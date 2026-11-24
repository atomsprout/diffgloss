import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DiffglossConfig, EffortLevel, ProviderDialect } from "../schema/types.ts";

export const DEFAULT_CONFIG: DiffglossConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  effort: "standard",
  budget_usd: 1.5,
  max_questions: 6,
  rules_from_base: true,
  redact_secrets: true,
  ignore: [],
  split_large_hunks: true,
  subhunk_line_threshold: 40,
};

/**
 * Minimal zero-dependency YAML parser covering flat key: value and simple string lists
 * used in diffgloss.yaml (also supports JSON files cleanly).
 */
export function parseSimpleYaml(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as Record<string, unknown>;
  }

  const result: Record<string, unknown> = {};
  let currentListKey: string | null = null;

  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const listMatch = /^\s*-\s+(.+)$/.exec(line);
    if (listMatch && currentListKey) {
      const arr = (result[currentListKey] as unknown[]) ?? [];
      arr.push(parseScalar(listMatch[1]!));
      result[currentListKey] = arr;
      continue;
    }

    currentListKey = null;
    const kvMatch = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!kvMatch) continue;

    const key = kvMatch[1]!;
    const valRaw = kvMatch[2]!.trim();

    if (valRaw === "") {
      currentListKey = key;
      result[key] = [];
    } else if (valRaw.startsWith("[") && valRaw.endsWith("]")) {
      const inner = valRaw.slice(1, -1).trim();
      result[key] = inner
        ? inner.split(",").map((item) => parseScalar(item.trim()))
        : [];
    } else {
      result[key] = parseScalar(valRaw);
    }
  }

  return result;
}

function parseScalar(raw: string): string | number | boolean {
  let unquoted = raw;
  if (raw.startsWith('"') && raw.endsWith('"')) {
    unquoted = raw
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  } else if (raw.startsWith("'") && raw.endsWith("'")) {
    unquoted = raw.slice(1, -1).replace(/''/g, "'");
  }

  if (unquoted === "true") return true;
  if (unquoted === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(unquoted)) return Number(unquoted);
  return unquoted;
}

function readGitFileAtRef(
  cwd: string,
  ref: string,
  relPath: string,
): string | null {
  try {
    return execFileSync("git", ["show", `${ref}:${relPath}`], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

export function loadConfig(
  cwd: string,
  overrides: Partial<DiffglossConfig> = {},
): DiffglossConfig {
  const candidates = ["diffgloss.yaml", "diffgloss.yml", ".diffgloss.yaml", "diffgloss.json"];
  let fileData: Record<string, unknown> = {};

  for (const name of candidates) {
    const full = path.join(cwd, name);
    if (existsSync(full)) {
      fileData = parseSimpleYaml(readFileSync(full, "utf8"));
      break;
    }
  }

  // Auto-detect sensible default provider from environment if not set in config
  let inferredProvider: ProviderDialect = DEFAULT_CONFIG.provider;
  let inferredModel: string = DEFAULT_CONFIG.model;
  if (typeof fileData.provider !== "string" && !overrides.provider) {
    if (process.env.ANTHROPIC_API_KEY) {
      inferredProvider = "anthropic";
      inferredModel = "claude-sonnet-4-5";
    } else if (process.env.OPENAI_API_KEY) {
      inferredProvider = "openai";
      inferredModel = "gpt-5.1";
    } else if (process.env.DEEPSEEK_API_KEY) {
      inferredProvider = "deepseek";
      inferredModel = "deepseek-chat";
    } else if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
      inferredProvider = "google";
      inferredModel = "gemini-2.5-pro";
    }
  }

  const merged: DiffglossConfig = {
    ...DEFAULT_CONFIG,
    provider: (fileData.provider as ProviderDialect) ?? inferredProvider,
    model: (fileData.model as string) ?? inferredModel,
    base_url: (fileData.base_url as string | undefined) ?? undefined,
    api_key_env: (fileData.api_key_env as string | undefined) ?? undefined,
    judge_provider: (fileData.judge_provider as ProviderDialect | undefined) ?? undefined,
    judge_model: (fileData.judge_model as string | undefined) ?? undefined,
    judge_base_url: (fileData.judge_base_url as string | undefined) ?? undefined,
    judge_api_key_env: (fileData.judge_api_key_env as string | undefined) ?? undefined,
    effort: (fileData.effort as EffortLevel) ?? DEFAULT_CONFIG.effort,
    budget_usd:
      typeof fileData.budget_usd === "number"
        ? fileData.budget_usd
        : DEFAULT_CONFIG.budget_usd,
    max_questions:
      typeof fileData.max_questions === "number"
        ? fileData.max_questions
        : DEFAULT_CONFIG.max_questions,
    rules_from_base:
      typeof fileData.rules_from_base === "boolean"
        ? fileData.rules_from_base
        : DEFAULT_CONFIG.rules_from_base,
    redact_secrets:
      typeof fileData.redact_secrets === "boolean"
        ? fileData.redact_secrets
        : DEFAULT_CONFIG.redact_secrets,
    ignore: Array.isArray(fileData.ignore)
      ? fileData.ignore.map(String)
      : DEFAULT_CONFIG.ignore,
    split_large_hunks:
      typeof fileData.split_large_hunks === "boolean"
        ? fileData.split_large_hunks
        : DEFAULT_CONFIG.split_large_hunks,
    subhunk_line_threshold:
      typeof fileData.subhunk_line_threshold === "number"
        ? fileData.subhunk_line_threshold
        : DEFAULT_CONFIG.subhunk_line_threshold,
    ...overrides,
  };

  return merged;
}

export interface LoadedRuleDoc {
  path: string;
  source: "base_ref" | "working_tree";
  content: string;
}

const RULE_FILENAMES = ["REVIEW.md", "AGENTS.md", "CLAUDE.md", ".cursor/BUGBOT.md"];
const IGNORED_RULE_DIRS = new Set(["test", "tests", "examples", "example", "vendor", "generated", "node_modules"]);
const MAX_RULE_BYTES = 120_000;

/**
 * Discovers repo review guidance (REVIEW.md, AGENTS.md, CLAUDE.md) from root and parent
 * directories of changed files. When `baseRef` is supplied and `rulesFromBase` is true,
 * reads rules exclusively from the base branch to prevent prompt injection via PR edits.
 */
export function discoverRuleDocs(
  cwd: string,
  changedPaths: string[],
  options: { baseRef?: string; rulesFromBase?: boolean } = {},
): LoadedRuleDoc[] {
  const dirsToCheck = new Set<string>([""]);

  for (const rel of changedPaths) {
    let cur = path.posix.dirname(rel);
    while (cur && cur !== "." && cur !== "/") {
      const base = path.posix.basename(cur);
      if (!IGNORED_RULE_DIRS.has(base)) {
        dirsToCheck.add(cur);
      }
      cur = path.posix.dirname(cur);
    }
  }

  const docs: LoadedRuleDoc[] = [];
  let totalBytes = 0;

  for (const dir of [...dirsToCheck].sort()) {
    for (const filename of RULE_FILENAMES) {
      // Only check .cursor/BUGBOT.md at repo root
      if (filename.includes("/") && dir !== "") continue;
      const relPath = dir ? `${dir}/${filename}` : filename;
      let content: string | null = null;
      let source: "base_ref" | "working_tree" = "working_tree";

      if (options.rulesFromBase !== false && options.baseRef) {
        content = readGitFileAtRef(cwd, options.baseRef, relPath);
        source = "base_ref";
      } else {
        const abs = path.join(cwd, relPath);
        if (existsSync(abs)) {
          content = readFileSync(abs, "utf8");
          source = "working_tree";
        }
      }

      if (!content) continue;
      if (totalBytes + content.length > MAX_RULE_BYTES) {
        const remaining = MAX_RULE_BYTES - totalBytes;
        if (remaining > 500) {
          docs.push({
            path: relPath,
            source,
            content: `${content.slice(0, remaining)}\n...[truncated]`,
          });
        }
        return docs;
      }
      totalBytes += content.length;
      docs.push({ path: relPath, source, content });
    }
  }

  return docs;
}
