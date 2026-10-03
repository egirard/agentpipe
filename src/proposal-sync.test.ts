import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadGlobalConfig, saveGlobalConfig, type GlobalConfig } from "./global.ts";
import type { IssuesClient, IssueView } from "./issues.ts";
import { BOT_MARKER } from "./proposals.ts";
import { approveProposal, commentOnProposal, creatorTaskDescription, dismissProposal, syncProposals } from "./proposal-sync.ts";
import type { Registry } from "./registry.ts";
import { Store } from "./store.ts";

/**
 * The proposal life cycle against a fake GitHub: publishing, reading decisions and feedback out of
 * the thread, queuing agent-creator on approval, closing what is built or dismissed. No gh, no model.
 */
let root: string;
let store: Store;
let g: GlobalConfig;
const saved = { data: process.env.AGENTPIPE_DATA_DIR, config: process.env.AGENTPIPE_CONFIG_DIR };

/** A GitHub that remembers what it was told and serves the thread we script. */
function fakeGitHub(threads: Record<number, Partial<IssueView>> = {}) {
  const calls: string[] = [];
  let next = 100;
  const client: IssuesClient = {
    repo: "e/a",
    async create(title) {
      const number = next++;
      calls.push(`create ${number} ${title}`);
      return { url: `https://github.com/e/a/issues/${number}`, number };
    },
    async view(number) {
      calls.push(`view ${number}`);
      return { number, url: `https://github.com/e/a/issues/${number}`, state: "OPEN", title: "", body: "", comments: [], ...threads[number] };
    },
    async comment(number, body) {
      calls.push(`comment ${number} ${body.split("\n")[0]}`);
    },
    async close(number, comment, reason) {
      calls.push(`close ${number} ${reason} ${comment.split("\n")[0]}`);
    },
    async reopen(number) {
      calls.push(`reopen ${number}`);
    },
  };
  return { client, calls };
}
const REGISTRY: Registry = { agents: new Map([["agent-creator", {} as any], ["coder", {} as any]]), dirs: [], problems: [] };
const spec = { name: "db-migrator", description: "Writes and applies SQLite migrations for the schema change a task describes.", runtime: "claude" as const, why: "No registered agent can change the schema safely, so every schema task stalls on the human.", inputs: "the table and column", outputs: "a branch", commits: true, shell: ["checks"] };
const owner = (body: string, createdAt: string) => ({ author: "egirard", association: "OWNER", createdAt, body });

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "agentpipe-propsync-"));
  process.env.AGENTPIPE_DATA_DIR = path.join(root, "data");
  process.env.AGENTPIPE_CONFIG_DIR = path.join(root, "config");
  mkdirSync(path.join(root, "repo"));
  g = loadGlobalConfig();
  g.projects.demo = { path: path.join(root, "repo"), base: "main", push: false };
  g.defaultProject = "demo";
  saveGlobalConfig(g);
  g = loadGlobalConfig();
  store = new Store();
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
  for (const [k, v] of [["AGENTPIPE_DATA_DIR", saved.data], ["AGENTPIPE_CONFIG_DIR", saved.config]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("syncProposals", () => {
  test("publishes an open proposal as an issue once, then reads the thread", async () => {
    const row = store.proposeAgent({ name: "db-migrator", spec, task_id: null, project: "demo", proposed_by: "architect-review" });
    const gh = fakeGitHub();
    let lines = await syncProposals(store, g, { client: gh.client, registry: REGISTRY });
    expect(lines[0]).toContain("published as https://github.com/e/a/issues/100");
    expect(gh.calls[0]).toBe("create 100 Proposed agent: db-migrator (claude)");
    const linked = store.proposal(row.id)!;
    expect(linked.issue_number).toBe(100);
    expect(linked.issue_repo).toBe("e/a");
    lines = await syncProposals(store, g, { client: gh.client, registry: REGISTRY });
    expect(lines).toEqual([]);
    expect(gh.calls.filter((c) => c.startsWith("create")).length).toBe(1);
  });
  test("records the owner's feedback for the architect and advances the cursor; pipeline comments are ignored", async () => {
    const row = store.proposeAgent({ name: "db-migrator", spec, task_id: null, project: "demo", proposed_by: "architect-review" });
    store.linkProposalIssue(row.id, { url: "https://github.com/e/a/issues/5", repo: "e/a", number: 5 });
    const gh = fakeGitHub({ 5: { comments: [{ author: "bot", association: "NONE", createdAt: "2026-10-03T09:00:00Z", body: `published\n${BOT_MARKER}` }, owner("Could it also run the migrations in a scratch database first?", "2026-10-03T10:00:00Z")] } });
    const lines = await syncProposals(store, g, { client: gh.client, registry: REGISTRY });
    expect(lines.join(" ")).toContain("1 new comment(s)");
    const thread = store.proposalComments(row.id);
    expect(thread.length).toBe(1);
    expect(thread[0].source).toBe("issue");
    expect(thread[0].answered).toBe(0);
    expect(store.proposalsAwaitingAnswer().map((r) => r.id)).toEqual([row.id]);
    expect(store.proposal(row.id)!.comment_cursor).toBe("2026-10-03T10:00:00Z");
    // Same thread again: nothing new.
    expect(await syncProposals(store, g, { client: gh.client, registry: REGISTRY })).toEqual([]);
    expect(store.proposalComments(row.id).length).toBe(1);
  });
  test("an owner's 'please implement' approves: agent-creator is queued and the issue told; a stranger's does not", async () => {
    const row = store.proposeAgent({ name: "db-migrator", spec, task_id: null, project: "demo", proposed_by: "architect-review" });
    store.linkProposalIssue(row.id, { url: "https://github.com/e/a/issues/5", repo: "e/a", number: 5 });
    const gh = fakeGitHub({ 5: { comments: [{ author: "passerby", association: "NONE", createdAt: "2026-10-03T09:00:00Z", body: "approved" }, owner("Please implement, but keep it read-only.", "2026-10-03T10:00:00Z")] } });
    const lines = await syncProposals(store, g, { client: gh.client, registry: REGISTRY });
    expect(lines.join(" ")).toContain("approved by egirard");
    const p = store.proposal(row.id)!;
    expect(p.status).toBe("approved");
    expect(p.decided_by).toBe("egirard");
    const task = store.get(p.creator_task!)!;
    expect(task.agent).toBe("agent-creator");
    expect(task.project).toBe("demo");
    expect(task.description).toContain("db-migrator");
    expect(task.description).toContain("keep it read-only");
    expect(gh.calls.some((c) => c.startsWith("comment 5 Approved by egirard"))).toBe(true);
    // An approved proposal is not re-read; it waits for the agent to appear.
    expect(await syncProposals(store, g, { client: gh.client, registry: REGISTRY })).toEqual([]);
  });
  test("a 'dismissed' comment or a closed issue dismisses; a registered agent closes the proposal as created", async () => {
    const a = store.proposeAgent({ name: "db-migrator", spec, task_id: null, project: "demo", proposed_by: "architect-review" });
    store.linkProposalIssue(a.id, { url: "https://github.com/e/a/issues/5", repo: "e/a", number: 5 });
    const b = store.proposeAgent({ name: "closed-one", spec: { ...spec, name: "closed-one" }, task_id: null, project: "demo", proposed_by: "architect-review" });
    store.linkProposalIssue(b.id, { url: "https://github.com/e/a/issues/6", repo: "e/a", number: 6 });
    const c = store.proposeAgent({ name: "coder", spec: { ...spec, name: "coder" }, task_id: null, project: "demo", proposed_by: "architect-review" });
    store.linkProposalIssue(c.id, { url: "https://github.com/e/a/issues/7", repo: "e/a", number: 7 });
    const gh = fakeGitHub({ 5: { comments: [owner("Dismissed: the coder can do this with a plain task.", "2026-10-03T10:00:00Z")] }, 6: { state: "CLOSED" } });
    const lines = await syncProposals(store, g, { client: gh.client, registry: REGISTRY });
    expect(store.proposal(a.id)!.status).toBe("dismissed");
    expect(gh.calls).toContain("close 5 not planned Dismissed by egirard. No agent will be created from this proposal; propose it again if that changes. comment on https://github.com/e/a/issues/5");
    expect(store.proposal(b.id)!.status).toBe("dismissed");
    expect(store.proposal(b.id)!.decision_note).toContain("closed on GitHub");
    expect(store.proposal(c.id)!.status).toBe("created");
    expect(gh.calls.some((x) => x.startsWith("close 7 completed Created by"))).toBe(true);
    expect(lines.length).toBe(3);
    expect(store.proposals("open")).toEqual([]);
  });
  test("a cancelled creator task reopens the proposal; without a client nothing touches GitHub", async () => {
    const row = store.proposeAgent({ name: "db-migrator", spec, task_id: null, project: "demo", proposed_by: "architect-review" });
    const r = await approveProposal(store, g, row.id, "eugene", { client: null });
    expect(r.task!.agent).toBe("agent-creator");
    store.setStatus(r.task!.id, "cancelled", "nope");
    store.update(r.task!.id, { error: "not worth it" });
    const lines = await syncProposals(store, g, { client: null, registry: REGISTRY });
    expect(lines.join(" ")).toContain("open for discussion again");
    expect(store.proposal(row.id)!.status).toBe("open");
    expect(store.proposal(row.id)!.decision_note).toContain("not worth it");
  });
});

describe("approve, dismiss, comment", () => {
  test("approve queues exactly one agent-creator task and is idempotent; dismiss and comment record their side", async () => {
    const row = store.proposeAgent({ name: "db-migrator", spec, task_id: 3, project: "demo", proposed_by: "agent:architect#3" });
    store.addProposalComment({ proposal_id: row.id, author: "eugene", source: "web", body: "Use sonnet." });
    const gh = fakeGitHub();
    store.linkProposalIssue(row.id, { url: "https://github.com/e/a/issues/5", repo: "e/a", number: 5 });
    const a = await approveProposal(store, g, row.id, "web", { note: "go", client: gh.client });
    expect(a.task!.description).toContain("Use sonnet.");
    expect(a.task!.priority).toBe(20);
    expect(a.task!.created_by).toBe(`proposal#${row.id}:web`);
    expect(gh.calls[0]).toContain("comment 5 Approved by web");
    const again = await approveProposal(store, g, row.id, "web", { client: gh.client });
    expect(again.task).toBeUndefined();
    expect(again.lines[0]).toContain("already approved");
    expect(store.list({ project: "demo", agent: "agent-creator" }).length).toBe(1);

    const other = store.proposeAgent({ name: "other", spec: { ...spec, name: "other" }, task_id: null, project: null, proposed_by: "architect-review" });
    const c = await commentOnProposal(store, g, other.id, "web", "Why not shell?", gh.client);
    expect(c.lines[0]).toContain("recorded");
    expect(store.proposalComments(other.id)[0].source).toBe("web");
    const d = await dismissProposal(store, g, other.id, "web", "covered by shell-runner", gh.client);
    expect(d.proposal.status).toBe("dismissed");
    expect(d.proposal.decision_note).toBe("covered by shell-runner");
    await expect(approveProposal(store, g, 999, "web", { client: null })).rejects.toThrow(/no agent proposal/);
  });
  test("creatorTaskDescription carries the specification and the feedback", () => {
    const row = store.proposeAgent({ name: "db-migrator", spec, task_id: null, project: "demo", proposed_by: "architect-review" });
    const text = creatorTaskDescription(row, spec, [{ ts: "2026-10-03T10:00:00Z", author: "egirard", body: "Keep it to SQLite." }]);
    expect(text).toContain("runtime: claude");
    expect(text).toContain("shell groups: checks");
    expect(text).toContain("Keep it to SQLite.");
    expect(text).toContain("docs/AGENTS.md");
  });
});
