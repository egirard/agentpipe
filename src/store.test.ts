import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrGate } from "./pr.ts";
import { Store } from "./store.ts";

/**
 * The pull request gate a task carries: it survives a round trip through the database and
 * through unrelated updates. Everything runs on a scratch database.
 */
let root: string;
let store: Store;
const saved = { data: process.env.AGENTPIPE_DATA_DIR, config: process.env.AGENTPIPE_CONFIG_DIR };

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "agentpipe-store-"));
  process.env.AGENTPIPE_DATA_DIR = path.join(root, "data");
  process.env.AGENTPIPE_CONFIG_DIR = path.join(root, "config");
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

/** A gate with a nested snapshot, so the JSON round trip is actually exercised. */
function makeGate(over: Partial<PrGate> = {}): PrGate {
  return {
    pr_url: "https://github.com/egirard/agentpipe/pull/42",
    source_task: 7,
    decision: null,
    snapshot: {
      url: "https://github.com/egirard/agentpipe/pull/42",
      state: "OPEN",
      isDraft: false,
      reviewDecision: "CHANGES_REQUESTED",
      updatedAt: "2026-01-02T03:04:05Z",
      comments: [{ author: "alice", ts: "2026-01-02T03:00:00Z", body: "one nit" }],
      reviews: [{ author: "bob", state: "CHANGES_REQUESTED", ts: "2026-01-02T03:03:00Z", body: "please fix the naming" }],
      checks: { total: 3, failed: 1 },
    },
    checked_at: "2026-01-02T03:05:00Z",
    log: ["opened", "checked"],
    ...over,
  };
}

describe("pull request gates on a task", () => {
  test("a gate set with setPrGate comes back deep-equal from get and list", () => {
    const t = store.add({ project: "demo", agent: "coder", title: "x", description: "x" });
    expect(store.get(t.id)!.pr_gate).toBeNull();
    const gate = makeGate();
    expect(store.setPrGate(t.id, gate).pr_gate).toEqual(gate);
    expect(store.get(t.id)!.pr_gate).toEqual(gate);
    expect(store.list({ project: "demo" })[0].pr_gate).toEqual(gate);
  });

  test("setPrGate with null clears it", () => {
    const t = store.add({ project: "demo", agent: "coder", title: "x", description: "x" });
    store.setPrGate(t.id, makeGate());
    expect(store.setPrGate(t.id, null).pr_gate).toBeNull();
    expect(store.get(t.id)!.pr_gate).toBeNull();
  });

  test("an unrelated update leaves the gate intact", () => {
    const t = store.add({ project: "demo", agent: "coder", title: "x", description: "x" });
    const gate = makeGate({ decision: "approve", decided_by: "eugene", decided_at: "2026-01-02T04:00:00Z" });
    store.setPrGate(t.id, gate);
    const after = store.update(t.id, { summary: "x" });
    expect(after.summary).toBe("x");
    expect(after.pr_gate).toEqual(gate);
    expect(store.get(t.id)!.pr_gate).toEqual(gate);
  });
});

describe("openPrGates", () => {
  test("lists only tasks with a gate that are still open, and honours the project filter", () => {
    const add = (project: string, title: string) => store.add({ project, agent: "coder", title, description: title });
    const attention = add("demo", "waiting on the human");
    store.setPrGate(attention.id, makeGate());
    store.setStatus(attention.id, "attention");
    const queued = add("demo", "queued with a gate");
    store.setPrGate(queued.id, makeGate());
    const done = add("demo", "merged");
    store.setPrGate(done.id, makeGate());
    store.setStatus(done.id, "done");
    const cancelled = add("demo", "abandoned");
    store.setPrGate(cancelled.id, makeGate());
    store.setStatus(cancelled.id, "cancelled");
    const noGate = add("demo", "ordinary task");
    const other = add("other", "another project's pull request");
    store.setPrGate(other.id, makeGate());

    expect(store.openPrGates().map((t) => t.id)).toEqual([attention.id, queued.id, other.id]);
    expect(store.openPrGates("demo").map((t) => t.id)).toEqual([attention.id, queued.id]);
    expect(store.openPrGates("demo").map((t) => t.id)).not.toContain(noGate.id);
    expect(store.openPrGates("demo")[0].pr_gate!.pr_url).toBe("https://github.com/egirard/agentpipe/pull/42");
  });
});

describe("spendToday", () => {
  test("totals per project and overall", () => {
    const a = store.add({ project: "demo", agent: "coder", title: "a", description: "a" });
    const b = store.add({ project: "other", agent: "coder", title: "b", description: "b" });
    store.addUsage({ task_id: a.id, project: "demo", agent: "coder", label: "x", model: "m", cost_usd: 1.5, turns: 1, seconds: 1 });
    store.addUsage({ task_id: b.id, project: "other", agent: "coder", label: "x", model: "m", cost_usd: 2, turns: 1, seconds: 1 });
    expect(store.spendToday()).toBeCloseTo(3.5);
    expect(store.spendToday("demo")).toBeCloseTo(1.5);
    expect(store.spendToday("nothing")).toBe(0);
  });
});
