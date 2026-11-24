import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { recordAndVerifyAnswer } from "../provenance/questioner.ts";
import type { DiffglossConfig, ExplanationLedger } from "../schema/types.ts";
import { renderHtmlReport } from "./html.ts";

export interface PreviewServerOptions {
  port: number;
  ledger: ExplanationLedger;
  jsonOutPath?: string;
  htmlOutPath?: string;
  config?: DiffglossConfig;
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
    writeFileSync(htmlOutPath, renderHtmlReport(ledger, { liveServer: true }), "utf8");
  }
}

export function startPreviewServer(options: PreviewServerOptions): http.Server {
  const { port, ledger, jsonOutPath, htmlOutPath, config } = options;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

    if (req.method === "GET" && url.pathname === "/") {
      const html = renderHtmlReport(ledger, { liveServer: true });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/ledger") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(ledger, null, 2));
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
        const outcome = await recordAndVerifyAnswer(ledger, qid, text, {
          answeredBy,
          channel: "human",
          config: body.verify ? config : undefined,
        });
        persistLedger(ledger, jsonOutPath, htmlOutPath);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, outcome, ledger }));
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
    console.log(`Diffgloss browser UI running at http://127.0.0.1:${port}`);
    console.log("Shortcuts: j/k next/prev hunk · s split/unified · / search · u understood");
    console.log("Press Ctrl+C to stop.");
  });

  return server;
}
