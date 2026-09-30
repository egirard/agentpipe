import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Machine-wide settings for the queue, as opposed to the per-repo `agentpipe.json` that tunes
 * the pipeline. Lives in ~/.config/agentpipe/agentpipe.json; data (the task database, digests,
 * logs, certificates) lives in ~/.local/share/agentpipe (override with AGENTPIPE_DATA_DIR).
 *
 * Several projects (repositories in different directories) are served by one queue and one
 * worker. Each task names its project; the worker checks out the right repository per task in a
 * private worktree, so projects and tasks never interfere.
 *
 * A project is a stream of work: a directory with its own repository, or a long-lived branch of
 * another project's repository (`parent` set, `base` = the stream branch, so task pull requests
 * land on the stream branch and the stream merges into the parent's base when it is finished).
 * One project is current (`defaultProject`): commands default to it and the worker takes its
 * tasks first. Paused and archived projects keep their tasks but nothing of theirs runs.
 */
export const PROJECT_STATUSES = ["active", "paused", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** A step outside this machine (a GitHub repo to create, a branch to push) that waits for the human. */
export interface PendingStep {
  command: string;
  /** Directory the command runs in. */
  cwd: string;
  why: string;
}

export interface ProjectConfig {
  /** Absolute path of the main checkout. The worker never edits it; it makes worktrees next to it. */
  path: string;
  /** Branch tasks start from and pull requests target. */
  base: string;
  /** Push green branches and open pull requests (never merges). */
  push: boolean;
  /** Extra directory of agent packages for this project only. */
  agentsDir?: string;
  /** Entries of the main checkout to symlink into every worktree (installed dependencies, generated dirs). */
  link?: string[];
  /** Command run once in a fresh worktree before the first task uses it (e.g. "bun install"). */
  setup?: string;
  /** active (default), paused (tasks wait), archived (hidden, nothing runs, no new tasks). */
  status?: ProjectStatus;
  /** What this stream is for, in a sentence or two. Every agent working in it reads this. */
  goal?: string;
  /** GitHub repository (owner/name or URL), when there is one. */
  repo?: string;
  /** Branch stream: the project whose repository and base branch this one forked from. */
  parent?: string;
  /** ISO timestamp of creation. */
  created?: string;
  /** Remote steps waiting for `agentpipe projects approve`; the project does not run until they are done. */
  pending?: PendingStep[];
}

export interface GlobalConfig {
  projects: Record<string, ProjectConfig>;
  defaultProject: string | null;
  worker: {
    /** Seconds between queue polls when idle. */
    pollSec: number;
    /** Seconds to wait when a project checkout is unusable or the daily budget is spent. */
    pauseSec: number;
    /** Times a task may be (re)started after a crash or worker restart before it is failed. */
    maxAttempts: number;
    /**
     * Parallel lanes and how many tasks each runs at once. Agents are assigned to a lane by their
     * runtime (pipeline and ollama need the GPU; claude and shell do not) or by the manifest's
     * `lane` field. One GPU means gpu stays at 1.
     */
    lanes: Record<string, number>;
  };
  worktrees: {
    /** Where per-task worktrees live; empty = <project>/.agentpipe/worktrees. */
    root: string;
    /** Default entries to symlink from the main checkout when the project does not say. */
    link: string[];
    /** Remove a task's worktree when the task finishes (the branch stays). */
    cleanup: boolean;
  };
  architect: {
    maxRounds: number;
    maxOpenTasks: number;
    maxItemsPerReview: number;
    maxSubtasks: number;
    model: string;
  };
  budgets: {
    /** Claude spend one task may accumulate before its cloud calls are refused (USD as reported by Claude Code). 0 = unlimited. */
    taskUsd: number;
    /** Claude spend per calendar day (UTC) across everything; the worker stops claiming cloud tasks beyond it. 0 = unlimited. */
    dailyUsd: number;
    /** Warn (notify, flag in the catalog) when an agent's share of attention+failed outcomes over its last runs exceeds this. */
    agentAttentionRate: number;
    /** How many recent runs the rate is computed over. */
    agentWindow: number;
  };
  notifications: {
    /** POSTed a JSON body {kind,title,body,url,host,ts,text,content} for every enabled event. */
    webhook: string;
    /** Shell command run with NOTIFY_KIND/TITLE/BODY/URL in the environment. */
    command: string;
    events: string[];
  };
}

export const GLOBAL_DEFAULTS: GlobalConfig = {
  projects: {},
  defaultProject: null,
  worker: { pollSec: 30, pauseSec: 300, maxAttempts: 3, lanes: { gpu: 1, cloud: 1 } },
  worktrees: { root: "", link: ["node_modules"], cleanup: true },
  architect: { maxRounds: 4, maxOpenTasks: 300, maxItemsPerReview: 12, maxSubtasks: 30, model: "" },
  budgets: { taskUsd: 5, dailyUsd: 40, agentAttentionRate: 0.5, agentWindow: 10 },
  notifications: { webhook: "", command: "", events: ["attention", "failed", "cancelled", "digest", "budget", "agent-health", "worker"] },
};

export function configDir(): string {
  return process.env.AGENTPIPE_CONFIG_DIR || path.join(homedir(), ".config", "agentpipe");
}
export function dataDir(): string {
  const d = process.env.AGENTPIPE_DATA_DIR || path.join(homedir(), ".local", "share", "agentpipe");
  mkdirSync(d, { recursive: true });
  return d;
}
export function globalConfigPath(): string {
  return path.join(configDir(), "agentpipe.json");
}
/** Root of this agentpipe checkout (for built-in agents and helper scripts). */
export function agentpipeRoot(): string {
  return path.resolve(import.meta.dir, "..");
}

export function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(homedir(), p.slice(2)) : p;
}

function merge<T extends object>(base: T, over: Partial<T> | undefined): T {
  if (!over) return base;
  const out: any = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof (base as any)[k] === "object" && !Array.isArray((base as any)[k])) out[k] = merge((base as any)[k], v as any);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

export function loadGlobalConfig(): GlobalConfig {
  const p = globalConfigPath();
  let raw: Partial<GlobalConfig> = {};
  if (existsSync(p)) raw = JSON.parse(readFileSync(p, "utf8"));
  const { projects: rawProjects, ...rest } = raw;
  const cfg: GlobalConfig = merge(structuredClone(GLOBAL_DEFAULTS), rest as Partial<GlobalConfig>);
  cfg.projects = {};
  for (const [name, pr] of Object.entries(rawProjects ?? {})) {
    cfg.projects[name] = {
      path: path.resolve(expandHome(pr.path)),
      base: pr.base ?? "main",
      push: pr.push ?? false,
      ...(pr.agentsDir ? { agentsDir: pr.agentsDir } : {}),
      ...(pr.link ? { link: pr.link } : {}),
      ...(pr.setup ? { setup: pr.setup } : {}),
      ...(pr.status && pr.status !== "active" ? { status: pr.status } : {}),
      ...(pr.goal ? { goal: pr.goal } : {}),
      ...(pr.repo ? { repo: pr.repo } : {}),
      ...(pr.parent ? { parent: pr.parent } : {}),
      ...(pr.created ? { created: pr.created } : {}),
      ...(pr.pending?.length ? { pending: pr.pending } : {}),
    };
  }
  if (!cfg.defaultProject && Object.keys(cfg.projects).length === 1) cfg.defaultProject = Object.keys(cfg.projects)[0];
  return cfg;
}

export function saveGlobalConfig(cfg: GlobalConfig): string {
  const p = globalConfigPath();
  mkdirSync(path.dirname(p), { recursive: true });
  // Written by the CLI, the worker (projects the architect creates) and the tests; never leave half a file.
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
  renameSync(tmp, p);
  return p;
}

/** Load, change, save: for edits that must not overwrite what another process saved meanwhile. */
export function updateGlobalConfig<T>(fn: (cfg: GlobalConfig) => T): T {
  const cfg = loadGlobalConfig();
  const out = fn(cfg);
  saveGlobalConfig(cfg);
  return out;
}

export function projectStatus(p: ProjectConfig): ProjectStatus {
  return p.status ?? "active";
}

/** Whether the worker may run this project's tasks: active and no remote step waiting for approval. */
export function isRunnable(p: ProjectConfig): boolean {
  return projectStatus(p) === "active" && !p.pending?.length;
}

/** The current project's name, if one is set and still exists. */
export function currentProject(cfg: GlobalConfig): string | null {
  return cfg.defaultProject && cfg.projects[cfg.defaultProject] ? cfg.defaultProject : null;
}

function contains(dir: string, cwd: string): boolean {
  const rel = path.relative(dir, path.resolve(cwd));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function checkedOutBranch(cwd: string): string | null {
  const r = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd, stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}

/**
 * Which project a command means: the one named (by flag, then AGENTPIPE_PROJECT), else the one
 * whose checkout contains `cwd`, else the current project. Branch streams share their parent's
 * directory; among several projects at `cwd` the current one wins, then the one whose base branch
 * is checked out there, then the one that is not a branch stream.
 */
export function resolveProject(cfg: GlobalConfig, name: string | undefined, cwd = process.cwd()): { name: string; project: ProjectConfig } {
  name ??= process.env.AGENTPIPE_PROJECT || undefined;
  if (name) {
    const project = cfg.projects[name];
    if (!project) throw new Error(`unknown project "${name}"; known: ${Object.keys(cfg.projects).join(", ") || "(none; run: agentpipe projects add NAME PATH)"}`);
    return { name, project };
  }
  const here = Object.entries(cfg.projects).filter(([, p]) => projectStatus(p) !== "archived" && contains(p.path, cwd));
  if (here.length) {
    const current = currentProject(cfg);
    let pick = here.find(([n]) => n === current);
    if (!pick && here.length > 1) {
      const branch = checkedOutBranch(cwd);
      pick = here.find(([, p]) => p.base === branch) ?? here.find(([, p]) => !p.parent);
    }
    const [n, p] = pick ?? here[0];
    return { name: n, project: p };
  }
  const current = currentProject(cfg);
  if (current) return { name: current, project: cfg.projects[current] };
  throw new Error(`no project given and none configured for ${cwd}. Register one: agentpipe projects add NAME PATH [--base main] [--push]`);
}

/** Where a project's worktrees go. */
export function worktreeRoot(cfg: GlobalConfig, projectName: string, project: ProjectConfig): string {
  return cfg.worktrees.root ? path.join(expandHome(cfg.worktrees.root), projectName) : path.join(project.path, ".agentpipe", "worktrees");
}
