// src/pr.ts
/**
 * What the pipeline knows about one pull request: its URL, a snapshot of its state, the human's
 * decision on it, and what changed since the last look. Pure: the commands that produce the data
 * live elsewhere.
 */
import { clip } from "./util.ts";

export interface PrComment {
  author: string;
  ts: string;
  body: string;
}

export interface PrReview {
  author: string;
  state: string;
  ts: string;
  body: string;
}

export interface PrSnapshot {
  url: string;
  state: string;
  isDraft: boolean;
  reviewDecision: string;
  updatedAt: string;
  comments: PrComment[];
  reviews: PrReview[];
  checks: { total: number; failed: number };
}

export type PrDecision = "approve" | "feedback" | "deny";

/** One pull request waiting on a human: what the pipeline saw and what the human said. */
export interface PrGate {
  pr_url: string;
  source_task: number;
  decision: PrDecision | null;
  decided_by?: string;
  decided_at?: string;
  snapshot: PrSnapshot | null;
  checked_at: string | null;
  log: string[];
}

/** Accepts only https://github.com/<owner>/<repo>/pull/<n>; trailing path or query is ignored. */
export function parsePrUrl(url: string): { owner: string; repo: string; number: number } | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;
  const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Check conclusions/states that mean the check did not pass. */
const FAILED_CHECK = ["FAILURE", "FAILING", "ERROR", "TIMED_OUT", "CANCELLED"];

/**
 * Maps the JSON of `gh pr view <url> --json state,isDraft,reviewDecision,updatedAt,comments,reviews,statusCheckRollup`.
 * Every field is optional in practice: missing or wrongly typed values become "", false, [] or 0.
 */
export function snapshotFromJson(url: string, raw: unknown): PrSnapshot {
  const o = obj(raw);
  const comments: PrComment[] = arr(o.comments).map((c) => {
    const e = obj(c);
    return { author: str(obj(e.author).login), ts: str(e.createdAt), body: str(e.body) };
  });
  const reviews: PrReview[] = arr(o.reviews).map((r) => {
    const e = obj(r);
    return { author: str(obj(e.author).login), state: str(e.state), ts: str(e.submittedAt), body: str(e.body) };
  });
  const rollup = arr(o.statusCheckRollup);
  let failed = 0;
  for (const c of rollup) {
    const e = obj(c);
    const v = (str(e.conclusion) || str(e.state)).toUpperCase();
    if (FAILED_CHECK.includes(v)) failed++;
  }
  return {
    url,
    state: str(o.state),
    isDraft: o.isDraft === true,
    reviewDecision: str(o.reviewDecision),
    updatedAt: str(o.updatedAt),
    comments,
    reviews,
    checks: { total: rollup.length, failed },
  };
}

/** Marker the pipeline puts in every comment it posts, so it never reacts to its own words. */
export const DECISION_MARKER = "agentpipe:decision";

const DECISION_VERB: Record<PrDecision, string> = {
  approve: "approved",
  feedback: "changes requested",
  deny: "rejected",
};

/** The comment body the pipeline posts to the pull request when the human has decided. */
export function decisionComment(d: { decision: PrDecision; text: string; by: string; taskId: number }): string {
  const lines = [`<!-- ${DECISION_MARKER}=${d.decision} task=#${d.taskId} -->`, `**agentpipe: ${DECISION_VERB[d.decision]} by ${d.by}**`];
  const text = d.text.trim();
  if (text) lines.push("", text);
  return lines.join("\n");
}

/** True for a comment agentpipe itself posted. */
export function isPipelineComment(body: string): boolean {
  return body.includes(DECISION_MARKER);
}

/** One short human-readable line per change since the last look, for a terminal or the status page. */
export function prActivity(prev: PrSnapshot | null, next: PrSnapshot): string[] {
  if (!prev) return [];
  const out: string[] = [];
  const seenComments = new Set(prev.comments.map((c) => `${c.author}\u0000${c.ts}`));
  for (const c of next.comments) {
    if (seenComments.has(`${c.author}\u0000${c.ts}`)) continue;
    if (isPipelineComment(c.body)) continue;
    out.push(`new comment from ${c.author}: ${clip(c.body, 200)}`);
  }
  const seenReviews = new Set(prev.reviews.map((r) => `${r.author}\u0000${r.ts}`));
  for (const r of next.reviews) {
    if (seenReviews.has(`${r.author}\u0000${r.ts}`)) continue;
    out.push(`review by ${r.author}: ${r.state}` + (r.body ? `: ${clip(r.body, 200)}` : ""));
  }
  if (prev.state !== next.state && prev.state && next.state) out.push(`pull request state changed from ${prev.state} to ${next.state}`);
  if (prev.reviewDecision !== next.reviewDecision && next.reviewDecision) out.push(`review decision is now ${next.reviewDecision}`);
  if (next.checks.failed > 0 && next.checks.failed !== prev.checks.failed) out.push(`${next.checks.failed} of ${next.checks.total} checks failing`);
  return out;
}
