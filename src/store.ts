import { Database } from "bun:sqlite";
import path from "node:path";
import { dataDir } from "./global.ts";
import type { PrGate } from "./pr.ts";
import type { ConfirmationRequest } from "./result.ts";

/**
 * The task queue. One SQLite file, no server. Tasks form a tree: a delegating agent (the
 * architect, a reviewer) finishes by creating children; the parent waits until every child has
 * reached a terminal state, then goes to `review` for the architect's next wake-up.
 *
 *  queued ──▶ running ──▶ done | attention | failed | cancelled
 *     │          └──▶ waiting (children created) ──▶ review ──▶ done | attention | waiting (next round)
 *     └──▶ blocked (a dependency ended badly) ──▶ queued (retried) | cancelled
 *
 * attention, failed and cancelled are exits a human (or the architect) can reopen: `retry`, or a
 * `reply` that answers what the agent asked, requeues the task, and is shown to the agent on its
 * next run. `cancelled` is the exit for tasks that proved impossible or moot: they leave "needs
 * you", do not count against an agent's track record, and stay in the history.
 *
 * Several projects (repositories) share one queue; every task carries its project name.
 */
export type TaskStatus = "queued" | "blocked" | "running" | "waiting" | "review" | "done" | "attention" | "failed" | "cancelled";

export const OPEN_STATUSES: TaskStatus[] = ["queued", "blocked", "running", "waiting", "review"];
export const TERMINAL_STATUSES: TaskStatus[] = ["done", "attention", "failed", "cancelled", "blocked"];
/** Statuses that make dependants wait forever unless somebody intervenes. */
const BAD_STATUSES: TaskStatus[] = ["attention", "failed", "cancelled"];

/** A confirmation request on a task: what the agent proposed, whether the human decided, what happened. */
export interface Confirmation {
  request: ConfirmationRequest;
  status: "pending" | "running" | "approved" | "rejected" | "failed" | "superseded";
  requested_at: string;
  decided_by?: string;
  decided_at?: string;
  /** One line per executed step, with exit code and clipped output. */
  log: string[];
}

export interface Task {
  id: number;
  project: string;
  agent: string;
  title: string;
  description: string;
  /** Checkable statements that define done. Empty for tasks queued by hand without any. */
  acceptance: string[];
  status: TaskStatus;
  priority: number;
  parent_id: number | null;
  depends_on: number[];
  files: string[];
  /** Branch this task's work lives on (set by the worker) or, for review tasks, the branch to look at. */
  branch: string | null;
  /** Branch the work started from (base, or a dependency's branch when stacked). */
  base_branch: string | null;
  round: number;
  attempts: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  created_by: string;
  summary: string | null;
  run_dir: string | null;
  pr_url: string | null;
  error: string | null;
  triaged: number;
  /** Hash of the agent's manifest + prompt + verifier at run time, so track records are per version. */
  agent_version: string | null;
  /** Claude spend attributed to this task, USD as reported by Claude Code. */
  cost_usd: number;
  lane: string | null;
  worktree: string | null;
  /** Set when an agent with requires_confirmation asked for approval. */
  confirmation: Confirmation | null;
  /** Set when this task gates a pull request: the URL, the human's decision, and the last state seen on GitHub. */
  pr_gate: PrGate | null;
}

export interface NewTask {
  project: string;
  agent: string;
  title: string;
  description: string;
  acceptance?: string[];
  priority?: number;
  parent_id?: number | null;
  depends_on?: number[];
  files?: string[];
  branch?: string | null;
  created_by?: string;
}

export interface TaskEvent {
  id: number;
  task_id: number;
  ts: string;
  kind: string;
  message: string;
}

/** A human's answer to a task that stopped (attention, failed, cancelled). Shown to the agent on its next run. */
export interface Reply {
  id: number;
  task_id: number;
  ts: string;
  author: string;
  text: string;
}

/** An agent an architect wished it had. Recorded, never created automatically. */
export interface ProposalRow {
  id: number;
  ts: string;
  task_id: number | null;
  project: string | null;
  proposed_by: string;
  name: string;
  /** The AgentProposal as JSON (src/result.ts). */
  spec: string;
  status: "open" | "dismissed" | "created";
  /** How many times an agent asked for this one while it was open. */
  times: number;
}

export interface UsageRow {
  id: number;
  ts: string;
  task_id: number | null;
  project: string | null;
  agent: string | null;
  label: string;
  model: string;
  cost_usd: number;
  turns: number;
  seconds: number;
}

export interface ListFilter {
  project?: string;
  status?: TaskStatus[];
  parent_id?: number | null;
  agent?: string;
  limit?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  agent TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  priority INTEGER NOT NULL DEFAULT 50,
  parent_id INTEGER,
  depends_on TEXT NOT NULL DEFAULT '[]',
  files TEXT NOT NULL DEFAULT '[]',
  branch TEXT,
  base_branch TEXT,
  round INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  created_by TEXT NOT NULL DEFAULT 'cli',
  summary TEXT,
  run_dir TEXT,
  pr_url TEXT,
  error TEXT,
  triaged INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, priority, id);
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_id);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_task ON events(task_id, id);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  task_id INTEGER,
  project TEXT,
  agent TEXT,
  label TEXT NOT NULL,
  model TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  seconds REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);
CREATE TABLE IF NOT EXISTS replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  ts TEXT NOT NULL,
  author TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS replies_task ON replies(task_id, id);
CREATE TABLE IF NOT EXISTS agent_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  task_id INTEGER,
  project TEXT,
  proposed_by TEXT NOT NULL,
  name TEXT NOT NULL,
  spec TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  times INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS agent_proposals_status ON agent_proposals(status, name);
`;

/** Columns added after the first release; applied with ALTER TABLE when missing. */
const MIGRATIONS: [string, string][] = [
  ["acceptance", "TEXT NOT NULL DEFAULT '[]'"],
  ["agent_version", "TEXT"],
  ["cost_usd", "REAL NOT NULL DEFAULT 0"],
  ["lane", "TEXT"],
  ["worktree", "TEXT"],
  ["confirmation", "TEXT"],
  ["pr_gate", "TEXT"],
];

function now(): string {
  return new Date().toISOString();
}

export class Store {
  readonly db: Database;
  readonly path: string;

  constructor(file?: string) {
    this.path = file ?? path.join(dataDir(), "agentpipe.db");
    this.db = new Database(this.path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    const have = new Set((this.db.query("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name));
    for (const [col, ddl] of MIGRATIONS) if (!have.has(col)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${ddl}`);
  }

  close() {
    this.db.close();
  }

  /** A raw `tasks` row (from a query written elsewhere) as a Task, with its JSON columns parsed. */
  fromRow(r: any): Task | null {
    return this.row(r);
  }

  private row(r: any): Task | null {
    if (!r) return null;
    return { ...r, depends_on: JSON.parse(r.depends_on || "[]"), files: JSON.parse(r.files || "[]"), acceptance: JSON.parse(r.acceptance || "[]"), cost_usd: r.cost_usd ?? 0, confirmation: r.confirmation ? JSON.parse(r.confirmation) : null, pr_gate: r.pr_gate ? JSON.parse(r.pr_gate) : null } as Task;
  }

  add(t: NewTask): Task {
    const r = this.db
      .query(
        `INSERT INTO tasks (project, agent, title, description, acceptance, priority, parent_id, depends_on, files, branch, created_at, created_by)
         VALUES ($project, $agent, $title, $description, $acceptance, $priority, $parent_id, $depends_on, $files, $branch, $created_at, $created_by) RETURNING *`,
      )
      .get({
        $project: t.project,
        $agent: t.agent,
        $title: t.title.slice(0, 200),
        $description: t.description,
        $acceptance: JSON.stringify(t.acceptance ?? []),
        $priority: t.priority ?? 50,
        $parent_id: t.parent_id ?? null,
        $depends_on: JSON.stringify(t.depends_on ?? []),
        $files: JSON.stringify(t.files ?? []),
        $branch: t.branch ?? null,
        $created_at: now(),
        $created_by: t.created_by ?? "cli",
      });
    const task = this.row(r)!;
    this.event(task.id, "created", `by ${task.created_by} for agent ${task.agent}${task.parent_id ? `, child of #${task.parent_id}` : ""}${task.depends_on.length ? `, after ${task.depends_on.map((d) => "#" + d).join(",")}` : ""}`);
    this.refreshBlocked(task.project);
    return this.get(task.id)!;
  }

  get(id: number): Task | null {
    return this.row(this.db.query("SELECT * FROM tasks WHERE id = ?").get(id));
  }

  list(f: ListFilter = {}): Task[] {
    const where: string[] = [];
    const params: any[] = [];
    if (f.project) {
      where.push("project = ?");
      params.push(f.project);
    }
    if (f.agent) {
      where.push("agent = ?");
      params.push(f.agent);
    }
    if (f.status?.length) {
      where.push(`status IN (${f.status.map(() => "?").join(",")})`);
      params.push(...f.status);
    }
    if (f.parent_id !== undefined) {
      if (f.parent_id === null) where.push("parent_id IS NULL");
      else {
        where.push("parent_id = ?");
        params.push(f.parent_id);
      }
    }
    const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id ASC ${f.limit ? `LIMIT ${Number(f.limit)}` : ""}`;
    return this.db
      .query(sql)
      .all(...params)
      .map((r) => this.row(r)!);
  }

  children(id: number): Task[] {
    return this.list({ parent_id: id });
  }

  counts(project?: string): Record<TaskStatus, number> {
    const rows = this.db.query(`SELECT status, COUNT(*) AS n FROM tasks ${project ? "WHERE project = ?" : ""} GROUP BY status`).all(...(project ? [project] : [])) as { status: TaskStatus; n: number }[];
    const out = Object.fromEntries(["queued", "blocked", "running", "waiting", "review", "done", "attention", "failed", "cancelled"].map((s) => [s, 0])) as Record<TaskStatus, number>;
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  openCount(project?: string): number {
    const c = this.counts(project);
    return OPEN_STATUSES.reduce((n, s) => n + c[s], 0);
  }

  update(id: number, patch: Partial<Omit<Task, "id" | "depends_on" | "files" | "acceptance" | "confirmation" | "pr_gate">> & { depends_on?: number[]; files?: string[]; acceptance?: string[]; confirmation?: Confirmation | null; pr_gate?: PrGate | null }): Task {
    const cols: string[] = [];
    const params: any[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      cols.push(`${k} = ?`);
      params.push(k === "depends_on" || k === "files" || k === "acceptance" ? JSON.stringify(v) : k === "confirmation" || k === "pr_gate" ? (v === null ? null : JSON.stringify(v)) : v);
    }
    if (cols.length) this.db.query(`UPDATE tasks SET ${cols.join(", ")} WHERE id = ?`).run(...params, id);
    return this.get(id)!;
  }

  event(taskId: number, kind: string, message: string) {
    this.db.query("INSERT INTO events (task_id, ts, kind, message) VALUES (?, ?, ?, ?)").run(taskId, now(), kind, message.slice(0, 4000));
  }

  events(taskId: number): TaskEvent[] {
    return this.db.query("SELECT * FROM events WHERE task_id = ? ORDER BY id").all(taskId) as TaskEvent[];
  }

  /** Move a task to a new status with an audit line, and keep dependants and parents consistent. */
  setStatus(id: number, status: TaskStatus, message = ""): Task {
    const before = this.get(id);
    if (!before) throw new Error(`no task #${id}`);
    const patch: any = { status };
    if (status === "running") patch.started_at = now();
    if (TERMINAL_STATUSES.includes(status) && status !== "blocked") patch.finished_at = now();
    const t = this.update(id, patch);
    this.event(id, "status", `${before.status} -> ${status}${message ? `: ${message}` : ""}`);
    this.refreshBlocked(t.project);
    return this.get(id)!;
  }

  /**
   * Atomically take the next runnable task: queued, every dependency done, lowest priority
   * number first, then oldest. `agents` restricts to the agents a lane serves, `projects` to
   * the projects that may run (active, not held); `prefer` (the current project) goes ahead of
   * the others. Returns null when nothing is runnable.
   */
  claimNext(opts: { project?: string; projects?: string[]; prefer?: string | null; agents?: string[]; lane?: string } = {}): Task | null {
    if (opts.agents && opts.agents.length === 0) return null;
    if (opts.projects && opts.projects.length === 0) return null;
    const tx = this.db.transaction(() => {
      const params: any[] = [];
      const where: string[] = ["t.status = 'queued'"];
      if (opts.project) {
        where.push("t.project = ?");
        params.push(opts.project);
      }
      if (opts.projects) {
        where.push(`t.project IN (${opts.projects.map(() => "?").join(",")})`);
        params.push(...opts.projects);
      }
      if (opts.agents) {
        where.push(`t.agent IN (${opts.agents.map(() => "?").join(",")})`);
        params.push(...opts.agents);
      }
      params.push(opts.prefer ?? "");
      const r = this.db
        .query(
          `SELECT t.* FROM tasks t
           WHERE ${where.join(" AND ")}
             AND NOT EXISTS (
               SELECT 1 FROM json_each(t.depends_on) d JOIN tasks x ON x.id = d.value WHERE x.status != 'done'
             )
           ORDER BY (t.project = ?) DESC, t.priority ASC, t.id ASC LIMIT 1`,
        )
        .get(...params);
      const t = this.row(r);
      if (!t) return null;
      this.db.query("UPDATE tasks SET status = 'running', started_at = ?, attempts = attempts + 1, error = NULL, lane = ? WHERE id = ?").run(now(), opts.lane ?? null, t.id);
      this.event(t.id, "status", `queued -> running (attempt ${t.attempts + 1}${opts.lane ? `, lane ${opts.lane}` : ""})`);
      return this.get(t.id);
    });
    return tx();
  }

  /**
   * Tasks the architect's review cycle must look at: parents whose children all finished, and
   * top-level tasks that stopped (attention, failed, blocked, or cancelled by an agent) and that
   * nobody has looked at. A human's cancel or the architect's own decisions set triaged.
   */
  needsTriage(project: string, limit: number): Task[] {
    return this.db
      .query(
        `SELECT * FROM tasks WHERE project = ? AND (
           status = 'review' OR (status IN ('attention','failed','blocked','cancelled') AND triaged = 0 AND parent_id IS NULL)
         ) ORDER BY priority ASC, id ASC LIMIT ?`,
      )
      .all(project, limit)
      .map((r) => this.row(r)!);
  }

  /**
   * queued -> blocked when a dependency ended badly; blocked -> queued when that is no longer true
   * (a retry requeued the dependency). Cheap enough to run after every change.
   */
  refreshBlocked(project: string) {
    const toBlock = this.db
      .query(
        `SELECT t.id, x.id AS dep, x.status AS dep_status FROM tasks t, json_each(t.depends_on) d JOIN tasks x ON x.id = d.value
         WHERE t.project = ? AND t.status = 'queued' AND x.status IN (${BAD_STATUSES.map((s) => `'${s}'`).join(",")})`,
      )
      .all(project) as { id: number; dep: number; dep_status: string }[];
    for (const b of toBlock) {
      this.db.query("UPDATE tasks SET status = 'blocked', error = ? WHERE id = ? AND status = 'queued'").run(`dependency #${b.dep} is ${b.dep_status}`, b.id);
      this.event(b.id, "status", `queued -> blocked: dependency #${b.dep} is ${b.dep_status}`);
    }
    const toUnblock = this.db
      .query(
        `SELECT t.id FROM tasks t WHERE t.project = ? AND t.status = 'blocked' AND NOT EXISTS (
           SELECT 1 FROM json_each(t.depends_on) d JOIN tasks x ON x.id = d.value WHERE x.status IN (${BAD_STATUSES.map((s) => `'${s}'`).join(",")})
         )`,
      )
      .all(project) as { id: number }[];
    for (const u of toUnblock) {
      this.db.query("UPDATE tasks SET status = 'queued', error = NULL WHERE id = ? AND status = 'blocked'").run(u.id);
      this.event(u.id, "status", "blocked -> queued: dependencies are healthy again");
    }
  }

  /**
   * After a child reaches a terminal state: if every sibling has too, the parent leaves `waiting`
   * for `review` so the architect looks at the outcome. Returns the parent if it changed.
   */
  settleParent(childId: number): Task | null {
    const child = this.get(childId);
    if (!child?.parent_id) return null;
    const parent = this.get(child.parent_id);
    if (!parent || parent.status !== "waiting") return null;
    const kids = this.children(parent.id);
    const open = kids.filter((k) => !TERMINAL_STATUSES.includes(k.status));
    if (open.length) return null;
    const summary = kids.map((k) => `#${k.id} ${k.status}`).join(", ");
    return this.setStatus(parent.id, "review", `all ${kids.length} children finished (${summary})`);
  }

  /** Worker restarted: anything left `running` was interrupted. Requeue or fail it. */
  recoverInterrupted(maxAttempts: number): Task[] {
    const out: Task[] = [];
    for (const t of this.list({ status: ["running"] })) {
      if (t.attempts >= maxAttempts) {
        out.push(this.setStatus(t.id, "failed", `interrupted by a worker restart after ${t.attempts} attempt(s)`));
        this.update(t.id, { error: `interrupted ${t.attempts} time(s); giving up` });
        this.settleParent(t.id);
      } else {
        out.push(this.setStatus(t.id, "queued", "interrupted by a worker restart; requeued"));
      }
    }
    return out;
  }

  /**
   * Put a stopped task back in the queue (a retry, or a human's reply). Its error and triage mark
   * are cleared. A parent the architect already looked at (`review`, or `attention` because of
   * this child) goes back to `waiting`, so the tree converges through the architect again once the
   * child finishes instead of leaving the child's outcome orphaned.
   */
  requeue(id: number, message: string): Task {
    const t = this.get(id);
    if (!t) throw new Error(`no task #${id}`);
    this.update(id, { error: null, triaged: 0 });
    // A request nobody decided on is moot once the agent runs again; it will ask afresh if it must.
    if (t.confirmation?.status === "pending") this.setConfirmation(id, { ...t.confirmation, status: "superseded" });
    const out = this.setStatus(id, "queued", message);
    if (t.parent_id) {
      const parent = this.get(t.parent_id);
      if (parent && (parent.status === "review" || parent.status === "attention")) this.setStatus(parent.id, "waiting", `child #${id} was requeued`);
    }
    return out;
  }

  setConfirmation(id: number, c: Confirmation | null): Task {
    return this.update(id, { confirmation: c });
  }

  /** Attach the pull request this task is gating, or clear it with null. */
  setPrGate(id: number, gate: PrGate | null): Task {
    return this.update(id, { pr_gate: gate });
  }

  /** Tasks whose pull request is still being watched; finished and cancelled ones are left alone. */
  openPrGates(project?: string): Task[] {
    const statuses: TaskStatus[] = ["queued", "blocked", "running", "waiting", "review", "attention"];
    const params: any[] = [...statuses];
    let sql = `SELECT * FROM tasks WHERE pr_gate IS NOT NULL AND status IN (${statuses.map(() => "?").join(",")})`;
    if (project) {
      sql += " AND project = ?";
      params.push(project);
    }
    sql += " ORDER BY id ASC";
    return this.db
      .query(sql)
      .all(...params)
      .map((r) => this.row(r)!);
  }

  /* ---------- replies: the human answering an agent ---------- */

  reply(taskId: number, author: string, text: string): Reply {
    const r = this.db.query("INSERT INTO replies (task_id, ts, author, text) VALUES (?, ?, ?, ?) RETURNING *").get(taskId, now(), author, text) as Reply;
    this.event(taskId, "reply", `${author}: ${text.replace(/\s+/g, " ")}`);
    return r;
  }

  replies(taskId: number): Reply[] {
    return this.db.query("SELECT * FROM replies WHERE task_id = ? ORDER BY id").all(taskId) as Reply[];
  }

  /* ---------- agent proposals: agents that should exist ---------- */

  /** Record a proposal; an open one with the same name is refreshed and counted instead of duplicated. */
  proposeAgent(p: { name: string; spec: object; task_id: number | null; project: string | null; proposed_by: string }): ProposalRow {
    const open = this.db.query("SELECT * FROM agent_proposals WHERE name = ? AND status = 'open' LIMIT 1").get(p.name) as ProposalRow | null;
    if (open) {
      this.db.query("UPDATE agent_proposals SET ts = ?, task_id = ?, project = ?, proposed_by = ?, spec = ?, times = times + 1 WHERE id = ?").run(now(), p.task_id, p.project, p.proposed_by, JSON.stringify(p.spec), open.id);
      return this.db.query("SELECT * FROM agent_proposals WHERE id = ?").get(open.id) as ProposalRow;
    }
    return this.db.query("INSERT INTO agent_proposals (ts, task_id, project, proposed_by, name, spec) VALUES (?, ?, ?, ?, ?, ?) RETURNING *").get(now(), p.task_id, p.project, p.proposed_by, p.name, JSON.stringify(p.spec)) as ProposalRow;
  }

  proposals(status?: ProposalRow["status"]): ProposalRow[] {
    return (status ? this.db.query("SELECT * FROM agent_proposals WHERE status = ? ORDER BY times DESC, id DESC").all(status) : this.db.query("SELECT * FROM agent_proposals ORDER BY id DESC").all()) as ProposalRow[];
  }

  proposal(id: number): ProposalRow | null {
    return (this.db.query("SELECT * FROM agent_proposals WHERE id = ?").get(id) as ProposalRow | null) ?? null;
  }

  setProposalStatus(id: number, status: ProposalRow["status"]): ProposalRow {
    this.db.query("UPDATE agent_proposals SET status = ? WHERE id = ?").run(status, id);
    const r = this.proposal(id);
    if (!r) throw new Error(`no agent proposal #${id}`);
    return r;
  }

  /** Same agent, same project, same title, still open: a duplicate. */
  findDuplicate(project: string, agent: string, title: string): Task | null {
    return this.row(this.db.query(`SELECT * FROM tasks WHERE project = ? AND agent = ? AND lower(title) = lower(?) AND status IN ('queued','blocked','running','waiting','review') LIMIT 1`).get(project, agent, title.slice(0, 200)));
  }

  /* ---------- usage and budgets ---------- */

  addUsage(u: Omit<UsageRow, "id" | "ts">) {
    this.db.query("INSERT INTO usage (ts, task_id, project, agent, label, model, cost_usd, turns, seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(now(), u.task_id, u.project, u.agent, u.label, u.model, u.cost_usd, u.turns, u.seconds);
    if (u.task_id != null) this.db.query("UPDATE tasks SET cost_usd = cost_usd + ? WHERE id = ?").run(u.cost_usd, u.task_id);
  }

  /** Spend since an ISO timestamp, in total and per agent / project. */
  spend(sinceIso: string): { total: number; calls: number; byAgent: Record<string, number>; byProject: Record<string, number> } {
    const rows = this.db.query("SELECT agent, project, SUM(cost_usd) AS usd, COUNT(*) AS n FROM usage WHERE ts >= ? GROUP BY agent, project").all(sinceIso) as { agent: string | null; project: string | null; usd: number; n: number }[];
    const out = { total: 0, calls: 0, byAgent: {} as Record<string, number>, byProject: {} as Record<string, number> };
    for (const r of rows) {
      out.total += r.usd;
      out.calls += r.n;
      const a = r.agent ?? "(none)";
      const p = r.project ?? "(none)";
      out.byAgent[a] = (out.byAgent[a] ?? 0) + r.usd;
      out.byProject[p] = (out.byProject[p] ?? 0) + r.usd;
    }
    return out;
  }

  spendToday(): number {
    return this.spend(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z").total;
  }

  /** Outcome mix over an agent's last `window` finished runs (per version when given). */
  agentHealth(agent: string, window: number): { runs: number; done: number; attention: number; failed: number; rate: number; avgSec: number | null; lastFinished: string | null } {
    const rows = this.db
      .query(`SELECT status, started_at, finished_at FROM tasks WHERE agent = ? AND status IN ('done','attention','failed') ORDER BY finished_at DESC LIMIT ?`)
      .all(agent, window) as { status: string; started_at: string | null; finished_at: string | null }[];
    const done = rows.filter((r) => r.status === "done").length;
    const attention = rows.filter((r) => r.status === "attention").length;
    const failed = rows.filter((r) => r.status === "failed").length;
    const durations = rows.filter((r) => r.started_at && r.finished_at).map((r) => (Date.parse(r.finished_at!) - Date.parse(r.started_at!)) / 1000);
    return {
      runs: rows.length,
      done,
      attention,
      failed,
      rate: rows.length ? (attention + failed) / rows.length : 0,
      avgSec: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      lastFinished: rows[0]?.finished_at ?? null,
    };
  }

  getMeta(key: string): string | null {
    const r = this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
    return r?.value ?? null;
  }
  setMeta(key: string, value: string) {
    this.db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}
