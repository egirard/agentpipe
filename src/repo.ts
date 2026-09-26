import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sh } from "./util.ts";

/** Resolve a model-supplied path inside the repo root, refusing anything that escapes it. */
export function safePath(root: string, rel: string): string {
  const target = path.resolve(root, rel);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Error(`path escapes the repository: ${rel}`);
  }
  if (relative.startsWith(".git" + path.sep) || relative === ".git") {
    throw new Error(`refusing to touch .git: ${rel}`);
  }
  return target;
}

export async function git(root: string, args: string): Promise<string> {
  const r = await sh(`git ${args}`, root, 120);
  if (!r.ok) throw new Error(`git ${args} failed:\n${r.output}`);
  return r.output.trim();
}

export async function listFiles(root: string, dir = "."): Promise<string[]> {
  const out = await git(root, `ls-files --cached --others --exclude-standard -- ${JSON.stringify(dir)}`);
  return out ? out.split("\n").filter(Boolean) : [];
}

export function readFile(root: string, rel: string): string {
  return readFileSync(safePath(root, rel), "utf8");
}

export function fileExists(root: string, rel: string): boolean {
  return existsSync(safePath(root, rel));
}

export function writeFile(root: string, rel: string, content: string): void {
  const p = safePath(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export async function grep(root: string, pattern: string, glob?: string, maxLines = 200): Promise<string> {
  const g = glob ? `-g ${JSON.stringify(glob)}` : "";
  const r = await sh(`rg -n --no-heading -S ${g} -e ${JSON.stringify(pattern)} . | head -n ${maxLines}`, root, 60);
  return r.output.trim() || "(no matches)";
}

/** A compact tree the planner can read: directories and file counts, plus every file under src/ and e2e/ at depth 1. */
export async function repoOverview(root: string): Promise<string> {
  const files = await listFiles(root);
  const byDir = new Map<string, number>();
  for (const f of files) {
    const d = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ".";
    byDir.set(d, (byDir.get(d) ?? 0) + 1);
  }
  const lines: string[] = [];
  for (const [d, n] of [...byDir.entries()].sort()) {
    const depth = d === "." ? 0 : d.split("/").length;
    if (depth <= 2) lines.push(`${d}/ (${n} files)`);
  }
  return lines.join("\n");
}

export async function currentBranch(root: string): Promise<string> {
  return git(root, "rev-parse --abbrev-ref HEAD");
}

export async function ensureClean(root: string): Promise<void> {
  const status = await git(root, "status --porcelain");
  if (status) throw new Error(`repository has uncommitted changes; commit or stash them first:\n${status}`);
}

/** Create `name`, or `name-2`, `name-3`, ... if it already exists. Returns the branch actually created. */
export async function createBranch(root: string, name: string): Promise<string> {
  const existing = (await git(root, "branch --list --format='%(refname:short)'")).split("\n");
  let candidate = name;
  for (let i = 2; existing.includes(candidate); i++) candidate = `${name}-${i}`;
  await git(root, `checkout -b ${JSON.stringify(candidate)}`);
  return candidate;
}

/** Commits need an author; fall back to a pipeline identity when the box has none configured. */
async function identityArgs(root: string): Promise<string> {
  const r = await sh("git config user.email", root, 30);
  return r.output.trim() ? "" : "-c user.name=agentpipe -c user.email=agentpipe@localhost ";
}

export async function hasGitIdentity(root: string): Promise<boolean> {
  return (await identityArgs(root)) === "";
}

export async function commitAll(root: string, message: string): Promise<string | null> {
  await git(root, "add -A");
  const status = await git(root, "status --porcelain");
  if (!status) return null;
  // Not under .git: in a worktree .git is a file, and the repo dir itself must stay clean.
  const msgFile = path.join(tmpdir(), `agentpipe-msg-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(msgFile, message);
  try {
    await git(root, `${await identityArgs(root)}commit -q -F ${JSON.stringify(msgFile)}`);
  } finally {
    try {
      unlinkSync(msgFile);
    } catch {
      /* gone */
    }
  }
  return git(root, "rev-parse --short HEAD");
}

/** `git diff` ignores untracked files; register new files as intent-to-add so they show up. */
async function trackNewFiles(root: string): Promise<void> {
  await sh("git add -A -N -- .", root, 60);
}

export async function diffSince(root: string, ref: string): Promise<string> {
  await trackNewFiles(root);
  const r = await sh(`git diff ${JSON.stringify(ref)} -- . ':(exclude)*.png' ':(exclude)*.lockb'`, root, 60);
  return r.output;
}

export async function diffStat(root: string, ref: string): Promise<string> {
  await trackNewFiles(root);
  const r = await sh(`git diff --stat ${JSON.stringify(ref)}`, root, 60);
  return r.output.trim();
}

export async function headSha(root: string): Promise<string> {
  return git(root, "rev-parse HEAD");
}

export async function pushBranch(root: string, branch: string): Promise<void> {
  await git(root, `push -u origin ${JSON.stringify(branch)}`);
}

/** Opens a PR with the GitHub CLI if it is installed and authenticated. Returns the PR URL, or null if gh is unavailable. */
export async function createPullRequest(root: string, branch: string, base: string, title: string, bodyFile: string): Promise<string | null> {
  const probe = await sh("gh auth status", root, 30);
  if (!probe.ok) return null;
  const r = await sh(`gh pr create --head ${JSON.stringify(branch)} --base ${JSON.stringify(base)} --title ${JSON.stringify(title.slice(0, 200))} --body-file ${JSON.stringify(bodyFile)}`, root, 120);
  if (!r.ok) throw new Error(`gh pr create failed: ${r.output.trim()}`);
  const url = r.output.trim().split("\n").find((l) => l.startsWith("https://"));
  return url ?? r.output.trim();
}

/** The shared .git directory: identical for the main checkout and every worktree of it. */
export async function gitCommonDir(root: string): Promise<string> {
  const r = await sh("git rev-parse --path-format=absolute --git-common-dir", root, 30);
  if (!r.ok) throw new Error(`${root} is not a git checkout`);
  return r.output.trim();
}

/** The main checkout that owns this (work)tree. */
export async function mainCheckout(root: string): Promise<string> {
  return path.dirname(await gitCommonDir(root));
}

/** Run directories live beside the main checkout, never inside a worktree that will be removed. */
export async function runsRoot(root: string): Promise<string> {
  return path.join(await mainCheckout(root), ".agentpipe", "runs");
}

/** Keep .agentpipe/ out of git via the shared exclude file, so worktrees see it too. */
export async function excludeAgentpipeDir(root: string): Promise<void> {
  const ex = path.join(await gitCommonDir(root), "info", "exclude");
  const line = ".agentpipe/";
  if (existsSync(ex) && readFileSync(ex, "utf8").split("\n").includes(line)) return;
  mkdirSync(path.dirname(ex), { recursive: true });
  writeFileSync(ex, (existsSync(ex) ? readFileSync(ex, "utf8").replace(/\n?$/, "\n") : "") + line + "\n");
}

/**
 * Make sure `entries` (symlinks the worker created in a worktree) are ignored. A symlink to a
 * directory is a file to git, so a `node_modules/` ignore rule does not cover it; the shared
 * exclude file gets an anchored entry without the slash.
 */
export async function ensureIgnored(root: string, entries: string[]): Promise<void> {
  const missing: string[] = [];
  for (const e of entries) if (!(await sh(`git check-ignore -q ${JSON.stringify(e)}`, root, 30)).ok) missing.push(e);
  if (!missing.length) return;
  const ex = path.join(await gitCommonDir(root), "info", "exclude");
  mkdirSync(path.dirname(ex), { recursive: true });
  const have = existsSync(ex) ? readFileSync(ex, "utf8") : "";
  const add = missing.map((e) => "/" + e.replace(/^\/+/, "")).filter((l) => !have.split("\n").includes(l));
  if (add.length) writeFileSync(ex, have.replace(/\n?$/, "\n") + add.join("\n") + "\n");
}

/** One line describing the stack, from package.json, so prompts need no hard-coded framework names. */
export function repoStack(root: string): string {
  const pkgPath = path.join(root, "package.json");
  if (!existsSync(pkgPath)) {
    for (const [file, name] of [["Cargo.toml", "Rust (cargo)"], ["pyproject.toml", "Python (pyproject)"], ["go.mod", "Go"], ["pom.xml", "Java (maven)"], ["build.gradle", "Java/Kotlin (gradle)"], ["Gemfile", "Ruby"]] as const)
      if (existsSync(path.join(root, file))) return name;
    return "unknown (no package manifest found)";
  }
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) } as Record<string, string>;
    const known: [string, string][] = [["svelte", "Svelte"], ["@sveltejs/kit", "SvelteKit"], ["react", "React"], ["next", "Next.js"], ["vue", "Vue"], ["nuxt", "Nuxt"], ["angular", "Angular"], ["@angular/core", "Angular"], ["solid-js", "Solid"], ["astro", "Astro"], ["express", "Express"], ["fastify", "Fastify"], ["hono", "Hono"], ["typescript", "TypeScript"], ["vitest", "Vitest"], ["jest", "Jest"], ["mocha", "Mocha"], ["@playwright/test", "Playwright"], ["cypress", "Cypress"], ["eslint", "ESLint"], ["prettier", "Prettier"], ["tailwindcss", "Tailwind"], ["vite", "Vite"], ["webpack", "webpack"], ["prisma", "Prisma"], ["drizzle-orm", "Drizzle"]];
    const parts = known.filter(([d]) => d in deps).map(([d, label]) => `${label} ${String(deps[d]).replace(/^[\^~]/, "")}`);
    const runtime = existsSync(path.join(root, "bun.lock")) || existsSync(path.join(root, "bun.lockb")) ? "Bun" : existsSync(path.join(root, "pnpm-lock.yaml")) ? "pnpm" : existsSync(path.join(root, "yarn.lock")) ? "yarn" : "npm";
    const scripts = Object.keys(pkg.scripts ?? {}).filter((k) => /^(lint|test|check|build|dev|format)/.test(k));
    return `${runtime}${parts.length ? "; " + parts.join(", ") : ""}${scripts.length ? `; scripts: ${scripts.join(", ")}` : ""}`;
  } catch {
    return "unknown (package.json unreadable)";
  }
}

/** Per-repository guidance for agents, written by humans: AGENTPIPE.md at the repo root (or docs/AGENTPIPE.md). */
export function projectNotes(root: string, maxChars = 6000): string | null {
  for (const rel of ["AGENTPIPE.md", "docs/AGENTPIPE.md", ".agentpipe.md"]) {
    const p = path.join(root, rel);
    if (existsSync(p)) {
      const text = readFileSync(p, "utf8").trim();
      return text.length > maxChars ? text.slice(0, maxChars) + "\n... (truncated)" : text;
    }
  }
  return null;
}
