import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Per-run context. The worker runs several tasks at once (one per lane), so "the current log
 * file" and "the current run directory" cannot be module globals: they live in an
 * AsyncLocalStorage store that follows each task's async chain. Code that runs outside any task
 * (the CLI, doctor) falls back to a module-level default.
 */
export interface RunContext {
  logFile: string | null;
  runDir: string | null;
  taskId: number | null;
  label: string;
  /** Claude spend recorded for this task so far, in USD as reported by Claude Code. */
  spentUsd: number;
  /** Per-task cap; null = unlimited. */
  budgetUsd: number | null;
  /** Called after every Claude invocation with its cost, if set (the worker records usage). */
  onSpend?: (usd: number, label: string, model: string, turns: number, seconds: number) => void;
}

const als = new AsyncLocalStorage<RunContext>();
const fallback: RunContext = { logFile: null, runDir: null, taskId: null, label: "", spentUsd: 0, budgetUsd: null };

export function runContext(): RunContext {
  return als.getStore() ?? fallback;
}

export function withRunContext<T>(init: Partial<RunContext>, fn: () => Promise<T>): Promise<T> {
  return als.run({ ...fallback, ...init, spentUsd: 0 }, fn);
}

export function setRunDir(p: string) {
  mkdirSync(p, { recursive: true });
  runContext().runDir = p;
}
export function runDir(): string | null {
  return runContext().runDir;
}

export function setLogFile(p: string) {
  mkdirSync(path.dirname(p), { recursive: true });
  runContext().logFile = p;
}

export function log(msg: string) {
  const c = runContext();
  const prefix = c.label ? `[${new Date().toISOString().slice(11, 19)}] [${c.label}] ` : `[${new Date().toISOString().slice(11, 19)}] `;
  const line = prefix + msg;
  console.log(line);
  if (c.logFile) appendFileSync(c.logFile, line + "\n");
}

/** Append raw text (model prompts/outputs) to the run log without echoing to the terminal. */
export function trace(label: string, text: string) {
  const c = runContext();
  if (!c.logFile) return;
  appendFileSync(c.logFile, `\n----- ${label} -----\n${text}\n----- end ${label} -----\n`);
}

/** Record Claude spend against the current task. Throws when the task's budget is exhausted. */
export function recordSpend(usd: number, label: string, model: string, turns: number, seconds: number) {
  const c = runContext();
  c.spentUsd += usd;
  c.onSpend?.(usd, label, model, turns, seconds);
}
export class BudgetExceeded extends Error {
  constructor(spent: number, budget: number) {
    super(`task budget exhausted: $${spent.toFixed(2)} spent of $${budget.toFixed(2)} allowed`);
  }
}
export function assertBudget() {
  const c = runContext();
  if (c.budgetUsd != null && c.spentUsd >= c.budgetUsd) throw new BudgetExceeded(c.spentUsd, c.budgetUsd);
}

export interface ExecResult {
  ok: boolean;
  code: number | null;
  output: string;
  timedOut: boolean;
  seconds: number;
}

/** Variables that must never reach a subprocess an agent influences. */
export const SECRET_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY"];

export function sanitizedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SECRET_VARS.includes(k)) env[k] = v;
  return { ...env, ...extra, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" };
}

/** Run a shell command in `cwd`, capturing combined stdout+stderr. Secrets are stripped from the environment. */
export async function sh(cmd: string, cwd: string, timeoutSec: number, env: Record<string, string> = {}): Promise<ExecResult> {
  const start = Date.now();
  const proc = Bun.spawn(["bash", "-lc", cmd], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: sanitizedEnv(env),
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutSec * 1000);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  const output = stripAnsi(out + (err ? "\n" + err : ""));
  return { ok: code === 0 && !timedOut, code, output, timedOut, seconds: (Date.now() - start) / 1000 };
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;?]*[a-zA-Z]/g, "");
}

/** Keep the head and tail of long output; models care about the last errors most. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.25);
  const tail = max - head;
  return s.slice(0, head) + `\n... [${s.length - max} chars omitted] ...\n` + s.slice(-tail);
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "task";
}

export function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export function sha1(s: string): string {
  return new Bun.CryptoHasher("sha1").update(s).digest("hex").slice(0, 12);
}
