import { z } from "zod";

/** The contract between the planner (cloud) and the workers (local). Steps must be small enough for a 7B model. */
export const PlanStep = z.object({
  id: z.string().describe("Short id like 'step-1'."),
  title: z.string().describe("One line."),
  description: z
    .string()
    .describe(
      "Precise instructions for a junior developer with no memory of the repo: what to change, where, exact names, and expected behaviour. Include code sketches for anything non-obvious.",
    ),
  files: z
    .array(
      z.object({
        path: z.string().describe("Repo-relative path."),
        action: z.enum(["create", "modify"]),
      }),
    )
    .describe("Files the coder is allowed to write. Keep to 1-3 small files per step."),
  context_files: z.array(z.string()).describe("Read-only files the coder needs to see (types, siblings, an example test). Keep small."),
  acceptance: z.array(z.string()).describe("Checkable statements a reviewer can verify from the diff."),
  unit_tests: z.array(z.string()).describe("Vitest files to run for this step (existing or ones this step creates). Empty = whole unit suite."),
  e2e_specs: z.array(z.string()).describe("Playwright spec paths this step must keep green, if any."),
});
export type PlanStep = z.infer<typeof PlanStep>;

export const Plan = z.object({
  summary: z.string(),
  steps: z.array(PlanStep).min(1),
  risks: z.array(z.string()),
});
export type Plan = z.infer<typeof Plan>;

/** What the architect returns after seeing a failure: a revised plan for the remaining work, or a reasoned stop. */
export const Replan = z.object({
  assessment: z.string().describe("What went wrong and why, in a few sentences, based on the exact outputs."),
  give_up: z.boolean().describe("True only if the task cannot be completed by this pipeline; explain in give_up_reason."),
  give_up_reason: z.string().optional(),
  steps: z.array(PlanStep).describe("Replacement for ALL remaining steps (including a retry of the failed one if still needed). Empty if give_up."),
  risks: z.array(z.string()),
});
export type Replan = z.infer<typeof Replan>;

/** JSON schema for Ollama's `format` field: what the local coder must return. */
export const coderOutputSchema = {
  type: "object",
  properties: {
    files: {
      type: "array",
      items: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
    explanation: { type: "string" },
  },
  required: ["files", "explanation"],
} as const;

export const CoderOutput = z.object({
  files: z.array(z.object({ path: z.string(), content: z.string() })),
  explanation: z.string(),
});
export type CoderOutput = z.infer<typeof CoderOutput>;

export const reviewOutputSchema = {
  type: "object",
  properties: {
    approved: { type: "boolean" },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["blocker", "major", "minor"] },
          path: { type: "string" },
          description: { type: "string" },
        },
        required: ["severity", "description"],
      },
    },
    summary: { type: "string" },
  },
  required: ["approved", "issues", "summary"],
} as const;

export const ReviewOutput = z.object({
  approved: z.boolean(),
  issues: z.array(z.object({ severity: z.enum(["blocker", "major", "minor"]), path: z.string().optional(), description: z.string() })),
  summary: z.string(),
});
export type ReviewOutput = z.infer<typeof ReviewOutput>;
