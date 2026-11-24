import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ExplanationLedger,
  HunkProvenance,
  WhyEvidence,
} from "../schema/types.ts";
import { redactSecrets } from "./redactor.ts";

export interface WriteTimeManifestEntry {
  at: string;
  session_id?: string;
  agent?: string;
  model?: string;
  path: string;
  tool?: string;
  rationale?: string;
  transcript_path?: string;
}

export interface ProvenanceOptions {
  cwd: string;
  manifestPath?: string;
  transcriptPath?: string;
  autoDiscover?: boolean;
  homeDir?: string;
  redact?: boolean;
}

export interface ProvenanceEnrichmentStats {
  matchedHunks: number;
  sourcesUsed: string[];
  redactions: number;
  discoveredTranscripts: number;
}

function normalizeRelPath(cwd: string, filePath: string): string {
  const cleaned = filePath.replace(/\\/g, "/");
  if (path.isAbsolute(filePath)) {
    const rel = path.relative(cwd, filePath).replace(/\\/g, "/");
    if (!rel.startsWith("..")) return rel;
  }
  return cleaned.replace(/^\.\//, "");
}

export function appendWriteTimeManifest(
  cwd: string,
  entry: WriteTimeManifestEntry,
  manifestRelPath = ".diffgloss/manifest.jsonl",
  redact = true,
): string {
  const abs = path.isAbsolute(manifestRelPath)
    ? manifestRelPath
    : path.join(cwd, manifestRelPath);
  mkdirSync(path.dirname(abs), { recursive: true });

  const safeEntry: WriteTimeManifestEntry = {
    ...entry,
    path: normalizeRelPath(cwd, entry.path),
    rationale:
      entry.rationale && redact
        ? redactSecrets(entry.rationale).text
        : entry.rationale,
  };

  appendFileSync(abs, `${JSON.stringify(safeEntry)}\n`, "utf8");
  return abs;
}

/**
 * Generates a ready-to-drop Claude Code hooks config capturing PostToolUse(Edit|Write)
 * provenance into .diffgloss/manifest.jsonl and optionally enforcing Stop-hook coverage.
 */
export function generateClaudeHooksSnippet(
  options: { strictStop?: boolean } = {},
): Record<string, unknown> {
  const hooks: Record<string, unknown> = {
    PostToolUse: [
      {
        matcher: "Edit|Write",
        hooks: [
          {
            type: "command",
            command: "npx diffgloss hooks capture --agent claude-code",
          },
        ],
      },
    ],
  };

  if (options.strictStop) {
    hooks.Stop = [
      {
        hooks: [
          {
            type: "command",
            command: "npx diffgloss hooks stop-check",
          },
        ],
      },
    ];
  }

  return { hooks };
}

export interface StopHookDecision {
  decision: "allow" | "block";
  reason?: string;
  uncoveredFiles: string[];
}

/**
 * Tier-1 Stop hook gate: verifies every modified substantive file in the current git
 * working tree has an entry in `.diffgloss/manifest.jsonl` before allowing the agent to finish.
 */
export function evaluateStopHook(
  cwd: string,
  manifestRelPath = ".diffgloss/manifest.jsonl",
): StopHookDecision {
  let modifiedFiles: string[] = [];
  try {
    const raw = execFileSync("git", ["diff", "--name-only"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    modifiedFiles = raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return { decision: "allow", uncoveredFiles: [] };
  }

  const substantiveFiles = modifiedFiles.filter(
    (f) =>
      !/(lock\.json|lock\.yaml|\.lockb?|\.md$|\.diffgloss\/)/i.test(f),
  );
  if (substantiveFiles.length === 0) {
    return { decision: "allow", uncoveredFiles: [] };
  }

  const manifestEntries = readManifestEntries(cwd, manifestRelPath);
  const covered = new Set(
    manifestEntries.map((e) => normalizeRelPath(cwd, e.path)),
  );
  const uncoveredFiles = substantiveFiles.filter((f) => !covered.has(f));

  if (uncoveredFiles.length > 0) {
    return {
      decision: "block",
      reason: `Diffgloss stop-check: missing write-time provenance for ${uncoveredFiles.length} modified file(s): ${uncoveredFiles.slice(0, 5).join(", ")}. Record rationale or run diffgloss inspect before stopping.`,
      uncoveredFiles,
    };
  }

  return { decision: "allow", uncoveredFiles: [] };
}

function readManifestEntries(
  cwd: string,
  manifestPath: string,
): WriteTimeManifestEntry[] {
  const abs = path.isAbsolute(manifestPath)
    ? manifestPath
    : path.join(cwd, manifestPath);
  if (!existsSync(abs)) return [];

  const entries: WriteTimeManifestEntry[] = [];
  for (const line of readFileSync(abs, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as WriteTimeManifestEntry);
    } catch {
      // Skip malformed lines cleanly
    }
  }
  return entries;
}

function collectRecentJsonl(dir: string, maxDepth: number, maxFiles: number): string[] {
  if (!existsSync(dir)) return [];
  const found: Array<{ file: string; mtimeMs: number }> = [];

  function walk(cur: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        walk(full, depth + 1);
      } else if (ent.isFile() && ent.name.endsWith(".jsonl")) {
        try {
          found.push({ file: full, mtimeMs: statSync(full).mtimeMs });
        } catch {
          // ignore
        }
      }
    }
  }

  walk(dir, 0);
  return found
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxFiles)
    .map((x) => x.file);
}

/**
 * Automatically discovers recent local Claude Code (`~/.claude/projects/<encoded-cwd>/`)
 * and Codex (`~/.codex/sessions/`) JSONL transcripts for the current workspace (read-only).
 */
export function discoverLocalAgentTranscripts(
  cwd: string,
  options: { homeDir?: string; maxFiles?: number } = {},
): string[] {
  const home = options.homeDir ?? os.homedir();
  const maxFiles = options.maxFiles ?? 5;
  const resolvedCwd = path.resolve(cwd);
  const discovered: string[] = [];

  // 1. Claude Code project session directory encoding: `/Users/foo/bar` -> `-Users-foo-bar`
  const encodedSlash = resolvedCwd.replace(/[\\/]/g, "-");
  const encodedStrict = resolvedCwd.replace(/[^A-Za-z0-9-]/g, "-");
  const claudeRoots = new Set([
    path.join(home, ".claude", "projects", encodedSlash),
    path.join(home, ".claude", "projects", encodedStrict),
  ]);
  for (const root of claudeRoots) {
    for (const f of collectRecentJsonl(root, 1, maxFiles)) {
      if (!discovered.includes(f)) discovered.push(f);
    }
  }

  // 2. Codex local sessions (`~/.codex/sessions/YYYY/MM/DD/*.jsonl`), filtered by cwd mention
  const codexRoot = path.join(home, ".codex", "sessions");
  for (const f of collectRecentJsonl(codexRoot, 4, maxFiles * 2)) {
    try {
      const head = readFileSync(f, "utf8").slice(0, 8192);
      if (head.includes(resolvedCwd) || head.includes(path.basename(resolvedCwd))) {
        if (!discovered.includes(f)) discovered.push(f);
      }
    } catch {
      // ignore unreadable session
    }
    if (discovered.length >= maxFiles * 2) break;
  }

  return discovered.slice(0, maxFiles * 2);
}

interface TranscriptMatch {
  sessionId?: string;
  agent?: string;
  toolUseId?: string;
  rationale: string;
}

/**
 * Reads a Claude Code or Codex JSONL transcript and extracts the latest assistant text
 * immediately preceding an Edit/Write/apply_patch tool call targeting each file path.
 */
export function scanJsonlTranscript(
  cwd: string,
  transcriptPath: string,
): Map<string, TranscriptMatch> {
  const byPath = new Map<string, TranscriptMatch>();
  if (!existsSync(transcriptPath)) return byPath;

  const inferredAgent = transcriptPath.includes(".codex")
    ? "codex"
    : transcriptPath.includes(".claude")
      ? "claude-code"
      : undefined;

  let lastAssistantText = "";
  let sessionId: string | undefined;

  for (const rawLine of readFileSync(transcriptPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (typeof obj.sessionId === "string") sessionId = obj.sessionId;
      if (typeof obj.session_id === "string") sessionId = obj.session_id;

      const msg = (obj.message as Record<string, unknown> | undefined) ?? obj;
      const role = msg.role ?? obj.type;
      const content = msg.content;

      if (role === "assistant" && typeof content === "string") {
        lastAssistantText = content.trim();
      } else if (role === "assistant" && Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
            lastAssistantText = b.text.trim();
          }
          if (b.type === "tool_use") {
            const input = (b.input as Record<string, unknown> | undefined) ?? {};
            const targetPath =
              (typeof input.file_path === "string" && input.file_path) ||
              (typeof input.path === "string" && input.path) ||
              (typeof input.Path === "string" && input.Path) ||
              "";
            if (targetPath && lastAssistantText) {
              byPath.set(normalizeRelPath(cwd, targetPath), {
                sessionId,
                agent: inferredAgent,
                toolUseId: typeof b.id === "string" ? b.id : undefined,
                rationale: lastAssistantText.slice(0, 400),
              });
            }
          }
        }
      }

      // Codex function_call events with apply_patch or file arguments
      if (obj.type === "function_call" && typeof obj.arguments === "string") {
        const patchFileRe = /\*\*\* (?:Update|Add) File:\s*(.+)/g;
        for (const m of obj.arguments.matchAll(patchFileRe)) {
          const targetPath = m[1]?.trim();
          if (targetPath && lastAssistantText) {
            byPath.set(normalizeRelPath(cwd, targetPath), {
              sessionId,
              agent: inferredAgent ?? "codex",
              toolUseId: typeof obj.call_id === "string" ? obj.call_id : undefined,
              rationale: lastAssistantText.slice(0, 400),
            });
          }
        }
      }
    } catch {
      // Ignore unparseable JSONL lines
    }
  }

  return byPath;
}

function readGitAiNotes(cwd: string): Map<string, { sessionId?: string; note: string }> {
  const map = new Map<string, { sessionId?: string; note: string }>();
  try {
    const raw = execFileSync("git", ["notes", "--ref=ai", "show", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) {
      const parsed = JSON.parse(trimmed) as {
        files?: Record<string, { session_id?: string; prompt?: string }>;
      };
      for (const [filePath, info] of Object.entries(parsed.files ?? {})) {
        map.set(normalizeRelPath(cwd, filePath), {
          sessionId: info.session_id,
          note: info.prompt ?? `Tracked via refs/notes/ai (${info.session_id ?? "unknown"})`,
        });
      }
    }
  } catch {
    // No git-ai notes present
  }
  return map;
}

function readEntireCheckpoint(cwd: string): string | null {
  try {
    const msg = execFileSync("git", ["log", "-n", "1", "--format=%B"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = /^Entire-Checkpoint:\s*(.+)$/m.exec(msg);
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

function readAgentTrace(cwd: string): Map<string, { sessionId?: string; agent?: string }> {
  const map = new Map<string, { sessionId?: string; agent?: string }>();
  const tracePath = path.join(cwd, ".agent-trace", "traces.json");
  if (!existsSync(tracePath)) return map;
  try {
    const parsed = JSON.parse(readFileSync(tracePath, "utf8")) as {
      files?: Array<{
        path?: string;
        conversations?: Array<{ url?: string; contributor?: { type?: string; model_id?: string } }>;
      }>;
    };
    for (const f of parsed.files ?? []) {
      if (!f.path) continue;
      const conv = f.conversations?.[0];
      map.set(normalizeRelPath(cwd, f.path), {
        sessionId: conv?.url,
        agent: conv?.contributor?.model_id ?? conv?.contributor?.type,
      });
    }
  } catch {
    // Ignore malformed trace file
  }
  return map;
}

/**
 * Enriches ledger hunks with provenance across Tiers 1-2:
 * write-time manifest -> explicit & auto-discovered local Claude/Codex transcripts ->
 * git-ai notes -> agent-trace -> entire checkpoint trailer.
 * All persisted excerpts are redacted by default.
 */
export function enrichLedgerProvenance(
  ledger: ExplanationLedger,
  options: ProvenanceOptions,
): ProvenanceEnrichmentStats {
  const shouldRedact = options.redact !== false;
  const manifestPath = options.manifestPath ?? ".diffgloss/manifest.jsonl";
  const manifestEntries = readManifestEntries(options.cwd, manifestPath);
  const manifestByPath = new Map<string, WriteTimeManifestEntry>();
  const discoveredTranscripts = new Set<string>();

  for (const e of manifestEntries) {
    manifestByPath.set(normalizeRelPath(options.cwd, e.path), e);
    if (e.transcript_path) discoveredTranscripts.add(e.transcript_path);
  }
  if (options.transcriptPath) discoveredTranscripts.add(options.transcriptPath);

  if (options.autoDiscover !== false) {
    for (const autoPath of discoverLocalAgentTranscripts(options.cwd, {
      homeDir: options.homeDir,
    })) {
      discoveredTranscripts.add(autoPath);
    }
  }

  const transcriptMatches = new Map<string, TranscriptMatch>();
  for (const tp of discoveredTranscripts) {
    for (const [k, v] of scanJsonlTranscript(options.cwd, tp)) {
      if (!transcriptMatches.has(k)) transcriptMatches.set(k, v);
    }
  }

  const gitAiNotes = readGitAiNotes(options.cwd);
  const agentTrace = readAgentTrace(options.cwd);
  const entireCheckpoint = readEntireCheckpoint(options.cwd);

  let matchedHunks = 0;
  let totalRedactions = 0;
  const sourcesUsed = new Set<string>();

  const cleanText = (txt: string): string => {
    if (!shouldRedact) return txt;
    const res = redactSecrets(txt);
    totalRedactions += res.redactions;
    return res.text;
  };

  for (const hunk of ledger.hunks) {
    if (hunk.status === "collapsed") continue;

    const normPath = normalizeRelPath(options.cwd, hunk.path);
    const mEntry = manifestByPath.get(normPath);
    const tMatch = transcriptMatches.get(normPath);
    const gNote = gitAiNotes.get(normPath);
    const aTrace = agentTrace.get(normPath);

    let prov: HunkProvenance | null = null;
    const evidence: WhyEvidence[] = [];
    let rationaleText: string | null = null;

    if (mEntry) {
      prov = {
        format: "hook",
        session_id: mEntry.session_id,
        agent: mEntry.agent,
        model: mEntry.model,
      };
      sourcesUsed.add("hook");
      if (mEntry.rationale) {
        rationaleText = cleanText(mEntry.rationale);
        evidence.push({
          kind: "tool_use",
          ref: `hook:${mEntry.session_id ?? "local"}#${mEntry.tool ?? "edit"}`,
          excerpt: rationaleText.slice(0, 180),
        });
      }
    }

    if (tMatch) {
      if (!prov) {
        prov = {
          format: "session-scan",
          session_id: tMatch.sessionId,
          agent: tMatch.agent,
        };
      }
      sourcesUsed.add("session-scan");
      const safeExcerpt = cleanText(tMatch.rationale);
      if (!rationaleText) rationaleText = safeExcerpt;
      evidence.push({
        kind: "transcript_turn",
        ref: `session:${tMatch.sessionId ?? "local"}#${tMatch.toolUseId ?? "edit"}`,
        excerpt: safeExcerpt.slice(0, 180),
      });
    } else if (gNote && !prov) {
      prov = { format: "git-ai", session_id: gNote.sessionId };
      sourcesUsed.add("git-ai");
      rationaleText = cleanText(gNote.note);
      evidence.push({
        kind: "git_note",
        ref: `refs/notes/ai#${gNote.sessionId ?? "HEAD"}`,
        excerpt: rationaleText.slice(0, 180),
      });
    } else if (aTrace && !prov) {
      prov = {
        format: "agent-trace",
        session_id: aTrace.sessionId,
        agent: aTrace.agent,
      };
      sourcesUsed.add("agent-trace");
    } else if (entireCheckpoint && !prov) {
      prov = { format: "entire", session_id: entireCheckpoint };
      sourcesUsed.add("entire");
    }

    if (prov) {
      matchedHunks += 1;
      hunk.provenance = prov;
      if (
        rationaleText &&
        (!hunk.why ||
          hunk.why.source === "missing" ||
          hunk.why.source === "reviewer_inferred")
      ) {
        hunk.why = {
          text: rationaleText,
          source: "transcript",
          evidence,
          verification: "not_checked",
        };
      }
    }
  }

  return {
    matchedHunks,
    sourcesUsed: [...sourcesUsed],
    redactions: totalRedactions,
    discoveredTranscripts: discoveredTranscripts.size,
  };
}
