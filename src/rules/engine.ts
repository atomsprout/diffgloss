import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseSimpleYaml } from "../config/loader.ts";
import type {
  AttachedFinding,
  HunkRecord,
  RuleTelemetry,
} from "../schema/types.ts";

export interface StructuredRule {
  id: string;
  title: string;
  severity: "important" | "nit" | "info";
  kind: "regex" | "llm";
  include: string[];
  exclude: string[];
  pattern?: string;
  evidence?: string;
  tags: string[];
  body: string;
  filePath: string;
  source: "base_ref" | "working_tree";
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§§")
    .replace(/\*/g, "[^/]*")
    .replace(/§§/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export function matchesRuleScope(filePath: string, rule: StructuredRule): boolean {
  if (rule.exclude.some((p) => globToRegex(p).test(filePath))) return false;
  if (rule.include.length === 0) return true;
  return rule.include.some((p) => globToRegex(p).test(filePath));
}

export function parseStructuredRuleMarkdown(
  raw: string,
  filePath: string,
  source: "base_ref" | "working_tree",
): StructuredRule | null {
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw.trim());
  if (!fmMatch) return null;

  const meta = parseSimpleYaml(fmMatch[1]!);
  const body = (fmMatch[2] ?? "").trim();
  const id =
    typeof meta.id === "string" && meta.id.trim()
      ? meta.id.trim()
      : path.posix.basename(filePath, ".md");
  const title = typeof meta.title === "string" ? meta.title : id;
  const severity =
    meta.severity === "important" || meta.severity === "nit" || meta.severity === "info"
      ? meta.severity
      : "important";
  const kind = meta.kind === "regex" ? "regex" : "llm";
  const include = Array.isArray(meta.include) ? meta.include.map(String) : [];
  const exclude = Array.isArray(meta.exclude) ? meta.exclude.map(String) : [];
  const tags = Array.isArray(meta.tags) ? meta.tags.map(String) : [];

  return {
    id,
    title,
    severity,
    kind,
    include,
    exclude,
    pattern: typeof meta.pattern === "string" ? meta.pattern : undefined,
    evidence: typeof meta.evidence === "string" ? meta.evidence : undefined,
    tags,
    body,
    filePath,
    source,
  };
}

function listRuleFilesAtRef(cwd: string, ref: string, dirRel: string): string[] {
  try {
    const out = execFileSync("git", ["ls-tree", "-r", "--name-only", ref, dirRel], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.endsWith(".md"));
  } catch {
    return [];
  }
}

export function loadStructuredRules(
  cwd: string,
  options: { baseRef?: string; rulesFromBase?: boolean; rulesDir?: string } = {},
): StructuredRule[] {
  const dirRel = options.rulesDir ?? ".diffgloss/rules";
  const rules: StructuredRule[] = [];

  if (options.rulesFromBase !== false && options.baseRef) {
    const files = listRuleFilesAtRef(cwd, options.baseRef, dirRel);
    for (const rel of files) {
      try {
        const raw = execFileSync("git", ["show", `${options.baseRef}:${rel}`], {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        const parsed = parseStructuredRuleMarkdown(raw, rel, "base_ref");
        if (parsed) rules.push(parsed);
      } catch {
        // ignore unreadable rule
      }
    }
    return rules;
  }

  const absDir = path.isAbsolute(dirRel) ? dirRel : path.join(cwd, dirRel);
  if (!existsSync(absDir)) return rules;

  for (const name of readdirSync(absDir).sort()) {
    if (!name.endsWith(".md")) continue;
    const rel = path.posix.join(dirRel.replace(/\\/g, "/"), name);
    const raw = readFileSync(path.join(absDir, name), "utf8");
    const parsed = parseStructuredRuleMarkdown(raw, rel, "working_tree");
    if (parsed) rules.push(parsed);
  }

  return rules;
}

export interface DeterministicRuleRunResult {
  findings: AttachedFinding[];
  telemetry: RuleTelemetry[];
  scopedLlmRules: Array<{ rule: StructuredRule; hunkIds: string[] }>;
}

export function evaluateStructuredRules(
  rules: StructuredRule[],
  hunks: HunkRecord[],
): DeterministicRuleRunResult {
  const findings: AttachedFinding[] = [];
  const telemetry: RuleTelemetry[] = [];
  const scopedLlmRules: Array<{ rule: StructuredRule; hunkIds: string[] }> = [];
  let counter = 0;

  for (const rule of rules) {
    const matchingHunks = hunks.filter(
      (h) => h.status !== "collapsed" && matchesRuleScope(h.path, rule),
    );
    let hits = 0;

    if (rule.kind === "regex" && rule.pattern) {
      let re: RegExp;
      try {
        re = new RegExp(rule.pattern, "m");
      } catch {
        continue;
      }

      for (const hunk of matchingHunks) {
        const addedCode = hunk.patch
          .split("\n")
          .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
          .map((l) => l.slice(1))
          .join("\n");
        const m = re.exec(addedCode);
        if (m) {
          hits += 1;
          counter += 1;
          findings.push({
            id: `f_rule_${counter}`,
            rule_id: `rule/${rule.id}`,
            tool: "diffgloss-rules",
            severity: rule.severity,
            category: "custom_rule",
            path: hunk.path,
            lines: hunk.new_range[0] > 0 ? hunk.new_range : [1, 1],
            hunk_id: hunk.id,
            message: `${rule.title}: ${rule.body.split("\n")[0] ?? "Pattern violation detected."}`,
            evidence: m[0].slice(0, 140),
            fingerprint: createHash("sha256")
              .update(`rule/${rule.id}\0${hunk.path}\0${m[0]}`)
              .digest("hex")
              .slice(0, 16),
          });
        }
      }
    } else if (rule.kind === "llm" && matchingHunks.length > 0) {
      // Optional regex pre-trigger for LLM rules
      const triggered = rule.pattern
        ? matchingHunks.filter((h) => {
            try {
              return new RegExp(rule.pattern!, "m").test(h.patch);
            } catch {
              return true;
            }
          })
        : matchingHunks;
      if (triggered.length > 0) {
        scopedLlmRules.push({
          rule,
          hunkIds: triggered.map((h) => h.id),
        });
      }
    }

    telemetry.push({
      id: rule.id,
      title: rule.title,
      path: rule.filePath,
      source: rule.source,
      kind: rule.kind,
      matched_hunks: matchingHunks.length,
      hits,
    });
  }

  return { findings, telemetry, scopedLlmRules };
}
