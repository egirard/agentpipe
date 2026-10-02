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

/** The shared bullet list of what the proposed agent is and needs. */
function fieldList(p: AgentProposal): string {
  return [
    `- runtime: ${p.runtime}`,
    `- commits: ${p.commits ? "yes, it changes files" : "no, it only reports"}`,
    `- shell groups: ${p.shell.length ? p.shell.join(", ") : "none"}`,
    `- a task for it must contain: ${p.inputs.trim() || "not specified"}`,
    `- it produces: ${p.outputs.trim() || "not specified"}`,
  ].join("\n");
}

export function issueBody(input: { id: number; proposal: AgentProposal; proposedBy: string; taskId: number | null; project: string | null; times: number }): string {
  const p = input.proposal;
  const where = `${input.taskId ? `task #${input.taskId}` : "no particular task"}, ${input.project ? `project ${input.project}` : "no project"}`;
  return [
    `**${p.name}** — ${p.description.trim()}`,
    "",
    "## Why",
    "",
    p.why.trim(),
    "",
    fieldList(p),
    "",
    `Proposed by ${input.proposedBy} for ${where}; asked for ${input.times} time${input.times === 1 ? "" : "s"} so far.`,
    "",
    "## How to decide",
    "",
    "- Comment `approved` on its own first line and the pipeline queues the agent-creator agent to build it.",
    "- Comment anything else to send feedback, which the architect answers in this thread.",
    "- Or press Approve on the status page.",
    "",
    proposalMarker(input.id),
    BOT_MARKER,
  ].join("\n");
}

/** Posted when the architect sharpens a proposal after feedback. */
export function revisionComment(p: AgentProposal, note: string): string {
  return [
    "## Revised specification",
    "",
    p.description.trim(),
    "",
    fieldList(p),
    "",
    note.trim(),
    "",
    BOT_MARKER,
  ].join("\n");
}

/** Posted when a proposal is decided or the agent has been built. */
export function decisionComment(status: "approved" | "dismissed" | "created", by: string, detail: string): string {
  const d = detail.trim();
  const tail = d ? ` ${d}` : "";
  const first =
    status === "approved"
      ? `Approved by ${by}. The pipeline has queued the agent-creator agent to build this agent; its result lands on this issue.${tail}`
      : status === "dismissed"
        ? `Dismissed by ${by}. No agent will be created from this proposal; propose it again if that changes.${tail}`
        : `Created by ${by}. The agent exists now and the architect can assign work to it.${tail}`;
  return [first, "", BOT_MARKER].join("\n");
}

export function isPipelineComment(c: { body: string }): boolean {
  return c.body.includes(BOT_MARKER);
}

/** GitHub author associations we trust to decide a proposal. */
export const APPROVER_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];

/**
 * The owner's decision, read out of one issue comment. Only comments from someone trusted count,
 * and only when the decision is the first thing they say: "I approved this last week" is prose,
 * not an approval.
 */
export function decisionFromComment(c: IssueComment, approvers: string[] = []): "approved" | "dismissed" | null {
  if (isPipelineComment(c)) return null;
  const trusted =
    APPROVER_ASSOCIATIONS.includes(c.association.toUpperCase()) ||
    approvers.some((a) => a.toLowerCase() === c.author.toLowerCase());
  if (!trusted) return null;
  const first = c.body.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!first) return null;
  const line = first
    .replace(/[*_`]/g, "")
    .replace(/^\/+/, "")
    .trim()
    .replace(/[\s.,:;!?)\]-]+$/, "")
    .toLowerCase();
  if (/^approved?\b/.test(line)) return "approved";
  if (/^(dismiss(ed)?|decline[d]?|reject(ed)?)\b/.test(line)) return "dismissed";
  return null;
}
