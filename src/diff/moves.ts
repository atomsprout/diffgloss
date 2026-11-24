import type { ParsedHunk } from "../schema/types.ts";

function normalizeBlock(lines: string[]): string {
  return lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

/**
 * Detects pure code moves across hunks/files: when a purely-deleted hunk's normalized
 * non-empty lines match a purely-added hunk's lines (>= 4 non-empty lines), annotate
 * the destination hunk with `moved_from` so the classifier treats it as a move instead
 * of brand-new logic.
 */
export function detectCrossFileMoves(hunks: ParsedHunk[]): ParsedHunk[] {
  const deletedBlocks = new Map<string, ParsedHunk[]>();

  for (const h of hunks) {
    if (h.added_lines.length > 0 || h.removed_lines.length === 0) continue;
    const norm = normalizeBlock(h.removed_lines);
    if (norm.split("\n").length < 4) continue;
    const list = deletedBlocks.get(norm) ?? [];
    list.push(h);
    deletedBlocks.set(norm, list);
  }

  const matchedDeletedIds = new Set<string>();

  return hunks.map((h) => {
    if (h.removed_lines.length > 0 || h.added_lines.length === 0) {
      return h;
    }
    const norm = normalizeBlock(h.added_lines);
    const candidates = deletedBlocks.get(norm);
    if (!candidates || candidates.length === 0) return h;

    const src = candidates.find(
      (c) => !matchedDeletedIds.has(c.id) && c.id !== h.id,
    );
    if (!src) return h;

    matchedDeletedIds.add(src.id);
    return {
      ...h,
      moved_from: {
        path: src.path,
        old_range: src.old_range,
      },
    };
  });
}
