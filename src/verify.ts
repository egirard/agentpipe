import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ProjectConfig } from "./global.ts";
import type { AgentManifest } from "./registry.ts";
import type { AgentResult } from "./result.ts";
import type { Task } from "./store.ts";
import { clip, log, sh, type ExecResult } from "./util.ts";

/**
 * Output verification. After an agent's runtime has produced a result (and, for agents that
 * commit, changed files), the agent's verifier gets one look at everything and returns a list of
 * problems. Any problem downgrades the task to `attention` and blocks the push: the agent's
 * promise in its manifest is checked by code, not taken on trust.
 *
 * A verifier is `verify.ts` in the agent directory (default export from defineVerifier), or a
 * shell command named in the manifest's `verify` field (exit 0 = pass, output = the problem).
 */
export interface VerifyContext {
  task: Task;
  result: AgentResult;
  manifest: AgentManifest;
  projectName: string;
  project: ProjectConfig;
  /** Absolute path of the checkout. */
  repo: string;
  /** The agent's directory, or null for a bare-json agent. */
  agentDir: string | null;
  runDir: string;
  /** Branch holding the agent's work, if it made any. */
  branch: string | null;
  /** Commit the work started from. */
  baseSha: string;
  startBranch: string;
  /** Repo-relative paths changed since baseSha, committed or not. */
  changedFiles: string[];
  diff(): Promise<string>;
  read(rel: string): string;
  exists(rel: string): boolean;
  sh(cmd: string, timeoutSec?: number): Promise<ExecResult>;
}

export type Verifier = (ctx: VerifyContext) => string[] | Promise<string[]>;

/** Identity with a type: makes verify.ts files self-documenting and checkable. */
export function defineVerifier(fn: Verifier): Verifier {
  return fn;
}

export interface VerifyOutcome {
  ran: boolean;
  ok: boolean;
  problems: string[];
  kind: "script" | "command" | "none";
}

export async function runVerifier(manifest: AgentManifest, ctx: VerifyContext): Promise<VerifyOutcome> {
  const v = manifest.verifier;
  if (!v) return { ran: false, ok: true, problems: [], kind: "none" };
  log(`  verifying output with ${v.kind === "script" ? path.relative(manifest.dir ?? path.dirname(manifest.source), v.path) : v.command}`);
  try {
    if (v.kind === "script") {
      const mod = await import(v.path);
      const fn: Verifier | undefined = mod.default;
      if (typeof fn !== "function") return { ran: true, ok: false, problems: [`${v.path} has no default export function`], kind: "script" };
      const problems = (await fn(ctx)).filter(Boolean).map(String);
      return { ran: true, ok: problems.length === 0, problems, kind: "script" };
    }
    const resultFile = path.join(ctx.runDir, "result.json");
    if (!existsSync(resultFile)) writeFileSync(resultFile, JSON.stringify(ctx.result, null, 2));
    const r = await sh(v.command, ctx.repo, 600, {
      AGENTPIPE_REPO: ctx.repo,
      AGENTPIPE_PROJECT: ctx.projectName,
      AGENTPIPE_TASK_ID: String(ctx.task.id),
      AGENTPIPE_TASK_TITLE: ctx.task.title,
      AGENTPIPE_TASK_DESCRIPTION: ctx.task.description,
      AGENTPIPE_TASK_FILES: ctx.task.files.join(" "),
      AGENTPIPE_TASK_BRANCH: ctx.branch ?? "",
      AGENTPIPE_BASE_SHA: ctx.baseSha,
      AGENTPIPE_RUN_DIR: ctx.runDir,
      AGENTPIPE_RESULT_JSON: resultFile,
      AGENTPIPE_CHANGED_FILES: ctx.changedFiles.join("\n"),
      AGENTPIPE_AGENT_DIR: ctx.agentDir ?? "",
    });
    return { ran: true, ok: r.ok, problems: r.ok ? [] : [`${v.command} exited ${r.timedOut ? "by timeout" : r.code}:\n${clip(r.output.trim(), 3000)}`], kind: "command" };
  } catch (e) {
    return { ran: true, ok: false, problems: [`verifier crashed: ${(e as Error).message}`], kind: v.kind };
  }
}

/* ---------- helpers for verify.ts files ---------- */

function matches(file: string, patterns: string[]): boolean {
  return patterns.some((p) => new Bun.Glob(p).match(file));
}

/** Problems for every changed file that matches none of the allowed globs. */
export function onlyPaths(files: string[], allowed: string[], label = "changed"): string[] {
  return files.filter((f) => !matches(f, allowed)).map((f) => `${label} file outside the allowed set (${allowed.join(", ")}): ${f}`);
}

/** Problems for allowed-but-forbidden files, e.g. screenshot baselines. */
export function forbidPaths(files: string[], forbidden: string[], why = "must not be changed by this agent"): string[] {
  return files.filter((f) => matches(f, forbidden)).map((f) => `${f} ${why}`);
}

/** Problems for expected files that do not exist. */
export function requirePaths(ctx: Pick<VerifyContext, "exists">, paths: string[]): string[] {
  return paths.filter((p) => !ctx.exists(p)).map((p) => `expected file is missing: ${p}`);
}

/** Problem when at least one changed file was expected and none appeared. */
export function requireChanges(files: string[], what = "a change"): string[] {
  return files.length ? [] : [`the agent reported success but produced ${what === "a change" ? "no file changes" : "no " + what}`];
}

export function nonEmptySummary(result: AgentResult, minChars = 40): string[] {
  const s = result.summary.trim();
  return s.length >= minChars ? [] : [`summary is too short (${s.length} chars, expected at least ${minChars})`];
}

/** Every finding of the given severities must name a file. */
export function findingsHavePaths(result: AgentResult, severities: string[] = ["blocker", "major"]): string[] {
  return result.findings.filter((f) => severities.includes(f.severity) && !f.path).map((f) => `${f.severity} finding has no file path: "${clip(f.description, 80)}"`);
}

/** Subtasks must be actionable on their own: a real description and a title. */
export function subtasksActionable(result: AgentResult, minChars = 120): string[] {
  const out: string[] = [];
  result.subtasks.forEach((s, i) => {
    if (!s.title.trim()) out.push(`subtask ${i} has no title`);
    if (s.description.trim().length < minChars) out.push(`subtask ${i} "${clip(s.title, 60)}" has a ${s.description.trim().length}-char description; the agent that runs it sees nothing else`);
    if (/\b(see above|as discussed|as mentioned|earlier)\b/i.test(s.description)) out.push(`subtask ${i} "${clip(s.title, 60)}" refers to context the target agent will not have`);
  });
  return out;
}

/** For agents that must not change files at all. */
export function noChanges(files: string[]): string[] {
  return files.length ? [`the agent changed files it is not allowed to: ${files.join(", ")}`] : [];
}

/** Cheap structural check for SVG assets. */
export function svgWellFormed(text: string, name: string): string[] {
  const out: string[] = [];
  if (!/<svg[\s>]/.test(text)) out.push(`${name}: no <svg> root`);
  if (!/viewBox=/.test(text)) out.push(`${name}: missing viewBox`);
  if (/<\?xml-stylesheet|sodipodi:|inkscape:|<metadata/.test(text)) out.push(`${name}: contains editor metadata`);
  if (/<script[\s>]/.test(text)) out.push(`${name}: contains a script element`);
  return out;
}

export function readIfExists(repo: string, rel: string): string | null {
  const p = path.join(repo, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}
