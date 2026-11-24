import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  HunkAudit,
  HunkExplainerMeta,
  HunkRecord,
  HunkStatus,
  HunkWhat,
  HunkWhy,
} from "../schema/types.ts";

export interface CachedHunkEntry {
  cache_key: string;
  hunk_id: string;
  saved_at: string;
  status: HunkStatus;
  what?: HunkWhat;
  why?: HunkWhy;
  explainer_meta?: HunkExplainerMeta;
  audit?: HunkAudit;
}

export function computeHunkCacheKey(params: {
  hunk: Pick<HunkRecord, "id" | "patch">;
  declaredIntent?: string;
  explainerKey: string;
  auditorKey?: string;
}): string {
  return createHash("sha256")
    .update(
      [
        params.hunk.id,
        params.hunk.patch,
        params.declaredIntent ?? "",
        params.explainerKey,
        params.auditorKey ?? "",
      ].join("\0"),
    )
    .digest("hex")
    .slice(0, 24);
}

export class HunkResultCache {
  private readonly dir: string;

  constructor(cwd: string, relDir = ".diffgloss/cache") {
    this.dir = path.isAbsolute(relDir) ? relDir : path.join(cwd, relDir);
  }

  get(cacheKey: string): CachedHunkEntry | null {
    const file = path.join(this.dir, `${cacheKey}.json`);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as CachedHunkEntry;
    } catch {
      return null;
    }
  }

  set(entry: CachedHunkEntry): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const file = path.join(this.dir, `${entry.cache_key}.json`);
      writeFileSync(file, JSON.stringify(entry, null, 2), "utf8");
    } catch {
      // Non-fatal in read-only workspaces
    }
  }
}
