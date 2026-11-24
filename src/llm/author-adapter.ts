import { execFile, execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { AuthorCliKind, ProviderDialect } from "../schema/types.ts";
import { estimateTokens } from "./budget.ts";
import type { LLMClient, LLMRequest, LLMResponse } from "./types.ts";

export interface DetectedAuthorClis {
  claude: { available: boolean; version?: string };
  codex: { available: boolean; version?: string };
}

/**
 * macOS GUI apps launched from Finder receive a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin)
 * that omits ~/.local/bin, /opt/homebrew/bin, ~/.bun/bin, etc. Augment PATH so local
 * coding-agent CLIs (`codex`, `claude`) are reliably discovered from Desktop & CLI alike.
 */
export function buildCliEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const sep = platform === "win32" ? ";" : ":";
  const currentPath = baseEnv.PATH ?? baseEnv.Path ?? "";
  const extraDirs =
    platform === "win32"
      ? [
          path.join(homeDir, ".local", "bin"),
          path.join(homeDir, ".bun", "bin"),
          path.join(homeDir, "AppData", "Roaming", "npm"),
        ]
      : [
          path.join(homeDir, ".local", "bin"),
          path.join(homeDir, ".bun", "bin"),
          path.join(homeDir, ".cargo", "bin"),
          path.join(homeDir, ".npm-global", "bin"),
          path.join(homeDir, ".volta", "bin"),
          "/opt/homebrew/bin",
          "/opt/homebrew/sbin",
          "/usr/local/bin",
        ];

  const merged: string[] = [];
  for (const dir of [...extraDirs, ...currentPath.split(sep)]) {
    if (dir && !merged.includes(dir)) merged.push(dir);
  }
  const nextPath = merged.join(sep);
  return {
    ...baseEnv,
    PATH: nextPath,
    ...(platform === "win32" ? { Path: nextPath } : {}),
  };
}

function probeBinary(bin: string, versionArg = "--version"): { available: boolean; version?: string } {
  try {
    const out = execFileSync(bin, [versionArg], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 3000,
      env: buildCliEnv(),
      windowsHide: true,
    }).trim();
    return { available: true, version: out.split(/\r?\n/)[0] };
  } catch {
    return { available: false };
  }
}

export function detectInstalledAuthorClis(): DetectedAuthorClis {
  return {
    claude: probeBinary("claude", "--version"),
    codex: probeBinary("codex", "--version"),
  };
}

export function resolvePreferredAuthorCli(
  preferred: AuthorCliKind = "auto",
  detected: DetectedAuthorClis = detectInstalledAuthorClis(),
): "claude-cli" | "codex-cli" | null {
  if (preferred === "claude-cli") return detected.claude.available ? "claude-cli" : null;
  if (preferred === "codex-cli") return detected.codex.available ? "codex-cli" : null;
  if (detected.codex.available) return "codex-cli";
  if (detected.claude.available) return "claude-cli";
  return null;
}

function spawnTextWithStdin(
  bin: string,
  args: string[],
  stdinText: string,
  cwd: string,
  timeoutMs = 180_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 15 * 1024 * 1024,
        timeout: timeoutMs,
        env: buildCliEnv(),
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `${bin} CLI failed (${err.message}): ${(stderr || stdout || "").slice(0, 400)}`,
            ),
          );
          return;
        }
        resolve(stdout.trim());
      },
    );
    child.stdin?.write(stdinText);
    child.stdin?.end();
  });
}

export interface AuthorCliClientOptions {
  kind: "claude-cli" | "codex-cli";
  cwd: string;
  model?: string;
  sessionId?: string;
  timeoutMs?: number;
}

/**
 * Wraps the user's local Claude Code or Codex CLI as a read-only LLMClient so the
 * authoring coding agent can explain its own diff using its existing subscription &
 * optional forked session context (never mutating files or the main conversation).
 */
export class AuthorCliLLMClient implements LLMClient {
  readonly provider: ProviderDialect;
  readonly model: string;
  private readonly cwd: string;
  private readonly sessionId?: string;
  private readonly timeoutMs: number;

  constructor(options: AuthorCliClientOptions) {
    this.provider = options.kind;
    this.model =
      options.model ||
      (options.kind === "claude-cli" ? "claude-code-cli" : "codex-cli");
    this.cwd = options.cwd;
    this.sessionId = options.sessionId;
    this.timeoutMs = options.timeoutMs ?? 180_000;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const combinedPrompt = [
      req.system,
      "",
      ...req.messages.map((m) => m.content),
      "",
      "IMPORTANT: Do NOT edit or create any files. Respond ONLY with the requested JSON object.",
    ].join("\n");

    let text = "";
    if (this.provider === "claude-cli") {
      const baseArgs = ["-p", "--permission-mode", "plan", "--output-format", "text"];
      if (this.model && this.model !== "claude-code-cli") {
        baseArgs.push("--model", this.model);
      }
      if (this.sessionId) {
        baseArgs.push("--resume", this.sessionId, "--fork-session");
      }
      text = await spawnTextWithStdin(
        "claude",
        baseArgs,
        combinedPrompt,
        this.cwd,
        this.timeoutMs,
      );
    } else {
      // Codex CLI non-interactive read-only execution (`codex exec -s read-only -`)
      const args = this.sessionId
        ? ["exec", "fork", this.sessionId, "-"]
        : ["exec", "-s", "read-only", "-"];
      if (!this.sessionId && this.model && this.model !== "codex-cli") {
        args.splice(1, 0, "-m", this.model);
      }
      text = await spawnTextWithStdin(
        "codex",
        args,
        combinedPrompt,
        this.cwd,
        this.timeoutMs,
      );
    }

    return {
      text,
      model: this.model,
      provider: this.provider,
      usage: {
        inputTokens: estimateTokens(combinedPrompt),
        outputTokens: estimateTokens(text),
        cachedInputTokens: 0,
      },
    };
  }
}

export function createAuthorCliClient(
  options: AuthorCliClientOptions,
): AuthorCliLLMClient {
  return new AuthorCliLLMClient(options);
}
