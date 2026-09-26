import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
 */
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
  notifications: { webhook: "", command: "", events: ["attention", "failed", "digest", "budget", "agent-health", "worker"] },
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
    };
  }
  if (!cfg.defaultProject && Object.keys(cfg.projects).length === 1) cfg.defaultProject = Object.keys(cfg.projects)[0];
  return cfg;
}

export function saveGlobalConfig(cfg: GlobalConfig): string {
  const p = globalConfigPath();
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
  return p;
}

/** Resolve a project by name, or the project whose path contains `cwd`, or the default. */
export function resolveProject(cfg: GlobalConfig, name: string | undefined, cwd = process.cwd()): { name: string; project: ProjectConfig } {
  if (name) {
    const project = cfg.projects[name];
    if (!project) throw new Error(`unknown project "${name}"; known: ${Object.keys(cfg.projects).join(", ") || "(none; run: agentpipe projects add NAME PATH)"}`);
    return { name, project };
  }
  for (const [n, p] of Object.entries(cfg.projects)) {
    const rel = path.relative(p.path, path.resolve(cwd));
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return { name: n, project: p };
  }
  if (cfg.defaultProject && cfg.projects[cfg.defaultProject]) return { name: cfg.defaultProject, project: cfg.projects[cfg.defaultProject] };
  throw new Error(`no project given and none configured for ${cwd}. Register one: agentpipe projects add NAME PATH [--base main] [--push]`);
}

/** Where a project's worktrees go. */
export function worktreeRoot(cfg: GlobalConfig, projectName: string, project: ProjectConfig): string {
  return cfg.worktrees.root ? path.join(expandHome(cfg.worktrees.root), projectName) : path.join(project.path, ".agentpipe", "worktrees");
}
