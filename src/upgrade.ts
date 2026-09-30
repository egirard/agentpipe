import { agentpipeRoot } from "./global.ts";
import type { Store } from "./store.ts";
import { log, sh } from "./util.ts";

/**
 * Upgrading the deployed agentpipe in place. The checkout the services run from (agentpipeRoot)
 * is a git clone; an update is available when origin's branch is ahead of HEAD. Upgrading is
 * `git pull --ff-only`, `bun install`, then a restart of the worker and web units. The web
 * server cannot restart itself from inside its own request (systemd would kill the child with
 * the unit), so it schedules the restart as a transient systemd timer a couple of seconds out.
 */
export interface UpdateInfo {
  root: string;
  branch: string | null;
  local: string | null;
  remote: string | null;
  behind: number;
  ahead: number;
  /** Subjects of the commits waiting, newest first. */
  commits: string[];
  dirty: boolean;
  checkedAt: string;
  available: boolean;
  error: string | null;
}

export const UNITS = ["agentpipe-worker.service", "agentpipe-web.service"];

let cache: { at: number; info: UpdateInfo } | null = null;

async function git(args: string, root: string, timeout = 30): Promise<string | null> {
  const r = await sh(`git ${args}`, root, timeout);
  return r.ok ? r.output.trim() : null;
}

/** Fetch origin (at most every `maxAgeMs`) and compare. Never throws; `error` says what failed. */
export async function checkForUpdate(opts: { maxAgeMs?: number; root?: string } = {}): Promise<UpdateInfo> {
  const root = opts.root ?? agentpipeRoot();
  const maxAge = opts.maxAgeMs ?? 10 * 60_000;
  if (cache && cache.info.root === root && Date.now() - cache.at < maxAge) return cache.info;
  const info: UpdateInfo = { root, branch: null, local: null, remote: null, behind: 0, ahead: 0, commits: [], dirty: false, checkedAt: new Date().toISOString(), available: false, error: null };
  try {
    info.branch = await git("rev-parse --abbrev-ref HEAD", root);
    info.local = await git("rev-parse --short HEAD", root);
    if (!info.branch || info.branch === "HEAD") throw new Error("not on a branch");
    const origin = await git("remote get-url origin", root);
    if (!origin) throw new Error("no origin remote");
    const f = await sh("git fetch -q origin", root, 60);
    if (!f.ok) throw new Error(`git fetch failed: ${f.output.trim().slice(0, 200)}`);
    const upstream = `origin/${info.branch}`;
    info.remote = await git(`rev-parse --short ${JSON.stringify(upstream)}`, root);
    if (!info.remote) throw new Error(`${upstream} does not exist`);
    const counts = await git(`rev-list --left-right --count HEAD...${JSON.stringify(upstream)}`, root);
    const [ahead, behind] = (counts ?? "0\t0").split(/\s+/).map(Number);
    info.ahead = ahead || 0;
    info.behind = behind || 0;
    info.commits = ((await git(`log --format=%s HEAD..${JSON.stringify(upstream)}`, root)) ?? "").split("\n").filter(Boolean).slice(0, 20);
    info.dirty = Boolean((await git("status --porcelain", root)) ?? "");
    info.available = info.behind > 0;
  } catch (e) {
    info.error = (e as Error).message;
  }
  cache = { at: Date.now(), info };
  return info;
}

export interface UpgradeOutcome {
  ok: boolean;
  lines: string[];
  /** now: units restarted; scheduled: a transient timer restarts them in a moment; none: nothing restarted. */
  restarted: "now" | "scheduled" | "none";
}

/**
 * Pull, install, restart. Refuses when the checkout has local changes (nothing is ever discarded)
 * or when a task is running (unless forced; the worker requeues what it was doing). `restart`
 * "scheduled" is for the web server upgrading itself; "now" for the CLI.
 */
export async function runUpgrade(store: Store, opts: { force?: boolean; restart: "now" | "scheduled" | "none"; root?: string }): Promise<UpgradeOutcome> {
  const root = opts.root ?? agentpipeRoot();
  const lines: string[] = [];
  const info = await checkForUpdate({ maxAgeMs: 0, root });
  if (info.error) return { ok: false, lines: [`cannot check for updates: ${info.error}`], restarted: "none" };
  if (info.dirty) return { ok: false, lines: [`${root} has local changes; commit or stash them first (nothing is discarded by an upgrade)`], restarted: "none" };
  const running = store.list({ status: ["running"] });
  if (running.length && !opts.force) return { ok: false, lines: [`${running.length} task(s) running (${running.map((t) => "#" + t.id).join(", ")}); wait, or force to interrupt them (they are requeued)`], restarted: "none" };
  if (!info.available) lines.push(`already up to date at ${info.local} on ${info.branch}`);
  else {
    const pull = await sh("git pull -q --ff-only origin", root, 180);
    if (!pull.ok) return { ok: false, lines: [`git pull failed: ${pull.output.trim().slice(0, 500)}`], restarted: "none" };
    const now = await sh("git rev-parse --short HEAD", root, 30);
    lines.push(`pulled ${info.behind} commit(s): ${info.local} -> ${now.output.trim()}`);
    for (const c of info.commits) lines.push(`  ${c}`);
    const install = await sh("bun install --silent", root, 600);
    lines.push(install.ok ? "bun install: ok" : `bun install failed: ${install.output.trim().slice(0, 500)}`);
    if (!install.ok) return { ok: false, lines, restarted: "none" };
    cache = null;
  }
  if (opts.restart === "none") return { ok: true, lines, restarted: "none" };
  const units = UNITS.join(" ");
  if (opts.restart === "now") {
    const r = await sh(`systemctl --user restart ${units}`, root, 120);
    lines.push(r.ok ? `restarted ${units}` : `restart failed: ${r.output.trim().slice(0, 300)} (run: systemctl --user restart ${units})`);
    return { ok: r.ok, lines, restarted: r.ok ? "now" : "none" };
  }
  // Scheduled: a transient timer outside this unit's cgroup, so restarting the web unit does not cancel the restart.
  const r = await sh(`systemd-run --user --quiet --collect --on-active=3 --description="agentpipe upgrade restart" systemctl --user restart ${units}`, root, 30);
  if (r.ok) {
    lines.push(`restart of ${units} scheduled in 3 seconds`);
    log(`upgrade: restart scheduled for ${units}`);
    return { ok: true, lines, restarted: "scheduled" };
  }
  lines.push(`could not schedule the restart (${r.output.trim().slice(0, 200)}); run: systemctl --user restart ${units}`);
  return { ok: true, lines, restarted: "none" };
}
