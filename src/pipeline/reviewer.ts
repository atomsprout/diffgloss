import { createHash } from "node:crypto";
import { BudgetExceededError, BudgetTracker } from "../llm/budget.ts";
import { createLLMClient, extractJsonFromText } from "../llm/providers.ts";
import type { LLMClient } from "../llm/types.ts";
import type { StructuredRule } from "../rules/engine.ts";
import type {
  AttachedFinding,
  DiffglossConfig,
  ExplanationLedger,
  HunkRecord,
  RuledOutConcern,
  RuleTelemetry,
} from "../schema/types.ts";
import { attachFindingsToHunks } from "./integrity.ts";

const SPECIALIST_SYSTEM_PROMPT = `DIFFGLOSS_SPECIALIST_REVIEWER:
You are a narrow-focus, read-only code reviewer operating under SYMMETRIC PROOF rules.
You NEVER see author rationalizations or self-defense. Judge ONLY the diff code and declared rules.

Symmetric Proof rules:
1. Report ONLY concrete, high-signal bugs or explicit rule violations backed by exact code evidence. Do NOT report style nits.
2. ALSO output "ruled_out": suspicions you considered and ruled out, WITH concrete code proof from the diff. Never write shaky dismissals like "probably checked elsewhere".
3. Return ONLY valid JSON:
{
  "candidates": [
    {
      "rule_id": "bug/logic | bug/security | rule/<id>",
      "severity": "important" | "nit",
      "hunk_id": "h_...",
      "path": "...",
      "lines": [start, end],
      "message": "concise concrete failure scenario and fix",
      "evidence": "verbatim code snippet or file:line proof"
    }
  ],
  "ruled_out": [
    {
      "hunk_id": "h_...",
      "path": "...",
      "lines": [start, end],
      "suspicion": "what you suspected might go wrong",
      "proof": "concrete code proof showing why it is safe"
    }
  ]
}`;

const FINDING_VERIFIER_SYSTEM_PROMPT = `DIFFGLOSS_FINDING_VERIFIER:
You are an independent, cold-start verifier. Your job is to TRY TO DISPROVE the candidate bug finding against the actual diff hunk.
If the issue is speculative, a nitpick, pre-existing, or contradicted by the code, reject it.
Return ONLY valid JSON:
{"verified": true | false, "reason": "concise code-grounded reason"}`;

interface SpecialistCandidate {
  rule_id: string;
  severity: "important" | "nit";
  hunk_id: string;
  path: string;
  lines: [number, number];
  message: string;
  evidence: string;
}

interface SpecialistOutput {
  candidates?: SpecialistCandidate[];
  ruled_out?: Array<{
    hunk_id?: string;
    path: string;
    lines: [number, number];
    suspicion: string;
    proof: string;
  }>;
}

export interface ReviewPassOptions {
  config: DiffglossConfig;
  scopedLlmRules?: Array<{ rule: StructuredRule; hunkIds: string[] }>;
  ruleTelemetry?: RuleTelemetry[];
  maxNits?: number;
  finderClientOverride?: LLMClient;
  verifierClientOverride?: LLMClient;
}

function isShakyDismissal(proof: string): boolean {
  const trimmed = proof.trim();
  if (trimmed.length < 18) return true;
  return /\b(probably|presumably|assume|likely checked elsewhere|should be handled upstream)\b/i.test(
    trimmed,
  );
}

function fingerprintFinding(c: SpecialistCandidate): string {
  return createHash("sha256")
    .update(`${c.rule_id}\0${c.path}\0${c.hunk_id}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Isolated Find -> Verify -> Symmetric Proof pass:
 * - Runs two parallel narrow specialists (logic/correctness + security/custom-rules)
 *   without ever exposing author answers (strict independence).
 * - Verifies every candidate with an independent cold-start verifier.
 * - Escalates shaky self-dismissals and preserves all ruled-out concerns in glass-box output.
 */
export async function runSymmetricProofReview(
  ledger: ExplanationLedger,
  options: ReviewPassOptions,
): Promise<ExplanationLedger> {
  const activeHunks = ledger.hunks.filter((h) => h.status !== "collapsed");
  if (activeHunks.length === 0) return ledger;

  const finderClient =
    options.finderClientOverride ??
    createLLMClient({
      provider: options.config.provider,
      model: options.config.model,
      baseUrl: options.config.base_url,
      apiKeyEnv: options.config.api_key_env,
    });

  const verifierClient =
    options.verifierClientOverride ??
    createLLMClient({
      provider: options.config.judge_provider ?? options.config.provider,
      model: options.config.judge_model ?? options.config.model,
      baseUrl: options.config.judge_base_url ?? options.config.base_url,
      apiKeyEnv:
        options.config.judge_api_key_env ?? options.config.api_key_env,
    });

  const budget = new BudgetTracker(
    finderClient.provider,
    finderClient.model,
    options.config.budget_usd,
    verifierClient.model,
  );

  // Strict isolation: NEVER include author_answer or Q&A text in specialist payloads
  const sanitizedPayload = activeHunks.map((h) => ({
    id: h.id,
    path: h.path,
    enclosing_symbol: h.enclosing_symbol,
    old_range: h.old_range,
    new_range: h.new_range,
    patch: h.patch,
  }));

  const customRulesText = (options.scopedLlmRules ?? [])
    .map(
      ({ rule, hunkIds }) =>
        `- Rule \`${rule.id}\` (${rule.severity}, applies to hunks ${hunkIds.join(", ")}): ${rule.title}\n  ${rule.body}`,
    )
    .join("\n");

  const specialists: Array<{ name: string; focus: string }> = [
    {
      name: "logic-correctness",
      focus:
        "Focus strictly on logic errors, off-by-one bounds, null/undefined dereferences, race conditions, broken edge cases, and error handling bugs. Leave pure auth/injection/security rules to the security specialist.",
    },
    {
      name: "security-and-rules",
      focus: `Focus strictly on auth/tenant checks, injection, secret exposure, weakened validation, and explicit custom rules below. Leave general non-security logic bugs to the logic specialist.${customRulesText ? `\n\nCustom Scoped Rules:\n${customRulesText}` : ""}`,
    },
  ];

  const hunkMap = new Map<string, HunkRecord>(
    ledger.hunks.map((h) => [h.id, h]),
  );
  const allCandidates: Array<{ specialist: string; candidate: SpecialistCandidate }> = [];
  const ruledOut: RuledOutConcern[] = [...(ledger.ruled_out ?? [])];
  let roCounter = ruledOut.length;

  // Run specialists in parallel
  const specialistRuns = specialists.map(async (spec) => {
    const prompt = `Specialist Role: ${spec.name}
Focus: ${spec.focus}

<HUNKS_JSON>
${JSON.stringify(sanitizedPayload, null, 2)}
</HUNKS_JSON>`;

    try {
      budget.checkBeforeCall(
        finderClient.model,
        SPECIALIST_SYSTEM_PROMPT + prompt,
        1500,
      );
      const res = await finderClient.complete({
        system: SPECIALIST_SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
        maxTokens: 2500,
        temperature: 0,
        jsonMode: true,
      });
      budget.record(finderClient.model, res.usage);
      const parsed = extractJsonFromText<SpecialistOutput>(res.text);
      return { specialist: spec.name, parsed };
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        budget.markExceeded();
        return { specialist: spec.name, parsed: {} as SpecialistOutput };
      }
      throw err;
    }
  });

  const specialistOutputs = await Promise.all(specialistRuns);

  for (const { specialist, parsed } of specialistOutputs) {
    for (const cand of parsed.candidates ?? []) {
      if (!cand.hunk_id || !hunkMap.has(cand.hunk_id)) continue;
      allCandidates.push({ specialist, candidate: cand });
    }
    for (const ro of parsed.ruled_out ?? []) {
      const shaky = isShakyDismissal(ro.proof ?? "");
      roCounter += 1;
      ruledOut.push({
        id: `ro_${roCounter}`,
        specialist,
        path: ro.path,
        lines:
          Array.isArray(ro.lines) && ro.lines.length === 2
            ? [ro.lines[0]!, ro.lines[1]!]
            : [1, 1],
        hunk_id: ro.hunk_id,
        suspicion: ro.suspicion,
        proof: ro.proof,
        shaky_dismissal: shaky,
      });

      // Escalate shaky self-dismissal into candidate verification
      if (shaky && ro.hunk_id && hunkMap.has(ro.hunk_id)) {
        allCandidates.push({
          specialist: `${specialist}:escalated`,
          candidate: {
            rule_id: "bug/shaky-dismissal-escalated",
            severity: "important",
            hunk_id: ro.hunk_id,
            path: ro.path,
            lines:
              Array.isArray(ro.lines) && ro.lines.length === 2
                ? [ro.lines[0]!, ro.lines[1]!]
                : [1, 1],
            message: `Escalated shaky dismissal: ${ro.suspicion} (unsupported dismissal: "${ro.proof}")`,
            evidence: ro.proof,
          },
        });
      }
    }
  }

  // Deduplicate candidates by fingerprint before independent verification
  const seenFp = new Set<string>(
    (ledger.findings ?? []).map((f) => f.fingerprint),
  );
  const verifiedFindings: AttachedFinding[] = [...(ledger.findings ?? [])];
  const maxNits = options.maxNits ?? 5;
  let nitCount = verifiedFindings.filter((f) => f.severity === "nit").length;
  const telemetryMap = new Map(
    (options.ruleTelemetry ?? ledger.rule_telemetry ?? []).map((t) => [t.id, t]),
  );

  for (const { specialist, candidate } of allCandidates) {
    const fp = fingerprintFinding(candidate);
    if (seenFp.has(fp)) continue;

    const hunk = hunkMap.get(candidate.hunk_id);
    if (!hunk) continue;

    const verifyPrompt = `Candidate finding (${candidate.rule_id}, ${candidate.severity}) from ${specialist}:
Path: ${candidate.path}:${candidate.lines[0]}-${candidate.lines[1]}
Message: ${candidate.message}
Claimed evidence: ${candidate.evidence}

Actual diff hunk (${hunk.id}):
${hunk.patch}`;

    let verified = false;
    let verifyReason = "";

    try {
      budget.checkBeforeCall(
        verifierClient.model,
        FINDING_VERIFIER_SYSTEM_PROMPT + verifyPrompt,
        300,
      );
      const vRes = await verifierClient.complete({
        system: FINDING_VERIFIER_SYSTEM_PROMPT,
        messages: [{ role: "user", content: verifyPrompt }],
        maxTokens: 350,
        temperature: 0,
        jsonMode: true,
      });
      budget.record(verifierClient.model, vRes.usage);
      const judged = extractJsonFromText<{ verified?: boolean; reason?: string }>(
        vRes.text,
      );
      verified = Boolean(judged.verified);
      verifyReason = judged.reason ?? "";
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        budget.markExceeded();
        break;
      }
      verified = false;
      verifyReason = "Verification call failed; dropped to protect signal quality.";
    }

    if (!verified) {
      roCounter += 1;
      ruledOut.push({
        id: `ro_${roCounter}`,
        specialist: `verifier(${verifierClient.model})`,
        path: candidate.path,
        lines: candidate.lines,
        hunk_id: candidate.hunk_id,
        suspicion: `[Rejected ${candidate.rule_id}] ${candidate.message}`,
        proof: verifyReason || "Rejected by independent cold-start verifier.",
        shaky_dismissal: false,
      });
      continue;
    }

    if (candidate.severity === "nit") {
      if (nitCount >= maxNits) continue;
      nitCount += 1;
    }

    seenFp.add(fp);
    const isCustomRule = candidate.rule_id.startsWith("rule/");
    if (isCustomRule) {
      const ruleId = candidate.rule_id.slice("rule/".length);
      const t = telemetryMap.get(ruleId);
      if (t) t.hits += 1;
    }

    verifiedFindings.push({
      id: `f_rev_${verifiedFindings.length + 1}`,
      rule_id: candidate.rule_id,
      tool: `diffgloss-review/${specialist}`,
      severity: candidate.severity,
      category: isCustomRule ? "custom_rule" : "bug_verified",
      path: candidate.path,
      lines: candidate.lines,
      hunk_id: candidate.hunk_id,
      message: candidate.message,
      evidence: candidate.evidence,
      verifier_model: verifierClient.model,
      fingerprint: fp,
    });
  }

  attachFindingsToHunks(ledger.hunks, verifiedFindings);

  const prevCost = ledger.cost;
  const revCost = budget.getSummary();
  const mergedCost = prevCost
    ? {
        ...prevCost,
        judge_model: verifierClient.model,
        input_tokens: prevCost.input_tokens + revCost.input_tokens,
        output_tokens: prevCost.output_tokens + revCost.output_tokens,
        cached_input_tokens:
          prevCost.cached_input_tokens + revCost.cached_input_tokens,
        estimated_usd: Number(
          (prevCost.estimated_usd + revCost.estimated_usd).toFixed(6),
        ),
        budget_exceeded: prevCost.budget_exceeded || revCost.budget_exceeded,
      }
    : revCost;

  return {
    ...ledger,
    findings: verifiedFindings.length > 0 ? verifiedFindings : undefined,
    ruled_out: ruledOut.length > 0 ? ruledOut : undefined,
    rule_telemetry:
      telemetryMap.size > 0 ? [...telemetryMap.values()] : ledger.rule_telemetry,
    cost: mergedCost,
  };
}
