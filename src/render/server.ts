import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { discoverRuleDocs, loadConfig } from "../config/loader.ts";
import {
  loadUserSettings,
  PROVIDER_PRESETS,
  recordRecentRepo,
  saveUserSettings,
  toMaskedUserSettings,
  type UserSettings,
} from "../config/user-settings.ts";
import {
  extractRepoDiff,
  inspectGitRepo,
  listNearbyGitRepos,
  resolveGitTopLevel,
  type DiffTarget,
} from "../diff/git-source.ts";
import { detectInstalledAuthorClis } from "../llm/author-adapter.ts";
import { createLLMClient } from "../llm/providers.ts";
import { auditLedgerLines } from "../pipeline/auditor.ts";
import { explainLedger } from "../pipeline/explainer.ts";
import { attachFindingsToHunks } from "../pipeline/integrity.ts";
import { buildInitialLedger } from "../pipeline/ledger.ts";
import { runSymmetricProofReview } from "../pipeline/reviewer.ts";
import { enrichLedgerProvenance } from "../provenance/capture.ts";
import { recordAndVerifyAnswer } from "../provenance/questioner.ts";
import {
  evaluateStructuredRules,
  loadStructuredRules,
} from "../rules/engine.ts";
import type {
  DiffglossConfig,
  EffortLevel,
  ExplanationLedger,
  ProviderDialect,
} from "../schema/types.ts";
import { renderHtmlReport } from "./html.ts";

export interface PreviewServerOptions {
  port: number;
  cwd?: string;
  ledger: ExplanationLedger;
  jsonOutPath?: string;
  htmlOutPath?: string;
  config?: DiffglossConfig;
  homeDir?: string;
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? (JSON.parse(body) as Record<string, unknown>) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function persistLedger(
  ledger: ExplanationLedger,
  jsonOutPath?: string,
  htmlOutPath?: string,
): void {
  if (jsonOutPath) {
    mkdirSync(path.dirname(jsonOutPath), { recursive: true });
    writeFileSync(jsonOutPath, JSON.stringify(ledger, null, 2), "utf8");
  }
  if (htmlOutPath) {
    mkdirSync(path.dirname(htmlOutPath), { recursive: true });
    writeFileSync(htmlOutPath, renderHtmlReport(ledger, { liveServer: false }), "utf8");
  }
}

function parseSettingsPatch(body: Record<string, unknown>): Partial<UserSettings> {
  const patch: Partial<UserSettings> = {};
  if (body.explainer_mode === "author_cli" || body.explainer_mode === "api_model") {
    patch.explainer_mode = body.explainer_mode;
  }
  if (
    body.author_cli === "auto" ||
    body.author_cli === "claude-cli" ||
    body.author_cli === "codex-cli"
  ) {
    patch.author_cli = body.author_cli;
  }
  if (typeof body.preset === "string") patch.preset = body.preset;
  if (typeof body.provider === "string") patch.provider = body.provider as ProviderDialect;
  if (typeof body.model === "string") patch.model = body.model.trim();
  if (typeof body.base_url === "string") patch.base_url = body.base_url.trim();
  if (typeof body.api_key === "string" && body.api_key.trim()) {
    patch.api_key = body.api_key.trim();
  } else if (body.clear_api_key === true) {
    (patch as Record<string, unknown>).api_key = null;
  }
  if (typeof body.judge_provider === "string") {
    patch.judge_provider = body.judge_provider
      ? (body.judge_provider as ProviderDialect)
      : (null as unknown as ProviderDialect);
  }
  if (typeof body.judge_model === "string") {
    patch.judge_model = body.judge_model.trim() || (null as unknown as string);
  }
  if (typeof body.judge_base_url === "string") {
    patch.judge_base_url =
      body.judge_base_url.trim() || (null as unknown as string);
  }
  if (typeof body.judge_api_key === "string" && body.judge_api_key.trim()) {
    patch.judge_api_key = body.judge_api_key.trim();
  } else if (body.clear_judge_api_key === true) {
    (patch as Record<string, unknown>).judge_api_key = null;
  }
  if (typeof body.effort === "string") patch.effort = body.effort as EffortLevel;
  if (typeof body.budget_usd === "number" && Number.isFinite(body.budget_usd)) {
    patch.budget_usd = body.budget_usd;
  }
  if (typeof body.enable_judge === "boolean") patch.enable_judge = body.enable_judge;
  if (typeof body.enable_line_audit === "boolean") {
    patch.enable_line_audit = body.enable_line_audit;
  }
  if (typeof body.enable_review === "boolean") patch.enable_review = body.enable_review;
  return patch;
}

export function startPreviewServer(options: PreviewServerOptions): http.Server {
  let currentRepoPath =
    resolveGitTopLevel(options.cwd ?? process.cwd()) ??
    path.resolve(options.cwd ?? process.cwd());
  const { port, jsonOutPath, htmlOutPath, homeDir } = options;
  let currentLedger = options.ledger;

  const getEffectiveConfig = (inlinePatch?: Partial<UserSettings>): DiffglossConfig => {
    const saved = { ...loadUserSettings(homeDir), ...(inlinePatch ?? {}) };
    return loadConfig(currentRepoPath, {
      ...(options.config ?? {}),
      ...(saved.explainer_mode ? { explainer_mode: saved.explainer_mode } : {}),
      ...(saved.author_cli ? { author_cli: saved.author_cli } : {}),
      ...(saved.provider ? { provider: saved.provider } : {}),
      ...(saved.model ? { model: saved.model } : {}),
      ...(saved.base_url ? { base_url: saved.base_url } : {}),
      ...(saved.api_key ? { api_key: saved.api_key } : {}),
      ...(saved.judge_provider ? { judge_provider: saved.judge_provider } : {}),
      ...(saved.judge_model ? { judge_model: saved.judge_model } : {}),
      ...(saved.judge_base_url ? { judge_base_url: saved.judge_base_url } : {}),
      ...(saved.judge_api_key ? { judge_api_key: saved.judge_api_key } : {}),
      ...(saved.effort ? { effort: saved.effort } : {}),
      ...(saved.budget_usd !== undefined ? { budget_usd: saved.budget_usd } : {}),
    });
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

    if (req.method === "GET" && url.pathname === "/") {
      const html = renderHtmlReport(currentLedger, { liveServer: true });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, repo: currentRepoPath, version: "0.3.0" }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/ledger") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(currentLedger, null, 2));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/repo") {
      try {
        const reqPath = url.searchParams.get("path")?.trim() || currentRepoPath;
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw ? Math.min(100, Math.max(5, Number.parseInt(limitRaw, 10) || 30)) : 30;
        const repo = inspectGitRepo(reqPath, limit);
        const saved = loadUserSettings(homeDir);
        const nearby = listNearbyGitRepos(repo.repo_path);

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            repo,
            recent_repos: saved.recent_repos ?? [repo.repo_path],
            nearby_repos: nearby,
          }),
        );
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/load-diff") {
      try {
        const body = await readJsonBody(req);
        const repoPath =
          typeof body.repo_path === "string" && body.repo_path.trim()
            ? body.repo_path.trim()
            : currentRepoPath;
        const mode = String(body.mode ?? "working");

        let target: DiffTarget;
        if (mode === "staged") {
          target = { mode: "staged" };
        } else if (mode === "commit") {
          target = { mode: "commit", sha: String(body.sha ?? "HEAD") };
        } else if (mode === "range") {
          target = { mode: "range", range: String(body.range ?? "HEAD~1..HEAD") };
        } else {
          target = { mode: "working" };
        }

        const repo = inspectGitRepo(repoPath, 30);
        currentRepoPath = repo.repo_path;
        let recent: string[] = [currentRepoPath];
        try {
          recent = recordRecentRepo(currentRepoPath, homeDir);
        } catch {
          // Non-fatal in read-only or sandboxed HOME environments
        }
        const extracted = extractRepoDiff(currentRepoPath, target);
        const cfg = getEffectiveConfig();

        const ledger = buildInitialLedger(extracted.raw_diff, {
          cwd: currentRepoPath,
          title: extracted.title,
          declaredIntent: extracted.declared_intent,
          declaredIntentRef: extracted.declared_intent_ref,
          source: {
            repo: repo.name,
            base_ref: extracted.base_ref,
            head_ref: extracted.head_ref,
            diff_args: extracted.diff_args,
          },
          splitLargeHunks: cfg.split_large_hunks,
          subhunkLineThreshold: cfg.subhunk_line_threshold,
          ignorePatterns: cfg.ignore,
        });

        const rules = loadStructuredRules(currentRepoPath, {
          baseRef: extracted.base_ref,
          rulesFromBase: cfg.rules_from_base,
        });
        const ruleEval = evaluateStructuredRules(rules, ledger.hunks);
        if (ruleEval.findings.length > 0) {
          const merged = [...(ledger.findings ?? []), ...ruleEval.findings];
          attachFindingsToHunks(ledger.hunks, merged);
          ledger.findings = merged;
        }
        if (ruleEval.telemetry.length > 0) {
          ledger.rule_telemetry = ruleEval.telemetry;
        }

        enrichLedgerProvenance(ledger, {
          cwd: currentRepoPath,
          autoDiscover: true,
          redact: cfg.redact_secrets,
        });

        currentLedger = ledger;
        persistLedger(currentLedger, jsonOutPath, htmlOutPath);

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            ledger: currentLedger,
            repo,
            recent_repos: recent,
            target_label: extracted.label,
          }),
        );
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/settings") {
      const saved = loadUserSettings(homeDir);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          settings: toMaskedUserSettings(saved, homeDir),
          presets: PROVIDER_PRESETS,
          detected_clis: detectInstalledAuthorClis(),
        }),
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/settings") {
      try {
        const body = await readJsonBody(req);
        const saved = saveUserSettings(parseSettingsPatch(body), homeDir);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            settings: toMaskedUserSettings(saved, homeDir),
          }),
        );
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/settings/test") {
      const start = Date.now();
      try {
        const body = await readJsonBody(req);
        const saved = loadUserSettings(homeDir);
        const provider =
          (typeof body.provider === "string" && body.provider
            ? (body.provider as ProviderDialect)
            : saved.provider) ?? "deepseek";
        const model =
          (typeof body.model === "string" && body.model.trim()
            ? body.model.trim()
            : saved.model) ?? "deepseek-chat";
        const baseUrl =
          typeof body.base_url === "string" && body.base_url.trim()
            ? body.base_url.trim()
            : saved.base_url;
        const apiKey =
          typeof body.api_key === "string" && body.api_key.trim()
            ? body.api_key.trim()
            : saved.api_key;

        const client = createLLMClient({ provider, model, baseUrl, apiKey });
        const pong = await client.complete({
          system: "Reply with exactly OK.",
          messages: [{ role: "user", content: "Ping" }],
          maxTokens: 16,
          temperature: 0,
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            provider: client.provider,
            model: client.model,
            latency_ms: Date.now() - start,
            reply: pong.text.trim().slice(0, 60),
          }),
        );
      } catch (err) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            latency_ms: Date.now() - start,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
      return;
    }

    if (req.method === "POST" && (url.pathname === "/api/explain" || url.pathname === "/api/explain-stream")) {
      const isStream = url.pathname === "/api/explain-stream";
      const sendEvent = (event: string, data: unknown): void => {
        if (!isStream) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      try {
        const body = await readJsonBody(req);
        if (isStream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
        }
        let inlinePatch: Partial<UserSettings> | undefined;
        if (body.settings && typeof body.settings === "object") {
          inlinePatch = parseSettingsPatch(body.settings as Record<string, unknown>);
          try {
            saveUserSettings(inlinePatch, homeDir);
          } catch {
            // Non-fatal in read-only HOME
          }
        }
        const saved = { ...loadUserSettings(homeDir), ...(inlinePatch ?? {}) };
        const cfg = getEffectiveConfig(inlinePatch);

        const intentText =
          typeof body.declared_intent === "string"
            ? body.declared_intent.trim()
            : currentLedger.overview.declared_intent;
        const workingLedger: ExplanationLedger = {
          ...structuredClone(currentLedger),
          overview: {
            ...currentLedger.overview,
            declared_intent: intentText || undefined,
            declared_intent_ref: intentText
              ? currentLedger.overview.declared_intent_ref === "none"
                ? "prompt"
                : currentLedger.overview.declared_intent_ref ?? "prompt"
              : "none",
          },
        };

        for (const h of workingLedger.hunks) {
          if (h.status !== "collapsed") {
            h.status = "unexplained";
            delete h.what;
            delete h.audit;
          }
        }

        const baseRef = workingLedger.source?.base_ref;
        const changedPaths = [...new Set(workingLedger.hunks.map((h) => h.path))];
        const ruleDocs = discoverRuleDocs(currentRepoPath, changedPaths, {
          baseRef,
          rulesFromBase: cfg.rules_from_base,
        });
        const runLineAudit =
          typeof body.enable_line_audit === "boolean"
            ? body.enable_line_audit
            : saved.enable_line_audit ?? true;
        const runJudge =
          typeof body.enable_judge === "boolean"
            ? body.enable_judge
            : saved.enable_judge ?? false;
        const runReview =
          typeof body.enable_review === "boolean"
            ? body.enable_review
            : saved.enable_review ?? false;

        sendEvent("stage", {
          stage: "explaining",
          done: 0,
          total: workingLedger.hunks.filter((h) => h.status !== "collapsed").length,
          message: `Explaining via ${cfg.explainer_mode === "author_cli" ? `Author CLI (${cfg.author_cli ?? "auto"})` : `${cfg.provider}/${cfg.model}`}...`,
        });

        let updated = await explainLedger(workingLedger, {
          cwd: currentRepoPath,
          config: cfg,
          ruleDocs,
          runJudge: runLineAudit ? false : runJudge,
          useCache: body.bypass_cache !== true,
          onProgress: (stage, done, total, message) => {
            sendEvent("stage", { stage, done, total, message });
          },
        });

        sendEvent("ledger", { ledger: updated });

        if (runLineAudit) {
          const auditTargets = updated.hunks.filter(
            (h) => h.status !== "collapsed" && Boolean(h.what?.text),
          ).length;
          sendEvent("stage", {
            stage: "auditing",
            done: 0,
            total: auditTargets,
            message: `Independent Reviewer auditing every changed line (${cfg.judge_model ?? cfg.model})...`,
          });
          updated = await auditLedgerLines(updated, {
            config: cfg,
            onHunkAudited: (hunk, done, total) => {
              sendEvent("stage", {
                stage: "auditing",
                done,
                total,
                message: `Audited ${done}/${total}: ${hunk.path} (${hunk.audit?.status ?? "done"})`,
              });
            },
          });
          sendEvent("ledger", { ledger: updated });
        }

        if (runReview) {
          sendEvent("stage", {
            stage: "reviewing",
            done: 0,
            total: 1,
            message: "Running isolated parallel specialists (Symmetric Proof)...",
          });
          const rules = loadStructuredRules(currentRepoPath, {
            baseRef,
            rulesFromBase: cfg.rules_from_base,
          });
          const ruleEval = evaluateStructuredRules(rules, updated.hunks);
          updated = await runSymmetricProofReview(updated, {
            config: cfg,
            scopedLlmRules: ruleEval.scopedLlmRules,
            ruleTelemetry: ruleEval.telemetry,
          });
        }

        currentLedger = updated;
        persistLedger(currentLedger, jsonOutPath, htmlOutPath);

        if (isStream) {
          sendEvent("done", { ok: true, ledger: currentLedger });
          res.end();
        } else {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, ledger: currentLedger }));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isStream) {
          if (!res.headersSent) {
            res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
          }
          sendEvent("error", { ok: false, error: msg });
          res.end();
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: msg }));
        }
      }
      return;
    }

    const answerMatch = /^\/api\/questions\/([^/]+)\/answer$/.exec(url.pathname);
    if (req.method === "POST" && answerMatch) {
      try {
        const qid = decodeURIComponent(answerMatch[1]!);
        const body = await readJsonBody(req);
        const text = String(body.text ?? "").trim();
        if (!text) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Answer text is required." }));
          return;
        }
        const answeredBy = String(body.answered_by ?? "human (browser)");
        const outcome = await recordAndVerifyAnswer(currentLedger, qid, text, {
          answeredBy,
          channel: "human",
          config: body.verify ? getEffectiveConfig() : undefined,
        });
        persistLedger(currentLedger, jsonOutPath, htmlOutPath);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, outcome, ledger: currentLedger }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`Diffgloss Workbench running at http://127.0.0.1:${port}`);
    console.log("  - Click '📂 Repo / Commit' to switch repos or browse any commit/diff");
    console.log("  - Click '⚙ Models' to configure API keys & run AI explain in-page");
    console.log("  - Shortcuts: j/k nav · s split/unified · / search · u understood");
    console.log("Press Ctrl+C to stop.");
  });

  return server;
}
