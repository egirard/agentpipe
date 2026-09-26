import type { Config } from "../config.ts";
import { ollamaJson, type OllamaMessage } from "../ollama.ts";
import { CoderOutput, coderOutputSchema, type PlanStep } from "../plan.ts";
import { fileExists, readFile, safePath, writeFile } from "../repo.ts";
import { clip, log } from "../util.ts";

const SYSTEM = `You are a careful senior developer working on an existing codebase (the stack is described in the task).
You will be given one small task, the current contents of the files you may change, and a few read-only context files.
Rules:
- Return the COMPLETE new content of every file you change or create. Never return fragments, diffs, or placeholders like "...rest unchanged".
- Only write files listed as writable. Do not invent new files unless the task explicitly allows a new test file.
- Follow the existing code style exactly (imports, naming, 2-space indent, semicolons as in the file).
- Keep changes minimal and focused on the task. Do not refactor unrelated code.
- Follow the repository's existing test framework and conventions; the read-only context shows examples.
- Respond with JSON only: {"files":[{"path":"...","content":"..."}],"explanation":"..."}.`;

function fileBlock(path: string, content: string): string {
  return `<file path="${path}">\n${content}\n</file>`;
}

export function buildCoderContext(cfg: Config, step: PlanStep): { writable: string; readonly: string; overBudget: boolean } {
  let used = 0;
  const budget = cfg.limits.coderContextChars;
  let overBudget = false;
  const w: string[] = [];
  for (const f of step.files) {
    const exists = fileExists(cfg.repo, f.path);
    const content = exists ? readFile(cfg.repo, f.path) : "";
    used += content.length;
    w.push(exists ? fileBlock(f.path, content) : `<file path="${f.path}">\n(does not exist yet; create it)\n</file>`);
  }
  const r: string[] = [];
  for (const p of step.context_files) {
    if (!fileExists(cfg.repo, p)) continue;
    let content = readFile(cfg.repo, p);
    if (used + content.length > budget) {
      content = clip(content, Math.max(2000, budget - used));
      overBudget = true;
    }
    used += content.length;
    r.push(fileBlock(p, content));
    if (used >= budget) {
      overBudget = true;
      break;
    }
  }
  return { writable: w.join("\n\n"), readonly: r.join("\n\n"), overBudget };
}

export interface CoderRound {
  /** Test/lint output from the previous attempt, if any. */
  feedback?: string;
  /** Reviewer issues to address, if any. */
  reviewIssues?: string;
}

/** One local coder attempt. Writes the returned files to disk and returns what changed. */
export async function runCoder(cfg: Config, step: PlanStep, round: CoderRound, attempt: number): Promise<CoderOutput> {
  const ctx = buildCoderContext(cfg, step);
  if (ctx.overBudget) log(`  note: context clipped to ${cfg.limits.coderContextChars} chars`);

  const task = [
    `# Task: ${step.title}`,
    step.description,
    "",
    "## Acceptance criteria",
    ...step.acceptance.map((a) => `- ${a}`),
    "",
    `## Writable files (return full content for each you change)`,
    step.files.map((f) => `- ${f.path} (${f.action})`).join("\n"),
  ].join("\n");

  const messages: OllamaMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `${task}\n\n## Current writable files\n${ctx.writable}\n\n## Read-only context\n${ctx.readonly || "(none)"}` },
  ];
  if (round.feedback) {
    messages.push({
      role: "user",
      content: `Your previous attempt did not pass. The writable files above already contain your previous changes. Fix the problems below and return the corrected full files.\n\n${round.feedback}`,
    });
  }
  if (round.reviewIssues) {
    messages.push({ role: "user", content: `A reviewer raised these issues with your change. Address them:\n${round.reviewIssues}` });
  }

  const out = await ollamaJson(messages, { url: cfg.ollamaUrl, model: cfg.models.coder, numCtx: cfg.numCtx, schema: coderOutputSchema, label: `coder ${step.id} attempt ${attempt}` }, (v) =>
    CoderOutput.parse(v),
  );

  const allowed = new Set(step.files.map((f) => f.path));
  const written: CoderOutput["files"] = [];
  for (const f of out.files) {
    if (!allowed.has(f.path)) {
      log(`  coder tried to write ${f.path}, not in the allowed list; ignored`);
      continue;
    }
    safePath(cfg.repo, f.path);
    if (!f.content.trim()) {
      log(`  coder returned empty content for ${f.path}; ignored`);
      continue;
    }
    writeFile(cfg.repo, f.path, f.content.endsWith("\n") ? f.content : f.content + "\n");
    written.push(f);
  }
  log(`  coder wrote ${written.length} file(s): ${written.map((f) => f.path).join(", ") || "none"}`);
  return { files: written, explanation: out.explanation };
}
