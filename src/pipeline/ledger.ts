import path from "node:path";
import { classifyHunk } from "../diff/classifier.ts";
import { detectCrossFileMoves } from "../diff/moves.ts";
import { parseUnifiedDiff } from "../diff/parser.ts";
import { splitLargeHunks } from "../diff/subhunk.ts";
import type {
  ClarifyingQuestion,
  ExplanationGroup,
  ExplanationLedger,
  HunkRecord,
  LedgerSource,
  RiskLevel,
} from "../schema/types.ts";
import { computeCoverage } from "../schema/validate.ts";
import { attachFindingsToHunks, runIntegrityChecks } from "./integrity.ts";

export interface BuildLedgerOptions {
  cwd?: string;
  title?: string;
  declaredIntent?: string;
  declaredIntentRef?:
    | "prompt"
    | "pr_description"
    | "plan"
    | "commit_message"
    | "none";
  source?: Omit<LedgerSource, "skipped_files">;
  splitLargeHunks?: boolean;
  subhunkLineThreshold?: number;
  ignorePatterns?: string[];
}

const RISK_ORDER: Record<RiskLevel, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

function maxRisk(levels: RiskLevel[]): RiskLevel {
  if (levels.includes("high")) return "high";
  if (levels.includes("medium")) return "medium";
  return "low";
}

function getModuleKey(filePath: string): string {
  const dir = path.posix.dirname(filePath);
  if (dir === "." || dir === "") return "root";
  const parts = dir.split("/");
  return parts.slice(0, 2).join("/");
}

function matchesGlob(filePath: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§§")
    .replace(/\*/g, "[^/]*")
    .replace(/§§/g, ".*");
  return new RegExp(`^${escaped}$`).test(filePath);
}

/**
 * Deterministic Stage-0/1a pipeline:
 * parses unified diff -> filters ignored paths -> splits oversized multi-symbol hunks ->
 * detects cross-file moves -> classifies mechanical/generated/test/config/substantive ->
 * runs intent-integrity checks -> orders semantically -> computes honest coverage ledger.
 */
export function buildInitialLedger(
  rawDiff: string,
  options: BuildLedgerOptions = {},
): ExplanationLedger {
  const parsed = parseUnifiedDiff(rawDiff);
  const skippedFiles = [...parsed.skipped_files];

  let workingHunks = parsed.hunks;
  if (options.ignorePatterns && options.ignorePatterns.length > 0) {
    const kept = [];
    const skippedSet = new Set<string>();
    for (const h of workingHunks) {
      if (options.ignorePatterns.some((pat) => matchesGlob(h.path, pat))) {
        if (!skippedSet.has(h.path)) {
          skippedSet.add(h.path);
          skippedFiles.push({ path: h.path, reason: "excluded" });
        }
      } else {
        kept.push(h);
      }
    }
    workingHunks = kept;
  }

  if (options.splitLargeHunks !== false) {
    workingHunks = splitLargeHunks(
      workingHunks,
      options.subhunkLineThreshold ?? 40,
      options.cwd,
    );
  }
  workingHunks = detectCrossFileMoves(workingHunks);

  const hunks: HunkRecord[] = [];
  const questions: ClarifyingQuestion[] = [];
  let qCounter = 0;

  for (const p of workingHunks) {
    const cls = classifyHunk(p);
    const questionIds: string[] = [];

    if (cls.trigger && cls.suggestedQuestion) {
      qCounter += 1;
      const qid = `q${qCounter}`;
      questionIds.push(qid);
      questions.push({
        id: qid,
        hunk_ids: [p.id],
        trigger: cls.trigger,
        question: cls.suggestedQuestion,
        channel: "human",
      });
    }

    hunks.push({
      id: p.id,
      path: p.path,
      old_path: p.old_path,
      change_type: p.change_type,
      enclosing_symbol: p.enclosing_symbol,
      old_range: p.old_range,
      new_range: p.new_range,
      class: cls.hunkClass,
      class_by: cls.classBy,
      class_reason: cls.reason,
      status: cls.shouldCollapse ? "collapsed" : "unexplained",
      risk: cls.risk,
      header: p.header,
      patch: p.patch,
      moved_from: p.moved_from,
      why: cls.shouldCollapse
        ? {
            text: cls.reason,
            source: "reviewer_inferred",
            evidence: [],
            verification: "not_checked",
          }
        : {
            text: "Not yet explained — awaiting LLM explanation pass or author provenance.",
            source: "missing",
            evidence: [],
            verification: "not_checked",
          },
      provenance: { format: "none" },
      questions: questionIds.length > 0 ? questionIds : undefined,
    });
  }

  const findings = runIntegrityChecks(hunks);
  attachFindingsToHunks(hunks, findings);

  // Build semantic reading order groups
  const groups: ExplanationGroup[] = [];
  let gCounter = 0;
  const nextGroupId = () => `g${++gCounter}`;

  const highRiskTests = hunks.filter(
    (h) => h.class === "test" && h.risk === "high",
  );
  if (highRiskTests.length > 0) {
    groups.push({
      id: nextGroupId(),
      title: "High-risk test assertion changes",
      intent:
        "Review weakened or modified test assertions first before inspecting implementation changes.",
      order_rationale:
        "Front-loaded because altered assertions can mask regressions in production code.",
      risk: "high",
      hunk_ids: highRiskTests.map((h) => h.id),
    });
  }

  const substantiveByModule = new Map<string, HunkRecord[]>();
  for (const h of hunks) {
    if (h.class !== "substantive") continue;
    const key = getModuleKey(h.path);
    const list = substantiveByModule.get(key) ?? [];
    list.push(h);
    substantiveByModule.set(key, list);
  }

  const sortedModules = [...substantiveByModule.entries()].sort((a, b) => {
    const riskDiff =
      RISK_ORDER[maxRisk(a[1].map((h) => h.risk))] -
      RISK_ORDER[maxRisk(b[1].map((h) => h.risk))];
    if (riskDiff !== 0) return riskDiff;
    return b[1].length - a[1].length;
  });

  for (const [mod, modHunks] of sortedModules) {
    const risk = maxRisk(modHunks.map((h) => h.risk));
    groups.push({
      id: nextGroupId(),
      title: `Core changes: ${mod}`,
      intent: `${modHunks.length} substantive hunk(s) in ${mod} awaiting explanation.`,
      order_rationale:
        risk === "high"
          ? "Prioritized due to sensitive path or removed guard heuristics."
          : "Ordered by deterministic risk and change density.",
      risk,
      hunk_ids: modHunks.map((h) => h.id),
    });
  }

  const normalTests = hunks.filter(
    (h) => h.class === "test" && h.risk !== "high",
  );
  if (normalTests.length > 0) {
    groups.push({
      id: nextGroupId(),
      title: "Tests",
      intent: `${normalTests.length} test hunk(s) covering modified or new behavior.`,
      order_rationale: "Placed after core logic for verification.",
      risk: maxRisk(normalTests.map((h) => h.risk)),
      hunk_ids: normalTests.map((h) => h.id),
    });
  }

  const configs = hunks.filter((h) => h.class === "config");
  if (configs.length > 0) {
    groups.push({
      id: nextGroupId(),
      title: "Configuration & tooling",
      intent: `${configs.length} configuration hunk(s).`,
      order_rationale: "Reviewed after logic and tests.",
      risk: maxRisk(configs.map((h) => h.risk)),
      hunk_ids: configs.map((h) => h.id),
    });
  }

  const collapsed = hunks.filter((h) => h.status === "collapsed");
  if (collapsed.length > 0) {
    groups.push({
      id: nextGroupId(),
      title: "Mechanical, generated & moved changes",
      intent: `${collapsed.length} hunk(s) deterministically classified as low-signal noise; expand any item to inspect.`,
      order_rationale: "Collapsed by default to preserve reviewer attention.",
      risk: "low",
      collapsed_by_default: true,
      hunk_ids: collapsed.map((h) => h.id),
    });
  }

  const coverage = computeCoverage(hunks);
  const overallRisk = maxRisk(hunks.map((h) => h.risk));

  return {
    schema: "diffgloss.explanation/v0",
    generated_at: new Date().toISOString(),
    source: {
      ...options.source,
      skipped_files: skippedFiles,
    },
    overview: {
      title: options.title ?? "Diffgloss Review Ledger",
      behavior_change:
        coverage.total === 0
          ? "No diff hunks detected."
          : `Parsed ${coverage.total} hunk(s): ${coverage.explained} explained, ${coverage.collapsed} collapsed deterministically, ${coverage.unexplained} unexplained.`,
      declared_intent: options.declaredIntent,
      declared_intent_ref: options.declaredIntent
        ? options.declaredIntentRef ?? "prompt"
        : "none",
      risk: overallRisk,
    },
    groups,
    hunks,
    questions,
    findings: findings.length > 0 ? findings : undefined,
    coverage,
  };
}
