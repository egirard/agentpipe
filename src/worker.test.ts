import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadGlobalConfig, saveGlobalConfig } from "./global.ts";
import type { Registry } from "./registry.ts";
import { Store, type Task } from "./store.ts";
import { queuePrReview } from "./worker.ts";

/**
 * Queuing the pull request gate: every task that opens a pull request gets exactly one review
 * task with a gate on it, and nothing is queued when the feature is off, the agent is missing, or
 * the pull request is already watched. No worker, no git, no model: a scratch database only.
 */
let root: string;
let store: Store;
const saved = { data: process.env.AGENTPIPE_DATA_DIR, config: process.env.AGENTPIPE_CONFIG_DIR };
const PR = "https://github.com/egirard/agentpipe/pull/7";

/** A registry built by hand, so the test does not need the pr-gate agent package to exist. */
const WITH_GATE: Registry = { agents: new Map([["pr-gate", {} as any]]), dirs: [], problems: [] };
const WITHOUT_GATE: Registry = { agents: new Map([["coder", {} as any]]), dirs: [], problems: [] };

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "agentpipe-worker-"));
  process.env.AGENTPIPE_DATA_DIR = path.join(root, "data");
  process.env.AGENTPIPE_CONFIG_DIR = path.join(root, "config");
  mkdirSync(path.join(root, "repo"));
  const g = loadGlobalConfig();
  g.projects.demo = { path: path.join(root, "repo"), base: "main", push: false };
  g.defaultProject = "demo";
  saveGlobalConfig(g);
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

/** A finished task that opened a pull request, as the worker would leave it. */
function opened(over: { agent?: string; pr_url?: string | null } = {}): Task {
  const t = store.add({
    project: "demo",
    agent: over.agent ?? "coder",
    title: "Add a clamp helper",
    description: "Add clamp() to src/util.ts with tests.",
    acceptance: ["clamp() is exported", "unit tests cover both bounds"],
    branch: "agentpipe/coder-clamp-2026",
    priority: 50,
  });
  store.setStatus(t.id, "running");
  store.update(t.id, { pr_url: over.pr_url === undefined ? PR : over.pr_url, base_branch: "main" });
  store.setStatus(t.id, "done");
  return store.get(t.id)!;
}

describe("queuePrReview", () => {
  test("a finished task with a pull request gets one child review task carrying the gate", () => {
    const t = opened();
    const review = queuePrReview(store, loadGlobalConfig(), t, WITH_GATE);
    expect(review).not.toBeNull();
    expect(review!.agent).toBe("pr-gate");
    expect(review!.parent_id).toBe(t.id);
    expect(review!.branch).toBe("agentpipe/coder-clamp-2026");
    expect(review!.priority).toBe(40);
    expect(review!.created_by).toBe(`worker#${t.id}`);
    expect(review!.title).toContain(`Review PR for #${t.id}`);
    expect(review!.title.length).toBeLessThanOrEqual(200);
    expect(review!.acceptance.length).toBe(3);
    expect(review!.description).toContain(PR);
    expect(review!.description).toContain("agentpipe/coder-clamp-2026");
    expect(review!.description).toContain("clamp() is exported");
    expect(review!.description).toContain("Approve, Give feedback, or Deny");
    const stored = store.get(review!.id)!;
    expect(stored.pr_gate!.pr_url).toBe(PR);
    expect(stored.pr_gate!.source_task).toBe(t.id);
    expect(stored.pr_gate!.decision).toBeNull();
    expect(store.children(t.id).map((c) => c.id)).toEqual([review!.id]);
    expect(store.events(t.id).some((e) => e.kind === "pr-review")).toBe(true);
  });

  test("called twice for the same pull request it queues only one review", () => {
    const t = opened();
    expect(queuePrReview(store, loadGlobalConfig(), t, WITH_GATE)).not.toBeNull();
    expect(queuePrReview(store, loadGlobalConfig(), t, WITH_GATE)).toBeNull();
    expect(store.children(t.id).length).toBe(1);
  });

  test("no pull request, the feature off, a missing agent, or a gate task itself: nothing is queued", () => {
    const noPr = opened({ pr_url: null });
    expect(queuePrReview(store, loadGlobalConfig(), noPr, WITH_GATE)).toBeNull();
    expect(store.children(noPr.id)).toEqual([]);

    const off = loadGlobalConfig();
    off.prReview.enabled = false;
    const t1 = opened();
    expect(queuePrReview(store, off, t1, WITH_GATE)).toBeNull();
    expect(store.children(t1.id)).toEqual([]);

    const t2 = opened();
    expect(queuePrReview(store, loadGlobalConfig(), t2, WITHOUT_GATE)).toBeNull();
    expect(store.children(t2.id)).toEqual([]);

    const gateTask = opened({ agent: "pr-gate" });
    expect(queuePrReview(store, loadGlobalConfig(), gateTask, WITH_GATE)).toBeNull();
    expect(store.children(gateTask.id)).toEqual([]);
  });
});
