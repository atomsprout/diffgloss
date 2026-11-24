import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "../src/config/loader.ts";
import { extractSymbolScopes, findEnclosingScope } from "../src/diff/ast.ts";
import { MockLLMClient } from "../src/llm/providers.ts";
import { handleMcpRequest } from "../src/mcp/server.ts";
import { buildInitialLedger } from "../src/pipeline/ledger.ts";
import { runSymmetricProofReview } from "../src/pipeline/reviewer.ts";
import { LEDGER_COMMENT_MARKER, planGitHubSync } from "../src/platform/github.ts";
import {
  discoverLocalAgentTranscripts,
  enrichLedgerProvenance,
} from "../src/provenance/capture.ts";
import {
  evaluateStructuredRules,
  parseStructuredRuleMarkdown,
} from "../src/rules/engine.ts";

describe("Multi-language AST scope extraction", () => {
  it("extracts nested TypeScript class methods while ignoring braces in strings & comments", () => {
    const src = `export class AuthService {
  // comment with fake { brace }
  async verifyToken(raw: string): Promise<boolean> {
    const template = \`not a { block } here\`;
    return raw.length > 0 && template.length > 0;
  }

  revoke(id: string) {
    return id;
  }
}
`;
    const scopes = extractSymbolScopes("src/auth.ts", src);
    const verifyScope = findEnclosingScope(scopes, 4);
    const revokeScope = findEnclosingScope(scopes, 9);
    expect(verifyScope?.qualifiedName).toBe("AuthService.verifyToken");
    expect(revokeScope?.qualifiedName).toBe("AuthService.revoke");
  });

  it("extracts Python class methods via indentation tracking", () => {
    const src = `class BillingWorker:
    def charge(self, amount: int):
        if amount <= 0:
            return False
        return True

    async def refund(self, tx_id: str):
        return tx_id
`;
    const scopes = extractSymbolScopes("worker/billing.py", src);
    expect(findEnclosingScope(scopes, 4)?.qualifiedName).toBe(
      "BillingWorker.charge",
    );
    expect(findEnclosingScope(scopes, 8)?.qualifiedName).toBe(
      "BillingWorker.refund",
    );
  });
});

describe("Auto Local Session Discovery", () => {
  it("discovers Claude Code project JSONL transcripts automatically from homeDir", () => {
    const tmpHome = mkdtempSync(path.join(os.tmpdir(), "diffgloss-home-"));
    const tmpRepo = mkdtempSync(path.join(os.tmpdir(), "diffgloss-repo-"));
    try {
      const encoded = path.resolve(tmpRepo).replace(/[\\/]/g, "-");
      const projDir = path.join(tmpHome, ".claude", "projects", encoded);
      mkdirSync(projDir, { recursive: true });
      const sessFile = path.join(projDir, "sess_auto.jsonl");
      writeFileSync(
        sessFile,
        `${JSON.stringify({
          sessionId: "sess_auto_1",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Adding retry jitter to prevent thundering herd." },
              {
                type: "tool_use",
                id: "tu_auto",
                name: "Edit",
                input: { file_path: path.join(tmpRepo, "src/retry.ts") },
              },
            ],
          },
        })}\n`,
        "utf8",
      );

      const discovered = discoverLocalAgentTranscripts(tmpRepo, {
        homeDir: tmpHome,
      });
      expect(discovered).toContain(sessFile);

      const diff = `diff --git a/src/retry.ts b/src/retry.ts
--- a/src/retry.ts
+++ b/src/retry.ts
@@ -1,2 +1,3 @@
 export function delay(ms: number) {
+  const jitter = Math.random() * 50;
   return ms + jitter;
 }
`;
      const ledger = buildInitialLedger(diff);
      const stats = enrichLedgerProvenance(ledger, {
        cwd: tmpRepo,
        homeDir: tmpHome,
        autoDiscover: true,
      });
      expect(stats.matchedHunks).toBe(1);
      expect(ledger.hunks[0]?.provenance?.format).toBe("session-scan");
      expect(ledger.hunks[0]?.why?.text).toContain("thundering herd");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });
});

describe("Structured Rules Engine & Symmetric-Proof Reviewer", () => {
  it("evaluates scoped regex rules and tracks telemetry", () => {
    const rule = parseStructuredRuleMarkdown(
      `---
id: no-console-log
title: Avoid console.log in production src
severity: nit
kind: regex
include:
  - "src/**"
exclude:
  - "**/*.test.ts"
pattern: "console\\\\.log\\\\("
---
Use structured logger instead of console.log.
`,
      ".diffgloss/rules/no-console-log.md",
      "base_ref",
    )!;

    const diff = `diff --git a/src/api.ts b/src/api.ts
--- a/src/api.ts
+++ b/src/api.ts
@@ -1,2 +1,3 @@
 export function ping() {
+  console.log("debug");
   return "ok";
 }
diff --git a/tests/api.test.ts b/tests/api.test.ts
--- a/tests/api.test.ts
+++ b/tests/api.test.ts
@@ -1,2 +1,3 @@
 it("pings", () => {
+  console.log("test log ok");
 });
`;
    const ledger = buildInitialLedger(diff);
    const res = evaluateStructuredRules([rule], ledger.hunks);
    expect(res.findings.length).toBe(1);
    expect(res.findings[0]?.rule_id).toBe("rule/no-console-log");
    expect(res.telemetry[0]?.matched_hunks).toBe(1);
    expect(res.telemetry[0]?.hits).toBe(1);
  });

  it("runs parallel specialists, verifies candidates, and populates symmetric-proof ruled_out list", async () => {
    const diff = `diff --git a/src/db/users.ts b/src/db/users.ts
--- a/src/db/users.ts
+++ b/src/db/users.ts
@@ -10,2 +10,4 @@ export function findUser(email: string) {
 export function findUser(email: string) {
+  const sql = "SELECT * FROM users WHERE email = '" + email + "'";
+  return db.query(sql);
 }
diff --git a/src/math.ts b/src/math.ts
--- a/src/math.ts
+++ b/src/math.ts
@@ -1,2 +1,3 @@
 export function double(n: number) {
+  return n * 2;
 }
`;
    const ledger = buildInitialLedger(diff);
    const reviewed = await runSymmetricProofReview(ledger, {
      config: { ...DEFAULT_CONFIG, provider: "mock", model: "mock" },
      finderClientOverride: new MockLLMClient("mock-finder"),
      verifierClientOverride: new MockLLMClient("mock-verifier"),
    });

    expect(
      reviewed.findings?.some((f) => f.rule_id === "bug/sql-injection"),
    ).toBe(true);
    expect((reviewed.ruled_out?.length ?? 0) > 0).toBe(true);
  });
});

describe("MCP Server & GitHub PR Sync Planner", () => {
  it("handles MCP initialize, tools/list, and diffgloss_inspect", async () => {
    const initRes = await handleMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      process.cwd(),
    );
    expect(initRes?.result).toBeDefined();

    const listRes = await handleMcpRequest(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      process.cwd(),
    );
    const tools = (listRes?.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toContain("diffgloss_inspect");
    expect(tools.map((t) => t.name)).toContain("diffgloss_list_rules");
  });

  it("reconciles sticky comment, deduplicates unchanged fingerprints, and flags resolved comments", () => {
    const diff = `diff --git a/src/billing.ts b/src/billing.ts
--- a/src/billing.ts
+++ b/src/billing.ts
@@ -10,3 +10,6 @@ export function charge() {
 export function charge() {
+  try {
+    runCharge();
+  } catch (e) {}
 }
`;
    const ledger = buildInitialLedger(diff);
    const activeFp = ledger.findings![0]!.fingerprint;

    const plan = planGitHubSync(
      ledger,
      [{ id: 100, body: `${LEDGER_COMMENT_MARKER}\nold summary` }],
      [
        { id: 201, body: `old unchanged\n<!-- diffgloss-fp:${activeFp} -->` },
        { id: 202, body: `old fixed bug\n<!-- diffgloss-fp:deadbeef12345678 -->` },
      ],
    );

    expect(plan.overviewAction).toBe("update");
    expect(plan.existingOverviewCommentId).toBe(100);
    expect(plan.unchangedFingerprints).toEqual([activeFp]);
    expect(plan.newInlineComments.length).toBe(0);
    expect(plan.resolvedCommentIds).toEqual([202]);
  });
});
