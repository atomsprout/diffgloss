import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { discoverRuleDocs, loadConfig } from "../config/loader.ts";
import { buildInitialLedger } from "../pipeline/ledger.ts";
import { enrichLedgerProvenance } from "../provenance/capture.ts";
import { recordAndVerifyAnswer } from "../provenance/questioner.ts";
import { renderHtmlReport } from "../render/html.ts";
import { loadStructuredRules } from "../rules/engine.ts";
import type { ExplanationLedger } from "../schema/types.ts";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

const MCP_TOOLS = [
  {
    name: "diffgloss_inspect",
    description:
      "Inspect a git diff range (or raw unified diff), classify mechanical noise, enforce coverage accounting, and write .diffgloss/ledger.json + .diffgloss/report.html.",
    inputSchema: {
      type: "object",
      properties: {
        range: { type: "string", description: "Git diff range, e.g. 'main..HEAD' or '--staged'" },
        diff: { type: "string", description: "Optional raw unified diff string" },
        intent: { type: "string", description: "Declared intent for this change" },
      },
    },
  },
  {
    name: "diffgloss_explain_hunk",
    description:
      "Return full details, diff patch, enclosing AST symbol, provenance, findings, and open questions for a specific hunk_id from a Diffgloss ledger.",
    inputSchema: {
      type: "object",
      required: ["hunk_id"],
      properties: {
        hunk_id: { type: "string" },
        ledger_path: { type: "string", description: "Defaults to .diffgloss/ledger.json" },
      },
    },
  },
  {
    name: "diffgloss_list_rules",
    description:
      "List all active Diffgloss review rules (REVIEW.md, AGENTS.md, CLAUDE.md, and .diffgloss/rules/*.md) with trust source.",
    inputSchema: {
      type: "object",
      properties: {
        base_ref: { type: "string", description: "Optional base git ref to read trusted rules from" },
      },
    },
  },
  {
    name: "diffgloss_record_answer",
    description:
      "Record an evidence-backed answer to an unexplained hunk's clarifying question in a Diffgloss ledger.",
    inputSchema: {
      type: "object",
      required: ["question_id", "answer"],
      properties: {
        question_id: { type: "string" },
        answer: { type: "string" },
        answered_by: { type: "string" },
        ledger_path: { type: "string", description: "Defaults to .diffgloss/ledger.json" },
      },
    },
  },
];

export async function handleMcpRequest(
  req: JsonRpcRequest,
  cwd: string,
): Promise<JsonRpcResponse | null> {
  if (req.id === undefined) {
    // Notification (e.g. notifications/initialized) — no response required
    return null;
  }

  if (req.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: req.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "diffgloss", version: "0.2.0" },
      },
    };
  }

  if (req.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id: req.id,
      result: { tools: MCP_TOOLS },
    };
  }

  if (req.method === "tools/call") {
    const params = req.params ?? {};
    const name = String(params.name ?? "");
    const args = (params.arguments as Record<string, unknown> | undefined) ?? {};

    try {
      if (name === "diffgloss_inspect") {
        const cfg = loadConfig(cwd);
        const rawDiff =
          typeof args.diff === "string"
            ? args.diff
            : execFileSync(
                "git",
                [
                  "diff",
                  "--no-color",
                  ...(typeof args.range === "string" && args.range.trim()
                    ? args.range.trim().split(/\s+/)
                    : []),
                ],
                { cwd, encoding: "utf8", maxBuffer: 25 * 1024 * 1024 },
              );

        const ledger = buildInitialLedger(rawDiff, {
          cwd,
          title: `Diffgloss: ${path.basename(cwd)}`,
          declaredIntent: typeof args.intent === "string" ? args.intent : undefined,
          splitLargeHunks: cfg.split_large_hunks,
          subhunkLineThreshold: cfg.subhunk_line_threshold,
          ignorePatterns: cfg.ignore,
        });
        enrichLedgerProvenance(ledger, { cwd, redact: cfg.redact_secrets });

        const outDir = path.join(cwd, ".diffgloss");
        mkdirSync(outDir, { recursive: true });
        const ledgerPath = path.join(outDir, "ledger.json");
        const htmlPath = path.join(outDir, "report.html");
        writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");
        writeFileSync(htmlPath, renderHtmlReport(ledger), "utf8");

        return {
          jsonrpc: "2.0",
          id: req.id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    coverage: ledger.coverage,
                    questions: ledger.questions,
                    findings: ledger.findings ?? [],
                    ledger_path: ledgerPath,
                    html_path: htmlPath,
                  },
                  null,
                  2,
                ),
              },
            ],
          },
        };
      }

      if (name === "diffgloss_explain_hunk") {
        const ledgerPath = path.resolve(
          cwd,
          typeof args.ledger_path === "string"
            ? args.ledger_path
            : ".diffgloss/ledger.json",
        );
        if (!existsSync(ledgerPath)) {
          throw new Error(`Ledger not found at ${ledgerPath}. Run diffgloss_inspect first.`);
        }
        const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as ExplanationLedger;
        const hunk = ledger.hunks.find((h) => h.id === String(args.hunk_id));
        if (!hunk) throw new Error(`Hunk '${String(args.hunk_id)}' not found.`);
        const questions = ledger.questions.filter((q) =>
          q.hunk_ids.includes(hunk.id),
        );
        const findings = (ledger.findings ?? []).filter(
          (f) => f.hunk_id === hunk.id,
        );
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ hunk, questions, findings }, null, 2),
              },
            ],
          },
        };
      }

      if (name === "diffgloss_list_rules") {
        const baseRef =
          typeof args.base_ref === "string" ? args.base_ref : undefined;
        const docs = discoverRuleDocs(cwd, [], { baseRef });
        const structured = loadStructuredRules(cwd, { baseRef });
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    markdown_docs: docs.map((d) => ({
                      path: d.path,
                      source: d.source,
                      bytes: d.content.length,
                    })),
                    structured_rules: structured.map((r) => ({
                      id: r.id,
                      title: r.title,
                      kind: r.kind,
                      severity: r.severity,
                      include: r.include,
                      source: r.source,
                    })),
                  },
                  null,
                  2,
                ),
              },
            ],
          },
        };
      }

      if (name === "diffgloss_record_answer") {
        const ledgerPath = path.resolve(
          cwd,
          typeof args.ledger_path === "string"
            ? args.ledger_path
            : ".diffgloss/ledger.json",
        );
        const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as ExplanationLedger;
        const outcome = await recordAndVerifyAnswer(
          ledger,
          String(args.question_id),
          String(args.answer),
          {
            answeredBy:
              typeof args.answered_by === "string"
                ? args.answered_by
                : "mcp-agent",
            channel: "acp",
          },
        );
        writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: {
            content: [{ type: "text", text: JSON.stringify(outcome, null, 2) }],
          },
        };
      }

      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: `Unknown tool: ${name}` },
      };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: {
          code: -32000,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  return {
    jsonrpc: "2.0",
    id: req.id,
    error: { code: -32601, message: `Method not found: ${req.method}` },
  };
}

/**
 * Starts a stdio MCP server accepting newline-delimited JSON-RPC 2.0 requests.
 */
export function startMcpStdioServer(cwd: string): void {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("Content-Length:")) continue;
      try {
        const req = JSON.parse(trimmed) as JsonRpcRequest;
        const res = await handleMcpRequest(req, cwd);
        if (res) {
          process.stdout.write(`${JSON.stringify(res)}\n`);
        }
      } catch (err) {
        const errRes: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: err instanceof Error ? err.message : "Parse error",
          },
        };
        process.stdout.write(`${JSON.stringify(errRes)}\n`);
      }
    }
  });
}
