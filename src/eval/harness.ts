import { readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG } from "../config/loader.ts";
import { createLLMClient, MockLLMClient } from "../llm/providers.ts";
import { explainLedger } from "../pipeline/explainer.ts";
import { buildInitialLedger } from "../pipeline/ledger.ts";
import type { ProviderDialect } from "../schema/types.ts";
import { validateLedger } from "../schema/validate.ts";

export interface GoldenEvalCase {
  id: string;
  description: string;
  declared_intent?: string;
  diff: string;
  expected: {
    skipped_secrets: string[];
    collapsed_paths: string[];
    never_collapse_paths: string[];
    expected_rule_ids: string[];
    min_unexplained_after_explain: number;
  };
}

export interface EvalCaseReport {
  id: string;
  passed: boolean;
  duration_ms: number;
  estimated_usd: number;
  failures: string[];
  metrics: {
    total_hunks: number;
    explained: number;
    collapsed: number;
    unexplained: number;
    false_collapses: number;
    citation_valid_rate: number;
  };
}

export interface EvalSuiteReport {
  provider: string;
  model: string;
  total_cases: number;
  passed_cases: number;
  false_collapse_total: number;
  coverage_invariant_rate: number;
  citation_valid_rate: number;
  total_duration_ms: number;
  total_estimated_usd: number;
  cases: EvalCaseReport[];
}

export interface EvalSuiteOptions {
  provider?: ProviderDialect;
  model?: string;
  baseUrl?: string;
  runJudge?: boolean;
  limit?: number;
}

export async function runGoldenEvalSuite(
  casesFilePath: string,
  cwd: string,
  options: EvalSuiteOptions = {},
): Promise<EvalSuiteReport> {
  const allCases = JSON.parse(
    readFileSync(casesFilePath, "utf8"),
  ) as GoldenEvalCase[];
  const cases =
    options.limit && options.limit > 0
      ? allCases.slice(0, options.limit)
      : allCases;

  const provider: ProviderDialect = options.provider ?? "mock";
  const model =
    options.model ??
    (provider === "deepseek"
      ? "deepseek-chat"
      : provider === "mock"
        ? "mock-eval"
        : DEFAULT_CONFIG.model);
  const runJudge = options.runJudge ?? provider === "mock";

  const client =
    provider === "mock"
      ? new MockLLMClient(model)
      : createLLMClient({ provider, model, baseUrl: options.baseUrl });
  const judgeClient = runJudge
    ? provider === "mock"
      ? new MockLLMClient("mock-judge")
      : client
    : undefined;

  const reports: EvalCaseReport[] = [];
  let invariantPassCount = 0;
  let totalExplained = 0;
  let totalValidCitations = 0;
  let falseCollapseTotal = 0;
  let totalUsd = 0;
  const suiteStart = Date.now();

  for (const c of cases) {
    const startMs = Date.now();
    const failures: string[] = [];
    const initial = buildInitialLedger(c.diff, {
      title: `Eval: ${c.id}`,
      declaredIntent: c.declared_intent,
    });

    const explained = await explainLedger(initial, {
      cwd,
      config: {
        ...DEFAULT_CONFIG,
        provider,
        model,
        base_url: options.baseUrl,
        effort: runJudge ? "deep" : "standard",
      },
      clientOverride: client,
      judgeClientOverride: judgeClient,
      runJudge,
    });

    const durationMs = Date.now() - startMs;
    const caseUsd = explained.cost?.estimated_usd ?? 0;
    totalUsd += caseUsd;

    const validation = validateLedger(explained);
    if (validation.ok) {
      invariantPassCount += 1;
    } else {
      failures.push(`Ledger validation failed: ${validation.errors.join("; ")}`);
    }

    const skippedSecrets = (explained.source?.skipped_files ?? [])
      .filter((s) => s.reason === "secret_suspected")
      .map((s) => s.path);
    for (const secret of c.expected.skipped_secrets) {
      if (!skippedSecrets.includes(secret)) {
        failures.push(`Secret file '${secret}' was NOT skipped.`);
      }
    }

    const collapsedPaths = new Set(
      explained.hunks.filter((h) => h.status === "collapsed").map((h) => h.path),
    );
    for (const p of c.expected.collapsed_paths) {
      if (!collapsedPaths.has(p)) {
        failures.push(`Expected mechanical/generated path '${p}' to be collapsed.`);
      }
    }

    let falseCollapses = 0;
    for (const p of c.expected.never_collapse_paths) {
      if (collapsedPaths.has(p)) {
        falseCollapses += 1;
        falseCollapseTotal += 1;
        failures.push(
          `FALSE COLLAPSE: substantive/critical path '${p}' was collapsed!`,
        );
      }
    }

    const hitRules = new Set((explained.findings ?? []).map((f) => f.rule_id));
    for (const ruleId of c.expected.expected_rule_ids) {
      if (!hitRules.has(ruleId)) {
        failures.push(`Expected integrity rule '${ruleId}' did not fire.`);
      }
    }

    if (explained.coverage.unexplained < c.expected.min_unexplained_after_explain) {
      failures.push(
        `Expected >= ${c.expected.min_unexplained_after_explain} unexplained hunk(s), got ${explained.coverage.unexplained}.`,
      );
    }

    const explainedHunks = explained.hunks.filter((h) => h.status === "explained");
    const validCites = explainedHunks.filter((h) => h.what?.citations_valid).length;
    totalExplained += explainedHunks.length;
    totalValidCitations += validCites;

    reports.push({
      id: c.id,
      passed: failures.length === 0,
      duration_ms: durationMs,
      estimated_usd: caseUsd,
      failures,
      metrics: {
        total_hunks: explained.coverage.total,
        explained: explained.coverage.explained,
        collapsed: explained.coverage.collapsed,
        unexplained: explained.coverage.unexplained,
        false_collapses: falseCollapses,
        citation_valid_rate:
          explainedHunks.length > 0 ? validCites / explainedHunks.length : 1,
      },
    });
  }

  return {
    provider,
    model,
    total_cases: cases.length,
    passed_cases: reports.filter((r) => r.passed).length,
    false_collapse_total: falseCollapseTotal,
    coverage_invariant_rate:
      cases.length > 0 ? invariantPassCount / cases.length : 1,
    citation_valid_rate:
      totalExplained > 0 ? totalValidCitations / totalExplained : 1,
    total_duration_ms: Date.now() - suiteStart,
    total_estimated_usd: Number(totalUsd.toFixed(6)),
    cases: reports,
  };
}

export function defaultGoldenCasesPath(rootDir: string): string {
  return path.join(rootDir, "evals", "golden", "cases.json");
}
