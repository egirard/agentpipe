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
  project: z.string().optional().describe("Another registered project (stream) to queue this subtask in, when the work belongs there: for example a stream this task just created. Default: the current project."),
});
export type Subtask = z.infer<typeof Subtask>;

/**
 * A repository to fetch read-only into a project, under `upstream/<name>/` in its checkout. Code
 * does the clone (a read, so it needs no approval); agents then reach the files like any other
 * file in the checkout, and the pinned commit is recorded in the project config.
 */
export const UpstreamSpec = z.object({
  repo: z.string().min(3).describe("owner/name on GitHub (private works through the gh login), or a git URL."),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional().describe("Directory name under upstream/. Default: the repository name in kebab-case."),
  ref: z.string().optional().describe("Branch or tag to check out. Default: the repository's default branch."),
  why: z.string().optional().describe("One line for the record: what the project needs it for."),
});
export type UpstreamSpec = z.infer<typeof UpstreamSpec>;

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
  setup: z.string().optional().describe("Command run once per fresh worktree, e.g. 'bun install'. Only for a repository that already has the toolchain it runs on; ignored for kind new."),
  link: z.array(z.string()).optional().describe("Entries of the main checkout to symlink into worktrees, e.g. node_modules."),
  upstreams: z.array(UpstreamSpec).optional().describe("Repositories to fetch read-only into the new stream's checkout under upstream/<name>/ (a template to scaffold from, a reference to read). Fetched at once; the kickoff can rely on them."),
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

/**
 * What an agent with `requires_confirmation` wants to do. Nothing in it runs until a human
 * approves it (status page or `agentpipe approve ID`); then code executes the steps exactly as
 * listed, in order, and records every output on the task. The agent never holds the permission
 * itself: it only ever proposes.
 */
export const ConfirmStep = z.object({
  kind: z.enum(["command", "write"]).describe("command: run a shell command. write: create or overwrite a file with the given content."),
  command: z.string().optional().describe("command steps: the exact command line, one purpose per step."),
  cwd: z.string().optional().describe("command steps: directory to run in, absolute or ~/ (default: the project's main checkout). Must be under the home directory."),
  path: z.string().optional().describe("write steps: absolute or ~/ path of the file. Must be under the home directory and not a credential file."),
  content: z.string().optional().describe("write steps: the complete file content."),
  why: z.string().min(1).describe("One line: what this step achieves."),
});
export type ConfirmStep = z.infer<typeof ConfirmStep>;

export const ConfirmationRequest = z.object({
  title: z.string().min(5).describe("One line the human sees first: what you want to do, e.g. 'Create github.com/egirard/tools and push main'."),
  why: z.string().min(20).describe("Why these steps, in a short paragraph, referring to the task."),
  risk: z.string().min(1).describe("What could go wrong, what is irreversible, and how to undo it. 'Nothing irreversible' when true."),
  steps: z.array(ConfirmStep).min(1).describe("Executed in order after approval; a failing step stops the rest."),
  links: z.array(z.string()).default([]).describe("URLs or paths with more detail (a PR, a spec, documentation you followed)."),
  continue_after: z.boolean().default(false).describe("true: after the steps ran, run this agent again with their output so it can check the result or finish the work. false: the task is done once the steps succeed."),
});
export type ConfirmationRequest = z.infer<typeof ConfirmationRequest>;

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
  upstreams: z.array(UpstreamSpec).optional().describe("Only for agents that may create projects: repositories to fetch read-only into THIS project's checkout under upstream/<name>/, so the agents working here can read them."),
  agent_proposals: z.array(AgentProposal).optional().describe("Only for delegating agents: agents that do not exist yet but would make currently impossible work possible. A human creates them; never name them in subtasks."),
  confirmation: ConfirmationRequest.optional().describe("Only for agents that require confirmation: the exact steps you want run, for the human to approve. Use with status attention."),
});
export type AgentResult = z.infer<typeof AgentResult>;
