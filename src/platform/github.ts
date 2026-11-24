import { renderMarkdownReport } from "../render/markdown.ts";
import type { AttachedFinding, ExplanationLedger } from "../schema/types.ts";

export const LEDGER_COMMENT_MARKER = "<!-- diffgloss-ledger -->";

export interface GitHubPrContext {
  title: string;
  body: string;
  baseRef: string;
  headRef: string;
  headSha: string;
  diff: string;
}

export interface ExistingComment {
  id: number;
  body: string;
}

export interface InlineReviewDraft {
  path: string;
  line: number;
  side: "RIGHT";
  fingerprint: string;
  body: string;
}

export interface GitHubSyncPlan {
  overviewAction: "create" | "update";
  existingOverviewCommentId?: number;
  overviewBody: string;
  newInlineComments: InlineReviewDraft[];
  unchangedFingerprints: string[];
  resolvedCommentIds: number[];
  skippedOutOfDiffCount: number;
}

const FP_RE = /<!--\s*diffgloss-fp:([a-f0-9]+)\s*-->/i;

function isLineInDiffHunks(ledger: ExplanationLedger, filePath: string, line: number): boolean {
  return ledger.hunks.some(
    (h) =>
      h.path === filePath &&
      h.new_range[0] > 0 &&
      line >= h.new_range[0] &&
      line <= h.new_range[1],
  );
}

function formatFindingInlineBody(f: AttachedFinding): string {
  const sev = f.severity === "important" ? "Important" : f.severity === "nit" ? "Nit" : "Info";
  return [
    `**[${sev}] \`${f.rule_id}\`** (${f.tool})`,
    "",
    f.message,
    f.evidence ? `\n> Evidence: \`${f.evidence}\`` : "",
    `\n<!-- diffgloss-fp:${f.fingerprint} -->`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Pure deterministic reconciliation planner for GitHub PR sync:
 * - Updates the sticky coverage ledger comment instead of spamming new overview comments
 * - Anchors inline comments strictly to valid diff lines (preventing GitHub 422 errors)
 * - Deduplicates unchanged findings by fingerprint and flags fixed prior comments
 */
export function planGitHubSync(
  ledger: ExplanationLedger,
  existingIssueComments: ExistingComment[],
  existingReviewComments: ExistingComment[],
): GitHubSyncPlan {
  const existingOverview = existingIssueComments.find((c) =>
    c.body.includes(LEDGER_COMMENT_MARKER),
  );
  const overviewBody = `${LEDGER_COMMENT_MARKER}\n${renderMarkdownReport(ledger)}`;

  const existingFpMap = new Map<string, number>();
  for (const rc of existingReviewComments) {
    const m = FP_RE.exec(rc.body);
    if (m?.[1]) existingFpMap.set(m[1], rc.id);
  }

  const activeFps = new Set<string>();
  const newInlineComments: InlineReviewDraft[] = [];
  const unchangedFingerprints: string[] = [];
  let skippedOutOfDiffCount = 0;

  for (const f of ledger.findings ?? []) {
    activeFps.add(f.fingerprint);
    if (existingFpMap.has(f.fingerprint)) {
      unchangedFingerprints.push(f.fingerprint);
      continue;
    }
    const anchorLine = Math.max(1, f.lines[0]);
    if (!isLineInDiffHunks(ledger, f.path, anchorLine)) {
      skippedOutOfDiffCount += 1;
      continue;
    }
    newInlineComments.push({
      path: f.path,
      line: anchorLine,
      side: "RIGHT",
      fingerprint: f.fingerprint,
      body: formatFindingInlineBody(f),
    });
  }

  const resolvedCommentIds: number[] = [];
  for (const [fp, commentId] of existingFpMap.entries()) {
    if (!activeFps.has(fp)) {
      resolvedCommentIds.push(commentId);
    }
  }

  return {
    overviewAction: existingOverview ? "update" : "create",
    existingOverviewCommentId: existingOverview?.id,
    overviewBody,
    newInlineComments,
    unchangedFingerprints,
    resolvedCommentIds,
    skippedOutOfDiffCount,
  };
}

function ghHeaders(token: string, accept = "application/vnd.github+json"): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept,
    "x-github-api-version": "2022-11-28",
    "user-agent": "diffgloss-cli/0.2.0",
  };
}

export async function fetchPullRequestContext(opts: {
  repo: string;
  pr: number;
  token: string;
  apiBase?: string;
}): Promise<GitHubPrContext> {
  const base = (opts.apiBase ?? "https://api.github.com").replace(/\/$/, "");
  const prUrl = `${base}/repos/${opts.repo}/pulls/${opts.pr}`;

  const [metaRes, diffRes] = await Promise.all([
    fetch(prUrl, { headers: ghHeaders(opts.token) }),
    fetch(prUrl, { headers: ghHeaders(opts.token, "application/vnd.github.v3.diff") }),
  ]);

  if (!metaRes.ok) {
    throw new Error(`GitHub PR metadata error ${metaRes.status}: ${await metaRes.text()}`);
  }
  if (!diffRes.ok) {
    throw new Error(`GitHub PR diff error ${diffRes.status}: ${await diffRes.text()}`);
  }

  const meta = (await metaRes.json()) as {
    title?: string;
    body?: string | null;
    base?: { ref?: string };
    head?: { ref?: string; sha?: string };
  };

  return {
    title: meta.title ?? `PR #${opts.pr}`,
    body: meta.body ?? "",
    baseRef: meta.base?.ref ?? "main",
    headRef: meta.head?.ref ?? "HEAD",
    headSha: meta.head?.sha ?? "",
    diff: await diffRes.text(),
  };
}

export async function syncLedgerToGitHub(opts: {
  repo: string;
  pr: number;
  token: string;
  ledger: ExplanationLedger;
  dryRun?: boolean;
  apiBase?: string;
}): Promise<GitHubSyncPlan> {
  const base = (opts.apiBase ?? "https://api.github.com").replace(/\/$/, "");
  const headers = ghHeaders(opts.token);

  const [issueRes, reviewRes, prRes] = await Promise.all([
    fetch(`${base}/repos/${opts.repo}/issues/${opts.pr}/comments?per_page=100`, { headers }),
    fetch(`${base}/repos/${opts.repo}/pulls/${opts.pr}/comments?per_page=100`, { headers }),
    fetch(`${base}/repos/${opts.repo}/pulls/${opts.pr}`, { headers }),
  ]);

  if (!issueRes.ok || !reviewRes.ok || !prRes.ok) {
    throw new Error(
      `Failed fetching GitHub PR comments (statuses: ${issueRes.status}/${reviewRes.status}/${prRes.status}).`,
    );
  }

  const existingIssue = (await issueRes.json()) as ExistingComment[];
  const existingReview = (await reviewRes.json()) as ExistingComment[];
  const prMeta = (await prRes.json()) as { head?: { sha?: string } };

  const plan = planGitHubSync(opts.ledger, existingIssue, existingReview);
  if (opts.dryRun) return plan;

  // 1. Create or update sticky overview comment
  if (plan.overviewAction === "update" && plan.existingOverviewCommentId) {
    await fetch(
      `${base}/repos/${opts.repo}/issues/comments/${plan.existingOverviewCommentId}`,
      {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ body: plan.overviewBody }),
      },
    );
  } else {
    await fetch(`${base}/repos/${opts.repo}/issues/${opts.pr}/comments`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ body: plan.overviewBody }),
    });
  }

  // 2. Post new inline findings anchored strictly to valid diff lines
  const commitId = prMeta.head?.sha;
  if (commitId) {
    for (const c of plan.newInlineComments) {
      await fetch(`${base}/repos/${opts.repo}/pulls/${opts.pr}/comments`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          body: c.body,
          commit_id: commitId,
          path: c.path,
          line: c.line,
          side: c.side,
        }),
      });
    }
  }

  // 3. Mark previously posted Diffgloss comments whose fingerprints are now fixed
  for (const oldId of plan.resolvedCommentIds) {
    await fetch(`${base}/repos/${opts.repo}/pulls/comments/${oldId}/replies`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        body: "Resolved: this finding no longer reproduces in the latest Diffgloss ledger.",
      }),
    });
  }

  return plan;
}
