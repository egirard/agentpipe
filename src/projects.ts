import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { currentProject, expandHome, loadGlobalConfig, projectStatus, updateGlobalConfig, type GlobalConfig, type PendingStep, type ProjectConfig } from "./global.ts";
import type { ProjectSpec } from "./result.ts";
import type { Store, Task } from "./store.ts";
import { log, sh } from "./util.ts";

/**
 * Creating and running streams of work (projects). The architect proposes a stream as a
 * ProjectSpec; this code makes it real. Everything local (clone, git init, a stream branch) runs
 * at once. Anything that changes GitHub (a new repository, pushing the stream branch) becomes a
 * pending step: the project is held until the human runs `agentpipe projects approve NAME`.
 * A human creating a stream from the CLI approves by running the command, so nothing is held.
 */

export interface Created {
  name: string;
  project: ProjectConfig;
  /** What was done, one line each, for the task log and the human. */
  notes: string[];
  /** Steps waiting for approval (empty when allowRemote or nothing remote was needed). */
  pending: PendingStep[];
  /** No agentpipe.json in the checkout (and not a branch stream): a project-setup task should write one. */
  needsSetup: boolean;
}

function q(s: string): string {
  return JSON.stringify(s);
}

async function run(cmd: string, cwd: string, timeoutSec = 300): Promise<string> {
  const r = await sh(cmd, cwd, timeoutSec);
  if (!r.ok) throw new Error(`${cmd} failed (${r.code}): ${r.output.trim().slice(0, 400)}`);
  return r.output.trim();
}

async function hasOrigin(dir: string): Promise<boolean> {
  return (await sh("git remote get-url origin", dir, 30)).ok;
}

/** The branch origin/HEAD points at, else the checked-out branch, else main. */
async function defaultBranch(dir: string): Promise<string> {
  const head = await sh("git symbolic-ref --short -q refs/remotes/origin/HEAD", dir, 30);
  if (head.ok && head.output.trim()) return head.output.trim().replace(/^origin\//, "");
  const cur = await sh("git symbolic-ref --short -q HEAD", dir, 30);
  return cur.ok && cur.output.trim() ? cur.output.trim() : "main";
}

function cloneSource(repo: string): string {
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? `https://github.com/${repo}.git` : repo;
}

function isEmptyDir(dir: string): boolean {
  return !existsSync(dir) || readdirSync(dir).length === 0;
}

/** Create a project from a spec and register it. Throws (having registered nothing) when a local step fails. */
export async function createProject(spec: ProjectSpec, opts: { allowRemote: boolean }): Promise<Created> {
  const g = loadGlobalConfig();
  if (g.projects[spec.name]) throw new Error(`project "${spec.name}" already exists (${g.projects[spec.name].path})`);
  const notes: string[] = [];
  const pending: PendingStep[] = [];
  let project: ProjectConfig;

  if (spec.kind === "branch") {
    const parentName = spec.parent;
    const parent = parentName ? g.projects[parentName] : undefined;
    if (!parentName || !parent) throw new Error(`branch stream "${spec.name}" needs "parent": one of ${Object.keys(g.projects).join(", ") || "(no projects)"}`);
    const dir = parent.path;
    const branch = spec.branch ?? spec.name;
    if (!(await sh(`git check-ref-format --branch ${q(branch)}`, dir, 30)).ok) throw new Error(`"${branch}" is not a valid branch name`);
    const origin = await hasOrigin(dir);
    if (origin) await sh("git fetch -q origin", dir, 180);
    if ((await sh(`git rev-parse --verify -q ${q("refs/heads/" + branch)}`, dir, 30)).ok) notes.push(`branch ${branch} already exists in ${dir}; the stream uses it as is`);
    else if (origin && (await sh(`git rev-parse --verify -q ${q("refs/remotes/origin/" + branch)}`, dir, 30)).ok) {
      await run(`git branch --track ${q(branch)} ${q("origin/" + branch)}`, dir);
      notes.push(`branch ${branch} tracks the existing origin/${branch}`);
    } else {
      const from = origin && (await sh(`git rev-parse --verify -q ${q("origin/" + parent.base)}`, dir, 30)).ok ? `origin/${parent.base}` : parent.base;
      await run(`git branch ${q(branch)} ${q(from)}`, dir);
      notes.push(`created branch ${branch} from ${from} in ${dir}`);
    }
    const push = spec.push ?? parent.push;
    if (push && origin && !(await sh(`git rev-parse --verify -q ${q("refs/remotes/origin/" + branch)}`, dir, 30)).ok) {
      pending.push({ command: `git push -u origin ${q(branch)}`, cwd: dir, why: `pull requests of this stream target ${branch}, which must exist on GitHub` });
    }
    project = {
      path: dir,
      base: branch,
      push,
      parent: parentName,
      ...(parent.repo ? { repo: parent.repo } : {}),
      ...(parent.agentsDir ? { agentsDir: parent.agentsDir } : {}),
      ...((spec.link ?? parent.link) ? { link: spec.link ?? parent.link } : {}),
      ...((spec.setup ?? parent.setup) ? { setup: spec.setup ?? parent.setup } : {}),
    };
  } else {
    const dir = path.resolve(expandHome(spec.path ?? path.join(homedir(), "src", spec.name)));
    const taken = Object.entries(g.projects).find(([, p]) => p.path === dir && !p.parent);
    if (taken) throw new Error(`${dir} is already project "${taken[0]}"; for a second stream in it use kind "branch" with parent "${taken[0]}"`);
    if (spec.kind === "existing") {
      if (!existsSync(path.join(dir, ".git"))) throw new Error(`${dir} is not a git checkout`);
      notes.push(`registered the existing checkout ${dir}`);
    } else if (spec.kind === "clone") {
      if (!spec.repo) throw new Error(`clone needs "repo" (URL or owner/name)`);
      if (!isEmptyDir(dir)) throw new Error(`${dir} exists and is not empty; use kind "existing" if it is the checkout`);
      mkdirSync(path.dirname(dir), { recursive: true });
      await run(`git clone -q ${q(cloneSource(spec.repo))} ${q(dir)}`, path.dirname(dir), 900);
      notes.push(`cloned ${spec.repo} into ${dir}`);
    } else {
      if (existsSync(path.join(dir, ".git"))) throw new Error(`${dir} is already a git checkout; use kind "existing"`);
      if (!isEmptyDir(dir)) throw new Error(`${dir} exists and is not empty; refusing to git init over it`);
      mkdirSync(dir, { recursive: true });
      const base = spec.base ?? "main";
      await run(`git init -q -b ${q(base)}`, dir);
      // Worktrees need a commit to start from.
      const who = (await sh("git config user.email", dir, 30)).output.trim() ? "" : "-c user.name=agentpipe -c user.email=agentpipe@localhost ";
      await run(`git ${who}commit -q --allow-empty -m ${q(`Start ${spec.name}\n\n${spec.goal}`)}`, dir);
      notes.push(`created an empty repository at ${dir} (branch ${base})`);
      if (spec.repo) {
        pending.push({ command: `gh repo create ${q(spec.repo.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, ""))} --private --source . --remote origin --push`, cwd: dir, why: `create the private GitHub repository ${spec.repo} and push ${base}` });
      }
    }
    const origin = await hasOrigin(dir);
    project = {
      path: dir,
      base: spec.base ?? (await defaultBranch(dir)),
      push: spec.push ?? (origin || Boolean(spec.repo)),
      ...(spec.repo ? { repo: spec.repo } : {}),
      ...(spec.link ? { link: spec.link } : {}),
      ...(spec.setup ? { setup: spec.setup } : {}),
    };
  }

  project.goal = spec.goal;
  project.created = new Date().toISOString();
  if (pending.length && opts.allowRemote) {
    for (const step of pending.splice(0)) {
      await run(step.command, step.cwd, 600);
      notes.push(`ran: ${step.command}`);
    }
  }
  if (pending.length) project.pending = pending;

  const makeCurrent = updateGlobalConfig((cfg) => {
    if (cfg.projects[spec.name]) throw new Error(`project "${spec.name}" was created meanwhile`);
    cfg.projects[spec.name] = project;
    const cur = spec.make_current || !currentProject(cfg);
    if (cur) cfg.defaultProject = spec.name;
    return cur;
  });
  if (makeCurrent) notes.push(`${spec.name} is now the current project`);
  if (pending.length) notes.push(`held until approved: ${pending.map((p) => p.command).join("; ")} (agentpipe projects approve ${spec.name})`);
  log(`projects: created ${spec.name} (${spec.kind}) at ${project.path}, base ${project.base}`);
  // A branch stream shares its parent's repository setup; setting it up is the parent's business.
  const needsSetup = !project.parent && !existsSync(path.join(project.path, "agentpipe.json"));
  if (project.parent && !existsSync(path.join(project.path, "agentpipe.json"))) notes.push(`note: ${project.parent} has no agentpipe.json; agents use the default commands until it gets one`);
  return { name: spec.name, project, notes, pending, needsSetup };
}

/**
 * First tasks of a new stream: project-setup (when the repo has no agentpipe.json) and the
 * kickoff goal for the architect, after setup. Top-level tasks of the new project, so the stream
 * tracks its own progress; `createdBy` links them back to whoever created the stream.
 */
export function queueStreamStart(store: Store, created: Created, spec: ProjectSpec, createdBy: string): Task[] {
  const out: Task[] = [];
  if (created.needsSetup) {
    out.push(
      store.add({
        project: created.name,
        agent: "project-setup",
        title: `Set up agentpipe for ${created.name}`,
        description: `A new stream of work was created: ${spec.goal}\n\nWrite agentpipe.json (the lint and unit test commands that work in this repository) and AGENTPIPE.md (guidance every agent reads) at the repository root.`,
        acceptance: ["agentpipe.json exists at the repository root with commands.lint and commands.unit that exit 0 on the current tree", "AGENTPIPE.md exists and describes the layout, conventions and how to run things"],
        priority: 10,
        created_by: createdBy,
      }),
    );
  }
  if (spec.kickoff) {
    out.push(
      store.add({
        project: created.name,
        agent: "architect",
        title: spec.kickoff.split("\n")[0].slice(0, 120),
        description: spec.kickoff,
        depends_on: out.map((t) => t.id),
        created_by: createdBy,
      }),
    );
  }
  return out;
}

/** Run a held project's pending remote steps in order. Stops at the first failure; what ran is not repeated. */
export async function approvePending(name: string): Promise<string[]> {
  const g = loadGlobalConfig();
  const p = g.projects[name];
  if (!p) throw new Error(`unknown project "${name}"`);
  if (!p.pending?.length) return [`${name} has nothing waiting for approval`];
  const out: string[] = [];
  const left = [...p.pending];
  try {
    while (left.length) {
      const step = left[0];
      out.push(`$ ${step.command}   (in ${step.cwd})`);
      out.push(await run(step.command, step.cwd, 600));
      left.shift();
    }
  } finally {
    updateGlobalConfig((cfg) => {
      if (!cfg.projects[name]) return;
      if (left.length) cfg.projects[name].pending = left;
      else delete cfg.projects[name].pending;
    });
  }
  out.push(`${name} approved; its tasks will run`);
  return out.filter(Boolean);
}

/** Open the pull request that merges a branch stream into its parent's base. Never merges. */
export async function finishStream(name: string): Promise<string> {
  const g = loadGlobalConfig();
  const p = g.projects[name];
  if (!p) throw new Error(`unknown project "${name}"`);
  const parent = p.parent ? g.projects[p.parent] : undefined;
  if (!p.parent || !parent) throw new Error(`${name} is not a branch stream; its pull requests already target ${p.base}`);
  if (!(await hasOrigin(p.path))) throw new Error(`${p.path} has no origin remote; merge ${p.base} into ${parent.base} by hand`);
  await run(`git push -u origin ${q(p.base)}`, p.path, 300);
  const body = `${p.goal ?? ""}\n\nMerges the agentpipe stream \`${name}\` (branch \`${p.base}\`) into \`${parent.base}\`.`;
  const r = await sh(`gh pr create --head ${q(p.base)} --base ${q(parent.base)} --title ${q(`${name}: ${(p.goal ?? p.base).split("\n")[0].slice(0, 150)}`)} --body ${q(body)}`, p.path, 120);
  if (!r.ok) throw new Error(`gh pr create failed: ${r.output.trim()}`);
  return r.output.trim().split("\n").find((l) => l.startsWith("https://")) ?? r.output.trim();
}

/** The project roster for prompts: agents that create streams must know what exists. */
export function renderProjects(gcfg: GlobalConfig, store?: Store): string {
  const cur = currentProject(gcfg);
  const rows = Object.entries(gcfg.projects).map(([n, p]) => {
    const c = store?.counts(n);
    const open = store ? store.openCount(n) : null;
    const state = p.pending?.length ? "held for approval" : projectStatus(p);
    return `- ${n}${n === cur ? " (current)" : ""} [${state}]: ${p.path}, ${p.parent ? `branch ${p.base} of ${p.parent}` : `base ${p.base}`}${p.repo ? `, GitHub ${p.repo}` : ""}${p.push ? ", opens PRs" : ""}${open !== null ? `; ${open} open, ${c!.done} done` : ""}${p.goal ? `\n  goal: ${p.goal.replace(/\s+/g, " ")}` : ""}`;
  });
  return rows.join("\n") || "(no projects)";
}

/** One line on what kind of stream a project is, for agent prompts. */
export function describeStream(name: string, p: ProjectConfig): string {
  const where = p.parent ? `a branch stream of ${p.parent}: work happens on branch ${p.base}, task pull requests target ${p.base}, and the stream is merged into its parent by a human later` : `base branch ${p.base}`;
  return `${name} at ${p.path}; ${where}${p.goal ? `.\nStream goal: ${p.goal}` : ""}`;
}
