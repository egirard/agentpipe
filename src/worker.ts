import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { recordProposals } from "./actions.ts";
import { loadConfig } from "./config.ts";
import { currentProject, dataDir, isRunnable, loadGlobalConfig, worktreeRoot, type GlobalConfig, type ProjectConfig } from "./global.ts";
import { notify } from "./notify.ts";
import { createProject, queueStreamStart } from "./projects.ts";
import { loadRegistry, type AgentManifest, type Registry } from "./registry.ts";
import { ensureIgnored, excludeAgentpipeDir } from "./repo.ts";
import type { ProjectSpec, Subtask } from "./result.ts";
import { runAgent, type AgentRunContext, type RunOutcome } from "./runner.ts";
import { TERMINAL_STATUSES, type Store, type Task } from "./store.ts";
import { BudgetExceeded, clip, log, setLogFile, sh, withRunContext } from "./util.ts";

/**
 * The worker drains the queue. It runs one task per lane slot concurrently: by default one
 * `gpu` slot (pipeline and ollama agents share the one GPU) and one `cloud` slot (claude and
 * shell agents). Every task gets a private git worktree of its project, so tasks from any
 * projects run side by side without touching each other or the human's checkout.
 *
 * Projects: the config is re-read before every claim, so projects added, switched, paused or
 * approved while the worker runs take effect at once. Only runnable projects (active, nothing
 * held for approval) are claimed from, and the current project's tasks go first.
 *
 * Budgets: a task whose Claude spend reaches budgets.taskUsd has its next cloud call refused
 * (the task ends in attention). When the day's spend reaches budgets.dailyUsd, lanes stop
 * claiming tasks that need Claude until the next UTC day; ollama and shell agents keep running.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface WorkerOpts {
  once?: boolean;
  project?: string;
}

function lockPath(): string {
  return path.join(dataDir(), "worker.pid");
}

/** Only one worker per machine. A stale lock from a dead process is taken over. */
export function acquireLock(): () => void {
  const p = lockPath();
  if (existsSync(p)) {
    const pid = Number(readFileSync(p, "utf8").trim());
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive && pid !== process.pid) throw new Error(`another worker (pid ${pid}) holds ${p}. Stop it first (systemctl --user stop agentpipe-worker) or remove the file if it is stale.`);
  }
  writeFileSync(p, String(process.pid));
  const release = () => {
    try {
      if (existsSync(p) && readFileSync(p, "utf8").trim() === String(process.pid)) unlinkSync(p);
    } catch {
      /* nothing */
    }
  };
  return release;
}

function usesClaude(m: AgentManifest): boolean {
  return m.runtime === "claude" || m.runtime === "pipeline";
}

/** Agents (across all projects' registries) that a lane serves, split by whether they spend Claude budget. */
function laneAgents(gcfg: GlobalConfig, lane: string): { all: string[]; free: string[] } {
  const all = new Set<string>();
  const free = new Set<string>();
  const projects = Object.values(gcfg.projects);
  for (const reg of (projects.length ? projects : [undefined]).map((p) => loadRegistry(p))) {
    for (const m of reg.agents.values()) {
      if (m.lane !== lane) continue;
      all.add(m.name);
      if (!usesClaude(m)) free.add(m.name);
    }
  }
  return { all: [...all], free: [...free] };
}

export async function runWorker(store: Store, gcfg: GlobalConfig, opts: WorkerOpts = {}) {
  const release = acquireLock();
  setLogFile(path.join(dataDir(), "worker.log"));
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log("worker: stop requested; finishing running tasks first");
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  try {
    for (const t of store.recoverInterrupted(gcfg.worker.maxAttempts)) log(`worker: recovered interrupted task #${t.id} -> ${t.status}`);
    for (const [name, project] of Object.entries(gcfg.projects)) await pruneWorktrees(store, gcfg, name, project);
    const lanes = Object.entries(gcfg.worker.lanes).filter(([, n]) => n > 0);
    log(`worker: started (pid ${process.pid}, db ${store.path}, projects: ${Object.keys(gcfg.projects).join(", ") || "none"}, lanes: ${lanes.map(([l, n]) => `${l}x${n}`).join(" ")})`);

    let budgetNotified = "";
    let claimedOnce = false;
    let cfgError = "";
    const fresh = (): GlobalConfig => {
      try {
        gcfg = loadGlobalConfig();
        cfgError = "";
      } catch (e) {
        // Mid-edit or broken: keep working with the last good config, say so once.
        if (cfgError !== (e as Error).message) log(`worker: config unreadable, keeping the previous one: ${(cfgError = (e as Error).message)}`);
      }
      return gcfg;
    };
    const slot = async (lane: string, index: number) => {
      const label = `${lane}${index}`;
      while (!stopping) {
        if (opts.once && claimedOnce) return;
        const g = fresh();
        const agents = laneAgents(g, lane);
        const overBudget = gcfg.budgets.dailyUsd > 0 && store.spendToday() >= gcfg.budgets.dailyUsd;
        if (overBudget) {
          const today = new Date().toISOString().slice(0, 10);
          if (budgetNotified !== today) {
            budgetNotified = today;
            log(`worker: daily Claude budget of $${gcfg.budgets.dailyUsd} reached; only local agents run until tomorrow (UTC)`);
            await notify(gcfg, { kind: "budget", title: "agentpipe: daily budget reached", body: `Claude spend today is $${store.spendToday().toFixed(2)} of $${gcfg.budgets.dailyUsd}. Cloud tasks wait until the next UTC day.` });
          }
        }
        const runnable = Object.entries(g.projects).filter(([, p]) => isRunnable(p)).map(([n]) => n);
        const task = store.claimNext({ project: opts.project, projects: runnable, prefer: currentProject(g), agents: overBudget ? agents.free : agents.all, lane });
        if (!task) {
          if (opts.once) return;
          await sleep(gcfg.worker.pollSec * 1000);
          continue;
        }
        claimedOnce = true;
        await withRunContext(
          {
            taskId: task.id,
            label: `${label} #${task.id}`,
            budgetUsd: gcfg.budgets.taskUsd > 0 ? gcfg.budgets.taskUsd : null,
            onSpend: (usd, l, model, turns, seconds) => store.addUsage({ task_id: task.id, project: task.project, agent: task.agent, label: l, model, cost_usd: usd, turns, seconds }),
          },
          () => processTask(store, g, task),
        );
        if (opts.once) return;
      }
    };
    const runs: Promise<void>[] = [];
    for (const [lane, n] of lanes) for (let i = 0; i < n; i++) runs.push(slot(lane, i));
    await Promise.all(runs);
  } finally {
    release();
    log("worker: exited");
  }
}

async function processTask(store: Store, gcfg: GlobalConfig, task: Task) {
  const project = gcfg.projects[task.project];
  if (!project) {
    finish(store, gcfg, task, null, `project "${task.project}" is not configured`);
    return;
  }
  const registry = loadRegistry(project);
  const manifest = registry.agents.get(task.agent);
  if (!manifest) {
    finish(store, gcfg, task, null, `agent "${task.agent}" is not in the registry for project ${task.project} (${[...registry.agents.keys()].join(", ")})`);
    return;
  }
  store.update(task.id, { agent_version: manifest.version });

  let wt: Worktree;
  try {
    wt = await prepareWorktree(store, gcfg, task.project, project, task);
  } catch (e) {
    // The project checkout is unusable (not a git repo, fetch broken, setup failing). Not the
    // task's fault: hand it back and wait before trying anything else in this lane.
    store.update(task.id, { attempts: Math.max(0, task.attempts - 1) });
    store.setStatus(task.id, "queued", `project not ready: ${(e as Error).message.split("\n")[0]}`);
    log(`worker: project ${task.project} not ready (${(e as Error).message.split("\n")[0]}); pausing ${gcfg.worker.pauseSec}s`);
    await notify(gcfg, { kind: "worker", title: `agentpipe: project ${task.project} not ready`, body: (e as Error).message.slice(0, 500) });
    await sleep(gcfg.worker.pauseSec * 1000);
    return;
  }
  store.update(task.id, { worktree: wt.dir });

  const cfg = loadConfig(wt.dir, { push: project.push });
  const ctx: AgentRunContext = { cfg, gcfg, projectName: task.project, project, registry, store, startBranch: wt.startBranch };
  log(`worker: #${task.id} "${task.title}" -> ${manifest.name} (attempt ${task.attempts}) from ${wt.startBranch} in ${wt.dir}`);
  store.event(task.id, "run", `agent ${manifest.name} v${manifest.version} starting from ${wt.startBranch} in worktree ${wt.dir}`);
  let outcome: RunOutcome | null = null;
  let error: string | null = null;
  try {
    outcome = await runAgent(task, manifest, ctx);
  } catch (e) {
    error = e instanceof BudgetExceeded ? `budget: ${e.message}` : (e as Error).message;
    log(`worker: #${task.id} crashed: ${error}`);
  }
  setLogFile(path.join(dataDir(), "worker.log"));
  await cleanupWorktree(gcfg, project, wt);
  if (outcome?.result.projects?.length && (await createProposedProjects(store, task, outcome.result.projects, outcome)) && outcome.result.subtasks.length) {
    // With subtasks the task goes to waiting, not attention, so finish() would not tell anyone.
    void notify(gcfg, { kind: "attention", title: `agentpipe: #${task.id} created a project that needs you`, body: `${task.title}\n\nagentpipe show ${task.id}` });
  }
  finish(store, gcfg, task, outcome, error, registry);
}

/**
 * New streams an agent proposed. Only a clean result creates anything: the task must be done and
 * verified. Each stream gets its first tasks (setup, kickoff); a stream held for approval, or one
 * that could not be created, turns the task into attention so the human hears about it.
 * Returns whether the human is needed.
 */
export async function createProposedProjects(store: Store, task: Task, specs: ProjectSpec[], outcome: Pick<RunOutcome, "result" | "verification">): Promise<boolean> {
  const { result } = outcome;
  if (result.status !== "done" || !outcome.verification.ok) {
    result.summary += `\n\n## Projects not created\nThe task did not finish cleanly, so the proposed project(s) ${specs.map((p) => p.name).join(", ")} were not created.`;
    return false;
  }
  const lines: string[] = [];
  let needsHuman = false;
  for (const spec of specs) {
    try {
      const created = await createProject(spec, { allowRemote: false });
      const first = queueStreamStart(store, created, spec, `agent:${task.agent}#${task.id}`);
      lines.push(`### ${created.name}`, ...created.notes.map((n) => `- ${n}`), ...first.map((t) => `- queued #${t.id} [${t.agent}] ${t.title}${created.pending.length ? " (runs after approval)" : ""}`));
      store.event(task.id, "project", `created project ${created.name} at ${created.project.path}${created.pending.length ? `, held for approval: ${created.pending.map((p) => p.command).join("; ")}` : ""}`);
      if (created.pending.length) {
        needsHuman = true;
        lines.push(`- **Needs you:** approve the GitHub step(s) with \`agentpipe projects approve ${created.name}\`: ${created.pending.map((p) => `\`${p.command}\` (${p.why})`).join("; ")}`);
      }
    } catch (e) {
      needsHuman = true;
      lines.push(`### ${spec.name}`, `- **not created:** ${(e as Error).message}`);
      store.event(task.id, "warning", `project ${spec.name} not created: ${(e as Error).message}`);
    }
  }
  result.summary += `\n\n## Projects\n${lines.join("\n")}`;
  if (needsHuman) result.status = "attention";
  return needsHuman;
}

interface Worktree {
  dir: string;
  startBranch: string;
  startRef: string;
}

/**
 * A private worktree for the task: from origin/<base> (fetched) or the local base, or from a
 * dependency's branch when stacked. Installed dependencies are symlinked from the main checkout
 * unless the project says otherwise; a setup command may run once.
 */
async function prepareWorktree(store: Store, gcfg: GlobalConfig, name: string, project: ProjectConfig, task: Task): Promise<Worktree> {
  const main = project.path;
  if (!existsSync(path.join(main, ".git"))) throw new Error(`${main} is not a git checkout`);
  await excludeAgentpipeDir(main);

  const hasOrigin = (await sh("git remote get-url origin", main, 30)).ok;
  if (hasOrigin) {
    const f = await sh("git fetch -q origin", main, 180);
    if (!f.ok) log(`worker: git fetch failed for ${name} (continuing with local refs): ${f.output.trim().slice(0, 200)}`);
  }
  let startBranch = project.base;
  let startRef = project.base;
  const stackedOn = task.depends_on
    .map((id) => store.get(id))
    .filter((d): d is Task => Boolean(d?.branch && d.status === "done"))
    .sort((a, b) => b.id - a.id)[0];
  if (stackedOn?.branch) {
    startBranch = stackedOn.branch;
    startRef = stackedOn.branch;
    if (!task.branch) {
      task.branch = startRef;
      store.update(task.id, { branch: startRef });
    }
    log(`worker: #${task.id} stacks on #${stackedOn.id}'s branch ${startRef}`);
  } else if (hasOrigin && (await sh(`git rev-parse --verify -q ${JSON.stringify("origin/" + project.base)}`, main, 30)).ok) {
    startRef = `origin/${project.base}`;
  }
  if (!(await sh(`git rev-parse --verify -q ${JSON.stringify(startRef)}`, main, 30)).ok) throw new Error(`start ref ${startRef} does not exist in ${main}`);

  const root = worktreeRoot(gcfg, name, project);
  mkdirSync(root, { recursive: true });
  const dir = path.join(root, `task-${task.id}`);
  if (existsSync(dir)) {
    await sh(`git worktree remove --force ${JSON.stringify(dir)}`, main, 120);
    rmSync(dir, { recursive: true, force: true });
  }
  await sh("git worktree prune", main, 60);
  const add = await sh(`git worktree add --detach -q ${JSON.stringify(dir)} ${JSON.stringify(startRef)}`, main, 300);
  if (!add.ok) throw new Error(`git worktree add failed: ${add.output.trim().slice(0, 300)}`);

  const linked: string[] = [];
  for (const entry of project.link ?? gcfg.worktrees.link) {
    const src = path.join(main, entry);
    const dst = path.join(dir, entry);
    if (existsSync(src) && !existsSync(dst)) {
      mkdirSync(path.dirname(dst), { recursive: true });
      symlinkSync(src, dst);
      linked.push(entry);
    }
  }
  if (linked.length) await ensureIgnored(dir, linked);
  if (project.setup) {
    log(`worker: running project setup in ${dir}: ${project.setup}`);
    const r = await sh(project.setup, dir, 900);
    if (!r.ok) throw new Error(`project setup failed (${r.code}): ${r.output.trim().slice(0, 300)}`);
  }
  const dirty = (await sh("git status --porcelain", dir, 60)).output.trim();
  if (dirty) throw new Error(`fresh worktree is not clean (check .gitignore for linked entries): ${dirty.split("\n").slice(0, 3).join("; ")}`);
  return { dir, startBranch, startRef };
}

async function cleanupWorktree(gcfg: GlobalConfig, project: ProjectConfig, wt: Worktree) {
  if (!gcfg.worktrees.cleanup) {
    log(`worker: keeping worktree ${wt.dir} (worktrees.cleanup=false)`);
    return;
  }
  // Anything uncommitted at this point is either reverted already or deliberately left by a
  // failed-verification commit; the branch is what survives.
  const r = await sh(`git worktree remove --force ${JSON.stringify(wt.dir)}`, project.path, 120);
  if (!r.ok) {
    log(`worker: could not remove worktree ${wt.dir}: ${r.output.trim().slice(0, 200)}`);
    rmSync(wt.dir, { recursive: true, force: true });
    await sh("git worktree prune", project.path, 60);
  }
}

/** On start: drop worktrees of tasks that are not running any more. */
async function pruneWorktrees(store: Store, gcfg: GlobalConfig, name: string, project: ProjectConfig) {
  const root = worktreeRoot(gcfg, name, project);
  if (!existsSync(root) || !existsSync(path.join(project.path, ".git"))) return;
  for (const d of readdirSync(root)) {
    const m = d.match(/^task-(\d+)$/);
    if (!m) continue;
    const t = store.get(Number(m[1]));
    if (t?.status === "running") continue;
    const dir = path.join(root, d);
    await sh(`git worktree remove --force ${JSON.stringify(dir)}`, project.path, 120);
    rmSync(dir, { recursive: true, force: true });
    log(`worker: pruned stale worktree ${dir}`);
  }
  await sh("git worktree prune", project.path, 60);
}

/** Record the outcome, create subtasks, wake the parent if this was its last child, notify. */
function finish(store: Store, gcfg: GlobalConfig, task: Task, outcome: RunOutcome | null, error: string | null, registry?: Registry) {
  let status: string;
  if (!outcome) {
    const transient = error && task.attempts < gcfg.worker.maxAttempts && /ECONNREFUSED|ollama|timed out|non-JSON|rate limit|overloaded/i.test(error) && !/^budget/.test(error);
    status = transient ? "queued" : error?.startsWith("budget") ? "attention" : "failed";
    store.update(task.id, { error: error ?? "no outcome" });
    store.setStatus(task.id, status as any, status === "queued" ? `transient error, will retry: ${error}` : `error: ${error}`);
    if (status !== "queued") store.settleParent(task.id);
  } else {
    const { result } = outcome;
    const created = createSubtasks(store, gcfg, task, result.subtasks, registry);
    // Agents the agent wished it had: recorded for the human, never created here.
    const proposed = recordProposals(store, result.agent_proposals, { task, project: task.project, by: `agent:${task.agent}#${task.id}` });
    if (proposed.length) result.summary += `\n\n## Agents proposed\n${proposed.join("\n")}`;
    // A confirmation request: validated by the runtime already; recorded here so the page and the CLI can show and decide it.
    if (result.confirmation) {
      store.setConfirmation(task.id, { request: result.confirmation, status: "pending", requested_at: new Date().toISOString(), log: [] });
      store.event(task.id, "confirmation", `requested: ${result.confirmation.title} (${result.confirmation.steps.length} step(s)); approve or reject on the status page or with agentpipe approve ${task.id}`);
    }
    status = created.length ? "waiting" : result.status;
    store.update(task.id, {
      summary: clip(result.summary, 30_000),
      run_dir: outcome.runDir,
      branch: outcome.branch ?? task.branch,
      base_branch: outcome.baseBranch,
      pr_url: outcome.prUrl,
      // failed: the report is the error. cancelled: the first lines say why it was impossible.
      error: result.status === "failed" || result.status === "cancelled" ? clip(result.summary.replace(/^#+\s.*$/m, "").trim(), 500) : null,
    });
    const blockers = result.findings.filter((f) => f.severity === "blocker").length;
    store.setStatus(task.id, status as any, `agent reported ${result.status}${outcome.verification.ran ? (outcome.verification.ok ? ", verification passed" : `, verification FAILED (${outcome.verification.problems.length})`) : ""}${blockers ? `, ${blockers} blocker finding(s)` : ""}${created.length ? `, created ${created.length} subtask(s)` : ""}${outcome.prUrl ? `, PR ${outcome.prUrl}` : outcome.branch ? `, branch ${outcome.branch}` : ""}`);
    if (TERMINAL_STATUSES.includes(status as any)) store.settleParent(task.id);
  }
  const t = store.get(task.id)!;
  log(`worker: #${task.id} -> ${t.status}${t.pr_url ? ` (${t.pr_url})` : ""}${t.cost_usd ? ` $${t.cost_usd.toFixed(2)}` : ""}`);

  if (t.status === "attention" || t.status === "failed" || t.status === "cancelled") {
    const pending = t.confirmation?.status === "pending" ? t.confirmation.request : null;
    void notify(gcfg, {
      kind: t.status,
      title: pending ? `agentpipe: #${t.id} needs your approval: ${pending.title}` : `agentpipe: #${t.id} ${t.status} [${t.agent}] ${t.title}`,
      body: `${t.project}${t.parent_id ? ` (child of #${t.parent_id})` : ""}\n${pending ? `${pending.why}\nRisk: ${pending.risk}\n${pending.steps.length} step(s): agentpipe show ${t.id}, then agentpipe approve ${t.id} or reject ${t.id}` : `${t.error ?? clip(t.summary ?? "", 600)}\n\nagentpipe show ${t.id}`}${t.run_dir ? `\n${t.run_dir}` : ""}`,
      url: t.pr_url ?? undefined,
    });
  }
  // Agent health: warn once a day when an agent's recent outcomes are mostly escalations or failures.
  const h = store.agentHealth(t.agent, gcfg.budgets.agentWindow);
  if (h.runs >= Math.max(3, Math.ceil(gcfg.budgets.agentWindow / 2)) && h.rate >= gcfg.budgets.agentAttentionRate) {
    const key = `health-notified:${t.agent}:${new Date().toISOString().slice(0, 10)}`;
    if (!store.getMeta(key)) {
      store.setMeta(key, "1");
      void notify(gcfg, { kind: "agent-health", title: `agentpipe: agent ${t.agent} is struggling`, body: `Last ${h.runs} runs: ${h.done} done, ${h.attention} attention, ${h.failed} failed (${Math.round(h.rate * 100)}% needing intervention). The architect is told to prefer other agents; consider narrowing its prompt or its tasks.` });
    }
  }
}

/** Subtasks from an agent's result become children of `parent`. Unknown agents, duplicates and over-limits are logged, not fatal. */
export function createSubtasks(store: Store, gcfg: GlobalConfig, parent: Task, subtasks: Subtask[], registry?: Registry, createdBy = `agent:${parent.agent}#${parent.id}`): Task[] {
  if (!subtasks.length) return [];
  const reg = registry ?? loadRegistry(gcfg.projects[parent.project]);
  const open = store.openCount(parent.project);
  const room = Math.max(0, gcfg.architect.maxOpenTasks - open);
  const wanted = subtasks.slice(0, gcfg.architect.maxSubtasks);
  if (wanted.length > room) store.event(parent.id, "limit", `only ${room} of ${wanted.length} subtasks created: ${gcfg.architect.maxOpenTasks} open tasks allowed`);
  if (subtasks.length > wanted.length) store.event(parent.id, "limit", `agent proposed ${subtasks.length} subtasks; capped at ${gcfg.architect.maxSubtasks}`);
  const ids: (number | null)[] = [];
  const created: Task[] = [];
  for (const [i, s] of wanted.slice(0, room).entries()) {
    if (!reg.agents.has(s.agent)) {
      store.event(parent.id, "warning", `subtask ${i} "${s.title}" names unknown agent "${s.agent}"; skipped`);
      ids.push(null);
      continue;
    }
    const dup = store.findDuplicate(parent.project, s.agent, s.title);
    if (dup) {
      store.event(parent.id, "warning", `subtask ${i} "${s.title}" duplicates open task #${dup.id}; skipped`);
      ids.push(dup.id);
      continue;
    }
    const deps = (s.after ?? []).filter((j) => j >= 0 && j < i && ids[j] !== null).map((j) => ids[j]!);
    const t = store.add({
      project: parent.project,
      agent: s.agent,
      title: s.title,
      description: s.description,
      acceptance: s.acceptance ?? [],
      priority: s.priority ?? parent.priority,
      parent_id: parent.id,
      depends_on: deps,
      files: s.files ?? [],
      branch: s.branch ?? null,
      created_by: createdBy,
    });
    ids.push(t.id);
    created.push(t);
  }
  if (created.length) store.event(parent.id, "subtasks", created.map((t) => `#${t.id} [${t.agent}] ${t.title}`).join("; "));
  return created;
}
