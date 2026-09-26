import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadGlobalConfig, saveGlobalConfig } from "./global.ts";
import { loadRegistry, type AgentManifest } from "./registry.ts";
import type { AgentResult } from "./result.ts";
import { Store, type Task } from "./store.ts";
import { sh } from "./util.ts";
import type { VerifyContext } from "./verify.ts";
import { runWorker } from "./worker.ts";

/**
 * Helpers for agent tests (bun test). Two tiers:
 *   - cheap: load the manifest, exercise verify.ts with a fake context; always run
 *   - e2e:   run the real agent through the real worker on a scratch project; only with AGENTPIPE_E2E=1
 * Everything happens in temp directories: a scratch queue, a scratch config, a scratch git repo.
 */

/** Load one agent's manifest as the registry would, from its directory, and report problems. */
export function loadAgent(name: string, agentDir: string): { manifest: AgentManifest; problems: string[] } {
  const parent = path.dirname(path.resolve(agentDir));
  const reg = loadRegistry({ path: parent, base: "main", push: false, agentsDir: parent });
  const manifest = reg.agents.get(name);
  if (!manifest) throw new Error(`agent ${name} did not load from ${agentDir}: ${reg.problems.join("; ")}`);
  return { manifest, problems: reg.problems.filter((p) => p.includes(path.resolve(agentDir))) };
}

/** A VerifyContext with sensible defaults, for exercising verify.ts without a run. */
export function fakeContext(over: Partial<VerifyContext> & { result: AgentResult; files?: Record<string, string> }): VerifyContext {
  const files = over.files ?? {};
  const task: Task = {
    id: 1,
    project: "test",
    agent: "test",
    title: "test task",
    description: "test",
    acceptance: [],
    status: "running",
    priority: 50,
    parent_id: null,
    depends_on: [],
    files: [],
    branch: null,
    base_branch: null,
    round: 0,
    attempts: 1,
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: null,
    created_by: "test",
    summary: null,
    run_dir: null,
    pr_url: null,
    error: null,
    triaged: 0,
    agent_version: null,
    cost_usd: 0,
    lane: null,
    worktree: null,
  };
  const { files: _f, ...rest } = over;
  return {
    task,
    manifest: { name: "test", description: "test agent for verify", runtime: "shell", when_to_use: "", inputs: "", outputs: "", can_delegate: false, commits: false, model: "", tools: [], shell: [], paths: [], lane: "cloud", max_turns: 1, timeout_sec: 60, context: [], task_prefix: "", command: "true", prompt: "", verify: "", tags: [], enabled: true, source: "", dir: null, verifier: null, hasTests: false, extras: [], version: "test" },
    projectName: "test",
    project: { path: "/nonexistent", base: "main", push: false },
    repo: "/nonexistent",
    agentDir: null,
    runDir: "/nonexistent",
    branch: null,
    baseSha: "0000000",
    startBranch: "main",
    changedFiles: Object.keys(files),
    diff: async () => "",
    read: (rel) => {
      if (!(rel in files)) throw new Error(`no such file in fake repo: ${rel}`);
      return files[rel];
    },
    exists: (rel) => rel in files,
    sh: async () => ({ ok: true, code: 0, output: "", timedOut: false, seconds: 0 }),
    ...rest,
  };
}

export interface Scratch {
  root: string;
  repo: string;
  dataDir: string;
  configDir: string;
  cleanup(): void;
}

/** A throwaway git repo plus isolated queue and config, registered as project "scratch". */
export async function makeScratch(opts: { files?: Record<string, string>; repoConfig?: object; agentsDir?: string } = {}): Promise<Scratch> {
  const root = mkdtempSync(path.join(tmpdir(), "agentpipe-test-"));
  const repo = path.join(root, "repo");
  const dataDir = path.join(root, "data");
  const configDir = path.join(root, "config");
  mkdirSync(repo);
  mkdirSync(dataDir);
  mkdirSync(configDir);
  process.env.AGENTPIPE_DATA_DIR = dataDir;
  process.env.AGENTPIPE_CONFIG_DIR = configDir;
  const files = { "README.md": "# scratch\n", "src/utils.ts": "export const one = 1;\n", ...opts.files };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), text);
  }
  writeFileSync(path.join(repo, "agentpipe.json"), JSON.stringify({ models: { cloud: process.env.AGENTPIPE_TEST_MODEL ?? "sonnet" }, commands: { lint: "true", unit: "true", e2e: "true" }, ...opts.repoConfig }, null, 2));
  const init = await sh("git init -q -b main && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init", repo, 60);
  if (!init.ok) throw new Error(`git init failed: ${init.output}`);
  await sh("git config user.email test@agentpipe && git config user.name agentpipe-test", repo, 30);
  const g = loadGlobalConfig();
  g.projects.scratch = { path: repo, base: "main", push: false, ...(opts.agentsDir ? { agentsDir: opts.agentsDir } : {}) };
  g.defaultProject = "scratch";
  g.worker.pollSec = 1;
  saveGlobalConfig(g);
  return { root, repo, dataDir, configDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export interface E2EResult {
  task: Task;
  children: Task[];
  runDir: string | null;
  report: string | null;
  result: AgentResult | null;
  scratch: Scratch;
}

/**
 * Queue one task for `agent` on a scratch project and run the worker once. The agent directory
 * is exposed to the scratch project through agentsDir so an agent under development is found
 * even when it is not in a registry directory.
 */
export async function runAgentE2E(agent: string, description: string, opts: { agentDir?: string; files?: Record<string, string>; taskFiles?: string[]; acceptance?: string[]; branch?: string; keep?: boolean } = {}): Promise<E2EResult> {
  const scratch = await makeScratch({ files: opts.files, agentsDir: opts.agentDir ? path.dirname(path.resolve(opts.agentDir)) : undefined });
  const store = new Store();
  const g = loadGlobalConfig();
  const t = store.add({ project: "scratch", agent, title: description.split("\n")[0].slice(0, 120), description, acceptance: opts.acceptance ?? [], files: opts.taskFiles ?? [], branch: opts.branch ?? null, created_by: "test" });
  await runWorker(store, g, { once: true });
  const task = store.get(t.id)!;
  const children = store.children(t.id);
  const runDir = task.run_dir;
  const read = (f: string) => {
    try {
      return readFileSync(path.join(runDir!, f), "utf8");
    } catch {
      return null;
    }
  };
  const out: E2EResult = { task, children, runDir, report: runDir ? read("report.md") : null, result: runDir ? (JSON.parse(read("result.json") ?? "null") as AgentResult | null) : null, scratch };
  store.close();
  if (!opts.keep) scratch.cleanup();
  return out;
}
