import { createHash } from "node:crypto";
import type { ParsedHunk } from "../schema/types.ts";
import {
  extractFileScopes,
  extractSymbolScopes,
  findEnclosingScope,
  type SymbolScope,
} from "./ast.ts";

interface NumberedPatchLine {
  raw: string;
  oldLine: number | null;
  newLine: number | null;
  kind: "add" | "del" | "ctx";
}

function parseBodyLines(hunk: ParsedHunk): NumberedPatchLine[] {
  const lines = hunk.patch.split("\n");
  let oldCursor = hunk.old_range[0];
  let newCursor = hunk.new_range[0];
  const out: NumberedPatchLine[] = [];

  for (const raw of lines) {
    if (raw.startsWith("@@")) continue;
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      out.push({ raw, oldLine: null, newLine: newCursor++, kind: "add" });
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      out.push({ raw, oldLine: oldCursor++, newLine: null, kind: "del" });
    } else {
      out.push({ raw, oldLine: oldCursor++, newLine: newCursor++, kind: "ctx" });
    }
  }
  return out;
}

function computeSubHunkId(
  parentId: string,
  sliceIndex: number,
  changedLines: string[],
): string {
  const digest = createHash("sha256")
    .update(`${parentId}\0sub:${sliceIndex}\0${changedLines.join("\n")}`)
    .digest("hex");
  return `h_${digest.slice(0, 12)}`;
}

/**
 * Extracts symbol scopes either from the real source file on disk (preferred, 100% accurate
 * including nested class methods & impl blocks) or falls back to parsing the new-side lines
 * reconstructed from the hunk patch itself.
 */
function resolveScopesForHunk(
  hunk: ParsedHunk,
  cwd: string | undefined,
  fileScopeCache: Map<string, SymbolScope[]>,
): { scopes: SymbolScope[]; lineOffset: number } {
  if (cwd) {
    let cached = fileScopeCache.get(hunk.path);
    if (!cached) {
      cached = extractFileScopes(cwd, hunk.path);
      fileScopeCache.set(hunk.path, cached);
    }
    if (cached.length > 0) {
      return { scopes: cached, lineOffset: 0 };
    }
  }

  // Fallback: parse new-side lines directly from the hunk patch
  const body = parseBodyLines(hunk);
  const newLines = body
    .filter((l) => l.kind !== "del")
    .map((l) => l.raw.slice(1));
  const scopes = extractSymbolScopes(hunk.path, newLines.join("\n"));
  const baseLine = Math.max(1, hunk.new_range[0]);
  return {
    scopes: scopes.map((s) => ({
      ...s,
      startLine: s.startLine + baseLine - 1,
      endLine: s.endLine + baseLine - 1,
    })),
    lineOffset: 0,
  };
}

/**
 * AST/scope-aware hunk splitter and symbol annotator:
 * 1) Always enriches hunks with the narrowest enclosing qualified symbol (e.g. `AuthService.verifyToken`).
 * 2) Splits oversized hunks (>= lineThreshold changed lines) along real function/method/class
 *    scope boundaries so a sneaky edit inside a giant hunk cannot hide behind another symbol's explanation.
 */
export function splitLargeHunks(
  hunks: ParsedHunk[],
  lineThreshold = 40,
  cwd?: string,
): ParsedHunk[] {
  const result: ParsedHunk[] = [];
  const fileScopeCache = new Map<string, SymbolScope[]>();

  for (const hunk of hunks) {
    const body = parseBodyLines(hunk);
    const { scopes } = resolveScopesForHunk(hunk, cwd, fileScopeCache);

    // Pick narrowest scope for the first changed new-side line to improve enclosing_symbol
    const firstChanged = body.find((l) => l.kind !== "ctx" && l.newLine !== null);
    const firstScope = firstChanged?.newLine
      ? findEnclosingScope(scopes, firstChanged.newLine)
      : undefined;

    const totalChanged = hunk.added_lines.length + hunk.removed_lines.length;
    if (totalChanged < lineThreshold || scopes.length === 0) {
      result.push({
        ...hunk,
        enclosing_symbol: firstScope?.qualifiedName ?? hunk.enclosing_symbol,
      });
      continue;
    }

    // Find scope-boundary split points (prefer method/function/impl/class starts inside the hunk)
    const leafStarts = new Set<number>(
      scopes
        .filter((s) => s.kind === "function" || s.kind === "method" || s.kind === "class" || s.kind === "impl")
        .map((s) => s.startLine),
    );

    const splitPoints: number[] = [0];
    for (let i = 1; i < body.length; i += 1) {
      const line = body[i]!;
      const ln = line.newLine;
      if (ln !== null && leafStarts.has(ln)) {
        const prevStart = splitPoints[splitPoints.length - 1]!;
        const hasChangeBefore = body
          .slice(prevStart, i)
          .some((l) => l.kind !== "ctx");
        const hasChangeAfter = body.slice(i).some((l) => l.kind !== "ctx");
        if (hasChangeBefore && hasChangeAfter && i - prevStart >= 3) {
          splitPoints.push(i);
        }
      }
    }

    if (splitPoints.length <= 1) {
      result.push({
        ...hunk,
        enclosing_symbol: firstScope?.qualifiedName ?? hunk.enclosing_symbol,
      });
      continue;
    }

    for (let s = 0; s < splitPoints.length; s += 1) {
      const startIdx = splitPoints[s]!;
      const endIdx = splitPoints[s + 1] ?? body.length;
      const slice = body.slice(startIdx, endIdx);
      const changed = slice.filter((l) => l.kind !== "ctx");
      if (changed.length === 0) continue;

      const oldNums = slice
        .map((l) => l.oldLine)
        .filter((n): n is number => n !== null);
      const newNums = slice
        .map((l) => l.newLine)
        .filter((n): n is number => n !== null);

      const oldRange: [number, number] =
        oldNums.length > 0
          ? [oldNums[0]!, oldNums[oldNums.length - 1]!]
          : [hunk.old_range[0], hunk.old_range[0]];
      const newRange: [number, number] =
        newNums.length > 0
          ? [newNums[0]!, newNums[newNums.length - 1]!]
          : [hunk.new_range[0], hunk.new_range[0]];

      const sliceFirstNew = slice.find((l) => l.newLine !== null)?.newLine;
      const sliceScope = sliceFirstNew
        ? findEnclosingScope(scopes, sliceFirstNew)
        : undefined;
      const symbol = sliceScope?.qualifiedName ?? hunk.enclosing_symbol;
      const header = `@@ -${oldRange[0]},${oldNums.length} +${newRange[0]},${newNums.length} @@${symbol ? ` ${symbol}` : ""}`;

      result.push({
        id: computeSubHunkId(
          hunk.id,
          s,
          changed.map((l) => l.raw),
        ),
        path: hunk.path,
        old_path: hunk.old_path,
        change_type: hunk.change_type,
        enclosing_symbol: symbol,
        old_range: oldRange,
        new_range: newRange,
        header,
        patch: [header, ...slice.map((l) => l.raw)].join("\n"),
        added_lines: slice
          .filter((l) => l.kind === "add")
          .map((l) => l.raw.slice(1)),
        removed_lines: slice
          .filter((l) => l.kind === "del")
          .map((l) => l.raw.slice(1)),
      });
    }
  }

  return result;
}
