import { createHash } from "node:crypto";
import type { AttachedFinding, HunkRecord } from "../schema/types.ts";

function makeFingerprint(ruleId: string, filePath: string, snippet: string): string {
  const norm = snippet.replace(/\s+/g, " ").trim().slice(0, 200);
  return createHash("sha256")
    .update(`${ruleId}\0${filePath}\0${norm}`)
    .digest("hex")
    .slice(0, 16);
}

const SILENT_CATCH_PATTERNS: RegExp[] = [
  /catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\/[^\n]*)?\s*\}/,
  /except(?:\s+[A-Za-z0-9_.,\s()]+)?:\s*\n\s*pass\b/,
  /\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/,
];

/**
 * Deterministic built-in checks strictly aligned with Diffgloss's explainability &
 * intent-integrity focus (not generic style linting).
 */
export function runIntegrityChecks(hunks: HunkRecord[]): AttachedFinding[] {
  const findings: AttachedFinding[] = [];
  let counter = 0;

  for (const hunk of hunks) {
    if (hunk.status === "collapsed") continue;

    const addedBlock = hunk.patch
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .map((l) => l.slice(1))
      .join("\n");

    // 1. Silent error swallowing newly introduced in diff
    for (const pattern of SILENT_CATCH_PATTERNS) {
      const match = pattern.exec(addedBlock);
      if (match) {
        counter += 1;
        findings.push({
          id: `f_int_${counter}`,
          rule_id: "diffgloss/silent-error-swallow",
          tool: "diffgloss-integrity",
          severity: "important",
          category: "silent_error",
          path: hunk.path,
          lines: hunk.new_range[0] > 0 ? hunk.new_range : [1, 1],
          hunk_id: hunk.id,
          message:
            "Newly added empty catch/except handler silently swallows errors without logging or rethrowing.",
          evidence: match[0].slice(0, 140),
          fingerprint: makeFingerprint(
            "diffgloss/silent-error-swallow",
            hunk.path,
            match[0],
          ),
        });
        break;
      }
    }

    // 2. Weakened / removed test assertions
    if (
      hunk.class === "test" &&
      hunk.risk === "high" &&
      hunk.class_reason?.includes("Test assertions removed")
    ) {
      counter += 1;
      findings.push({
        id: `f_int_${counter}`,
        rule_id: "diffgloss/test-assertion-weakened",
        tool: "diffgloss-integrity",
        severity: "important",
        category: "test_weakened",
        path: hunk.path,
        lines: hunk.new_range[0] > 0 ? hunk.new_range : hunk.old_range,
        hunk_id: hunk.id,
        message: hunk.class_reason,
        fingerprint: makeFingerprint(
          "diffgloss/test-assertion-weakened",
          hunk.path,
          hunk.patch,
        ),
      });
    }

    // 3. Guard or throw path removed without replacement
    if (
      hunk.class === "substantive" &&
      hunk.risk === "high" &&
      hunk.class_reason?.includes("guard")
    ) {
      counter += 1;
      findings.push({
        id: `f_int_${counter}`,
        rule_id: "diffgloss/safety-check-removed",
        tool: "diffgloss-integrity",
        severity: "important",
        category: "guard_removed",
        path: hunk.path,
        lines: hunk.old_range[0] > 0 ? hunk.old_range : hunk.new_range,
        hunk_id: hunk.id,
        message: hunk.class_reason,
        fingerprint: makeFingerprint(
          "diffgloss/safety-check-removed",
          hunk.path,
          hunk.patch,
        ),
      });
    }
  }

  return findings;
}

export function attachFindingsToHunks(
  hunks: HunkRecord[],
  findings: AttachedFinding[],
): void {
  const byHunk = new Map<string, string[]>();
  for (const f of findings) {
    let targetHunkId = f.hunk_id;
    if (!targetHunkId) {
      const match = hunks.find(
        (h) =>
          h.path === f.path &&
          h.new_range[0] <= f.lines[1] &&
          h.new_range[1] >= f.lines[0],
      );
      if (match) {
        targetHunkId = match.id;
        f.hunk_id = match.id;
      }
    }
    if (targetHunkId) {
      const list = byHunk.get(targetHunkId) ?? [];
      if (!list.includes(f.id)) list.push(f.id);
      byHunk.set(targetHunkId, list);
    }
  }

  for (const h of hunks) {
    const ids = byHunk.get(h.id);
    if (ids && ids.length > 0) {
      const merged = new Set([...(h.finding_ids ?? []), ...ids]);
      h.finding_ids = [...merged];
    }
  }
}
