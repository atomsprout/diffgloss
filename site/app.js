(function () {
  // 0. Dark / Light Theme toggle (respects saved preference or prefers-color-scheme)
  const themeBtn = document.getElementById("theme-toggle");
  const THEME_KEY = "diffgloss.site.theme";

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    if (themeBtn) {
      themeBtn.textContent = theme === "light" ? "☾ Dark" : "☀ Light";
    }
  }

  const savedTheme = localStorage.getItem(THEME_KEY);
  const initialTheme =
    savedTheme === "light" || savedTheme === "dark"
      ? savedTheme
      : window.matchMedia?.("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark";
  applyTheme(initialTheme);

  themeBtn?.addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
    const next = cur === "light" ? "dark" : "light";
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });

  // 1. 3D Stage mouse parallax + Raw/Gloss mode toggle
  const stage = document.getElementById("stage-3d");
  const stageWrap = stage?.parentElement;

  document.querySelectorAll("[data-stage-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.getAttribute("data-stage-mode");
      document.querySelectorAll("[data-stage-mode]").forEach((b) => {
        const active = b === btn;
        b.classList.toggle("active", active);
        b.setAttribute("aria-selected", String(active));
      });
      if (stage && mode) stage.setAttribute("data-mode", mode);
    });
  });

  if (stage && stageWrap) {
    stageWrap.addEventListener("mousemove", (ev) => {
      if (stage.getAttribute("data-mode") === "raw" || window.innerWidth <= 640) return;
      const rect = stageWrap.getBoundingClientRect();
      const x = (ev.clientX - rect.left) / rect.width - 0.5;
      const y = (ev.clientY - rect.top) / rect.height - 0.5;
      stage.style.transform = `rotateY(${(-6 + x * 16).toFixed(2)}deg) rotateX(${(5 - y * 14).toFixed(2)}deg)`;
    });
    stageWrap.addEventListener("mouseleave", () => {
      if (stage.getAttribute("data-mode") === "raw") {
        stage.style.transform = "rotateY(0deg) rotateX(0deg)";
      } else {
        stage.style.transform = "rotateY(-8deg) rotateX(6deg)";
      }
    });
  }

  // 2. 3D Tilt cards
  document.querySelectorAll(".tilt-card").forEach((card) => {
    card.addEventListener("mousemove", (ev) => {
      const r = card.getBoundingClientRect();
      const x = (ev.clientX - r.left) / r.width - 0.5;
      const y = (ev.clientY - r.top) / r.height - 0.5;
      card.style.transform = `perspective(700px) rotateY(${(x * 8).toFixed(2)}deg) rotateX(${(-y * 8).toFixed(2)}deg) translateY(-3px)`;
    });
    card.addEventListener("mouseleave", () => {
      card.style.transform = "";
    });
  });

  // 3. Interactive 5-Stage Pipeline Explorer
  const STAGES = [
    {
      title: "01 · Deterministic Ingestion & Multi-Language AST Splitting (<1s)",
      desc: "Before spending a single LLM token, Diffgloss parses the unified diff, strips secrets & binaries, splits oversized hunks along real function/method scopes, detects cross-file verbatim moves, and collapses mechanical noise.",
      bullets: [
        "Content-hash hunk_id resilient to minor line shifts",
        "Lexer-aware AST scope splitter (TS, JS, Python, Go, Rust, Java, C++)",
        "Skips .env*, *.pem, *.key and collapses lockfiles/whitespace/renames",
        "Flags weakened test assertions, removed safety guards, and silent catch blocks",
      ],
      code: `// Coverage invariant enforced on every hunk\ncoverage.total === explained + collapsed + unexplained\n\n// Never hides substantive edits\nfalse_mechanical_collapses === 0`,
    },
    {
      title: "02 · 4-Tier Provenance Capture & Secret Redaction",
      desc: "The most trustworthy 'Why' is captured when code is written—not guessed afterward. Diffgloss reads write-time hooks and local coding-agent transcripts while redacting secrets automatically.",
      bullets: [
        "Tier 1: Claude Code PostToolUse manifest + optional Stop coverage gate",
        "Tier 2: Auto-discovered ~/.claude & ~/.codex JSONL transcripts, Git AI notes, Agent Trace, Entire",
        "Tier 3: Forked read-only session resume (--fork-session) for unanswered triggers",
        "Automatic redaction of API keys, JWTs, PEM blocks, and password assignments",
      ],
      code: `// Base-branch trust boundary prevents PR prompt injection\nREVIEW.md / AGENTS.md / CLAUDE.md -> git show <base_ref>:<path>\n.diffgloss/rules/*.md             -> scoped YAML + telemetry`,
    },
    {
      title: "03 · Blind-First Explanation & Mechanical Grounding",
      desc: "The explainer reads only the diff, base rules, and declared intent—never author self-defense. Every explained hunk must pass mechanical file:line and backticked-symbol verification.",
      bullets: [
        "Hard USD budget guard + pre-run --dry-run cost estimation",
        "1x targeted citation repair loop; failed hunks honestly demote to 'unexplained'",
        "Strict UI split: structural citations_valid vs. cold-start semantic_grounding",
        "Works with DeepSeek, Anthropic (prompt cached), OpenAI, Gemini, OpenRouter & Ollama",
      ],
      code: `"what": {\n  "citations": [{ "path": "src/auth/session.ts", "lines": [15, 17], "side": "new" }],\n  "citations_valid": true,\n  "semantic_grounding": "judge_passed"\n}`,
    },
    {
      title: "04 · Isolated Symmetric-Proof Bug Review & Q&A Verifier",
      desc: "Parallel narrow specialists (Logic/Correctness + Security/Rules) NEVER see author answers. Every bug claim and every ruled-out dismissal requires concrete code proof.",
      bullets: [
        "Outputs both verified findings and Ruled-Out Concerns with code proof",
        "Shaky self-dismissals ('probably checked upstream') auto-escalate to verification",
        "Cold-start verifier checks human/agent answers: confirmed | refuted | unverifiable",
        "Refuted answers stay pinned at the top as unexplained",
      ],
      code: `"ruled_out": [{\n  "specialist": "logic-correctness",\n  "suspicion": "Off-by-one at expiresAt === now boundary",\n  "proof": "Both touchSession (<= now) and verifySession (> now) treat === now as expired."\n}]`,
    },
    {
      title: "05 · Multi-Surface Outputs & Local Workbench",
      desc: "One language-neutral JSON ledger projects cleanly into an offline interactive browser tour, GitHub PR sticky comments, SARIF 2.1.0, reviewdog rdjsonl, and an MCP stdio server.",
      bullets: [
        "diffgloss ui: switch any local git repo or click any commit in history",
        "In-page ⚙ Models modal: 10 presets, Test Connection & Run Explain Now",
        "GitHub PR incremental fingerprint reconciliation (auto-resolves fixed comments)",
        "Native MCP tools: diffgloss_inspect, explain_hunk, list_rules, record_answer",
      ],
      code: `node dist/cli.js ui              # Interactive browser workbench\nnode dist/cli.js mcp             # MCP JSON-RPC 2.0 stdio server\nnode dist/cli.js pr-comment      # Sticky ledger + inline fingerprints`,
    },
  ];

  const pipeDetail = document.getElementById("pipe-detail");
  function renderStage(idx) {
    const s = STAGES[idx];
    if (!s || !pipeDetail) return;
    pipeDetail.innerHTML = `
      <div>
        <h3>${s.title}</h3>
        <p>${s.desc}</p>
        <ul class="pipe-bullets">${s.bullets.map((b) => `<li>${b}</li>`).join("")}</ul>
      </div>
      <pre class="pipe-code"><code>${s.code}</code></pre>
    `;
  }
  document.getElementById("pipe-nodes")?.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-stage]");
    if (!btn) return;
    document.querySelectorAll(".pipe-node").forEach((n) => n.classList.remove("active"));
    btn.classList.add("active");
    renderStage(Number(btn.getAttribute("data-stage")));
  });
  renderStage(0);

  // 4. Interactive Mini-Ledger Demo
  const DEMOS = [
    {
      path: "src/auth/session.ts",
      symbol: "verifySession",
      status: "unexplained",
      risk: "high",
      what: "Deletes the `session.revokedAt !== null` check in `verifySession`, leaving only expiration timestamp validation.",
      cite: { label: "src/auth/session.ts:31-33 (old)", lines: [31, 32, 33] },
      citeValid: true,
      semantic: "judge_passed",
      whySource: "missing",
      why: "Contradicts declared intent ('Do NOT weaken revoked session checks'). Cold verifier refuted author claim that gateway checks revocation.",
      proof: "Trigger: safety_check_removed · Cold Verifier Verdict: REFUTED — no `revokedAt` check exists in gateway middleware.",
      rows: [
        { n: 30, kind: "ctx", t: " export function verifySession(session: Session) {" },
        { n: 31, kind: "del", t: "-  if (session.revokedAt !== null) {" },
        { n: 32, kind: "del", t: '-    throw new Error("Session revoked");' },
        { n: 33, kind: "del", t: "-  }" },
        { n: 34, kind: "ctx", t: "   return session.expiresAt > Date.now();" },
        { n: 35, kind: "ctx", t: " }" },
      ],
    },
    {
      path: "src/db/users.ts",
      symbol: "lookupUserByEmail",
      status: "explained",
      risk: "high",
      what: "Builds a raw SQL `query` by concatenating `email` directly into a SELECT clause and returns `db.query(query)`.",
      cite: { label: "src/db/users.ts:19-20 (new)", lines: [19, 20] },
      citeValid: true,
      semantic: "judge_passed",
      whySource: "declared_intent",
      why: "Matches declared intent to add lookupUserByEmail helper, while isolated security specialist flagged SQL injection.",
      proof: "Symmetric Proof: [Verified Finding bug/security] SQL injection via string concatenation · [Ruled-Out ro_1] Checked touchSession vs verifySession boundary (<= vs >), proven consistent.",
      rows: [
        { n: 18, kind: "ctx", t: " export async function lookupUserByEmail(email: string) {" },
        { n: 19, kind: "add", t: "+  const query = \"SELECT id, email FROM users WHERE email = '\" + email + \"'\";" },
        { n: 20, kind: "add", t: "+  return db.query(query);" },
        { n: 21, kind: "ctx", t: " }" },
      ],
    },
    {
      path: "tests/billing.test.ts",
      symbol: "describe('webhook')",
      status: "unexplained",
      risk: "high",
      what: "Removes the `rejects.toThrow('Invalid signature')` assertion and leaves a trivial `expect(true).toBe(true)` placeholder.",
      cite: { label: "tests/billing.test.ts:9-10 (old/new)", lines: [9, 10] },
      citeValid: true,
      semantic: "judge_passed",
      whySource: "missing",
      why: "No evidence justifies weakening signature verification tests; front-loaded to Group 1 before production webhook edits.",
      proof: "Built-in Integrity Rules Fired: diffgloss/test-assertion-weakened + diffgloss/silent-error-swallow in src/billing/webhook.ts.",
      rows: [
        { n: 8, kind: "ctx", t: '   it("rejects invalid signature", async () => {' },
        { n: 9, kind: "del", t: '-    await expect(handleWebhook(badEvent)).rejects.toThrow("Invalid signature");' },
        { n: 10, kind: "add", t: "+    expect(true).toBe(true);" },
        { n: 11, kind: "ctx", t: "   });" },
      ],
    },
  ];

  let activeDemo = 0;
  let selfCheck = false;
  let revealed = false;
  let highlightedLines = [];

  const demoBody = document.getElementById("demo-body");
  function renderDemo() {
    const d = DEMOS[activeDemo];
    if (!d || !demoBody) return;
    const hideWhat = selfCheck && !revealed;

    demoBody.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:8px;flex-wrap:wrap">
        <div class="mono" style="font-size:13px"><strong>${d.path}</strong> <span style="color:var(--muted)">· ${d.symbol}</span></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <span class="chip ${d.status === "explained" ? "chip-green" : "chip-red"}">${d.status}</span>
          <span class="chip chip-red">risk: ${d.risk}</span>
        </div>
      </div>
      <div class="demo-cards">
        <div class="demo-ev">
          <div class="demo-ev-head">
            <span>What (Code Fact)</span>
            <span>
              <span class="chip chip-green">citations_valid ✓</span>
              <span class="chip chip-cyan">${d.semantic}</span>
            </span>
          </div>
          ${
            hideWhat
              ? `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:12.5px;color:var(--muted)">
                   <span>Inspect the diff below first, then reveal the explanation.</span>
                   <button class="mini-btn active" id="demo-reveal-btn">Reveal What</button>
                 </div>`
              : `<div class="demo-ev-text">${d.what}</div>
                 <button class="demo-cite-btn" id="demo-cite-btn">⌖ Highlight ${d.cite.label}</button>`
          }
        </div>
        <div class="demo-ev">
          <div class="demo-ev-head">
            <span>Why (Provenance)</span>
            <span class="chip ${d.whySource === "missing" ? "chip-red" : "chip-green"}">source: ${d.whySource}</span>
          </div>
          <div class="demo-ev-text">${d.why}</div>
        </div>
      </div>
      <div class="demo-diff">
        ${d.rows
          .map(
            (r) =>
              `<div class="d-row ${r.kind}${highlightedLines.includes(r.n) ? " hl" : ""}"><span class="d-num">${r.n}</span><span>${r.t.replace(/</g, "&lt;")}</span></div>`,
          )
          .join("")}
      </div>
      <div class="demo-proof"><strong>Glass-Box Evidence:</strong> ${d.proof}</div>
    `;
  }

  document.getElementById("demo-tabs")?.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-demo]");
    if (!btn) return;
    activeDemo = Number(btn.getAttribute("data-demo"));
    revealed = false;
    highlightedLines = [];
    document.querySelectorAll(".demo-tab").forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");
    renderDemo();
  });

  document.getElementById("demo-selfcheck")?.addEventListener("click", (ev) => {
    selfCheck = !selfCheck;
    revealed = false;
    ev.target.textContent = "Self-Check: " + (selfCheck ? "On" : "Off");
    ev.target.classList.toggle("active", selfCheck);
    renderDemo();
  });

  demoBody?.addEventListener("click", (ev) => {
    if (ev.target.closest("#demo-reveal-btn")) {
      revealed = true;
      renderDemo();
      return;
    }
    if (ev.target.closest("#demo-cite-btn")) {
      highlightedLines = DEMOS[activeDemo].cite.lines;
      renderDemo();
    }
  });

  renderDemo();

  // 5. Copy buttons
  document.querySelectorAll(".copy-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const txt = btn.getAttribute("data-copy") || "";
      navigator.clipboard?.writeText(txt).then(() => {
        const orig = btn.textContent;
        btn.textContent = "Copied ✓";
        setTimeout(() => (btn.textContent = orig), 1500);
      });
    });
  });
})();
