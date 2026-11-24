import type {
  CoverageSummary,
  ExplanationLedger,
  HunkRecord,
} from "./types.ts";

export interface CitationCheckResult {
  valid: boolean;
  errors: string[];
}

export interface LedgerValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  computed_coverage: CoverageSummary;
}

const IDENTIFIER_BACKTICK_RE = /`([A-Za-z_][A-Za-z0-9_]{2,})`/g;

function extractHunkBodyText(patch: string): string {
  return patch
    .split("\n")
    .filter((line) => !line.startsWith("@@ "))
    .join("\n");
}

/**
 * Mechanical check of `what.citations` and backticked identifiers against the hunk.
 * Note: Passing this sets `citations_valid = true` (structural grounding), NOT semantic truth.
 */
export function verifyHunkCitations(hunk: HunkRecord): CitationCheckResult {
  const errors: string[] = [];

  if (!hunk.what) {
    if (hunk.status === "explained") {
      errors.push(`Explained hunk ${hunk.id} is missing a 'what' block.`);
    }
    return { valid: errors.length === 0, errors };
  }

  if (hunk.status === "explained" && hunk.what.citations.length === 0) {
    errors.push(
      `Explained hunk ${hunk.id} must include at least one file:line citation.`,
    );
  }

  for (const citation of hunk.what.citations) {
    const [start, end] = citation.lines;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
      errors.push(
        `Invalid citation range [${start}, ${end}] in hunk ${hunk.id}.`,
      );
      continue;
    }

    const expectedPath =
      citation.side === "old" && hunk.old_path ? hunk.old_path : hunk.path;
    if (citation.path !== expectedPath && citation.path !== hunk.path) {
      errors.push(
        `Citation path '${citation.path}' does not match hunk path '${expectedPath}' in ${hunk.id}.`,
      );
      continue;
    }

    const [rangeStart, rangeEnd] =
      citation.side === "old" ? hunk.old_range : hunk.new_range;

    // Allow empty range [0,0] only if it's a pure rename; otherwise require overlap/containment
    if (rangeStart === 0 && rangeEnd === 0) {
      errors.push(
        `Citation references ${citation.side} lines [${start}, ${end}], but hunk ${hunk.id} has no lines on side '${citation.side}'.`,
      );
    } else if (start < rangeStart || end > rangeEnd) {
      errors.push(
        `Citation ${citation.path}:${start}-${end} (${citation.side}) is outside hunk ${hunk.id} range [${rangeStart}, ${rangeEnd}].`,
      );
    }
  }

  // Check backticked code identifiers mentioned in `what.text` exist in the hunk patch or symbol header
  const searchable = `${hunk.enclosing_symbol ?? ""}\n${hunk.path}\n${extractHunkBodyText(hunk.patch)}`;
  const checkedSymbols = new Set<string>();
  for (const match of hunk.what.text.matchAll(IDENTIFIER_BACKTICK_RE)) {
    const sym = match[1]!;
    if (checkedSymbols.has(sym)) continue;
    checkedSymbols.add(sym);
    if (!searchable.includes(sym)) {
      errors.push(
        `Identifier \`${sym}\` mentioned in 'what.text' was not found in hunk ${hunk.id}.`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function computeCoverage(hunks: HunkRecord[]): CoverageSummary {
  let explained = 0;
  let collapsed = 0;
  let unexplained = 0;

  for (const hunk of hunks) {
    if (hunk.status === "explained") explained += 1;
    else if (hunk.status === "collapsed") collapsed += 1;
    else unexplained += 1;
  }

  return {
    total: hunks.length,
    explained,
    collapsed,
    unexplained,
  };
}

export function validateLedger(ledger: ExplanationLedger): LedgerValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (ledger.schema !== "diffgloss.explanation/v0") {
    errors.push(`Unsupported schema '${String(ledger.schema)}'.`);
  }

  const hunkMap = new Map<string, HunkRecord>();
  for (const hunk of ledger.hunks) {
    if (hunkMap.has(hunk.id)) {
      errors.push(`Duplicate hunk_id '${hunk.id}'.`);
    }
    hunkMap.set(hunk.id, hunk);
  }

  const groupedHunks = new Set<string>();
  const groupIds = new Set<string>();
  for (const group of ledger.groups) {
    if (groupIds.has(group.id)) {
      errors.push(`Duplicate group id '${group.id}'.`);
    }
    groupIds.add(group.id);

    for (const hid of group.hunk_ids) {
      if (!hunkMap.has(hid)) {
        errors.push(`Group '${group.id}' references unknown hunk '${hid}'.`);
      } else {
        groupedHunks.add(hid);
      }
    }
  }

  for (const hunk of ledger.hunks) {
    if (!groupedHunks.has(hunk.id)) {
      errors.push(`Hunk '${hunk.id}' (${hunk.path}) is not assigned to any group.`);
    }

    const citationCheck = verifyHunkCitations(hunk);
    if (!citationCheck.valid) {
      if (hunk.status === "explained") {
        errors.push(...citationCheck.errors);
      } else if (hunk.what?.citations_valid) {
        errors.push(
          `Hunk '${hunk.id}' claims citations_valid=true despite failing mechanical check: ${citationCheck.errors.join("; ")}`,
        );
      } else {
        warnings.push(...citationCheck.errors);
      }
    }

    if (
      hunk.status === "explained" &&
      hunk.what &&
      !hunk.what.citations_valid
    ) {
      errors.push(
        `Hunk '${hunk.id}' is marked 'explained' but has citations_valid=false.`,
      );
    }

    if (
      hunk.status === "explained" &&
      hunk.what &&
      hunk.what.semantic_grounding === "unchecked"
    ) {
      warnings.push(
        `Hunk '${hunk.id}' passed structural citation checks, but semantic_grounding is still 'unchecked'.`,
      );
    }
  }

  const questionMap = new Map(ledger.questions.map((q) => [q.id, q]));
  for (const q of ledger.questions) {
    for (const hid of q.hunk_ids) {
      if (!hunkMap.has(hid)) {
        errors.push(`Question '${q.id}' references unknown hunk '${hid}'.`);
      }
    }
  }
  for (const hunk of ledger.hunks) {
    for (const qid of hunk.questions ?? []) {
      if (!questionMap.has(qid)) {
        errors.push(`Hunk '${hunk.id}' references unknown question '${qid}'.`);
      }
    }
  }

  const computed_coverage = computeCoverage(ledger.hunks);
  const c = ledger.coverage;
  if (
    c.total !== computed_coverage.total ||
    c.explained !== computed_coverage.explained ||
    c.collapsed !== computed_coverage.collapsed ||
    c.unexplained !== computed_coverage.unexplained
  ) {
    errors.push(
      `Coverage mismatch: declared ${JSON.stringify(c)} vs computed ${JSON.stringify(computed_coverage)}.`,
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    computed_coverage,
  };
}
