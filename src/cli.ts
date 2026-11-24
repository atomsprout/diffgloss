#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { discoverRuleDocs, loadConfig } from "./config/loader.ts";
import {
  extractRepoDiff,
  resolveGitTopLevel,
} from "./diff/git-source.ts";
import { defaultGoldenCasesPath, runGoldenEvalSuite } from "./eval/harness.ts";
import {
  exportRdjsonl,
  exportSarifReport,
  importSarifFindings,
} from "./interop/sarif.ts";
import { startMcpStdioServer } from "./mcp/server.ts";
import { auditLedgerLines } from "./pipeline/auditor.ts";
import { estimateExplainCost, explainLedger } from "./pipeline/explainer.ts";
import { attachFindingsToHunks } from "./pipeline/integrity.ts";
import { buildInitialLedger } from "./pipeline/ledger.ts";
import { runSymmetricProofReview } from "./pipeline/reviewer.ts";
import { syncLedgerToGitHub } from "./platform/github.ts";
import {
  appendWriteTimeManifest,
  enrichLedgerProvenance,
  evaluateStopHook,
  generateClaudeHooksSnippet,
} from "./provenance/capture.ts";
import {
  askAuthorAgentSession,
  recordAndVerifyAnswer,
} from "./provenance/questioner.ts";
import { renderHtmlReport } from "./render/html.ts";
import { renderMarkdownReport } from "./render/markdown.ts";
import { startPreviewServer } from "./render/server.ts";
import {
  evaluateStructuredRules,
  loadStructuredRules,
} from "./rules/engine.ts";
import type {
  DiffglossConfig,
  EffortLevel,
  ExplanationLedger,
  ProviderDialect,
} from "./schema/types.ts";
import { validateLedger } from "./schema/validate.ts";

function printHelp(): void {
  console.log(`diffgloss — Explainability-first code review ledger

Usage:
  diffgloss ui [git-diff-args...] [options]          Open interactive browser UI immediately (configure models in-page!)
  diffgloss inspect [git-diff-args...] [options]     Deterministic pass (<1s): parse, AST split, collapse, rules
  diffgloss explain [git-diff-args...] [options]     Full pass: deterministic + provenance + LLM explain + verify
  diffgloss render <ledger.json> [options]           Render existing ledger to HTML / Markdown / SARIF / rdjsonl
  diffgloss validate <ledger.json> [options]         Verify schema, coverage invariant & mechanical citations
  diffgloss answer <ledger.json> <qid> [options]     Record & verify an answer (human or headless agent resume)
  diffgloss pr-comment [options]                     Sync sticky ledger & fingerprinted inline findings to GitHub PR
  diffgloss mcp                                      Start MCP JSON-RPC 2.0 stdio server for coding agents
  diffgloss hooks <init|capture|stop-check>          Install/run write-time provenance hooks & Stop gate
  diffgloss eval [options]                           Run golden evaluation harness (mock or live provider)

Common options (inspect / explain):
  --diff <file>              Read unified diff from file instead of git diff
  --base <ref>               Base git ref for reading trusted rule files (default: auto-detected from A..B)
  --intent <text>            Declared intent (prompt / plan / PR description)
  --intent-file <file>       Read declared intent from a file (e.g. SPEC.md)
  --title <text>             Custom report title
  --sarif <file>             Import external SARIF 2.1.0 findings onto matching hunks
  --transcript <file>        Optional local JSONL transcript for Tier-2 provenance lookup
  --no-auto-sessions         Disable automatic local ~/.claude & ~/.codex session discovery
  --out <file>               Output HTML report path (default: .diffgloss/report.html)
  --json-out <file>          Output JSON ledger path (default: .diffgloss/ledger.json)
  --md-out <file>            Also write Markdown report
  --sarif-out <file>         Also write SARIF 2.1.0 report
  --rdjsonl-out <file>       Also write reviewdog rdjsonl diagnostics
  --serve                    Serve interactive browser UI locally
  --port <number>            Port for --serve (default: 4317)

LLM options (explain / eval):
  --provider <dialect>       anthropic | openai | openai-chat | deepseek | google | mock
  --model <name>             Model identifier (e.g. deepseek-chat, claude-sonnet-4-5, gpt-5.1)
  --base-url <url>           Custom API base URL
  --judge                    Enable cold-start semantic grounding judge
  --review                   Also run isolated parallel specialist review + symmetric-proof verifier
  --judge-provider <dialect> Cross-model judge/verifier provider
  --judge-model <name>       Cross-model judge/verifier model
  --effort <level>           quick | standard | deep
  --budget <usd>             Hard USD budget cap
  --dry-run                  Estimate tokens and USD cost without calling any LLM API

PR Comment options:
  --repo <owner/repo>        GitHub repository slug
  --pr <number>              Pull request number
  --ledger <file>            Ledger JSON path (default: .diffgloss/ledger.json)
  --dry-run                  Print sync plan without posting to GitHub
`);
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function stripFlags(
  args: string[],
  valueFlags: Set<string>,
  boolFlags: Set<string>,
): string[] {
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (valueFlags.has(arg)) {
      i += 1;
      continue;
    }
    if (boolFlags.has(arg)) continue;
    rest.push(arg);
  }
  return rest;
}

function writeFileEnsuringDir(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

function inferBaseRef(gitDiffArgs: string[]): string | undefined {
  for (const arg of gitDiffArgs) {
    const dots = /^([^\s.]+)\.{2,3}/.exec(arg);
    if (dots?.[1]) return dots[1];
  }
  return undefined;
}

function writeAllOutputs(
  ledger: ExplanationLedger,
  opts: {
    outJson?: string;
    outHtml?: string;
    outMd?: string;
    outSarif?: string;
    outRdjsonl?: string;
    liveServer?: boolean;
  },
): string {
  const html = renderHtmlReport(ledger, { liveServer: opts.liveServer });
  if (opts.outJson) {
    writeFileEnsuringDir(opts.outJson, JSON.stringify(ledger, null, 2));
    console.log(`Ledger JSON   -> ${opts.outJson}`);
  }
  if (opts.outHtml) {
    writeFileEnsuringDir(opts.outHtml, html);
    console.log(`HTML Report   -> ${opts.outHtml}`);
  }
  if (opts.outMd) {
    writeFileEnsuringDir(opts.outMd, renderMarkdownReport(ledger));
    console.log(`Markdown      -> ${opts.outMd}`);
  }
  if (opts.outSarif) {
    writeFileEnsuringDir(opts.outSarif, exportSarifReport(ledger));
    console.log(`SARIF 2.1.0   -> ${opts.outSarif}`);
  }
  if (opts.outRdjsonl) {
    writeFileEnsuringDir(opts.outRdjsonl, exportRdjsonl(ledger));
    console.log(`rdjsonl       -> ${opts.outRdjsonl}`);
  }
  return html;
}

function buildConfigOverrides(args: string[]): Partial<DiffglossConfig> {
  const overrides: Partial<DiffglossConfig> = {};
  const explainerMode = getFlagValue(args, "--explainer-mode");
  const authorCli = getFlagValue(args, "--author-cli");
  const provider = getFlagValue(args, "--provider") as ProviderDialect | undefined;
  const model = getFlagValue(args, "--model");
  const baseUrl = getFlagValue(args, "--base-url");
  const judgeProvider = getFlagValue(args, "--judge-provider") as ProviderDialect | undefined;
  const judgeModel = getFlagValue(args, "--judge-model");
  const effort = getFlagValue(args, "--effort") as EffortLevel | undefined;
  const budgetStr = getFlagValue(args, "--budget");

  if (explainerMode === "author_cli" || explainerMode === "api_model") {
    overrides.explainer_mode = explainerMode;
  }
  if (
    authorCli === "auto" ||
    authorCli === "claude-cli" ||
    authorCli === "codex-cli"
  ) {
    overrides.author_cli = authorCli;
  }
  if (provider) {
    overrides.provider = provider;
    if (!model && provider === "deepseek") {
      overrides.model = "deepseek-chat";
    }
  }
  if (model) overrides.model = model;
  if (baseUrl) overrides.base_url = baseUrl;
  if (judgeProvider) overrides.judge_provider = judgeProvider;
  if (judgeModel) overrides.judge_model = judgeModel;
  if (effort) overrides.effort = effort;
  if (budgetStr) overrides.budget_usd = Number.parseFloat(budgetStr);

  return overrides;
}

function loadDiffAndBaseLedger(
  cwd: string,
  args: string[],
  config: DiffglossConfig,
) {
  const diffFile = getFlagValue(args, "--diff");
  const intentFile = getFlagValue(args, "--intent-file");
  const intent =
    getFlagValue(args, "--intent") ??
    (intentFile ? readFileSync(intentFile, "utf8").trim() : undefined);
  const title = getFlagValue(args, "--title");
  const sarifFile = getFlagValue(args, "--sarif");
  const transcriptFile = getFlagValue(args, "--transcript");
  const explicitBase = getFlagValue(args, "--base");
  const noAutoSessions = args.includes("--no-auto-sessions");

  const gitDiffArgs = stripFlags(
    args,
    new Set([
      "--diff",
      "--base",
      "--intent",
      "--intent-file",
      "--title",
      "--sarif",
      "--transcript",
      "--out",
      "--json-out",
      "--md-out",
      "--sarif-out",
      "--rdjsonl-out",
      "--port",
      "--provider",
      "--model",
      "--base-url",
      "--explainer-mode",
      "--author-cli",
      "--judge-provider",
      "--judge-model",
      "--effort",
      "--budget",
    ]),
    new Set(["--serve", "--dry-run", "--judge", "--audit", "--review", "--no-auto-sessions"]),
  );

  const rawDiff = diffFile
    ? readFileSync(diffFile, "utf8")
    : execFileSync("git", ["diff", "--no-color", ...gitDiffArgs], {
        cwd,
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
      });

  const baseRef = explicitBase ?? inferBaseRef(gitDiffArgs);
  const ledger = buildInitialLedger(rawDiff, {
    cwd,
    title: title ?? `Diffgloss: ${path.basename(cwd)}`,
    declaredIntent: intent,
    declaredIntentRef: intentFile ? "plan" : intent ? "prompt" : "none",
    source: {
      repo: path.basename(cwd),
      base_ref: baseRef,
      diff_args: diffFile ? [`--diff ${diffFile}`] : gitDiffArgs,
    },
    splitLargeHunks: config.split_large_hunks,
    subhunkLineThreshold: config.subhunk_line_threshold,
    ignorePatterns: config.ignore,
  });

  // Load & run deterministic structured rules from .diffgloss/rules/*.md
  const structuredRules = loadStructuredRules(cwd, {
    baseRef,
    rulesFromBase: config.rules_from_base,
  });
  const ruleEval = evaluateStructuredRules(structuredRules, ledger.hunks);
  if (ruleEval.findings.length > 0) {
    const merged = [...(ledger.findings ?? []), ...ruleEval.findings];
    attachFindingsToHunks(ledger.hunks, merged);
    ledger.findings = merged;
  }
  if (ruleEval.telemetry.length > 0) {
    ledger.rule_telemetry = ruleEval.telemetry;
  }

  // Attach external SARIF findings if provided
  if (sarifFile) {
    const imported = importSarifFindings(readFileSync(sarifFile, "utf8"));
    const merged = [...(ledger.findings ?? []), ...imported];
    attachFindingsToHunks(ledger.hunks, merged);
    ledger.findings = merged;
  }

  // Enrich with Tiers 1-2 provenance (hooks, explicit/auto-discovered transcripts, git-ai, agent-trace, entire)
  const provStats = enrichLedgerProvenance(ledger, {
    cwd,
    transcriptPath: transcriptFile,
    autoDiscover: !noAutoSessions,
    redact: config.redact_secrets,
  });
  if (provStats.matchedHunks > 0) {
    console.log(
      `Provenance: matched ${provStats.matchedHunks} hunk(s) via [${provStats.sourcesUsed.join(", ")}] (${provStats.redactions} redaction(s))`,
    );
  }

  return {
    ledger,
    baseRef,
    scopedLlmRules: ruleEval.scopedLlmRules,
    ruleTelemetry: ruleEval.telemetry,
  };
}

async function runInspectOrExplain(mode: "inspect" | "explain", args: string[]): Promise<void> {
  const cwd = process.cwd();
  const config = loadConfig(cwd, buildConfigOverrides(args));
  const outHtml = getFlagValue(args, "--out") ?? ".diffgloss/report.html";
  const outJson = getFlagValue(args, "--json-out") ?? ".diffgloss/ledger.json";
  const outMd = getFlagValue(args, "--md-out");
  const outSarif = getFlagValue(args, "--sarif-out");
  const outRdjsonl = getFlagValue(args, "--rdjsonl-out");
  const shouldServe = args.includes("--serve");
  const dryRun = args.includes("--dry-run");
  const runAudit = args.includes("--audit");
  const runJudge = args.includes("--judge") || config.effort === "deep";
  const runReview = args.includes("--review");
  const port = Number.parseInt(getFlagValue(args, "--port") ?? "4317", 10);

  let { ledger, baseRef, scopedLlmRules, ruleTelemetry } = loadDiffAndBaseLedger(
    cwd,
    args,
    config,
  );

  if (mode === "explain") {
    const changedPaths = [...new Set(ledger.hunks.map((h) => h.path))];
    const ruleDocs = discoverRuleDocs(cwd, changedPaths, {
      baseRef,
      rulesFromBase: config.rules_from_base,
    });

    if (dryRun) {
      const est = estimateExplainCost(ledger, {
        cwd,
        config,
        ruleDocs,
        runJudge,
      });
      console.log(`Dry-run estimate (${config.provider}/${config.model}, effort=${config.effort}):`);
      console.log(`  Hunks to explain : ${est.hunksToExplain} (${est.batches} batch(es))`);
      console.log(`  Est. input tokens: ${est.estimatedInputTokens}`);
      console.log(`  Est. output tok. : ${est.estimatedOutputTokens}`);
      console.log(`  Est. cost (USD)  : $${est.estimatedUsd.toFixed(4)} (budget: $${est.budgetUsd.toFixed(2)})`);
      console.log(`  Within budget    : ${est.withinBudget ? "YES" : "NO"}`);
      console.log(`  Rules loaded     : ${ruleDocs.map((d) => `${d.path} (${d.source})`).join(", ") || "none"}`);
      return;
    }

    ledger = await explainLedger(ledger, {
      cwd,
      config,
      ruleDocs,
      runJudge: runAudit ? false : runJudge,
    });

    if (runAudit) {
      ledger = await auditLedgerLines(ledger, { config });
    }

    if (runReview) {
      ledger = await runSymmetricProofReview(ledger, {
        config,
        scopedLlmRules,
        ruleTelemetry,
      });
    }
  }

  const validation = validateLedger(ledger);
  if (!validation.ok) {
    console.error("Ledger validation failed:");
    for (const err of validation.errors) console.error(`  - ${err}`);
    process.exit(1);
  }

  const c = ledger.coverage;
  console.log(
    `Coverage: total=${c.total} | explained=${c.explained} | collapsed=${c.collapsed} | unexplained=${c.unexplained}`,
  );
  if (ledger.cost) {
    console.log(
      `Cost: $${ledger.cost.estimated_usd.toFixed(4)} / $${ledger.cost.budget_usd.toFixed(2)} (${ledger.cost.input_tokens} in, ${ledger.cost.output_tokens} out)`,
    );
  }
  if (ledger.questions.length > 0) {
    console.log(`Clarifying questions: ${ledger.questions.length}`);
  }
  if ((ledger.findings?.length ?? 0) > 0) {
    console.log(`Attached findings: ${ledger.findings!.length}`);
  }
  if ((ledger.ruled_out?.length ?? 0) > 0) {
    console.log(`Ruled-out proof entries: ${ledger.ruled_out!.length}`);
  }

  writeAllOutputs(ledger, {
    outJson,
    outHtml,
    outMd,
    outSarif,
    outRdjsonl,
    liveServer: shouldServe,
  });

  if (shouldServe) {
    startPreviewServer({
      port,
      cwd,
      ledger,
      jsonOutPath: outJson,
      htmlOutPath: outHtml,
      config,
    });
  }
}

function runRender(args: string[]): void {
  const inputPath = args[0];
  if (!inputPath) {
    console.error("Error: missing <ledger.json> path.");
    process.exit(1);
  }
  const outHtml = getFlagValue(args, "--out") ?? ".diffgloss/report.html";
  const outMd = getFlagValue(args, "--md-out");
  const outSarif = getFlagValue(args, "--sarif-out");
  const outRdjsonl = getFlagValue(args, "--rdjsonl-out");
  const shouldServe = args.includes("--serve");
  const port = Number.parseInt(getFlagValue(args, "--port") ?? "4317", 10);

  const ledger = JSON.parse(readFileSync(inputPath, "utf8")) as ExplanationLedger;
  const validation = validateLedger(ledger);
  if (!validation.ok) {
    console.error("Ledger validation errors:");
    for (const err of validation.errors) console.error(`  - ${err}`);
    process.exit(1);
  }

  writeAllOutputs(ledger, {
    outHtml,
    outMd,
    outSarif,
    outRdjsonl,
    liveServer: shouldServe,
  });

  if (shouldServe) {
    startPreviewServer({
      port,
      cwd: process.cwd(),
      ledger,
      jsonOutPath: inputPath,
      htmlOutPath: outHtml,
    });
  }
}

function runValidate(args: string[]): void {
  const inputPath = args[0];
  if (!inputPath) {
    console.error("Error: missing <ledger.json> path.");
    process.exit(1);
  }
  const maxUnexplainedRaw = getFlagValue(args, "--max-unexplained");
  const ledger = JSON.parse(readFileSync(inputPath, "utf8")) as ExplanationLedger;
  const res = validateLedger(ledger);

  console.log(
    `Coverage: total=${res.computed_coverage.total}, explained=${res.computed_coverage.explained}, collapsed=${res.computed_coverage.collapsed}, unexplained=${res.computed_coverage.unexplained}`,
  );
  for (const warn of res.warnings) {
    console.warn(`WARN: ${warn}`);
  }
  if (!res.ok) {
    for (const err of res.errors) console.error(`ERROR: ${err}`);
    process.exit(1);
  }
  if (maxUnexplainedRaw !== undefined) {
    const limit = Number.parseInt(maxUnexplainedRaw, 10);
    if (res.computed_coverage.unexplained > limit) {
      console.error(
        `CI GATE FAILED: unexplained hunks (${res.computed_coverage.unexplained}) exceeds --max-unexplained ${limit}.`,
      );
      process.exit(2);
    }
  }
  console.log("Ledger is valid.");
}

async function runAnswer(args: string[]): Promise<void> {
  const ledgerPath = args[0];
  const qid = args[1];
  if (!ledgerPath || !qid) {
    console.error("Usage: diffgloss answer <ledger.json> <qid> --text <answer> [--verify]");
    process.exit(1);
  }

  const cwd = process.cwd();
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as ExplanationLedger;
  const question = ledger.questions.find((q) => q.id === qid);
  if (!question) {
    console.error(`Question '${qid}' not found in ${ledgerPath}.`);
    process.exit(1);
  }

  let answerText = getFlagValue(args, "--text");
  let answeredBy = "human";
  let channel: "human" | "session_resume" = "human";
  let sessionForked = false;

  const resumeClaude = getFlagValue(args, "--resume-claude");
  const resumeCodex = getFlagValue(args, "--resume-codex");

  if (resumeClaude) {
    const res = askAuthorAgentSession("claude", resumeClaude, question.question, cwd);
    answerText = res.text;
    answeredBy = res.answeredBy;
    channel = "session_resume";
    sessionForked = res.sessionForked;
  } else if (resumeCodex) {
    const res = askAuthorAgentSession("codex", resumeCodex, question.question, cwd);
    answerText = res.text;
    answeredBy = res.answeredBy;
    channel = "session_resume";
    sessionForked = res.sessionForked;
  }

  if (!answerText) {
    console.error("Error: provide --text <answer>, --resume-claude <sid>, or --resume-codex <sid>.");
    process.exit(1);
  }

  const shouldVerify = args.includes("--verify");
  const config = shouldVerify ? loadConfig(cwd, buildConfigOverrides(args)) : undefined;

  const outcome = await recordAndVerifyAnswer(ledger, qid, answerText, {
    answeredBy,
    channel,
    sessionForked,
    config,
  });

  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");
  const outHtml = getFlagValue(args, "--out");
  if (outHtml) {
    writeFileEnsuringDir(outHtml, renderHtmlReport(ledger));
    console.log(`Updated HTML  -> ${outHtml}`);
  }

  console.log(`Question ${qid}: verdict=${outcome.verdict}`);
  for (const ev of outcome.evidence) console.log(`  - ${ev}`);
  if (outcome.promotedHunks.length > 0) {
    console.log(`Promoted to explained: ${outcome.promotedHunks.join(", ")}`);
  }
}

async function runPrComment(args: string[]): Promise<void> {
  const repo = getFlagValue(args, "--repo") ?? process.env.GITHUB_REPOSITORY;
  const prRaw = getFlagValue(args, "--pr");
  const ledgerPath = getFlagValue(args, "--ledger") ?? ".diffgloss/ledger.json";
  const dryRun = args.includes("--dry-run");
  const token = process.env.GITHUB_TOKEN ?? "";

  if (!repo || !prRaw) {
    console.error("Usage: diffgloss pr-comment --repo owner/repo --pr <number> [--ledger file] [--dry-run]");
    process.exit(1);
  }
  if (!token) {
    console.error("Error: GITHUB_TOKEN environment variable is required.");
    process.exit(1);
  }

  const pr = Number.parseInt(prRaw, 10);
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as ExplanationLedger;
  const plan = await syncLedgerToGitHub({ repo, pr, token, ledger, dryRun });

  console.log(
    `GitHub PR #${pr} sync (${dryRun ? "DRY RUN" : "APPLIED"}): overview=${plan.overviewAction}, newInline=${plan.newInlineComments.length}, unchanged=${plan.unchangedFingerprints.length}, resolved=${plan.resolvedCommentIds.length}, skippedOutOfDiff=${plan.skippedOutOfDiffCount}`,
  );
}

function runHooks(args: string[]): void {
  const sub = args[0];
  if (sub === "init") {
    const strictStop = args.includes("--strict");
    console.log(JSON.stringify(generateClaudeHooksSnippet({ strictStop }), null, 2));
    return;
  }
  if (sub === "stop-check") {
    const decision = evaluateStopHook(process.cwd());
    console.log(JSON.stringify(decision));
    return;
  }
  if (sub === "capture") {
    const cwd = process.cwd();
    const agent = getFlagValue(args, "--agent") ?? "unknown";
    const stdinRaw = readFileSync(0, "utf8").trim();
    if (!stdinRaw) return;
    const payload = JSON.parse(stdinRaw) as {
      session_id?: string;
      transcript_path?: string;
      tool_name?: string;
      tool_input?: { file_path?: string; path?: string };
      rationale?: string;
    };
    const targetPath =
      payload.tool_input?.file_path ?? payload.tool_input?.path ?? "";
    if (!targetPath) return;

    const out = appendWriteTimeManifest(cwd, {
      at: new Date().toISOString(),
      session_id: payload.session_id,
      agent,
      path: targetPath,
      tool: payload.tool_name,
      rationale: payload.rationale,
      transcript_path: payload.transcript_path,
    });
    console.log(`Recorded provenance -> ${out}`);
    return;
  }

  console.error("Usage: diffgloss hooks <init|capture|stop-check>");
  process.exit(1);
}

async function runEval(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const casesPath =
    getFlagValue(args, "--cases") ??
    defaultGoldenCasesPath(path.resolve(import.meta.dirname, ".."));
  const provider = (getFlagValue(args, "--provider") as ProviderDialect | undefined) ?? "mock";
  const model = getFlagValue(args, "--model");
  const baseUrl = getFlagValue(args, "--base-url");
  const limitRaw = getFlagValue(args, "--limit");
  const runJudge = args.includes("--judge");

  const report = await runGoldenEvalSuite(casesPath, cwd, {
    provider,
    model,
    baseUrl,
    runJudge: provider === "mock" ? true : runJudge,
    limit: limitRaw ? Number.parseInt(limitRaw, 10) : undefined,
  });

  console.log(
    `Diffgloss Golden Eval Suite [${report.provider}/${report.model}] (${report.passed_cases}/${report.total_cases} passed, ${(report.total_duration_ms / 1000).toFixed(2)}s, est. $${report.total_estimated_usd.toFixed(4)})`,
  );
  console.log(
    `  Coverage invariant rate : ${(report.coverage_invariant_rate * 100).toFixed(1)}%`,
  );
  console.log(
    `  Citation validity rate  : ${(report.citation_valid_rate * 100).toFixed(1)}%`,
  );
  console.log(`  False mechanical hides  : ${report.false_collapse_total}`);

  for (const c of report.cases) {
    console.log(
      `  [${c.passed ? "PASS" : "FAIL"}] ${c.id} (${c.duration_ms}ms · total=${c.metrics.total_hunks}, explained=${c.metrics.explained}, collapsed=${c.metrics.collapsed}, unexplained=${c.metrics.unexplained})`,
    );
    for (const f of c.failures) console.log(`         -> ${f}`);
  }

  if (report.passed_cases !== report.total_cases) {
    process.exit(1);
  }
}

async function runUi(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const config = loadConfig(cwd, buildConfigOverrides(args));
  const outHtml = getFlagValue(args, "--out") ?? ".diffgloss/report.html";
  const outJson = getFlagValue(args, "--json-out") ?? ".diffgloss/ledger.json";
  const port = Number.parseInt(getFlagValue(args, "--port") ?? "4317", 10);

  // If user passed explicit diff args or --diff, honor them; otherwise auto-load working tree or latest commit!
  const positional = stripFlags(
    args,
    new Set(["--diff", "--base", "--intent", "--intent-file", "--title", "--out", "--json-out", "--port", "--repo"]),
    new Set(["--serve"]),
  );
  const targetRepo = getFlagValue(args, "--repo") ?? cwd;

  if (positional.length > 0 || args.includes("--diff")) {
    await runInspectOrExplain("inspect", [...args, "--serve"]);
    return;
  }

  const root = resolveGitTopLevel(targetRepo);
  let extracted: {
    raw_diff: string;
    title: string;
    declared_intent?: string;
    declared_intent_ref: "commit_message" | "none";
    base_ref?: string;
    head_ref?: string;
    diff_args: string[];
  };

  if (root) {
    extracted = extractRepoDiff(root, { mode: "working" });
    if (!extracted.raw_diff.trim()) {
      try {
        extracted = extractRepoDiff(root, { mode: "commit", sha: "HEAD" });
      } catch {
        // Empty repo with no commits yet
      }
    }
  } else {
    extracted = {
      raw_diff: "",
      title: "Diffgloss — Drop a Git Repository Folder or Click '📂 Repo / Commit'",
      declared_intent_ref: "none",
      diff_args: [],
    };
  }

  const activeCwd = root ?? cwd;
  const ledger = buildInitialLedger(extracted.raw_diff, {
    cwd: activeCwd,
    title: extracted.title,
    declaredIntent: extracted.declared_intent,
    declaredIntentRef: extracted.declared_intent_ref,
    source: {
      repo: root ? path.basename(root) : "welcome",
      base_ref: extracted.base_ref,
      head_ref: extracted.head_ref,
      diff_args: extracted.diff_args,
    },
    splitLargeHunks: config.split_large_hunks,
    subhunkLineThreshold: config.subhunk_line_threshold,
    ignorePatterns: config.ignore,
  });

  if (root) {
    try {
      writeAllOutputs(ledger, { outJson, outHtml, liveServer: false });
    } catch {
      // Non-fatal if cwd is read-only when launched as Desktop App
    }
  }
  startPreviewServer({
    port,
    cwd: activeCwd,
    ledger,
    jsonOutPath: root ? outJson : undefined,
    htmlOutPath: root ? outHtml : undefined,
    config,
  });
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === "-h" || cmd === "--help") {
    printHelp();
    return;
  }
  switch (cmd) {
    case "ui":
      await runUi(rest);
      break;
    case "inspect":
      await runInspectOrExplain("inspect", rest);
      break;
    case "explain":
      await runInspectOrExplain("explain", rest);
      break;
    case "render":
      runRender(rest);
      break;
    case "validate":
      runValidate(rest);
      break;
    case "answer":
      await runAnswer(rest);
      break;
    case "pr-comment":
      await runPrComment(rest);
      break;
    case "mcp":
      startMcpStdioServer(process.cwd());
      break;
    case "hooks":
      runHooks(rest);
      break;
    case "eval":
      await runEval(rest);
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
