import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { loadGlobalConfig, updateGlobalConfig, type ProjectConfig, type UpstreamConfig } from "./global.ts";
import { ensureIgnored } from "./repo.ts";
import type { UpstreamSpec } from "./result.ts";
import { log, sh } from "./util.ts";

/**
 * Upstream repositories: read-only copies of other repositories kept inside a project's checkout.
 *
 *   <checkout>/upstream/<name>/     a clone (shallow by default), excluded from git
 *   <worktree>/upstream -> <checkout>/upstream   symlinked by the worker like node_modules
 *
 * Why inside the checkout: every tool an agent has (Read, Grep, Glob, `ls`, `cat`, `find`,
 * `git -C upstream/<name> log`) works on paths inside the checkout and refuses paths outside it.
 * A cache under ~/.cache put the files exactly where no agent could operate on them. Fetching is
 * a read, so code does it at once (no confirmation round); the commit it landed on is recorded in
 * the project config and rendered into every prompt, so agents pin to it without re-deriving it.
 */
export const UPSTREAM_DIR = "upstream";

export function upstreamRoot(project: Pick<ProjectConfig, "path">): string {
  return path.join(project.path, UPSTREAM_DIR);
}

export function upstreamPath(project: Pick<ProjectConfig, "path">, name: string): string {
  return path.join(upstreamRoot(project), name);
}

/** `owner/TabletopTemplate` or a URL ending in `/TabletopTemplate.git` -> `tabletop-template`. */
export function upstreamName(repo: string): string {
  const last = repo.replace(/\.git$/, "").replace(/\/+$/, "").split(/[/:]/).pop() ?? repo;
  return last
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "upstream";
}

const OWNER_NAME = /^[\w.-]+\/[\w.-]+$/;

/** How to clone: `gh` when the repo is owner/name and gh is logged in (private repositories work), else git with a URL. */
async function cloneCommand(repo: string, ref: string | undefined, dest: string, cwd: string): Promise<string> {
  const branch = ref ? ` --branch ${JSON.stringify(ref)}` : "";
  if (OWNER_NAME.test(repo) && (await sh("gh auth status", cwd, 30)).ok) return `gh repo clone ${JSON.stringify(repo)} ${JSON.stringify(dest)} -- --depth 1${branch}`;
  const url = OWNER_NAME.test(repo) ? `https://github.com/${repo}.git` : repo;
  return `git clone -q --depth 1${branch} ${JSON.stringify(url)} ${JSON.stringify(dest)}`;
}

export interface UpstreamResult {
  name: string;
  path: string;
  sha: string;
  ref: string;
  /** What happened, one line for logs and summaries. */
  note: string;
}

async function headOf(dir: string): Promise<{ sha: string; ref: string }> {
  const sha = (await sh("git rev-parse HEAD", dir, 30)).output.trim();
  const ref = (await sh("git rev-parse --abbrev-ref HEAD", dir, 30)).output.trim();
  return { sha, ref: ref === "HEAD" ? "" : ref };
}

/**
 * Fetch a repository into `<checkout>/upstream/<name>/` and record it on the project. An existing
 * copy of the same repository is updated instead of cloned again; a different repository under the
 * same name is refused.
 */
export async function addUpstream(projectName: string, spec: UpstreamSpec): Promise<UpstreamResult> {
  const g = loadGlobalConfig();
  const project = g.projects[projectName];
  if (!project) throw new Error(`unknown project "${projectName}"`);
  const name = spec.name ?? upstreamName(spec.repo);
  const have = project.upstreams?.[name];
  if (have && have.repo !== spec.repo) throw new Error(`upstream "${name}" of ${projectName} is ${have.repo}, not ${spec.repo}; pick another name`);
  const dest = upstreamPath(project, name);
  if (existsSync(path.join(dest, ".git"))) return updateUpstream(projectName, name, spec.ref);
  if (existsSync(dest)) throw new Error(`${dest} exists but is not a git clone; remove it first`);
  mkdirSync(upstreamRoot(project), { recursive: true });
  const cmd = await cloneCommand(spec.repo, spec.ref, dest, project.path);
  log(`upstreams: ${projectName}: ${cmd}`);
  const r = await sh(cmd, project.path, 900);
  if (!r.ok) {
    rmSync(dest, { recursive: true, force: true });
    throw new Error(`could not fetch ${spec.repo}: ${r.output.trim().split("\n").slice(-3).join(" ").slice(0, 400)}`);
  }
  const { sha, ref } = await headOf(dest);
  await ensureIgnored(project.path, [UPSTREAM_DIR]);
  const entry: UpstreamConfig = { repo: spec.repo, ...(spec.ref ? { ref: spec.ref } : {}), sha, fetched: new Date().toISOString() };
  updateGlobalConfig((cfg) => {
    const p = cfg.projects[projectName];
    if (!p) throw new Error(`project "${projectName}" disappeared`);
    p.upstreams = { ...(p.upstreams ?? {}), [name]: entry };
  });
  return { name, path: dest, sha, ref: spec.ref ?? ref, note: `fetched ${spec.repo}${spec.ref ? ` (${spec.ref})` : ""} into ${UPSTREAM_DIR}/${name} at ${sha.slice(0, 12)}` };
}

/** Bring an upstream copy to the tip of its ref (or a new ref) and re-record the commit. */
export async function updateUpstream(projectName: string, name: string, ref?: string): Promise<UpstreamResult> {
  const g = loadGlobalConfig();
  const project = g.projects[projectName];
  if (!project) throw new Error(`unknown project "${projectName}"`);
  const have = project.upstreams?.[name];
  if (!have) throw new Error(`${projectName} has no upstream "${name}" (${Object.keys(project.upstreams ?? {}).join(", ") || "none"})`);
  const dest = upstreamPath(project, name);
  if (!existsSync(path.join(dest, ".git"))) throw new Error(`${dest} is missing; remove the upstream and add it again`);
  const target = ref ?? have.ref;
  const fetch = await sh(target ? `git fetch -q --depth 1 origin ${JSON.stringify(target)} && git checkout -q --detach FETCH_HEAD` : "git fetch -q --depth 1 origin && git checkout -q --detach FETCH_HEAD", dest, 600);
  if (!fetch.ok) throw new Error(`could not update ${name}: ${fetch.output.trim().slice(0, 300)}`);
  const { sha } = await headOf(dest);
  updateGlobalConfig((cfg) => {
    const p = cfg.projects[projectName]?.upstreams?.[name];
    if (!p) return;
    p.sha = sha;
    p.fetched = new Date().toISOString();
    if (ref) p.ref = ref;
  });
  return { name, path: dest, sha, ref: target ?? "", note: `updated ${UPSTREAM_DIR}/${name} (${have.repo}) to ${sha.slice(0, 12)}` };
}

/** Delete the copy and forget it. */
export function removeUpstream(projectName: string, name: string): string {
  const g = loadGlobalConfig();
  const project = g.projects[projectName];
  if (!project) throw new Error(`unknown project "${projectName}"`);
  if (!project.upstreams?.[name]) throw new Error(`${projectName} has no upstream "${name}"`);
  rmSync(upstreamPath(project, name), { recursive: true, force: true });
  updateGlobalConfig((cfg) => {
    const p = cfg.projects[projectName];
    if (!p?.upstreams) return;
    delete p.upstreams[name];
    if (!Object.keys(p.upstreams).length) delete p.upstreams;
  });
  return `removed ${UPSTREAM_DIR}/${name} from ${projectName}`;
}

/** The paragraph every prompt in a project with upstreams carries. Empty when there are none. */
export function renderUpstreams(project: Pick<ProjectConfig, "path" | "upstreams">): string {
  const entries = Object.entries(project.upstreams ?? {});
  if (!entries.length) return "";
  const lines = [
    "## Upstream repositories (read-only copies inside this checkout)",
    "These directories are other repositories, fetched for you to read: templates to copy from, references to consult. They are not part of this project's git history and must not be edited. Read them with your file tools or `ls`/`cat`/`find`; `git -C upstream/<name> log` shows their history. Pin to the commit shown when you record provenance. Copying files from one into the project is the upstream-importer agent's job.",
  ];
  for (const [name, u] of entries) lines.push(`- ${UPSTREAM_DIR}/${name}/: ${u.repo}${u.ref ? ` (${u.ref})` : ""} at commit ${u.sha ?? "unknown"}${u.fetched ? `, fetched ${u.fetched.slice(0, 10)}` : ""}`);
  return lines.join("\n");
}

/** `agentpipe projects upstream list`: one line per copy. */
export function listUpstreams(project: ProjectConfig): string[] {
  return Object.entries(project.upstreams ?? {}).map(([n, u]) => `${n}: ${u.repo}${u.ref ? ` (${u.ref})` : ""} @ ${u.sha?.slice(0, 12) ?? "?"}${u.fetched ? ` fetched ${u.fetched.slice(0, 16).replace("T", " ")}` : ""}${existsSync(upstreamPath(project, n)) ? "" : "  (MISSING on disk)"}`);
}
