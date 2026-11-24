import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseUnifiedDiff } from "../src/diff/parser.ts";
import { buildInitialLedger } from "../src/pipeline/ledger.ts";
import { renderHtmlReport } from "../src/render/html.ts";
import type { ExplanationLedger } from "../src/schema/types.ts";
import { validateLedger, verifyHunkCitations } from "../src/schema/validate.ts";

const SAMPLE_DIFF = `diff --git a/.env.local b/.env.local
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/.env.local
@@ -0,0 +1 @@
+API_SECRET=super-secret-value
diff --git a/package-lock.json b/package-lock.json
index 1111111..2222222 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,3 +1,3 @@
 {
-  "version": "1.0.0"
+  "version": "1.0.1"
 }
diff --git a/src/auth/guard.ts b/src/auth/guard.ts
index 1111111..2222222 100644
--- a/src/auth/guard.ts
+++ b/src/auth/guard.ts
@@ -10,6 +10,3 @@ export function checkAccess(user: User) {
 export function checkAccess(user: User) {
-  if (!user.isActive) {
-    throw new Error("Inactive user");
-  }
   return user.role === "admin";
 }
diff --git a/src/utils/format.ts b/src/utils/format.ts
index 1111111..2222222 100644
--- a/src/utils/format.ts
+++ b/src/utils/format.ts
@@ -1,2 +1,2 @@
-export const greeting="hi"
+export const greeting = "hi"
diff --git a/tests/auth.test.ts b/tests/auth.test.ts
index 1111111..2222222 100644
--- a/tests/auth.test.ts
+++ b/tests/auth.test.ts
@@ -5,5 +5,4 @@ describe("auth", () => {
   it("blocks inactive users", () => {
-    expect(() => checkAccess({ isActive: false, role: "admin" })).toThrow();
     expect(checkAccess({ isActive: true, role: "admin" })).toBe(true);
   });
 });
`;

describe("parseUnifiedDiff", () => {
  it("skips suspected secret files and parses remaining hunks with stable IDs", () => {
    const res1 = parseUnifiedDiff(SAMPLE_DIFF);
    const res2 = parseUnifiedDiff(SAMPLE_DIFF);

    expect(res1.skipped_files).toEqual([
      { path: ".env.local", reason: "secret_suspected" },
    ]);
    expect(res1.hunks.length).toBe(4);
    expect(res1.hunks.map((h) => h.id)).toEqual(res2.hunks.map((h) => h.id));
    expect(res1.hunks[1]?.enclosing_symbol).toContain("checkAccess");
  });
});

describe("buildInitialLedger", () => {
  it("collapses lockfile & whitespace, flags guard removal and weakened test assertions, and satisfies coverage invariant", () => {
    const ledger = buildInitialLedger(SAMPLE_DIFF, {
      title: "Test Diff",
      declaredIntent: "Clean up formatting",
    });

    expect(ledger.coverage).toEqual({
      total: 4,
      explained: 0,
      collapsed: 2,
      unexplained: 2,
    });

    // High-risk test assertion change should be front-loaded in reading order
    expect(ledger.groups[0]?.title).toBe("High-risk test assertion changes");
    expect(ledger.questions.map((q) => q.trigger).sort()).toEqual([
      "safety_check_removed",
      "test_assertion_changed",
    ]);

    const validation = validateLedger(ledger);
    expect(validation.ok).toBe(true);
    expect(validation.errors).toEqual([]);
  });
});

describe("verifyHunkCitations & validateLedger", () => {
  it("validates sample-ledger.json cleanly", () => {
    const samplePath = path.resolve(
      import.meta.dirname,
      "../examples/sample-ledger.json",
    );
    const ledger = JSON.parse(
      readFileSync(samplePath, "utf8"),
    ) as ExplanationLedger;

    const validation = validateLedger(ledger);
    expect(validation.ok).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it("rejects out-of-range citations and fabricated backticked symbols", () => {
    const ledger = buildInitialLedger(SAMPLE_DIFF);
    const guardHunk = ledger.hunks.find((h) => h.path === "src/auth/guard.ts")!;
    guardHunk.status = "explained";
    guardHunk.what = {
      text: "Calls `nonExistentHelper` to verify access.",
      citations: [{ path: "src/auth/guard.ts", lines: [999, 1005], side: "new" }],
      citations_valid: true,
      semantic_grounding: "unchecked",
    };

    const check = verifyHunkCitations(guardHunk);
    expect(check.valid).toBe(false);
    expect(check.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe("renderHtmlReport", () => {
  it("renders a standalone interactive HTML document containing the embedded ledger", () => {
    const samplePath = path.resolve(
      import.meta.dirname,
      "../examples/sample-ledger.json",
    );
    const ledger = JSON.parse(
      readFileSync(samplePath, "utf8"),
    ) as ExplanationLedger;

    const html = renderHtmlReport(ledger);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Sliding TTL for Auth Sessions");
    expect(html).toContain("citations_valid");
    expect(html).toContain("diffgloss-data");
  });
});
