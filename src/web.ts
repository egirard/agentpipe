import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { addTask, approveTask, cancelTask, editTask, rejectTask, replyToTask, retryTask, viewProposal } from "./actions.ts";
import { latestDigest } from "./architect.ts";
import { agentpipeRoot, currentProject, dataDir, loadGlobalConfig, projectStatus, type GlobalConfig } from "./global.ts";
import { loadRegistry } from "./registry.ts";
import type { Store, Task } from "./store.ts";
import { checkForUpdate, runUpgrade } from "./upgrade.ts";
import { clip, log, setLogFile, sh } from "./util.ts";

/**
 * `agentpipe web`: the status page. A small Bun server that reads the queue database and probes
 * the box (Ollama, GPU, worker, timer, disks) on every request. Nothing is cached server-side;
 * the numbers are as fresh as the page's last poll.
 *
 * The page itself is installable: a service worker keeps the shell in the browser so that when
 * mothership is down the page still opens and says so, with the last snapshot it saw. Service
 * workers need a secure context, hence the HTTPS listener with a self-signed certificate that
 * the browser trusts once (download it from /ca.crt).
 *
 * Besides reading, the page can do what the CLI does to the queue: add a task, reply to one that
 * asked something, retry, cancel, dismiss an agent proposal. Those are POSTs with a JSON body and
 * are accepted only from the page's own origin (or a non-browser client): a form on some other
 * site cannot send a JSON body without a preflight, and the preflight is refused.
 */

export interface WebOpts {
  port: number;
  tlsPort: number;
  host: string;
  ollamaUrl: string;
  webuiUrl: string;
}

interface Check {
  name: string;
  ok: boolean;
  level: "good" | "warning" | "critical";
  detail: string;
}

const STATIC = path.join(agentpipeRoot(), "web");

/** What is serving: the checkout's commit and when this process started. The page reloads itself when the commit changes. */
const STARTED_AT = new Date().toISOString();
let versionCache: { sha: string; startedAt: string } | null = null;
async function serverVersion(): Promise<{ sha: string; startedAt: string }> {
  if (versionCache) return versionCache;
  const r = await sh("git rev-parse --short HEAD", agentpipeRoot(), 10);
  versionCache = { sha: r.ok ? r.output.trim() : "unknown", startedAt: STARTED_AT };
  return versionCache;
}

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((r) => (t = setTimeout(() => r(fallback), ms)));
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t!);
  }
}

async function fetchJson(url: string, ms = 4000): Promise<any | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function probeGpu() {
  const r = await withTimeout(sh("nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits", os.homedir(), 10), 12_000, null);
  if (!r || !r.ok) return null;
  const [name, util, memUsed, memTotal, temp] = r.output.trim().split("\n")[0].split(",").map((s) => s.trim());
  return { name, utilPct: Number(util), memUsedMb: Number(memUsed), memTotalMb: Number(memTotal), tempC: Number(temp) };
}

async function probeDisks() {
  // df exits non-zero when one of the mounts is missing but still prints the others.
  const r = await withTimeout(sh("df -P -B1 / /data 2>/dev/null", os.homedir(), 10), 12_000, null);
  if (!r || !r.output.trim()) return [];
  return r.output
    .trim()
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f.length >= 6)
    .map((f) => ({ mount: f[5], totalBytes: Number(f[1]), usedBytes: Number(f[2]), usedPct: Math.round((Number(f[2]) / Math.max(1, Number(f[1]))) * 100) }));
}

async function probeTimer() {
  const r = await withTimeout(sh("systemctl --user show agentpipe-architect.timer -p NextElapseUSecRealtime -p LastTriggerUSec -p ActiveState 2>/dev/null", os.homedir(), 10), 12_000, null);
  if (!r || !r.ok || !r.output.includes("=")) return null;
  const kv = Object.fromEntries(r.output.trim().split("\n").map((l) => l.split("=", 2) as [string, string]));
  return { active: kv.ActiveState === "active", next: kv.NextElapseUSecRealtime || null, last: kv.LastTriggerUSec || null };
}

function pidAlive(file: string): number | null {
  if (!existsSync(file)) return null;
  const pid = Number(readFileSync(file, "utf8").trim());
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/** The first lines of a report as one plain line: what an attention task is asking, for the list. */
function summaryHead(s: string | null, max = 240): string | null {
  if (!s) return null;
  const text = s
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#+\s*/gm, "")
    .replace(/[*_`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text ? clip(text, max) : null;
}

function taskRow(t: Task) {
  const durSec = t.started_at && t.finished_at ? Math.round((Date.parse(t.finished_at) - Date.parse(t.started_at)) / 1000) : null;
  return {
    id: t.id,
    project: t.project,
    agent: t.agent,
    title: t.title,
    status: t.status,
    priority: t.priority,
    parent_id: t.parent_id,
    depends_on: t.depends_on,
    created_at: t.created_at,
    started_at: t.started_at,
    finished_at: t.finished_at,
    durationSec: durSec,
    branch: t.branch,
    pr_url: t.pr_url,
    error: t.error ? t.error.slice(0, 300) : null,
    /** What the agent is asking or reporting, for tasks that stopped; null otherwise. */
    ask: t.confirmation?.status === "pending" ? `approve: ${t.confirmation.request.title}` : t.status === "attention" || t.status === "cancelled" || t.status === "failed" ? summaryHead(t.summary) : null,
    confirmation: t.confirmation ? { title: t.confirmation.request.title, status: t.confirmation.status, steps: t.confirmation.request.steps.length } : null,
    created_by: t.created_by,
    round: t.round,
    attempts: t.attempts,
    triaged: t.triaged,
  };
}

/** One task in full, for the detail view: record, events, children, replies, and the run report. */
export function taskDetail(store: Store, id: number) {
  const t = store.get(id);
  if (!t) return null;
  let report: string | null = null;
  if (t.run_dir) {
    const f = path.join(t.run_dir, "report.md");
    if (existsSync(f)) report = clip(readFileSync(f, "utf8"), 20_000);
  }
  return { task: t, events: store.events(t.id), children: store.children(t.id).map(taskRow), replies: store.replies(t.id), report };
}


export async function collectStatus(store: Store, gcfg: GlobalConfig, o: WebOpts, historyLimit = 40) {
  const [gpu, disks, timer, update, tags, ps, webui] = await Promise.all([
    probeGpu(),
    probeDisks(),
    probeTimer(),
    withTimeout(checkForUpdate(), 70_000, null),
    fetchJson(`${o.ollamaUrl}/api/tags`),
    fetchJson(`${o.ollamaUrl}/api/ps`),
    (async () => {
      try {
        const res = await fetch(o.webuiUrl, { method: "GET", signal: AbortSignal.timeout(4000), redirect: "manual" });
        return res.status > 0;
      } catch {
        return false;
      }
    })(),
  ]);

  const workerPid = pidAlive(path.join(dataDir(), "worker.pid"));
  const workerLog = path.join(dataDir(), "worker.log");
  const workerLogAge = existsSync(workerLog) ? Math.round((Date.now() - statSync(workerLog).mtimeMs) / 1000) : null;
  // Current project first, archived ones left out.
  const current = currentProject(gcfg);
  const projects = Object.keys(gcfg.projects)
    .filter((p) => projectStatus(gcfg.projects[p]) !== "archived")
    .sort((a, b) => Number(b === current) - Number(a === current));
  const queue = projects.map((p) => ({
    project: p,
    path: gcfg.projects[p].path,
    push: gcfg.projects[p].push,
    current: p === current,
    status: gcfg.projects[p].pending?.length ? "held" : projectStatus(gcfg.projects[p]),
    goal: gcfg.projects[p].goal ?? null,
    branch: gcfg.projects[p].parent ? `${gcfg.projects[p].base} of ${gcfg.projects[p].parent}` : null,
    counts: store.counts(p),
    running: store.list({ project: p, status: ["running"] }).map(taskRow),
    next: store.list({ project: p, status: ["queued"], limit: 8 }).map(taskRow),
    needsYou: store
      .list({ project: p, status: ["attention", "failed", "blocked"] })
      .filter((t) => !t.parent_id || t.status !== "attention" || !t.triaged)
      .slice(-15)
      .map(taskRow),
    lastReview: store.getMeta(`last-review:${p}`),
  }));
  const history = store.db
    .query(`SELECT * FROM tasks WHERE status IN ('done','attention','failed','cancelled') ORDER BY COALESCE(finished_at, created_at) DESC LIMIT ?`)
    .all(historyLimit)
    .map((r: any) => taskRow(store.fromRow(r)!));
  const totals = store.counts();
  const today = store.spendToday();
  const week = store.spend(new Date(Date.now() - 7 * 86400_000).toISOString());
  const digest = latestDigest();
  const registry = loadRegistry();

  const mem = { totalBytes: os.totalmem(), usedBytes: os.totalmem() - os.freemem() };
  const checks: Check[] = [];
  const loaded: string[] = (ps?.models ?? []).map((m: any) => m.name);
  checks.push(tags ? { name: "Ollama", ok: true, level: "good", detail: `${(tags.models ?? []).length} model(s) available${loaded.length ? `, loaded: ${loaded.join(", ")}` : ", nothing loaded"}` } : { name: "Ollama", ok: false, level: "critical", detail: `no answer from ${o.ollamaUrl}` });
  checks.push(gpu ? { name: "GPU", ok: true, level: gpu.tempC > 85 ? "warning" : "good", detail: `${gpu.name}: ${gpu.utilPct}% busy, ${gpu.memUsedMb}/${gpu.memTotalMb} MB, ${gpu.tempC} °C` } : { name: "GPU", ok: false, level: "critical", detail: "nvidia-smi failed (driver not loaded?)" });
  checks.push(workerPid ? { name: "Worker", ok: true, level: "good", detail: `running (pid ${workerPid})${workerLogAge != null ? `, last log ${fmtAge(workerLogAge)} ago` : ""}` } : { name: "Worker", ok: false, level: totals.queued + totals.running > 0 ? "critical" : "warning", detail: "not running: systemctl --user start agentpipe-worker" });
  checks.push(
    timer?.active ? { name: "Architect timer", ok: true, level: "good", detail: `next wake ${timer.next ?? "unknown"}` } : { name: "Architect timer", ok: false, level: "warning", detail: "timer inactive (rebuild not applied yet, or systemctl --user start agentpipe-architect.timer)" },
  );
  checks.push(webui ? { name: "Open WebUI", ok: true, level: "good", detail: `answering at ${o.webuiUrl}` } : { name: "Open WebUI", ok: false, level: "warning", detail: `no answer from ${o.webuiUrl}` });
  checks.push({ name: "Claude token", ok: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN), level: process.env.CLAUDE_CODE_OAUTH_TOKEN ? "good" : "critical", detail: process.env.CLAUDE_CODE_OAUTH_TOKEN ? "CLAUDE_CODE_OAUTH_TOKEN present (~/.config/agentpipe/env)" : "missing: run claude setup-token and fill ~/.config/agentpipe/env" });
  for (const d of disks) checks.push({ name: `Disk ${d.mount}`, ok: d.usedPct < 90, level: d.usedPct >= 95 ? "critical" : d.usedPct >= 85 ? "warning" : "good", detail: `${d.usedPct}% used of ${fmtBytes(d.totalBytes)}` });
  const stuck = queue.flatMap((q) => q.running).filter((t) => t.started_at && Date.now() - Date.parse(t.started_at) > 3 * 3600_000);
  if (stuck.length) checks.push({ name: "Long-running task", ok: false, level: "warning", detail: stuck.map((t) => `#${t.id} running since ${t.started_at}`).join("; ") });
  if (registry.problems.length) checks.push({ name: "Agent registry", ok: false, level: "warning", detail: registry.problems.join("; ") });
  if (update?.available) checks.push({ name: "Update available", ok: false, level: "warning", detail: `${update.behind} commit(s) behind origin/${update.branch}: ${update.commits.slice(0, 3).join("; ")}${update.commits.length > 3 ? "; …" : ""}. Upgrade from the banner above or: agentpipe upgrade` });
  else if (update?.error) checks.push({ name: "Update check", ok: false, level: "warning", detail: update.error });
  const approvals = queue.flatMap((q) => q.needsYou).filter((t) => t.confirmation?.status === "pending");
  if (approvals.length) checks.push({ name: "Awaiting your approval", ok: false, level: "warning", detail: approvals.map((t) => `#${t.id} ${t.confirmation!.title}`).join("; ") });
  if (gcfg.budgets.dailyUsd) checks.push({ name: "Daily Claude budget", ok: today < gcfg.budgets.dailyUsd, level: today >= gcfg.budgets.dailyUsd ? "warning" : today >= gcfg.budgets.dailyUsd * 0.8 ? "warning" : "good", detail: `$${today.toFixed(2)} of $${gcfg.budgets.dailyUsd} today; $${week.total.toFixed(2)} this week` });
  for (const a of registry.agents.values()) {
    const h = store.agentHealth(a.name, gcfg.budgets.agentWindow);
    if (h.runs >= 3 && h.rate >= gcfg.budgets.agentAttentionRate) checks.push({ name: `Agent ${a.name}`, ok: false, level: "warning", detail: `${Math.round(h.rate * 100)}% of its last ${h.runs} runs needed intervention (${h.attention} attention, ${h.failed} failed)` });
  }

  return {
    ok: true,
    ts: new Date().toISOString(),
    version: await serverVersion(),
    host: { name: os.hostname(), uptimeSec: Math.round(os.uptime()), load: os.loadavg().map((x) => Math.round(x * 100) / 100), mem, cpus: os.cpus().length },
    gpu,
    disks,
    ollama: tags ? { models: (tags.models ?? []).map((m: any) => ({ name: m.name, sizeBytes: m.size })), loaded } : null,
    worker: { pid: workerPid, logAgeSec: workerLogAge },
    architect: { timer, digestFile: digest?.file ?? null, digestAt: digest ? statSync(digest.file).mtime.toISOString() : null, digestExcerpt: digest ? digest.text.slice(0, 2500) : null },
    update,
    links: { webui: o.webuiUrl },
    budgets: { todayUsd: Math.round(today * 100) / 100, weekUsd: Math.round(week.total * 100) / 100, weekCalls: week.calls, dailyCapUsd: gcfg.budgets.dailyUsd, taskCapUsd: gcfg.budgets.taskUsd, byAgent: week.byAgent, byProject: week.byProject },
    lanes: Object.entries(gcfg.worker.lanes).map(([lane, slots]) => ({ lane, slots, running: store.list({ status: ["running"] }).filter((t) => t.lane === lane).map((t) => t.id) })),
    agents: agentCatalog(store, registry, gcfg),
    proposals: store.proposals("open").map(viewProposal),
    checks,
    totals,
    queue,
    history,
  };
}

/** Registry metadata plus what the queue knows about each agent's track record. */
export function agentCatalog(store: Store, registry: ReturnType<typeof loadRegistry>, gcfg?: GlobalConfig) {
  const stats = new Map<string, any>();
  for (const r of store.db
    .query(
      `SELECT agent, COUNT(*) AS runs,
              SUM(status='done') AS done, SUM(status='attention') AS attention, SUM(status='failed') AS failed,
              SUM(status IN ('queued','running','waiting','review','blocked')) AS open,
              MAX(finished_at) AS last_finished,
              AVG(CASE WHEN started_at IS NOT NULL AND finished_at IS NOT NULL THEN (julianday(finished_at)-julianday(started_at))*86400 END) AS avg_sec
       FROM tasks GROUP BY agent`,
    )
    .all() as any[])
    stats.set(r.agent, r);
  return [...registry.agents.values()].map((a) => ({
    name: a.name,
    runtime: a.runtime,
    description: a.description,
    when_to_use: a.when_to_use,
    inputs: a.inputs,
    outputs: a.outputs,
    commits: a.commits,
    can_delegate: a.can_delegate,
    model: a.model,
    tools: a.tools,
    shell: a.shell,
    paths: a.paths,
    lane: a.lane,
    version: a.version,
    context: a.context,
    tags: a.tags,
    verifier: a.verifier ? a.verifier.kind : null,
    tests: a.hasTests,
    extras: a.extras,
    source: a.dir ?? a.source,
    builtin: a.source.startsWith(agentpipeRoot()),
    stats: (() => {
      const r = stats.get(a.name);
      return r ? { runs: r.runs, done: r.done, attention: r.attention, failed: r.failed, open: r.open, lastFinished: r.last_finished, avgSec: r.avg_sec == null ? null : Math.round(r.avg_sec) } : { runs: 0, done: 0, attention: 0, failed: 0, open: 0, lastFinished: null, avgSec: null };
    })(),
    health: (() => {
      const h = store.agentHealth(a.name, gcfg?.budgets.agentWindow ?? 10);
      return { ...h, warn: h.runs >= 3 && h.rate >= (gcfg?.budgets.agentAttentionRate ?? 0.5) };
    })(),
  }));
}

function fmtAge(sec: number): string {
  if (sec < 90) return `${sec}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  if (sec < 172800) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}
function fmtBytes(b: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) {
    b /= 1024;
    i++;
  }
  return `${b.toFixed(i >= 3 ? 1 : 0)} ${u[i]}`;
}

/** A self-signed certificate covering every name this box answers to. Generated once, kept in the data dir. */
async function ensureCert(): Promise<{ cert: string; key: string } | null> {
  const dir = path.join(dataDir(), "web");
  mkdirSync(dir, { recursive: true });
  const cert = path.join(dir, "cert.pem");
  const key = path.join(dir, "key.pem");
  if (existsSync(cert) && existsSync(key)) return { cert, key };
  const host = os.hostname();
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is os.NetworkInterfaceInfo => Boolean(i && i.family === "IPv4" && !i.internal))
    .map((i) => `IP:${i.address}`);
  const san = [`DNS:${host}`, `DNS:${host}.local`, `DNS:${host}.home`, `DNS:localhost`, "IP:127.0.0.1", ...ips].join(",");
  // sh() opens a login shell whose profile resets PATH; find openssl on the unit's PATH first.
  const openssl = Bun.which("openssl");
  if (!openssl) {
    log("web: openssl not found on PATH; serving HTTP only (no offline mode)");
    return null;
  }
  const cmd = `umask 077; ${JSON.stringify(openssl)} req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 -keyout ${JSON.stringify(key)} -out ${JSON.stringify(cert)} -subj "/CN=${host} status" -addext "subjectAltName=${san}" -addext "basicConstraints=critical,CA:true" -addext "keyUsage=digitalSignature,keyCertSign" -addext "extendedKeyUsage=serverAuth"`;
  const r = await sh(cmd, dir, 60);
  if (!r.ok) {
    log(`web: could not create a certificate (openssl missing?): ${r.output.trim().slice(0, 200)}; serving HTTP only`);
    return null;
  }
  log(`web: created self-signed certificate for ${san}`);
  return { cert, key };
}

function contentType(p: string): string {
  if (p.endsWith(".html")) return "text/html; charset=utf-8";
  if (p.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (p.endsWith(".css")) return "text/css; charset=utf-8";
  if (p.endsWith(".webmanifest")) return "application/manifest+json";
  if (p.endsWith(".svg")) return "image/svg+xml";
  if (p.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

class BadRequest extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/**
 * Same-origin guard for writes. Browsers send Sec-Fetch-Site on every request; anything but
 * same-origin/none is refused. A body that is not JSON is refused too, which is what stops a
 * plain HTML form on another site (forms cannot send application/json without a preflight).
 */
async function jsonBody(req: Request): Promise<Record<string, any>> {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw new BadRequest(`cross-site request refused (${site})`, 403);
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) throw new BadRequest("send a JSON body (content-type: application/json)", 415);
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequest("body must be a JSON object");
  return body;
}

function who(req: Request): string {
  const ua = req.headers.get("user-agent") ?? "";
  return `web${/Mobile|Android|iPhone|iPad/.test(ua) ? " (phone)" : ""}`;
}

/** The request handler, separated from the listeners so tests can call it. `gcfg` is re-read on writes so a project added meanwhile counts. */
export function createHandler(store: Store, gcfg: GlobalConfig, o: WebOpts, tls: { cert: string; key: string } | null) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const headers: Record<string, string> = { "access-control-allow-origin": "*", "cache-control": "no-store" };
    try {
      if (url.pathname === "/healthz") return new Response("ok\n", { headers });
      if (req.method === "OPTIONS") return new Response(null, { status: 405, headers: { "cache-control": "no-store" } });

      // ---- writes: what the CLI does, from the page ----
      if (req.method === "POST") {
        const fresh = (() => {
          try {
            return (gcfg = loadGlobalConfig());
          } catch {
            return gcfg;
          }
        })();
        const by = who(req);
        if (url.pathname === "/api/tasks") {
          const b = await jsonBody(req);
          const { task, notes } = addTask(store, fresh, {
            project: typeof b.project === "string" ? b.project : null,
            agent: typeof b.agent === "string" ? b.agent : null,
            title: typeof b.title === "string" ? b.title : null,
            description: typeof b.description === "string" ? b.description : "",
            priority: b.priority == null || b.priority === "" ? null : Number(b.priority),
            acceptance: Array.isArray(b.acceptance) ? b.acceptance.map(String) : typeof b.acceptance === "string" ? b.acceptance.split(/\s*;\s*|\n/) : null,
            files: Array.isArray(b.files) ? b.files.map(String) : typeof b.files === "string" ? b.files.split(/[,\s]+/) : null,
            depends_on: Array.isArray(b.depends_on) ? b.depends_on.map(Number) : null,
            created_by: by,
          });
          log(`web: ${by} queued #${task.id} for ${task.agent} in ${task.project}: ${task.title}`);
          return Response.json({ ok: true, task: taskRow(task), notes }, { status: 201, headers });
        }
        if (url.pathname === "/api/upgrade") {
          const b = await jsonBody(req);
          const r = await runUpgrade(store, { force: b.force === true, restart: "scheduled" });
          log(`web: ${by} upgrade: ${r.lines.join(" | ")}`);
          return Response.json({ ok: r.ok, lines: r.lines, restarted: r.restarted }, { status: r.ok ? 200 : 409, headers });
        }
        const tm = url.pathname.match(/^\/api\/task\/(\d+)\/(reply|retry|cancel|approve|reject|edit)$/);
        if (tm) {
          const id = Number(tm[1]);
          const b = await jsonBody(req);
          if (tm[2] === "approve") {
            // Marks the request running synchronously, then the steps run while the page polls the task.
            const p = approveTask(store, fresh, id, by);
            await Promise.race([p, new Promise((r) => setTimeout(r, 1500))]);
            p.then((r) => log(`web: ${by} approved #${id}: ${r.ok ? "ok" : "FAILED"} (${r.log[r.log.length - 1]})`)).catch((e) => log(`web: approval of #${id} crashed: ${(e as Error).message}`));
            const t = store.get(id)!;
            return Response.json({ ok: true, task: taskRow(t), note: t.confirmation?.status === "running" ? "approved; the steps are running, watch the events" : `approved; ${t.confirmation?.status}`, ...taskDetail(store, id) }, { headers });
          }
          if (tm[2] === "reject") {
            const c = rejectTask(store, id, by, typeof b.reason === "string" ? b.reason : null);
            log(`web: ${by} rejected #${id}`);
            return Response.json({ ok: true, task: taskRow(c.task), note: `#${id} rejected and cancelled` }, { headers });
          }
          if (tm[2] === "reply") {
            const r = replyToTask(store, id, typeof b.text === "string" ? b.text : "", by, { requeue: b.requeue !== false });
            log(`web: ${by} replied to #${id}${r.requeued ? " (requeued)" : ""}`);
            return Response.json({ ok: true, task: taskRow(r.task), requeued: r.requeued, note: r.note, ...taskDetail(store, id) }, { headers });
          }
          if (tm[2] === "edit") {
            const t = editTask(store, fresh, id, {
              title: typeof b.title === "string" ? b.title : null,
              description: typeof b.description === "string" ? b.description : null,
              acceptance: Array.isArray(b.acceptance) ? b.acceptance.map(String) : typeof b.acceptance === "string" ? b.acceptance.split("\n") : null,
              files: Array.isArray(b.files) ? b.files.map(String) : typeof b.files === "string" ? b.files.split(/[,\s]+/) : null,
              agent: typeof b.agent === "string" ? b.agent : null,
              priority: b.priority == null || b.priority === "" ? null : Number(b.priority),
            }, by);
            log(`web: ${by} edited #${id}`);
            return Response.json({ ok: true, task: taskRow(t), note: `#${id} saved`, ...taskDetail(store, id) }, { headers });
          }
          if (tm[2] === "retry") {
            const t = retryTask(store, id, by);
            log(`web: ${by} retried #${id}`);
            return Response.json({ ok: true, task: taskRow(t), note: `#${id} requeued` }, { headers });
          }
          const c = cancelTask(store, id, by, typeof b.reason === "string" ? b.reason : null);
          log(`web: ${by} cancelled #${id}`);
          return Response.json({ ok: true, task: taskRow(c.task), note: c.note ?? `#${id} cancelled` }, { headers });
        }
        const pm = url.pathname.match(/^\/api\/proposal\/(\d+)\/(dismiss|reopen)$/);
        if (pm) {
          await jsonBody(req);
          const row = store.setProposalStatus(Number(pm[1]), pm[2] === "dismiss" ? "dismissed" : "open");
          return Response.json({ ok: true, proposal: viewProposal(row) }, { headers });
        }
        return Response.json({ ok: false, error: "no such action" }, { status: 404, headers });
      }

      if (url.pathname === "/api/status") {
        const limit = Math.min(500, Number(url.searchParams.get("history") ?? 40) || 40);
        // Projects are added, paused and switched from the CLI while this server runs: re-read every time, keep the last good copy on a half-written file.
        try {
          gcfg = loadGlobalConfig();
        } catch (e) {
          log(`web: config unreadable, keeping the previous one: ${(e as Error).message}`);
        }
        return Response.json(await collectStatus(store, gcfg, o, limit), { headers });
      }
      if (url.pathname === "/api/history") {
        const limit = Math.min(2000, Number(url.searchParams.get("limit") ?? 200) || 200);
        const project = url.searchParams.get("project");
        const rows = store.db
          .query(`SELECT * FROM tasks WHERE status IN ('done','attention','failed','cancelled') ${project ? "AND project = ?" : ""} ORDER BY COALESCE(finished_at, created_at) DESC LIMIT ?`)
          .all(...(project ? [project, limit] : [limit]))
          .map((r: any) => taskRow(store.fromRow(r)!));
        return Response.json({ history: rows }, { headers });
      }
      if (url.pathname === "/api/agents") return Response.json({ agents: agentCatalog(store, loadRegistry(), gcfg), problems: loadRegistry().problems }, { headers });
      if (url.pathname === "/api/proposals") {
        const all = url.searchParams.get("all") === "1";
        return Response.json({ proposals: store.proposals(all ? undefined : "open").map(viewProposal) }, { headers });
      }
      if (url.pathname === "/api/spend") {
        const days = Math.min(90, Number(url.searchParams.get("days") ?? 7) || 7);
        const since = new Date(Date.now() - days * 86400_000).toISOString();
        const byDay = store.db.query("SELECT substr(ts,1,10) AS day, SUM(cost_usd) AS usd, COUNT(*) AS calls FROM usage WHERE ts >= ? GROUP BY day ORDER BY day").all(since);
        return Response.json({ days, ...store.spend(since), byDay, today: store.spendToday(), caps: gcfg.budgets }, { headers });
      }
      const m = url.pathname.match(/^\/api\/task\/(\d+)$/);
      if (m) {
        const d = taskDetail(store, Number(m[1]));
        if (!d) return Response.json({ error: "no such task" }, { status: 404, headers });
        return Response.json(d, { headers });
      }
      if (url.pathname === "/ca.crt") {
        if (!tls) return new Response("no certificate on this server\n", { status: 404, headers });
        return new Response(Bun.file(tls.cert), { headers: { ...headers, "content-type": "application/x-x509-ca-cert", "content-disposition": `attachment; filename="${os.hostname()}-status.crt"` } });
      }
      // Static shell. Only files that exist in web/ are served; nothing else on disk is reachable.
      const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1).replace(/[^a-zA-Z0-9._-]/g, "");
      const abs = path.join(STATIC, file);
      if (file && readdirSync(STATIC).includes(file) && statSync(abs).isFile()) {
        const h: Record<string, string> = { ...headers, "content-type": contentType(file) };
        if (file === "sw.js") h["service-worker-allowed"] = "/";
        return new Response(Bun.file(abs), { headers: h });
      }
      return new Response("not found\n", { status: 404, headers });
    } catch (e) {
      if (e instanceof BadRequest) return Response.json({ ok: false, error: e.message }, { status: e.status, headers });
      // Validation errors from the actions (unknown agent, empty description...) are the caller's fault, not ours.
      const status = req.method === "POST" ? 400 : 500;
      if (status === 500) log(`web: ${url.pathname} failed: ${(e as Error).message}`);
      return Response.json({ ok: false, error: (e as Error).message }, { status, headers });
    }
  };
}

export async function runWeb(store: Store, gcfg: GlobalConfig, o: WebOpts) {
  setLogFile(path.join(dataDir(), "web.log"));
  const tls = await ensureCert();
  const handler = createHandler(store, gcfg, o, tls);

  const http = Bun.serve({ hostname: o.host, port: o.port, fetch: handler, idleTimeout: 120 });
  log(`web: http://${os.hostname()}:${http.port}/  (also by IP)`);
  if (tls) {
    const https = Bun.serve({ hostname: o.host, port: o.tlsPort, fetch: handler, idleTimeout: 120, tls: { cert: Bun.file(tls.cert), key: Bun.file(tls.key) } });
    log(`web: https://${os.hostname()}:${https.port}/  (trust /ca.crt once for the offline-capable page)`);
  }
  const stop = () => {
    log("web: stopping");
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await new Promise(() => {});
}
