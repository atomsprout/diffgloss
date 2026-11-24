import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface SymbolScope {
  name: string;
  qualifiedName: string;
  kind: "class" | "function" | "method" | "interface" | "impl" | "struct";
  startLine: number;
  endLine: number;
}

type LangFamily = "brace" | "python" | "unknown";

function detectLangFamily(filePath: string): LangFamily {
  const ext = path.posix.extname(filePath).toLowerCase();
  if (
    [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".rs", ".java", ".kt", ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".swift", ".php"].includes(
      ext,
    )
  ) {
    return "brace";
  }
  if (ext === ".py") return "python";
  return "unknown";
}

/**
 * Strips string literals and comments on a line while tracking multi-line block comment state,
 * so braces/keywords inside strings or comments never corrupt structural scope boundaries.
 */
function stripLiteralsAndComments(
  line: string,
  inBlockComment: boolean,
): { clean: string; inBlockComment: boolean } {
  let out = "";
  let i = 0;
  let inBlock = inBlockComment;
  let quote: string | null = null;

  while (i < line.length) {
    const ch = line[i]!;
    const next = line[i + 1] ?? "";

    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (quote) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      i += 1;
      continue;
    }

    if (ch === "/" && next === "/") {
      break;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += " ";
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return { clean: out, inBlockComment: inBlock };
}

interface DeclMatch {
  name: string;
  kind: SymbolScope["kind"];
}

const BRACE_DECL_PATTERNS: Array<{ re: RegExp; kind: SymbolScope["kind"] }> = [
  { re: /\bclass\s+([A-Za-z_]\w*)/, kind: "class" },
  { re: /\binterface\s+([A-Za-z_]\w*)/, kind: "interface" },
  { re: /\bstruct\s+([A-Za-z_]\w*)/, kind: "struct" },
  { re: /\bimpl(?:<[^>]+>)?\s+(?:[A-Za-z_]\w*\s+for\s+)?([A-Za-z_]\w*)/, kind: "impl" },
  { re: /\b(?:async\s+)?function\s*\*?\s*([A-Za-z_]\w*)\s*[<(]/, kind: "function" },
  { re: /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[<(]/, kind: "function" },
  { re: /\b(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*[<(]/, kind: "function" },
  { re: /\b(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_]\w*)\s*(?::[^=]+)?=>/, kind: "function" },
  // Class methods in TS/JS/Java/C#/Swift (e.g. `async verifySession(req: Req) {`)
  {
    re: /^\s*(?:public|private|protected|static|readonly|override|virtual|async|export|get|set|\s)*([A-Za-z_]\w*)\s*(?:<[^>]+>)?\s*\([^;]*\)\s*(?::\s*[^={]+)?\s*\{/,
    kind: "method",
  },
];

const CONTROL_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "else",
  "do",
  "try",
  "finally",
  "with",
  "match",
  "return",
]);

function matchBraceDeclaration(cleanLine: string): DeclMatch | null {
  for (const { re, kind } of BRACE_DECL_PATTERNS) {
    const m = re.exec(cleanLine);
    if (m?.[1] && !CONTROL_KEYWORDS.has(m[1])) {
      return { name: m[1], kind };
    }
  }
  return null;
}

function parseBraceScopes(lines: string[]): SymbolScope[] {
  const scopes: SymbolScope[] = [];
  const stack: Array<{
    name: string;
    kind: SymbolScope["kind"];
    startLine: number;
    openDepth: number;
  }> = [];

  let depth = 0;
  let inBlockComment = false;
  let pendingDecl: { name: string; kind: SymbolScope["kind"]; startLine: number } | null =
    null;

  for (let idx = 0; idx < lines.length; idx += 1) {
    const lineNo = idx + 1;
    const { clean, inBlockComment: nextBlock } = stripLiteralsAndComments(
      lines[idx]!,
      inBlockComment,
    );
    inBlockComment = nextBlock;

    const trimmed = clean.trim();
    if (trimmed) {
      const decl = matchBraceDeclaration(clean);
      if (decl) {
        pendingDecl = { ...decl, startLine: lineNo };
      }
    }

    for (const ch of clean) {
      if (ch === "{") {
        depth += 1;
        if (pendingDecl) {
          stack.push({
            ...pendingDecl,
            openDepth: depth,
          });
          pendingDecl = null;
        }
      } else if (ch === "}") {
        while (stack.length > 0 && stack[stack.length - 1]!.openDepth === depth) {
          const closed = stack.pop()!;
          const parentNames = stack.map((s) => s.name);
          const qualifiedName = [...parentNames, closed.name].join(".");
          scopes.push({
            name: closed.name,
            qualifiedName,
            kind: closed.kind,
            startLine: closed.startLine,
            endLine: lineNo,
          });
        }
        depth = Math.max(0, depth - 1);
      }
    }

    // Clear stale pending decl if semicolon terminated a signature/declaration
    if (pendingDecl && trimmed.endsWith(";") && !clean.includes("{")) {
      pendingDecl = null;
    }
  }

  // Close any unclosed scopes at EOF
  const eof = lines.length;
  while (stack.length > 0) {
    const closed = stack.pop()!;
    const parentNames = stack.map((s) => s.name);
    scopes.push({
      name: closed.name,
      qualifiedName: [...parentNames, closed.name].join("."),
      kind: closed.kind,
      startLine: closed.startLine,
      endLine: eof,
    });
  }

  return scopes.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
}

function parsePythonScopes(lines: string[]): SymbolScope[] {
  const scopes: SymbolScope[] = [];
  const stack: Array<{
    name: string;
    kind: SymbolScope["kind"];
    startLine: number;
    indent: number;
  }> = [];

  for (let idx = 0; idx < lines.length; idx += 1) {
    const raw = lines[idx]!;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const indent = raw.length - raw.trimStart().length;
    const lineNo = idx + 1;

    while (stack.length > 0 && indent <= stack[stack.length - 1]!.indent) {
      const closed = stack.pop()!;
      const parents = stack.map((s) => s.name);
      scopes.push({
        name: closed.name,
        qualifiedName: [...parents, closed.name].join("."),
        kind: closed.kind,
        startLine: closed.startLine,
        endLine: lineNo - 1,
      });
    }

    const classMatch = /^class\s+([A-Za-z_]\w*)/.exec(trimmed);
    const fnMatch = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(trimmed);
    if (classMatch?.[1]) {
      stack.push({ name: classMatch[1], kind: "class", startLine: lineNo, indent });
    } else if (fnMatch?.[1]) {
      const kind = stack.some((s) => s.kind === "class") ? "method" : "function";
      stack.push({ name: fnMatch[1], kind, startLine: lineNo, indent });
    }
  }

  const eof = lines.length;
  while (stack.length > 0) {
    const closed = stack.pop()!;
    const parents = stack.map((s) => s.name);
    scopes.push({
      name: closed.name,
      qualifiedName: [...parents, closed.name].join("."),
      kind: closed.kind,
      startLine: closed.startLine,
      endLine: eof,
    });
  }

  return scopes.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
}

export function extractSymbolScopes(filePath: string, sourceText: string): SymbolScope[] {
  const family = detectLangFamily(filePath);
  const lines = sourceText.split(/\r?\n/);
  if (family === "brace") return parseBraceScopes(lines);
  if (family === "python") return parsePythonScopes(lines);
  return [];
}

export function extractFileScopes(cwd: string, relPath: string): SymbolScope[] {
  const abs = path.join(cwd, relPath);
  if (!existsSync(abs)) return [];
  try {
    return extractSymbolScopes(relPath, readFileSync(abs, "utf8"));
  } catch {
    return [];
  }
}

/**
 * Returns the narrowest (most specific) enclosing scope containing the given 1-based line.
 */
export function findEnclosingScope(
  scopes: SymbolScope[],
  line: number,
): SymbolScope | undefined {
  let best: SymbolScope | undefined;
  for (const s of scopes) {
    if (line >= s.startLine && line <= s.endLine) {
      if (
        !best ||
        s.endLine - s.startLine < best.endLine - best.startLine
      ) {
        best = s;
      }
    }
  }
  return best;
}
