import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export interface CommitSummary {
  sha: string;
  short_sha: string;
  subject: string;
  author: string;
  relative_time: string;
}

export interface RepoInspection {
  repo_path: string;
  name: string;
  branch: string;
  branches: string[];
  default_base: string;
  dirty_files: number;
  staged_files: number;
  commits: CommitSummary[];
}

export type DiffTarget =
  | { mode: "working" }
  | { mode: "staged" }
  | { mode: "commit"; sha: string }
  | { mode: "range"; range: string };

export interface ExtractedDiff {
  raw_diff: string;
  title: string;
  declared_intent?: string;
  declared_intent_ref: "commit_message" | "none";
  base_ref?: string;
  head_ref?: string;
  diff_args: string[];
  label: string;
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 50 * 1024 * 1024,
    windowsHide: true,
  });
}

export function resolveGitTopLevel(dirPath: string): string | null {
  const abs = path.resolve(dirPath);
  if (!existsSync(abs)) return null;
  let targetDir = abs;
  try {
    if (statSync(abs).isFile()) {
      targetDir = path.dirname(abs);
    }
  } catch {
    return null;
  }
  try {
    return runGit(targetDir, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    return null;
  }
}

export function listNearbyGitRepos(cwd: string, maxRepos = 10): string[] {
  const top = resolveGitTopLevel(cwd) ?? path.resolve(cwd);
  const parent = path.dirname(top);
  if (!existsSync(parent)) return [];

  const repos: string[] = [];
  try {
    for (const ent of readdirSync(parent, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
      const candidate = path.join(parent, ent.name);
      if (existsSync(path.join(candidate, ".git"))) {
        repos.push(candidate);
        if (repos.length >= maxRepos) break;
      }
    }
  } catch {
    // Parent directory might not be readable
  }
  return repos.sort();
}

export function inspectGitRepo(
  repoPath: string,
  commitLimit = 30,
): RepoInspection {
  const root = resolveGitTopLevel(repoPath);
  if (!root) {
    throw new Error(`Not a valid git repository: ${repoPath}`);
  }

  let branch = "HEAD";
  try {
    branch =
      runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim() || "HEAD";
  } catch {
    // unborn HEAD
  }

  let branches: string[] = [];
  try {
    branches = runGit(root, ["branch", "--format=%(refname:short)"])
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 20);
  } catch {
    branches = [];
  }

  const default_base = branches.includes("main")
    ? "main"
    : branches.includes("master")
      ? "master"
      : branches[0] ?? "HEAD~1";

  let dirty_files = 0;
  let staged_files = 0;
  try {
    const porcelain = runGit(root, ["status", "--porcelain"]);
    for (const line of porcelain.split(/\r?\n/)) {
      if (!line) continue;
      const x = line[0] ?? " ";
      const y = line[1] ?? " ";
      if (x !== " " && x !== "?") staged_files += 1;
      if (y !== " " || x === "?") dirty_files += 1;
    }
  } catch {
    // ignore
  }

  const commits: CommitSummary[] = [];
  try {
    const SEP = "\x1f";
    const REC = "\x1e";
    const logOut = runGit(root, [
      "log",
      `-n`,
      String(commitLimit),
      `--format=%H${SEP}%h${SEP}%s${SEP}%an${SEP}%cr${REC}`,
    ]);
    for (const rec of logOut.split(REC)) {
      const trimmed = rec.trim();
      if (!trimmed) continue;
      const [sha, short_sha, subject, author, relative_time] = trimmed.split(SEP);
      if (sha && short_sha) {
        commits.push({
          sha,
          short_sha,
          subject: subject ?? "(no subject)",
          author: author ?? "",
          relative_time: relative_time ?? "",
        });
      }
    }
  } catch {
    // Empty repo with zero commits
  }

  return {
    repo_path: root,
    name: path.basename(root),
    branch,
    branches,
    default_base,
    dirty_files,
    staged_files,
    commits,
  };
}

function assertSafeGitRef(ref: string, label: string): string {
  const trimmed = ref.trim();
  if (!trimmed) throw new Error(`Missing ${label}.`);
  if (trimmed.startsWith("-") || /[\0\r\n]/.test(trimmed)) {
    throw new Error(`Invalid ${label}: '${trimmed}'.`);
  }
  return trimmed;
}

export function extractRepoDiff(
  repoPath: string,
  target: DiffTarget,
): ExtractedDiff {
  const root = resolveGitTopLevel(repoPath);
  if (!root) {
    throw new Error(`Not a valid git repository: ${repoPath}`);
  }
  const repoName = path.basename(root);

  if (target.mode === "working") {
    let raw = "";
    try {
      raw = runGit(root, ["diff", "--no-color", "HEAD"]);
    } catch {
      raw = runGit(root, ["diff", "--no-color"]);
    }
    return {
      raw_diff: raw,
      title: `${repoName} — Working Tree vs HEAD`,
      declared_intent_ref: "none",
      base_ref: "HEAD",
      diff_args: ["HEAD"],
      label: "Working Tree",
    };
  }

  if (target.mode === "staged") {
    const raw = runGit(root, ["diff", "--no-color", "--cached"]);
    return {
      raw_diff: raw,
      title: `${repoName} — Staged Changes`,
      declared_intent_ref: "none",
      base_ref: "HEAD",
      diff_args: ["--cached"],
      label: "Staged",
    };
  }

  if (target.mode === "commit") {
    const sha = assertSafeGitRef(target.sha, "commit SHA");
    const shortSha = runGit(root, ["rev-parse", "--short", sha]).trim();
    const subject = runGit(root, ["show", "-s", "--format=%s", sha]).trim();
    const fullMsg = runGit(root, ["show", "-s", "--format=%B", sha]).trim();
    const raw = runGit(root, [
      "diff-tree",
      "--no-commit-id",
      "-p",
      "--root",
      "--no-color",
      sha,
    ]);
    let baseRef: string | undefined;
    try {
      baseRef = runGit(root, ["rev-parse", `${sha}^`]).trim();
    } catch {
      baseRef = undefined;
    }

    return {
      raw_diff: raw,
      title: `${repoName} @ ${shortSha}: ${subject}`,
      declared_intent: fullMsg || undefined,
      declared_intent_ref: fullMsg ? "commit_message" : "none",
      base_ref: baseRef,
      head_ref: sha,
      diff_args: ["show", shortSha],
      label: shortSha,
    };
  }

  const range = assertSafeGitRef(target.range, "git diff range");
  const raw = runGit(root, ["diff", "--no-color", range]);
  const dots = /^([^\s.]+)\.{2,3}([^\s.]+)?/.exec(range);
  return {
    raw_diff: raw,
    title: `${repoName} (${range})`,
    declared_intent_ref: "none",
    base_ref: dots?.[1],
    head_ref: dots?.[2] ?? "HEAD",
    diff_args: [range],
    label: range,
  };
}
