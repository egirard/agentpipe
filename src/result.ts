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

/**
 * A new project (stream of work) proposed by an agent allowed to create them. Code does the
 * creating: local steps run right away, anything touching GitHub waits for the human.
 */
export const ProjectSpec = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).describe("Kebab-case name. Use the name the human gave."),
  goal: z.string().min(20).describe("What the stream is for, in one to three sentences. Every agent working in it reads this."),
  kind: z
    .enum(["existing", "clone", "new", "branch"])
    .describe("existing: a git checkout already on disk at `path`. clone: clone `repo` into `path`. new: an empty repository at `path` (git init), plus a private GitHub repo if `repo` is set. branch: a long-lived branch of the `parent` project's repository."),
  path: z.string().optional().describe("existing/clone/new: absolute or ~/ path. Default ~/src/<name>."),
  repo: z.string().optional().describe("clone: the URL or owner/name to clone. new: owner/name of a GitHub repo to create (needs the human's approval)."),
  parent: z.string().optional().describe("branch: the registered project to branch from."),
  branch: z.string().optional().describe("branch: the stream branch name. Default: the project name."),
  base: z.string().optional().describe("existing/clone/new: branch tasks start from and pull requests target. Default: the repository's default branch, else main."),
  push: z.boolean().optional().describe("Open pull requests for green work. Default: the parent's setting for branch streams, true when there is a GitHub remote otherwise."),
  setup: z.string().optional().describe("Command run once per fresh worktree, e.g. 'bun install'."),
  link: z.array(z.string()).optional().describe("Entries of the main checkout to symlink into worktrees, e.g. node_modules."),
  kickoff: z.string().optional().describe("A first goal for the architect in the new stream, queued once the stream is set up. Omit to leave the stream idle."),
  make_current: z.boolean().optional().describe("Make it the current project. Only when the human asked to switch to it."),
});
export type ProjectSpec = z.infer<typeof ProjectSpec>;

export const Finding = z.object({
  severity: z.enum(["blocker", "major", "minor", "info"]),
  path: z.string().optional(),
  description: z.string(),
});
export type Finding = z.infer<typeof Finding>;

/**
 * An agent that does not exist yet, proposed by a delegating agent that found work no registered
 * agent can do. Nothing is created automatically: proposals are recorded, shown on the status page
 * and in the digest, and a human scaffolds the agent (`agentpipe agents new NAME --from ID`).
 */
export const AgentProposal = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).describe("Kebab-case name for the new agent, e.g. 'db-migrator'."),
  description: z.string().min(20).describe("One or two sentences a future architect could choose it by."),
  runtime: z.enum(["claude", "ollama", "shell", "pipeline"]).describe("claude: needs judgement or tools. ollama: a single local model call over given text. shell: one fixed command. pipeline: a coder loop with a different task prefix."),
  why: z.string().min(20).describe("Which part of the current work is impossible or awkward without it, and what it would unblock."),
  inputs: z.string().default("").describe("What a task description for it must contain."),
  outputs: z.string().default("").describe("What it would produce: a branch/PR, a report, a file."),
  commits: z.boolean().default(false).describe("Whether it would need to change files."),
  shell: z.array(z.string()).default([]).describe("Shell groups it would need (git-read, gh-read, gh-comment, checks, package-read)."),
});
export type AgentProposal = z.infer<typeof AgentProposal>;

export const AgentResult = z.object({
  status: z
    .enum(["done", "attention", "failed", "cancelled"])
    .describe(
      "done: assignment complete (subtasks, if any, carry on the work). attention: a human must decide or answer something before the work can continue; say exactly what. failed: you tried and could not do it (an error, a broken environment); a retry or a better specification might succeed. cancelled: the task cannot be done as specified and no retry will help (impossible, moot, contradicts the codebase, or needs a capability no agent has); say why and what would make it possible.",
    ),
  summary: z.string().describe("Markdown report for the human and the architect: what you found or did, with file paths."),
  findings: z.array(Finding).default([]),
  subtasks: z.array(Subtask).default([]),
  projects: z.array(ProjectSpec).optional().describe("Only for agents that may create projects: new streams to create."),
  agent_proposals: z.array(AgentProposal).optional().describe("Only for delegating agents: agents that do not exist yet but would make currently impossible work possible. A human creates them; never name them in subtasks."),
});
export type AgentResult = z.infer<typeof AgentResult>;
