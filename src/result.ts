import { z } from "zod";

/**
 * The one shape every agent run ends in, whatever the runtime. The worker files it, the
 * verifier inspects it, the architect reads it, the status page shows it.
 */
export const Subtask = z.object({
  title: z.string().describe("One line, imperative."),
  description: z
    .string()
    .describe("Self-contained instructions for the agent: exact files, names, behaviour, acceptance criteria. The agent sees nothing else about your reasoning."),
  agent: z.string().describe("Registered agent name."),
  acceptance: z
    .array(z.string())
    .min(1)
    .describe("Checkable statements that define done for this subtask, e.g. 'src/utils.test.ts covers below/above/in-range'. The agent, its verifier and the architect's review all read these."),
  priority: z.number().int().min(1).max(99).optional().describe("1 = most urgent, 99 = whenever. Default 50."),
  after: z.array(z.number().int().min(0)).optional().describe("0-based indexes of subtasks in this list that must finish (done) first. Their branch becomes this task's starting point."),
  files: z.array(z.string()).optional().describe("Repo-relative files the agent should look at first."),
  branch: z.string().optional().describe("For review agents: an existing branch to examine."),
});
export type Subtask = z.infer<typeof Subtask>;

export const Finding = z.object({
  severity: z.enum(["blocker", "major", "minor", "info"]),
  path: z.string().optional(),
  description: z.string(),
});
export type Finding = z.infer<typeof Finding>;

export const AgentResult = z.object({
  status: z.enum(["done", "attention", "failed"]).describe("done: assignment complete (subtasks, if any, carry on the work). attention: a human must look. failed: could not do it."),
  summary: z.string().describe("Markdown report for the human and the architect: what you found or did, with file paths."),
  findings: z.array(Finding).default([]),
  subtasks: z.array(Subtask).default([]),
});
export type AgentResult = z.infer<typeof AgentResult>;
