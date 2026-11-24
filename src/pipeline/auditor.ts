import { createHash } from "node:crypto";
import { BudgetExceededError, BudgetTracker } from "../llm/budget.ts";
import { createLLMClient, extractJsonFromText } from "../llm/providers.ts";
import type { LLMClient } from "../llm/types.ts";
import type {
  AttachedFinding,
  AuditStatus,
  DiffglossConfig,
  ExplanationLedger,
  HunkAudit,
  HunkRecord,
} from "../schema/types.ts";
import { computeCoverage } from "../schema/validate.ts";
import { attachFindingsToHunks } from "./integrity.ts";

const LINE_AUDITOR_SYSTEM_PROMPT = `DIFFGLOSS_LINE_AUDITOR:
You are an INDEPENDENT, cold-start code review auditor.
You receive:
1. Every changed line (+ added / - removed) of a diff hunk with exact line numbers.
2. An UNTRUSTED_AUTHOR_EXPLANATION produced by the authoring coding agent or explainer model.

Your job is to audit EVERY SINGLE CHANGED LINE strictly:
- Verify whether the explanation covers ALL meaningful changed lines (not just the headline edit).
- Verify whether the explanation is 100% faithful to what the code actually does (catch reversed conditions, hidden guard removals, silent side effects, or unimplemented claims).

Return ONLY valid JSON:
{
  "status": "verified" | "omission_detected" | "contradicted",
  "covered_lines": [line numbers accounted for],
  "omitted_lines": [exact changed line numbers omitted or glossed over by the explanation],
  "note": "concise evidence-backed audit verdict"
}`;

export interface NumberedChangedLine {
  side: "old" | "new";
  line: number;
  prefix: "+" | "-";
  text: string;
}

export function extractChangedLinesWithNumbers(
  hunk: Pick<HunkRecord, "patch" | "old_range" | "new_range">,
): NumberedChangedLine[] {
  const out: NumberedChangedLine[] = [];
  let oldCursor = hunk.old_range[0];
  let newCursor = hunk.new_range[0];

  for (const raw of hunk.patch.split("\n")) {
    if (raw.startsWith("@@") || raw.startsWith("rename ")) continue;
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      const text = raw.slice(1);
      if (text.trim().length > 0) {
        out.push({ side: "new", line: newCursor, prefix: "+", text });
      }
      newCursor += 1;
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      const text = raw.slice(1);
      if (text.trim().length > 0) {
        out.push({ side: "old", line: oldCursor, prefix: "-", text });
      }
      oldCursor += 1;
    } else {
      oldCursor += 1;
      newCursor += 1;
    }
  }

  return out;
}

export interface LineAuditOptions {
  config: DiffglossConfig;
  auditorClientOverride?: LLMClient;
  onHunkAudited?: (hunk: HunkRecord, index: number, total: number) => void;
}

/**
 * Independent Role-B Line-by-Line Auditor:
 * Audits every non-collapsed hunk that has an explanation (from Claude/Codex CLI or Model A),
 * verifying line-level coverage (`covered_lines` vs `omitted_lines`) and semantic truthfulness.
 * Contradicted explanations are honestly demoted to `unexplained` with an attached finding.
 */
export async function auditLedgerLines(
  ledger: ExplanationLedger,
  options: LineAuditOptions,
): Promise<ExplanationLedger> {
  const targets = ledger.hunks.filter(
    (h) => h.status !== "collapsed" && Boolean(h.what?.text),
  );
  if (targets.length === 0) return ledger;

  const auditorProvider =
    options.config.judge_provider ?? options.config.provider;
  const auditorModel = options.config.judge_model ?? options.config.model;

  const client =
    options.auditorClientOverride ??
    createLLMClient({
      provider: auditorProvider,
      model: auditorModel,
      baseUrl: options.config.judge_base_url ?? options.config.base_url,
      apiKey: options.config.judge_api_key ?? options.config.api_key,
      apiKeyEnv:
        options.config.judge_api_key_env ?? options.config.api_key_env,
    });

  const budget = new BudgetTracker(
    client.provider,
    client.model,
    options.config.budget_usd,
    client.model,
  );

  const findings: AttachedFinding[] = [...(ledger.findings ?? [])];
  const seenFp = new Set(findings.map((f) => f.fingerprint));

  for (let i = 0; i < targets.length; i += 1) {
    const hunk = targets[i]!;
    const changedLines = extractChangedLinesWithNumbers(hunk);
    const validLineSet = new Set(changedLines.map((l) => l.line));

    const prompt = `File: ${hunk.path} (${hunk.id})
Enclosing symbol: ${hunk.enclosing_symbol ?? "unknown"}
Declared intent: ${ledger.overview.declared_intent ?? "(none)"}

<UNTRUSTED_AUTHOR_EXPLANATION>
What: ${hunk.what?.text ?? ""}
Why (${hunk.why?.source ?? "missing"}): ${hunk.why?.text ?? ""}
</UNTRUSTED_AUTHOR_EXPLANATION>

<NUMBERED_CHANGED_LINES>
${changedLines.map((l) => `[${l.side} L${l.line}] ${l.prefix}${l.text}`).join("\n")}
</NUMBERED_CHANGED_LINES>

Full hunk patch:
${hunk.patch}`;

    try {
      budget.checkBeforeCall(
        client.model,
        LINE_AUDITOR_SYSTEM_PROMPT + prompt,
        350,
      );
      const res = await client.complete({
        system: LINE_AUDITOR_SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
        maxTokens: 450,
        temperature: 0,
        jsonMode: true,
      });
      budget.record(client.model, res.usage);

      const parsed = extractJsonFromText<{
        status?: AuditStatus;
        covered_lines?: number[];
        omitted_lines?: number[];
        note?: string;
      }>(res.text);

      const covered = (parsed.covered_lines ?? []).filter((n) =>
        validLineSet.has(n),
      );
      const omitted = (parsed.omitted_lines ?? []).filter((n) =>
        validLineSet.has(n),
      );

      let status: AuditStatus = parsed.status ?? "verified";
      if (status === "verified" && omitted.length > 0) {
        status = "omission_detected";
      }

      const audit: HunkAudit = {
        status,
        auditor_model: client.model,
        covered_lines:
          covered.length > 0
            ? covered
            : status === "verified"
              ? changedLines.map((l) => l.line)
              : [],
        omitted_lines: omitted,
        note: parsed.note ?? "Audited against numbered diff lines.",
        audited_at: new Date().toISOString(),
      };
      hunk.audit = audit;

      // Sync semantic_grounding + honest demotion on contradiction
      if (hunk.what) {
        if (status === "verified") {
          hunk.what.semantic_grounding = "judge_passed";
          hunk.what.semantic_note = audit.note;
        } else if (status === "contradicted") {
          hunk.what.semantic_grounding = "judge_failed";
          hunk.what.semantic_note = audit.note;
          hunk.status = "unexplained";
        }
      }

      if (status === "contradicted" || status === "omission_detected") {
        const ruleId =
          status === "contradicted"
            ? "diffgloss/audit-contradiction"
            : "diffgloss/audit-omission";
        const fp = createHash("sha256")
          .update(`${ruleId}\0${hunk.id}\0${omitted.join(",")}`)
          .digest("hex")
          .slice(0, 16);
        if (!seenFp.has(fp)) {
          seenFp.add(fp);
          findings.push({
            id: `f_aud_${findings.length + 1}`,
            rule_id: ruleId,
            tool: `diffgloss-auditor/${client.model}`,
            severity: "important",
            category:
              status === "contradicted"
                ? "audit_contradiction"
                : "audit_omission",
            path: hunk.path,
            lines:
              omitted.length > 0
                ? [Math.min(...omitted), Math.max(...omitted)]
                : hunk.new_range[0] > 0
                  ? hunk.new_range
                  : hunk.old_range,
            hunk_id: hunk.id,
            message:
              status === "contradicted"
                ? `Author explanation contradicted by diff: ${audit.note}`
                : `Author explanation omitted changed line(s) [${omitted.join(", ")}]: ${audit.note}`,
            verifier_model: client.model,
            fingerprint: fp,
          });
        }
      }

      options.onHunkAudited?.(hunk, i + 1, targets.length);
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        budget.markExceeded();
        break;
      }
      hunk.audit = {
        status: "pending",
        auditor_model: client.model,
        covered_lines: [],
        omitted_lines: [],
        note: `Audit skipped: ${err instanceof Error ? err.message : String(err)}`,
        audited_at: new Date().toISOString(),
      };
    }
  }

  attachFindingsToHunks(ledger.hunks, findings);
  const coverage = computeCoverage(ledger.hunks);

  const prevCost = ledger.cost;
  const audCost = budget.getSummary();
  const mergedCost = prevCost
    ? {
        ...prevCost,
        judge_model: client.model,
        input_tokens: prevCost.input_tokens + audCost.input_tokens,
        output_tokens: prevCost.output_tokens + audCost.output_tokens,
        cached_input_tokens:
          prevCost.cached_input_tokens + audCost.cached_input_tokens,
        estimated_usd: Number(
          (prevCost.estimated_usd + audCost.estimated_usd).toFixed(6),
        ),
        budget_exceeded: prevCost.budget_exceeded || audCost.budget_exceeded,
      }
    : audCost;

  return {
    ...ledger,
    findings: findings.length > 0 ? findings : undefined,
    cost: mergedCost,
    coverage,
  };
}
