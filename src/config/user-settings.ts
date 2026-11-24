import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EffortLevel, ProviderDialect } from "../schema/types.ts";

export interface ProviderPreset {
  id: string;
  label: string;
  dialect: ProviderDialect;
  base_url: string;
  default_model: string;
  suggested_models: string[];
  requires_key: boolean;
  key_placeholder: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    dialect: "deepseek",
    base_url: "https://api.deepseek.com/v1",
    default_model: "deepseek-chat",
    suggested_models: ["deepseek-chat", "deepseek-reasoner"],
    requires_key: true,
    key_placeholder: "sk-...",
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    dialect: "anthropic",
    base_url: "https://api.anthropic.com",
    default_model: "claude-sonnet-4-5",
    suggested_models: ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5"],
    requires_key: true,
    key_placeholder: "sk-ant-...",
  },
  {
    id: "openai",
    label: "OpenAI",
    dialect: "openai",
    base_url: "https://api.openai.com",
    default_model: "gpt-5.1",
    suggested_models: ["gpt-5.1", "gpt-5-mini", "gpt-4.1", "o4-mini"],
    requires_key: true,
    key_placeholder: "sk-...",
  },
  {
    id: "google",
    label: "Google Gemini",
    dialect: "google",
    base_url: "https://generativelanguage.googleapis.com",
    default_model: "gemini-2.5-pro",
    suggested_models: ["gemini-2.5-pro", "gemini-2.5-flash"],
    requires_key: true,
    key_placeholder: "AIza...",
  },
  {
    id: "openrouter",
    label: "OpenRouter (300+ Models)",
    dialect: "openai-chat",
    base_url: "https://openrouter.ai/api/v1",
    default_model: "anthropic/claude-sonnet-4.5",
    suggested_models: [
      "anthropic/claude-sonnet-4.5",
      "openai/gpt-5.1",
      "google/gemini-2.5-pro",
      "deepseek/deepseek-chat",
    ],
    requires_key: true,
    key_placeholder: "sk-or-v1-...",
  },
  {
    id: "ollama",
    label: "Ollama (Local, No Key)",
    dialect: "openai-chat",
    base_url: "http://127.0.0.1:11434/v1",
    default_model: "qwen2.5-coder:14b",
    suggested_models: ["qwen2.5-coder:14b", "deepseek-r1:14b", "llama3.3:70b"],
    requires_key: false,
    key_placeholder: "(optional for local Ollama)",
  },
  {
    id: "qwen",
    label: "Qwen / DashScope",
    dialect: "openai-chat",
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    default_model: "qwen-plus",
    suggested_models: ["qwen-plus", "qwen-max", "qwen3-coder-plus"],
    requires_key: true,
    key_placeholder: "sk-...",
  },
  {
    id: "kimi",
    label: "Kimi / Moonshot",
    dialect: "openai-chat",
    base_url: "https://api.moonshot.cn/v1",
    default_model: "moonshot-v1-auto",
    suggested_models: ["moonshot-v1-auto", "kimi-k2-0711-preview"],
    requires_key: true,
    key_placeholder: "sk-...",
  },
  {
    id: "glm",
    label: "Zhipu GLM",
    dialect: "openai-chat",
    base_url: "https://open.bigmodel.cn/api/paas/v4",
    default_model: "glm-4-plus",
    suggested_models: ["glm-4-plus", "glm-4.5"],
    requires_key: true,
    key_placeholder: "...",
  },
  {
    id: "custom",
    label: "Custom OpenAI-Compatible",
    dialect: "openai-chat",
    base_url: "https://your-endpoint.example.com/v1",
    default_model: "my-model",
    suggested_models: [],
    requires_key: false,
    key_placeholder: "optional bearer token",
  },
];

export interface UserSettings {
  preset?: string;
  provider?: ProviderDialect;
  model?: string;
  base_url?: string;
  api_key?: string;
  judge_provider?: ProviderDialect;
  judge_model?: string;
  judge_base_url?: string;
  judge_api_key?: string;
  effort?: EffortLevel;
  budget_usd?: number;
  enable_judge?: boolean;
  enable_review?: boolean;
}

export interface MaskedUserSettings {
  settings_path: string;
  preset: string;
  provider: ProviderDialect;
  model: string;
  base_url: string;
  has_api_key: boolean;
  api_key_masked: string;
  judge_provider: ProviderDialect | "";
  judge_model: string;
  judge_base_url: string;
  has_judge_api_key: boolean;
  judge_api_key_masked: string;
  effort: EffortLevel;
  budget_usd: number;
  enable_judge: boolean;
  enable_review: boolean;
}

export function getUserSettingsPath(homeDir?: string): string {
  const xdg = !homeDir ? process.env.XDG_CONFIG_HOME : undefined;
  const base = xdg
    ? xdg
    : path.join(homeDir ?? os.homedir(), ".config");
  return path.join(base, "diffgloss", "settings.json");
}

export function maskApiKey(key: string | undefined): string {
  if (!key || key.trim().length === 0) return "";
  const trimmed = key.trim();
  if (trimmed.length <= 8) return "••••••••";
  return `${trimmed.slice(0, 5)}••••${trimmed.slice(-4)}`;
}

export function loadUserSettings(homeDir?: string): UserSettings {
  const filePath = getUserSettingsPath(homeDir);
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as UserSettings;
  } catch {
    return {};
  }
}

export function saveUserSettings(
  patch: Partial<UserSettings>,
  homeDir?: string,
): UserSettings {
  const filePath = getUserSettingsPath(homeDir);
  const existing = loadUserSettings(homeDir);
  const next: UserSettings = { ...existing };

  // Merge non-undefined fields; preserve saved keys when caller leaves key empty unless explicitly cleared
  for (const [k, v] of Object.entries(patch) as Array<
    [keyof UserSettings, unknown]
  >) {
    if (v === undefined) continue;
    if ((k === "api_key" || k === "judge_api_key") && v === "") {
      continue;
    }
    if (v === null) {
      delete next[k];
    } else {
      (next as Record<string, unknown>)[k] = v;
    }
  }

  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(next, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Windows does not enforce POSIX chmod
  }
  return next;
}

export function toMaskedUserSettings(
  settings: UserSettings,
  homeDir?: string,
): MaskedUserSettings {
  const provider = settings.provider ?? "deepseek";
  const preset =
    settings.preset ??
    PROVIDER_PRESETS.find((p) => p.dialect === provider)?.id ??
    "custom";
  const presetObj = PROVIDER_PRESETS.find((p) => p.id === preset);

  return {
    settings_path: getUserSettingsPath(homeDir),
    preset,
    provider,
    model: settings.model ?? presetObj?.default_model ?? "deepseek-chat",
    base_url: settings.base_url ?? presetObj?.base_url ?? "",
    has_api_key: Boolean(settings.api_key),
    api_key_masked: maskApiKey(settings.api_key),
    judge_provider: settings.judge_provider ?? "",
    judge_model: settings.judge_model ?? "",
    judge_base_url: settings.judge_base_url ?? "",
    has_judge_api_key: Boolean(settings.judge_api_key),
    judge_api_key_masked: maskApiKey(settings.judge_api_key),
    effort: settings.effort ?? "standard",
    budget_usd: settings.budget_usd ?? 1.5,
    enable_judge: settings.enable_judge ?? true,
    enable_review: settings.enable_review ?? true,
  };
}
