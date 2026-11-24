import { createHash } from "node:crypto";
import type {
  ChangeType,
  ParsedDiffResult,
  ParsedHunk,
  SkippedFile,
} from "../schema/types.ts";

const SECRET_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.env($|\..+)/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/i,
  /(^|\/).*credentials.*\.json$/i,
  /(^|\/)secrets?\.(ya?ml|json|toml|env)$/i,
];

export function isSuspectedSecretPath(filePath: string): boolean {
  return SECRET_PATH_PATTERNS.some((re) => re.test(filePath));
}

function stripDiffPrefix(raw: string): string {
  const trimmed = raw.trim().replace(/^"|"$/g, "");
  if (trimmed.startsWith("a/") || trimmed.startsWith("b/")) {
    return trimmed.slice(2);
  }
  return trimmed;
}

function computeHunkId(
  filePath: string,
  changeType: ChangeType,
  changedLines: string[],
  enclosingSymbol: string | undefined,
  occurrenceIndex: number,
): string {
  const normalized = changedLines
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n");
  const payload = [
    filePath,
    changeType,
    enclosingSymbol ?? "",
    normalized,
    occurrenceIndex > 0 ? `#${occurrenceIndex}` : "",
  ].join("\0");

  const digest = createHash("sha256").update(payload).digest("hex");
  return `h_${digest.slice(0, 12)}`;
}

function parseRange(startRaw: string, countRaw: string | undefined): [number, number] {
  const start = Number.parseInt(startRaw, 10);
  const count = countRaw === undefined ? 1 : Number.parseInt(countRaw, 10);
  if (count === 0) {
    return [start, start];
  }
  return [start, start + count - 1];
}

function extractSymbolFromHunkHeader(contextTail: string): string | undefined {
  const trimmed = contextTail.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 120);
}

interface RawFileBlock {
  oldPath: string;
  newPath: string;
  changeType: ChangeType;
  isBinary: boolean;
  lines: string[];
}

function splitFileBlocks(rawDiff: string): RawFileBlock[] {
  const normalized = rawDiff.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const blocks: RawFileBlock[] = [];
  let current: RawFileBlock | null = null;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current) blocks.push(current);
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      const oldPath = match?.[1] ? stripDiffPrefix(match[1]) : "";
      const newPath = match?.[2] ? stripDiffPrefix(match[2]) : "";
      current = {
        oldPath,
        newPath,
        changeType: "modified",
        isBinary: false,
        lines: [line],
      };
      continue;
    }

    if (!current) continue;
    current.lines.push(line);

    if (line.startsWith("new file mode ")) {
      current.changeType = "added";
    } else if (line.startsWith("deleted file mode ")) {
      current.changeType = "deleted";
    } else if (line.startsWith("rename from ")) {
      current.changeType = "renamed";
      current.oldPath = line.slice("rename from ".length).trim();
    } else if (line.startsWith("rename to ")) {
      current.changeType = "renamed";
      current.newPath = line.slice("rename to ".length).trim();
    } else if (
      line.startsWith("Binary files ") ||
      line === "GIT binary patch"
    ) {
      current.isBinary = true;
    } else if (line.startsWith("--- ") && !current.oldPath) {
      const p = line.slice(4).trim();
      if (p !== "/dev/null") current.oldPath = stripDiffPrefix(p);
    } else if (line.startsWith("+++ ") && !current.newPath) {
      const p = line.slice(4).trim();
      if (p !== "/dev/null") current.newPath = stripDiffPrefix(p);
    }
  }

  if (current) blocks.push(current);
  return blocks;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function parseUnifiedDiff(rawDiff: string): ParsedDiffResult {
  const blocks = splitFileBlocks(rawDiff);
  const hunks: ParsedHunk[] = [];
  const skipped_files: SkippedFile[] = [];
  const seenIds = new Map<string, number>();

  for (const block of blocks) {
    const effectivePath =
      block.changeType === "deleted"
        ? block.oldPath || block.newPath
        : block.newPath || block.oldPath;

    if (!effectivePath) continue;

    if (isSuspectedSecretPath(effectivePath)) {
      skipped_files.push({ path: effectivePath, reason: "secret_suspected" });
      continue;
    }

    if (block.isBinary) {
      skipped_files.push({ path: effectivePath, reason: "binary" });
      continue;
    }

    let i = 0;
    let fileHunkCount = 0;

    while (i < block.lines.length) {
      const line = block.lines[i]!;
      const headerMatch = HUNK_HEADER_RE.exec(line);
      if (!headerMatch) {
        i += 1;
        continue;
      }

      fileHunkCount += 1;
      const oldRange = parseRange(headerMatch[1]!, headerMatch[2]);
      const newRange = parseRange(headerMatch[3]!, headerMatch[4]);
      const enclosingSymbol = extractSymbolFromHunkHeader(headerMatch[5] ?? "");

      const patchLines: string[] = [line];
      const addedLines: string[] = [];
      const removedLines: string[] = [];
      const changedLines: string[] = [];

      i += 1;
      while (i < block.lines.length) {
        const nextLine = block.lines[i]!;
        if (HUNK_HEADER_RE.test(nextLine)) break;
        if (nextLine === "" && i === block.lines.length - 1) {
          i += 1;
          break;
        }
        patchLines.push(nextLine);
        if (nextLine.startsWith("+") && !nextLine.startsWith("+++")) {
          addedLines.push(nextLine.slice(1));
          changedLines.push(nextLine);
        } else if (nextLine.startsWith("-") && !nextLine.startsWith("---")) {
          removedLines.push(nextLine.slice(1));
          changedLines.push(nextLine);
        }
        i += 1;
      }

      const baseId = computeHunkId(
        effectivePath,
        block.changeType,
        changedLines,
        enclosingSymbol,
        0,
      );
      const count = seenIds.get(baseId) ?? 0;
      seenIds.set(baseId, count + 1);
      const id =
        count === 0
          ? baseId
          : computeHunkId(
              effectivePath,
              block.changeType,
              changedLines,
              enclosingSymbol,
              count,
            );

      hunks.push({
        id,
        path: effectivePath,
        old_path:
          block.changeType === "renamed" && block.oldPath !== effectivePath
            ? block.oldPath
            : undefined,
        change_type: block.changeType,
        enclosing_symbol: enclosingSymbol,
        old_range: oldRange,
        new_range: newRange,
        header: line,
        patch: patchLines.join("\n"),
        added_lines: addedLines,
        removed_lines: removedLines,
      });
    }

    // Handle pure file renames with no content hunks
    if (fileHunkCount === 0 && block.changeType === "renamed") {
      const id = computeHunkId(
        effectivePath,
        "renamed",
        [`rename:${block.oldPath}->${effectivePath}`],
        undefined,
        0,
      );
      hunks.push({
        id,
        path: effectivePath,
        old_path: block.oldPath,
        change_type: "renamed",
        old_range: [0, 0],
        new_range: [0, 0],
        header: `@@ rename ${block.oldPath} -> ${effectivePath} @@`,
        patch: `rename from ${block.oldPath}\nrename to ${effectivePath}`,
        added_lines: [],
        removed_lines: [],
      });
    }
  }

  return { hunks, skipped_files };
}
