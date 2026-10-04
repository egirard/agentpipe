import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isRunnable, loadGlobalConfig, resolveProject, saveGlobalConfig, updateGlobalConfig } from "./global.ts";
import { approvePending, createProject, queueStreamStart } from "./projects.ts";
import type { AgentResult, ProjectSpec } from "./result.ts";
import { Store } from "./store.ts";
import { sh } from "./util.ts";
import { createProposedProjects } from "./worker.ts";

let root: string;
const saved = { data: process.env.AGENTPIPE_DATA_DIR, config: process.env.AGENTPIPE_CONFIG_DIR, project: process.env.AGENTPIPE_PROJECT };

async function gitRepo(dir: string, opts: { origin?: string } = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# r\n");
  const r = await sh("git init -q -b main && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init", dir, 60);
  if (!r.ok) throw new Error(r.output);
  if (opts.origin) {
    await sh(`git init -q --bare -b main ${JSON.stringify(opts.origin)}`, root, 60);
    await sh(`git remote add origin ${JSON.stringify(opts.origin)} && git push -q -u origin main`, dir, 60);
  }
}

function register(name: string, dir: string, extra: object = {}) {
  updateGlobalConfig((g) => {
    g.projects[name] = { path: dir, base: "main", push: false, ...extra };
    g.defaultProject ??= name;
  });
}

const spec = (s: Partial<ProjectSpec> & Pick<ProjectSpec, "name" | "kind">): ProjectSpec => ({ goal: "A stream used by the project tests, nothing more.", ...s });

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "agentpipe-projects-"));
  process.env.AGENTPIPE_DATA_DIR = path.join(root, "data");
  process.env.AGENTPIPE_CONFIG_DIR = path.join(root, "config");
  delete process.env.AGENTPIPE_PROJECT;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [k, v] of [["AGENTPIPE_DATA_DIR", saved.data], ["AGENTPIPE_CONFIG_DIR", saved.config], ["AGENTPIPE_PROJECT", saved.project]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("resolveProject", () => {
  test("flag, then AGENTPIPE_PROJECT, then the checkout at cwd, then the current project", async () => {
    await gitRepo(path.join(root, "a"));
    await gitRepo(path.join(root, "b"));
    register("a", path.join(root, "a"));
    register("b", path.join(root, "b"));
    const g = loadGlobalConfig();
    expect(g.defaultProject).toBe("a");
    expect(resolveProject(g, undefined, root).name).toBe("a");
    expect(resolveProject(g, undefined, path.join(root, "b")).name).toBe("b");
    expect(resolveProject(g, "b", path.join(root, "a")).name).toBe("b");
    process.env.AGENTPIPE_PROJECT = "b";
    expect(resolveProject(g, undefined, root).name).toBe("b");
    expect(() => resolveProject(g, "nope")).toThrow("unknown project");
  });

  test("branch streams sharing a checkout: current wins, then the checked-out branch, then the parent", async () => {
    const dir = path.join(root, "a");
    await gitRepo(dir);
    await sh("git branch feature", dir, 30);
    register("a", dir);
    register("feat", dir, { base: "feature", parent: "a" });
    register("other", path.join(root, "elsewhere"));
    let g = loadGlobalConfig();
    expect(resolveProject(g, undefined, dir).name).toBe("a");
    g.defaultProject = "feat";
    expect(resolveProject(g, undefined, dir).name).toBe("feat");
    g.defaultProject = "other";
    expect(resolveProject(g, undefined, dir).name).toBe("a");
    await sh("git checkout -q feature", dir, 30);
    expect(resolveProject(g, undefined, dir).name).toBe("feat");
  });
});

describe("createProject", () => {
  test("existing: registers the checkout, becomes current when there is none, needs setup without agentpipe.json", async () => {
    const dir = path.join(root, "x");
    await gitRepo(dir);
    const c = await createProject(spec({ name: "x", kind: "existing", path: dir }), { allowRemote: false });
    expect(c.project.base).toBe("main");
    expect(c.project.push).toBe(false);
    expect(c.needsSetup).toBe(true);
    const g = loadGlobalConfig();
    expect(g.projects.x.goal).toContain("project tests");
    expect(g.defaultProject).toBe("x");
    await expect(createProject(spec({ name: "x", kind: "existing", path: dir }), { allowRemote: false })).rejects.toThrow("already exists");
    await expect(createProject(spec({ name: "y", kind: "existing", path: dir }), { allowRemote: false })).rejects.toThrow('already project "x"');
    await expect(createProject(spec({ name: "z", kind: "existing", path: path.join(root, "missing") }), { allowRemote: false })).rejects.toThrow("not a git checkout");
  });

  test("new: git init with a first commit; a GitHub repo is held for approval", async () => {
    const dir = path.join(root, "fresh");
    const c = await createProject(spec({ name: "fresh", kind: "new", path: dir, repo: "someone/fresh" }), { allowRemote: false });
    expect((await sh("git log --oneline", dir, 30)).output).toContain("Start fresh");
    expect(c.pending.map((p) => p.command).join(" ")).toContain("gh repo create");
    expect(c.project.push).toBe(true);
    const p = loadGlobalConfig().projects.fresh;
    expect(p.pending?.length).toBe(1);
    expect(isRunnable(p)).toBe(false);
    mkdirSync(path.join(root, "busy"));
    writeFileSync(path.join(root, "busy", "f"), "x");
    await expect(createProject(spec({ name: "busy", kind: "new", path: path.join(root, "busy") }), { allowRemote: false })).rejects.toThrow("not empty");
  });

  test("clone: from a URL or path into an empty directory", async () => {
    const src = path.join(root, "src-repo");
    await gitRepo(src, { origin: path.join(root, "origin.git") });
    const dir = path.join(root, "cloned");
    const c = await createProject(spec({ name: "cloned", kind: "clone", repo: path.join(root, "origin.git"), path: dir }), { allowRemote: false });
    expect(existsSync(path.join(dir, "README.md"))).toBe(true);
    expect(c.project.base).toBe("main");
    expect(c.project.push).toBe(true);
    expect(c.pending).toEqual([]);
  });

  test("branch: creates the stream branch from the parent's base, holds the push, approve pushes it", async () => {
    const dir = path.join(root, "parent");
    const origin = path.join(root, "parent.git");
    await gitRepo(dir, { origin });
    register("parent", dir, { push: true, setup: "true" });
    const c = await createProject(spec({ name: "feat", kind: "branch", parent: "parent", make_current: true }), { allowRemote: false });
    expect(c.project).toMatchObject({ path: dir, base: "feat", parent: "parent", push: true, setup: "true" });
    expect(c.needsSetup).toBe(false);
    expect((await sh("git rev-parse --verify -q refs/heads/feat", dir, 30)).ok).toBe(true);
    expect(c.pending.map((p) => p.command)).toEqual(['git push -u origin "feat"']);
    expect(loadGlobalConfig().defaultProject).toBe("feat");
    const out = await approvePending("feat");
    expect(out.join("\n")).toContain("approved");
    expect((await sh("git rev-parse --verify -q refs/heads/feat", origin, 30)).ok).toBe(true);
    expect(isRunnable(loadGlobalConfig().projects.feat)).toBe(true);
    await expect(createProject(spec({ name: "orphan", kind: "branch", parent: "nope" }), { allowRemote: false })).rejects.toThrow("needs \"parent\"");
  });

  test("allowRemote runs the held steps at once", async () => {
    const dir = path.join(root, "parent");
    await gitRepo(dir, { origin: path.join(root, "parent.git") });
    register("parent", dir, { push: true });
    const c = await createProject(spec({ name: "now", kind: "branch", parent: "parent" }), { allowRemote: true });
    expect(c.pending).toEqual([]);
    expect(c.notes.join(" ")).toContain("ran: git push");
    expect(loadGlobalConfig().projects.now.pending).toBeUndefined();
  });
});

describe("stream start and scheduling", () => {
  test("setup first, kickoff after it, both in the new project", async () => {
    const dir = path.join(root, "x");
    await gitRepo(dir);
    const s = spec({ name: "x", kind: "existing", path: dir, kickoff: "Build the first screen" });
    const created = await createProject(s, { allowRemote: false });
    const store = new Store();
    const [setup, kick] = queueStreamStart(store, created, s, "test");
    expect(setup.agent).toBe("project-setup");
    expect(kick.agent).toBe("architect");
    expect(kick.depends_on).toEqual([setup.id]);
    expect([setup.project, kick.project]).toEqual(["x", "x"]);
    store.close();
  });

  test("claimNext skips projects that may not run and takes the current project first", () => {
    const store = new Store();
    const a = store.add({ project: "a", agent: "coder", title: "a1", description: "a1", priority: 1 });
    const b = store.add({ project: "b", agent: "coder", title: "b1", description: "b1", priority: 90 });
    store.add({ project: "c", agent: "coder", title: "c1", description: "c1", priority: 1 });
    expect(store.claimNext({ projects: ["a", "b"], prefer: "b" })?.id).toBe(b.id);
    expect(store.claimNext({ projects: ["a", "b"], prefer: "b" })?.id).toBe(a.id);
    expect(store.claimNext({ projects: ["a", "b"], prefer: "b" })).toBeNull();
    expect(store.claimNext({ projects: [] })).toBeNull();
    store.close();
  });
});

describe("createProposedProjects (worker)", () => {
  const result = (over: Partial<AgentResult> = {}): AgentResult => ({ status: "done", summary: "Created the stream.", findings: [], subtasks: [], ...over });

  test("a clean result creates the stream and queues its setup; a held one needs the human", async () => {
    saveGlobalConfig(loadGlobalConfig());
    const store = new Store();
    const task = store.add({ project: "home", agent: "architect", title: "Create x", description: "Create x" });
    const dir = path.join(root, "x");
    await gitRepo(dir);
    const r1 = result();
    expect(await createProposedProjects(store, task, [spec({ name: "x", kind: "existing", path: dir })], { result: r1, verification: { ran: true, ok: true, problems: [] } })).toBe(false);
    expect(r1.status).toBe("done");
    expect(r1.summary).toContain("## Projects");
    expect(store.list({ project: "x" }).map((t) => t.agent)).toEqual(["project-setup"]);

    const r2 = result();
    expect(await createProposedProjects(store, task, [spec({ name: "gh", kind: "new", path: path.join(root, "gh"), repo: "me/gh" })], { result: r2, verification: { ran: true, ok: true, problems: [] } })).toBe(true);
    expect(r2.status).toBe("attention");
    expect(r2.summary).toContain("agentpipe projects approve gh");

    const r3 = result();
    await createProposedProjects(store, task, [spec({ name: "bad", kind: "existing", path: path.join(root, "nothing") })], { result: r3, verification: { ran: true, ok: true, problems: [] } });
    expect(r3.status).toBe("attention");
    expect(r3.summary).toContain("not created");
    store.close();
  });

  test("an unclean result creates nothing", async () => {
    const store = new Store();
    const task = store.add({ project: "home", agent: "architect", title: "Create y", description: "Create y" });
    const dir = path.join(root, "y");
    await gitRepo(dir);
    const r = result({ status: "attention" });
    await createProposedProjects(store, task, [spec({ name: "y", kind: "existing", path: dir })], { result: r, verification: { ran: true, ok: true, problems: [] } });
    expect(loadGlobalConfig().projects.y).toBeUndefined();
    expect(r.summary).toContain("not created");
    store.close();
  });
});

describe("upstreams and stream closure", () => {
  test("a new stream fetches its upstreams before anything runs, and approving its held steps closes the creating task", async () => {
    saveGlobalConfig(loadGlobalConfig());
    const template = path.join(root, "template");
    await gitRepo(template);
    const store = new Store();
    const task = store.add({ project: "home", agent: "architect", title: "Create z", description: "Create z" });
    store.setStatus(task.id, "running");
    const r: AgentResult = { status: "done", summary: "Created the stream.", findings: [], subtasks: [] };
    // "gh repo create" would fail here; a harmless pending command stands in for it.
    const created = await createProposedProjects(store, task, [spec({ name: "z", kind: "new", path: path.join(root, "z"), setup: "bun install", upstreams: [{ repo: template, name: "tt", why: "the template" }], kickoff: "Scaffold z from upstream/tt" })], { result: r, verification: { ran: true, ok: true, problems: [] } });
    expect(created).toBe(false);
    const z = loadGlobalConfig().projects.z;
    expect(z.upstreams?.tt.repo).toBe(template);
    expect(z.upstreams?.tt.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(z.createdByTask).toBe(task.id);
    expect(existsSync(path.join(root, "z", "upstream", "tt", "README.md"))).toBe(true);
    expect(r.summary).toContain("fetched " + template);
    // A new repository carries placeholder pipeline files in its first commit, so no setup task is needed yet.
    expect(store.list({ project: "z" }).map((t) => t.agent)).toEqual(["architect"]);
    expect(existsSync(path.join(root, "z", "agentpipe.json"))).toBe(true);
    // A setup command has nothing to run on in an empty repository, so it is not recorded.
    expect(z.setup).toBeUndefined();
    expect(r.summary).toContain('setup "bun install" not recorded');
    expect(store.list({ project: "z" })[0].description).toContain("upstream/tt");
    expect(store.list({ project: "z" })[0].description).toContain("placeholder commands");

    // Simulate the held GitHub step and the creating task waiting in attention.
    updateGlobalConfig((g) => void (g.projects.z.pending = [{ command: "true", cwd: path.join(root, "z"), why: "stand-in" }]));
    store.setStatus(task.id, "attention");
    expect(isRunnable(loadGlobalConfig().projects.z)).toBe(false);
    const lines = await approvePending("z", store);
    expect(lines.join("\n")).toContain("z approved");
    expect(lines.join("\n")).toContain(`#${task.id}`);
    expect(store.get(task.id)!.status).toBe("done");
    expect(isRunnable(loadGlobalConfig().projects.z)).toBe(true);
    store.close();
  });

  test("upstreams an agent requests for its own project are fetched; a bad one turns the task into attention", async () => {
    const { fetchRequestedUpstreams } = await import("./worker.ts");
    const dir = path.join(root, "home2");
    await gitRepo(dir);
    register("home2", dir);
    const template = path.join(root, "template2");
    await gitRepo(template);
    const store = new Store();
    const task = store.add({ project: "home2", agent: "architect", title: "Plan", description: "Plan" });
    const ok: AgentResult = { status: "done", summary: "Need the template.", findings: [], subtasks: [] };
    const f = await fetchRequestedUpstreams(store, task, [{ repo: template, name: "tt" }], { result: ok, verification: { ran: true, ok: true, problems: [] } });
    expect(f.ok).toBe(true);
    expect(f.replan).toBe(true);
    expect(f.notes[0]).toContain("fetched");
    expect(ok.status).toBe("done");
    expect(ok.summary).toContain("## Upstream repositories");
    expect(loadGlobalConfig().projects.home2.upstreams?.tt.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(store.events(task.id).some((e) => e.kind === "upstream")).toBe(true);
    const bad: AgentResult = { status: "done", summary: "Need another.", findings: [], subtasks: [] };
    expect((await fetchRequestedUpstreams(store, task, [{ repo: path.join(root, "missing") }], { result: bad, verification: { ran: true, ok: true, problems: [] } })).ok).toBe(false);
    expect(bad.status).toBe("attention");
    expect(bad.summary).toContain("NOT fetched");
    store.close();
  });
});
