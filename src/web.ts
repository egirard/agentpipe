import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { latestDigest } from "./architect.ts";
import { agentpipeRoot, dataDir, type GlobalConfig } from "./global.ts";
import { loadRegistry } from "./registry.ts";
import type { Store, Task } from "./store.ts";
import { log, setLogFile, sh } from "./util.ts";

/**
 * `agentpipe web`: the status page. A small Bun server that reads the queue database and probes
 * the box (Ollama, GPU, worker, timer, disks) on every request. Nothing is cached server-side;
 * the numbers are as fresh as the page's last poll.
 *
 * The page itself is installable: a service worker keeps the shell in the browser so that when
 * mothership is down the page still opens and says so, with the last snapshot it saw. Service
 * workers need a secure context, hence the HTTPS listener with a self-signed certificate that
 * the browser trusts once (download it from /ca.crt).
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
    created_by: t.created_by,
    round: t.round,
    attempts: t.attempts,
  };
}


export async function collectStatus(store: Store, gcfg: GlobalConfig, o: WebOpts, historyLimit = 40) {
  const [gpu, disks, timer, tags, ps, webui] = await Promise.all([
    probeGpu(),
    probeDisks(),
    probeTimer(),
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
  const projects = Object.keys(gcfg.projects);
  const queue = projects.map((p) => ({
    project: p,
    path: gcfg.projects[p].path,
    push: gcfg.projects[p].push,
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
    .map((r: any) => taskRow({ ...r, depends_on: JSON.parse(r.depends_on || "[]"), files: JSON.parse(r.files || "[]") }));
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
  if (gcfg.budgets.dailyUsd) checks.push({ name: "Daily Claude budget", ok: today < gcfg.budgets.dailyUsd, level: today >= gcfg.budgets.dailyUsd ? "warning" : today >= gcfg.budgets.dailyUsd * 0.8 ? "warning" : "good", detail: `$${today.toFixed(2)} of $${gcfg.budgets.dailyUsd} today; $${week.total.toFixed(2)} this week` });
  for (const a of registry.agents.values()) {
    const h = store.agentHealth(a.name, gcfg.budgets.agentWindow);
    if (h.runs >= 3 && h.rate >= gcfg.budgets.agentAttentionRate) checks.push({ name: `Agent ${a.name}`, ok: false, level: "warning", detail: `${Math.round(h.rate * 100)}% of its last ${h.runs} runs needed intervention (${h.attention} attention, ${h.failed} failed)` });
  }

  return {
    ok: true,
    ts: new Date().toISOString(),
    host: { name: os.hostname(), uptimeSec: Math.round(os.uptime()), load: os.loadavg().map((x) => Math.round(x * 100) / 100), mem, cpus: os.cpus().length },
    gpu,
    disks,
    ollama: tags ? { models: (tags.models ?? []).map((m: any) => ({ name: m.name, sizeBytes: m.size })), loaded } : null,
    worker: { pid: workerPid, logAgeSec: workerLogAge },
    architect: { timer, digestFile: digest?.file ?? null, digestAt: digest ? statSync(digest.file).mtime.toISOString() : null, digestExcerpt: digest ? digest.text.slice(0, 2500) : null },
    links: { webui: o.webuiUrl },
    budgets: { todayUsd: Math.round(today * 100) / 100, weekUsd: Math.round(week.total * 100) / 100, weekCalls: week.calls, dailyCapUsd: gcfg.budgets.dailyUsd, taskCapUsd: gcfg.budgets.taskUsd, byAgent: week.byAgent, byProject: week.byProject },
    lanes: Object.entries(gcfg.worker.lanes).map(([lane, slots]) => ({ lane, slots, running: store.list({ status: ["running"] }).filter((t) => t.lane === lane).map((t) => t.id) })),
    agents: agentCatalog(store, registry, gcfg),
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

export async function runWeb(store: Store, gcfg: GlobalConfig, o: WebOpts) {
  setLogFile(path.join(dataDir(), "web.log"));
  const tls = await ensureCert();

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const headers: Record<string, string> = { "access-control-allow-origin": "*", "cache-control": "no-store" };
    try {
      if (url.pathname === "/healthz") return new Response("ok\n", { headers });
      if (url.pathname === "/api/status") {
        const limit = Math.min(500, Number(url.searchParams.get("history") ?? 40) || 40);
        return Response.json(await collectStatus(store, gcfg, o, limit), { headers });
      }
      if (url.pathname === "/api/history") {
        const limit = Math.min(2000, Number(url.searchParams.get("limit") ?? 200) || 200);
        const project = url.searchParams.get("project");
        const rows = store.db
          .query(`SELECT * FROM tasks WHERE status IN ('done','attention','failed','cancelled') ${project ? "AND project = ?" : ""} ORDER BY COALESCE(finished_at, created_at) DESC LIMIT ?`)
          .all(...(project ? [project, limit] : [limit]))
          .map((r: any) => taskRow({ ...r, depends_on: JSON.parse(r.depends_on || "[]"), files: JSON.parse(r.files || "[]") }));
        return Response.json({ history: rows }, { headers });
      }
      if (url.pathname === "/api/agents") return Response.json({ agents: agentCatalog(store, loadRegistry(), gcfg), problems: loadRegistry().problems }, { headers });
      if (url.pathname === "/api/spend") {
        const days = Math.min(90, Number(url.searchParams.get("days") ?? 7) || 7);
        const since = new Date(Date.now() - days * 86400_000).toISOString();
        const byDay = store.db.query("SELECT substr(ts,1,10) AS day, SUM(cost_usd) AS usd, COUNT(*) AS calls FROM usage WHERE ts >= ? GROUP BY day ORDER BY day").all(since);
        return Response.json({ days, ...store.spend(since), byDay, today: store.spendToday(), caps: gcfg.budgets }, { headers });
      }
      const m = url.pathname.match(/^\/api\/task\/(\d+)$/);
      if (m) {
        const t = store.get(Number(m[1]));
        if (!t) return Response.json({ error: "no such task" }, { status: 404, headers });
        return Response.json({ task: t, events: store.events(t.id), children: store.children(t.id).map(taskRow) }, { headers });
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
      log(`web: ${url.pathname} failed: ${(e as Error).message}`);
      return Response.json({ ok: false, error: (e as Error).message }, { status: 500, headers });
    }
  };

  const http = Bun.serve({ hostname: o.host, port: o.port, fetch: handler, idleTimeout: 30 });
  log(`web: http://${os.hostname()}:${http.port}/  (also by IP)`);
  if (tls) {
    const https = Bun.serve({ hostname: o.host, port: o.tlsPort, fetch: handler, idleTimeout: 30, tls: { cert: Bun.file(tls.cert), key: Bun.file(tls.key) } });
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
