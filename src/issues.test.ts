import { describe, expect, test } from "bun:test";
import { issuesClient, parseIssueView, proposalsRepo, repoFromRemoteUrl, type GhRunner } from "./issues.ts";

/** The gh layer without gh: URL parsing, JSON mapping, and the exact commands the client issues. */
describe("repoFromRemoteUrl", () => {
  test("reads owner/name from https and ssh remotes and refuses other hosts", () => {
    expect(repoFromRemoteUrl("https://github.com/egirard/agentpipe.git")).toBe("egirard/agentpipe");
    expect(repoFromRemoteUrl("git@github.com:egirard/agentpipe.git\n")).toBe("egirard/agentpipe");
    expect(repoFromRemoteUrl("https://github.com/egirard/agentpipe")).toBe("egirard/agentpipe");
    expect(repoFromRemoteUrl("https://gitlab.com/x/y.git")).toBeNull();
    expect(repoFromRemoteUrl("")).toBeNull();
  });
  test("proposalsRepo prefers the configured repository and strips a URL form", async () => {
    const run: GhRunner = async () => ({ ok: true, output: "https://github.com/some/origin.git\n" });
    expect(await proposalsRepo("", run)).toBe("some/origin");
    expect(await proposalsRepo("https://github.com/egirard/agentpipe.git", run)).toBe("egirard/agentpipe");
    expect(await proposalsRepo("", async () => ({ ok: false, output: "fatal" }))).toBeNull();
  });
});

describe("parseIssueView", () => {
  test("maps the gh JSON and tolerates missing fields", () => {
    const v = parseIssueView({ number: 12, url: "https://github.com/e/a/issues/12", state: "open", title: "Proposed agent: x (claude)", body: "b", comments: [{ author: { login: "egirard" }, authorAssociation: "OWNER", createdAt: "2026-10-03T10:00:00Z", body: "approved" }, { body: "no author" }] });
    expect(v.number).toBe(12);
    expect(v.state).toBe("OPEN");
    expect(v.comments[0]).toEqual({ author: "egirard", association: "OWNER", createdAt: "2026-10-03T10:00:00Z", body: "approved" });
    expect(v.comments[1]).toEqual({ author: "", association: "", createdAt: "", body: "no author" });
    expect(parseIssueView(null).comments).toEqual([]);
  });
});

describe("issuesClient", () => {
  test("creates, views, comments and closes with --repo and body files, and reports gh failures", async () => {
    const calls: string[] = [];
    const run: GhRunner = async (cmd) => {
      calls.push(cmd);
      if (cmd.startsWith("gh issue create")) return { ok: true, output: "\nCreating issue in e/a\n\nhttps://github.com/e/a/issues/7\n" };
      if (cmd.startsWith("gh issue view")) return { ok: true, output: JSON.stringify({ number: 7, url: "https://github.com/e/a/issues/7", state: "OPEN", title: "t", body: "b", comments: [] }) };
      if (cmd.startsWith("gh issue close 9")) return { ok: false, output: "GraphQL: Could not resolve to an issue" };
      return { ok: true, output: "" };
    };
    const c = issuesClient("e/a", run, "/tmp");
    expect(await c.create("Proposed agent: x (claude)", "body\nwith lines")).toEqual({ url: "https://github.com/e/a/issues/7", number: 7 });
    expect(calls[0]).toMatch(/^gh issue create --repo "e\/a" --title "Proposed agent: x \(claude\)" --body-file "/);
    expect((await c.view(7)).number).toBe(7);
    expect(calls[1]).toBe('gh issue view 7 --repo "e/a" --json number,url,state,title,body,comments');
    await c.comment(7, "hello");
    expect(calls[2]).toMatch(/^gh issue comment 7 --repo "e\/a" --body-file "/);
    await c.close(7, "done", "completed");
    expect(calls[3]).toBe('gh issue close 7 --repo "e/a" --reason "completed" --comment "done"');
    await c.reopen(7);
    expect(calls[4]).toBe('gh issue reopen 7 --repo "e/a"');
    await expect(c.close(9, "x", "not planned")).rejects.toThrow(/Could not resolve/);
    await expect(issuesClient("e/a", async () => ({ ok: true, output: "nothing useful" }), "/tmp").create("t", "b")).rejects.toThrow(/no issue URL/);
  });
});
