import { describe, expect, test } from "bun:test";
import { APPROVER_ASSOCIATIONS, BOT_MARKER, isPipelineComment, issueTitle, proposalMarker } from "./proposals.ts";
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
