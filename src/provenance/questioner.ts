import { execFileSync } from "node:child_process";
import { createLLMClient, extractJsonFromText } from "../llm/providers.ts";
import type { LLMClient } from "../llm/types.ts";
import type {
  DiffglossConfig,
  ExplanationLedger,
  QuestionChannel,
} from "../schema/types.ts";
import { computeCoverage } from "../schema/validate.ts";
import { redactSecrets } from "./redactor.ts";

const ANSWER_VERIFIER_SYSTEM_PROMPT = `ANSWER_VERIFIER:
You are an independent, cold-start verifier checking an author's explanation for a code hunk.
Never accept the author's claim on trust. Check whether the answer is directly consistent with the unified diff patch and cites concrete code, invariants, or tests.
Return ONLY valid JSON:
{
  "status": "confirmed" | "refuted" | "unverifiable",
  "evidence": ["concise evidence point 1", "..."]
}`;

export interface VerifyAnswerOptions {
  config?: DiffglossConfig;
  answeredBy?: string;
  channel?: QuestionChannel;
  sessionForked?: boolean;
  verifierClient?: LLMClient;
  redact?: boolean;
}

export interface AnswerVerificationOutcome {
  questionId: string;
  verdict: "confirmed" | "refuted" | "unverifiable";
  evidence: string[];
  promotedHunks: string[];
}

/**
 * Records an answer (human or resumed coding agent) on a clarifying question and runs
 * a cold-start verification against the actual diff hunks.
 * Only promotes a hunk out of `unexplained` if verified as `confirmed` AND structural
 * `what.citations_valid` holds; refuted/unverifiable answers stay pinned as unexplained.
 */
export async function recordAndVerifyAnswer(
  ledger: ExplanationLedger,
  questionId: string,
  rawAnswerText: string,
  options: VerifyAnswerOptions = {},
): Promise<AnswerVerificationOutcome> {
  const question = ledger.questions.find((q) => q.id === questionId);
  if (!question) {
    throw new Error(`Question '${questionId}' not found in ledger.`);
  }

  const safeText =
    options.redact === false
      ? rawAnswerText
      : redactSecrets(rawAnswerText).text;

  if (options.channel) question.channel = options.channel;
  question.answer = {
    text: safeText,
    answered_by: options.answeredBy ?? "human",
    at: new Date().toISOString(),
    session_forked: options.sessionForked,
  };

  const targetHunks = question.hunk_ids
    .map((id) => ledger.hunks.find((h) => h.id === id))
    .filter((h): h is NonNullable<typeof h> => Boolean(h));

  let verdictStatus: "confirmed" | "refuted" | "unverifiable" = "unverifiable";
  let evidence: string[] = [];
  let verifierModel = "deterministic-fallback";

  const client =
    options.verifierClient ??
    (options.config
      ? createLLMClient({
          provider: options.config.judge_provider ?? options.config.provider,
          model: options.config.judge_model ?? options.config.model,
          baseUrl: options.config.judge_base_url ?? options.config.base_url,
          apiKeyEnv:
            options.config.judge_api_key_env ?? options.config.api_key_env,
        })
      : undefined);

  if (client) {
    verifierModel = client.model;
    const prompt = `Trigger: ${question.trigger}
Question asked:
${question.question}

Author answer (UNVERIFIED CLAIM):
${safeText}

Target diff hunk(s):
${targetHunks
  .map((h) => `--- ${h.path} (${h.id}) ---\n${h.patch}`)
  .join("\n\n")}`;

    const res = await client.complete({
      system: ANSWER_VERIFIER_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 600,
      temperature: 0,
      jsonMode: true,
    });

    const parsed = extractJsonFromText<{
      status?: "confirmed" | "refuted" | "unverifiable";
      evidence?: string[];
    }>(res.text);

    verdictStatus = parsed.status ?? "unverifiable";
    evidence = parsed.evidence ?? [];
  } else {
    // Deterministic offline heuristic when no LLM verifier is configured
    const citesCode = /[A-Za-z0-9_/-]+\.[a-z]+(?::\d+)?/.test(safeText);
    verdictStatus = citesCode ? "unverifiable" : "unverifiable";
    evidence = [
      "Recorded without an LLM verifier; pass --verify with a configured provider to run cold-start verification.",
    ];
  }

  question.verdict = {
    status: verdictStatus,
    verifier_model: verifierModel,
    evidence,
  };

  const promotedHunks: string[] = [];
  for (const hunk of targetHunks) {
    hunk.why = {
      text: safeText,
      source: "author_answer",
      evidence: evidence.map((ev, idx) => ({
        kind: "call_site",
        ref: `qa:${question.id}#${idx + 1}`,
        excerpt: ev,
      })),
      verification: verdictStatus,
    };

    if (verdictStatus === "confirmed" && hunk.what?.citations_valid) {
      hunk.status = "explained";
      promotedHunks.push(hunk.id);
    }
  }

  ledger.coverage = computeCoverage(ledger.hunks);

  return {
    questionId,
    verdict: verdictStatus,
    evidence,
    promotedHunks,
  };
}

/**
 * Tier 3: Headless read-only session resume for Claude Code or Codex.
 * Always asks for concrete file:line or test evidence and disallows file writes.
 */
export function askAuthorAgentSession(
  agent: "claude" | "codex",
  sessionId: string,
  question: string,
  cwd: string,
): { text: string; answeredBy: string; sessionForked: boolean } {
  const prompt = `Read-only clarification request from Diffgloss code review. Do NOT modify any files. Answer concisely with exact file:line or test citations:\n\n${question}`;

  if (agent === "claude") {
    // Prefer --fork-session so questioning never mutates the author's primary session
    try {
      const out = execFileSync(
        "claude",
        [
          "-p",
          "--resume",
          sessionId,
          "--fork-session",
          "--permission-mode",
          "plan",
          prompt,
        ],
        { cwd, encoding: "utf8", maxBuffer: 5 * 1024 * 1024 },
      );
      return {
        text: out.trim(),
        answeredBy: `claude-code@${sessionId}`,
        sessionForked: true,
      };
    } catch {
      const out = execFileSync(
        "claude",
        ["-p", "--resume", sessionId, "--permission-mode", "plan", prompt],
        { cwd, encoding: "utf8", maxBuffer: 5 * 1024 * 1024 },
      );
      return {
        text: out.trim(),
        answeredBy: `claude-code@${sessionId}`,
        sessionForked: false,
      };
    }
  }

  const out = execFileSync(
    "codex",
    ["exec", "resume", sessionId, prompt],
    { cwd, encoding: "utf8", maxBuffer: 5 * 1024 * 1024 },
  );
  return {
    text: out.trim(),
    answeredBy: `codex@${sessionId}`,
    sessionForked: false,
  };
}
