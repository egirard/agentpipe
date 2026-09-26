import type { Config } from "./config.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { clip, log, runDir, sh, type ExecResult } from "./util.ts";

export interface CheckResult {
  name: string;
  ok: boolean;
  summary: string;
  /** Clipped output suitable for a prompt. */
  output: string;
  /** Where the complete, unclipped output was saved (inside the run dir), if a run dir is set. */
  logPath: string | null;
  seconds: number;
}

let checkCounter = 0;
function persist(name: string, output: string): string | null {
  const dir = runDir();
  if (!dir) return null;
  const checks = path.join(dir, "checks");
  mkdirSync(checks, { recursive: true });
  const file = path.join(checks, `${String(++checkCounter).padStart(3, "0")}-${name.replace(/[^a-z0-9]+/gi, "-")}.log`);
  writeFileSync(file, output);
  return file;
}

function summarize(r: ExecResult): string {
  if (r.timedOut) return "timed out";
  if (r.ok) return "passed";
  return `failed (exit ${r.code})`;
}

async function runCheck(name: string, cmd: string, cfg: Config): Promise<CheckResult> {
  log(`  running ${name}: ${cmd}`);
  const r = await sh(cmd, cfg.repo, cfg.limits.commandTimeoutSec, { AGENTPIPE_REPO: cfg.repo });
  const res: CheckResult = { name, ok: r.ok, summary: summarize(r), output: clip(r.output, cfg.limits.testOutputChars), logPath: persist(name, r.output), seconds: r.seconds };
  log(`  ${name}: ${res.summary} in ${r.seconds.toFixed(0)}s`);
  return res;
}

/** Lint plus unit tests. If `unitFiles` is given, vitest runs only those (much faster feedback for the coder loop). */
export async function runFastChecks(cfg: Config, unitFiles: string[] = []): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  results.push(await runCheck("lint", cfg.commands.lint, cfg));
  const unitCmd = unitFiles.length ? `${cfg.commands.unit} -- ${unitFiles.map((f) => JSON.stringify(f)).join(" ")}` : cfg.commands.unit;
  results.push(await runCheck(unitFiles.length ? "unit (targeted)" : "unit", unitCmd, cfg));
  return results;
}

export async function runFullUnit(cfg: Config): Promise<CheckResult> {
  return runCheck("unit (full)", cfg.commands.unit, cfg);
}

export async function runE2e(cfg: Config, specs: string[]): Promise<CheckResult> {
  const args = specs.map((s) => JSON.stringify(s)).join(" ");
  return runCheck("e2e", `${cfg.commands.e2e} ${args}`.trim(), cfg);
}

export function failures(results: CheckResult[]): CheckResult[] {
  return results.filter((r) => !r.ok);
}

export function formatFailures(results: CheckResult[]): string {
  return failures(results)
    .map((r) => `### ${r.name}: ${r.summary}${r.logPath ? `\n(full output: ${r.logPath})` : ""}\n\`\`\`\n${r.output}\n\`\`\``)
    .join("\n\n");
}
