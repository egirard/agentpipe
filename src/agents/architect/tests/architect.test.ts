import { describe, expect, test } from "bun:test";
import { fakeContext, loadAgent, runAgentE2E } from "../../../testkit.ts";
import verify from "../verify.ts";

const good = { status: "done" as const, summary: "Goal: add a skip-turn button.\n\n1. coder: reducer case + test.\n2. coder: button wired to the reducer, e2e 011 stays green.\n3. code-reviewer after 2.\n\nOpen questions: none.".padEnd(220, "."), findings: [], subtasks: [
  { title: "Add SKIP_TURN reducer case", description: "In src/store/gameSlice.ts add a SKIP_TURN action that ends the hero phase without an action. Add a unit test in src/store/gameSlice.test.ts covering: phase advances, no action consumed, no-op when not hero phase. Keep existing tests green.", agent: "coder", acceptance: ["src/store/gameSlice.test.ts has a passing test for SKIP_TURN", "bun run test:unit is green"] },
  { title: "Add the Skip turn button", description: "In src/components/HeroTurnPanel.svelte add a button labelled 'Skip turn' that dispatches SKIP_TURN. Disabled outside the hero phase. Unit test the component with @testing-library/svelte in src/components/HeroTurnPanel.test.ts; keep e2e/011-hero-turn.spec.ts green.", agent: "coder", acceptance: ["The button dispatches SKIP_TURN", "e2e/011-hero-turn.spec.ts passes"], after: [0] },
] };

describe("architect", () => {
  test("manifest loads", () => {
    const { manifest, problems } = loadAgent("architect", import.meta.dir + "/..");
    expect(problems).toEqual([]);
    expect(manifest.can_delegate).toBe(true);
    expect(manifest.commits).toBe(false);
  });
  test("accepts a real plan", async () => {
    expect(await verify(fakeContext({ result: good }))).toEqual([]);
  });
  test("rejects done without subtasks, vague subtasks, and file changes", async () => {
    const p1 = await verify(fakeContext({ result: { ...good, subtasks: [] } }));
    expect(p1.join(" ")).toContain("no subtasks");
    const p2 = await verify(fakeContext({ result: { ...good, subtasks: [{ title: "fix it", description: "as discussed", agent: "coder", acceptance: ["it works"] }] } }));
    expect(p2.length).toBeGreaterThanOrEqual(2);
    const p3 = await verify(fakeContext({ result: good, files: { "src/x.ts": "oops" } }));
    expect(p3.join(" ")).toContain("not allowed");
  });
  test("accepts a new stream instead of subtasks, rejects malformed ones", async () => {
    const stream = { name: "dungeon-editor", goal: "A level editor for Ashardalon dungeon tiles, as its own stream.", kind: "branch" as const, parent: "ashardalon" };
    expect(await verify(fakeContext({ result: { ...good, subtasks: [], projects: [stream] } }))).toEqual([]);
    const p = await verify(fakeContext({ result: { ...good, subtasks: [], projects: [{ ...stream, parent: undefined }, { ...stream, name: "c", kind: "clone" as const, parent: undefined }] } }));
    expect(p.join(" ")).toContain('needs "parent"');
    expect(p.join(" ")).toContain('needs "repo"');
  });
  test("accepts agent proposals with a reason, rejects existing names and subtasks for proposed agents", async () => {
    const proposal = { name: "db-migrator", description: "Writes and checks SQL migrations for the project's Postgres schema.", runtime: "claude" as const, why: "The goal needs a schema migration and no registered agent may touch SQL.", inputs: "", outputs: "", commits: true, shell: ["checks"] };
    expect(await verify(fakeContext({ result: { ...good, agent_proposals: [proposal] } }))).toEqual([]);
    const p1 = await verify(fakeContext({ result: { ...good, agent_proposals: [{ ...proposal, name: "coder" }] } }));
    expect(p1.join(" ")).toContain("already exists");
    const p2 = await verify(fakeContext({ result: { ...good, agent_proposals: [proposal], subtasks: [...good.subtasks, { title: "Write the migration", description: "Add a migration creating the heroes table with id, name, hp columns and a rollback; run the migration test in test/db.test.ts and keep it green.", agent: "db-migrator", acceptance: ["test/db.test.ts passes"] }] } }));
    expect(p2.join(" ")).toContain("does not exist yet");
    const p3 = await verify(fakeContext({ result: { ...good, status: "attention", subtasks: [], agent_proposals: [{ ...proposal, why: "needed" }] } }));
    expect(p3.join(" ")).toContain("does not say why");
  });
  test("a cancelled goal plans nothing", async () => {
    expect(await verify(fakeContext({ result: { ...good, status: "cancelled", subtasks: [] } }))).toEqual([]);
    expect((await verify(fakeContext({ result: { ...good, status: "cancelled" } }))).join(" ")).toContain("plans nothing");
  });
  test.skipIf(!process.env.AGENTPIPE_E2E)("plans a small goal into subtasks", async () => {
    const r = await runAgentE2E("architect", "Add a clamp(value, min, max) helper to src/utils.ts with unit tests, then document it in README.md.");
    expect(r.task.status).toBe("waiting");
    expect(r.children.length).toBeGreaterThanOrEqual(2);
    expect(r.children.map((c) => c.agent)).toContain("coder");
  }, 20 * 60_000);
});

describe("architect: upstream requests", () => {
  test("done with only upstreams is a complete answer; a malformed repo is not", async () => {
    const only = { ...good, subtasks: [], upstreams: [{ repo: "egirard/TabletopTemplate", why: "the template to scaffold from" }] };
    expect(await verify(fakeContext({ result: only }))).toEqual([]);
    const bad = await verify(fakeContext({ result: { ...only, upstreams: [{ repo: "just a name" }] } }));
    expect(bad.join(" ")).toContain("neither owner/name nor a git URL");
  });
});
