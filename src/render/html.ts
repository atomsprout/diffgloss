import type { ExplanationLedger } from "../schema/types.ts";

export interface RenderHtmlOptions {
  liveServer?: boolean;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeJsonForScript(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function renderHtmlReport(
  ledger: ExplanationLedger,
  options: RenderHtmlOptions = {},
): string {
  const title = escapeHtml(ledger.overview.title || "Diffgloss Review Ledger");
  const embeddedJson = safeJsonForScript(ledger);
  const isLiveServer = Boolean(options.liveServer);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} — Diffgloss</title>
  <style>
    :root {
      --bg: #0f0f10;
      --bg-elev: #18181b;
      --bg-card: #141416;
      --border: #2c2c31;
      --text: #f4f4f5;
      --muted: #a1a1aa;
      --accent: #d97706;
      --accent-soft: rgba(217, 119, 6, 0.16);
      --green: #22c55e;
      --green-bg: rgba(34, 197, 94, 0.14);
      --amber: #f59e0b;
      --amber-bg: rgba(245, 158, 11, 0.16);
      --red: #ef4444;
      --red-bg: rgba(239, 68, 68, 0.15);
      --purple: #14b8a6;
      --purple-bg: rgba(20, 184, 166, 0.14);
      --slate: #a8a29e;
      --slate-bg: rgba(168, 162, 158, 0.14);
      --diff-add-bg: rgba(34, 197, 94, 0.14);
      --diff-add-num: rgba(34, 197, 94, 0.22);
      --diff-del-bg: rgba(239, 68, 68, 0.16);
      --diff-del-num: rgba(239, 68, 68, 0.24);
      --diff-hl-bg: rgba(245, 158, 11, 0.24);
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    [data-theme="light"] {
      --bg: #faf8f4;
      --bg-elev: #ffffff;
      --bg-card: #f5f2eb;
      --border: #e5dfd3;
      --text: #1c1917;
      --muted: #57534e;
      --accent: #c2410c;
      --accent-soft: rgba(194, 65, 12, 0.12);
      --green: #15803d;
      --green-bg: rgba(21, 128, 61, 0.11);
      --amber: #b45309;
      --amber-bg: rgba(180, 83, 9, 0.13);
      --red: #b91c1c;
      --red-bg: rgba(185, 28, 28, 0.1);
      --purple: #0f766e;
      --purple-bg: rgba(15, 118, 110, 0.11);
      --slate: #57534e;
      --slate-bg: rgba(87, 83, 78, 0.1);
      --diff-add-bg: #dcfce7;
      --diff-add-num: #bbf7d0;
      --diff-del-bg: #fee2e2;
      --diff-del-num: #fecaca;
      --diff-hl-bg: rgba(217, 119, 6, 0.2);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--font-sans);
      font-size: 14px;
      line-height: 1.5;
    }
    header {
      position: sticky;
      top: 0;
      z-index: 20;
      background: var(--bg-elev);
      border-bottom: 1px solid var(--border);
      padding: 12px 20px;
    }
    .header-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .brand { display: flex; align-items: center; gap: 10px; }
    .brand-tag {
      font-family: var(--font-mono);
      font-weight: 700;
      font-size: 13px;
      padding: 2px 8px;
      border-radius: 6px;
      background: var(--accent);
      color: #fff;
    }
    .brand h1 { margin: 0; font-size: 16px; font-weight: 600; }
    .header-controls {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .search-input, .select-input {
      background: var(--bg-card);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 4px 9px;
      font-size: 12px;
      outline: none;
    }
    .search-input { min-width: 195px; }
    .search-input:focus, .select-input:focus { border-color: var(--accent); }
    .btn {
      background: var(--bg-card);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 4px 9px;
      font-size: 12px;
      cursor: pointer;
    }
    .btn:hover { border-color: var(--accent); }
    .btn.active {
      border-color: var(--accent);
      background: var(--accent-soft);
      color: var(--accent);
    }
    .coverage-bar {
      display: flex;
      height: 6px;
      border-radius: 99px;
      overflow: hidden;
      background: var(--border);
      margin-top: 10px;
    }
    .cov-explained { background: var(--green); }
    .cov-collapsed { background: var(--slate); }
    .cov-unexplained { background: var(--red); }
    .overview-strip {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
      flex-wrap: wrap;
    }
    .layout {
      display: grid;
      grid-template-columns: 300px 1fr;
      min-height: calc(100vh - 110px);
    }
    @media (max-width: 960px) {
      .layout { grid-template-columns: 1fr; }
      aside { position: static; height: auto; border-right: none; border-bottom: 1px solid var(--border); }
    }
    aside {
      border-right: 1px solid var(--border);
      background: var(--bg-elev);
      padding: 14px;
      position: sticky;
      top: 108px;
      height: calc(100vh - 108px);
      overflow-y: auto;
    }
    aside h2 {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      margin: 14px 0 8px;
    }
    aside h2:first-child { margin-top: 0; }
    .nav-item {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 6px;
      cursor: pointer;
      border: 1px solid transparent;
      margin-bottom: 4px;
      text-decoration: none;
      color: var(--text);
    }
    .nav-item:hover { background: var(--bg-card); border-color: var(--border); }
    .nav-item.understood { opacity: 0.6; }
    .nav-title { font-size: 13px; font-weight: 500; }
    .nav-meta { font-size: 11px; color: var(--muted); margin-top: 2px; }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-top: 6px;
      flex-shrink: 0;
    }
    .dot-high { background: var(--red); }
    .dot-medium { background: var(--amber); }
    .dot-low { background: var(--slate); }
    main {
      padding: 20px 24px 80px;
      max-width: 1320px;
      width: 100%;
    }
    .intent-banner {
      background: var(--bg-elev);
      border: 1px solid var(--border);
      border-left: 3px solid var(--accent);
      border-radius: 8px;
      padding: 12px 14px;
      margin-bottom: 14px;
    }
    .skipped-banner {
      background: var(--amber-bg);
      border: 1px solid var(--amber);
      border-radius: 8px;
      padding: 10px 14px;
      margin-bottom: 14px;
      font-size: 12px;
    }
    .group-card {
      background: var(--bg-elev);
      border: 1px solid var(--border);
      border-radius: 10px;
      margin-bottom: 20px;
      overflow: hidden;
    }
    .group-header {
      padding: 14px 16px;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      border-bottom: 1px solid var(--border);
    }
    .group-title { margin: 0 0 4px; font-size: 15px; }
    .group-intent { margin: 0; color: var(--muted); font-size: 13px; }
    .group-rationale { margin: 4px 0 0; color: var(--muted); font-size: 12px; font-style: italic; }
    .group-body { padding: 14px 16px; }
    .group-body.collapsed { display: none; }
    .hunk-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 8px;
      margin-bottom: 14px;
      overflow: hidden;
      transition: box-shadow 0.15s;
    }
    .hunk-card:last-child { margin-bottom: 0; }
    .hunk-card.focused { box-shadow: 0 0 0 2px var(--accent); }
    .hunk-card.status-unexplained { border-left: 3px solid var(--red); }
    .hunk-card.status-explained { border-left: 3px solid var(--green); }
    .hunk-card.status-collapsed { border-left: 3px solid var(--slate); }
    .hunk-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      background: var(--bg-elev);
      border-bottom: 1px solid var(--border);
      flex-wrap: wrap;
    }
    .hunk-path { font-family: var(--font-mono); font-size: 12px; font-weight: 600; }
    .hunk-symbol { font-family: var(--font-mono); font-size: 11px; color: var(--muted); margin-left: 6px; }
    .badges { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .badge {
      font-size: 11px;
      font-family: var(--font-mono);
      padding: 1px 7px;
      border-radius: 99px;
      border: 1px solid transparent;
    }
    .b-green { background: var(--green-bg); color: var(--green); border-color: rgba(63, 185, 80, 0.35); }
    .b-red { background: var(--red-bg); color: var(--red); border-color: rgba(248, 81, 73, 0.35); }
    .b-amber { background: var(--amber-bg); color: var(--amber); border-color: rgba(210, 153, 34, 0.35); }
    .b-purple { background: var(--purple-bg); color: var(--purple); border-color: rgba(20, 184, 166, 0.38); }
    .b-slate { background: var(--slate-bg); color: var(--slate); border-color: var(--border); }
    .evidence-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      padding: 12px;
      border-bottom: 1px solid var(--border);
    }
    @media (max-width: 760px) { .evidence-grid { grid-template-columns: 1fr; } }
    .ev-box {
      background: var(--bg-elev);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px 12px;
    }
    .ev-label {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--muted);
      margin-bottom: 6px;
      flex-wrap: wrap;
    }
    .ev-text { margin: 0; font-size: 13px; }
    .ev-masked {
      padding: 8px;
      border-radius: 6px;
      border: 1px dashed var(--border);
      color: var(--muted);
      font-size: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }
    .citations { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
    .cite-chip {
      font-family: var(--font-mono);
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 5px;
      border: 1px solid var(--border);
      background: var(--bg-card);
      color: var(--accent);
      cursor: pointer;
    }
    .cite-chip:hover { border-color: var(--accent); }
    .finding-box {
      margin: 0 12px 10px;
      padding: 8px 12px;
      border-radius: 6px;
      background: var(--purple-bg);
      border: 1px solid rgba(188, 140, 255, 0.4);
      font-size: 12px;
    }
    .question-box {
      margin: 0 12px 12px;
      padding: 10px 12px;
      border-radius: 6px;
      background: var(--red-bg);
      border: 1px solid rgba(248, 81, 73, 0.4);
      font-size: 12px;
    }
    .question-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
      flex-wrap: wrap;
    }
    .answer-box {
      margin-top: 8px;
      padding: 8px 10px;
      border-radius: 5px;
      background: var(--bg-elev);
      border: 1px solid var(--border);
    }
    .answer-form {
      display: flex;
      gap: 6px;
      margin-top: 8px;
    }
    .answer-form input {
      flex: 1;
      background: var(--bg-card);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 5px 8px;
      font-size: 12px;
    }
    .diff-table {
      width: 100%;
      border-collapse: collapse;
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 1.45;
      overflow-x: auto;
      display: block;
    }
    .diff-table tbody { display: table; width: 100%; }
    .diff-line td { padding: 0 8px; vertical-align: top; }
    .diff-num {
      width: 44px;
      min-width: 44px;
      text-align: right;
      color: var(--muted);
      user-select: none;
      border-right: 1px solid var(--border);
    }
    .diff-code { width: 100%; white-space: pre-wrap; word-break: break-word; }
    .diff-split-code { width: 50%; white-space: pre-wrap; word-break: break-word; border-right: 1px solid var(--border); }
    .diff-split-code:last-child { border-right: none; }
    .line-add { background: var(--diff-add-bg); }
    .line-add .diff-num { background: var(--diff-add-num); }
    .line-del { background: var(--diff-del-bg); }
    .line-del .diff-num { background: var(--diff-del-num); }
    .line-hdr { color: var(--muted); background: var(--bg-elev); }
    .line-highlight { background: var(--diff-hl-bg) !important; outline: 1px solid var(--accent); }
    .line-omitted { background: rgba(210, 153, 34, 0.24) !important; box-shadow: inset 3px 0 0 var(--amber); }
    .stream-banner {
      display: none;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 14px;
      margin-top: 8px;
      border-radius: 8px;
      background: rgba(88, 166, 255, 0.12);
      border: 1px solid rgba(88, 166, 255, 0.35);
      font-size: 12px;
    }
    .stream-banner.active { display: flex; }
    .drop-overlay {
      position: fixed;
      inset: 0;
      z-index: 90;
      background: rgba(15, 15, 16, 0.88);
      border: 3px dashed var(--accent);
      display: none;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 10px;
      font-size: 18px;
      font-weight: 600;
      color: var(--text);
      pointer-events: none;
    }
    .drop-overlay.active { display: flex; }
    .empty-state {
      text-align: center;
      padding: 48px 20px;
      color: var(--muted);
      border: 1px dashed var(--border);
      border-radius: 10px;
    }
    .kbd-hint { font-family: var(--font-mono); font-size: 11px; color: var(--muted); }
    .modal-backdrop {
      position: fixed;
      inset: 0;
      z-index: 50;
      background: rgba(0, 0, 0, 0.58);
      display: none;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    .modal-backdrop.open { display: flex; }
    .modal-panel {
      background: var(--bg-elev);
      border: 1px solid var(--border);
      border-radius: 12px;
      width: 100%;
      max-width: 620px;
      max-height: 90vh;
      overflow-y: auto;
      padding: 18px 20px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.45);
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }
    .modal-header h2 { margin: 0; font-size: 16px; }
    .form-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-bottom: 10px;
    }
    @media (max-width: 640px) { .form-grid { grid-template-columns: 1fr; } }
    .field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
    .field label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
    .field input, .field select, .field textarea {
      background: var(--bg-card);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 7px 9px;
      font-size: 13px;
      font-family: var(--font-sans);
    }
    .field textarea { resize: vertical; min-height: 58px; }
    .preset-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
    .preset-chip {
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 99px;
      border: 1px solid var(--border);
      background: var(--bg-card);
      color: var(--text);
      cursor: pointer;
    }
    .preset-chip.active, .preset-chip:hover { border-color: var(--accent); color: var(--accent); }
    .model-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 4px; }
    .modal-actions {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      margin-top: 14px;
      flex-wrap: wrap;
    }
    .btn-primary {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
      font-weight: 600;
    }
    .btn-primary:hover { opacity: 0.92; }
    .status-msg {
      margin-top: 10px;
      padding: 8px 10px;
      border-radius: 6px;
      font-size: 12px;
      display: none;
    }
    .status-msg.ok { display: block; background: var(--green-bg); color: var(--green); border: 1px solid rgba(63,185,80,0.4); }
    .status-msg.err { display: block; background: var(--red-bg); color: var(--red); border: 1px solid rgba(248,81,73,0.4); }
    .status-msg.info { display: block; background: var(--slate-bg); color: var(--text); border: 1px solid var(--border); }
    .check-row { display: flex; gap: 16px; flex-wrap: wrap; margin: 6px 0 10px; font-size: 12px; }
    .check-row label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
    .commit-list {
      max-height: 300px;
      overflow-y: auto;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-card);
    }
    .commit-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      width: 100%;
      text-align: left;
      background: transparent;
      color: var(--text);
      border: none;
      border-bottom: 1px solid var(--border);
      padding: 9px 12px;
      cursor: pointer;
      font-size: 13px;
    }
    .commit-row:last-child { border-bottom: none; }
    .commit-row:hover { background: var(--accent-soft); }
    .commit-sha {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--accent);
      background: var(--accent-soft);
      padding: 2px 6px;
      border-radius: 4px;
      flex-shrink: 0;
    }
    .commit-subj { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .commit-meta { font-size: 11px; color: var(--muted); flex-shrink: 0; }
    .quick-diff-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
  </style>
</head>
<body>
  <header>
    <div class="header-top">
      <div class="brand">
        <span class="brand-tag">diffgloss</span>
        <h1 id="report-title">${title}</h1>
      </div>
      <div class="header-controls">
        <input type="search" id="search-box" class="search-input" placeholder="Search path/symbol (/)" />
        <select id="risk-filter" class="select-input">
          <option value="all">All risks</option>
          <option value="high">High risk</option>
          <option value="medium">Medium risk</option>
          <option value="low">Low risk</option>
        </select>
        <button class="btn active" data-filter="all">All (<span id="cnt-all">0</span>)</button>
        <button class="btn" data-filter="unexplained">Unexplained (<span id="cnt-unexplained">0</span>)</button>
        <button class="btn" data-filter="explained">Explained (<span id="cnt-explained">0</span>)</button>
        <button class="btn" data-filter="collapsed">Collapsed (<span id="cnt-collapsed">0</span>)</button>
        <button class="btn" id="split-toggle" title="Toggle Unified / Side-by-Side (s)">Unified</button>
        <button class="btn" id="self-check-toggle" title="Hide explanations on high-risk hunks until revealed">Self-Check: Off</button>
        <span class="badge b-slate" id="understood-counter">Understood 0/0</span>
        <button class="btn" id="repo-picker-btn" title="Switch local git repository, working tree diff, branch range, or any commit">📂 Repo / Commit</button>
        <button class="btn btn-primary" id="quick-explain-btn" title="Stream Role A Explanation + Role B Independent Line Audit">▶ Explain &amp; Audit</button>
        <button class="btn" id="settings-btn" title="Configure any LLM provider, API key & re-run in page">⚙ Models</button>
        <button class="btn" id="download-json-btn">Export JSON</button>
        <button class="btn" id="theme-toggle">Theme</button>
      </div>
    </div>
    <div class="coverage-bar" id="coverage-bar"></div>
    <div class="overview-strip">
      <span id="behavior-change"></span>
      <span id="meta-info"></span>
    </div>
    <div class="stream-banner" id="stream-banner">
      <span id="stream-msg">Running Diffgloss pipeline...</span>
      <span class="badge b-amber" id="stream-step">0/0</span>
    </div>
  </header>
  <div class="drop-overlay" id="drop-overlay">
    <div>📂 Drop Git Repository Folder to Review</div>
    <div style="font-size:13px;color:var(--muted)">Instant AST diff + Dual-Model Audit</div>
  </div>

  <div class="layout">
    <aside id="sidebar"></aside>
    <main id="main"></main>
  </div>

  <div class="modal-backdrop" id="repo-modal">
    <div class="modal-panel" role="dialog" aria-label="Repository and Commit Picker" style="max-width:720px">
      <div class="modal-header">
        <h2>📂 Select Repository, Diff or Commit</h2>
        <button class="btn" id="repo-close">Close</button>
      </div>
      <div id="repo-static-note" class="status-msg info" style="margin-bottom:10px"></div>
      <div id="repo-live-body">
        <div class="field">
          <label for="repo-path-input">Local Git Repository Path</label>
          <div style="display:flex;gap:8px">
            <input id="repo-path-input" type="text" style="flex:1" placeholder="/path/to/your/git/repo" />
            <button class="btn" id="repo-load-btn">Load Repo</button>
          </div>
        </div>
        <div class="field" id="repo-chips-wrap">
          <label>Recent &amp; Nearby Git Repositories</label>
          <div class="preset-chips" id="repo-chips"></div>
        </div>
        <div class="field">
          <label>Current Diff Views <span id="repo-branch-badge" style="text-transform:none"></span></label>
          <div class="quick-diff-row">
            <button class="btn" id="load-working-btn">Working Tree</button>
            <button class="btn" id="load-staged-btn">Staged Changes</button>
            <input id="range-input" class="search-input" type="text" placeholder="e.g. main..HEAD or HEAD~3..HEAD" style="min-width:210px" />
            <button class="btn" id="load-range-btn">Load Range</button>
          </div>
        </div>
        <div class="field">
          <label for="commit-filter-input">Or Click Any Commit (auto-loads diff + commit message as intent)</label>
          <input id="commit-filter-input" type="search" placeholder="Filter commits by SHA or message..." style="margin-bottom:6px" />
          <div class="commit-list" id="commit-list"></div>
        </div>
        <div id="repo-status" class="status-msg"></div>
      </div>
    </div>
  </div>

  <div class="modal-backdrop" id="settings-modal">
    <div class="modal-panel" role="dialog" aria-label="Model Settings">
      <div class="modal-header">
        <h2>⚙ Models &amp; In-Page Configuration</h2>
        <button class="btn" id="settings-close">Close</button>
      </div>
      <div id="settings-static-note" class="status-msg info" style="margin-bottom:10px"></div>
      <div id="settings-live-body">
        <div class="field">
          <label>Role A — Explainer Mode (Who Explains the Diff)</label>
          <div class="form-grid" style="margin-bottom:4px">
            <select id="cfg-explainer-mode">
              <option value="author_cli">Author Coding Agent CLI (Codex / Claude Code — Default)</option>
              <option value="api_model">Independent Explainer Model A (API)</option>
            </select>
            <select id="cfg-author-cli">
              <option value="auto">Auto-detect (Codex / Claude Code)</option>
              <option value="codex-cli">Codex CLI (codex exec -s read-only)</option>
              <option value="claude-cli">Claude Code CLI (claude -p --permission-mode plan)</option>
            </select>
          </div>
          <div id="detected-clis" class="badges" style="margin-top:4px"></div>
        </div>
        <div class="field">
          <label>Quick Provider Presets (Model A / Reviewer Model B)</label>
          <div class="preset-chips" id="preset-chips"></div>
        </div>
        <div class="form-grid">
          <div class="field">
            <label for="cfg-provider">Protocol Dialect</label>
            <select id="cfg-provider">
              <option value="deepseek">deepseek</option>
              <option value="openai-chat">openai-chat (OpenAI-Compatible)</option>
              <option value="openai">openai (Responses API)</option>
              <option value="anthropic">anthropic (Messages + Cache)</option>
              <option value="google">google (Gemini)</option>
              <option value="mock">mock (Offline)</option>
            </select>
          </div>
          <div class="field">
            <label for="cfg-model">Model Name (any model ID)</label>
            <input id="cfg-model" type="text" placeholder="e.g. deepseek-chat, gpt-5.1, claude-sonnet-4-5" />
            <div class="model-chips" id="model-chips"></div>
          </div>
        </div>
        <div class="field">
          <label for="cfg-base-url">Base URL</label>
          <input id="cfg-base-url" type="text" placeholder="https://api.deepseek.com/v1" />
        </div>
        <div class="field">
          <label for="cfg-api-key">API Key <span id="cfg-key-status" style="text-transform:none"></span></label>
          <input id="cfg-api-key" type="password" autocomplete="off" placeholder="Paste API key (saved locally to ~/.config/diffgloss/settings.json, chmod 600)" />
        </div>
        <div class="form-grid">
          <div class="field">
            <label for="cfg-budget">Budget Cap ($ USD)</label>
            <input id="cfg-budget" type="number" step="0.1" min="0" value="1.5" />
          </div>
          <div class="field">
            <label for="cfg-effort">Effort Level</label>
            <select id="cfg-effort">
              <option value="quick">quick</option>
              <option value="standard">standard</option>
              <option value="deep">deep</option>
            </select>
          </div>
        </div>
        <div class="check-row">
          <label><input type="checkbox" id="cfg-enable-line-audit" checked /> Role B: Line-by-Line Audit (verify every changed line)</label>
          <label><input type="checkbox" id="cfg-enable-review" checked /> Isolated Symmetric-Proof Bug Review</label>
          <label><input type="checkbox" id="cfg-enable-judge" /> Legacy Semantic Judge</label>
        </div>
        <div class="field">
          <label for="cfg-intent">Declared Intent (Prompt / Plan / PR Description)</label>
          <textarea id="cfg-intent" placeholder="Describe what this diff is supposed to achieve..."></textarea>
        </div>
        <details style="margin-bottom:8px">
          <summary style="cursor:pointer;font-size:12px;color:var(--muted)">Optional: Cross-Model Judge / Verifier (different vendor)</summary>
          <div class="form-grid" style="margin-top:8px">
            <div class="field">
              <label for="cfg-judge-provider">Judge Dialect</label>
              <select id="cfg-judge-provider">
                <option value="">(Same as primary)</option>
                <option value="anthropic">anthropic</option>
                <option value="openai">openai</option>
                <option value="openai-chat">openai-chat</option>
                <option value="deepseek">deepseek</option>
                <option value="google">google</option>
              </select>
            </div>
            <div class="field">
              <label for="cfg-judge-model">Judge Model</label>
              <input id="cfg-judge-model" type="text" placeholder="e.g. claude-sonnet-4-5" />
            </div>
          </div>
          <div class="form-grid">
            <div class="field">
              <label for="cfg-judge-base-url">Judge Base URL</label>
              <input id="cfg-judge-base-url" type="text" placeholder="optional custom endpoint" />
            </div>
            <div class="field">
              <label for="cfg-judge-api-key">Judge API Key <span id="cfg-judge-key-status" style="text-transform:none"></span></label>
              <input id="cfg-judge-api-key" type="password" autocomplete="off" placeholder="leave blank to reuse primary" />
            </div>
          </div>
        </details>
        <div class="modal-actions">
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn" id="cfg-test-btn">Test Connection</button>
            <button class="btn" id="cfg-save-btn">Save Settings</button>
          </div>
          <button class="btn btn-primary" id="cfg-run-btn">▶ Run Explain Now</button>
        </div>
        <div id="cfg-status" class="status-msg"></div>
      </div>
    </div>
  </div>

  <script id="diffgloss-data" type="application/json">${embeddedJson}</script>
  <script>
    (function () {
      const LIVE_SERVER = ${isLiveServer ? "true" : "false"};
      let ledger = JSON.parse(document.getElementById("diffgloss-data").textContent);
      const storageKey = "diffgloss.understood." + (ledger.source?.repo || "local") + "." + ledger.coverage.total;

      let activeFilter = "all";
      let riskFilter = "all";
      let searchQuery = "";
      let splitView = false;
      let selfCheckMode = false;
      let ruledOutExpanded = false;
      let focusedHunkIdx = -1;
      const revealedHunks = new Set();
      const understoodGroups = new Set(JSON.parse(localStorage.getItem(storageKey) || "[]"));

      function esc(str) {
        return String(str ?? "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
      }

      function saveUnderstood() {
        localStorage.setItem(storageKey, JSON.stringify([...understoodGroups]));
        updateUnderstoodCounter();
      }

      function updateUnderstoodCounter() {
        document.getElementById("understood-counter").textContent =
          "Understood " + understoodGroups.size + "/" + ledger.groups.length;
      }

      function renderHeader() {
        const c = ledger.coverage;
        document.getElementById("report-title").textContent = ledger.overview.title || "Diffgloss Review Ledger";
        document.title = (ledger.overview.title || "Diffgloss Review Ledger") + " — Diffgloss";
        document.getElementById("cnt-all").textContent = c.total;
        document.getElementById("cnt-unexplained").textContent = c.unexplained;
        document.getElementById("cnt-explained").textContent = c.explained;
        document.getElementById("cnt-collapsed").textContent = c.collapsed;
        document.getElementById("behavior-change").textContent = ledger.overview.behavior_change || "";

        const metaParts = [];
        if (ledger.source?.repo) metaParts.push(ledger.source.repo);
        if (ledger.cost) {
          metaParts.push(ledger.cost.provider + "/" + ledger.cost.model + " ($" + ledger.cost.estimated_usd.toFixed(4) + ")");
        }
        if (ledger.source?.rules_loaded?.length) {
          metaParts.push("rules: " + ledger.source.rules_loaded.length);
        }
        metaParts.push("j/k nav · s split · / search");
        document.getElementById("meta-info").textContent = metaParts.join(" · ");

        const bar = document.getElementById("coverage-bar");
        const denom = Math.max(c.total, 1);
        bar.innerHTML =
          '<div class="cov-explained" style="width:' + ((c.explained / denom) * 100) + '%" title="Explained: ' + c.explained + '"></div>' +
          '<div class="cov-collapsed" style="width:' + ((c.collapsed / denom) * 100) + '%" title="Collapsed: ' + c.collapsed + '"></div>' +
          '<div class="cov-unexplained" style="width:' + ((c.unexplained / denom) * 100) + '%" title="Unexplained: ' + c.unexplained + '"></div>';
        updateUnderstoodCounter();
      }

      function parsePatchLines(patch, oldStart, newStart) {
        const lines = patch.split("\\n");
        let oldLine = oldStart;
        let newLine = newStart;
        return lines.map((line) => {
          if (line.startsWith("@@") || line.startsWith("rename ")) {
            return { type: "hdr", oldNum: "", newNum: "", text: line };
          }
          if (line.startsWith("+") && !line.startsWith("+++")) {
            return { type: "add", oldNum: "", newNum: newLine++, text: line };
          }
          if (line.startsWith("-") && !line.startsWith("---")) {
            return { type: "del", oldNum: oldLine++, newNum: "", text: line };
          }
          return { type: "ctx", oldNum: oldLine++, newNum: newLine++, text: line };
        });
      }

      function renderUnifiedTable(hunk, rows) {
        const omittedSet = new Set(hunk.audit?.omitted_lines || []);
        return (
          '<table class="diff-table" data-hunk-table="' + esc(hunk.id) + '"><tbody>' +
          rows.map((r) => {
            const isOmitted =
              (r.type === "add" && omittedSet.has(r.newNum)) ||
              (r.type === "del" && omittedSet.has(r.oldNum));
            const cls =
              (r.type === "add" ? "line-add" :
              r.type === "del" ? "line-del" :
              r.type === "hdr" ? "line-hdr" : "") +
              (isOmitted ? " line-omitted" : "");
            return (
              '<tr class="diff-line ' + cls + '" data-old="' + r.oldNum + '" data-new="' + r.newNum + '"' +
              (isOmitted ? ' title="Omitted by author explanation — flagged by independent Line Auditor"' : "") + '>' +
              '<td class="diff-num">' + r.oldNum + "</td>" +
              '<td class="diff-num">' + r.newNum + "</td>" +
              '<td class="diff-code">' + esc(r.text) + "</td>" +
              "</tr>"
            );
          }).join("") +
          "</tbody></table>"
        );
      }

      function renderSplitTable(hunk, rows) {
        const pairs = [];
        let i = 0;
        while (i < rows.length) {
          const r = rows[i];
          if (r.type === "hdr" || r.type === "ctx") {
            pairs.push({ left: r, right: r });
            i += 1;
          } else if (r.type === "del") {
            const dels = [];
            const adds = [];
            while (i < rows.length && rows[i].type === "del") dels.push(rows[i++]);
            while (i < rows.length && rows[i].type === "add") adds.push(rows[i++]);
            const max = Math.max(dels.length, adds.length);
            for (let k = 0; k < max; k += 1) {
              pairs.push({ left: dels[k] || null, right: adds[k] || null });
            }
          } else if (r.type === "add") {
            pairs.push({ left: null, right: r });
            i += 1;
          } else {
            i += 1;
          }
        }

        const omittedSet = new Set(hunk.audit?.omitted_lines || []);
        return (
          '<table class="diff-table" data-hunk-table="' + esc(hunk.id) + '"><tbody>' +
          pairs.map((p) => {
            if (p.left && p.left.type === "hdr") {
              return '<tr class="diff-line line-hdr"><td class="diff-num"></td><td colspan="3" class="diff-code">' + esc(p.left.text) + "</td></tr>";
            }
            const lOmitted = p.left?.type === "del" && omittedSet.has(p.left.oldNum);
            const rOmitted = p.right?.type === "add" && omittedSet.has(p.right.newNum);
            const lCls = (p.left?.type === "del" ? "line-del" : "") + (lOmitted ? " line-omitted" : "");
            const rCls = (p.right?.type === "add" ? "line-add" : "") + (rOmitted ? " line-omitted" : "");
            return (
              '<tr class="diff-line' + (lOmitted || rOmitted ? " line-omitted" : "") + '" data-old="' + (p.left?.oldNum ?? "") + '" data-new="' + (p.right?.newNum ?? "") + '"' +
              (lOmitted || rOmitted ? ' title="Omitted by author explanation — flagged by independent Line Auditor"' : "") + '>' +
              '<td class="diff-num ' + lCls + '">' + (p.left?.oldNum ?? "") + "</td>" +
              '<td class="diff-split-code ' + lCls + '">' + esc(p.left ? p.left.text.replace(/^-/, " ") : "") + "</td>" +
              '<td class="diff-num ' + rCls + '">' + (p.right?.newNum ?? "") + "</td>" +
              '<td class="diff-split-code ' + rCls + '">' + esc(p.right ? p.right.text.replace(/^\\+/, " ") : "") + "</td>" +
              "</tr>"
            );
          }).join("") +
          "</tbody></table>"
        );
      }

      function renderHunk(hunk, questionById, findingById) {
        const statusClass =
          hunk.status === "explained" ? "b-green" :
          hunk.status === "unexplained" ? "b-red" : "b-slate";
        const riskClass =
          hunk.risk === "high" ? "b-red" :
          hunk.risk === "medium" ? "b-amber" : "b-slate";

        const pathLabel = hunk.old_path ? hunk.old_path + " → " + hunk.path : hunk.path;
        const rangeLabel = "L" + hunk.new_range[0] + "–" + hunk.new_range[1];
        const maskWhat = selfCheckMode && hunk.risk === "high" && hunk.what && !revealedHunks.has(hunk.id);

        let whatHtml = "";
        if (maskWhat) {
          whatHtml =
            '<div class="ev-box">' +
            '<div class="ev-label"><span>What (Self-Check Active)</span><span class="badge b-amber">predict first</span></div>' +
            '<div class="ev-masked"><span>Read the diff below and form your own mental model before revealing.</span><button class="btn reveal-btn" data-hunk="' + esc(hunk.id) + '">Reveal What</button></div>' +
            "</div>";
        } else if (hunk.what) {
          const citeBadge = hunk.what.citations_valid
            ? '<span class="badge b-green">citations_valid ✓</span>'
            : '<span class="badge b-red">citations_invalid ✗</span>';
          const semBadgeClass =
            hunk.what.semantic_grounding === "test_backed" || hunk.what.semantic_grounding === "judge_passed"
              ? "b-green"
              : hunk.what.semantic_grounding === "judge_failed"
              ? "b-red"
              : "b-amber";
          const cites = (hunk.what.citations || []).map((c) =>
            '<button class="cite-chip" data-hunk="' + esc(hunk.id) + '" data-side="' + esc(c.side) + '" data-start="' + c.lines[0] + '" data-end="' + c.lines[1] + '">' +
            esc(c.path) + ":" + c.lines[0] + (c.lines[1] !== c.lines[0] ? "-" + c.lines[1] : "") + " (" + esc(c.side) + ")</button>"
          ).join("");
          const auditBadge = hunk.audit
            ? '<span class="badge ' +
              (hunk.audit.status === "verified" ? "b-green" :
               hunk.audit.status === "omission_detected" ? "b-amber" :
               hunk.audit.status === "contradicted" ? "b-red" : "b-slate") +
              '">audit: ' + esc(hunk.audit.status) +
              (hunk.audit.omitted_lines?.length ? " (" + hunk.audit.omitted_lines.length + " omitted)" : "") +
              "</span>"
            : "";
          const explainerPill = hunk.explainer_meta
            ? '<span class="badge b-slate">' + esc(hunk.explainer_meta.adapter) + (hunk.explainer_meta.cached ? " · cached" : "") + "</span>"
            : "";
          whatHtml =
            '<div class="ev-box">' +
            '<div class="ev-label"><span>What (Code Fact)</span><span class="badges">' + citeBadge + '<span class="badge ' + semBadgeClass + '">semantic: ' + esc(hunk.what.semantic_grounding) + '</span>' + auditBadge + explainerPill + '</span></div>' +
            '<p class="ev-text">' + esc(hunk.what.text) + "</p>" +
            (hunk.audit?.note ? '<div style="margin-top:4px;font-size:11px;color:var(--muted)">Auditor (' + esc(hunk.audit.auditor_model) + "): " + esc(hunk.audit.note) + "</div>" : "") +
            (!hunk.audit && hunk.what.semantic_note ? '<div style="margin-top:4px;font-size:11px;color:var(--muted)">Judge: ' + esc(hunk.what.semantic_note) + "</div>" : "") +
            (cites ? '<div class="citations">' + cites + "</div>" : "") +
            "</div>";
        } else {
          whatHtml =
            '<div class="ev-box">' +
            '<div class="ev-label"><span>What (Code Fact)</span><span class="badge b-slate">' + esc(hunk.status) + "</span></div>" +
            '<p class="ev-text" style="color:var(--muted)">' +
            (hunk.status === "collapsed"
              ? esc(hunk.class_reason || "Deterministically classified as mechanical/generated.")
              : "No explanation recorded yet for this hunk.") +
            "</p></div>";
        }

        const why = hunk.why || { text: "No rationale recorded.", source: "missing", evidence: [], verification: "not_checked" };
        const whySrcClass =
          why.source === "transcript" || why.source === "declared_intent" ? "b-green" :
          why.source === "missing" ? "b-red" : "b-amber";
        const whyVerClass =
          why.verification === "confirmed" ? "b-green" :
          why.verification === "refuted" ? "b-red" : "b-slate";
        const evidenceHtml = (why.evidence || []).map((ev) =>
          '<div style="margin-top:6px;font-size:11px;color:var(--muted)"><code>' + esc(ev.kind) + ": " + esc(ev.ref) + "</code>" +
          (ev.excerpt ? " — " + esc(ev.excerpt) : "") + "</div>"
        ).join("");

        const whyHtml =
          '<div class="ev-box">' +
          '<div class="ev-label"><span>Why (Provenance)</span><span class="badges"><span class="badge ' + whySrcClass + '">source: ' + esc(why.source) + '</span><span class="badge ' + whyVerClass + '">' + esc(why.verification) + "</span></span></div>" +
          '<p class="ev-text">' + esc(why.text) + "</p>" +
          evidenceHtml +
          "</div>";

        const fHtml = (hunk.finding_ids || []).map((fid) => {
          const f = findingById.get(fid);
          if (!f) return "";
          return (
            '<div class="finding-box">' +
            '<div class="badges" style="margin-bottom:4px"><span class="badge b-purple">' + esc(f.rule_id) + '</span><span class="badge b-slate">' + esc(f.tool) + '</span><span class="badge ' + (f.severity === "important" ? "b-red" : "b-amber") + '">' + esc(f.severity) + "</span></div>" +
            "<div>" + esc(f.message) + "</div>" +
            "</div>"
          );
        }).join("");

        const qHtml = (hunk.questions || []).map((qid) => {
          const q = questionById.get(qid);
          if (!q) return "";
          const copyText = "Please explain this change with exact file:line or test evidence:\\n" + q.question;
          let ansHtml = "";
          if (q.answer) {
            const vStatus = q.verdict?.status || "unverifiable";
            const vClass = vStatus === "confirmed" ? "b-green" : vStatus === "refuted" ? "b-red" : "b-amber";
            ansHtml =
              '<div class="answer-box">' +
              '<div class="question-head"><strong>Answer (' + esc(q.answer.answered_by) + ')</strong><span class="badge ' + vClass + '">verdict: ' + esc(vStatus) + "</span></div>" +
              "<div>" + esc(q.answer.text) + "</div>" +
              (q.verdict?.evidence?.length ? '<div style="margin-top:4px;font-size:11px;color:var(--muted)">Evidence: ' + esc(q.verdict.evidence.join(" · ")) + "</div>" : "") +
              "</div>";
          }
          const liveForm = LIVE_SERVER
            ? '<form class="answer-form" data-qid="' + esc(q.id) + '"><input type="text" placeholder="Record answer (cite file:line or test)..." /><button class="btn" type="submit">Save Answer</button></form>'
            : "";
          return (
            '<div class="question-box">' +
            '<div class="question-head"><span class="badge b-red">trigger: ' + esc(q.trigger) + '</span><button class="btn copy-q-btn" data-copy="' + esc(copyText) + '">Copy question for agent</button></div>' +
            "<div>" + esc(q.question) + "</div>" +
            ansHtml +
            liveForm +
            "</div>"
          );
        }).join("");

        const rows = parsePatchLines(hunk.patch, hunk.old_range[0], hunk.new_range[0]);
        const diffHtml = splitView ? renderSplitTable(hunk, rows) : renderUnifiedTable(hunk, rows);

        return (
          '<article class="hunk-card status-' + esc(hunk.status) + '" id="hunk-' + esc(hunk.id) + '" data-hunk-id="' + esc(hunk.id) + '">' +
          '<div class="hunk-head">' +
          '<div><span class="hunk-path">' + esc(pathLabel) + "</span>" +
          '<span class="hunk-symbol">' + esc(rangeLabel) + (hunk.enclosing_symbol ? " · " + esc(hunk.enclosing_symbol) : "") + "</span></div>" +
          '<div class="badges">' +
          '<span class="badge ' + statusClass + '">' + esc(hunk.status) + "</span>" +
          '<span class="badge ' + riskClass + '">risk: ' + esc(hunk.risk) + "</span>" +
          '<span class="badge b-slate">' + esc(hunk.class) + " (" + esc(hunk.class_by) + ")</span>" +
          '<span class="badge b-slate">' + esc(hunk.id) + "</span>" +
          "</div></div>" +
          '<div class="evidence-grid">' + whatHtml + whyHtml + "</div>" +
          fHtml +
          qHtml +
          diffHtml +
          "</article>"
        );
      }

      function matchesFilters(hunk) {
        if (activeFilter !== "all" && hunk.status !== activeFilter) return false;
        if (riskFilter !== "all" && hunk.risk !== riskFilter) return false;
        if (searchQuery) {
          const hay = (
            hunk.path + " " + (hunk.enclosing_symbol || "") + " " +
            (hunk.what?.text || "") + " " + (hunk.why?.text || "") + " " + hunk.id
          ).toLowerCase();
          if (!hay.includes(searchQuery)) return false;
        }
        return true;
      }

      function renderBody() {
        const hunkById = new Map(ledger.hunks.map((h) => [h.id, h]));
        const questionById = new Map(ledger.questions.map((q) => [q.id, q]));
        const findingById = new Map((ledger.findings || []).map((f) => [f.id, f]));

        const sidebar = document.getElementById("sidebar");
        const main = document.getElementById("main");

        let sideHtml = "<h2>Reading Order (" + ledger.groups.length + ")</h2>";
        let mainHtml = "";

        if (ledger.overview.declared_intent) {
          mainHtml +=
            '<div class="intent-banner"><strong>Declared Intent (' + esc(ledger.overview.declared_intent_ref || "prompt") + "):</strong> " +
            esc(ledger.overview.declared_intent) + "</div>";
        }

        const skipped = ledger.source?.skipped_files || [];
        if (skipped.length > 0) {
          mainHtml +=
            '<div class="skipped-banner"><strong>Skipped ' + skipped.length + " file(s) during ingestion:</strong> " +
            skipped.map((s) => "<code>" + esc(s.path) + "</code> (" + esc(s.reason) + ")").join(", ") + "</div>";
        }

        let visibleGroupCount = 0;

        for (const group of ledger.groups) {
          const groupHunks = group.hunk_ids
            .map((id) => hunkById.get(id))
            .filter(Boolean)
            .filter(matchesFilters);

          if (groupHunks.length === 0) continue;
          visibleGroupCount += 1;

          const isUnderstood = understoodGroups.has(group.id);
          const unexpCount = groupHunks.filter((h) => h.status === "unexplained").length;

          sideHtml +=
            '<a class="nav-item' + (isUnderstood ? " understood" : "") + '" href="#group-' + esc(group.id) + '">' +
            '<span class="dot dot-' + esc(group.risk) + '"></span>' +
            '<div><div class="nav-title">' + (isUnderstood ? "✓ " : "") + esc(group.title) + "</div>" +
            '<div class="nav-meta">' + groupHunks.length + " hunk(s)" + (unexpCount > 0 ? " · " + unexpCount + " unexplained" : "") + "</div></div>" +
            "</a>";

          const startCollapsed = Boolean(group.collapsed_by_default) && activeFilter !== "collapsed" && !searchQuery;
          const riskClass =
            group.risk === "high" ? "b-red" :
            group.risk === "medium" ? "b-amber" : "b-slate";

          mainHtml +=
            '<section class="group-card" id="group-' + esc(group.id) + '" data-group-id="' + esc(group.id) + '">' +
            '<div class="group-header">' +
            "<div>" +
            '<h3 class="group-title">' + esc(group.title) + "</h3>" +
            '<p class="group-intent">' + esc(group.intent) + "</p>" +
            (group.order_rationale ? '<p class="group-rationale">' + esc(group.order_rationale) + "</p>" : "") +
            "</div>" +
            '<div class="badges">' +
            '<span class="badge ' + riskClass + '">risk: ' + esc(group.risk) + "</span>" +
            '<button class="btn understood-btn' + (isUnderstood ? " active" : "") + '" data-group="' + esc(group.id) + '">' +
            (isUnderstood ? "Understood ✓" : "Mark understood") + "</button>" +
            '<button class="btn toggle-group-btn" data-target="body-' + esc(group.id) + '">' +
            (startCollapsed ? "Expand (" + groupHunks.length + ")" : "Collapse") + "</button>" +
            "</div></div>" +
            '<div class="group-body' + (startCollapsed ? " collapsed" : "") + '" id="body-' + esc(group.id) + '">' +
            groupHunks.map((h) => renderHunk(h, questionById, findingById)).join("") +
            "</div></section>";
        }

        if (ledger.questions.length > 0) {
          sideHtml += "<h2>Clarifying Questions (" + ledger.questions.length + ")</h2>";
          for (const q of ledger.questions) {
            const firstHunk = q.hunk_ids[0];
            const dotClass = q.verdict?.status === "confirmed" ? "dot-low" : "dot-high";
            sideHtml +=
              '<a class="nav-item" href="#hunk-' + esc(firstHunk) + '">' +
              '<span class="dot ' + dotClass + '"></span>' +
              '<div><div class="nav-title">' + esc(q.trigger) + (q.verdict ? " [" + esc(q.verdict.status) + "]" : "") + "</div>" +
              '<div class="nav-meta">' + esc(q.question.slice(0, 72)) + "...</div></div></a>";
          }
        }

        if ((ledger.findings || []).length > 0) {
          sideHtml += "<h2>Findings (" + ledger.findings.length + ")</h2>";
          for (const f of ledger.findings) {
            sideHtml +=
              '<a class="nav-item" href="#hunk-' + esc(f.hunk_id || "") + '">' +
              '<span class="dot dot-' + (f.severity === "important" ? "high" : "medium") + '"></span>' +
              '<div><div class="nav-title">' + esc(f.rule_id) + "</div>" +
              '<div class="nav-meta">' + esc(f.path) + ":" + f.lines[0] + "</div></div></a>";
          }
        }

        if ((ledger.ruled_out || []).length > 0) {
          sideHtml += "<h2>Ruled-Out Proof (" + ledger.ruled_out.length + ")</h2>";
          mainHtml +=
            '<section class="group-card" id="ruled-out-section">' +
            '<div class="group-header"><div><h3 class="group-title">Symmetric Proof: Ruled-Out Concerns (' + ledger.ruled_out.length + ')</h3>' +
            '<p class="group-intent">Suspicions examined and dismissed with code proof (or rejected by the independent cold-start verifier).</p></div>' +
            '<button class="btn toggle-group-btn" data-target="body-ruled-out">' + (ruledOutExpanded ? "Collapse" : "Expand (" + ledger.ruled_out.length + ")") + '</button></div>' +
            '<div class="group-body' + (ruledOutExpanded ? "" : " collapsed") + '" id="body-ruled-out">' +
            ledger.ruled_out.map((ro) =>
              '<div class="ev-box" style="margin-bottom:8px">' +
              '<div class="ev-label"><span>' + esc(ro.path) + ':' + ro.lines[0] + ' (' + esc(ro.specialist) + ')</span>' +
              '<span class="badge ' + (ro.shaky_dismissal ? "b-red" : "b-slate") + '">' + (ro.shaky_dismissal ? "shaky_dismissal_escalated" : "ruled_out") + '</span></div>' +
              '<p class="ev-text"><strong>Suspicion:</strong> ' + esc(ro.suspicion) + '</p>' +
              '<p class="ev-text" style="color:var(--muted);margin-top:4px"><strong>Proof:</strong> ' + esc(ro.proof) + '</p>' +
              '</div>'
            ).join("") +
            '</div></section>';
        }

        if ((ledger.rule_telemetry || []).length > 0) {
          mainHtml +=
            '<section class="group-card" id="rule-telemetry-section">' +
            '<div class="group-header"><div><h3 class="group-title">Structured Rule Telemetry (' + ledger.rule_telemetry.length + ')</h3>' +
            '<p class="group-intent">Active custom rules scoped to this diff, with trust source and hit counts.</p></div></div>' +
            '<div class="group-body">' +
            ledger.rule_telemetry.map((t) =>
              '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);font-size:12px">' +
              '<span><code>' + esc(t.id) + '</code> — ' + esc(t.title) + ' <span style="color:var(--muted)">(' + esc(t.source) + ', ' + esc(t.kind) + ')</span></span>' +
              '<span class="badges"><span class="badge b-slate">matched: ' + t.matched_hunks + '</span><span class="badge ' + (t.hits > 0 ? "b-red" : "b-green") + '">hits: ' + t.hits + '</span></span>' +
              '</div>'
            ).join("") +
            '</div></section>';
        }

        if (visibleGroupCount === 0) {
          mainHtml += '<div class="empty-state">No hunks match your active filters.</div>';
        }

        sidebar.innerHTML = sideHtml;
        main.innerHTML = mainHtml;
        focusedHunkIdx = -1;
      }

      function focusHunk(delta) {
        const cards = [...document.querySelectorAll(".hunk-card")].filter((el) => !el.closest(".group-body.collapsed"));
        if (cards.length === 0) return;
        cards.forEach((c) => c.classList.remove("focused"));
        focusedHunkIdx = Math.max(0, Math.min(cards.length - 1, focusedHunkIdx + delta));
        const target = cards[focusedHunkIdx];
        target.classList.add("focused");
        target.scrollIntoView({ behavior: "smooth", block: "center" });
      }

      document.addEventListener("click", (ev) => {
        const filterBtn = ev.target.closest("[data-filter]");
        if (filterBtn) {
          activeFilter = filterBtn.getAttribute("data-filter");
          document.querySelectorAll("[data-filter]").forEach((b) => b.classList.remove("active"));
          filterBtn.classList.add("active");
          renderBody();
          return;
        }

        const understoodBtn = ev.target.closest(".understood-btn");
        if (understoodBtn) {
          const gid = understoodBtn.getAttribute("data-group");
          if (understoodGroups.has(gid)) understoodGroups.delete(gid);
          else understoodGroups.add(gid);
          saveUnderstood();
          renderBody();
          return;
        }

        const toggleBtn = ev.target.closest(".toggle-group-btn");
        if (toggleBtn) {
          const targetId = toggleBtn.getAttribute("data-target");
          const target = document.getElementById(targetId);
          if (target) {
            const isCollapsed = target.classList.toggle("collapsed");
            if (targetId === "body-ruled-out") ruledOutExpanded = !isCollapsed;
            toggleBtn.textContent = isCollapsed ? "Expand" : "Collapse";
          }
          return;
        }

        const revealBtn = ev.target.closest(".reveal-btn");
        if (revealBtn) {
          revealedHunks.add(revealBtn.getAttribute("data-hunk"));
          renderBody();
          return;
        }

        const citeBtn = ev.target.closest(".cite-chip");
        if (citeBtn) {
          const hid = citeBtn.getAttribute("data-hunk");
          const side = citeBtn.getAttribute("data-side");
          const start = Number(citeBtn.getAttribute("data-start"));
          const end = Number(citeBtn.getAttribute("data-end"));
          const table = document.querySelector('[data-hunk-table="' + hid + '"]');
          if (table) {
            table.querySelectorAll(".line-highlight").forEach((el) => el.classList.remove("line-highlight"));
            let first = null;
            table.querySelectorAll("tr.diff-line").forEach((tr) => {
              const raw = tr.getAttribute(side === "old" ? "data-old" : "data-new");
              const num = Number(raw);
              if (raw && num >= start && num <= end) {
                tr.classList.add("line-highlight");
                if (!first) first = tr;
              }
            });
            if (first) first.scrollIntoView({ behavior: "smooth", block: "center" });
          }
          return;
        }

        const copyBtn = ev.target.closest(".copy-q-btn");
        if (copyBtn) {
          const text = copyBtn.getAttribute("data-copy");
          navigator.clipboard?.writeText(text).then(() => {
            const orig = copyBtn.textContent;
            copyBtn.textContent = "Copied ✓";
            setTimeout(() => (copyBtn.textContent = orig), 1500);
          });
          return;
        }
      });

      document.addEventListener("submit", async (ev) => {
        const form = ev.target.closest(".answer-form");
        if (!form || !LIVE_SERVER) return;
        ev.preventDefault();
        const qid = form.getAttribute("data-qid");
        const input = form.querySelector("input");
        const text = input.value.trim();
        if (!text) return;
        const btn = form.querySelector("button");
        btn.disabled = true;
        btn.textContent = "Saving...";
        try {
          const res = await fetch("/api/questions/" + encodeURIComponent(qid) + "/answer", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text }),
          });
          const data = await res.json();
          if (data.ok && data.ledger) {
            ledger = data.ledger;
            renderHeader();
            renderBody();
          }
        } finally {
          btn.disabled = false;
        }
      });

      document.getElementById("search-box").addEventListener("input", (ev) => {
        searchQuery = ev.target.value.trim().toLowerCase();
        renderBody();
      });

      document.getElementById("risk-filter").addEventListener("change", (ev) => {
        riskFilter = ev.target.value;
        renderBody();
      });

      document.getElementById("split-toggle").addEventListener("click", () => {
        splitView = !splitView;
        document.getElementById("split-toggle").textContent = splitView ? "Split" : "Unified";
        document.getElementById("split-toggle").classList.toggle("active", splitView);
        renderBody();
      });

      document.getElementById("self-check-toggle").addEventListener("click", () => {
        selfCheckMode = !selfCheckMode;
        const btn = document.getElementById("self-check-toggle");
        btn.textContent = "Self-Check: " + (selfCheckMode ? "On" : "Off");
        btn.classList.toggle("active", selfCheckMode);
        renderBody();
      });

      document.getElementById("download-json-btn").addEventListener("click", () => {
        const blob = new Blob([JSON.stringify(ledger, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "diffgloss-ledger.json";
        a.click();
      });

      document.getElementById("theme-toggle").addEventListener("click", () => {
        const cur = document.documentElement.getAttribute("data-theme");
        document.documentElement.setAttribute("data-theme", cur === "light" ? "dark" : "light");
      });

      // --- Repo & Commit Picker Modal ---
      const repoModal = document.getElementById("repo-modal");
      const repoStatusEl = document.getElementById("repo-status");
      const repoStaticNote = document.getElementById("repo-static-note");
      const repoLiveBody = document.getElementById("repo-live-body");
      let activeRepoInfo = null;
      let commitsCache = [];

      function setRepoStatus(kind, msg) {
        repoStatusEl.className = "status-msg " + kind;
        repoStatusEl.textContent = msg;
      }

      function renderCommitsList(filterText) {
        const q = (filterText || "").trim().toLowerCase();
        const filtered = commitsCache.filter((c) =>
          !q || c.short_sha.toLowerCase().includes(q) || c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q)
        );
        const box = document.getElementById("commit-list");
        if (filtered.length === 0) {
          box.innerHTML = '<div style="padding:14px;text-align:center;color:var(--muted);font-size:12px">No commits found.</div>';
          return;
        }
        box.innerHTML = filtered.map((c) =>
          '<button type="button" class="commit-row" data-commit-sha="' + esc(c.sha) + '">' +
          '<span class="commit-sha">' + esc(c.short_sha) + '</span>' +
          '<span class="commit-subj">' + esc(c.subject) + '</span>' +
          '<span class="commit-meta">' + esc(c.author) + (c.relative_time ? " · " + esc(c.relative_time) : "") + '</span>' +
          '</button>'
        ).join("");
      }

      async function fetchRepoMetadata(targetPath) {
        setRepoStatus("info", "Inspecting git repository...");
        try {
          const qs = targetPath ? "?path=" + encodeURIComponent(targetPath) : "";
          const res = await fetch("/api/repo" + qs);
          const data = await res.json();
          if (!data.ok) {
            setRepoStatus("err", data.error || "Failed to inspect repo");
            return;
          }
          activeRepoInfo = data.repo;
          commitsCache = data.repo.commits || [];
          document.getElementById("repo-path-input").value = data.repo.repo_path;
          document.getElementById("repo-branch-badge").textContent =
            "(branch: " + data.repo.branch + " · " + data.repo.dirty_files + " dirty · " + data.repo.staged_files + " staged)";
          document.getElementById("load-working-btn").textContent = "Working Tree (" + data.repo.dirty_files + ")";
          document.getElementById("load-staged-btn").textContent = "Staged (" + data.repo.staged_files + ")";
          document.getElementById("range-input").value =
            data.repo.default_base && data.repo.default_base !== data.repo.branch
              ? data.repo.default_base + "..HEAD"
              : "HEAD~1..HEAD";

          const allRepos = [...new Set([...(data.recent_repos || []), ...(data.nearby_repos || [])])];
          const chips = document.getElementById("repo-chips");
          chips.innerHTML = allRepos.map((rp) => {
            const parts = rp.split(/[\\/]/);
            const name = parts[parts.length - 1] || rp;
            const isCur = rp === data.repo.repo_path;
            return '<button type="button" class="preset-chip' + (isCur ? " active" : "") + '" data-repo-path="' + esc(rp) + '" title="' + esc(rp) + '">' + esc(name) + "</button>";
          }).join("");

          renderCommitsList(document.getElementById("commit-filter-input").value);
          repoStatusEl.className = "status-msg";
        } catch (err) {
          setRepoStatus("err", err.message);
        }
      }

      async function loadDiffSelection(payload) {
        setRepoStatus("info", "Loading diff & building explainability ledger...");
        try {
          const res = await fetch("/api/load-diff", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              repo_path: document.getElementById("repo-path-input").value.trim(),
              ...payload,
            }),
          });
          const data = await res.json();
          if (!data.ok) {
            const errMsg = data.error || "Failed to load diff";
            setRepoStatus("err", errMsg);
            return { ok: false, error: errMsg };
          }
          ledger = data.ledger;
          activeFilter = "all";
          document.querySelectorAll("[data-filter]").forEach((b) =>
            b.classList.toggle("active", b.getAttribute("data-filter") === "all")
          );
          renderHeader();
          renderBody();
          repoModal.classList.remove("open");
          return { ok: true, ledger };
        } catch (err) {
          setRepoStatus("err", err.message);
          return { ok: false, error: err.message };
        }
      }

      document.getElementById("repo-picker-btn").addEventListener("click", () => {
        repoModal.classList.add("open");
        repoStatusEl.className = "status-msg";
        if (!LIVE_SERVER) {
          repoStaticNote.style.display = "block";
          repoStaticNote.textContent = "Static offline HTML mode: run 'diffgloss ui' to switch repositories and browse commits interactively.";
          repoLiveBody.style.display = "none";
          return;
        }
        repoStaticNote.style.display = "none";
        repoLiveBody.style.display = "block";
        fetchRepoMetadata(activeRepoInfo?.repo_path || "");
      });

      document.getElementById("repo-close").addEventListener("click", () => repoModal.classList.remove("open"));
      repoModal.addEventListener("click", (ev) => {
        if (ev.target === repoModal) repoModal.classList.remove("open");
      });
      document.getElementById("repo-load-btn").addEventListener("click", () => {
        fetchRepoMetadata(document.getElementById("repo-path-input").value.trim());
      });
      document.getElementById("repo-chips").addEventListener("click", (ev) => {
        const chip = ev.target.closest("[data-repo-path]");
        if (!chip) return;
        fetchRepoMetadata(chip.getAttribute("data-repo-path"));
      });
      document.getElementById("load-working-btn").addEventListener("click", () => loadDiffSelection({ mode: "working" }));
      document.getElementById("load-staged-btn").addEventListener("click", () => loadDiffSelection({ mode: "staged" }));
      document.getElementById("load-range-btn").addEventListener("click", () =>
        loadDiffSelection({ mode: "range", range: document.getElementById("range-input").value.trim() })
      );
      document.getElementById("commit-filter-input").addEventListener("input", (ev) => renderCommitsList(ev.target.value));
      document.getElementById("commit-list").addEventListener("click", (ev) => {
        const row = ev.target.closest("[data-commit-sha]");
        if (!row) return;
        loadDiffSelection({ mode: "commit", sha: row.getAttribute("data-commit-sha") });
      });

      async function runExplainWithStream(payloadObj, onDoneCallback) {
        const banner = document.getElementById("stream-banner");
        const msgEl = document.getElementById("stream-msg");
        const stepEl = document.getElementById("stream-step");
        banner.classList.add("active");
        msgEl.textContent = "Starting Diffgloss dual-role pipeline...";
        stepEl.textContent = "...";

        try {
          const res = await fetch("/api/explain-stream", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payloadObj),
          });
          if (!res.body) throw new Error("Streaming response unavailable");
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          let lastError = null;

          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const frames = buf.split("\\n\\n");
            buf = frames.pop() || "";
            for (const frame of frames) {
              const evMatch = /^event:\\s*(.+)$/m.exec(frame);
              const dataMatch = /^data:\\s*(.+)$/m.exec(frame);
              if (!evMatch || !dataMatch) continue;
              const evName = evMatch[1].trim();
              const data = JSON.parse(dataMatch[1]);
              if (evName === "stage") {
                msgEl.textContent = data.message || data.stage;
                stepEl.textContent = data.total ? data.done + "/" + data.total : data.stage;
              } else if (evName === "ledger" && data.ledger) {
                ledger = data.ledger;
                renderHeader();
                renderBody();
              } else if (evName === "done" && data.ledger) {
                ledger = data.ledger;
                renderHeader();
                renderBody();
                onDoneCallback?.(true, data.ledger);
              } else if (evName === "error") {
                lastError = data.error || "Pipeline error";
              }
            }
          }
          if (lastError) {
            onDoneCallback?.(false, lastError);
          }
        } catch (err) {
          onDoneCallback?.(false, err.message);
        } finally {
          setTimeout(() => banner.classList.remove("active"), 1800);
        }
      }

      document.getElementById("quick-explain-btn").addEventListener("click", async () => {
        if (!LIVE_SERVER) {
          document.getElementById("settings-btn").click();
          return;
        }
        const btn = document.getElementById("quick-explain-btn");
        btn.disabled = true;
        btn.textContent = "Running...";
        await runExplainWithStream({}, (ok, info) => {
          if (!ok) {
            document.getElementById("settings-btn").click();
            setTimeout(() => setStatus("err", String(info || "Please configure a model and API key first.")), 150);
          }
        });
        btn.disabled = false;
        btn.textContent = "▶ Explain & Audit";
      });

      // Native Tauri Desktop Drag-and-Drop bridge (when running inside Diffgloss.app)
      window.__diffglossSetDropActive = function (active) {
        const overlay = document.getElementById("drop-overlay");
        if (overlay) overlay.classList.toggle("active", Boolean(active));
      };
      window.__diffglossLoadRepo = async function (repoPath) {
        window.__diffglossSetDropActive(false);
        if (!repoPath || !LIVE_SERVER) return;
        const banner = document.getElementById("stream-banner");
        const msgEl = document.getElementById("stream-msg");
        const stepEl = document.getElementById("stream-step");
        banner.classList.add("active");
        msgEl.textContent = "Loading dropped path: " + repoPath + "...";
        stepEl.textContent = "git";
        document.getElementById("repo-path-input").value = repoPath;
        try {
          const r1 = await loadDiffSelection({ repo_path: repoPath, mode: "working" });
          if (!r1?.ok) {
            throw new Error(r1?.error || "Not a valid Git repository");
          }
          if (ledger.coverage.total === 0) {
            const r2 = await loadDiffSelection({ repo_path: repoPath, mode: "commit", sha: "HEAD" });
            if (!r2?.ok) throw new Error(r2?.error || "Could not load HEAD commit");
          }
          msgEl.textContent = "Loaded " + (ledger.source?.repo || repoPath) + " (" + ledger.coverage.total + " hunks) — click '▶ Explain & Audit' to analyze.";
          stepEl.textContent = "ready";
        } catch (err) {
          msgEl.textContent = "Could not load dropped path: " + (err?.message || String(err));
          stepEl.textContent = "error";
        } finally {
          setTimeout(() => banner.classList.remove("active"), 3200);
        }
      };

      (function setupDesktopBridge() {
        const tauriEvent = window.__TAURI__?.event;
        if (tauriEvent && typeof tauriEvent.listen === "function") {
          tauriEvent.listen("tauri://drag-enter", () => window.__diffglossSetDropActive(true));
          tauriEvent.listen("tauri://drag-leave", () => window.__diffglossSetDropActive(false));
          tauriEvent.listen("tauri://drag-drop", (ev) => {
            const paths = ev.payload?.paths || [];
            if (paths.length > 0) window.__diffglossLoadRepo(paths[0]);
          });
        }
      })();

      // --- In-Page Model Settings Modal ---
      let presetsCache = [];
      let selectedPresetId = "deepseek";
      const modal = document.getElementById("settings-modal");
      const statusEl = document.getElementById("cfg-status");
      const staticNote = document.getElementById("settings-static-note");
      const liveBody = document.getElementById("settings-live-body");

      function setStatus(kind, msg) {
        statusEl.className = "status-msg " + kind;
        statusEl.textContent = msg;
      }

      function renderPresetChips() {
        const box = document.getElementById("preset-chips");
        box.innerHTML = presetsCache.map((p) =>
          '<button type="button" class="preset-chip' + (p.id === selectedPresetId ? " active" : "") + '" data-preset="' + esc(p.id) + '">' + esc(p.label) + "</button>"
        ).join("");
        const active = presetsCache.find((p) => p.id === selectedPresetId);
        const mBox = document.getElementById("model-chips");
        mBox.innerHTML = (active?.suggested_models || []).map((m) =>
          '<button type="button" class="preset-chip" data-suggest-model="' + esc(m) + '">' + esc(m) + "</button>"
        ).join("");
      }

      function collectSettingsPayload() {
        return {
          explainer_mode: document.getElementById("cfg-explainer-mode").value,
          author_cli: document.getElementById("cfg-author-cli").value,
          preset: selectedPresetId,
          provider: document.getElementById("cfg-provider").value,
          model: document.getElementById("cfg-model").value.trim(),
          base_url: document.getElementById("cfg-base-url").value.trim(),
          api_key: document.getElementById("cfg-api-key").value.trim(),
          budget_usd: Number(document.getElementById("cfg-budget").value || 1.5),
          effort: document.getElementById("cfg-effort").value,
          enable_line_audit: document.getElementById("cfg-enable-line-audit").checked,
          enable_judge: document.getElementById("cfg-enable-judge").checked,
          enable_review: document.getElementById("cfg-enable-review").checked,
          judge_provider: document.getElementById("cfg-judge-provider").value,
          judge_model: document.getElementById("cfg-judge-model").value.trim(),
          judge_base_url: document.getElementById("cfg-judge-base-url").value.trim(),
          judge_api_key: document.getElementById("cfg-judge-api-key").value.trim(),
        };
      }

      function populateSettingsForm(s, detectedClis) {
        selectedPresetId = s.preset || "deepseek";
        document.getElementById("cfg-explainer-mode").value = s.explainer_mode || "author_cli";
        document.getElementById("cfg-author-cli").value = s.author_cli || "auto";
        if (detectedClis) {
          const cliEl = document.getElementById("detected-clis");
          cliEl.innerHTML =
            '<span class="badge ' + (detectedClis.codex?.available ? "b-green" : "b-slate") + '">' +
            (detectedClis.codex?.available ? "✓ " + esc(detectedClis.codex.version || "codex") : "codex not found") +
            '</span><span class="badge ' + (detectedClis.claude?.available ? "b-green" : "b-slate") + '">' +
            (detectedClis.claude?.available ? "✓ " + esc(detectedClis.claude.version || "claude") : "claude not found") +
            "</span>";
        }
        document.getElementById("cfg-provider").value = s.provider || "deepseek";
        document.getElementById("cfg-model").value = s.model || "";
        document.getElementById("cfg-base-url").value = s.base_url || "";
        document.getElementById("cfg-api-key").value = "";
        document.getElementById("cfg-key-status").textContent = s.has_api_key
          ? "(Saved: " + s.api_key_masked + ")"
          : "(Not saved yet)";
        document.getElementById("cfg-budget").value = s.budget_usd ?? 1.5;
        document.getElementById("cfg-effort").value = s.effort || "standard";
        document.getElementById("cfg-enable-line-audit").checked = s.enable_line_audit !== false;
        document.getElementById("cfg-enable-judge").checked = Boolean(s.enable_judge);
        document.getElementById("cfg-enable-review").checked = Boolean(s.enable_review);
        document.getElementById("cfg-intent").value = ledger.overview.declared_intent || "";
        document.getElementById("cfg-judge-provider").value = s.judge_provider || "";
        document.getElementById("cfg-judge-model").value = s.judge_model || "";
        document.getElementById("cfg-judge-base-url").value = s.judge_base_url || "";
        document.getElementById("cfg-judge-api-key").value = "";
        document.getElementById("cfg-judge-key-status").textContent = s.has_judge_api_key
          ? "(Saved: " + s.judge_api_key_masked + ")"
          : "";
        renderPresetChips();
      }

      document.getElementById("settings-btn").addEventListener("click", async () => {
        modal.classList.add("open");
        statusEl.className = "status-msg";
        if (!LIVE_SERVER) {
          staticNote.style.display = "block";
          staticNote.textContent = "Static offline HTML mode: run 'diffgloss ui' or open Diffgloss.app to configure API keys and re-run explanations directly in the page.";
          liveBody.style.display = "none";
          return;
        }
        staticNote.style.display = "none";
        liveBody.style.display = "block";
        try {
          const res = await fetch("/api/settings");
          const data = await res.json();
          presetsCache = data.presets || [];
          populateSettingsForm(data.settings || {}, data.detected_clis);
        } catch (err) {
          setStatus("err", "Failed to load settings: " + err.message);
        }
      });

      document.getElementById("settings-close").addEventListener("click", () => modal.classList.remove("open"));
      modal.addEventListener("click", (ev) => {
        if (ev.target === modal) modal.classList.remove("open");
      });

      document.getElementById("preset-chips").addEventListener("click", (ev) => {
        const btn = ev.target.closest("[data-preset]");
        if (!btn) return;
        const p = presetsCache.find((x) => x.id === btn.getAttribute("data-preset"));
        if (!p) return;
        selectedPresetId = p.id;
        document.getElementById("cfg-provider").value = p.dialect;
        document.getElementById("cfg-base-url").value = p.base_url;
        document.getElementById("cfg-model").value = p.default_model;
        document.getElementById("cfg-api-key").placeholder = p.key_placeholder || "API Key";
        renderPresetChips();
      });

      document.getElementById("model-chips").addEventListener("click", (ev) => {
        const btn = ev.target.closest("[data-suggest-model]");
        if (!btn) return;
        document.getElementById("cfg-model").value = btn.getAttribute("data-suggest-model");
      });

      document.getElementById("cfg-save-btn").addEventListener("click", async () => {
        setStatus("info", "Saving settings locally (~/.config/diffgloss/settings.json)...");
        try {
          const res = await fetch("/api/settings", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(collectSettingsPayload()),
          });
          const data = await res.json();
          if (data.ok) {
            populateSettingsForm(data.settings);
            setStatus("ok", "Saved to " + data.settings.settings_path + " (chmod 600). No environment variables needed!");
          } else {
            setStatus("err", data.error || "Save failed");
          }
        } catch (err) {
          setStatus("err", err.message);
        }
      });

      document.getElementById("cfg-test-btn").addEventListener("click", async () => {
        setStatus("info", "Testing connection...");
        try {
          const res = await fetch("/api/settings/test", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(collectSettingsPayload()),
          });
          const data = await res.json();
          if (data.ok) {
            setStatus("ok", "Connected to " + data.provider + "/" + data.model + " in " + data.latency_ms + "ms (" + data.reply + ")");
          } else {
            setStatus("err", "Connection failed (" + data.latency_ms + "ms): " + data.error);
          }
        } catch (err) {
          setStatus("err", err.message);
        }
      });

      document.getElementById("cfg-run-btn").addEventListener("click", async () => {
        const btn = document.getElementById("cfg-run-btn");
        btn.disabled = true;
        btn.textContent = "Running...";
        setStatus("info", "Saving settings & streaming Diffgloss explanation + line audit...");
        const payload = collectSettingsPayload();
        modal.classList.remove("open");
        await runExplainWithStream(
          {
            settings: payload,
            declared_intent: document.getElementById("cfg-intent").value.trim(),
            enable_line_audit: payload.enable_line_audit,
            enable_judge: payload.enable_judge,
            enable_review: payload.enable_review,
          },
          (ok, info) => {
            if (!ok) {
              modal.classList.add("open");
              setStatus("err", String(info || "Explain failed"));
            }
          },
        );
        btn.disabled = false;
        btn.textContent = "▶ Run Explain Now";
      });

      document.addEventListener("keydown", (ev) => {
        if (ev.target.tagName === "INPUT" || ev.target.tagName === "TEXTAREA" || ev.target.tagName === "SELECT") {
          if (ev.key === "Escape") ev.target.blur();
          return;
        }
        if (ev.key === "j") focusHunk(1);
        else if (ev.key === "k") focusHunk(-1);
        else if (ev.key === "s") document.getElementById("split-toggle").click();
        else if (ev.key === "/") {
          ev.preventDefault();
          document.getElementById("search-box").focus();
        } else if (ev.key === "u") {
          const focused = document.querySelector(".hunk-card.focused");
          const groupCard = focused?.closest(".group-card");
          if (groupCard) {
            const gid = groupCard.getAttribute("data-group-id");
            if (understoodGroups.has(gid)) understoodGroups.delete(gid);
            else understoodGroups.add(gid);
            saveUnderstood();
            renderBody();
          }
        }
      });

      renderHeader();
      renderBody();
    })();
  </script>
</body>
</html>
`;
}
