import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { HunkRecord } from "../schema/types.ts";

export interface HunkContextSnippet {
  hunk_id: string;
  surrounding_code?: string;
  call_sites: string[];
}

function extractLikelySymbolName(symbolHeader: string | undefined): string | null {
  if (!symbolHeader) return null;
  const match =
    /\b(?:function|class|def|fn|func|const|let|var)\s+([A-Za-z_][A-Za-z0-9_]{2,})/.exec(
      symbolHeader,
    ) ?? /\b([A-Za-z_][A-Za-z0-9_]{3,})\s*\(/.exec(symbolHeader);
  return match?.[1] ?? null;
}

/**
 * Extracts bounded surrounding file lines (+/- windowLines) and lightweight repo call-sites
 * via `git grep` so the explainer has targeted context without stuffing the whole codebase.
 */
export function extractHunkContext(
  cwd: string,
  hunk: Pick<HunkRecord, "id" | "path" | "new_range" | "enclosing_symbol">,
  windowLines = 12,
): HunkContextSnippet {
  let surrounding_code: string | undefined;
  const absPath = path.join(cwd, hunk.path);

  if (existsSync(absPath) && hunk.new_range[0] > 0) {
    try {
      const fileLines = readFileSync(absPath, "utf8").split(/\r?\n/);
      const start = Math.max(1, hunk.new_range[0] - windowLines);
      const end = Math.min(fileLines.length, hunk.new_range[1] + windowLines);
      const numbered: string[] = [];
      for (let ln = start; ln <= end; ln += 1) {
        numbered.push(`${ln}: ${fileLines[ln - 1] ?? ""}`);
      }
      surrounding_code = numbered.join("\n");
    } catch {
      // Non-fatal: file might be deleted or unreadable
    }
  }

  const call_sites: string[] = [];
  const sym = extractLikelySymbolName(hunk.enclosing_symbol);
  if (sym) {
    try {
      const raw = execFileSync(
        "git",
        ["grep", "-n", "-F", "--max-count=3", sym],
        {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          maxBuffer: 1024 * 1024,
        },
      );
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(`${hunk.path}:`)) continue;
        call_sites.push(trimmed.slice(0, 140));
        if (call_sites.length >= 5) break;
      }
    } catch {
      // git grep returns exit code 1 when no matches found
    }
  }

  return {
    hunk_id: hunk.id,
    surrounding_code,
    call_sites,
  };
}
