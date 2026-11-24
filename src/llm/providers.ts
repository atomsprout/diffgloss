import type { ProviderDialect } from "../schema/types.ts";
import { estimateTokens } from "./budget.ts";
import type { LLMClient, LLMClientConfig, LLMRequest, LLMResponse } from "./types.ts";

export function extractJsonFromText<T>(raw: string): T {
  const trimmed = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate) as T;
  } catch {
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(candidate.slice(firstBrace, lastBrace + 1)) as T;
    }
    throw new Error(
      `Failed to parse JSON from LLM output. Preview: ${candidate.slice(0, 240)}`,
    );
  }
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs = 120_000,
  maxRetries = 2,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      if (
        res.ok ||
        (res.status < 500 && res.status !== 429) ||
        attempt === maxRetries
      ) {
        return res;
      }
      const backoffMs = 500 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, backoffMs));
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (attempt === maxRetries) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastError;
}

function resolveApiKey(
  dialect: ProviderDialect,
  explicit?: string,
  envName?: string,
): string {
  if (explicit) return explicit;
  if (envName && process.env[envName]) return process.env[envName]!;

  if (dialect === "anthropic") {
    return process.env.ANTHROPIC_API_KEY ?? "";
  }
  if (dialect === "openai" || dialect === "openai-chat") {
    return process.env.OPENAI_API_KEY ?? process.env.OPENROUTER_API_KEY ?? "";
  }
  if (dialect === "deepseek") {
    return process.env.DEEPSEEK_API_KEY ?? "";
  }
  if (dialect === "google") {
    return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";
  }
  return "";
}

class AnthropicClient implements LLMClient {
  readonly provider: ProviderDialect = "anthropic";
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(cfg: LLMClientConfig) {
    this.model = cfg.model;
    this.baseUrl = (cfg.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.apiKey = resolveApiKey("anthropic", cfg.apiKey, cfg.apiKeyEnv);
    this.timeoutMs = cfg.timeoutMs ?? 120_000;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    if (!this.apiKey) {
      throw new Error(
        "Missing Anthropic API key. Set ANTHROPIC_API_KEY or configure api_key_env in diffgloss.yaml.",
      );
    }

    const res = await fetchWithRetry(
      `${this.baseUrl}/v1/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: req.maxTokens ?? 4096,
          temperature: req.temperature ?? 0,
          system: [
            {
              type: "text",
              text: req.system,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: req.messages,
        }),
      },
      this.timeoutMs,
    );

    if (!res.ok) {
      throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
      };
    };

    const text = (data.content ?? [])
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n");

    return {
      text,
      model: this.model,
      provider: this.provider,
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
        cachedInputTokens: data.usage?.cache_read_input_tokens ?? 0,
      },
    };
  }
}

class OpenAIResponsesClient implements LLMClient {
  readonly provider: ProviderDialect = "openai";
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(cfg: LLMClientConfig) {
    this.model = cfg.model;
    this.baseUrl = (cfg.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");
    this.apiKey = resolveApiKey("openai", cfg.apiKey, cfg.apiKeyEnv);
    this.timeoutMs = cfg.timeoutMs ?? 120_000;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    if (!this.apiKey && this.baseUrl.includes("api.openai.com")) {
      throw new Error(
        "Missing OpenAI API key. Set OPENAI_API_KEY or configure api_key_env in diffgloss.yaml.",
      );
    }

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const res = await fetchWithRetry(
      `${this.baseUrl}/v1/responses`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.model,
          instructions: req.system,
          input: req.messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          max_output_tokens: req.maxTokens ?? 4096,
          ...(req.jsonMode ? { text: { format: { type: "json_object" } } } : {}),
        }),
      },
      this.timeoutMs,
    );

    if (!res.ok) {
      throw new Error(`OpenAI Responses API error ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ text?: string }> }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        input_tokens_details?: { cached_tokens?: number };
      };
    };

    const text =
      data.output_text ??
      (data.output ?? [])
        .flatMap((o) => o.content ?? [])
        .map((c) => c.text ?? "")
        .join("\n");

    return {
      text,
      model: this.model,
      provider: this.provider,
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
        cachedInputTokens: data.usage?.input_tokens_details?.cached_tokens ?? 0,
      },
    };
  }
}

class OpenAIChatClient implements LLMClient {
  readonly provider: ProviderDialect;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(cfg: LLMClientConfig) {
    this.provider = cfg.provider;
    this.model = cfg.model;
    this.baseUrl = (cfg.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");
    this.apiKey = resolveApiKey(cfg.provider, cfg.apiKey, cfg.apiKeyEnv);
    this.timeoutMs = cfg.timeoutMs ?? 120_000;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const endpoint = this.baseUrl.endsWith("/v1")
      ? `${this.baseUrl}/chat/completions`
      : `${this.baseUrl}/v1/chat/completions`;

    const res = await fetchWithRetry(
      endpoint,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.model,
          temperature: req.temperature ?? 0,
          max_tokens: req.maxTokens ?? 4096,
          ...(req.jsonMode ? { response_format: { type: "json_object" } } : {}),
          messages: [
            { role: "system", content: req.system },
            ...req.messages,
          ],
        }),
      },
      this.timeoutMs,
    );

    if (!res.ok) {
      throw new Error(`OpenAI Chat API error ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
    };

    return {
      text: data.choices?.[0]?.message?.content ?? "",
      model: this.model,
      provider: this.provider,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        cachedInputTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
    };
  }
}

class GoogleGenAIClient implements LLMClient {
  readonly provider: ProviderDialect = "google";
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(cfg: LLMClientConfig) {
    this.model = cfg.model;
    this.baseUrl = (
      cfg.baseUrl ?? "https://generativelanguage.googleapis.com"
    ).replace(/\/$/, "");
    this.apiKey = resolveApiKey("google", cfg.apiKey, cfg.apiKeyEnv);
    this.timeoutMs = cfg.timeoutMs ?? 120_000;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    if (!this.apiKey) {
      throw new Error(
        "Missing Google API key. Set GEMINI_API_KEY or GOOGLE_API_KEY.",
      );
    }

    const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const res = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.system }] },
          contents: req.messages.map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          })),
          generationConfig: {
            temperature: req.temperature ?? 0,
            maxOutputTokens: req.maxTokens ?? 4096,
            ...(req.jsonMode ? { responseMimeType: "application/json" } : {}),
          },
        }),
      },
      this.timeoutMs,
    );

    if (!res.ok) {
      throw new Error(`Google GenAI API error ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        cachedContentTokenCount?: number;
      };
    };

    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("\n");

    return {
      text,
      model: this.model,
      provider: this.provider,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        cachedInputTokens: data.usageMetadata?.cachedContentTokenCount ?? 0,
      },
    };
  }
}

/**
 * Deterministic offline mock provider used for tests, CI dry-runs, and golden evals.
 * Inspects the structured hunk payloads embedded in the prompt and returns grounded JSON.
 */
export class MockLLMClient implements LLMClient {
  readonly provider: ProviderDialect = "mock";
  readonly model: string;

  constructor(model = "mock-explainer-v0") {
    this.model = model;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const promptText = req.messages.map((m) => m.content).join("\n");
    const inputTokens = estimateTokens(req.system + promptText);

    // Handle semantic grounding judge requests
    if (req.system.includes("SEMANTIC_GROUNDING_JUDGE")) {
      const verdict = {
        verdict: "judge_passed",
        note: "Mock semantic judge verified explanation consistency with diff.",
      };
      const text = JSON.stringify(verdict);
      return {
        text,
        model: this.model,
        provider: this.provider,
        usage: { inputTokens, outputTokens: estimateTokens(text), cachedInputTokens: 0 },
      };
    }

    // Handle answer verifier requests
    if (req.system.includes("ANSWER_VERIFIER")) {
      const hasFileRef = /[A-Za-z0-9_/-]+\.[a-z]+:\d+/.test(promptText);
      const verdict = {
        status: hasFileRef ? "confirmed" : "unverifiable",
        evidence: [
          hasFileRef
            ? "Author answer includes concrete file:line reference matching diff context."
            : "Author answer provides no verifiable file:line or test evidence.",
        ],
      };
      const text = JSON.stringify(verdict);
      return {
        text,
        model: this.model,
        provider: this.provider,
        usage: { inputTokens, outputTokens: estimateTokens(text), cachedInputTokens: 0 },
      };
    }

    // Handle symmetric-proof specialist reviewer requests
    if (req.system.includes("DIFFGLOSS_SPECIALIST_REVIEWER")) {
      const payloadMatch = /<HUNKS_JSON>\s*([\s\S]*?)\s*<\/HUNKS_JSON>/.exec(promptText);
      const hunks = payloadMatch
        ? (JSON.parse(payloadMatch[1]!) as Array<{
            id: string;
            path: string;
            new_range: [number, number];
            patch: string;
          }>)
        : [];
      const candidates = [];
      const ruled_out = [];
      for (const h of hunks) {
        if (/\+\s*.*SELECT\s+\*.*\+/.test(h.patch)) {
          candidates.push({
            rule_id: "bug/sql-injection",
            severity: "important",
            hunk_id: h.id,
            path: h.path,
            lines: h.new_range,
            message: "String concatenation inside SQL query risks SQL injection; use parameterized bindings.",
            evidence: `${h.path}:${h.new_range[0]}`,
          });
        } else {
          ruled_out.push({
            hunk_id: h.id,
            path: h.path,
            lines: h.new_range,
            suspicion: "Checked boundary and null safety across changed lines.",
            proof: `Lines ${h.new_range[0]}-${h.new_range[1]} in ${h.path} introduce no unchecked dereference.`,
          });
        }
      }
      const text = JSON.stringify({ candidates, ruled_out });
      return {
        text,
        model: this.model,
        provider: this.provider,
        usage: { inputTokens, outputTokens: estimateTokens(text), cachedInputTokens: 0 },
      };
    }

    // Handle cold-start finding verifier requests
    if (req.system.includes("DIFFGLOSS_FINDING_VERIFIER")) {
      const verified = !promptText.includes("shaky-dismissal-escalated");
      const text = JSON.stringify({
        verified,
        reason: verified
          ? "Verified directly against diff hunk code."
          : "Insufficient evidence in diff hunk to confirm bug.",
      });
      return {
        text,
        model: this.model,
        provider: this.provider,
        usage: { inputTokens, outputTokens: estimateTokens(text), cachedInputTokens: 0 },
      };
    }

    // Parse embedded HUNK_PAYLOAD JSON array from explainer prompt
    const payloadMatch = /<HUNKS_JSON>\s*([\s\S]*?)\s*<\/HUNKS_JSON>/.exec(promptText);
    const hunks = payloadMatch
      ? (JSON.parse(payloadMatch[1]!) as Array<{
          id: string;
          path: string;
          new_range: [number, number];
          old_range: [number, number];
          risk: "low" | "medium" | "high";
          class: string;
          enclosing_symbol?: string;
          patch: string;
        }>)
      : [];

    const hasIntent = /<DECLARED_INTENT>\s*\S/.test(promptText);

    const explainedHunks = hunks.map((h) => {
      const removedGuard = h.patch
        .split("\n")
        .some((l) => l.startsWith("-") && /\b(throw|if\s*\(|assert|expect)\b/.test(l));

      if (removedGuard && h.risk === "high") {
        return {
          id: h.id,
          status: "unexplained",
          risk: "high",
          why_text:
            "Guard or assertion was removed without supporting evidence in the diff or declared intent.",
          why_source: "missing",
          trigger: h.class === "test" ? "test_assertion_changed" : "safety_check_removed",
          question: `In ${h.path} (lines ${h.old_range[0]}-${h.old_range[1]}), a guard or assertion was removed. What requirement justifies removing it and where is the invariant enforced now?`,
        };
      }

      const side = h.new_range[0] > 0 ? "new" : "old";
      const range = side === "new" ? h.new_range : h.old_range;
      return {
        id: h.id,
        status: "explained",
        risk: h.risk,
        what_text: `Updates ${h.path}${h.enclosing_symbol ? ` (${h.enclosing_symbol})` : ""} across lines ${range[0]}-${range[1]}.`,
        citations: [{ path: h.path, lines: range, side }],
        why_text: hasIntent
          ? "Supports the declared intent for this change."
          : "Inferred from local diff structure; no declared intent or session transcript was provided.",
        why_source: hasIntent ? "declared_intent" : "reviewer_inferred",
      };
    });

    const responseObj = {
      behavior_change: `Analyzed ${hunks.length} substantive hunk(s) in deterministic mock mode.`,
      groups:
        hunks.length > 0
          ? [
              {
                title: "Substantive changes",
                intent: "Grouped substantive changes for guided review.",
                order_rationale: "Ordered with high-risk changes first.",
                risk: hunks.some((h) => h.risk === "high") ? "high" : "low",
                hunk_ids: hunks.map((h) => h.id),
              },
            ]
          : [],
      hunks: explainedHunks,
    };

    const text = JSON.stringify(responseObj);
    return {
      text,
      model: this.model,
      provider: this.provider,
      usage: {
        inputTokens,
        outputTokens: estimateTokens(text),
        cachedInputTokens: 0,
      },
    };
  }
}

export function createLLMClient(cfg: LLMClientConfig): LLMClient {
  switch (cfg.provider) {
    case "anthropic":
      return new AnthropicClient(cfg);
    case "openai":
      return new OpenAIResponsesClient(cfg);
    case "openai-chat":
      return new OpenAIChatClient(cfg);
    case "deepseek":
      return new OpenAIChatClient({
        ...cfg,
        provider: "deepseek",
        model: cfg.model || "deepseek-chat",
        baseUrl: cfg.baseUrl ?? "https://api.deepseek.com/v1",
        apiKey: resolveApiKey("deepseek", cfg.apiKey, cfg.apiKeyEnv),
      });
    case "google":
      return new GoogleGenAIClient(cfg);
    case "mock":
      return new MockLLMClient(cfg.model);
    default:
      throw new Error(`Unsupported LLM provider dialect: ${String(cfg.provider)}`);
  }
}
