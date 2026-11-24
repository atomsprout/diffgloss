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

  // 2b. Desktop Repo Drop + SSE Streaming Simulator
  const simBtn = document.getElementById("sim-drop-btn");
  const dropSim = document.getElementById("drop-sim");
  const dropProgress = document.getElementById("drop-progress");
  const dropTitle = document.getElementById("drop-sim-title");
  const dropSub = document.getElementById("drop-sim-sub");
  const dropLabel = document.getElementById("drop-stage-label");
  const dropPct = document.getElementById("drop-stage-pct");
  const dropFill = document.getElementById("drop-prog-fill");
  const dropEvents = document.getElementById("drop-events");
  let simTimers = [];

  simBtn?.addEventListener("click", () => {
    simTimers.forEach((t) => clearTimeout(t));
    simTimers = [];
    if (!dropSim || !dropProgress || !dropFill || !dropEvents) return;

    dropSim.classList.add("active");
    dropProgress.hidden = false;
    dropTitle.textContent = "Dropped: ~/workspace/payment-gateway (HEAD: 8f31c2a)";
    dropSub.innerHTML = "AST parsed <strong>6 hunks</strong> in 42ms · 2 cache hits · streaming SSE dual-role verification...";
    dropEvents.innerHTML = "";
    dropFill.style.width = "10%";
    dropLabel.textContent = "Stage 1/3 · AST Split & Hunk Cache";
    dropPct.textContent = "15%";
    simBtn.disabled = true;
    simBtn.textContent = "Streaming SSE...";

    const steps = [
      {
        ms: 350,
        pct: 38,
        label: "Stage 1/3 · Role A Explaining via codex-cli (read-only)",
        line: '<span class="ev-ok">✓ Role A [codex-cli]: explained 4/4 substantive hunks (2 loaded from disk cache)</span>',
      },
      {
        ms: 950,
        pct: 72,
        label: "Stage 2/3 · Role B Line Auditor checking 39 +/- diff lines",
        line: '<span class="ev-warn">⚠ Role B [independent]: omission_detected on src/billing/retry.ts line 44 (timeout increased 3s → 30s)</span>',
      },
      {
        ms: 1550,
        pct: 100,
        label: "Stage 3/3 · Complete — 4 explained, 1 collapsed, 1 flagged",
        line: '<span class="ev-ok">✓ Ledger ready: 100% coverage invariant · amber line highlight pinned for review</span>',
        done: true,
      },
    ];

    steps.forEach((s) => {
      const id = setTimeout(() => {
        dropFill.style.width = s.pct + "%";
        dropLabel.textContent = s.label;
        dropPct.textContent = s.pct + "%";
        dropEvents.insertAdjacentHTML("beforeend", "<div>" + s.line + "</div>");
        if (s.done) {
          dropSim.classList.remove("active");
          simBtn.disabled = false;
          simBtn.textContent = "↻ Replay Repo Drop Simulation";
        }
      }, s.ms);
      simTimers.push(id);
    });
  });

  // 3. Interactive 5-Stage Pipeline Explorer
  const STAGES = [
    {
      title: "01 · Deterministic Ingestion, AST Splitting & Hunk Cache (<1s)",
      desc: "Before spending a single LLM token, Diffgloss parses the unified diff, strips secrets & binaries, splits oversized hunks along real function scopes, collapses mechanical noise, and checks content-addressed disk cache.",
      bullets: [
        "Content-hash hunk_id + .diffgloss/cache/<hash>.json for zero-cost repeat reviews",
        "Lexer-aware AST scope splitter (TS, JS, Python, Go, Rust, Java, C++)",
        "Skips .env*, *.pem, *.key and collapses lockfiles/whitespace/renames",
        "Flags weakened test assertions, removed safety guards, and silent catch blocks",
      ],
      code: `// Coverage invariant enforced on every hunk\ncoverage.total === explained + collapsed + unexplained\n\n// Content-addressed hunk cache key\nsha256(hunk_id + patch + intent + explainer + model)`,
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
      title: "03 · Role A Explanation (Author Coding Agent or API Model A)",
      desc: "By default, Diffgloss asks the authoring coding agent (Codex CLI or Claude Code CLI, strictly read-only & fork-safe) to explain its own changes—or switches in 1 click to an independent API Model A.",
      bullets: [
        "Auto-detects installed `codex` and `claude` CLIs with seamless fallback to API Model A",
        "Mechanical file:line and verbatim backticked-symbol citation check + 1x repair",
        "Hard USD budget guard + pre-run --dry-run cost estimation",
        "Supports DeepSeek, Anthropic, OpenAI, Gemini, OpenRouter, Ollama, Qwen, Kimi & GLM",
      ],
      code: `"explainer_meta": {\n  "mode": "author_cli",\n  "adapter": "codex-cli",\n  "cached": false\n}`,
    },
    {
      title: "04 · Role B Independent Line Auditor & Symmetric Proof",
      desc: "A cold-start Reviewer (never sharing Role A's thread) verifies EVERY +/- diff line against the explanation, catching silent omissions and contradictions—alongside isolated bug specialists.",
      bullets: [
        "Line-by-line audit verdicts: verified | omission_detected | contradicted",
        "Omitted lines highlighted directly in amber inside the unified diff viewer",
        "Contradicted explanations automatically demote to 'unexplained' with critical finding",
        "Symmetric Proof specialists emit both verified bugs and proven Ruled-Out Concerns",
      ],
      code: `"audit": {\n  "status": "omission_detected",\n  "auditor_model": "deepseek-chat",\n  "covered_lines": [41, 42],\n  "omitted_lines": [44],\n  "note": "Explanation omitted retry timeout increase from 3s to 30s."\n}`,
    },
    {
      title: "05 · Native Desktop App (Tauri v2), SSE Streaming & CI Surfaces",
      desc: "Drop any local Git repository onto Diffgloss.app on macOS or Windows—powered by an embedded diffgloss-engine sidecar streaming SSE progress—or export to GitHub PR, SARIF, rdjsonl, and MCP.",
      bullets: [
        "Native macOS (.dmg arm64/Intel) & Windows (.exe/.msi) via Tauri v2 + Bun sidecar",
        "POST /api/explain-stream streams Explain -> Line Audit -> Review live",
        "In-page ⚙ Models modal with Role A/B toggle & detected CLI status badges",
        "Native MCP stdio server, SARIF 2.1.0 & GitHub PR sticky comment reconciliation",
      ],
      code: `open Diffgloss.app               # Drag & drop any local Git repo\nnode dist/cli.js ui              # Zero-env-var browser workbench\nnode dist/cli.js mcp             # MCP JSON-RPC 2.0 stdio server`,
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

  // 4. Interactive Mini-Ledger Demo (with Role A explainer_meta & Role B Line Audit)
  const DEMOS = [
    {
      path: "src/billing/retry.ts",
      symbol: "fetchInvoiceWithRetry",
      status: "explained",
      risk: "high",
      explainerLabel: "Role A: codex-cli",
      auditStatus: "omission_detected",
      auditLabel: "audit: omission_detected (L44)",
      what: "Adds exponential backoff jitter to `fetchInvoiceWithRetry` on HTTP 503 responses.",
      cite: { label: "src/billing/retry.ts:41-42 (new)", lines: [41, 42] },
      citeValid: true,
      semantic: "judge_passed",
      whySource: "transcript",
      why: "Author agent explained retry jitter for transient 503s, but omitted the 10x request timeout increase on line 44.",
      proof: "Role-B Line Auditor (cold-start): checked 3 changed lines — lines 41–42 verified, line 44 OMITTED (`timeoutMs: 30_000` raised from `3_000`). Highlighted in amber below.",
      omittedLines: [44],
      rows: [
        { n: 40, kind: "ctx", t: " export async function fetchInvoiceWithRetry(id: string) {" },
        { n: 41, kind: "add", t: "+  const jitterMs = Math.floor(Math.random() * 250);" },
        { n: 42, kind: "add", t: "+  const delayMs = BASE_DELAY_MS * attempt + jitterMs;" },
        { n: 43, kind: "del", t: "-  return httpGet(`/invoices/${id}`, { timeoutMs: 3_000 });" },
        { n: 44, kind: "add", t: "+  return httpGet(`/invoices/${id}`, { timeoutMs: 30_000 });" },
        { n: 45, kind: "ctx", t: " }" },
      ],
    },
    {
      path: "src/auth/session.ts",
      symbol: "verifySession",
      status: "unexplained",
      risk: "high",
      explainerLabel: "Role A: claude-cli",
      auditStatus: "contradicted",
      auditLabel: "audit: contradicted ✗",
      what: "Deletes the `session.revokedAt !== null` check in `verifySession`, leaving only expiration timestamp validation.",
      cite: { label: "src/auth/session.ts:31-33 (old)", lines: [31, 32, 33] },
      citeValid: true,
      semantic: "judge_failed",
      whySource: "missing",
      why: "Author claimed revocation is enforced in gateway middleware. Role-B Auditor contradicted the claim and demoted this hunk to `unexplained`.",
      proof: "Role-B Line Auditor + Cold Verifier: CONTRADICTED — `revokedAt` is never checked in gateway middleware. Finding attached: `diffgloss/audit-contradiction`.",
      omittedLines: [31, 32, 33],
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
      explainerLabel: "Role A: deepseek-chat",
      auditStatus: "verified",
      auditLabel: "audit: verified ✓ (2/2 lines)",
      what: "Builds a raw SQL `query` by concatenating `email` directly into a SELECT clause and returns `db.query(query)`.",
      cite: { label: "src/db/users.ts:19-20 (new)", lines: [19, 20] },
      citeValid: true,
      semantic: "judge_passed",
      whySource: "declared_intent",
      why: "Matches declared intent to add lookupUserByEmail helper, while isolated security specialist flagged SQL injection.",
      proof: "Symmetric Proof: [Verified Finding bug/security] SQL injection via string concatenation · [Ruled-Out ro_1] Checked touchSession vs verifySession boundary (<= vs >), proven consistent.",
      omittedLines: [],
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
      explainerLabel: "Role A: codex-cli",
      auditStatus: "verified",
      auditLabel: "audit: verified ✓ (2/2 lines)",
      what: "Removes the `rejects.toThrow('Invalid signature')` assertion and leaves a trivial `expect(true).toBe(true)` placeholder.",
      cite: { label: "tests/billing.test.ts:9-10 (old/new)", lines: [9, 10] },
      citeValid: true,
      semantic: "judge_passed",
      whySource: "missing",
      why: "No evidence justifies weakening signature verification tests; front-loaded to Group 1 before production webhook edits.",
      proof: "Built-in Integrity Rules Fired: diffgloss/test-assertion-weakened + diffgloss/silent-error-swallow in src/billing/webhook.ts.",
      omittedLines: [],
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
    const auditChipCls =
      d.auditStatus === "verified"
        ? "chip-green"
        : d.auditStatus === "omission_detected"
          ? "chip-amber"
          : "chip-red";

    demoBody.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:8px;flex-wrap:wrap">
        <div class="mono" style="font-size:13px"><strong>${d.path}</strong> <span style="color:var(--muted)">· ${d.symbol}</span></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <span class="chip chip-slate">${d.explainerLabel}</span>
          <span class="chip ${auditChipCls}">${d.auditLabel}</span>
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
              <span class="chip ${d.semantic === "judge_failed" ? "chip-red" : "chip-cyan"}">${d.semantic}</span>
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
          .map((r) => {
            const isOmitted = (d.omittedLines || []).includes(r.n);
            const isHl = highlightedLines.includes(r.n);
            return `<div class="d-row ${r.kind}${isHl ? " hl" : ""}${isOmitted ? " omitted" : ""}"><span class="d-num">${r.n}</span><span>${r.t.replace(/</g, "&lt;")}</span>${isOmitted ? '<span class="d-omitted-tag">⚠ OMITTED BY AUTHOR</span>' : ""}</div>`;
          })
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
