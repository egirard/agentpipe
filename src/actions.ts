import { currentProject, isRunnable, projectStatus, type GlobalConfig } from "./global.ts";
import { loadRegistry, requireAgent } from "./registry.ts";
import type { AgentProposal } from "./result.ts";
import type { ProposalRow, Store, Task } from "./store.ts";

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
  store.settleParent(id);
  return { task: store.get(id)!, note: t.status === "running" ? "the worker is running this task; it finishes the current agent call, then the result is recorded but no subtasks are created. Stop the worker to abort it." : null };
}

/** File an agent's proposals for agents that do not exist. Returns one line per proposal for logs and digests. */
export function recordProposals(store: Store, proposals: AgentProposal[] | undefined, from: { task: Task | null; project: string | null; by: string }): string[] {
  const out: string[] = [];
  for (const p of proposals ?? []) {
    const row = store.proposeAgent({ name: p.name, spec: p, task_id: from.task?.id ?? null, project: from.project, proposed_by: from.by });
    if (from.task) store.event(from.task.id, "proposal", `agent "${p.name}" (${p.runtime}) proposed: ${p.why.replace(/\s+/g, " ").slice(0, 300)}`);
    out.push(`- proposed agent "${p.name}" (${p.runtime}${row.times > 1 ? `, asked for ${row.times} times` : ""}): ${p.why.replace(/\s+/g, " ")}. Create it: agentpipe agents new ${p.name} --from ${row.id}`);
  }
  return out;
}

/** A proposal row with its spec parsed, for the API and the CLI. */
export function viewProposal(r: ProposalRow): ProposalRow & { proposal: AgentProposal } {
  return { ...r, proposal: JSON.parse(r.spec) as AgentProposal };
}
