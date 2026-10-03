import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { currentProject, expandHome, isRunnable, projectStatus, updateGlobalConfig, type GlobalConfig, type ProjectConfig, type ProjectStatus } from "./global.ts";
import { loadRegistry, requireAgent } from "./registry.ts";
import type { AgentProposal, ConfirmationRequest } from "./result.ts";
import { checkApprovedCommand } from "./shell-policy.ts";
import type { Confirmation, ProposalComment, ProposalRow, Store, Task } from "./store.ts";
import { clip, log, sh } from "./util.ts";

/**
 * The few things a human does to the queue, shared by the CLI (`agentpipe add|reply|retry|cancel`)
 * and the status page (POST /api/...). Each validates, changes the store, and returns what to tell
 * the human. Nothing here talks to models.
 */

export interface AddTaskInput {
  project?: string | null;
  agent?: string | null;
  title?: string | null;
  description: string;
  priority?: number | null;
  acceptance?: string[] | null;
  depends_on?: number[] | null;
  files?: string[] | null;
  branch?: string | null;
  created_by: string;
}

export interface AddTaskOutcome {
  task: Task;
  notes: string[];
}

/** Queue a task; defaults to the architect in the current project. Throws with a human-readable message when the input is unusable. */
export function addTask(store: Store, gcfg: GlobalConfig, input: AddTaskInput): AddTaskOutcome {
  const name = input.project || currentProject(gcfg);
  if (!name) throw new Error("no project given and no current project (agentpipe use NAME)");
  const project = gcfg.projects[name];
  if (!project) throw new Error(`unknown project "${name}"; known: ${Object.keys(gcfg.projects).join(", ") || "(none)"}`);
  if (projectStatus(project) === "archived") throw new Error(`project ${name} is archived; agentpipe projects resume ${name} first`);
  const description = (input.description ?? "").trim();
  if (!description) throw new Error("a task needs a description");
  const agent = input.agent || "architect";
  requireAgent(loadRegistry(project), agent);
  const priority = input.priority == null ? undefined : Number(input.priority);
  if (priority !== undefined && (!Number.isInteger(priority) || priority < 1 || priority > 99)) throw new Error("priority is a whole number from 1 (urgent) to 99");
  const depends_on = (input.depends_on ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  for (const d of depends_on) if (!store.get(d)) throw new Error(`dependency #${d} does not exist`);
  const task = store.add({
    project: name,
    agent,
    title: (input.title ?? "").trim() || description.split("\n")[0].slice(0, 120),
    description,
    acceptance: (input.acceptance ?? []).map((a) => a.trim()).filter(Boolean),
    priority,
    depends_on,
    files: (input.files ?? []).map((f) => f.trim()).filter(Boolean),
    branch: input.branch || null,
    created_by: input.created_by,
  });
  const notes: string[] = [];
  if (!isRunnable(project)) notes.push(`${name} is ${project.pending?.length ? `waiting for approval (agentpipe projects approve ${name})` : projectStatus(project)}; its tasks wait until it runs again`);
  return { task, notes };
}

/** Statuses a reply reopens. `blocked` stays blocked until its dependency is fixed; open tasks just get the note. */
const REOPENABLE = new Set(["attention", "failed", "cancelled"]);

export interface ReplyOutcome {
  task: Task;
  requeued: boolean;
  note: string;
}

/**
 * Answer what a task asked. The reply is stored, shown to the agent on its next run, and (unless
 * told otherwise) the task goes back into the queue so that run happens.
 */
export function replyToTask(store: Store, id: number, text: string, author: string, opts: { requeue?: boolean } = {}): ReplyOutcome {
  const t = store.get(id);
  if (!t) throw new Error(`no task #${id}`);
  const body = text.trim();
  if (!body) throw new Error("a reply needs some text");
  store.reply(id, author, body);
  const wants = opts.requeue ?? true;
  if (wants && REOPENABLE.has(t.status)) {
    const task = store.requeue(id, `reply from ${author}; continuing`);
    return { task, requeued: true, note: `#${id} was ${t.status}; requeued with your reply` };
  }
  const note =
    t.status === "running"
      ? `#${id} is running now; the reply is saved and the agent sees it on its next run`
      : t.status === "blocked"
        ? `#${id} is blocked on ${t.error ?? "a dependency"}; the reply is saved and used once it runs`
        : !wants
          ? `reply saved on #${id} (not requeued)`
          : `#${id} is ${t.status}; the reply is saved and shown to the agent on its next run`;
  return { task: store.get(id)!, requeued: false, note };
}

export interface EditTaskInput {
  title?: string | null;
  description?: string | null;
  acceptance?: string[] | null;
  agent?: string | null;
  priority?: number | null;
  files?: string[] | null;
}

/**
 * Change what a task asks for before (or after) it runs: a stale description written before the
 * roster changed, a wrong agent, acceptance criteria that need a line. Running tasks are refused;
 * the change is recorded as an event so the history says what the agent actually saw.
 */
export function editTask(store: Store, gcfg: GlobalConfig, id: number, patch: EditTaskInput, by: string): Task {
  const t = store.get(id);
  if (!t) throw new Error(`no task #${id}`);
  if (t.status === "running") throw new Error(`#${id} is running; wait for it to finish (or cancel it) before editing`);
  const changes: Partial<Parameters<Store["update"]>[1]> = {};
  const what: string[] = [];
  if (patch.title != null && patch.title.trim() && patch.title.trim() !== t.title) {
    changes.title = patch.title.trim().slice(0, 200);
    what.push("title");
  }
  if (patch.description != null && patch.description.trim() && patch.description.trim() !== t.description) {
    changes.description = patch.description.trim();
    what.push("description");
  }
  if (patch.acceptance != null) {
    const acc = patch.acceptance.map((a) => a.trim()).filter(Boolean);
    if (JSON.stringify(acc) !== JSON.stringify(t.acceptance)) {
      changes.acceptance = acc;
      what.push("acceptance");
    }
  }
  if (patch.files != null) {
    const files = patch.files.map((f) => f.trim()).filter(Boolean);
    if (JSON.stringify(files) !== JSON.stringify(t.files)) {
      changes.files = files;
      what.push("files");
    }
  }
  if (patch.agent != null && patch.agent.trim() && patch.agent.trim() !== t.agent) {
    const project = gcfg.projects[t.project];
    if (!project) throw new Error(`project "${t.project}" is not configured`);
    requireAgent(loadRegistry(project), patch.agent.trim());
    changes.agent = patch.agent.trim();
    what.push(`agent ${t.agent} -> ${changes.agent}`);
  }
  if (patch.priority != null && patch.priority !== t.priority) {
    const p = Number(patch.priority);
    if (!Number.isInteger(p) || p < 1 || p > 99) throw new Error("priority is a whole number from 1 (urgent) to 99");
    changes.priority = p;
    what.push(`priority ${t.priority} -> ${p}`);
  }
  if (!what.length) return t;
  const out = store.update(id, changes);
  store.event(id, "edited", `by ${by}: ${what.join(", ")}`);
  return out;
}

export function retryTask(store: Store, id: number, by: string): Task {
  const t = store.get(id);
  if (!t) throw new Error(`no task #${id}`);
  if (t.status === "running") throw new Error(`#${id} is running; stop the worker or wait for it to finish`);
  if (t.status === "queued") return t;
  return store.requeue(id, `retry by ${by}`);
}

export interface CancelOutcome {
  task: Task;
  note: string | null;
}

/** Mark a task cancelled (impossible, moot, or no longer wanted). A running one finishes its current agent call first. */
export function cancelTask(store: Store, id: number, by: string, reason?: string | null): CancelOutcome {
  const t = store.get(id);
  if (!t) throw new Error(`no task #${id}`);
  if (t.status === "cancelled") return { task: t, note: `#${id} was already cancelled` };
  const why = (reason ?? "").trim();
  store.setStatus(id, "cancelled", `by ${by}${why ? `: ${why}` : ""}`);
  store.update(id, { triaged: 1, ...(why ? { error: why } : {}) });
  if (t.confirmation?.status === "pending") store.setConfirmation(id, { ...t.confirmation, status: "rejected", decided_by: by, decided_at: new Date().toISOString(), log: [...t.confirmation.log, `rejected by ${by}${why ? `: ${why}` : ""}`] });
  store.settleParent(id);
  return { task: store.get(id)!, note: t.status === "running" ? "the worker is running this task; it finishes the current agent call, then the result is recorded but no subtasks are created. Stop the worker to abort it." : null };
}

/** Statuses that "cancel all open tasks" sweeps up: everything that is not already over. */
export const CANCELLABLE: Task["status"][] = ["queued", "blocked", "running", "waiting", "review", "attention", "failed"];

export interface CancelProjectOutcome {
  cancelled: Task[];
  running: Task[];
  note: string;
}

/**
 * Cancel every open task of one project at once: a stream whose plan went wrong and is being
 * restarted. Children go first so no parent is woken for review half-way through; running tasks
 * are marked and the worker records their result without acting on it when they finish.
 */
export function cancelProjectTasks(store: Store, project: string, by: string, reason?: string | null): CancelProjectOutcome {
  const open = store.list({ project, status: CANCELLABLE }).sort((a, b) => b.id - a.id);
  const why = (reason ?? "").trim() || `all open tasks of ${project} cancelled`;
  const cancelled: Task[] = [];
  const running: Task[] = [];
  for (const t of open) {
    if (t.status === "running") running.push(t);
    cancelled.push(cancelTask(store, t.id, by, why).task);
  }
  const note = cancelled.length
    ? `${cancelled.length} task(s) of ${project} cancelled${running.length ? `; ${running.length} running (${running.map((t) => "#" + t.id).join(", ")}) finish their current agent call first, then stop` : ""}`
    : `${project} has no open tasks`;
  return { cancelled, running, note };
}

/** Set or clear (0) a project's own daily Claude cap. Returns the saved value. */
export function setProjectBudget(name: string, dailyUsd: number): number {
  if (!Number.isFinite(dailyUsd) || dailyUsd < 0) throw new Error("the daily cap is a number of dollars (0 = only the global cap applies)");
  const usd = Math.round(dailyUsd * 100) / 100;
  updateGlobalConfig((c) => {
    if (!c.projects[name]) throw new Error(`unknown project "${name}"`);
    if (usd) c.projects[name].dailyUsd = usd;
    else delete c.projects[name].dailyUsd;
  });
  return usd;
}

/** Set the machine-wide Claude caps (per task, per UTC day); null leaves one alone, 0 removes it. */
export function setGlobalBudgets(patch: { dailyUsd?: number | null; taskUsd?: number | null }): GlobalConfig["budgets"] {
  for (const v of [patch.dailyUsd, patch.taskUsd]) if (v != null && (!Number.isFinite(v) || v < 0)) throw new Error("a cap is a number of dollars (0 = none)");
  return updateGlobalConfig((c) => {
    if (patch.dailyUsd != null) c.budgets.dailyUsd = Math.round(patch.dailyUsd * 100) / 100;
    if (patch.taskUsd != null) c.budgets.taskUsd = Math.round(patch.taskUsd * 100) / 100;
    return c.budgets;
  });
}

/** Pause, resume or archive a stream. Archiving the current project hands "current" to another active one. */
export function setProjectStatus(name: string, status: ProjectStatus): { status: ProjectStatus; current: string | null } {
  return updateGlobalConfig((c) => {
    if (!c.projects[name]) throw new Error(`unknown project "${name}"`);
    if (status === "active") delete c.projects[name].status;
    else c.projects[name].status = status;
    if (status === "archived" && c.defaultProject === name) c.defaultProject = Object.keys(c.projects).find((n) => n !== name && projectStatus(c.projects[n]) === "active") ?? null;
    return { status, current: c.defaultProject };
  });
}

/** Make a project the current one (commands default to it, the worker claims its tasks first). */
export function makeCurrentProject(name: string): void {
  updateGlobalConfig((c) => {
    if (!c.projects[name]) throw new Error(`unknown project "${name}"`);
    if (projectStatus(c.projects[name]) === "archived") throw new Error(`${name} is archived; resume it first`);
    c.defaultProject = name;
  });
}

/** File an agent's proposals for agents that do not exist. Returns one line per proposal for logs and digests. */
export function recordProposals(store: Store, proposals: AgentProposal[] | undefined, from: { task: Task | null; project: string | null; by: string }): string[] {
  const out: string[] = [];
  for (const p of proposals ?? []) {
    const row = store.proposeAgent({ name: p.name, spec: p, task_id: from.task?.id ?? null, project: from.project, proposed_by: from.by });
    if (from.task) store.event(from.task.id, "proposal", `agent "${p.name}" (${p.runtime}) proposed: ${p.why.replace(/\s+/g, " ").slice(0, 300)}`);
    out.push(`- proposed agent "${p.name}" (${p.runtime}${row.times > 1 ? `, asked for ${row.times} times` : ""}): ${p.why.replace(/\s+/g, " ")}. It is published as a GitHub issue for your decision (approve there or on the status page).`);
  }
  return out;
}

/** A proposal row with its spec parsed and its discussion, for the API and the CLI. */
export function viewProposal(r: ProposalRow, store?: Store): ProposalRow & { proposal: AgentProposal; comments: ProposalComment[] } {
  return { ...r, proposal: JSON.parse(r.spec) as AgentProposal, comments: store ? store.proposalComments(r.id) : [] };
}

/* ---------- confirmations: agents that may act only with the human's approval ---------- */

const CREDENTIAL_PATHS = /(^|\/)\.(ssh|gnupg|aws|netrc|claude)(\/|$)|\/\.config\/(gh|agentpipe\/env)(\/|$)|(^|\/)\.env(\.|$)/;

function under(dir: string, p: string): boolean {
  const rel = path.relative(dir, p);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Steps may touch the home directory and the project's checkout (which may live elsewhere), nothing else. */
function inBounds(p: string, project: ProjectConfig): boolean {
  return under(homedir(), p) || under(project.path, p);
}

/** Resolve a step's path (absolute or ~/), relative ones against the project checkout. */
function stepPath(p: string, project: ProjectConfig): string {
  const e = expandHome(p);
  return path.isAbsolute(e) ? path.normalize(e) : path.resolve(project.path, e);
}

/**
 * Problems with a confirmation request, checked before it is shown to the human and again before
 * it runs. Commands must clear the hard deny list; every directory and file must be under the
 * home directory and away from credentials. A request with problems is never stored as pending.
 */
export function validateConfirmation(req: ConfirmationRequest, project: ProjectConfig): string[] {
  const out: string[] = [];
  req.steps.forEach((s, i) => {
    const n = `step ${i + 1}`;
    if (s.kind === "command") {
      if (!s.command?.trim()) return void out.push(`${n}: command step without a command`);
      const v = checkApprovedCommand(s.command);
      if (!v.ok) out.push(`${n}: "${clip(s.command, 60)}" refused: ${v.reason}`);
      if (s.cwd) {
        const d = stepPath(s.cwd, project);
        if (!inBounds(d, project)) out.push(`${n}: cwd ${d} is outside the home directory and the project`);
        if (CREDENTIAL_PATHS.test(d)) out.push(`${n}: cwd ${d} is a credential directory`);
      }
    } else {
      if (!s.path?.trim()) return void out.push(`${n}: write step without a path`);
      if (typeof s.content !== "string") out.push(`${n}: write step without content`);
      const f = stepPath(s.path, project);
      if (!inBounds(f, project)) out.push(`${n}: ${f} is outside the home directory and the project`);
      if (CREDENTIAL_PATHS.test(f)) out.push(`${n}: ${f} is a credential or configuration secret`);
      if (/\.(ssh|pem|key)$/.test(f)) out.push(`${n}: ${f} looks like a key`);
    }
  });
  return out;
}

export interface ApproveOutcome {
  task: Task;
  ok: boolean;
  log: string[];
}

/**
 * Run the steps of a pending confirmation, in order, as the human. The confirmation is marked
 * `running` synchronously (so a caller may fire and forget), then each step's result is appended
 * to its log and the task's events. Success ends the task (`done`), or requeues it with a reply
 * carrying the outputs when the agent asked to continue. A failing step stops the rest and leaves
 * the task in `attention` with the failure.
 */
export async function approveTask(store: Store, gcfg: GlobalConfig, id: number, by: string): Promise<ApproveOutcome> {
  const t = store.get(id);
  if (!t) throw new Error(`no task #${id}`);
  const c = t.confirmation;
  if (!c) throw new Error(`#${id} has no confirmation request`);
  if (c.status !== "pending") throw new Error(`#${id}'s request is ${c.status}, not pending`);
  const project = gcfg.projects[t.project];
  if (!project) throw new Error(`project "${t.project}" is not configured`);
  const problems = validateConfirmation(c.request, project);
  if (problems.length) throw new Error(`request refused: ${problems.join("; ")}`);

  let cur: Confirmation = { ...c, status: "running", decided_by: by, decided_at: new Date().toISOString(), log: [...c.log, `approved by ${by}`] };
  store.setConfirmation(id, cur);
  store.event(id, "confirmation", `approved by ${by}: ${c.request.title}`);
  const save = (line: string) => {
    cur = { ...cur, log: [...cur.log, line] };
    store.setConfirmation(id, cur);
    store.event(id, "confirmation", line);
  };

  let ok = true;
  const outputs: string[] = [];
  for (const [i, s] of c.request.steps.entries()) {
    const n = i + 1;
    try {
      if (s.kind === "write") {
        const f = stepPath(s.path!, project);
        const existed = existsSync(f);
        mkdirSync(path.dirname(f), { recursive: true });
        writeFileSync(f, s.content ?? "");
        save(`step ${n} ok: ${existed ? "overwrote" : "wrote"} ${f} (${(s.content ?? "").length} chars)`);
        outputs.push(`step ${n}: ${existed ? "overwrote" : "wrote"} ${f}`);
      } else {
        const cwd = s.cwd ? stepPath(s.cwd, project) : project.path;
        if (!existsSync(cwd)) throw new Error(`directory ${cwd} does not exist`);
        log(`confirmation #${id} step ${n}: ${s.command} (in ${cwd})`);
        const r = await sh(s.command!, cwd, 900);
        const out = r.output.trim();
        outputs.push(`step ${n}: \`${s.command}\` in ${cwd} ${r.timedOut ? "timed out" : `exited ${r.code}`}${out ? `\n\`\`\`\n${clip(out, 4000)}\n\`\`\`` : ""}`);
        if (!r.ok) throw new Error(`\`${s.command}\` ${r.timedOut ? "timed out" : `exited ${r.code}`}: ${clip(out, 600)}`);
        save(`step ${n} ok: ${s.command}${out ? ` -> ${clip(out.split("\n").slice(-1)[0], 200)}` : ""}`);
      }
    } catch (e) {
      ok = false;
      save(`step ${n} FAILED: ${(e as Error).message}`);
      break;
    }
  }

  const report = `## Approved by ${by}\n${outputs.join("\n\n")}`;
  if (!ok) {
    cur = { ...cur, status: "failed" };
    store.setConfirmation(id, cur);
    store.update(id, { error: cur.log[cur.log.length - 1], summary: `${t.summary ?? ""}\n\n${report}`.trim(), triaged: 1 });
    store.event(id, "status", "attention (approved steps failed)");
    return { task: store.get(id)!, ok, log: cur.log };
  }
  cur = { ...cur, status: "approved" };
  store.setConfirmation(id, cur);
  store.update(id, { summary: `${t.summary ?? ""}\n\n${report}`.trim() });
  if (c.request.continue_after) {
    store.reply(id, by, `Approved and executed. ${outputs.join("\n\n")}`);
    store.requeue(id, `approved by ${by}; the agent continues with the outputs`);
  } else {
    store.setStatus(id, "done", `approved by ${by}; ${c.request.steps.length} step(s) executed`);
    store.update(id, { triaged: 1, error: null });
    store.settleParent(id);
  }
  return { task: store.get(id)!, ok, log: cur.log };
}

/** Decline a pending request: the task is cancelled with the reason, and the agent is not run again. */
export function rejectTask(store: Store, id: number, by: string, reason?: string | null): CancelOutcome {
  const t = store.get(id);
  if (!t) throw new Error(`no task #${id}`);
  if (!t.confirmation || t.confirmation.status !== "pending") throw new Error(`#${id} has no pending confirmation request`);
  return cancelTask(store, id, by, `rejected: ${(reason ?? "").trim() || t.confirmation.request.title}`);
}
