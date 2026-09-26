import { writeFileSync } from "node:fs";
import path from "node:path";
import { architectPlan, architectReplan, cloudFinalReview, cloudFix } from "./claude.ts";
import type { Config } from "./config.ts";
import type { Plan, PlanStep } from "./plan.ts";
import { commitAll, createBranch, createPullRequest, currentBranch, diffSince, diffStat, ensureClean, excludeAgentpipeDir, headSha, pushBranch, runsRoot } from "./repo.ts";
import { runCoder } from "./stages/coder.ts";
import { formatIssues, runReviewer } from "./stages/reviewer.ts";
import { failures, formatFailures, runE2e, runFastChecks, runFullUnit, type CheckResult } from "./tests.ts";
import { clip, log, nowStamp, setLogFile, setRunDir, sh, slug } from "./util.ts";

/** One attempt at a step, with everything a later reader (human or architect) needs to see exactly what happened. */
export interface StepAttempt {
  n: number;
  actor: "coder" | "fixer" | "e2e";
  filesWritten: string[];
  explanation: string;
  checks: CheckResult[];
  review?: { approved: boolean; summary: string; issues: string };
  error?: string;
}

export interface StepReport {
  id: string;
  title: string;
  status: "passed" | "escalated-passed" | "failed" | "skipped";
  attempts: number;
  commit: string | null;
  notes: string[];
  history: StepAttempt[];
}

export interface RunReport {
  task: string;
  branch: string;
  runDir: string;
  plan: Plan;
  steps: StepReport[];
  replans: { after: string; assessment: string; gaveUp: boolean; reason?: string; newSteps: string[] }[];
  finalUnit: CheckResult | null;
  finalReview: string | null;
  pushed: string | null;
  ok: boolean;
}

export async function runPipeline(cfg: Config, task: string, opts: { planOnly?: boolean; plan?: Plan } = {}): Promise<RunReport> {
  const stamp = nowStamp();
  await excludeAgentpipeDir(cfg.repo);
  const runDir = path.join(await runsRoot(cfg.repo), `${stamp}-${slug(task)}`);
  setRunDir(runDir);
  setLogFile(path.join(runDir, "run.log"));
  log(`run dir: ${runDir}`);

  // Everything that can fail cheaply happens before any model is called.
  await ensureClean(cfg.repo);
  const startBranch = await currentBranch(cfg.repo);
  let branch = `agentpipe/${slug(task)}-${stamp.slice(0, 16).replace("T", "-").replace(/-(\d\d)-(\d\d)$/, "-$1$2")}`;
  if (!opts.planOnly) {
    branch = await createBranch(cfg.repo, branch);
    log(`branch ${branch} (from ${startBranch})`);
  }

  let plan: Plan;
  try {
    plan = opts.plan ?? (await architectPlan(cfg, task));
  } catch (e) {
    await abandon(cfg.repo, startBranch, branch, opts.planOnly);
    throw e;
  }
  writeFileSync(path.join(runDir, "plan.json"), JSON.stringify(plan, null, 2));
  logPlan(plan);

  const report: RunReport = { task, branch, runDir, plan, steps: [], replans: [], finalUnit: null, finalReview: null, pushed: null, ok: false };
  if (opts.planOnly) {
    writeReport(report);
    return report;
  }
  const baseSha = await headSha(cfg.repo);

  // Work queue: the architect may replace the remaining steps after a failure.
  const queue: PlanStep[] = [...plan.steps];
  const completed: PlanStep[] = [];
  let replans = 0;
  let stopped = false;

  while (queue.length && !stopped) {
    const step = queue.shift()!;
    const sr = await runStep(cfg, step);
    report.steps.push(sr);
    writeFileSync(path.join(runDir, `${step.id}-history.json`), JSON.stringify(sr.history, null, 2));
    if (sr.status !== "failed") {
      completed.push(step);
      continue;
    }

    // The step is exhausted. Hand the exact evidence back to the architect.
    const keptChanges = sr.commit !== null;
    if (!keptChanges) {
      await sh("git checkout -q -- . && git clean -fdq -e node_modules -e .agentpipe", cfg.repo, 60);
      log("  reverted the failed step's uncommitted changes");
    }
    if (!cfg.cloudEnabled) {
      log("  cloud disabled: cannot replan; stopping");
      stopped = true;
      break;
    }
    if (replans >= cfg.limits.replans) {
      log(`  replan limit (${cfg.limits.replans}) reached; stopping`);
      stopped = true;
      break;
    }
    replans++;
    log(`\n=== replan ${replans}/${cfg.limits.replans} after ${step.id} failed ===`);
    let revised;
    try {
      revised = await architectReplan(cfg, {
        task,
        originalPlan: plan,
        completedSteps: completed,
        failedStep: step,
        history: renderHistory(sr.history),
        remainingSteps: queue,
        keptChanges,
        replanNumber: replans,
      });
    } catch (e) {
      log(`  replan failed: ${(e as Error).message}`);
      stopped = true;
      break;
    }
    writeFileSync(path.join(runDir, `replan-${replans}.json`), JSON.stringify(revised, null, 2));
    log(`  assessment: ${revised.assessment}`);
    report.replans.push({ after: step.id, assessment: revised.assessment, gaveUp: revised.give_up, reason: revised.give_up_reason, newSteps: revised.steps.map((s) => `${s.id}: ${s.title}`) });
    if (revised.give_up) {
      log(`  architect gave up: ${revised.give_up_reason ?? "(no reason given)"}`);
      stopped = true;
      break;
    }
    // Ids must stay unique across the whole run so history files and commits stay readable.
    const used = new Set(report.steps.map((s) => s.id));
    for (const s of revised.steps) {
      let id = s.id;
      for (let i = 2; used.has(id); i++) id = `${s.id}-r${replans}${i > 2 ? `-${i}` : ""}`;
      s.id = id;
      used.add(id);
    }
    queue.splice(0, queue.length, ...revised.steps);
    plan.steps = [...completed, ...revised.steps];
    plan.risks.push(...revised.risks);
    log(`  revised remaining steps:`);
    for (const s of revised.steps) log(`    ${s.id}: ${s.title} [${s.files.map((f) => f.path).join(", ")}]`);
  }

  for (const s of queue) {
    report.steps.push({ id: s.id, title: s.title, status: "skipped", attempts: 0, commit: null, notes: ["skipped: run stopped earlier"], history: [] });
  }

  if (!stopped) {
    report.finalUnit = await runFullUnit(cfg);
    if (!report.finalUnit.ok) log("full unit suite failed after all steps");
    const diff = await diffSince(cfg.repo, baseSha);
    if (cfg.cloudEnabled && cfg.cloudFinalReview && diff.trim()) {
      report.finalReview = await cloudFinalReview(cfg, task, plan, baseSha);
      log(`final review:\n${report.finalReview}`);
    }
    report.ok = report.finalUnit.ok && (!report.finalReview || /VERDICT:\s*approve/i.test(report.finalReview));
  }

  log(`diff stat:\n${await diffStat(cfg.repo, baseSha)}`);
  writeReport(report);

  if (report.ok && cfg.push) {
    try {
      await pushBranch(cfg.repo, branch);
      log(`pushed ${branch} to origin`);
      const pr = await createPullRequest(cfg.repo, branch, startBranch, task, path.join(runDir, "report.md"));
      report.pushed = pr ?? `branch ${branch} pushed (no gh CLI or not authenticated: open the PR by hand)`;
      log(pr ? `pull request: ${pr}` : report.pushed);
      writeReport(report);
    } catch (e) {
      log(`push failed: ${(e as Error).message}`);
    }
  }

  log(`report: ${path.join(runDir, "report.md")}`);
  if (!report.ok) {
    log(`the repo is left on branch ${branch} for inspection. To discard everything from this run:\n    git checkout -- . && git clean -fd && git checkout ${startBranch} && git branch -D ${branch}`);
  }
  return report;
}

async function runStep(cfg: Config, step: PlanStep): Promise<StepReport> {
  log(`\n=== ${step.id}: ${step.title} ===`);
  const sr: StepReport = { id: step.id, title: step.title, status: "failed", attempts: 0, commit: null, notes: [], history: [] };
  const stepBase = await headSha(cfg.repo);
  let feedback: string | undefined;
  let reviewIssues: string | undefined;
  let lastChecks: CheckResult[] = [];
  let green = false;

  // Debug hook: AGENTPIPE_FORCE_FAIL=step-1 makes that step fail once without calling any model.
  if (process.env.AGENTPIPE_FORCE_FAIL === step.id) {
    delete process.env.AGENTPIPE_FORCE_FAIL;
    log("  forced failure (AGENTPIPE_FORCE_FAIL)");
    sr.attempts = 1;
    sr.history.push({ n: 1, actor: "coder", filesWritten: [], explanation: "(forced failure for testing)", checks: [{ name: "unit", ok: false, summary: "failed (exit 1)", output: "FAIL src/example.test.ts > example\nAssertionError: expected 1 to be 2\n  at src/example.test.ts:5:3", logPath: null, seconds: 0 }] });
    sr.notes.push("forced failure");
    return sr;
  }

  for (let attempt = 1; attempt <= cfg.limits.localAttempts && !green; attempt++) {
    sr.attempts = attempt;
    const rec: StepAttempt = { n: attempt, actor: "coder", filesWritten: [], explanation: "", checks: [] };
    sr.history.push(rec);
    log(`attempt ${attempt}/${cfg.limits.localAttempts} (${cfg.models.coder})`);
    try {
      const out = await runCoder(cfg, step, { feedback, reviewIssues }, attempt);
      rec.filesWritten = out.files.map((f) => f.path);
      rec.explanation = out.explanation;
      if (out.files.length === 0) {
        rec.error = "coder returned no files";
        feedback = "You returned no files. Return the full content of at least one writable file.";
        continue;
      }
    } catch (e) {
      rec.error = (e as Error).message;
      sr.notes.push(`coder error on attempt ${attempt}: ${(e as Error).message}`);
      feedback = `Your previous reply could not be used: ${(e as Error).message}`;
      continue;
    }
    lastChecks = await runFastChecks(cfg, step.unit_tests);
    rec.checks = lastChecks;
    if (failures(lastChecks).length) {
      feedback = formatFailures(lastChecks);
      reviewIssues = undefined;
      continue;
    }
    const diff = await diffSince(cfg.repo, stepBase);
    if (!diff.trim()) {
      rec.error = "no diff produced";
      feedback = "Your changes produced no diff. Implement the task.";
      continue;
    }
    const review = await runReviewer(cfg, step, diff);
    rec.review = { approved: review.approved, summary: review.summary, issues: formatIssues(review) };
    log(`  reviewer: ${review.approved ? "approved" : "changes requested"} - ${review.summary}`);
    const blocking = review.issues.filter((i) => i.severity !== "minor");
    if (review.approved || blocking.length === 0) {
      green = true;
    } else {
      reviewIssues = formatIssues(review);
      feedback = undefined;
      sr.notes.push(`review round ${attempt}: ${review.summary}`);
    }
  }

  if (!green && cfg.cloudEnabled) {
    const diff = await diffSince(cfg.repo, stepBase);
    const rec: StepAttempt = { n: sr.history.length + 1, actor: "fixer", filesWritten: [], explanation: "", checks: [] };
    sr.history.push(rec);
    try {
      const fix = await cloudFix(cfg, step, diff, lastChecks);
      rec.explanation = fix.summary;
      rec.checks = fix.lastChecks;
      rec.filesWritten = (await sh(`git diff --name-only ${JSON.stringify(stepBase)}`, cfg.repo, 30)).output.trim().split("\n").filter(Boolean);
      sr.notes.push(`cloud fixer: ${fix.summary.slice(0, 500)}`);
      if (fix.ok) {
        green = true;
        sr.status = "escalated-passed";
      }
    } catch (e) {
      rec.error = (e as Error).message;
      sr.notes.push(`cloud fixer error: ${(e as Error).message}`);
    }
  } else if (green) {
    sr.status = "passed";
  }

  if (green) {
    sr.commit = await commitAll(cfg.repo, `${step.title}\n\n${step.description.slice(0, 800)}\n\n[agentpipe ${sr.status}, ${sr.attempts} local attempt(s)]`);
    log(`  committed ${sr.commit ?? "(nothing)"}`);
    if (cfg.runE2e && step.e2e_specs.length) {
      const e2e = await runE2e(cfg, step.e2e_specs);
      sr.history.push({ n: sr.history.length + 1, actor: "e2e", filesWritten: [], explanation: `ran ${step.e2e_specs.join(", ")}`, checks: [e2e] });
      if (!e2e.ok) {
        sr.notes.push(`e2e failed after commit (full output: ${e2e.logPath ?? "n/a"})`);
        sr.status = "failed";
        log("  e2e failed; the commit is kept and the architect will be asked to replan");
      }
    }
  } else {
    sr.status = "failed";
    log("  step exhausted its attempts");
  }
  return sr;
}

/** Exact evidence for the architect: every attempt, every check output (clipped, with the full-log path), every review. */
function renderHistory(history: StepAttempt[]): string {
  const out: string[] = [];
  for (const a of history) {
    out.push(`## Attempt ${a.n} (${a.actor})`);
    if (a.filesWritten.length) out.push(`Files written: ${a.filesWritten.join(", ")}`);
    if (a.explanation) out.push(`Explanation: ${clip(a.explanation, 1500)}`);
    if (a.error) out.push(`Error: ${a.error}`);
    for (const c of a.checks) {
      out.push(`### ${c.name}: ${c.summary}${c.logPath ? ` (full output: ${c.logPath})` : ""}`);
      if (!c.ok) out.push("```\n" + c.output + "\n```");
    }
    if (a.review) out.push(`### Reviewer: ${a.review.approved ? "approved" : "changes requested"} - ${a.review.summary}${a.review.issues ? "\n" + a.review.issues : ""}`);
    out.push("");
  }
  return out.join("\n");
}

function logPlan(plan: Plan) {
  log(`plan: ${plan.steps.length} step(s). ${plan.summary}`);
  for (const s of plan.steps) log(`  ${s.id}: ${s.title} [${s.files.map((f) => f.path).join(", ")}]`);
  if (plan.risks.length) log(`risks:\n${plan.risks.map((r) => "  - " + r).join("\n")}`);
}

/** A run died before doing any work: go back to where we started and drop the empty branch. */
async function abandon(repo: string, startBranch: string, branch: string, planOnly?: boolean) {
  if (planOnly) return;
  try {
    await sh(`git checkout -q ${JSON.stringify(startBranch)} && git branch -D ${JSON.stringify(branch)}`, repo, 60);
    log(`nothing was changed; back on ${startBranch}, removed empty branch ${branch}`);
  } catch {
    /* leave it for the user */
  }
}

function writeReport(r: RunReport) {
  const lines = [
    `# agentpipe run: ${r.task}`,
    "",
    `- branch: \`${r.branch}\``,
    `- result: **${r.ok ? "OK" : r.steps.length ? "NEEDS ATTENTION" : "plan only"}**`,
    ...(r.pushed ? [`- pushed: ${r.pushed}`] : []),
    "",
    "## Plan",
    r.plan.summary,
    "",
    ...r.plan.steps.map((s) => `- **${s.id}** ${s.title} (${s.files.map((f) => f.path).join(", ")})`),
    ...(r.plan.risks.length ? ["", "Risks:", ...r.plan.risks.map((x) => `- ${x}`)] : []),
    "",
    "## Steps",
    ...r.steps.map((s) => {
      const head = `- **${s.id}** ${s.title}: ${s.status}, ${s.attempts} attempt(s)${s.commit ? `, commit ${s.commit}` : ""}`;
      const hist = s.history.map((a) => {
        const checks = a.checks.map((c) => `${c.name} ${c.ok ? "ok" : "FAIL"}`).join(", ");
        const rev = a.review ? `, review ${a.review.approved ? "approved" : "changes requested"}` : "";
        return `  - attempt ${a.n} (${a.actor}): ${checks || "no checks"}${rev}${a.error ? `, error: ${a.error.slice(0, 200)}` : ""}`;
      });
      const notes = s.notes.map((n) => "  - " + n.replace(/\n/g, "\n    "));
      return [head, ...hist, ...notes].join("\n");
    }),
    "",
    ...(r.replans.length
      ? [
          "## Replans",
          ...r.replans.map((p) => `- after **${p.after}**: ${p.assessment}${p.gaveUp ? `\n  - gave up: ${p.reason ?? ""}` : p.newSteps.length ? `\n  - new steps: ${p.newSteps.join("; ")}` : ""}`),
          "",
        ]
      : []),
    r.finalUnit ? `## Full unit suite: ${r.finalUnit.summary}` : "",
    r.finalReview ? `## Final review\n${r.finalReview}` : "",
    "",
    `Full check outputs: \`${path.join(r.runDir, "checks")}/\`; per-step attempt histories: \`${r.runDir}/<step>-history.json\`.`,
  ];
  writeFileSync(path.join(r.runDir, "report.md"), lines.join("\n") + "\n");
}
