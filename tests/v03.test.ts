import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "../src/config/loader.ts";
import { resolvePreferredAuthorCli } from "../src/llm/author-adapter.ts";
import { MockLLMClient } from "../src/llm/providers.ts";
import {
  auditLedgerLines,
  extractChangedLinesWithNumbers,
} from "../src/pipeline/auditor.ts";
import { computeHunkCacheKey, HunkResultCache } from "../src/pipeline/cache.ts";
import { explainLedger } from "../src/pipeline/explainer.ts";
import { buildInitialLedger } from "../src/pipeline/ledger.ts";
import { validateLedger } from "../src/schema/validate.ts";

describe("AuthorAdapter CLI Resolution", () => {
  it("resolves preferred author CLI cleanly with graceful fallback", () => {
    const both = {
      claude: { available: true, version: "2.1.329" },
      codex: { available: true, version: "0.170.0" },
    };
    const none = {
      claude: { available: false },
      codex: { available: false },
    };
    expect(resolvePreferredAuthorCli("auto", both)).toBe("codex-cli");
    expect(resolvePreferredAuthorCli("claude-cli", both)).toBe("claude-cli");
    expect(resolvePreferredAuthorCli("auto", none)).toBeNull();
  });
});

describe("HunkResultCache", () => {
  it("caches explained hunks by content hash and hits cache without calling LLM again", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "diffgloss-cache-"));
    try {
      const diff = `diff --git a/src/math.ts b/src/math.ts
--- a/src/math.ts
+++ b/src/math.ts
@@ -1,2 +1,3 @@
 export function add(a: number, b: number) {
+  if (!Number.isFinite(a)) return 0;
   return a + b;
 }
`;
      const initial1 = buildInitialLedger(diff, { declaredIntent: "Guard NaN" });
      let callCount = 0;
      const countingMock = new MockLLMClient("mock-cache");
      const wrapped = {
        provider: countingMock.provider,
        model: countingMock.model,
        async complete(req: Parameters<MockLLMClient["complete"]>[0]) {
          callCount += 1;
          return countingMock.complete(req);
        },
      };

      const first = await explainLedger(initial1, {
        cwd: tmpDir,
        config: { ...DEFAULT_CONFIG, provider: "mock", model: "mock-cache" },
        clientOverride: wrapped,
        useCache: true,
      });
      expect(callCount).toBe(1);
      expect(first.hunks[0]?.status).toBe("explained");

      const initial2 = buildInitialLedger(diff, { declaredIntent: "Guard NaN" });
      const second = await explainLedger(initial2, {
        cwd: tmpDir,
        config: { ...DEFAULT_CONFIG, provider: "mock", model: "mock-cache" },
        clientOverride: wrapped,
        useCache: true,
      });
      expect(callCount).toBe(1); // Zero extra LLM calls on cache hit!
      expect(second.hunks[0]?.explainer_meta?.cached).toBe(true);
      expect(second.hunks[0]?.status).toBe("explained");

      const cache = new HunkResultCache(tmpDir);
      const key = computeHunkCacheKey({
        hunk: first.hunks[0]!,
        declaredIntent: "Guard NaN",
        explainerKey: "api_model:mock:mock-cache",
      });
      expect(cache.get(key)?.hunk_id).toBe(first.hunks[0]!.id);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Independent Line-by-Line Auditor (Role B)", () => {
  it("extracts exact numbered changed lines and detects verified, omission_detected, and contradicted", async () => {
    const diff = `diff --git a/src/auth/session.ts b/src/auth/session.ts
--- a/src/auth/session.ts
+++ b/src/auth/session.ts
@@ -10,5 +10,6 @@ export function check(session: Session) {
 export function check(session: Session) {
-  if (session.revoked) throw new Error("revoked");
+  const ok = session.expiresAt > Date.now();
+  return ok;
 }
`;
    const ledger = buildInitialLedger(diff);
    const h = ledger.hunks[0]!;
    const lines = extractChangedLinesWithNumbers(h);
    expect(lines.map((l) => `${l.prefix}${l.line}`)).toEqual(["-11", "+11", "+12"]);

    // Case 1: Author lies ("still checks revoked") -> contradicted & demoted to unexplained
    h.status = "explained";
    h.what = {
      text: "Refactors `check` while it still checks revoked sessions.",
      citations: [{ path: "src/auth/session.ts", lines: [11, 12], side: "new" }],
      citations_valid: true,
      semantic_grounding: "unchecked",
    };

    const auditedBad = await auditLedgerLines(structuredClone(ledger), {
      config: { ...DEFAULT_CONFIG, provider: "mock", model: "mock-auditor" },
      auditorClientOverride: new MockLLMClient("mock-auditor"),
    });
    expect(auditedBad.hunks[0]?.audit?.status).toBe("contradicted");
    expect(auditedBad.hunks[0]?.status).toBe("unexplained");
    expect(
      auditedBad.findings?.some((f) => f.rule_id === "diffgloss/audit-contradiction"),
    ).toBe(true);
    expect(validateLedger(auditedBad).ok).toBe(true);

    // Case 2: Author omits lines -> omission_detected with exact omitted_lines
    h.what.text = "Updates `check` (omit-test-trigger) with `ok`.";
    const auditedOmit = await auditLedgerLines(structuredClone(ledger), {
      config: { ...DEFAULT_CONFIG, provider: "mock", model: "mock-auditor" },
      auditorClientOverride: new MockLLMClient("mock-auditor"),
    });
    expect(auditedOmit.hunks[0]?.audit?.status).toBe("omission_detected");
    expect((auditedOmit.hunks[0]?.audit?.omitted_lines.length ?? 0) > 0).toBe(true);
    expect(
      auditedOmit.findings?.some((f) => f.rule_id === "diffgloss/audit-omission"),
    ).toBe(true);

    // Case 3: Faithful complete explanation -> verified
    h.what.text = "Removes `revoked` check and returns `ok` comparing `expiresAt`.";
    const auditedGood = await auditLedgerLines(structuredClone(ledger), {
      config: { ...DEFAULT_CONFIG, provider: "mock", model: "mock-auditor" },
      auditorClientOverride: new MockLLMClient("mock-auditor"),
    });
    expect(auditedGood.hunks[0]?.audit?.status).toBe("verified");
    expect(auditedGood.hunks[0]?.audit?.omitted_lines).toEqual([]);
    expect(auditedGood.hunks[0]?.what?.semantic_grounding).toBe("judge_passed");
  });
});
