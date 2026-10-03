import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Config } from "./config.ts";
import { Plan, Replan, type PlanStep } from "./plan.ts";
import { fileExists, readFile, repoOverview } from "./repo.ts";
import { formatFailures, runFastChecks, type CheckResult } from "./tests.ts";
import { assertBudget, clip, log, recordSpend, stripAnsi, trace } from "./util.ts";

/**
 * Cloud roles run through Claude Code in headless mode (`claude -p`), so they are covered by a
 * Claude subscription via `claude setup-token` rather than an API key. Claude Code brings its own
 * tools (Read/Grep/Glob/Edit/Bash) and runs inside the repo directory; we constrain what each role
 * may do with --allowedTools and --permission-mode.
 *
 *  - architect: read-only exploration, returns a Plan as structured JSON (--json-schema)
 *  - fixer:     may edit files and run lint/unit tests; the pipeline re-verifies afterwards
 *  - final review: read-only, sees the diff via git
 */

export interface ClaudeRun {
  result: string;
  structured: unknown | undefined;
  sessionId: string | undefined;
  costUsd: number | undefined;
  turns: number | undefined;
  isError: boolean;
}

export interface ClaudeOpts {
  cwd: string;
  prompt: string;
  systemAppend?: string;
  allowedTools: string[];
  permissionMode: "dontAsk" | "acceptEdits";
  maxTurns: number;
  jsonSchema?: object;
  timeoutSec?: number;
  label: string;
  /** Override cfg.models.cloud for this call (agents may pin a model). */
  model?: string;
  /** Claude Code settings object (hooks); written to a temp file and passed with --settings. */
  settings?: object;
}

export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "LS"];

export async function runClaude(cfg: Config, o: ClaudeOpts): Promise<ClaudeRun> {
  const args = [
    cfg.claudeBin,
    "-p",
    o.prompt,
    "--output-format",
    "json",
    "--permission-mode",
    o.permissionMode,
    "--max-turns",
    String(o.maxTurns),
    "--allowedTools",
    o.allowedTools.join(","),
  ];
  const model = o.model || cfg.models.cloud;
  if (model) args.push("--model", model);
  if (o.systemAppend) args.push("--append-system-prompt", o.systemAppend);
  if (o.jsonSchema) args.push("--json-schema", JSON.stringify(o.jsonSchema));
  let settingsFile: string | null = null;
  if (o.settings) {
    settingsFile = path.join(tmpdir(), `agentpipe-settings-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(settingsFile, JSON.stringify(o.settings));
    args.push("--settings", settingsFile);
  }
  assertBudget();

  trace(`claude ${o.label} prompt`, o.prompt + (o.systemAppend ? `\n\n[system append]\n${o.systemAppend}` : ""));
  log(`  claude (${model || "default model"}): ${o.label}, up to ${o.maxTurns} turns`);
  const start = Date.now();
  const proc = Bun.spawn(args, {
    cwd: o.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  const timeoutMs = (o.timeoutSec ?? 1800) * 1000;
  const timer = setTimeout(() => proc.kill("SIGTERM"), timeoutMs);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  if (settingsFile) try { unlinkSync(settingsFile); } catch { /* gone */ }
  const secs = ((Date.now() - start) / 1000).toFixed(0);
  trace(`claude ${o.label} stdout`, out);
  if (err.trim()) trace(`claude ${o.label} stderr`, stripAnsi(err));

  let parsed: any = null;
  try {
    parsed = JSON.parse(out.trim());
  } catch {
    throw new Error(`claude -p returned non-JSON (exit ${code}) after ${secs}s: ${clip(stripAnsi(err || out), 800)}`);
  }
  const run: ClaudeRun = {
    result: typeof parsed.result === "string" ? parsed.result : JSON.stringify(parsed.result ?? ""),
    structured: parsed.structured_output,
    sessionId: parsed.session_id,
    costUsd: parsed.total_cost_usd,
    turns: parsed.num_turns,
    isError: Boolean(parsed.is_error) || code !== 0,
  };
  log(`  claude ${o.label}: ${run.isError ? "ERROR" : "done"} in ${secs}s, ${run.turns ?? "?"} turns${run.costUsd != null ? `, $${run.costUsd.toFixed(3)}` : ""}`);
  const denials = Array.isArray(parsed.permission_denials) ? parsed.permission_denials.length : 0;
  if (denials) log(`  claude ${o.label}: ${denials} tool call(s) blocked by policy`);
  recordSpend(run.costUsd ?? 0, o.label, model || "default", run.turns ?? 0, Number(secs));
  if (run.isError) throw new Error(`claude -p failed (exit ${code}): ${clip(run.result || stripAnsi(err), 800)}`);
  return run;
}

const ARCHITECT_SYSTEM = `You are the architect for a coding pipeline. A much weaker local model (a 7B parameter coder) will implement your plan one step at a time, seeing only the files you list for that step. Real lint and tests decide whether a step passed. You are read-only: explore, then answer with the plan JSON.

Plan rules:
- Steps are tiny: one concern, 1-3 small files, ideally under 200 lines each. Split large files' work into separate steps or have a step extract a helper first.
- Every step's description must be self-contained and explicit: exact function names, signatures, where to insert, what to import, expected behaviour, edge cases. Include short code sketches. Assume the coder has never seen the repo.
- Put unit tests in their own step before or with the code they test, following the repo's existing test style. List the test file(s) in unit_tests so only they run during the step.
- context_files: the minimum the coder must read (type definitions, one similar example). Keep total context small.
- List e2e specs only where the step changes UI or flows that an existing spec covers.
- Never plan screenshot baseline updates; flag them under risks instead.
- Order steps so each one leaves the suite green.
- Mark scripts and git hooks with "executable": true on the file entry; the pipeline sets the mode, nobody can chmod.
- A file over about 20,000 characters cannot be rewritten by the local model and goes to the cloud fixer; prefer steps that extract a small helper first, and never ask for a whole-file rewrite of a large file.
- The repository may hold read-only copies of other repositories under upstream/<name>/; read them for reference but never list them as writable or context files.`;

export async function architectPlan(cfg: Config, task: string): Promise<Plan> {
  const overview = await repoOverview(cfg.repo);
  const guidelines = ["docs/E2E_TEST_GUIDELINES.md", "CONTRIBUTING.md"]
    .filter((p) => fileExists(cfg.repo, p))
    .map((p) => `- ${p}`)
    .join("\n");
  const prompt = [
    `# Task`,
    task,
    "",
    "# Repository overview (directories, file counts)",
    overview,
    "",
    guidelines ? `Project guideline files worth reading first:\n${guidelines}\n` : "",
    "Explore the repository with Read/Grep/Glob as needed (you are in the repo root), then produce the plan.",
  ].join("\n");

  const run = await runClaude(cfg, {
    cwd: cfg.repo,
    prompt,
    systemAppend: ARCHITECT_SYSTEM,
    allowedTools: READ_ONLY_TOOLS,
    permissionMode: "dontAsk",
    maxTurns: 60,
    jsonSchema: planJsonSchema(),
    label: "architect",
  });
  const raw = run.structured ?? tryParseJson(run.result);
  if (!raw) throw new Error("architect did not return a plan");
  return Plan.parse(raw);
}

const REPLAN_SYSTEM = `You are the architect for a coding pipeline; you wrote the original plan. A step has now failed after every attempt. You have the exact outputs of every attempt below and full logs on disk; read the logs and the current files as needed (you are read-only). The working tree has been reset to the last good commit unless stated otherwise.

Decide what to do with the REMAINING work and return a revised plan:
- Diagnose from the evidence, not from guesses. Common causes: the step was too big for a 7B coder, the spec left something implicit, a wrong file or missing context file, a flaky or environment-dependent test, or the task conflicts with existing behaviour.
- Reorganise freely: split the failed step, add a preparatory step, list more context files, rewrite the description with the exact code the coder should produce, change which tests run.
- Keep steps tiny and explicit as before. The completed steps are already committed; do not repeat them.
- If the failure is an environment problem the pipeline cannot fix (missing tool, broken test harness) or the task is genuinely impossible, set give_up=true with a precise reason.`;

export interface FailureContext {
  task: string;
  originalPlan: Plan;
  completedSteps: PlanStep[];
  failedStep: PlanStep;
  /** Rendered attempt history with exact (clipped) outputs and log paths. */
  history: string;
  remainingSteps: PlanStep[];
  /** True when the failed step's work was committed (e.g. e2e failed after commit) and is still in the tree. */
  keptChanges: boolean;
  replanNumber: number;
}

export async function architectReplan(cfg: Config, f: FailureContext): Promise<Replan> {
  const prompt = [
    `# Task`,
    f.task,
    "",
    `# Original plan summary`,
    f.originalPlan.summary,
    "",
    `# Completed steps (committed)`,
    f.completedSteps.length ? f.completedSteps.map((s) => `- ${s.id}: ${s.title}`).join("\n") : "(none)",
    "",
    `# Failed step ${f.failedStep.id}: ${f.failedStep.title}`,
    "```json",
    JSON.stringify(f.failedStep, null, 2),
    "```",
    "",
    `# Attempt history for ${f.failedStep.id} (exact outputs, clipped; full logs at the paths shown)`,
    f.history,
    "",
    f.keptChanges ? "The failed step's changes ARE committed and present in the working tree (its unit checks passed; a later check failed)." : "The working tree has been reset to the last good commit; none of the failed step's changes remain.",
    "",
    `# Remaining planned steps (to be replaced by your answer)`,
    f.remainingSteps.length ? f.remainingSteps.map((s) => `- ${s.id}: ${s.title}`).join("\n") : "(none)",
    "",
    `This is replan ${f.replanNumber} of ${cfg.limits.replans}. Investigate, then answer with the revised plan JSON.`,
  ].join("\n");

  const run = await runClaude(cfg, {
    cwd: cfg.repo,
    prompt,
    systemAppend: REPLAN_SYSTEM,
    allowedTools: [...READ_ONLY_TOOLS, "Bash(git diff *)", "Bash(git log *)", "Bash(git status *)", "Bash(git show *)"],
    permissionMode: "dontAsk",
    maxTurns: 60,
    jsonSchema: jsonSchemaOf(Replan),
    label: `replan ${f.replanNumber}`,
  });
  const raw = run.structured ?? tryParseJson(run.result);
  if (!raw) throw new Error("architect did not return a revised plan");
  return Replan.parse(raw);
}

const FIXER_SYSTEM = `You are taking over a step that a weaker local model could not complete, or was not trusted with. Read what you need, edit files, and run lint and the step's unit tests until they pass. Keep changes minimal and in the repo's style. Do not run git commands, do not modify screenshot baselines, and do not touch files unrelated to the step. Files the step marks executable get their mode set by the pipeline after you finish; do not try to chmod. Finish with a short summary of what you changed and why.`;

export async function cloudFix(cfg: Config, step: PlanStep, diffSoFar: string, failing: CheckResult[], note?: string): Promise<{ ok: boolean; summary: string; lastChecks: CheckResult[] }> {
  const unitCmd = step.unit_tests.length ? `${cfg.commands.unit} -- ${step.unit_tests.join(" ")}` : cfg.commands.unit;
  const prompt = [
    `# Step ${step.id}: ${step.title}`,
    step.description,
    "",
    ...(note ? [`## Why this step comes to you`, note, ""] : []),
    "## Acceptance criteria",
    ...step.acceptance.map((a) => `- ${a}`),
    "",
    `## Files the step was meant to touch\n${step.files.map((f) => `- ${f.path} (${f.action}${f.executable ? ", executable" : ""})`).join("\n")}`,
    "",
    `## Commands to verify\n- lint: \`${cfg.commands.lint}\`\n- unit: \`${unitCmd}\``,
    "",
    "## What the local model changed so far (diff)",
    "```diff",
    clip(diffSoFar, 30_000),
    "```",
    "",
    "## Last failing checks",
    formatFailures(failing) || "(none recorded)",
  ].join("\n");

  const lintBase = cfg.commands.lint;
  const unitBase = cfg.commands.unit;
  const run = await runClaude(cfg, {
    cwd: cfg.repo,
    prompt,
    systemAppend: FIXER_SYSTEM,
    allowedTools: [...READ_ONLY_TOOLS, "Edit", "Write", "MultiEdit", `Bash(${lintBase})`, `Bash(${lintBase} *)`, `Bash(${unitBase})`, `Bash(${unitBase} *)`, "Bash(bunx vitest *)"],
    permissionMode: "acceptEdits",
    maxTurns: cfg.limits.cloudIterations,
    label: `fixer ${step.id}`,
  });
  // Never trust the model's own claim: re-run the checks.
  const lastChecks = await runFastChecks(cfg, step.unit_tests);
  return { ok: lastChecks.every((c) => c.ok), summary: run.result, lastChecks };
}

const REVIEW_SYSTEM = `You are reviewing the complete diff produced by an automated pipeline for a task. Lint and tests passed. Look for logic errors, unmet requirements, unsafe changes, dead code, anything a human reviewer would push back on. Be specific and brief. End with a verdict line: VERDICT: approve or VERDICT: request-changes.`;

export async function cloudFinalReview(cfg: Config, task: string, plan: Plan, baseSha: string): Promise<string> {
  const run = await runClaude(cfg, {
    cwd: cfg.repo,
    prompt: `# Task\n${task}\n\n# Plan summary\n${plan.summary}\n\nRun \`git diff ${baseSha}\` (and read files if needed) to see everything the pipeline changed, then review it.`,
    systemAppend: REVIEW_SYSTEM,
    allowedTools: [...READ_ONLY_TOOLS, "Bash(git diff *)", "Bash(git log *)", "Bash(git show *)"],
    permissionMode: "dontAsk",
    maxTurns: 20,
    label: "final review",
  });
  return run.result;
}

/** For `agentpipe doctor`: proves the CLI is installed and authenticated. */
export async function claudeReachable(cfg: Config): Promise<string> {
  const run = await runClaude(cfg, {
    cwd: cfg.repo,
    prompt: "Reply with exactly: ok",
    allowedTools: [],
    permissionMode: "dontAsk",
    maxTurns: 1,
    timeoutSec: 120,
    label: "doctor",
  });
  return run.result.trim();
}

/** Claude Code's --json-schema validator rejects the draft-2020 `$schema` header Zod emits. */
function planJsonSchema(): object {
  return jsonSchemaOf(Plan);
}
export function jsonSchemaOf(t: z.ZodType): object {
  const schema = z.toJSONSchema(t, { target: "draft-7" }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

export function tryParseJson(s: string): unknown | null {
  const t = s.trim();
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = m ? m[1] : t.slice(t.indexOf("{"));
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}
