import { createHash } from "node:crypto";
import type { LoadedRuleDoc } from "../config/loader.ts";
import { extractHunkContext } from "../diff/context.ts";
import {
  createAuthorCliClient,
  resolvePreferredAuthorCli,
} from "../llm/author-adapter.ts";
import {
  BudgetExceededError,
  BudgetTracker,
  calculateUsageUsd,
  estimateTokens,
} from "../llm/budget.ts";
import { createLLMClient, extractJsonFromText } from "../llm/providers.ts";
import type { LLMClient } from "../llm/types.ts";
import type {
  AttachedFinding,
  Citation,
  ClarifyingQuestion,
  DiffglossConfig,
  ExplanationGroup,
  ExplanationLedger,
  HunkRecord,
  QuestionTrigger,
  RiskLevel,
  WhySource,
} from "../schema/types.ts";
import { computeCoverage, verifyHunkCitations } from "../schema/validate.ts";
import { computeHunkCacheKey, HunkResultCache } from "./cache.ts";
import { attachFindingsToHunks } from "./integrity.ts";

const EXPLAINER_SYSTEM_PROMPT = `You are Diffgloss, an evidence-first code change explainer.
Your job is NOT to write flattering prose. Your job is to account for EVERY provided hunk honestly.

Strict rules:
1. Return ONLY valid JSON matching the exact schema requested.
2. Separate WHAT (observable code change in the diff) from WHY (rationale with honest source tier).
3. Every "explained" hunk MUST include at least one exact file:line citation inside that hunk's old_range or new_range.
4. Any code identifier wrapped in backticks in what_text MUST actually appear verbatim in that hunk's patch or header.
5. NEVER invent a rationale. If a hunk removes a safety/validation guard, weakens a test assertion, or has no evidence connecting it to the declared intent, set status="unexplained", why_source="missing", and provide a sharp, verifiable clarifying question with a trigger.
6. Order groups for human comprehension (high-risk tests or data-model/core logic first, call sites next, config last). Every provided hunk_id MUST appear in exactly one group.`;

const SEMANTIC_JUDGE_SYSTEM_PROMPT = `SEMANTIC_GROUNDING_JUDGE:
You are a cold-start semantic grounding verifier. Compare the actual unified diff hunk against the proposed "what" explanation.
Flag "judge_failed" if the explanation reverses a condition, misstates bounds/side-effects, claims behavior not present in the diff, or omits a significant security/logic change inside the hunk.
Return ONLY valid JSON: {"verdict": "judge_passed" | "judge_failed", "note": "concise reason"}`;

interface LLMExplainerGroup {
  title: string;
  intent: string;
  order_rationale?: string;
  risk?: RiskLevel;
  hunk_ids: string[];
}

interface LLMExplainerHunk {
  id: string;
  status: "explained" | "unexplained";
  risk?: RiskLevel;
  what_text?: string;
  citations?: Citation[];
  why_text?: string;
  why_source?: WhySource;
  trigger?: QuestionTrigger;
  question?: string;
}

interface LLMExplainerOutput {
  behavior_change?: string;
  groups?: LLMExplainerGroup[];
  hunks?: LLMExplainerHunk[];
}

export interface ExplainOptions {
  cwd: string;
  config: DiffglossConfig;
  ruleDocs?: LoadedRuleDoc[];
  dryRun?: boolean;
  runJudge?: boolean;
  useCache?: boolean;
  clientOverride?: LLMClient;
  judgeClientOverride?: LLMClient;
  onProgress?: (stage: string, done: number, total: number, message?: string) => void;
}

export interface DryRunEstimate {
  batches: number;
  hunksToExplain: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedUsd: number;
  budgetUsd: number;
  withinBudget: boolean;
}

function batchHunks(
  hunks: HunkRecord[],
  maxHunksPerBatch = 10,
  maxCharsPerBatch = 24_000,
): HunkRecord[][] {
  const batches: HunkRecord[][] = [];
  let current: HunkRecord[] = [];
  let chars = 0;

  for (const h of hunks) {
    const size = h.patch.length + 400;
    if (
      current.length > 0 &&
      (current.length >= maxHunksPerBatch || chars + size > maxCharsPerBatch)
    ) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(h);
    chars += size;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

function buildBatchPrompt(
  cwd: string,
  batch: HunkRecord[],
  declaredIntent: string | undefined,
  ruleDocs: LoadedRuleDoc[],
): string {
  const payload = batch.map((h) => {
    const ctx = extractHunkContext(cwd, h, 8);
    return {
      id: h.id,
      path: h.path,
      old_range: h.old_range,
      new_range: h.new_range,
      class: h.class,
      risk: h.risk,
      enclosing_symbol: h.enclosing_symbol,
      provenance_why:
        h.why && h.why.source !== "missing"
          ? { source: h.why.source, text: h.why.text }
          : undefined,
      call_sites: ctx.call_sites.length > 0 ? ctx.call_sites : undefined,
      patch: h.patch,
    };
  });

  const rulesBlock =
    ruleDocs.length > 0
      ? `<REPO_RULES>\n${ruleDocs
          .map((d) => `--- ${d.path} (${d.source}) ---\n${d.content}`)
          .join("\n\n")}\n</REPO_RULES>\n\n`
      : "";

  return `${rulesBlock}<DECLARED_INTENT>
${declaredIntent ?? ""}
</DECLARED_INTENT>

<HUNKS_JSON>
${JSON.stringify(payload, null, 2)}
</HUNKS_JSON>

Respond with JSON of shape:
{
  "behavior_change": "1-2 sentence behavioral summary for this batch",
  "groups": [
    {
      "title": "short semantic group title",
      "intent": "what this group accomplishes",
      "order_rationale": "why read this group here",
      "risk": "low" | "medium" | "high",
      "hunk_ids": ["h_..."]
    }
  ],
  "hunks": [
    {
      "id": "h_...",
      "status": "explained" | "unexplained",
      "risk": "low" | "medium" | "high",
      "what_text": "factual description of code change (required if explained)",
      "citations": [{"path": "...", "lines": [start, end], "side": "new" | "old"}],
      "why_text": "rationale or why it cannot be explained",
      "why_source": "transcript" | "declared_intent" | "reviewer_inferred" | "missing",
      "trigger": "no_evidence_for_why" | "unrelated_to_intent" | "test_assertion_changed" | "claim_mismatch" | "safety_check_removed",
      "question": "specific question requiring file:line or test evidence (only if unexplained)"
    }
  ]
}`;
}

export function estimateExplainCost(
  ledger: ExplanationLedger,
  options: ExplainOptions,
): DryRunEstimate {
  const targets = ledger.hunks.filter((h) => h.status !== "collapsed");
  const batches = batchHunks(targets);
  const ruleDocs = options.ruleDocs ?? [];
  let estInput = 0;
  let estOutput = 0;

  for (const batch of batches) {
    const prompt = buildBatchPrompt(
      options.cwd,
      batch,
      ledger.overview.declared_intent,
      ruleDocs,
    );
    estInput += estimateTokens(EXPLAINER_SYSTEM_PROMPT + prompt);
    estOutput += Math.min(3500, batch.length * 240 + 300);
  }

  const runJudge =
    options.runJudge ?? options.config.effort === "deep";
  if (runJudge) {
    estInput += targets.length * 450;
    estOutput += targets.length * 90;
  }

  const estUsd = calculateUsageUsd(options.config.model, {
    inputTokens: estInput,
    outputTokens: estOutput,
    cachedInputTokens: 0,
  });

  return {
    batches: batches.length,
    hunksToExplain: targets.length,
    estimatedInputTokens: estInput,
    estimatedOutputTokens: estOutput,
    estimatedUsd: estUsd,
    budgetUsd: options.config.budget_usd,
    withinBudget:
      options.config.budget_usd <= 0 || estUsd <= options.config.budget_usd,
  };
}

export async function explainLedger(
  ledger: ExplanationLedger,
  options: ExplainOptions,
): Promise<ExplanationLedger> {
  const targets = ledger.hunks.filter((h) => h.status !== "collapsed");
  if (targets.length === 0) {
    return ledger;
  }

  let explainerMode: "author_cli" | "api_model" =
    options.config.explainer_mode ?? "api_model";
  let client = options.clientOverride;
  let authorSessionId: string | undefined;

  if (!client && explainerMode === "author_cli") {
    const cliKind = resolvePreferredAuthorCli(options.config.author_cli ?? "auto");
    if (cliKind) {
      // Reuse discovered session_id if provenance matched a local Claude/Codex session
      authorSessionId = ledger.hunks.find((h) => h.provenance?.session_id)?.provenance?.session_id;
      client = createAuthorCliClient({
        kind: cliKind,
        cwd: options.cwd,
        sessionId: authorSessionId,
      });
    } else {
      // Graceful fallback to configured API model if neither claude nor codex is installed
      explainerMode = "api_model";
    }
  }

  if (!client) {
    client = createLLMClient({
      provider: options.config.provider,
      model: options.config.model,
      baseUrl: options.config.base_url,
      apiKey: options.config.api_key,
      apiKeyEnv: options.config.api_key_env,
    });
  }

  const runJudge =
    options.runJudge ?? options.config.effort === "deep";
  const judgeModel = options.config.judge_model ?? options.config.model;
  const judgeClient = runJudge
    ? options.judgeClientOverride ??
      createLLMClient({
        provider: options.config.judge_provider ?? options.config.provider,
        model: judgeModel,
        baseUrl: options.config.judge_base_url ?? options.config.base_url,
        apiKey: options.config.judge_api_key ?? options.config.api_key,
        apiKeyEnv: options.config.judge_api_key_env ?? options.config.api_key_env,
      })
    : undefined;

  const budget = new BudgetTracker(
    client.provider,
    client.model,
    options.config.budget_usd,
    judgeClient?.model,
  );

  // Check content-addressed hunk cache so unchanged hunks skip repeat LLM calls
  const cache = options.useCache !== false ? new HunkResultCache(options.cwd) : null;
  const explainerKey = `${explainerMode}:${client.provider}:${client.model}`;
  const uncachedTargets: HunkRecord[] = [];
  for (const h of targets) {
    if (cache) {
      const cKey = computeHunkCacheKey({
        hunk: h,
        declaredIntent: ledger.overview.declared_intent,
        explainerKey,
      });
      const hit = cache.get(cKey);
      if (hit && hit.what?.citations_valid) {
        h.status = hit.status;
        h.what = hit.what;
        if (hit.why) h.why = hit.why;
        h.explainer_meta = {
          ...(hit.explainer_meta ?? { mode: explainerMode, adapter: client.provider }),
          cached: true,
        };
        if (hit.audit) h.audit = hit.audit;
        continue;
      }
    }
    uncachedTargets.push(h);
  }

  const ruleDocs = options.ruleDocs ?? [];
  const batches = batchHunks(uncachedTargets);
  const hunkMap = new Map(ledger.hunks.map((h) => [h.id, h]));
  const existingQuestions = new Map(ledger.questions.map((q) => [q.id, q]));
  let qCounter = ledger.questions.length;
  const newGroups: ExplanationGroup[] = [];
  const behaviorSummaries: string[] = [];
  const extraFindings: AttachedFinding[] = [...(ledger.findings ?? [])];
  let processedCount = targets.length - uncachedTargets.length;
  options.onProgress?.(
    "explaining",
    processedCount,
    targets.length,
    processedCount > 0 ? `Loaded ${processedCount} hunk(s) from cache` : "Starting explanation...",
  );

  for (const batch of batches) {
    const prompt = buildBatchPrompt(
      options.cwd,
      batch,
      ledger.overview.declared_intent,
      ruleDocs,
    );

    try {
      budget.checkBeforeCall(client.model, EXPLAINER_SYSTEM_PROMPT + prompt, 2400);
      const res = await client.complete({
        system: EXPLAINER_SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
        maxTokens: 4096,
        temperature: 0,
        jsonMode: true,
      });
      budget.record(client.model, res.usage);

      const parsed = extractJsonFromText<LLMExplainerOutput>(res.text);
      if (parsed.behavior_change) {
        behaviorSummaries.push(parsed.behavior_change);
      }

      const invalidForRepair: Array<{ hunk: HunkRecord; errors: string[] }> = [];

      for (const item of parsed.hunks ?? []) {
        const hunk = hunkMap.get(item.id);
        if (!hunk || hunk.status === "collapsed") continue;

        if (item.risk) hunk.risk = item.risk;
        hunk.explainer_meta = {
          mode: explainerMode,
          adapter: `${client.provider}/${client.model}`,
          session_id: authorSessionId,
          cached: false,
        };

        if (item.status === "explained" && item.what_text) {
          hunk.status = "explained";
          hunk.what = {
            text: item.what_text,
            citations: item.citations ?? [],
            citations_valid: false,
            semantic_grounding: "unchecked",
          };
          const check = verifyHunkCitations(hunk);
          hunk.what.citations_valid = check.valid;
          if (!check.valid) {
            hunk.what.citation_errors = check.errors;
            invalidForRepair.push({ hunk, errors: check.errors });
          }

          // Preserve stronger provenance (e.g. write-time hook or transcript) if already attached
          if (!hunk.why || hunk.why.source === "missing") {
            hunk.why = {
              text: item.why_text ?? "Inferred from diff context.",
              source: item.why_source ?? "reviewer_inferred",
              evidence:
                item.why_source === "declared_intent" && ledger.overview.declared_intent
                  ? [
                      {
                        kind: "declared_intent",
                        ref: ledger.overview.declared_intent_ref ?? "prompt",
                        excerpt:
                          ledger.overview.declared_intent.length > 140
                            ? `${ledger.overview.declared_intent.slice(0, 140).replace(/\s+\S*$/, "")}…`
                            : ledger.overview.declared_intent,
                      },
                    ]
                  : [],
              verification: "not_checked",
            };
          }
          // Prune stale deterministic placeholder question once hunk is validly explained
          if (hunk.what.citations_valid && hunk.questions && hunk.questions.length > 0) {
            const kept: string[] = [];
            for (const qid of hunk.questions) {
              const q = existingQuestions.get(qid);
              if (q && q.trigger === "no_evidence_for_why" && !q.answer) {
                existingQuestions.delete(qid);
              } else {
                kept.push(qid);
              }
            }
            hunk.questions = kept.length > 0 ? kept : undefined;
          }
        } else {
          hunk.status = "unexplained";
          if (!hunk.why || hunk.why.source === "missing") {
            hunk.why = {
              text:
                item.why_text ??
                "Insufficient evidence in diff or declared intent to explain this change.",
              source: "missing",
              evidence: [],
              verification: "not_checked",
            };
          }
          if (
            item.question &&
            existingQuestions.size < options.config.max_questions &&
            (!hunk.questions || hunk.questions.length === 0)
          ) {
            qCounter += 1;
            const qid = `q${qCounter}`;
            const q: ClarifyingQuestion = {
              id: qid,
              hunk_ids: [hunk.id],
              trigger: item.trigger ?? "no_evidence_for_why",
              question: item.question,
              channel: "human",
            };
            existingQuestions.set(qid, q);
            hunk.questions = [qid];
          }
        }
      }

      // Single targeted repair pass for any hunk that failed mechanical citation checks
      if (invalidForRepair.length > 0) {
        for (const broken of invalidForRepair) {
          // Honest demotion if repair fails or budget is tight
          const repairPrompt = `Fix the citations/symbols for hunk ${broken.hunk.id} (${broken.hunk.path}).
Validation errors:
${broken.errors.map((e) => `- ${e}`).join("\n")}

Allowed ranges: old_range=${JSON.stringify(broken.hunk.old_range)}, new_range=${JSON.stringify(broken.hunk.new_range)}.
Patch:
${broken.hunk.patch}

Return JSON: {"what_text": "...", "citations": [{"path": "${broken.hunk.path}", "lines": [start, end], "side": "new" | "old"}]}`;

          let repaired = false;
          try {
            budget.checkBeforeCall(client.model, EXPLAINER_SYSTEM_PROMPT + repairPrompt, 600);
            const repairRes = await client.complete({
              system: EXPLAINER_SYSTEM_PROMPT,
              messages: [{ role: "user", content: repairPrompt }],
              maxTokens: 1024,
              temperature: 0,
              jsonMode: true,
            });
            budget.record(client.model, repairRes.usage);
            const fixed = extractJsonFromText<{
              what_text?: string;
              citations?: Citation[];
            }>(repairRes.text);
            if (fixed.what_text && fixed.citations) {
              broken.hunk.what = {
                text: fixed.what_text,
                citations: fixed.citations,
                citations_valid: false,
                semantic_grounding: "unchecked",
              };
              const recheck = verifyHunkCitations(broken.hunk);
              broken.hunk.what.citations_valid = recheck.valid;
              broken.hunk.what.citation_errors = recheck.valid
                ? undefined
                : recheck.errors;
              repaired = recheck.valid;
            }
          } catch (err) {
            if (err instanceof BudgetExceededError) {
              budget.markExceeded();
            }
          }

          if (!repaired) {
            broken.hunk.status = "unexplained";
            const fid = `f_cite_${extraFindings.length + 1}`;
            extraFindings.push({
              id: fid,
              rule_id: "diffgloss/citation-verification-failed",
              tool: "diffgloss-verifier",
              severity: "important",
              category: "intent_mismatch",
              path: broken.hunk.path,
              lines:
                broken.hunk.new_range[0] > 0
                  ? broken.hunk.new_range
                  : broken.hunk.old_range,
              hunk_id: broken.hunk.id,
              message: `Explanation demoted to unexplained after failing mechanical citation check: ${broken.errors.join("; ")}`,
              fingerprint: createHash("sha256")
                .update(`cite-fail:${broken.hunk.id}`)
                .digest("hex")
                .slice(0, 16),
            });
          }
        }
      }

      // Collect semantic groups from batch output
      for (const g of parsed.groups ?? []) {
        const validIds = g.hunk_ids.filter((id) => hunkMap.has(id));
        if (validIds.length === 0) continue;
        newGroups.push({
          id: `g${newGroups.length + 1}`,
          title: g.title,
          intent: g.intent,
          order_rationale: g.order_rationale,
          risk: g.risk ?? "low",
          hunk_ids: validIds,
        });
      }

      processedCount += batch.length;
      options.onProgress?.(
        "explaining",
        Math.min(processedCount, targets.length),
        targets.length,
        `Explained ${Math.min(processedCount, targets.length)}/${targets.length} hunks via ${client.provider}`,
      );

      // Save validly explained hunks to disk cache
      if (cache) {
        for (const h of batch) {
          if (h.status === "explained" && h.what?.citations_valid) {
            cache.set({
              cache_key: computeHunkCacheKey({
                hunk: h,
                declaredIntent: ledger.overview.declared_intent,
                explainerKey,
              }),
              hunk_id: h.id,
              saved_at: new Date().toISOString(),
              status: h.status,
              what: h.what,
              why: h.why,
              explainer_meta: h.explainer_meta,
            });
          }
        }
      }
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        budget.markExceeded();
        break;
      }
      throw err;
    }
  }

  // Optional Cold-Start Semantic Grounding Judge pass
  if (judgeClient) {
    const explainedTargets = ledger.hunks.filter(
      (h) => h.status === "explained" && h.what?.citations_valid,
    );
    for (const h of explainedTargets) {
      const judgePrompt = `File: ${h.path}
Proposed WHAT explanation:
${h.what!.text}

Actual unified diff hunk:
${h.patch}`;
      try {
        budget.checkBeforeCall(
          judgeClient.model,
          SEMANTIC_JUDGE_SYSTEM_PROMPT + judgePrompt,
          250,
        );
        const res = await judgeClient.complete({
          system: SEMANTIC_JUDGE_SYSTEM_PROMPT,
          messages: [{ role: "user", content: judgePrompt }],
          maxTokens: 300,
          temperature: 0,
          jsonMode: true,
        });
        budget.record(judgeClient.model, res.usage);
        const judged = extractJsonFromText<{
          verdict?: "judge_passed" | "judge_failed";
          note?: string;
        }>(res.text);
        h.what!.semantic_grounding = judged.verdict ?? "unchecked";
        h.what!.semantic_note = judged.note;
        if (judged.verdict === "judge_failed") {
          h.status = "unexplained";
        }
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          budget.markExceeded();
          break;
        }
      }
    }
  }

  // Reconcile group assignments so EVERY hunk appears in exactly one group
  const assigned = new Set<string>();
  const finalGroups: ExplanationGroup[] = [];

  for (const g of newGroups) {
    const deduped = g.hunk_ids.filter((id) => !assigned.has(id));
    if (deduped.length === 0) continue;
    for (const id of deduped) assigned.add(id);
    finalGroups.push({
      ...g,
      id: `g${finalGroups.length + 1}`,
      hunk_ids: deduped,
    });
  }

  // Keep any unassigned non-collapsed hunks in an explicit catch-all group
  const unassignedActive = ledger.hunks.filter(
    (h) => h.status !== "collapsed" && !assigned.has(h.id),
  );
  if (unassignedActive.length > 0) {
    for (const h of unassignedActive) assigned.add(h.id);
    finalGroups.push({
      id: `g${finalGroups.length + 1}`,
      title: "Remaining unexplained changes",
      intent: "Hunks not assigned to a semantic group (e.g., due to budget cap or fallback).",
      risk: unassignedActive.some((h) => h.risk === "high") ? "high" : "medium",
      hunk_ids: unassignedActive.map((h) => h.id),
    });
  }

  // Append collapsed group at the end
  const collapsedHunks = ledger.hunks.filter(
    (h) => h.status === "collapsed" && !assigned.has(h.id),
  );
  if (collapsedHunks.length > 0) {
    finalGroups.push({
      id: `g${finalGroups.length + 1}`,
      title: "Mechanical, generated & moved changes",
      intent: `${collapsedHunks.length} hunk(s) deterministically classified as low-signal noise; expand any item to inspect.`,
      order_rationale: "Collapsed by default to preserve reviewer attention.",
      risk: "low",
      collapsed_by_default: true,
      hunk_ids: collapsedHunks.map((h) => h.id),
    });
  }

  attachFindingsToHunks(ledger.hunks, extraFindings);
  const coverage = computeCoverage(ledger.hunks);

  return {
    ...ledger,
    generated_at: new Date().toISOString(),
    source: {
      ...ledger.source,
      rules_loaded: ruleDocs.map((d) => `${d.path} (${d.source})`),
    },
    overview: {
      ...ledger.overview,
      behavior_change:
        behaviorSummaries.length > 0
          ? behaviorSummaries.join(" ")
          : ledger.overview.behavior_change,
    },
    groups: finalGroups,
    questions: [...existingQuestions.values()],
    findings: extraFindings.length > 0 ? extraFindings : undefined,
    cost: budget.getSummary(),
    coverage,
  };
}
