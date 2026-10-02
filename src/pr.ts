/**
 * What the pipeline knows about one pull request: its URL, a snapshot of its state, the human's
 * decision on it, and what changed since the last look. Pure: the commands that produce the data
 * live elsewhere.
 */

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
