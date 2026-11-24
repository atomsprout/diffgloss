# Diffgloss Architecture & Roadmap

> Status: v0 draft (2026-11-23).
> Runtime: TypeScript on **Bun** (standard ESM + Node-compatible APIs).
> Primary UI (Stage 1): Self-contained interactive **browser HTML report** (offline single-file + optional local `Bun.serve` preview).

---

## 1. Core Thesis

Diffgloss is **not** "another AI bug hunter with a summary attached". It is an **explainability ledger** for code changes.

Every hunk (or AST-split sub-hunk) in a diff must satisfy an explicit **coverage invariant** — falling into exactly one of three states:

1. **`explained`** — covered by a semantic group explanation, with:
   - **`what`**: what the code actually changed, backed by mechanically verified `file:line` citations (`citations_valid`) and optional semantic grounding checks (`semantic_grounding`).
   - **`why`**: rationale explicitly tagged by provenance tier (`transcript` > `declared_intent` > `author_answer` > `reviewer_inferred` > `missing`).
2. **`collapsed`** — mechanical, generated, lockfile, whitespace, or pure move/rename changes classified deterministically first (and always one click away to expand).
3. **`unexplained`** — changes that lack evidence for `why`, contradict declared intent, weaken tests, or remove guards. Surfaced prominently and eligible to trigger clarifying questions.

---

## 2. Design Guardrails

1. **Separate structural grounding from semantic verification**
   - Mechanical checks verify that cited `file:line` coordinates fall within the hunk/file and referenced code identifiers exist (`citations_valid: true`).
   - Never display mechanical checks as proof of semantic correctness; track semantic grounding separately (`semantic_grounding: "unchecked" | "judge_passed" | "judge_failed" | "test_backed"`).
2. **Progressive disclosure over wall-of-text**
   - Deterministic preprocessing, mechanical collapsing, and diff layout render immediately (<1s).
   - Explanations are many-to-one (group level by default), with hunk-level details and citations expandable on demand.
   - Browser report tracks reviewer attention via per-group "Understood" toggles to counter passive reading / comprehension debt.
3. **Independence before questioning**
   - Blind-first: the explainer analyzes diff + repository + declared intent (`prompt` / `plan` / PR description) without seeing author post-hoc rationalizations.
   - Triggered questioning: only `unexplained` hunks with explicit trigger reasons generate clarifying questions.
   - Answers are treated as unverified claims (`confirmed` / `refuted` / `unverifiable`) and are strictly isolated from any downstream defect-finding pass.
4. **Privacy & security defaults**
   - `.diffgloss/` is ignored by git by default; transcript excerpts undergo secret redaction before persistence.
   - Skip suspected credential files (`.env*`, `*.pem`, `*.key`) by default during ingestion.
   - Rule files (`AGENTS.md`, `CLAUDE.md`, `REVIEW.md`, `diffgloss.yaml`) default to reading from the base branch in PR contexts to mitigate prompt injection.
5. **Language-neutral JSON contracts**
   - Internal boundaries (`diffgloss.explanation/v0`, future `finding/v0`, `rule/v0`) are strict JSON schemas, allowing deterministic analyzers (e.g., tree-sitter / Rust sidecars) or external SARIF tools to plug in without breaking the renderer or CLI.

---

## 3. Pipeline Overview (Progressive)

```text
git diff / patch
   │
   ▼
[1. Ingest]         Parse unified diff -> files & hunks, content-hash hunk_id, skip secrets/binary
   │
   ▼
[2. Preproc]        Deterministic classification (lockfile, generated, whitespace, config, test)
   │                (Next: tree-sitter AST sub-hunk splitting & enclosing symbol extraction)
   ▼
[3. Group & Order]  Semantic ordering: data model -> core logic -> call sites -> tests -> config -> collapsed
   │                (High-risk test edits surfaced alongside or before implementation)
   ▼
[4. Explain]        LLM pass (multi-provider, hard budget) -> overview + groups + hunk what/why
   │
   ▼
[5. Verify]         Mechanical citation/symbol check (`citations_valid`) + optional semantic judge
   │
   ▼
[6. Provenance/Q&A] (Stage 2) Write-time hook -> transcript lookup -> forked session resume -> verdict
   │
   ▼
[7. Render]         Standalone interactive HTML report (browser) + JSON ledger (+ future SARIF/MD)
```

---

## 4. Tech Stack Decisions

- **TypeScript + Bun** for fast startup, built-in test runner (`bun test`), native TS execution, and built-in local HTTP preview (`Bun.serve`).
- **Node 20+ compatible ESM**: stick to standard Web APIs and `node:*` built-ins in core modules so the package can run cleanly on both Bun and Node (`bunx` / `npx`) without fighting cross-platform `bun build --compile` native/WASM packaging during Stage 0–1.
- **Provider-agnostic LLM layer (Stage 1b)**: direct `fetch` adapters for the 4 core API dialects (Anthropic Messages, OpenAI Responses/Completions, Google GenAI, plus `base_url` overrides for Ollama/OpenRouter/LiteLLM) with explicit token/USD budget caps.
- **Zero-dependency browser viewer**: single-file HTML bundle with inline CSS/JS so reports open instantly offline, attach cleanly to CI artifacts, and require zero backend auth.

---

## 5. Phased Roadmap (Trimmed for Velocity)

| Phase | Scope | Exit Criterion |
|---|---|---|
| **Phase 0 (Now)** | `diffgloss.explanation/v0` schema, Bun CLI skeleton, unified diff parser, deterministic classifier, citation & coverage validator, standalone interactive HTML renderer | `bun test` green; can run `diffgloss inspect` on real repo diffs and explore them in the browser |
| **Phase 1 (Explain MVP)** | Multi-provider LLM explainer with hard budget, tree-sitter enclosing-symbol & sub-hunk splitting, declared-intent input (`--intent` / PR body / plan file), Claude Code / Codex Agent Skill | User stops screenshotting diffs to ask coding agents what changed; 5–8 real golden diffs pass coverage & citation checks |
| **Phase 2 (Provenance & Q&A)** | Write-time capture hooks (Claude Code / Codex), redacted transcript lookup, triggered clarifying Q&A for `unexplained` hunks, cold-start answer verifier | Every `unexplained` hunk can be resolved into an audited Q&A record with a `confirmed` / `refuted` / `unverifiable` verdict |
| **Phase 3 (Intent Integrity & Interop)** | Built-in intent-divergence checks (claim mismatch, weakened tests, scope creep, removed guards), SARIF import to attach external linter/bug-hunter findings onto explanation groups, zero-config `AGENTS.md`/`CLAUDE.md`/`REVIEW.md` ingestion | External static/AI findings render in context inside semantic groups without rebuilding a generic bug hunter |
| **Phase 4 (Platform & Memory)** | GitHub/GitLab comment & check integration, incremental hunk-fingerprint reconciliation, local feedback store, optional MCP server | Smooth CI + local workflow with measurable signal tracking |
