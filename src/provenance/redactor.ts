const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    "[REDACTED:PRIVATE_KEY]",
  ],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED:ANTHROPIC_KEY]"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, "[REDACTED:OPENAI_KEY]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "[REDACTED:GITHUB_TOKEN]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED:GITHUB_PAT]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED:AWS_ACCESS_KEY]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED:SLACK_TOKEN]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED:JWT]"],
  [/(Bearer\s+)[A-Za-z0-9._-]{16,}/gi, "$1[REDACTED:BEARER]"],
  [
    /((?:password|passwd|secret|api_key|apikey|access_token|auth_token)\s*[:=]\s*["']?)([^"'\s,;]{6,})(["']?)/gi,
    "$1[REDACTED]$3",
  ],
];

export interface RedactionResult {
  text: string;
  redactions: number;
}

export function redactSecrets(input: string): RedactionResult {
  let text = input;
  let redactions = 0;

  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, (...args) => {
      redactions += 1;
      if (replacement.includes("$1")) {
        return replacement
          .replace("$1", String(args[1] ?? ""))
          .replace("$3", String(args[3] ?? ""));
      }
      return replacement;
    });
  }

  return { text, redactions };
}
