import type { AgentProposal } from "./result.ts";

/**
 * Rendering and parsing for agent proposals published as GitHub issues: the issue body, the
 * comments the pipeline posts, and reading the owner's decision out of a comment. Pure functions; the gh calls live in src/issues.ts.
 */
export interface IssueComment {
  author: string;
  association: string;
  createdAt: string;
  body: string;
}

/** Every comment the pipeline posts carries this marker so it never reads its own words as a decision. */
export const BOT_MARKER = "<!-- agentpipe:bot -->";

export function proposalMarker(id: number): string {
  return `<!-- agentpipe:proposal:${id} -->`;
}

export function issueTitle(p: AgentProposal): string {
  return `Proposed agent: ${p.name} (${p.runtime})`;
}

export function isPipelineComment(c: { body: string }): boolean {
  return c.body.includes(BOT_MARKER);
}

/** GitHub author associations we trust to decide a proposal. */
export const APPROVER_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];
