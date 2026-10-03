#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { addTask, approveTask, cancelTask, editTask, rejectTask, replyToTask, retryTask, viewProposal } from "./actions.ts";
import { architectReview, latestDigest } from "./architect.ts";
import { claudeReachable } from "./claude.ts";
import { loadConfig, loadEnvFile, type Config } from "./config.ts";
import { agentpipeRoot, currentProject, dataDir, globalConfigPath, isRunnable, loadGlobalConfig, projectStatus, resolveProject, saveGlobalConfig, updateGlobalConfig, type GlobalConfig, type ProjectStatus } from "./global.ts";
import { ollamaModels } from "./ollama.ts";
import { runPipeline } from "./pipeline.ts";
import { Plan } from "./plan.ts";
import { approvePending, createProject, finishStream, queueStreamStart } from "./projects.ts";
import { AgentProposal, ProjectSpec } from "./result.ts";
import { loadRegistry, requireAgent, scaffoldAgent, Runtime } from "./registry.ts";
import { hasGitIdentity, repoStack } from "./repo.ts";
import { shellCheckMain } from "./shell-policy.ts";
import { Store, type TaskStatus } from "./store.ts";
import { addUpstream, listUpstreams, removeUpstream, updateUpstream } from "./upstreams.ts";
import { sh } from "./util.ts";
import { checkForUpdate, runUpgrade } from "./upgrade.ts";
import { runWeb } from "./web.ts";
import { runWorker } from "./worker.ts";

const USAGE = `agentpipe - local-first coding pipeline with a task queue and an agent registry

Every command works on the current project unless --project P (or AGENTPIPE_PROJECT) names
another; inside a registered checkout, that checkout's project. --project all widens status/list.

Queue (the normal way to hand work to the system):
  agentpipe add [--project P] [--agent NAME] [--priority N] [--after 12,13] [--files a.ts,b.ts] [--branch B] [--accept "crit 1;crit 2"] "what to do"
  agentpipe add --file TASKS.md|.json [...]   # bulk: "- [agent] task" lines, or a JSON array of {title,description,agent,...}
  agentpipe status [--project P|all]          # every project in a line, then the current one in detail
  agentpipe list [--project P|all] [--status queued,running,...] [--all]
  agentpipe show ID                           # full record, events, replies, children
  agentpipe reply ID "answer" [--no-requeue]  # answer a task that stopped (attention/failed/cancelled); it is requeued and the agent continues with your reply
  agentpipe retry ID | cancel ID [--reason "why"] | prio ID N   # cancelled = impossible or moot; leaves "needs you", stays in history
  agentpipe edit ID [--title T] [--description TEXT | --desc-file F] [--accept "a;b"] [--agent NAME] [--priority N] [--files a,b]   # change what a task asks for (not while running)
  agentpipe approve ID | reject ID [--reason "why"]   # decide a confirmation request (github, agent-creator): approve runs the listed steps as you
  agentpipe worker [--once] [--project P]     # drain the queue (normally a systemd user service)
  agentpipe architect review [--project P] [--dry-run]   # the architect's wake-up (normally a systemd timer)
  agentpipe digest                            # print the latest architect digest
  agentpipe web [--port 8081] [--tls-port 8443]   # status page + JSON API (normally a systemd user service)
  agentpipe upgrade [--check] [--force]       # pull the deployed checkout, bun install, restart the worker and web units

Registry:
  agentpipe agents                            # list agents the architect can delegate to
  agentpipe agents show NAME                  # manifest, prompt, verifier, tests, extra files
  agentpipe agents new NAME [--runtime claude|ollama|pipeline|shell] [--dir DIR] [--from ID]   # scaffold a package (--from: fill it in from a proposal)
  agentpipe agents test [NAME] [--e2e]        # bun test for one agent or all (--e2e runs the real agent on a scratch repo)
  agentpipe agents proposals [--all]          # agents the architect wished it had (from tasks it could not fully delegate)
  agentpipe agents dismiss ID                 # drop a proposal

Projects: streams of work. Each is a repository in its own directory, or a long-lived branch of
another project. One queue and worker serve them all; the current project's tasks run first.
  agentpipe use [NAME]                        # show or switch the current project
  agentpipe projects                          # list with status, goal and progress ("streams" works too)
  agentpipe projects new NAME "what it is for"   # ask the architect to create and configure it
  agentpipe projects create NAME --goal "..." [--path DIR | --clone URL|owner/name | --new [--github owner/name] | --branch-of PARENT [--branch B]]
                            [--base B] [--push|--no-push] [--setup CMD] [--link a,b] [--kickoff "first goal"] [--use]
  agentpipe projects add NAME PATH [--base main] [--push] [--default] [--goal "..."] [--link node_modules,.svelte-kit] [--setup "bun install"] [--agents-dir DIR]
  agentpipe projects pause|resume|archive NAME    # paused and archived projects run nothing
  agentpipe projects approve NAME             # run the GitHub steps an architect-created project is waiting on
  agentpipe projects upstream add owner/repo|URL [--name N] [--ref BRANCH] [--project P]   # fetch another repository read-only into <checkout>/upstream/N
  agentpipe projects upstream list|update N [--ref B]|remove N [--project P]
  agentpipe projects budget NAME --daily-usd N   # this project's own daily Claude cap (0 = only the global cap)
  agentpipe projects finish NAME              # branch stream: open the PR merging it into its parent
  agentpipe projects remove NAME
  agentpipe spend [--days 7]                  # Claude spend by day, agent and project

Shell policy (used as a Claude Code hook; also handy by hand):
  agentpipe shell-check --groups git-read,gh-read --command "git log -3"

One-off pipeline runs (bypass the queue; stop the worker first if it shares the checkout):
  agentpipe run  [--repo DIR] [--local-only] [--no-e2e] [--no-final-review] [--push] "task description"
  agentpipe plan [--repo DIR] "task description"        # architect only, writes plan.json
  agentpipe resume [--repo DIR] PLAN.json                # run a saved/edited plan
  agentpipe doctor [--repo DIR]                          # check Ollama, Claude auth, toolchain, registry

Files: ~/.config/agentpipe/agentpipe.json (projects), ~/.config/agentpipe/env (CLAUDE_CODE_OAUTH_TOKEN),
~/.config/agentpipe/agents/ (your agents), ~/.local/share/agentpipe/ (queue db, logs, digests).
`;

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const valued = new Set(["repo", "project", "agent", "priority", "after", "files", "branch", "file", "status", "base", "runtime", "title", "port", "tls-port", "host", "webui", "dir", "accept", "link", "setup", "agents-dir", "days", "goal", "path", "clone", "github", "branch-of", "kickoff", "reason", "from", "description", "desc-file", "name", "ref", "daily-usd"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=", 2);
      if (inline !== undefined) flags[k] = inline;
      else if (valued.has(k)) flags[k] = argv[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function fmtAge(iso: string | null): string {
  if (!iso) return "";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function table(rows: string[][], header: string[]) {
  const all = [header, ...rows];
  const w = header.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  for (const [n, r] of all.entries()) {
    console.log(r.map((c, i) => (c ?? "").padEnd(w[i])).join("  ").trimEnd());
    if (n === 0) console.log(w.map((x) => "-".repeat(x)).join("  "));
  }
}

async function doctor(cfg: Config) {
  const envPath = loadEnvFile();
  console.log(`repo:          ${cfg.repo}`);
  console.log(`env file:      ${envPath ?? "(none; expected ~/.config/agentpipe/env)"}`);
  console.log(`config file:   ${existsSync(path.join(cfg.repo, "agentpipe.json")) ? "agentpipe.json found" : "defaults (no agentpipe.json)"}`);
  try {
    const models = await ollamaModels(cfg.ollamaUrl);
    const need = [cfg.models.coder, cfg.models.reviewer];
    console.log(`ollama:        ok at ${cfg.ollamaUrl}, models: ${models.join(", ")}`);
    for (const m of need) console.log(`  ${models.includes(m) ? "ok " : "MISSING"} ${m}${models.includes(m) ? "" : `  -> ollama pull ${m}`}`);
  } catch (e) {
    console.log(`ollama:        FAILED (${(e as Error).message})`);
  }
  if (!cfg.cloudEnabled) console.log("claude:        disabled (local only)");
  else {
    const v = await sh(`${cfg.claudeBin} --version`, cfg.repo, 30);
    if (!v.ok) console.log(`claude:        NOT INSTALLED (${cfg.claudeBin})`);
    else {
      const source = process.env.CLAUDE_CODE_OAUTH_TOKEN ? "CLAUDE_CODE_OAUTH_TOKEN" : process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : "claude login (interactive)";
      try {
        const r = await claudeReachable(cfg);
        console.log(`claude:        ${v.output.trim()}, auth ok via ${source}, model ${cfg.models.cloud || "default"}, replied "${r.slice(0, 40)}"`);
      } catch (e) {
        console.log(`claude:        ${v.output.trim()}, FAILED via ${source}: ${(e as Error).message.slice(0, 300)}`);
        console.log(`               On a headless box: run 'claude setup-token' where you have a browser, then put CLAUDE_CODE_OAUTH_TOKEN=... in ~/.config/agentpipe/env`);
      }
    }
  }
  for (const [name, cmd] of [["bun", "bun --version"], ["node", "node --version"], ["rg", "command -v rg >/dev/null && rg --version | head -1"], ["podman", "podman --version"], ["git", "git --version"], ["gh", "command -v gh >/dev/null && gh --version | head -1"]]) {
    const r = await sh(cmd, cfg.repo, 30);
    console.log(`${(name + ":").padEnd(15)}${r.ok ? r.output.trim().split("\n")[0] : "MISSING"}`);
  }
  const ghAuth = await sh("gh auth status 2>&1 | head -2", cfg.repo, 30);
  console.log(`gh auth:       ${ghAuth.output.includes("Logged in") ? "ok" : "not logged in (pull requests will not be opened; run: gh auth login)"}`);
  const clean = await sh("git status --porcelain", cfg.repo, 30);
  console.log(`git tree:      ${clean.output.trim() ? "DIRTY (commit or stash first)" : "clean"} on ${(await sh("git rev-parse --abbrev-ref HEAD", cfg.repo, 30)).output.trim()}`);
  console.log(`git identity:  ${(await hasGitIdentity(cfg.repo)) ? (await sh("git config user.email", cfg.repo, 30)).output.trim() : "none (commits will use agentpipe@localhost; set with git config --global user.email ...)"}`);
  const g = loadGlobalConfig();
  console.log(`projects:      ${Object.keys(g.projects).length ? Object.entries(g.projects).map(([n, p]) => `${n} (${p.path}, base ${p.base}${p.push ? ", push" : ""})`).join("; ") : `none registered (${globalConfigPath()})`}`);
  const reg = loadRegistry();
  console.log(`agents:        ${[...reg.agents.keys()].join(", ")}`);
  for (const p of reg.problems) console.log(`  registry:    ${p}`);
  console.log(`queue db:      ${path.join(dataDir(), "agentpipe.db")}`);
  const lock = path.join(dataDir(), "worker.pid");
  console.log(`worker:        ${existsSync(lock) ? `pid file ${lock} (${readFileSync(lock, "utf8").trim()})` : "not running (systemctl --user start agentpipe-worker)"}`);
}

function parseBulk(file: string): { title: string; description: string; agent?: string; priority?: number; files?: string[]; acceptance?: string[] }[] {
  const text = readFileSync(file, "utf8");
  if (file.endsWith(".json")) {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new Error("bulk JSON must be an array");
    return arr.map((x: any) => ({ title: x.title ?? String(x.description).split("\n")[0].slice(0, 120), description: x.description ?? x.title, agent: x.agent, priority: x.priority, files: x.files, acceptance: x.acceptance }));
  }
  const out: { title: string; description: string; agent?: string }[] = [];
  for (const raw of text.split("\n")) {
    const m = raw.match(/^\s*[-*]\s+(?:\[([a-z0-9-]+)\]\s*)?(.+)$/);
    if (!m) {
      if (out.length && raw.startsWith("  ")) out[out.length - 1].description += "\n" + raw.trim();
      continue;
    }
    out.push({ title: m[2].slice(0, 120), description: m[2], agent: m[1] });
  }
  return out;
}

/** One line per project for `status` and `use`: current marker, state, progress, goal. */
function projectLine(g: GlobalConfig, name: string, store: Store): string {
  const p = g.projects[name];
  const c = store.counts(name);
  const state = p.pending?.length ? "held for approval" : projectStatus(p);
  const parts = [c.running && `${c.running} running`, c.queued && `${c.queued} queued`, c.attention + c.failed + c.blocked && `${c.attention + c.failed + c.blocked} need you`, `${c.done} done`].filter(Boolean);
  return `${currentProject(g) === name ? "*" : " "} ${name} [${state}${p.parent ? `, branch ${p.base} of ${p.parent}` : ""}] ${parts.join(", ")}${p.goal ? ` - ${p.goal.replace(/\s+/g, " ").slice(0, 80)}` : ""}`;
}

async function main() {
  // Helper scripts (agentpipe-e2e) and user tools live here even when a systemd unit gives us a bare PATH.
  process.env.PATH = [path.join(agentpipeRoot(), "scripts"), path.join(process.env.HOME ?? "", ".local", "bin"), process.env.PATH ?? ""].join(":");
  if (process.argv[2] === "shell-check") process.exit(await shellCheckMain(process.argv.slice(3)));
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const cmd = positional.shift();
  if (!cmd || flags.help) {
    console.log(USAGE);
    process.exit(cmd ? 0 : 1);
  }
  loadEnvFile();

  switch (cmd) {
    // ----- queue -----
    case "add": {
      const g = loadGlobalConfig();
      const { name: project } = resolveProject(g, str(flags.project));
      const store = new Store();
      const priority = flags.priority ? Number(flags.priority) : undefined;
      const after = str(flags.after)?.split(",").filter(Boolean).map(Number) ?? [];
      const files = str(flags.files)?.split(",").filter(Boolean) ?? [];
      const acceptance = str(flags.accept)?.split(/\s*;\s*/).map((a) => a.trim()).filter(Boolean) ?? [];
      const items = flags.file ? parseBulk(str(flags.file)!) : [{ title: str(flags.title) ?? positional.join(" ").split("\n")[0].slice(0, 120), description: positional.join(" ").trim() }];
      if (!items.length || items.some((i) => !i.description)) throw new Error("add needs a task description (or --file with tasks)");
      const notes = new Set<string>();
      for (const it of items) {
        const { task: t, notes: n } = addTask(store, g, {
          project,
          agent: (it as any).agent ?? str(flags.agent) ?? "architect",
          title: it.title,
          description: it.description,
          acceptance: (it as any).acceptance ?? acceptance,
          priority: (it as any).priority ?? priority,
          depends_on: after,
          files: (it as any).files ?? files,
          branch: str(flags.branch) ?? null,
          created_by: process.env.USER ?? "cli",
        });
        console.log(`#${t.id} queued for ${t.agent} in ${project}: ${t.title}`);
        for (const x of n) notes.add(x);
      }
      for (const n of notes) console.log(`note: ${n}`);
      const lock = path.join(dataDir(), "worker.pid");
      if (!existsSync(lock)) console.log("note: no worker is running. Start it: systemctl --user start agentpipe-worker   (or: agentpipe worker)");
      break;
    }
    case "use": {
      const g = loadGlobalConfig();
      const name = positional[0];
      if (!name) {
        const cur = currentProject(g);
        console.log(cur ? projectLine(g, cur, new Store()) : "no current project (agentpipe use NAME)");
        break;
      }
      const p = g.projects[name];
      if (!p) throw new Error(`unknown project "${name}"; known: ${Object.keys(g.projects).join(", ") || "(none)"}`);
      if (projectStatus(p) === "archived") throw new Error(`${name} is archived; agentpipe projects resume ${name} first`);
      updateGlobalConfig((c) => void (c.defaultProject = name));
      console.log(`now on ${projectLine(loadGlobalConfig(), name, new Store())}`);
      if (!isRunnable(p)) console.log(`note: ${name} is ${p.pending?.length ? "waiting for approval: agentpipe projects approve " + name : projectStatus(p) + ": agentpipe projects resume " + name}`);
      break;
    }
    case "status": {
      const g = loadGlobalConfig();
      const store = new Store();
      const all = flags.project === "all";
      const focus = all ? null : flags.project || process.env.AGENTPIPE_PROJECT ? resolveProject(g, str(flags.project)).name : currentProject(g);
      const listed = Object.keys(g.projects).filter((n) => all || projectStatus(g.projects[n]) !== "archived");
      if (!all) for (const n of listed) console.log(projectLine(g, n, store));
      const projects = all ? listed : focus ? [focus] : [];
      for (const p of projects) {
        const c = store.counts(p);
        console.log(`\n${p}: ${Object.entries(c).filter(([, n]) => n).map(([s, n]) => `${s} ${n}`).join(", ") || "empty"}`);
        const running = store.list({ project: p, status: ["running"] });
        for (const t of running) console.log(`  running:   #${t.id} [${t.agent}] ${t.title} (${fmtAge(t.started_at)})`);
        const next = store.list({ project: p, status: ["queued"], limit: 5 });
        for (const t of next) console.log(`  queued:    #${t.id} [${t.agent}] ${t.title}${t.depends_on.length ? ` after ${t.depends_on.map((d) => "#" + d).join(",")}` : ""}`);
        const attention = store.list({ project: p, status: ["attention", "failed", "blocked"] }).filter((t) => !t.triaged || t.status !== "attention" || !t.parent_id);
        for (const t of attention.slice(-10)) console.log(`  needs you: #${t.id} ${t.status} [${t.agent}] ${t.title}${t.pr_url ? ` ${t.pr_url}` : t.branch ? ` (${t.branch})` : ""}${t.error ? ` - ${t.error.split("\n")[0].slice(0, 100)}` : ""}`);
        const done = store.list({ project: p, status: ["done"] }).slice(-5);
        for (const t of done) console.log(`  done:      #${t.id} [${t.agent}] ${t.title}${t.pr_url ? ` ${t.pr_url}` : ""} (${fmtAge(t.finished_at)} ago)`);
      }
      const lock = path.join(dataDir(), "worker.pid");
      console.log(`\nworker: ${existsSync(lock) ? `running (pid ${readFileSync(lock, "utf8").trim()})` : "not running"}; lanes ${Object.entries(g.worker.lanes).map(([l, n]) => `${l}x${n}`).join(" ")}`);
      const today = store.spendToday();
      const week = store.spend(new Date(Date.now() - 7 * 86400_000).toISOString());
      console.log(`claude spend: $${today.toFixed(2)} today${g.budgets.dailyUsd ? ` of $${g.budgets.dailyUsd}` : ""}, $${week.total.toFixed(2)} last 7 days (${week.calls} calls)${g.budgets.taskUsd ? `; per-task cap $${g.budgets.taskUsd}` : ""}`);
      const d = latestDigest();
      if (d) console.log(`latest digest: ${d.file}`);
      break;
    }
    case "list":
    case "ls":
    case "queue": {
      const g = loadGlobalConfig();
      const store = new Store();
      const status = str(flags.status)?.split(",") as TaskStatus[] | undefined;
      const everywhere = flags.project === "all" || !Object.keys(g.projects).length;
      const project = everywhere ? undefined : resolveProject(g, str(flags.project)).name;
      let rows = store.list({ project, status });
      if (!status && !flags.all) rows = rows.filter((t) => !["done", "cancelled"].includes(t.status) || (Date.now() - Date.parse(t.finished_at ?? t.created_at)) < 86400_000);
      if (project) console.log(`${project}:`);
      table(
        rows.map((t) => [`#${t.id}`, ...(everywhere ? [t.project] : []), t.status, t.agent, t.parent_id ? `#${t.parent_id}` : "", String(t.priority), t.title.slice(0, 70), t.pr_url ?? (t.branch ?? ""), fmtAge(t.finished_at ?? t.started_at ?? t.created_at)]),
        ["id", ...(everywhere ? ["project"] : []), "status", "agent", "parent", "prio", "title", "pr/branch", "age"],
      );
      break;
    }
    case "show": {
      const store = new Store();
      const id = Number(positional[0]);
      const t = store.get(id);
      if (!t) throw new Error(`no task #${id}`);
      const { depends_on, files, description, summary, acceptance, confirmation, ...rest } = t;
      for (const [k, v] of Object.entries(rest)) if (v !== null && v !== "" && v !== 0) console.log(`${k.padEnd(12)} ${v}`);
      if (confirmation) {
        const c = confirmation.request;
        console.log(`\n--- confirmation (${confirmation.status}${confirmation.decided_by ? `, ${confirmation.decided_by}` : ""}) ---\n${c.title}\nwhy:  ${c.why}\nrisk: ${c.risk}`);
        c.steps.forEach((st, i) => console.log(`${i + 1}. ${st.kind === "command" ? `$ ${st.command}${st.cwd ? `   (in ${st.cwd})` : ""}` : `write ${st.path} (${(st.content ?? "").length} chars)`}\n   ${st.why}`));
        for (const l of c.links) console.log(`link: ${l}`);
        if (confirmation.status === "pending") console.log(`decide: agentpipe approve ${id}   |   agentpipe reject ${id} --reason "..."   (file contents: agentpipe show ${id} --full)`);
        if (flags.full) for (const st of c.steps) if (st.kind === "write") console.log(`\n===== ${st.path} =====\n${st.content}`);
        for (const l of confirmation.log) console.log(`log: ${l}`);
      }
      if (depends_on.length) console.log(`depends_on   ${depends_on.map((d) => "#" + d).join(", ")}`);
      if (acceptance.length) console.log(`acceptance   ${acceptance.map((a, i) => (i ? "\n             " : "") + "- " + a).join("")}`);
      if (files.length) console.log(`files        ${files.join(", ")}`);
      console.log(`\n--- description ---\n${description}`);
      if (summary) console.log(`\n--- summary ---\n${summary}`);
      const replies = store.replies(id);
      if (replies.length) {
        console.log("\n--- replies ---");
        for (const r of replies) console.log(`${r.ts.slice(0, 19)} ${r.author}: ${r.text}`);
      }
      const kids = store.children(id);
      if (kids.length) {
        console.log("\n--- children ---");
        for (const k of kids) console.log(`#${k.id} ${k.status} [${k.agent}] ${k.title}${k.pr_url ? ` ${k.pr_url}` : ""}`);
      }
      console.log("\n--- events ---");
      for (const e of store.events(id)) console.log(`${e.ts.slice(0, 19)} ${e.kind}: ${e.message}`);
      break;
    }
    case "cancel": {
      const id = Number(positional[0]);
      if (!Number.isInteger(id)) throw new Error('usage: agentpipe cancel ID [--reason "why"]');
      const r = cancelTask(new Store(), id, process.env.USER ?? "cli", str(flags.reason) ?? positional.slice(1).join(" "));
      console.log(`#${id} cancelled${r.task.error ? `: ${r.task.error}` : ""}`);
      if (r.note) console.log(`note: ${r.note}`);
      break;
    }
    case "retry": {
      const id = Number(positional[0]);
      if (!Number.isInteger(id)) throw new Error("usage: agentpipe retry ID");
      const t = retryTask(new Store(), id, process.env.USER ?? "cli");
      console.log(`#${id} ${t.status === "queued" ? "requeued" : t.status}`);
      break;
    }
    case "approve": {
      const id = Number(positional[0]);
      if (!Number.isInteger(id)) throw new Error("usage: agentpipe approve ID");
      const store = new Store();
      const t = store.get(id);
      if (!t?.confirmation) throw new Error(`#${id} has no confirmation request`);
      console.log(`${t.confirmation.request.title}\n${t.confirmation.request.steps.length} step(s) run as ${process.env.USER ?? "you"}...`);
      const r = await approveTask(store, loadGlobalConfig(), id, process.env.USER ?? "cli");
      for (const l of r.log) console.log(`  ${l}`);
      console.log(`#${id} -> ${r.task.status}${r.ok ? "" : " (a step failed; see agentpipe show " + id + ")"}`);
      process.exitCode = r.ok ? 0 : 2;
      break;
    }
    case "reject": {
      const id = Number(positional[0]);
      if (!Number.isInteger(id)) throw new Error('usage: agentpipe reject ID [--reason "why"]');
      const r = rejectTask(new Store(), id, process.env.USER ?? "cli", str(flags.reason) ?? positional.slice(1).join(" "));
      console.log(`#${id} rejected and cancelled: ${r.task.error}`);
      break;
    }
    case "upgrade": {
      const store = new Store();
      if (flags.check) {
        const u = await checkForUpdate({ maxAgeMs: 0 });
        if (u.error) throw new Error(`cannot check: ${u.error}`);
        console.log(u.available ? `update available: ${u.behind} commit(s) behind origin/${u.branch} (${u.local} -> ${u.remote})${u.dirty ? "; checkout has local changes" : ""}\n${u.commits.map((c) => "  " + c).join("\n")}` : `up to date at ${u.local} on ${u.branch}${u.ahead ? ` (${u.ahead} local commit(s) not pushed)` : ""}`);
        process.exitCode = u.available ? 2 : 0;
        break;
      }
      const r = await runUpgrade(store, { force: Boolean(flags.force), restart: flags["no-restart"] ? "none" : "now" });
      for (const l of r.lines) console.log(l);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case "reply": {
      const id = Number(positional.shift());
      if (!Number.isInteger(id)) throw new Error('usage: agentpipe reply ID "your answer" [--no-requeue]   (or pipe the text on stdin)');
      let text = positional.join(" ").trim();
      if (!text && !process.stdin.isTTY) text = (await Bun.stdin.text()).trim();
      if (!text) throw new Error("reply needs some text: what should the agent know or do?");
      const r = replyToTask(new Store(), id, text, process.env.USER ?? "cli", { requeue: !flags["no-requeue"] });
      console.log(r.note);
      const lock = path.join(dataDir(), "worker.pid");
      if (r.requeued && !existsSync(lock)) console.log("note: no worker is running. Start it: systemctl --user start agentpipe-worker   (or: agentpipe worker)");
      break;
    }
    case "edit": {
      const id = Number(positional.shift());
      if (!Number.isInteger(id)) throw new Error('usage: agentpipe edit ID [--title T] [--description TEXT | --desc-file F] [--accept "a;b"] [--agent NAME] [--priority N] [--files a,b]');
      const store = new Store();
      const before = store.get(id);
      if (!before) throw new Error(`no task #${id}`);
      let description = str(flags.description) ?? (positional.length ? positional.join(" ") : undefined);
      if (flags["desc-file"]) description = readFileSync(str(flags["desc-file"])!, "utf8");
      if (description === undefined && !flags.title && !flags.accept && !flags.agent && !flags.priority && !flags.files && !process.stdin.isTTY) description = (await Bun.stdin.text()).trim() || undefined;
      const edits = store.events(id).filter((e) => e.kind === "edited").length;
      editTask(store, loadGlobalConfig(), id, {
        title: str(flags.title) ?? null,
        description: description ?? null,
        acceptance: str(flags.accept) !== undefined ? str(flags.accept)!.split(/\s*;\s*/) : null,
        agent: str(flags.agent) ?? null,
        priority: flags.priority ? Number(flags.priority) : null,
        files: str(flags.files) !== undefined ? str(flags.files)!.split(",") : null,
      }, process.env.USER ?? "cli");
      const after = store.events(id).filter((e) => e.kind === "edited");
      console.log(after.length > edits ? `#${id} edited ${after[after.length - 1].message}` : `#${id} unchanged (nothing differed)`);
      break;
    }
    case "prio": {
      const store = new Store();
      const id = Number(positional[0]);
      const n = Number(positional[1]);
      if (!store.get(id) || !Number.isFinite(n)) throw new Error("usage: agentpipe prio ID N");
      store.update(id, { priority: n });
      console.log(`#${id} priority ${n}`);
      break;
    }
    case "worker": {
      const g = loadGlobalConfig();
      if (!Object.keys(g.projects).length) throw new Error(`no projects registered in ${globalConfigPath()}; run: agentpipe projects add NAME PATH`);
      await runWorker(new Store(), g, { once: Boolean(flags.once), project: str(flags.project) });
      break;
    }
    case "architect": {
      const sub = positional.shift() ?? "review";
      if (sub !== "review") throw new Error("usage: agentpipe architect review [--project P] [--dry-run]");
      const g = loadGlobalConfig();
      const file = await architectReview(new Store(), g, { project: str(flags.project), dryRun: Boolean(flags["dry-run"]) });
      if (file) console.log(readFileSync(file, "utf8"));
      break;
    }
    case "web": {
      const g = loadGlobalConfig();
      await runWeb(new Store(), g, {
        port: Number(str(flags.port) ?? process.env.AGENTPIPE_WEB_PORT ?? 8081),
        tlsPort: Number(str(flags["tls-port"]) ?? process.env.AGENTPIPE_WEB_TLS_PORT ?? 8443),
        host: str(flags.host) ?? "0.0.0.0",
        ollamaUrl: process.env.OLLAMA_URL ?? "http://127.0.0.1:11434",
        webuiUrl: str(flags.webui) ?? process.env.AGENTPIPE_WEBUI_URL ?? "http://127.0.0.1:8080/",
      });
      break;
    }
    case "spend": {
      const store = new Store();
      const days = Number(str(flags.days) ?? 7);
      const since = new Date(Date.now() - days * 86400_000).toISOString();
      const s7 = store.spend(since);
      console.log(`last ${days} days: $${s7.total.toFixed(2)} over ${s7.calls} Claude calls; today $${store.spendToday().toFixed(2)}`);
      const byDay = store.db.query("SELECT substr(ts,1,10) AS day, SUM(cost_usd) AS usd, COUNT(*) AS n FROM usage WHERE ts >= ? GROUP BY day ORDER BY day DESC").all(since) as { day: string; usd: number; n: number }[];
      table(byDay.map((r) => [r.day, `$${r.usd.toFixed(2)}`, String(r.n)]), ["day", "usd", "calls"]);
      console.log();
      table(Object.entries(s7.byAgent).sort((a, b) => b[1] - a[1]).map(([a, u]) => [a, `$${u.toFixed(2)}`]), ["agent", "usd"]);
      console.log();
      table(Object.entries(s7.byProject).sort((a, b) => b[1] - a[1]).map(([a, u]) => [a, `$${u.toFixed(2)}`]), ["project", "usd"]);
      break;
    }
    case "digest": {
      const d = latestDigest();
      console.log(d ? d.text : "no digest yet (the architect has not reviewed anything)");
      break;
    }

    // ----- registry -----
    case "agents": {
      const sub = positional.shift();
      const g = loadGlobalConfig();
      let project;
      try {
        project = resolveProject(g, str(flags.project)).project;
      } catch {
        project = undefined;
      }
      const reg = loadRegistry(project);
      if (!sub || sub === "list") {
        table(
          [...reg.agents.values()].map((a) => [a.name, a.runtime, a.lane, a.commits ? "yes" : "", a.can_delegate ? "yes" : "", a.shell.join(",") || "-", a.verifier ? a.verifier.kind : "", a.hasTests ? "yes" : "", a.description.slice(0, 60)]),
          ["name", "runtime", "lane", "commits", "delegates", "shell", "verify", "tests", "description"],
        );
        console.log(`\ndirs: ${reg.dirs.join(", ")}`);
        for (const p of reg.problems) console.log(`problem: ${p}`);
      } else if (sub === "show") {
        const a = requireAgent(reg, positional[0] ?? "");
        const { prompt, verifier, extras, ...rest } = a;
        console.log(JSON.stringify(rest, null, 2));
        console.log(`\nverifier: ${verifier ? (verifier.kind === "script" ? verifier.path : `command: ${verifier.command}`) : "none"}`);
        if (extras.length) console.log(`extra files: ${extras.join(", ")}`);
        if (prompt) console.log(`\n--- prompt ---\n${prompt}`);
      } else if (sub === "new") {
        const name = positional[0];
        if (!name) throw new Error("usage: agentpipe agents new NAME [--runtime claude|ollama|pipeline|shell] [--dir DIR] [--from PROPOSAL_ID]");
        let from: AgentProposal | undefined;
        let store: Store | undefined;
        if (flags.from) {
          store = new Store();
          const row = store.proposal(Number(flags.from));
          if (!row) throw new Error(`no agent proposal #${flags.from} (agentpipe agents proposals --all)`);
          from = AgentProposal.parse(JSON.parse(row.spec));
          if (from.name !== name) console.log(`note: proposal #${row.id} was for "${from.name}"; creating "${name}" from it`);
        }
        const files = scaffoldAgent(name, Runtime.parse(str(flags.runtime) ?? from?.runtime ?? "claude"), str(flags.dir) ? path.resolve(str(flags.dir)!) : undefined, from);
        if (store && flags.from) store.setProposalStatus(Number(flags.from), "created");
        console.log(`created:\n${files.map((f) => "  " + f).join("\n")}\n${from ? "The manifest is filled in from the proposal; the prompt is yours to write. " : ""}Edit them, then 'agentpipe agents' should list ${name} and 'agentpipe agents test ${name}' should pass.`);
      } else if (sub === "proposals") {
        const store = new Store();
        const rows = store.proposals(flags.all ? undefined : "open").map(viewProposal);
        if (!rows.length) {
          console.log(flags.all ? "no agent proposals recorded" : "no open agent proposals (--all shows dismissed and created ones)");
          break;
        }
        for (const r of rows) {
          const p = r.proposal;
          console.log(`#${r.id} ${p.name} (${p.runtime}${p.commits ? ", commits" : ""}${p.shell.length ? `, shell: ${p.shell.join(",")}` : ""}) [${r.status}${r.times > 1 ? `, asked ${r.times}x` : ""}] proposed ${fmtAge(r.ts)} ago by ${r.proposed_by}${r.task_id ? ` for #${r.task_id}` : ""}${r.project ? ` in ${r.project}` : ""}`);
          console.log(`   ${p.description}`);
          console.log(`   why: ${p.why}`);
          if (p.inputs) console.log(`   inputs: ${p.inputs}`);
          if (p.outputs) console.log(`   outputs: ${p.outputs}`);
          if (r.status === "open") console.log(`   create it: agentpipe agents new ${p.name} --from ${r.id}`);
        }
      } else if (sub === "dismiss") {
        const id = Number(positional[0]);
        if (!Number.isInteger(id)) throw new Error("usage: agentpipe agents dismiss PROPOSAL_ID");
        const r = new Store().setProposalStatus(id, "dismissed");
        console.log(`proposal #${id} (${r.name}) dismissed`);
      } else if (sub === "test") {
        const name = positional[0];
        const targets = name ? [requireAgent(reg, name)] : [...reg.agents.values()];
        const dirs = targets.filter((a) => a.dir && a.hasTests).map((a) => path.join(a.dir!, "tests"));
        const skipped = targets.filter((a) => !a.dir || !a.hasTests).map((a) => a.name);
        if (skipped.length) console.log(`no tests: ${skipped.join(", ")}`);
        if (!dirs.length) break;
        const proc = Bun.spawn(["bun", "test", ...dirs], { cwd: agentpipeRoot(), stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, ...(flags.e2e ? { AGENTPIPE_E2E: "1" } : {}) } });
        process.exitCode = await proc.exited;
      } else throw new Error("usage: agentpipe agents [list|show NAME|new NAME [--from ID]|test [NAME]|proposals [--all]|dismiss ID]");
      break;
    }

    // ----- projects -----
    case "stream":
    case "streams":
    case "projects": {
      const sub = positional.shift();
      const g = loadGlobalConfig();
      if (!sub || sub === "list") {
        const store = new Store();
        const cur = currentProject(g);
        table(
          Object.entries(g.projects)
            .filter(([, p]) => flags.all || projectStatus(p) !== "archived")
            .map(([n, p]) => {
              const c = store.counts(n);
              return [n + (cur === n ? " *" : ""), p.pending?.length ? "held" : projectStatus(p), p.parent ? `${p.parent}:${p.base}` : p.base, p.path, p.push ? "yes" : "no", `${store.openCount(n)} open, ${c.done} done${c.attention + c.failed ? `, ${c.attention + c.failed} need you` : ""}`, (p.goal ?? "").replace(/\s+/g, " ").slice(0, 60)];
            }),
          ["name", "status", "branch", "path", "push", "progress", "goal"],
        );
        console.log(`\n* = current (agentpipe use NAME). ${flags.all ? "" : "Archived projects hidden (--all). "}config: ${globalConfigPath()}`);
      } else if (sub === "add") {
        const [name, p] = positional;
        if (!name || !p) throw new Error("usage: agentpipe projects add NAME PATH [--base main] [--push] [--default] [--goal TEXT] [--link a,b] [--setup CMD] [--agents-dir DIR]");
        if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error("project names are kebab-case");
        const abs = path.resolve(str(p) ?? p);
        if (!existsSync(path.join(abs, ".git"))) throw new Error(`${abs} is not a git checkout`);
        const prev = g.projects[name];
        g.projects[name] = {
          ...prev,
          path: abs,
          base: str(flags.base) ?? prev?.base ?? "main",
          push: flags.push ? true : prev?.push ?? false,
          ...(str(flags["agents-dir"]) ? { agentsDir: str(flags["agents-dir"]) } : {}),
          ...(str(flags.link) ? { link: str(flags.link)!.split(",").filter(Boolean) } : {}),
          ...(str(flags.setup) ? { setup: str(flags.setup) } : {}),
          ...(str(flags.goal) ? { goal: str(flags.goal) } : {}),
          ...(prev ? {} : { created: new Date().toISOString() }),
        };
        if (flags.default || !g.defaultProject) g.defaultProject = name;
        console.log(`saved ${saveGlobalConfig(g)}`);
        console.log(`${name}: ${abs} (base ${g.projects[name].base}${g.projects[name].push ? ", push" : ""}); stack: ${repoStack(abs)}`);
        if (!existsSync(path.join(abs, "agentpipe.json"))) console.log(`note: no agentpipe.json in the repo; the pipeline will use defaults (bun run lint / bun run test:unit). Copy agentpipe.example.json and adjust the commands if this project differs, or queue: agentpipe add --project ${name} --agent project-setup "Set up agentpipe"`);
        if (!existsSync(path.join(abs, "AGENTPIPE.md"))) console.log(`tip: an AGENTPIPE.md at the repo root is read by every agent: conventions, forbidden areas, how to run things.`);
      } else if (sub === "create") {
        const name = positional[0];
        if (!name || !str(flags.goal)) throw new Error('usage: agentpipe projects create NAME --goal "what it is for" (--path DIR | --clone URL | --new [--github owner/name] | --branch-of PARENT [--branch B])');
        const kind = flags["branch-of"] ? "branch" : flags.clone ? "clone" : flags.new ? "new" : "existing";
        const spec = ProjectSpec.parse({
          name,
          goal: str(flags.goal) ?? "",
          kind,
          path: str(flags.path),
          repo: str(flags.clone) ?? str(flags.github),
          parent: str(flags["branch-of"]),
          branch: str(flags.branch),
          base: str(flags.base),
          push: flags.push ? true : flags["no-push"] ? false : undefined,
          setup: str(flags.setup),
          link: str(flags.link)?.split(",").filter(Boolean),
          kickoff: str(flags.kickoff),
          make_current: Boolean(flags.use),
        });
        if (kind === "existing" && !spec.path) throw new Error("say where the project comes from: --path DIR (existing checkout), --clone URL, --new, or --branch-of PARENT");
        // A human running this approves the GitHub steps by running it.
        const created = await createProject(spec, { allowRemote: true });
        for (const n of created.notes) console.log(n);
        for (const t of queueStreamStart(new Store(), created, spec, process.env.USER ?? "cli")) console.log(`#${t.id} queued for ${t.agent} in ${created.name}: ${t.title}`);
      } else if (sub === "new") {
        const name = positional.shift();
        const what = positional.join(" ").trim();
        if (!name || !what) throw new Error('usage: agentpipe projects new NAME "what the stream is for, where it lives, what to do first"');
        if (g.projects[name]) throw new Error(`project "${name}" already exists`);
        const { name: home, project } = resolveProject(g, str(flags.project));
        requireAgent(loadRegistry(project), "architect");
        const t = new Store().add({
          project: home,
          agent: "architect",
          title: `Create project ${name}`,
          description: `Create and configure a new project (stream of work) named "${name}". Return it in "projects"; do not plan work for it as subtasks here.${flags.use ? " Make it the current project." : ""}\n\nThe human's description:\n${what}`,
          priority: 10,
          created_by: process.env.USER ?? "cli",
        });
        console.log(`#${t.id} queued for the architect (in ${home}): ${t.title}`);
        console.log("It creates the project on disk; anything on GitHub waits for: agentpipe projects approve " + name);
      } else if (["pause", "resume", "archive"].includes(sub)) {
        const name = positional[0];
        if (!name || !g.projects[name]) throw new Error(`usage: agentpipe projects ${sub} NAME (known: ${Object.keys(g.projects).join(", ")})`);
        const status: ProjectStatus = sub === "pause" ? "paused" : sub === "archive" ? "archived" : "active";
        updateGlobalConfig((c) => {
          if (status === "active") delete c.projects[name].status;
          else c.projects[name].status = status;
          if (status === "archived" && c.defaultProject === name) c.defaultProject = Object.keys(c.projects).find((n) => n !== name && projectStatus(c.projects[n]) === "active") ?? null;
        });
        const after = loadGlobalConfig();
        console.log(`${name}: ${status}${status === "archived" && g.defaultProject === name ? `; current project is now ${after.defaultProject ?? "(none)"}` : ""}`);
        const open = new Store().openCount(name);
        if (status !== "active" && open) console.log(`${open} open task(s) stay in the queue and wait; a running task finishes first`);
      } else if (sub === "approve") {
        const name = positional[0];
        if (!name) throw new Error("usage: agentpipe projects approve NAME");
        for (const line of await approvePending(name, new Store())) console.log(line);
      } else if (sub === "upstream" || sub === "upstreams") {
        const verb = positional.shift() ?? "list";
        const { name: pname, project } = resolveProject(g, str(flags.project));
        if (verb === "list") {
          const rows = listUpstreams(project);
          console.log(rows.length ? `${pname} (${project.path}/upstream/):\n${rows.map((r) => "  " + r).join("\n")}` : `${pname} has no upstream repositories (agentpipe projects upstream add owner/repo)`);
        } else if (verb === "add") {
          const repo = positional[0];
          if (!repo) throw new Error("usage: agentpipe projects upstream add owner/repo|URL [--name N] [--ref BRANCH] [--project P]");
          const r = await addUpstream(pname, { repo, name: str(flags.name), ref: str(flags.ref) });
          console.log(`${pname}: ${r.note}\n  ${r.path}`);
        } else if (verb === "update") {
          const n = positional[0];
          if (!n) throw new Error("usage: agentpipe projects upstream update NAME [--ref BRANCH] [--project P]");
          console.log(`${pname}: ${(await updateUpstream(pname, n, str(flags.ref))).note}`);
        } else if (verb === "remove") {
          const n = positional[0];
          if (!n) throw new Error("usage: agentpipe projects upstream remove NAME [--project P]");
          console.log(removeUpstream(pname, n));
        } else throw new Error("usage: agentpipe projects upstream [list|add REPO|update NAME|remove NAME]");
      } else if (sub === "budget") {
        const name = positional[0];
        if (!name || !g.projects[name] || flags["daily-usd"] === undefined) throw new Error(`usage: agentpipe projects budget NAME --daily-usd N (known: ${Object.keys(g.projects).join(", ")})`);
        const usd = Number(flags["daily-usd"]);
        if (!Number.isFinite(usd) || usd < 0) throw new Error("--daily-usd must be a number of dollars (0 = only the global cap)");
        updateGlobalConfig((c) => {
          if (usd) c.projects[name].dailyUsd = usd;
          else delete c.projects[name].dailyUsd;
        });
        console.log(`${name}: daily Claude cap ${usd ? "$" + usd : "none (global cap only)"}; spent today ${new Store().spendToday(name).toFixed(2)}`);
      } else if (sub === "finish") {
        const name = positional[0];
        if (!name) throw new Error("usage: agentpipe projects finish NAME");
        console.log(await finishStream(name));
        console.log(`after it is merged: agentpipe projects archive ${name}`);
      } else if (sub === "remove") {
        const name = positional[0];
        if (!name || !g.projects[name]) throw new Error(`usage: agentpipe projects remove NAME (known: ${Object.keys(g.projects).join(", ")})`);
        delete g.projects[name];
        if (g.defaultProject === name) g.defaultProject = Object.keys(g.projects)[0] ?? null;
        console.log(`removed ${name} from ${saveGlobalConfig(g)} (its tasks stay in the queue history)`);
      } else throw new Error("usage: agentpipe projects [list|new|create|add|pause|resume|archive|approve|upstream|budget|finish|remove] ...");
      break;
    }

    // ----- one-off pipeline -----
    case "doctor":
    case "plan":
    case "resume":
    case "run": {
      const overrides: Partial<Config> = {};
      if (flags["local-only"]) overrides.cloudEnabled = false;
      if (flags["no-e2e"]) overrides.runE2e = false;
      if (flags["no-final-review"]) overrides.cloudFinalReview = false;
      if (flags.push) overrides.push = true;
      const cfg = loadConfig(str(flags.repo) ?? process.cwd(), overrides);
      if (cmd === "doctor") await doctor(cfg);
      else if (cmd === "plan") {
        const task = positional.join(" ").trim();
        if (!task) throw new Error("plan needs a task description");
        const r = await runPipeline(cfg, task, { planOnly: true });
        console.log(`\nplan written to ${path.join(r.runDir, "plan.json")}. Edit it, then: agentpipe resume ${path.join(r.runDir, "plan.json")}`);
      } else if (cmd === "resume") {
        const planPath = positional[0];
        if (!planPath) throw new Error("resume needs a plan.json path");
        const plan = Plan.parse(JSON.parse(readFileSync(planPath, "utf8")));
        const r = await runPipeline(cfg, plan.summary, { plan });
        process.exitCode = r.ok ? 0 : 2;
      } else {
        const task = positional.join(" ").trim();
        if (!task) throw new Error("run needs a task description");
        const r = await runPipeline(cfg, task);
        console.log(`\n${r.ok ? "OK" : "NEEDS ATTENTION"}: branch ${r.branch}, report ${path.join(r.runDir, "report.md")}${r.pushed ? `\n${r.pushed}` : ""}`);
        process.exitCode = r.ok ? 0 : 2;
      }
      break;
    }
    default:
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`\nerror: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
