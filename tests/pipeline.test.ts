import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, parseSimpleYaml } from "../src/config/loader.ts";
import { detectCrossFileMoves } from "../src/diff/moves.ts";
import { parseUnifiedDiff } from "../src/diff/parser.ts";
import { splitLargeHunks } from "../src/diff/subhunk.ts";
import { defaultGoldenCasesPath, runGoldenEvalSuite } from "../src/eval/harness.ts";
import {
  exportRdjsonl,
  exportSarifReport,
  importSarifFindings,
} from "../src/interop/sarif.ts";
import { BudgetExceededError, BudgetTracker } from "../src/llm/budget.ts";
import { MockLLMClient } from "../src/llm/providers.ts";
import type { LLMClient, LLMRequest, LLMResponse } from "../src/llm/types.ts";
import { estimateExplainCost, explainLedger } from "../src/pipeline/explainer.ts";
import { attachFindingsToHunks } from "../src/pipeline/integrity.ts";
import { buildInitialLedger } from "../src/pipeline/ledger.ts";
import {
  appendWriteTimeManifest,
  enrichLedgerProvenance,
} from "../src/provenance/capture.ts";
import { recordAndVerifyAnswer } from "../src/provenance/questioner.ts";
import { redactSecrets } from "../src/provenance/redactor.ts";
import { renderMarkdownReport } from "../src/render/markdown.ts";
import { validateLedger } from "../src/schema/validate.ts";

describe("parseSimpleYaml", () => {
  it("parses scalars, booleans, numbers, and string lists", () => {
    const parsed = parseSimpleYaml(`
# comment
provider: openai
model: gpt-5.1
budget_usd: 2.5
rules_from_base: true
ignore:
  - "**/*.generated.ts"
  - "vendor/**"
`);
    expect(parsed.provider).toBe("openai");
    expect(parsed.model).toBe("gpt-5.1");
    expect(parsed.budget_usd).toBe(2.5);
    expect(parsed.rules_from_base).toBe(true);
    expect(parsed.ignore).toEqual(["**/*.generated.ts", "vendor/**"]);
  });
});

describe("splitLargeHunks & detectCrossFileMoves", () => {
  it("splits an oversized multi-function hunk into separate semantic sub-hunks", () => {
    const bigDiff = `diff --git a/src/service.ts b/src/service.ts
--- a/src/service.ts
+++ b/src/service.ts
@@ -1,2 +1,16 @@
+export function alpha(x: number) {
+  const a = x + 1;
+  const b = a * 2;
+  const c = b - 3;
+  const d = c + 4;
+  return d;
+}
+
+export function beta(y: number) {
+  const e = y + 10;
+  const f = e * 20;
+  const g = f - 30;
+  const h = g + 40;
+  return h;
+}
`;
    const parsed = parseUnifiedDiff(bigDiff);
    expect(parsed.hunks.length).toBe(1);
    const split = splitLargeHunks(parsed.hunks, 10);
    expect(split.length).toBe(2);
    expect(split[0]?.enclosing_symbol).toContain("alpha");
    expect(split[1]?.enclosing_symbol).toContain("beta");
  });

  it("detects cross-file verbatim code moves", () => {
    const moveDiff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,5 +10,0 @@
-export function helper(v: number) {
-  const doubled = v * 2;
-  if (doubled > 10) return 10;
-  return doubled;
-}
diff --git a/src/b.ts b/src/b.ts
new file mode 100644
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1,5 @@
+export function helper(v: number) {
+  const doubled = v * 2;
+  if (doubled > 10) return 10;
+  return doubled;
+}
`;
    const parsed = parseUnifiedDiff(moveDiff);
    const withMoves = detectCrossFileMoves(parsed.hunks);
    const dest = withMoves.find((h) => h.path === "src/b.ts");
    expect(dest?.moved_from?.path).toBe("src/a.ts");
  });
});

describe("Secret Redaction & Provenance Capture", () => {
  it("redacts API keys, tokens, JWTs, and password assignments", () => {
    const sample =
      "Using sk-ant-api03-1234567890abcdef123456 and ghp_abcdefghijklmnopqrstuvwxyz1234 with password=mySecretValue123";
    const res = redactSecrets(sample);
    expect(res.redactions).toBeGreaterThanOrEqual(3);
    expect(res.text).not.toContain("sk-ant-api03");
    expect(res.text).not.toContain("ghp_abcdef");
    expect(res.text).not.toContain("mySecretValue123");
  });

  it("enriches hunks from write-time manifest and JSONL transcript with redaction", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "diffgloss-prov-"));
    try {
      const transcriptPath = path.join(tmpDir, "session.jsonl");
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({
          sessionId: "sess_99",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "Adding timeout guard using key sk-ant-secretvalue123456789012345",
              },
              {
                type: "tool_use",
                id: "tu_1",
                name: "Edit",
                input: { file_path: "src/client.ts" },
              },
            ],
          },
        })}\n`,
        "utf8",
      );

      appendWriteTimeManifest(tmpDir, {
        at: new Date().toISOString(),
        session_id: "sess_99",
        agent: "claude-code",
        path: "src/client.ts",
        tool: "Edit",
        transcript_path: transcriptPath,
      });

      const diff = `diff --git a/src/client.ts b/src/client.ts
--- a/src/client.ts
+++ b/src/client.ts
@@ -1,2 +1,3 @@
 export function fetchApi() {
+  const timeout = 5000;
   return timeout;
 }
`;
      const ledger = buildInitialLedger(diff);
      const stats = enrichLedgerProvenance(ledger, { cwd: tmpDir, redact: true });
      expect(stats.matchedHunks).toBe(1);
      expect(stats.redactions).toBeGreaterThanOrEqual(1);
      expect(ledger.hunks[0]?.why?.source).toBe("transcript");
      expect(ledger.hunks[0]?.why?.text).not.toContain("sk-ant-secretvalue");
      expect(ledger.hunks[0]?.why?.text).toContain("[REDACTED:ANTHROPIC_KEY]");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Explainer, Citation Demotion, Budget Guard, and Q&A Verification", () => {
  it("demotes hallucinated citations to unexplained after failed repair", async () => {
    const brokenClient: LLMClient = {
      provider: "mock",
      model: "broken-mock",
      async complete(_req: LLMRequest): Promise<LLMResponse> {
        return {
          provider: "mock",
          model: "broken-mock",
          text: JSON.stringify({
            behavior_change: "Broken claims.",
            groups: [
              {
                title: "Group",
                intent: "Intent",
                risk: "low",
                hunk_ids: [],
              },
            ],
            hunks: [
              {
                id: "WILL_BE_REPLACED",
                status: "explained",
                what_text: "Calls `fabricatedSymbolName` on line 999.",
                citations: [{ path: "src/app.ts", lines: [999, 1001], side: "new" }],
                why_text: "Made up.",
                why_source: "reviewer_inferred",
              },
            ],
          }),
          usage: { inputTokens: 100, outputTokens: 80, cachedInputTokens: 0 },
        };
      },
    };

    const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,3 @@
 export function run() {
+  return 42;
 }
`;
    const initial = buildInitialLedger(diff);
    const targetId = initial.hunks[0]!.id;
    const wrappedClient: LLMClient = {
      provider: "mock",
      model: "broken-mock",
      async complete(req: LLMRequest): Promise<LLMResponse> {
        const res = await brokenClient.complete(req);
        return { ...res, text: res.text.replace("WILL_BE_REPLACED", targetId) };
      },
    };

    const out = await explainLedger(initial, {
      cwd: process.cwd(),
      config: { ...DEFAULT_CONFIG, provider: "mock", model: "broken-mock" },
      clientOverride: wrappedClient,
    });

    expect(out.hunks[0]?.status).toBe("unexplained");
    expect(
      out.findings?.some(
        (f) => f.rule_id === "diffgloss/citation-verification-failed",
      ),
    ).toBe(true);
    expect(validateLedger(out).ok).toBe(true);
  });

  it("enforces hard USD budget cap cleanly", () => {
    const tracker = new BudgetTracker("anthropic", "claude-opus-4", 0.001);
    expect(() =>
      tracker.checkBeforeCall("claude-opus-4", "x".repeat(4000), 2000),
    ).toThrow(BudgetExceededError);
  });

  it("estimates dry-run cost and verifies Q&A answers with cold-start verifier", async () => {
    const diff = `diff --git a/src/auth/check.ts b/src/auth/check.ts
--- a/src/auth/check.ts
+++ b/src/auth/check.ts
@@ -5,5 +5,2 @@ export function check(user: User) {
 export function check(user: User) {
-  if (!user.verified) {
-    throw new Error("unverified");
-  }
   return true;
 }
`;
    const initial = buildInitialLedger(diff, {
      declaredIntent: "Simplify check",
    });

    const est = estimateExplainCost(initial, {
      cwd: process.cwd(),
      config: { ...DEFAULT_CONFIG, model: "claude-sonnet-4-5" },
    });
    expect(est.hunksToExplain).toBe(1);
    expect(est.estimatedUsd).toBeGreaterThan(0);

    const explained = await explainLedger(initial, {
      cwd: process.cwd(),
      config: { ...DEFAULT_CONFIG, provider: "mock", model: "mock" },
      clientOverride: new MockLLMClient("mock"),
    });
    expect(explained.questions.length).toBeGreaterThanOrEqual(1);

    const qid = explained.questions[0]!.id;
    const outcome = await recordAndVerifyAnswer(
      explained,
      qid,
      "Moved verification into src/auth/middleware.ts:42 before routing.",
      { verifierClient: new MockLLMClient("mock-verifier") },
    );
    expect(outcome.verdict).toBe("confirmed");
    expect(explained.questions[0]?.verdict?.status).toBe("confirmed");
  });
});

describe("SARIF, rdjsonl, Markdown & Golden Eval Suite", () => {
  it("imports external SARIF findings onto matching hunks and exports SARIF/rdjsonl/Markdown", () => {
    const diff = `diff --git a/src/db.ts b/src/db.ts
--- a/src/db.ts
+++ b/src/db.ts
@@ -10,3 +10,4 @@ export function queryUser(id: string) {
 export function queryUser(id: string) {
+  return db.query("SELECT * FROM users WHERE id = " + id);
 }
`;
    const ledger = buildInitialLedger(diff);
    const sarifIn = JSON.stringify({
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "semgrep" } },
          results: [
            {
              ruleId: "sql-injection",
              level: "error",
              message: { text: "String concatenation in SQL query" },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: "src/db.ts" },
                    region: { startLine: 11, endLine: 11 },
                  },
                },
              ],
            },
          ],
        },
      ],
    });

    const imported = importSarifFindings(sarifIn);
    expect(imported.length).toBe(1);
    attachFindingsToHunks(ledger.hunks, imported);
    ledger.findings = imported;

    expect(ledger.hunks[0]?.finding_ids).toEqual([imported[0]!.id]);

    const sarifOut = JSON.parse(exportSarifReport(ledger)) as {
      version: string;
      runs: Array<{ results: unknown[] }>;
    };
    expect(sarifOut.version).toBe("2.1.0");
    expect(sarifOut.runs[0]?.results.length).toBeGreaterThanOrEqual(1);

    const rdjsonl = exportRdjsonl(ledger);
    expect(rdjsonl).toContain("sql-injection");

    const md = renderMarkdownReport(ledger);
    expect(md).toContain("## Coverage Ledger");
    expect(md).toContain("sql-injection");
  });

  it("passes 100% of offline golden evaluation cases with zero false collapses", async () => {
    const casesPath = defaultGoldenCasesPath(
      path.resolve(import.meta.dirname, ".."),
    );
    const report = await runGoldenEvalSuite(casesPath, process.cwd());
    expect(report.passed_cases).toBe(report.total_cases);
    expect(report.false_collapse_total).toBe(0);
    expect(report.coverage_invariant_rate).toBe(1);
    expect(report.citation_valid_rate).toBe(1);
  });
});
