// src/pr.test.ts
import { describe, expect, test } from "bun:test";
import { parsePrUrl, snapshotFromJson, decisionComment, isPipelineComment } from "./pr.ts";

describe("parsePrUrl", () => {
  test("reads owner, repo and number from a github pull request url", () => {
    expect(parsePrUrl("https://github.com/egirard/agentpipe/pull/42")).toEqual({ owner: "egirard", repo: "agentpipe", number: 42 });
  });
  test("ignores a trailing path and query", () => {
    expect(parsePrUrl("https://github.com/egirard/agentpipe/pull/42/files?w=1")).toEqual({ owner: "egirard", repo: "agentpipe", number: 42 });
    expect(parsePrUrl("https://www.github.com/egirard/agentpipe/pull/7")).toEqual({ owner: "egirard", repo: "agentpipe", number: 7 });
  });
  test("rejects other hosts, missing numbers and junk", () => {
    for (const bad of ["https://gitlab.com/egirard/agentpipe/pull/42", "https://github.com/egirard/agentpipe/pull/abc", "https://github.com/egirard/agentpipe", "not a url", ""]) {
      expect(parsePrUrl(bad)).toBeNull();
    }
  });
});

const ghJson = {
  state: "OPEN",
  isDraft: false,
  reviewDecision: "CHANGES_REQUESTED",
  updatedAt: "2026-01-02T03:04:05Z",
  comments: [
    { author: { login: "alice" }, createdAt: "2026-01-02T03:00:00Z", body: "looks good" },
    { author: { login: "bob" }, createdAt: "2026-01-02T03:02:00Z", body: "one nit" },
  ],
  reviews: [{ author: { login: "carol" }, state: "CHANGES_REQUESTED", submittedAt: "2026-01-02T03:03:00Z", body: "please fix the naming" }],
  statusCheckRollup: [
    { name: "unit", conclusion: "SUCCESS" },
    { name: "lint", conclusion: "FAILURE" },
    { name: "e2e", state: "SUCCESS" },
  ],
};

describe("snapshotFromJson", () => {
  const url = "https://github.com/egirard/agentpipe/pull/42";
  test("maps a realistic gh payload", () => {
    const s = snapshotFromJson(url, ghJson);
    expect(s.url).toBe(url);
    expect(s.state).toBe("OPEN");
    expect(s.isDraft).toBe(false);
    expect(s.reviewDecision).toBe("CHANGES_REQUESTED");
    expect(s.updatedAt).toBe("2026-01-02T03:04:05Z");
    expect(s.comments).toEqual([
      { author: "alice", ts: "2026-01-02T03:00:00Z", body: "looks good" },
      { author: "bob", ts: "2026-01-02T03:02:00Z", body: "one nit" },
    ]);
    expect(s.reviews).toEqual([{ author: "carol", state: "CHANGES_REQUESTED", ts: "2026-01-02T03:03:00Z", body: "please fix the naming" }]);
    expect(s.checks).toEqual({ total: 3, failed: 1 });
  });
  test("an empty object gives an empty snapshot with the url", () => {
    expect(snapshotFromJson(url, {})).toEqual({ url, state: "", isDraft: false, reviewDecision: "", updatedAt: "", comments: [], reviews: [], checks: { total: 0, failed: 0 } });
  });
  test("a non-object raw does not throw", () => {
    expect(snapshotFromJson(url, null).checks).toEqual({ total: 0, failed: 0 });
    expect(snapshotFromJson(url, "nope").comments).toEqual([]);
    expect(snapshotFromJson(url, { comments: "nope", reviews: 3, statusCheckRollup: null, state: 5 }).state).toBe("");
  });
});
describe("decision comments", () => {
  test("every decision round-trips through isPipelineComment", () => {
    for (const decision of ["approve", "feedback", "deny"] as const) {
      const body = decisionComment({ decision, text: "please see the notes", by: "eugene", taskId: 12 });
      expect(isPipelineComment(body)).toBe(true);
      expect(body.split("\n")[0]).toBe(`<!-- agentpipe:decision=${decision} task=#12 -->`);
      expect(body).toContain("by eugene");
      expect(body).toContain("please see the notes");
    }
  });
  test("the heading names what happened", () => {
    expect(decisionComment({ decision: "approve", text: "", by: "eugene", taskId: 1 })).toBe("<!-- agentpipe:decision=approve task=#1 -->\n**agentpipe: approved by eugene**");
    expect(decisionComment({ decision: "feedback", text: "", by: "eugene", taskId: 1 })).toContain("changes requested by eugene");
    expect(decisionComment({ decision: "deny", text: "", by: "eugene", taskId: 1 })).toContain("rejected by eugene");
  });
  test("a human comment is not a pipeline comment", () => {
    expect(isPipelineComment("looks good to me")).toBe(false);
    expect(isPipelineComment("")).toBe(false);
  });
});
