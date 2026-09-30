# Agents: design and authoring guide

An agent is a named, single-skill worker that the queue can hand a task to. It advertises what it
is good for, receives one task, does the work, and reports back in one fixed shape: success with
whatever it produced, or a failure that says why and what should happen next. Some agents
complete their assignment by creating tasks for other agents instead of doing the work
themselves.

This document describes how agents are built, what happens when one runs, and how to write a
good one. The code it describes lives in `src/registry.ts` (manifests), `src/runner.ts` (execution),
`src/result.ts` (the result shape), `src/verify.ts` (verification), `src/testkit.ts` (tests),
`src/worker.ts` (scheduling and bookkeeping) and `src/architect.ts` (review).

## 1. The model in one page

```
 registry (src/agents/<name>/)              queue (SQLite)
 ┌──────────────────────────────┐          ┌───────────────────────────────┐
 │ architect   claude  delegate │          │ #12 architect  "Add skip turn"│
 │ coder       pipeline         │  picks   │ #13 coder      ... waiting on │
 │ code-reviewer claude delegate│◀─────────│ #14 code-reviewer  after #13  │
 │ e2e-runner  shell            │          │ ...                           │
 └──────────────────────────────┘          └───────────────┬───────────────┘
                                                            │ worker claims next runnable task
                                                            ▼
                                   ┌─────────────────────────────────────────┐
                                   │ 1. put the checkout on the right branch │
                                   │ 2. build the prompt / command from the  │
                                   │    task + manifest.context              │
                                   │ 3. run the runtime                      │
                                   │ 4. validate the AgentResult             │
                                   │ 5. run the agent's verifier             │
                                   │ 6. checks, commit, push, PR (if commits)│
                                   │ 7. record status, create subtasks       │
                                   └─────────────────┬───────────────────────┘
                                                     ▼
                       done  ──▶ asset: branch / PR / report          (success)
                       attention ──▶ a human decides or answers        (escalation; a reply resumes it)
                       failed ──▶ could not do it; error in the record (error; retry may work)
                       cancelled ──▶ impossible or moot; reason in the record (no retry will help)
                       waiting ──▶ children run; architect reviews the outcome later
```

Three ideas carry everything:

- **A manifest advertises the skill.** The architect reads the manifest, never the prompt, when
  deciding whom to give a task. If the manifest is vague the agent is picked wrongly or never.
- **A runtime does the work.** Four exist: the coder pipeline, a Claude Code session, a local
  Ollama call, a shell command. The manifest chooses one; the worker adapts the rest.
- **One result shape.** Whatever the runtime, the worker ends up with an `AgentResult`: a status,
  a human-readable summary, findings, optional subtasks, and (for delegating agents) proposals
  for agents that should exist. Everything downstream (status page, architect review, PR bodies)
  is built on that shape.

## 2. Anatomy of an agent

An agent is a directory named after it. The manifest is required; the rest depends on the
runtime and on how much the agent needs around it:

```
src/agents/code-reviewer/
  agent.json        manifest: what the agent advertises and how it runs (required)
  prompt.md         system prompt (required for claude and ollama runtimes)
  verify.ts         output verification: default export from defineVerifier (section 3.5)
  tests/            bun tests: cheap checks always, the real run behind AGENTPIPE_E2E=1 (section 4.7)
  README.md         optional notes for humans
  ...               anything else: helper scripts, supplemental prompts, fixtures, checklists
```

Helper files are the agent's own business: a shell agent's `command` can call a script in its
directory (the directory arrives as `AGENTPIPE_AGENT_DIR`), a prompt can tell a Claude agent to
read a checklist kept next to it, a verifier can import a shared module. Files other than the
well-known ones are listed as "extras" in `agentpipe agents show` and on the status page, so a
reader can see an agent's full footprint at a glance.

A bare `<name>.json` (plus `<name>.md`) is still accepted for a quick local experiment, but it has
no verifier, no tests and no place for helpers; promote it to a directory before relying on it.

Registry directories, merged in this order with later ones overriding earlier ones by name:

| Directory | Purpose |
|---|---|
| `<agentpipe>/src/agents/` | built-ins, versioned with this repository |
| `~/.config/agentpipe/agents/` | agents for this machine |
| the project's `agentsDir` (set in `~/.config/agentpipe/agentpipe.json`) | agents for one project |

`agentpipe agents` lists what loaded (with verifier and test columns) and every manifest problem;
`agentpipe agents show NAME` prints one agent with its prompt, verifier and extra files;
`agentpipe agents new NAME --runtime …` writes a complete package skeleton (manifest, prompt,
verifier, test) into the machine directory or `--dir`; `agentpipe agents test [NAME] [--e2e]`
runs its tests. A manifest with `"enabled": false` removes an agent of that name, which is how
a built-in is switched off without deleting it.

### 2.1 The manifest

Validated against `AgentManifest` in `src/registry.ts`. Unknown fields are rejected.

| Field | Type, default | Read by | Meaning |
|---|---|---|---|
| `name` | kebab-case string | everyone | Must equal the directory name. |
| `description` | string, min 10 chars | architect, humans | One or two sentences: what the agent does and produces. **This is the advertisement.** |
| `runtime` | `pipeline` \| `claude` \| `ollama` \| `shell` | worker | How the work gets done (section 3). |
| `when_to_use` | string | architect | When this agent is the right choice, and when it is not. |
| `inputs` | string | architect | What a task description for this agent must contain. The architect writes tasks to this contract. |
| `outputs` | string | architect, humans | What comes back: a branch/PR, a report, subtasks. |
| `can_delegate` | bool, false | worker | May create subtasks. Ignored for `ollama`. |
| `can_create_projects` | bool, false | worker | May return `projects`: new streams of work (section 3.9). `claude` runtime only; adds the `projects` context. |
| `commits` | bool, false | worker | May change files. Gets a branch, verification, lint + unit tests, a commit, and a PR. Ignored for `ollama`. |
| `model` | string, "" | runtime | Claude alias (`opus`, `sonnet`) or Ollama model name. Empty = the project's default. |
| `tools` | string[], [] | claude runtime | Extra non-shell Claude Code tools. `Bash(...)` entries are refused at load time. |
| `shell` | string[], [] | claude runtime, shell runtime | Shell capability groups (section 3.8): `git-read`, `gh-read`, `gh-comment`, `checks`, `package-read`; `ops` is reserved for `shell-runner`. |
| `paths` | string[], [] | worker | Globs the agent may change (`commits` and `pipeline` agents). Any other changed file fails verification, before the agent's own verifier runs. |
| `lane` | string, "" | worker | Which worker lane runs it: `gpu` (default for pipeline and ollama) or `cloud` (default for claude and shell). |
| `max_turns` | int, 40 | claude runtime | Agentic turns before Claude Code stops. |
| `timeout_sec` | int, 2700 | claude, shell | Wall-clock limit for the run. |
| `context` | list, `["repo-overview","files","branch-diff"]` | prompt builder | What the worker adds to the prompt (section 3.6). `catalog` is added automatically when `can_delegate`, `projects` when `can_create_projects`. |
| `task_prefix` | string, "" | pipeline runtime | Text prepended to the task before the pipeline plans it. |
| `command` | string | shell runtime | The command to run. |
| `prompt` | string, "" | claude, ollama | Inline system prompt; normally left empty in favour of `prompt.md`. |
| `verify` | string, "" | worker | Output verification (section 3.5): a `.ts`/`.js` path relative to the agent directory whose default export is `(ctx) => problems[]`, or a shell command (exit 0 = pass). Default: `verify.ts` in the agent directory when present. |
| `tags` | string[] | humans | Free-form grouping. |
| `enabled` | bool, true | registry | `false` hides the agent (and any lower-precedence agent of the same name). |

### 2.2 The prompt

`prompt.md` is the agent's system prompt. It is appended to Claude Code's own system prompt
(`--append-system-prompt`) or sent as the `system` message to Ollama. The worker adds two things
after it, so the prompt should not restate them:

- a one-line permission footer: "You may edit files. Do not run git commit/push…" for `commits`
  agents, "You are read-only: do not modify files." for the rest;
- in the user message, the task itself, the requested context, the delegation rules (if
  `can_delegate`) and the result rules that describe the JSON to return.

## 3. How an agent runs

### 3.1 Being chosen

Tasks arrive in the queue from `agentpipe add`, from a delegating agent's subtasks, or from the
architect's review. Each task names its agent. The worker takes the runnable task with the lowest
priority number (oldest first on ties) whose dependencies are all `done`, loads the registry for
the task's project, and looks the agent up. A task naming an agent that is not registered fails
immediately with that reason.

### 3.2 The worktree

Every task runs in a private git worktree of its project, created by the worker and removed
when the task ends (the branch survives). The human's checkout is never touched, and tasks from
any projects run side by side. Before the run the worker:

1. fetches `origin` in the main checkout (a failure is logged, not fatal);
2. starts the worktree from `origin/<base>` (or the local base without a remote), **or** from a
   dependency's branch when the task was queued `after` a task that produced one (stacked work);
   in that case a task with no `branch` of its own inherits the dependency's branch, so review
   agents see the right diff;
3. symlinks the project's installed dependencies into the worktree (`link`, default
   `node_modules`) and runs the project's `setup` command if it has one;
4. for `commits` agents, creates `agentpipe/<agent>-<slug>-<date>` there.

Run directories live under the *main* checkout's `.agentpipe/runs/`, so they outlive the
worktree. If the project is unusable (not a git checkout, setup failing) the task goes back to
the queue and the lane pauses; that is a project problem, not the task's.

### 3.3 The runtimes

**pipeline.** The task text (`task_prefix` + title + description + files) goes through
`runPipeline`: Claude Code plans small steps, the local coder writes each step, lint and targeted
tests gate it, a local reviewer checks the diff, Claude fixes stuck steps and reviews the whole
at the end. Result mapping: a fully green run is `done`; anything else is `attention` with a
blocker finding per failed step and one for an architect that gave up. The summary is the
pipeline's `report.md`. Assets: the branch, one commit per step, the PR when the project pushes.
This runtime ignores `prompt`, `tools`, `can_delegate` and `commits` (it always commits).

**claude.** One headless Claude Code session (`claude -p`) in the worktree, held to the result
schema with `--json-schema`. Tools: `Read`, `Grep`, `Glob`, `LS` always; `Edit`, `Write`,
`MultiEdit` when `commits`; shell commands only through the manifest's `shell` groups (section
3.8), plus whatever non-shell `tools` lists. Permission mode is `acceptEdits` for `commits`
agents and `dontAsk` otherwise, so nothing ever waits for a human. Every Claude call's cost is
recorded against the task; a task that reaches `budgets.taskUsd` has its next call refused and
ends in `attention`. A reply that is not valid JSON becomes `attention` with the raw text in the
summary rather than a crash.

**ollama.** One chat call to the local model with the same prompt material, clipped to fit the
small context window, constrained to the result schema by Ollama's `format` field. Cheap and
offline, but a 7B model cannot be trusted to delegate or edit, so `subtasks` are dropped and
`commits` is refused at load time. Good for quick diff reviews and classification.

**shell.** `command` is checked against the policy (with the manifest's groups plus `ops`; a
refusal is `failed` with the reason) and then runs with `bash -lc` in the worktree with the task
in environment variables: `AGENTPIPE_TASK_ID`, `AGENTPIPE_TASK_TITLE`,
`AGENTPIPE_TASK_DESCRIPTION`, `AGENTPIPE_TASK_ACCEPTANCE`, `AGENTPIPE_TASK_FILES`
(space-joined), `AGENTPIPE_TASK_BRANCH`, `AGENTPIPE_BASE_BRANCH`, `AGENTPIPE_PROJECT`,
`AGENTPIPE_REPO`, `AGENTPIPE_AGENT_DIR`. Credentials are stripped from the environment. Exit 0
is `done`, anything else `attention`; the output (clipped) is the summary and the full output is
saved under the run directory. No model is involved.

### 3.4 The result contract

Every runtime ends in this shape (`AgentResult` in `src/result.ts`):

```jsonc
{
  "status": "done" | "attention" | "failed" | "cancelled",
  "summary": "markdown for the human and the architect",
  "findings": [ { "severity": "blocker"|"major"|"minor"|"info", "path": "optional/file", "description": "..." } ],
  "subtasks": [ { "title": "...", "description": "...", "agent": "coder",
                  "acceptance": ["src/x.test.ts exists and passes", "bun run lint is green"],
                  "priority": 40, "after": [0], "files": ["src/x.ts"], "branch": "agentpipe/..." } ],
  "projects": [ ... ],          // only agents with can_create_projects (section 3.9)
  "agent_proposals": [ { "name": "db-migrator", "runtime": "claude", "description": "...", "why": "...",
                         "inputs": "...", "outputs": "...", "commits": true, "shell": ["checks"] } ]   // only can_delegate agents
}
```

What each status means, and what the worker does with it:

| Status | Meaning | Worker action |
|---|---|---|
| `done` | The assignment is complete. For a delegating agent, laying out the subtasks *is* completing it. | Record; push and open a PR if `commits` and the project pushes; if subtasks were created the task becomes `waiting`, otherwise `done`. Dependants become runnable. |
| `attention` | The agent got somewhere but a human must decide or answer before work continues: an ambiguous requirement, a design choice, an environment problem, a change it is not allowed to make (screenshot baselines), repeated failure, an agent that has to be created first. | Record; keep any branch but never push; dependants become `blocked`; the task appears under "needs you" and in the next architect review. The human's `reply` requeues it, and the next run sees the previous report and the reply (section 3.6). |
| `failed` | The agent tried and could not: an error, a broken environment. A retry or a better specification might succeed. | Record with the summary as the error; dependants become `blocked`; reviewed by the architect, who may retry or re-specify. |
| `cancelled` | The task cannot be done as specified and no retry would help: impossible in this repository, moot, contradicts the codebase, or needs a capability no agent has (then propose the agent). The summary says why and what would make it possible. | Record with the reason as the error; dependants become `blocked`; the human is notified; the architect confirms, re-plans or escalates on its next review. Leaves "needs you"; does not count against the agent's track record. |

`agent_proposals` is how a delegating agent says "this needs an agent that does not exist".
Proposals are recorded (deduplicated by name while open), listed in the task's summary and
events, in the digest, on the status page and in `agentpipe agents proposals`. Nothing is
created automatically; `agentpipe agents new NAME --from ID` scaffolds the package from the
proposal. The architect's verifier refuses proposals for names that already exist and subtasks
that name a proposed agent.

Two more outcomes are decided by the worker, not the agent:

- **Crash** (the runtime threw: Ollama down, Claude returned garbage, a timeout). Transient-looking
  errors are requeued up to `worker.maxAttempts`; the rest become `failed`. A task that exhausts
  its Claude budget ends in `attention`, not a retry.
- **Path policy violated** (`paths` set in the manifest). A changed file outside the allowed globs
  is a verification problem like any other: `attention`, no push.
- **Output verification failed** (any runtime with a verifier). The agent's own `verify.ts`
  found problems with what was produced. The status is forced to `attention`, each problem becomes
  a blocker finding prefixed "output verification:", the branch (if any) is committed for
  inspection, and nothing is pushed. Section 3.5.
- **Checks failed after edits** (`commits` agents only). Lint or the unit suite failed on the
  agent's changes. The branch is committed for inspection, the status is forced to `attention`,
  and the failing output is appended to the summary.

Where the pieces land:

| Piece | Where |
|---|---|
| status, summary, branch, PR URL, error, timings | the task record (`agentpipe show ID`, status page, `/api/task/ID`) |
| findings and subtasks | `report.md` and `result.json` in the run directory; blockers are counted in the task's event log |
| verification outcome | `verification.json` in the run directory, the "verification:" line of `report.md`, and the task's event log |
| everything the model saw and said | `run.log` in the run directory |
| full check outputs | `checks/` in the run directory |
| the run directory itself | `<repo>/.agentpipe/runs/<stamp>-<agent>-<slug>/` (pipeline runs: `<stamp>-<slug>/`) |

So "success with an asset" is: `done` plus a branch/PR (code agents) or a `report.md` (review and
analysis agents). "Failure with an error log" is: `failed` with the error in the record and the
log on disk. "Feedback report" is: `findings` with paths and severities. "Escalation" is:
`attention` with a summary that says exactly what a human must decide.

### 3.5 Output verification

Most agents promise something concrete: a branch with committed code, documentation edits and
nothing else, a review whose blockers name files, a plan whose subtasks a stranger can act on.
The verifier is where that promise is checked by code instead of taken from the model's own
report. It runs once per task, after the runtime has returned and (for agents that change files)
before anything is committed or pushed, and receives everything there is to look at:

```ts
// src/agents/docs-writer/verify.ts
import { defineVerifier, nonEmptySummary, onlyPaths, requireChanges } from "../../verify.ts";

export default defineVerifier(async (ctx) => {
  const problems = [...nonEmptySummary(ctx.result, 60), ...onlyPaths(ctx.changedFiles, ["**/*.md", "docs/**"], "non-documentation")];
  if (ctx.result.status === "done") problems.push(...requireChanges(ctx.changedFiles, "documentation changes"));
  return problems;                 // [] means the output is acceptable
});
```

`ctx` (`VerifyContext` in `src/verify.ts`) carries the task (including its acceptance criteria),
the parsed result, the manifest, the worktree path, the agent directory, the run directory, the
branch and base commit, the list of changed files (committed or not), and helpers: `diff()`,
`read(path)`, `exists(path)`, `sh(cmd)`. The manifest's `paths` allowlist is applied by the
worker before the verifier runs and its problems are merged into the same outcome.
The return value is a list of problems in plain language; an empty list passes.

What a failed verification does: the status becomes `attention` (never `done`), each problem is
added as a blocker finding, the summary gets an "Output verification failed" section, the branch
is committed so a human can look, and the push and pull request are skipped. The architect's
review sees the problems verbatim and can re-specify or retry.

Verifiers are deliberately cheap and deterministic: file lists, globs, string checks, a git
command, a parse. They do not call models. The library in `src/verify.ts` covers the common
cases: `onlyPaths`, `forbidPaths`, `requirePaths`, `requireChanges`, `noChanges`,
`nonEmptySummary`, `findingsHavePaths`, `subtasksActionable`, `svgWellFormed`. A shell verifier
(`"verify": "./check.sh"`) gets the same information through `AGENTPIPE_*` environment variables
including `AGENTPIPE_RESULT_JSON` and `AGENTPIPE_CHANGED_FILES`, and fails on a non-zero exit.

What the built-ins verify:

| Agent | Verifier checks |
|---|---|
| architect | no file changes; `done` implies at least one subtask or project; branch streams name a parent and clones a repo; every subtask description is long enough to act on and does not say "see above"; coder subtasks mention tests |
| coder | `done` implies changed files and commits on the branch; no screenshot baseline touched |
| unit-tester | only test files changed; `done` implies at least one |
| docs-writer | only documentation files changed; `done` implies at least one |
| project-setup | only `agentpipe.json` and `AGENTPIPE.md` changed; the JSON parses and has non-empty lint and unit commands; the notes are substantial. The worker then runs the commands it wrote |
| graphics-designer | only vector and style files changed; every changed SVG has a viewBox and no editor metadata or scripts |
| code-reviewer, a11y-reviewer, ux-reviewer | no file changes; a substantial summary; every blocker or major finding names a file; subtasks are actionable |
| project-manager, gitbot, local-reviewer | no file changes; a substantial summary |
| e2e-runner | none: the exit code of the suite is the verification |

### 3.6 What the prompt contains

The user message is assembled from the task and `manifest.context`, in this order:

1. **Task block** (always): `# Task #id: title`, the description, the acceptance criteria, the
   **continuation** when the task ran before or a human replied (below), the
   project (name, path, base branch or stream branch and parent, the stream's goal, the branch the
   worktree is on, a one-line stack summary read from the package manifest), the repository's `AGENTPIPE.md` notes if it has one, and the parent
   task if any.
2. `files`: the contents of the task's `files`, inline, clipped to the project's
   `limits.coderContextChars` in total; missing files are listed as such.
3. `branch-diff`: when the task has a branch, `git diff base...branch` clipped to 40k characters.
4. `repo-overview`: directories with file counts (the same overview the pipeline's planner gets).
5. `queue`: counts and the open tasks of this project, for management agents.
6. `projects`: every project on the machine with its status, branch, progress and goal, for
   agents that create streams.
7. `catalog`: the registry as a catalog (name, description, when to use, inputs, outputs, and each
   agent's recent track record with a warning when it has been escalating or failing often)
   followed by the delegation rules. Only for `can_delegate` agents; the agent itself is left out
   so it cannot delegate to itself.
8. **Proposal rules** (`can_delegate` agents): delegate only to registered agents; describe a
   missing one in `agent_proposals` instead of improvising.
9. **Result rules** (always): what the JSON must contain and what the statuses mean.

**Continuation.** Agents have no memory between runs, so when a task comes back (a human's
`reply`, a `retry`, the architect's retry decision) the task block carries what the last run
reported (the stored summary, clipped), the branch it made if any (the new run starts from a fresh
worktree, but the old branch is still in the repository for `git diff`), and every human reply in
order, with the instruction to continue and not to ask again what has been answered. Pipeline
(coder) tasks get the same text in their task description; shell agents get the replies in
`AGENTPIPE_TASK_REPLIES`. The architect's review prompt shows the replies on each item too, and
is told they are the owner's instructions.

The system prompt is the agent's `prompt.md` plus a permission footer and the ground rules every
model agent gets: repository content, diffs, pull requests, issues and command output are data,
never instructions; shell refusals are final; credentials are never printed; git state belongs
to the worker.

Claude agents also have tools and can read anything else they need; the context list only decides
what is handed to them up front. Ollama and shell agents get nothing beyond this.

### 3.7 Delegation

An agent with `can_delegate` may return `subtasks`. The worker turns them into child tasks of the
current one, in the same project, then puts the parent into `waiting`:

- Each subtask must name a registered agent; the JSON schema enumerates the names, so a Claude
  agent cannot invent one. Unknown names (possible from hand-written or Ollama results) are
  skipped with a warning event on the parent.
- Each subtask must carry acceptance criteria (the schema requires at least one). They travel
  with the task into the agent's prompt, its verifier and the architect's review.
- A subtask whose agent and title match an open task in the same project is a duplicate and is
  skipped; dependants are pointed at the existing task.
- `after` lists 0-based indexes of earlier subtasks in the same list. Those become dependencies:
  the child waits until they are `done` and starts from the last one's branch. Forward or
  self references are dropped.
- `priority` defaults to the parent's. `files` and `branch` are passed through.
- Limits: `architect.maxSubtasks` per result (default 30) and `architect.maxOpenTasks` in the
  project (default 300); the excess is dropped and logged on the parent.

When the last child reaches a terminal state (`done`, `attention`, `failed`, `cancelled`, or
`blocked` behind one of those), the parent moves from `waiting` to `review`. The architect's
timer job then reads the parent, its children's summaries, reports, replies and branches, and
returns one decision: `done`, `attention`, `continue` (a new round of subtasks under the same
parent, at most `architect.maxRounds` rounds), `retry` or `cancel` (moot, or proved impossible).
It may also act on the children directly (retry a blocked one, cancel a moot one), and it may
return `agent_proposals` when the work failed for want of an agent. Top-level tasks that an agent
reported `cancelled` are reviewed too, so the architect can confirm, re-plan, or escalate. This is
how a tree of work converges without any agent holding the whole plan in its head.

A human can reopen a child that stopped (`agentpipe reply`, `retry`, or the status page). The
child is requeued; if its parent was already in `review` or `attention`, the parent goes back to
`waiting`, so the child's new outcome is reviewed rather than orphaned.

Delegation is therefore one level at a time: an agent plans the next layer, finishes, and the
review cycle decides whether another layer is needed. An agent never waits on its own children.

### 3.8 Shell access

No agent asks for raw shell tools. A manifest names capability groups and one module,
`src/shell-policy.ts`, decides what those groups permit:

| Group | Permits |
|---|---|
| `git-read` | `git diff`, `log`, `show`, `status`, `blame`, `branch --list`, `merge-base`, `fetch` and the other read-only verbs |
| `gh-read` | `gh pr list/view/checks/diff`, `gh issue list/view`, `gh run list/view` |
| `gh-comment` | `gh pr comment`, `gh issue comment` |
| `checks` | the project's lint and unit commands, `bunx vitest`, `bun test` and the usual linters; added automatically for `commits` agents |
| `package-read` | `bun outdated`, `npm view`, version queries |
| `ops` | installs with the lockfile, builds, `bun run <script>`, test suites, file inspection inside the checkout; **shell-runner only** |

The policy is enforced twice for Claude agents: the groups become `--allowedTools` patterns, and
a PreToolUse hook (`agentpipe shell-check`) inspects every Bash call before it runs, splitting
pipelines into segments and checking each against the groups. A deny list is applied before any
group and cannot be overridden: privilege escalation, recursive deletes, any git command that
changes the tree or refs, any `gh` command that changes state or exposes credentials, network
tools, piping downloads into a shell, command substitution, redirecting output to files,
reading environment variables that look like secrets, credential files, inline script
execution, and leaving the checkout. A blocked call is reported to the model with the reason and
counted in the run log; the model is told a refusal is final.

`shell-runner` is the one agent with `ops`. Other agents that need a build, an install, a full
test suite or a scripted check delegate a subtask to it with the exact command and the reason.
Its prompt makes it vet each command against the same rules before running it, and the hook
checks again. Shell-runtime agents (a fixed `command`) and shell verifiers pass through
`checkCommand` too. Secrets (`CLAUDE_CODE_OAUTH_TOKEN` and friends) are stripped from the
environment of every subprocess an agent influences.

### 3.9 Lanes, budgets, projects

**Lanes.** The worker runs one task per lane slot concurrently: by default `gpu` x1 (pipeline and
ollama agents, which share the one GPU) and `cloud` x1 (claude and shell agents). Raise
`worker.lanes.cloud` when Claude is the idle resource. Worktrees make this safe; the queue's
claim is atomic, and dependencies are respected across lanes.

**Budgets.** Every Claude call's cost (as reported by Claude Code) is recorded per task, agent and
project. `budgets.taskUsd` caps one task; `budgets.dailyUsd` caps the UTC day, after which lanes
only claim agents that do not spend (ollama, shell) until the next day. `agentpipe spend` and the
status page show the numbers.

**Track record.** Each task records the hash of the agent's manifest, prompt and verifier
(`agent_version`), so outcomes are comparable per version. The architect's catalog shows each
agent's last `budgets.agentWindow` outcomes and a warning when the share needing intervention
exceeds `budgets.agentAttentionRate`; the same threshold raises a check on the status page and
a notification once a day.

**Projects.** A project is a stream of work: a repository in its own directory, or a long-lived
branch of another project (`parent`; its `base` is the stream branch, so task PRs target it). Any
number share the queue and the worker. The current project (`agentpipe use NAME`) is what commands
default to, and the worker claims its tasks first; `paused` and `archived` projects, and projects
holding a GitHub step for approval, are not claimed from at all. The worker rereads the config
before every claim. Register one with `agentpipe projects add NAME PATH [--base main] [--push] [--link node_modules] [--setup "bun install"] [--agents-dir DIR]`,
or `projects create` (clone, new, branch), or let an agent with `can_create_projects` (the
architect) return `projects`: code creates each one, runs the local steps, holds GitHub steps
for `agentpipe projects approve`, and queues `project-setup` and a kickoff architect task in it.
Every agent's prompt carries the stream's goal.
A project can carry its own agents (`agentsDir`), its own pipeline tuning (`agentpipe.json` in
the repo) and its own guidance for agents (`AGENTPIPE.md` at the repo root, read into every
prompt: conventions, forbidden areas, how to run things). Prompts describe the stack from the
package manifest instead of assuming one.

**Notifications.** `notifications.webhook` (POSTed JSON, works with Discord, Slack, ntfy and
similar) and `notifications.command` receive: a task ending in `attention` or `failed`, the
architect's digest, the daily budget being reached, an agent crossing the health threshold, and
a project the worker cannot use.

## 4. Authoring guidelines

### 4.1 One skill, advertised precisely

- Name the agent after what it does to what: `a11y-reviewer`, `changelog-writer`, `e2e-runner`.
  Not `helper`, not `assistant`, not `agent2`.
- Write `description` for a reader choosing between fifteen agents in a hurry: the verb, the
  object, the output. "Audits Svelte components for accessibility and files coder tasks for
  mechanical fixes" beats "Helps with accessibility".
- Put the negative cases in `when_to_use`: "Not for non-UI changes." "Not for diffs over a few
  hundred lines." The architect's most common mistake is sending work to a nearly-right agent.
- `inputs` is a contract. If the agent needs a branch, say so; if it needs to know who the user
  is, say so. The architect writes task descriptions to match.
- `outputs` should let a reader predict what `agentpipe show` will contain afterwards.

If you cannot write these four fields in a few lines, the agent is doing two jobs. Split it.

### 4.2 Choosing a runtime

| You want the agent to… | Runtime | Notes |
|---|---|---|
| change source code with tests | `pipeline` | Steer it with `task_prefix` (this is all `unit-tester` is). Do not write a `claude` agent that edits `.ts` files; the pipeline's step discipline and local loop exist for that. |
| read, judge, plan, report | `claude` with `commits: false` | The default for reviewers, auditors, planners, managers. |
| edit non-code files (docs, SVG, config) | `claude` with `commits: true` | Lint and the unit suite still run afterwards; the prompt must fence what may be touched, since tools cannot. |
| give a cheap, offline opinion | `ollama` | Small inputs only. Escalate anything serious to a `claude` reviewer in the prompt's own words. |
| run a program and report its exit code | `shell` | Test suites, linters, builds, scripted checks. The command is policy-checked; anything it needs beyond `ops` will not run. |
| run arbitrary-but-vetted commands for other agents | delegate to `shell-runner` | Do not create a second agent with `ops`; the registry refuses it. |

Rules of thumb: prefer the cheapest runtime that can do the job; keep `max_turns` tight (a
reviewer rarely needs more than 30); pin `model: "sonnet"` for high-volume, low-stakes roles and
leave the project default (opus) for planning and final judgement.

### 4.3 Writing the prompt

A good prompt has five parts, in this order, and fits on one screen:

1. **Role.** One sentence: who the agent is and in what setting ("…reviewing a Svelte web
   application by reading its source; you cannot run a browser").
2. **What to examine and how.** The procedure, concrete enough to be repeatable: which files,
   which commands, what order, what standard (WCAG 2.2 AA, the repo's CONTRIBUTING.md).
3. **What a good result contains.** The shape of the summary, what each finding must carry
   (file and line, severity, the fix), what qualifies as a subtask versus a recommendation.
4. **What not to do.** Files it may not touch, actions that stay with humans (merging,
   deleting branches, updating baselines), things the linter already covers.
5. **How to decide the status.** Spell out `done` versus `attention` for this role. Reviewers
   are `done` when the review is complete even if they found problems; `attention` is for "the
   branch should be abandoned" or "I need a decision".

Do not restate the result JSON, the delegation rules or the permission footer; the worker adds
them. Do not address the human in the prompt; the human reads the summary, not the prompt.

### 4.4 Delegating well

- Only planners and reviewers should delegate. An agent that both edits and delegates muddles
  who owns the branch; keep `commits` and `can_delegate` on different agents.
- A subtask description is read by an agent with no memory of anything else. Include the files,
  the exact names, and the tests that must stay green, and put the definition of done in
  `acceptance` as two to five checkable statements. Test the description by asking: could a
  contractor with the repo and nothing else act on it, and would they know when they were done?
- Size coder tasks for the pipeline: one concern, a handful of small files, tests included. If a
  subtask needs the word "and" twice, split it.
- Use `after` only for real code dependencies. Independent tasks merge independently; stacked
  tasks wait for each other and inherit each other's failures.
- Reviewers go `after` the coder task they review, so the worker hands them the branch.
- Do not schedule the review of your own subtasks; the architect's cycle does that.

### 4.5 Reporting well

- The summary is read by a human on the status page and by the architect deciding what to do
  next. Lead with the outcome, then the evidence, then what should happen. Paths and PR links,
  not adjectives.
- Findings are the feedback channel. `blocker`: wrong or incomplete. `major`: fix before merge.
  `minor`: nice to have. `info`: an observation or a decision the human should know about. Every
  finding names a file when one applies.
- `attention` must say what is being asked of the human, in one sentence, near the top of the
  summary. "Needs human review" is not an escalation; "Choose between keeping the modal or
  moving to an inline panel; the e2e specs 028 and 097 assume the modal" is.
- `failed` is for "could not". If some of the work was done, it is `attention` with the partial
  result described, not `failed`.
- `cancelled` is for "cannot, and no retry will change that". Say why, and what would make it
  possible (a decision, a dependency, an agent that does not exist). It is not a softer `failed`:
  a task that might work on a second try is `failed`.
- When you can see that the work needs a skill no registered agent has, propose the agent
  (`agent_proposals`) instead of stretching yourself or another agent past its description, and
  plan or finish what can be done without it. Never put a proposed agent's name in a subtask.

### 4.6 Safety rails you get for free, and the ones you must add

Provided by the worker: each task runs in its own worktree, so nothing reaches the human's
checkout or another task; agents cannot write outside the repository or into `.git`;
non-`commits` agents that modify files have the changes reverted and noted; `paths` restricts
where `commits` agents may write; `commits` agents cannot push without green lint and unit
tests; shell access is limited to declared groups and checked per command by a hook; secrets are
stripped from subprocess environments; every model agent gets the ground rules about untrusted
content; Claude spend is capped per task and per day; nothing merges; nothing updates screenshot
baselines through the pipeline; each run is time-boxed.

Still the prompt's job: the *meaning* of a change (a verifier checks shape, not intent), deciding
when to escalate rather than guess, and telling `shell-runner` clearly what a command is for so
its own vetting has something to judge.

### 4.7 Testing an agent

Every agent directory has a `tests/` folder with bun tests in two tiers, and `agentpipe agents
test NAME` runs them (all agents when no name is given; `--e2e` enables the second tier):

- **Cheap tier, always on.** Load the manifest through the real registry and assert it has no
  problems and the properties you rely on (runtime, `commits`, `can_delegate`, tools). Exercise
  `verify.ts` with fake contexts from `src/testkit.ts`: one result that should pass, and one per
  failure mode you care about (the wrong files changed, a blocker without a path, `done` with
  nothing produced). These take milliseconds and run on every change.
- **End-to-end tier, behind `AGENTPIPE_E2E=1`.** `runAgentE2E(agent, description, opts)` builds
  a scratch git repository, an isolated queue and config in a temp directory, registers the
  scratch project, queues one task, runs the real worker once, and hands back the task record, its
  children, the run directory, the report and the parsed result. This calls the real runtime
  (Claude, Ollama, or the command), so it costs model time and needs the machine's credentials.
  Assert on outcomes, not on wording: status, branch name, child agents, files created.

```ts
test.skipIf(!process.env.AGENTPIPE_E2E)("edits only documentation", async () => {
  const r = await runAgentE2E("docs-writer", "Add a Usage section to README.md describing src/utils.ts.");
  expect(r.task.status).toBe("done");
  expect(r.task.branch).toMatch(/^agentpipe\/docs-writer/);
}, 15 * 60_000);
```

The shell runtime is cheap enough to run for real in the first tier; `e2e-runner`'s test does
exactly that and asserts the failure path (no Playwright in the scratch repo, so `attention`).

`src/registry.test.ts` holds the roster-wide rules: every built-in loads without problems, has a
description, `when_to_use`, `inputs` and `outputs`, a prompt where its runtime needs one, a
verifier unless it is a shell agent, a `tests/` folder, and never both `commits` and
`can_delegate`. `bun test src` (or `bun run test`) runs everything in the cheap tier;
`bun run test:e2e` runs both tiers.

Bringing up a new agent, in order: `agentpipe agents new NAME --runtime …`; fill in the manifest
and prompt; make the verifier check the promise in `outputs`; `agentpipe agents test NAME` until
the cheap tier passes; `agentpipe agents test NAME --e2e` once or twice, reading `run.log` in the
run directory to tune the prompt; then queue it once on the real project with
`agentpipe add --agent NAME …` before relying on the architect to choose it. The architect sees
new agents immediately; nothing restarts.

### 4.8 Anti-patterns

- A `claude` agent that edits code. Use the pipeline.
- An agent that both `commits` and `can_delegate`.
- Descriptions that describe the prompt ("uses Claude to…") instead of the outcome.
- Prompts that restate the JSON schema or address the human.
- Subtasks that say "see above" or "as discussed".
- `max_turns: 200` to compensate for a vague procedure.
- Ollama agents asked to judge whole pull requests.
- Shell agents with side effects outside the checkout.
- Finding text without a file path.
- Using `failed` for "found problems" and `done` for "gave up".
- A verifier that calls a model, or that only checks the summary is non-empty when the agent promised files.
- Asking for `ops` on a second agent, or working around a shell refusal by delegating the same command with a different wording.
- Subtasks without acceptance criteria that mean something ("it works" is not one).
- Shipping an agent without the second tier ever having been run.

## 5. Worked example

A dependency auditor: reads the lockfile, reports risky or outdated packages, files upgrade tasks
for the coder when an upgrade is mechanical.

```
~/.config/agentpipe/agents/dependency-auditor/
  agent.json  prompt.md  verify.ts  tests/dependency-auditor.test.ts
```

`agent.json`

```json
{
  "name": "dependency-auditor",
  "description": "Audits package.json and the lockfile for outdated, deprecated or vulnerable dependencies and files coder tasks for upgrades that are mechanical.",
  "runtime": "claude",
  "when_to_use": "Periodically, or before a release. Not for adding a new dependency (that is a coder task) and not for lockfile conflicts (gitbot).",
  "inputs": "Optionally which packages or which severity to focus on. Nothing else is required.",
  "outputs": "An audit report with one finding per package (severity, current and target version, why); coder subtasks for safe minor/patch upgrades.",
  "can_delegate": true,
  "commits": false,
  "model": "sonnet",
  "shell": ["package-read"],
  "max_turns": 30,
  "context": ["repo-overview", "catalog"],
  "tags": ["maintenance"]
}
```

`prompt.md`

```
You audit the dependencies of a Bun/TypeScript project. Read package.json and bun.lock, run
`bun outdated`, and for anything notable check `npm view <pkg>` for deprecation notices and
release dates. Judge each dependency: is it behind, is the gap a major version, is it deprecated,
does the changelog mention breaking changes that touch how this repository uses it (grep for
the import).

Report one finding per package that deserves action: severity (blocker: known vulnerability or
deprecated with no fix; major: behind by a major version or unmaintained; minor: behind by a
minor/patch), current version, target version, and the reason in one sentence. Ignore packages
that are current or one patch behind.

For minor and patch upgrades with no breaking changes, create one coder subtask per package:
"Upgrade <pkg> from X to Y in package.json, run bun install, keep lint and the unit suite green;
if a type error appears, fix the call site minimally and note it." Major upgrades stay as findings
for a human. Do not edit anything yourself. Status done when the audit is complete; attention
only if the lockfile cannot be read or bun outdated fails.
```

`verify.ts`

```ts
import { defineVerifier, findingsHavePaths, noChanges, nonEmptySummary, subtasksActionable } from "../../../../src/agentpipe/src/verify.ts";

export default defineVerifier(async (ctx) => {
  const problems = [...noChanges(ctx.changedFiles), ...nonEmptySummary(ctx.result, 150), ...subtasksActionable(ctx.result, 120)];
  for (const f of ctx.result.findings) if (!/\d+\.\d+/.test(f.description)) problems.push(`finding lacks a version number: "${f.description.slice(0, 60)}"`);
  for (const s of ctx.result.subtasks) if (!/from .+ to .+/i.test(s.description)) problems.push(`upgrade subtask "${s.title}" does not state from/to versions`);
  return problems;
});
```

(`agentpipe agents new` writes the import path for you, relative to wherever the package lives.)

`tests/dependency-auditor.test.ts` asserts the manifest loads, that the verifier rejects a
finding without versions and accepts a well-formed one, and, behind `AGENTPIPE_E2E=1`, that a
run on a scratch repo with a deliberately old `package.json` ends `done` with at least one
finding. Then: `agentpipe agents test dependency-auditor`, once with `--e2e`, then
`agentpipe add --agent dependency-auditor "Quarterly audit"` on the real project.

## 6. Known limits

- One `gpu` lane per machine: one GPU holds one model. The `cloud` lane can be widened.
- An agent cannot wait on or talk to another agent; coordination is only through the task tree
  and the architect's review cycle.
- `ollama` agents cannot delegate or commit, by design.
- Verifiers check structure and files, not meaning. A review can pass verification and still be
  shallow; that is what the architect's review and the human are for.
- Assets are implied by status plus branch, PR URL and run directory; there is no separate
  "attachments" field. If an agent produces something else (an image, a data file), it should
  commit it (`commits: true`) or name its path in the summary.
- Nothing turns GitHub issues into tasks yet; agents with `gh-read` can read them.
- The shell policy is a pattern matcher, not a sandbox: it refuses what it recognises and
  refuses what no group covers, but a command that passes still runs with the worker's own
  permissions inside the worktree.
