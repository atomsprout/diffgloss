---
name: diffgloss
description: Generate a verifiable, browser-ready explainability ledger for the current git diff (coverage accounting, evidence-backed what/why, and clarifying questions for unexplained hunks).
---

# Diffgloss Review Ledger Skill

Use this skill when the user wants to **understand a large diff**, audit AI-authored changes before committing/merging, or check which hunks lack evidence or diverge from declared intent.

## Workflow

1. **Estimate or run Diffgloss** on the target git range (default: working tree or `main..HEAD`):
   - Fast deterministic inspection (zero LLM cost, collapses noise, flags removed guards & weakened tests):
     ```bash
     bun run src/cli.ts inspect [range] --intent "<user's declared goal>" --out .diffgloss/report.html
     ```
   - Full LLM-backed explanation + mechanical citation check (preview cost first with `--dry-run`):
     ```bash
     bun run src/cli.ts explain [range] --intent "<user's declared goal>" --dry-run
     bun run src/cli.ts explain [range] --intent "<user's declared goal>" --serve
     ```
2. **Validate the ledger** and inspect any `unexplained` hunks or `diffgloss/*` integrity findings:
   ```bash
   bun run src/cli.ts validate .diffgloss/ledger.json
   ```
3. **Never fabricate a rationale** for `unexplained` hunks. For every open clarifying question in `.diffgloss/ledger.json`, cite concrete `file:line` or test evidence and record it via:
   ```bash
   bun run src/cli.ts answer .diffgloss/ledger.json <qid> --text "<evidence-backed answer>" --verify
   ```
4. Present the user with:
   - The coverage counts (`total`, `explained`, `collapsed`, `unexplained`)
   - Any high-risk unexplained hunks or refuted answers
   - The path/URL to the interactive browser report (`.diffgloss/report.html` or `http://127.0.0.1:4317`)
