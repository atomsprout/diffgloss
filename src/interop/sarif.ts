import { createHash } from "node:crypto";
import type { AttachedFinding, ExplanationLedger } from "../schema/types.ts";

interface SarifLog {
  version?: string;
  runs?: Array<{
    tool?: { driver?: { name?: string } };
    results?: Array<{
      ruleId?: string;
      level?: string;
      message?: { text?: string };
      partialFingerprints?: Record<string, string>;
      locations?: Array<{
        physicalLocation?: {
          artifactLocation?: { uri?: string };
          region?: { startLine?: number; endLine?: number };
        };
      }>;
    }>;
  }>;
}

function mapSarifSeverity(level: string | undefined): "important" | "nit" | "info" {
  if (level === "error") return "important";
  if (level === "warning") return "important";
  if (level === "note") return "info";
  return "nit";
}

function normalizeUri(uri: string): string {
  return uri.replace(/^file:\/\//, "").replace(/^\.\//, "");
}

export function importSarifFindings(sarifRaw: string): AttachedFinding[] {
  const parsed = JSON.parse(sarifRaw) as SarifLog;
  const findings: AttachedFinding[] = [];
  let counter = 0;

  for (const run of parsed.runs ?? []) {
    const toolName = run.tool?.driver?.name ?? "external-sarif";
    for (const res of run.results ?? []) {
      const phys = res.locations?.[0]?.physicalLocation;
      const rawUri = phys?.artifactLocation?.uri;
      if (!rawUri) continue;

      const filePath = normalizeUri(rawUri);
      const startLine = Math.max(1, phys?.region?.startLine ?? 1);
      const endLine = Math.max(startLine, phys?.region?.endLine ?? startLine);
      const ruleId = res.ruleId ?? "external/rule";
      const message = res.message?.text ?? "External static analysis finding";
      const fp =
        Object.values(res.partialFingerprints ?? {})[0] ??
        createHash("sha256")
          .update(`${toolName}\0${ruleId}\0${filePath}\0${startLine}\0${message}`)
          .digest("hex")
          .slice(0, 16);

      counter += 1;
      findings.push({
        id: `f_sarif_${counter}`,
        rule_id: ruleId,
        tool: toolName,
        severity: mapSarifSeverity(res.level),
        category: "external_sarif",
        path: filePath,
        lines: [startLine, endLine],
        message,
        fingerprint: fp,
      });
    }
  }

  return findings;
}

export function exportSarifReport(ledger: ExplanationLedger): string {
  const results: Array<Record<string, unknown>> = [];

  for (const f of ledger.findings ?? []) {
    results.push({
      ruleId: f.rule_id,
      level: f.severity === "important" ? "error" : f.severity === "nit" ? "warning" : "note",
      message: { text: f.message },
      partialFingerprints: { diffglossFingerprint: f.fingerprint },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: f.path },
            region: { startLine: f.lines[0], endLine: f.lines[1] },
          },
        },
      ],
    });
  }

  // Also emit high-risk unexplained hunks as SARIF warnings for CI visibility
  for (const h of ledger.hunks) {
    if (h.status !== "unexplained" || h.risk !== "high") continue;
    const startLine = Math.max(1, h.new_range[0] || h.old_range[0] || 1);
    const endLine = Math.max(startLine, h.new_range[1] || h.old_range[1] || startLine);
    results.push({
      ruleId: "diffgloss/unexplained-high-risk-hunk",
      level: "warning",
      message: {
        text: `High-risk hunk ${h.id} has no verified explanation: ${h.why?.text ?? "Missing rationale."}`,
      },
      partialFingerprints: { diffglossHunkId: h.id },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: h.path },
            region: { startLine, endLine },
          },
        },
      ],
    });
  }

  const sarif = {
    $schema:
      "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "diffgloss",
            informationUri: "https://github.com/atomsprout/diffgloss",
            version: "0.1.0",
          },
        },
        results,
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}

/**
 * Exports findings & unexplained high-risk hunks in reviewdog rdjsonl format
 * (one JSON diagnostic per line) so any git host supported by reviewdog works immediately.
 */
export function exportRdjsonl(ledger: ExplanationLedger): string {
  const lines: string[] = [];

  for (const f of ledger.findings ?? []) {
    lines.push(
      JSON.stringify({
        message: `[${f.rule_id}] ${f.message}`,
        location: {
          path: f.path,
          range: {
            start: { line: Math.max(1, f.lines[0]) },
            end: { line: Math.max(1, f.lines[1]) },
          },
        },
        severity: f.severity === "important" ? "ERROR" : "WARNING",
        code: { value: f.rule_id },
      }),
    );
  }

  for (const h of ledger.hunks) {
    if (h.status !== "unexplained" || h.risk !== "high") continue;
    lines.push(
      JSON.stringify({
        message: `[diffgloss/unexplained] High-risk hunk (${h.id}) lacks verified explanation: ${h.why?.text ?? ""}`,
        location: {
          path: h.path,
          range: {
            start: { line: Math.max(1, h.new_range[0] || 1) },
            end: { line: Math.max(1, h.new_range[1] || 1) },
          },
        },
        severity: "WARNING",
        code: { value: "diffgloss/unexplained-hunk" },
      }),
    );
  }

  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}
