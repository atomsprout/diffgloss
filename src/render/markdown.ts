import type { ExplanationLedger } from "../schema/types.ts";

export function renderMarkdownReport(ledger: ExplanationLedger): string {
  const c = ledger.coverage;
  const hunkMap = new Map(ledger.hunks.map((h) => [h.id, h]));
  const questionMap = new Map(ledger.questions.map((q) => [q.id, q]));
  const findingMap = new Map((ledger.findings ?? []).map((f) => [f.id, f]));

  const lines: string[] = [];
  lines.push(`# ${ledger.overview.title}`);
  lines.push("");
  lines.push(ledger.overview.behavior_change);
  lines.push("");

  if (ledger.overview.declared_intent) {
    lines.push(
      `> **Declared intent (${ledger.overview.declared_intent_ref ?? "prompt"})**: ${ledger.overview.declared_intent}`,
    );
    lines.push("");
  }

  lines.push("## Coverage Ledger");
  lines.push("");
  lines.push("| Total Hunks | Explained | Collapsed (Mechanical) | Unexplained |");
  lines.push("|---:|---:|---:|---:|");
  lines.push(`| ${c.total} | ${c.explained} | ${c.collapsed} | ${c.unexplained} |`);
  lines.push("");

  if (ledger.cost) {
    lines.push(
      `_Model: \`${ledger.cost.provider}/${ledger.cost.model}\` · Tokens: ${ledger.cost.input_tokens} in (${ledger.cost.cached_input_tokens} cached) / ${ledger.cost.output_tokens} out · Est. cost: \$${ledger.cost.estimated_usd.toFixed(4)} / \$${ledger.cost.budget_usd.toFixed(2)}${ledger.cost.budget_exceeded ? " (BUDGET CAPPED)" : ""}_`,
    );
    lines.push("");
  }

  const skipped = ledger.source?.skipped_files ?? [];
  if (skipped.length > 0) {
    lines.push(
      `**Skipped files:** ${skipped.map((s) => `\`${s.path}\` (${s.reason})`).join(", ")}`,
    );
    lines.push("");
  }

  lines.push("## Semantic Reading Order");
  lines.push("");

  for (const group of ledger.groups) {
    const riskTag = group.risk.toUpperCase();
    const header = `### ${group.title} [${riskTag}]`;

    if (group.collapsed_by_default) {
      lines.push(`<details><summary>${group.title} (${group.hunk_ids.length} hunks, collapsed)</summary>`);
      lines.push("");
    } else {
      lines.push(header);
      lines.push("");
    }

    lines.push(group.intent);
    if (group.order_rationale) {
      lines.push(`_${group.order_rationale}_`);
    }
    lines.push("");

    for (const hid of group.hunk_ids) {
      const h = hunkMap.get(hid);
      if (!h) continue;
      const range = `L${h.new_range[0]}-${h.new_range[1]}`;
      lines.push(
        `- **\`${h.path}:${range}\`** (\`${h.id}\` · \`${h.status}\` · \`${h.class}\` · risk: \`${h.risk}\`)`,
      );
      if (h.what) {
        const cites = h.what.citations
          .map((ci) => `\`${ci.path}:${ci.lines[0]}-${ci.lines[1]}\``)
          .join(", ");
        lines.push(
          `  - **What** [${h.what.citations_valid ? "citations_valid" : "citations_invalid"} | semantic: ${h.what.semantic_grounding}]: ${h.what.text}${cites ? ` (${cites})` : ""}`,
        );
      }
      if (h.why) {
        lines.push(
          `  - **Why** [source: \`${h.why.source}\` | verification: \`${h.why.verification}\`]: ${h.why.text}`,
        );
      }
      for (const fid of h.finding_ids ?? []) {
        const f = findingMap.get(fid);
        if (!f) continue;
        lines.push(`  - **Finding (\`${f.rule_id}\`, ${f.tool})**: ${f.message}`);
      }
      for (const qid of h.questions ?? []) {
        const q = questionMap.get(qid);
        if (!q) continue;
        lines.push(`  - **Question (\`${q.trigger}\`)**: ${q.question}`);
        if (q.answer) {
          lines.push(
            `    - **Answer (${q.answer.answered_by})** [verdict: \`${q.verdict?.status ?? "unverifiable"}\`]: ${q.answer.text}`,
          );
        }
      }
    }

    if (group.collapsed_by_default) {
      lines.push("");
      lines.push("</details>");
    }
    lines.push("");
  }

  if ((ledger.ruled_out?.length ?? 0) > 0) {
    lines.push(`<details><summary>Symmetric Proof: ${ledger.ruled_out!.length} Ruled-Out Concern(s)</summary>`);
    lines.push("");
    for (const ro of ledger.ruled_out!) {
      lines.push(
        `- **\`${ro.path}:${ro.lines[0]}\`** (${ro.specialist}${ro.shaky_dismissal ? " · ESCALATED" : ""}): ${ro.suspicion} — _Proof_: ${ro.proof}`,
      );
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  return lines.join("\n");
}
