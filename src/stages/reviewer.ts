import type { Config } from "../config.ts";
import { ollamaJson, type OllamaMessage } from "../ollama.ts";
import { ReviewOutput, reviewOutputSchema, type PlanStep } from "../plan.ts";
import { clip } from "../util.ts";

const SYSTEM = `You are a strict code reviewer. You receive a task, its acceptance criteria, and a unified diff.
Judge only what is in the diff. Check: every acceptance criterion is met; no unrelated changes; no obvious bugs, typos, or leftover debug code; TypeScript types look sound; tests actually assert behaviour.
Be concrete: each issue names the file and what is wrong. Mark "blocker" only for things that make the change wrong or incomplete.
Approve when there are no blockers or majors.
Respond with JSON only: {"approved":bool,"issues":[{"severity":"blocker|major|minor","path":"...","description":"..."}],"summary":"..."}`;

export async function runReviewer(cfg: Config, step: PlanStep, diff: string): Promise<ReviewOutput> {
  const messages: OllamaMessage[] = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: [
        `# Task: ${step.title}`,
        step.description,
        "",
        "## Acceptance criteria",
        ...step.acceptance.map((a) => `- ${a}`),
        "",
        "## Diff",
        "```diff",
        clip(diff, cfg.limits.coderContextChars),
        "```",
      ].join("\n"),
    },
  ];
  return ollamaJson(messages, { url: cfg.ollamaUrl, model: cfg.models.reviewer, numCtx: cfg.numCtx, schema: reviewOutputSchema, label: `review ${step.id}` }, (v) =>
    ReviewOutput.parse(v),
  );
}

export function formatIssues(r: ReviewOutput): string {
  return r.issues.map((i) => `- [${i.severity}] ${i.path ? i.path + ": " : ""}${i.description}`).join("\n");
}
