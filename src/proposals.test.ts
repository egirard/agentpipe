import { describe, expect, test } from "bun:test";
import { APPROVER_ASSOCIATIONS, BOT_MARKER, decisionComment, decisionFromComment, isPipelineComment, issueBody, issueTitle, proposalMarker, revisionComment, type IssueComment } from "./proposals.ts";
import type { AgentProposal } from "./result.ts";

export const proposal: AgentProposal = {
  name: "db-migrator",
  description: "Writes and applies SQLite migrations for the schema change a task describes.",
  runtime: "claude",
  why: "No registered agent can change the schema safely, so every schema task stalls on the human.",
  inputs: "the table and the column to add",
  outputs: "a branch with the migration and a short report",
  commits: true,
  shell: ["git-read", "checks"],
};

describe("proposal markers and title", () => {
  test("the marker carries the proposal id and the title names the agent and runtime", () => {
    expect(proposalMarker(7)).toBe("<!-- agentpipe:proposal:7 -->");
    expect(issueTitle(proposal)).toBe("Proposed agent: db-migrator (claude)");
  });
  test("pipeline comments are the ones carrying the bot marker", () => {
    expect(isPipelineComment({ body: `queued the agent-creator agent\n\n${BOT_MARKER}` })).toBe(true);
    expect(isPipelineComment({ body: "approved" })).toBe(false);
  });
  test("owners, members and collaborators may decide", () => {
    expect(APPROVER_ASSOCIATIONS).toContain("OWNER");
    expect(APPROVER_ASSOCIATIONS).toContain("COLLABORATOR");
    expect(APPROVER_ASSOCIATIONS).not.toContain("NONE");
  });
});

describe("issueBody", () => {
  const body = issueBody({ id: 7, proposal, proposedBy: "architect", taskId: 42, project: "agentpipe", times: 3 });
  test("names the agent, the runtime, the why and the shell groups", () => {
    expect(body).toContain("db-migrator");
    expect(body).toContain("claude");
    expect(body).toContain("No registered agent can change the schema safely");
    expect(body).toContain("git-read");
    expect(body).toContain("checks");
    expect(body).toContain("## Why");
  });
  test("says how to decide and who asked for it", () => {
    expect(body).toContain("approved");
    expect(body).toContain("## How to decide");
    expect(body).toContain("architect");
    expect(body).toContain("task #42");
    expect(body).toContain("agentpipe");
    expect(body).toContain("3 times");
  });
  test("ends with the proposal marker and the bot marker", () => {
    expect(body.endsWith(`${proposalMarker(7)}\n${BOT_MARKER}`)).toBe(true);
  });
  test("a proposal with no task, project or shell groups still renders", () => {
    const b = issueBody({ id: 1, proposal: { ...proposal, shell: [], inputs: "", commits: false }, proposedBy: "egirard", taskId: null, project: null, times: 1 });
    expect(b).toContain("shell groups: none");
    expect(b).toContain("not specified");
    expect(b).toContain("1 time so far");
  });
});

describe("pipeline comments", () => {
  test("a revision repeats the fields and the note", () => {
    const c = revisionComment({ ...proposal, runtime: "ollama" }, "Narrowed to SQLite only, per your comment.");
    expect(c).toContain("## Revised specification");
    expect(c).toContain("runtime: ollama");
    expect(c).toContain("Narrowed to SQLite only");
    expect(c.endsWith(BOT_MARKER)).toBe(true);
  });
  test("every decision comment is recognised as a pipeline comment", () => {
    for (const status of ["approved", "dismissed", "created"] as const) {
      const c = decisionComment(status, "egirard", "");
      expect(isPipelineComment({ body: c })).toBe(true);
      expect(c.endsWith(BOT_MARKER)).toBe(true);
    }
    expect(decisionComment("approved", "egirard", "queued as task #58")).toContain("task #58");
  });
});

function comment(body: string, association = "OWNER", author = "egirard", createdAt = "2026-01-01T00:00:00Z"): IssueComment {
  return { author, association, createdAt, body };
}

describe("decisionFromComment", () => {
  test("an owner approving in any of the usual shapes", () => {
    expect(decisionFromComment(comment("Approved"))).toBe("approved");
    expect(decisionFromComment(comment("approved: go ahead"))).toBe("approved");
    expect(decisionFromComment(comment("`approved`"))).toBe("approved");
  });
  test("a stranger's approval does not count unless they are listed", () => {
    expect(decisionFromComment(comment("Approved", "NONE"))).toBe(null);
    expect(decisionFromComment(comment("approved: go ahead", "NONE"))).toBe(null);
    expect(decisionFromComment(comment("Approved", "NONE", "driveby"), ["egirard"])).toBe(null);
    expect(decisionFromComment(comment("Approved", "NONE"), ["EGirard"])).toBe("approved");
  });
  test("prose that merely mentions approval is feedback, not a decision", () => {
    expect(decisionFromComment(comment("I approved this last week"))).toBe(null);
    expect(decisionFromComment(comment("can it also run migrations down?"))).toBe(null);
  });
  test("dismissal words", () => {
    expect(decisionFromComment(comment("reject - too narrow"))).toBe("dismissed");
    expect(decisionFromComment(comment("Dismissed."))).toBe("dismissed");
    expect(decisionFromComment(comment("declined, the architect can do it"))).toBe("dismissed");
  });
  test("the pipeline never reads its own comments", () => {
    expect(decisionFromComment(comment(decisionComment("approved", "egirard", "")))).toBe(null);
  });
});
