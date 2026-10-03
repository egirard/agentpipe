# agentpipe

A local-first coding pipeline for mothership. Small models on the GTX 1080 do the routine work;
Claude plans, unblocks, and reviews. Scripts, not models, drive the loop, and real lint and tests
decide whether a step passed.

```
task ──▶ architect (Claude Code, read-only) ──▶ plan.json: small steps, each with writable files + acceptance + tests
              │
              ▼  for each step
        coder (qwen2.5-coder, local) ──▶ lint + targeted unit tests ──▶ reviewer (local)
              │ fail ×3                                                     │ approve
              ▼                                                             ▼
        fixer (Claude Code: edit + run lint/tests)                     git commit
              │ pass                            │ still failing                 │
              │                                 ▼                               ▼
              │                     architect replans (sees every            e2e specs (podman)
              │                     attempt's exact output + logs)           if the step names any
              │                                 │ revised remaining steps       │ fail ──▶ replan
              └─────────────────────────────────┴───────────────────────────────┘
                                                            │
                                     full unit suite + final review (Claude) ──▶ report.md
                                                            │ --push
                                              git push + pull request via gh (never merges)
```

## Why this shape

A 7B model can rewrite a small file to a precise spec, and it can spot obvious problems in a diff.
It cannot hold a repo in its head or recover from a vague failure. So the cloud model writes
specs that a junior developer could follow with no repo knowledge, and the local model only ever
sees one step's files. When the local loop stalls three times, Claude takes over that step with
real tools, then hands back.

## The queue: architect, worker, registry

The pipeline above is one task in, one branch out. On top of it sits a queue so that work can
pile up and drain unattended:

```
you ──▶ agentpipe add "goal" ──▶ [architect task] ──▶ worker runs it ──▶ subtasks for coder, reviewers, ...
                                                                              │
              systemd timer, every 2 h                                        ▼
        architect review ◀── parents whose children all finished ◀── worker runs each subtask (one at a time)
              │                                                               │
              ├─ done / needs you / next round of subtasks                    └─ branch + PR per coder task
              └─ digest for you (~/.local/share/agentpipe/digests/)
```

- **Tasks** live in a SQLite file (`~/.local/share/agentpipe/agentpipe.db`). Each names a project,
  an agent, a priority and optional dependencies. A task whose dependency ended badly becomes
  `blocked`; a task created by another task is its child, and the parent `waiting`s until all
  children finish, then goes to `review`.
- **The worker** (`agentpipe worker`, a systemd user service) takes runnable tasks, gives each a
  private git worktree of its project (from the base branch, or from a dependency's branch for
  stacked work), runs the agent, records the result and any subtasks, and removes the worktree.
  It runs one task per lane at a time: `gpu` for the local model, `cloud` for Claude and shell
  agents, so a review or a plan no longer waits behind a coder run. Your checkout is never touched.
- **The architect** is two things. As an agent in the registry it turns a goal into subtasks.
  As the timer job `agentpipe architect review` it wakes up, reads what finished (reports, logs,
  branches, PRs), and decides per item: accept, hand to you, retry, cancel, or queue the next
  round. Rounds per task are capped (`architect.maxRounds`), so it cannot loop forever. When
  work failed because no agent has the skill, it proposes the agent that should exist (below).
- **The registry** (`agentpipe agents`) is the roster the architect chooses from. See below.

### Day to day

```bash
agentpipe add "Add a 'Skip turn' button to the hero turn panel; cover the reducer with a unit test"
agentpipe add --agent coder "Extract the four inline Math.max(Math.min(...)) call sites to clamp()"
agentpipe add --agent a11y-reviewer --files src/components/PlayerCard.svelte "Audit the player card"
agentpipe add --file backlog.md              # one task per "- [agent] text" line; agent defaults to architect
agentpipe status                             # counts, running, what needs you, last digest
agentpipe list                               # open tasks (--all for everything, --status done,failed)
agentpipe show 42                            # record, summary, replies, children, event log
agentpipe reply 42 "Blue, like the other primary buttons"   # answer a task that asked something; it continues with your answer
agentpipe retry 42 | cancel 42 --reason "needs a DB we do not have" | prio 42 10
agentpipe edit 42 --description "read upstream/tt instead of cloning"   # fix what a task asks for (also on the page)
agentpipe approve 42 | reject 42 --reason "not yet"   # decide what a github or agent-creator task proposed
agentpipe digest                             # the architect's latest write-up
agentpipe upgrade [--check]                  # on the box: pull the deployed checkout, bun install, restart the units
agentpipe agents proposals                   # agents the architect wished it had; create one: agentpipe agents new NAME --from ID
journalctl --user -u agentpipe-worker -f     # live worker log (also ~/.local/share/agentpipe/worker.log)
systemctl --user start agentpipe-architect   # wake the architect now instead of waiting for the timer
```

A task that ends in `attention` or `failed` is yours: `agentpipe show` has the summary and the
run directory with full logs. Three ways out:

- `agentpipe reply ID "..."` when the agent asked something or went the wrong way. The reply is
  stored on the task, the task is requeued, and the agent's next run starts with its previous
  report and your answer in front of it ("continuing a task that stopped"). A reply to a task
  that is still open is kept as a note for its next run and does not requeue. If the architect
  had already handed the parent to you, the parent goes back to `waiting` so the tree converges
  through the architect again once the child finishes.
- `agentpipe retry ID` to run it again unchanged (a flaky test, a fixed environment).
- `agentpipe edit ID` (or the "edit task" form on the page) when the description, acceptance
  criteria, agent or priority are wrong: a kickoff written before the roster changed, a task that
  names a refused command. The change is recorded as an event; reply or retry to requeue it.
- `agentpipe cancel ID [--reason "..."]` when it proved impossible or moot. `cancelled` leaves
  "needs you", does not count against the agent's track record, and stays in the history with
  the reason. Agents can reach it too: an agent that finds its task impossible as specified
  reports `cancelled` with why, the architect confirms or re-plans on its next review, and you
  are notified like for `attention`.

Coder tasks that went green have a pull request link in `pr_url`; merging is always a human action.

### Agents that act with your approval

Two things the pipeline must never do on its own are changing GitHub and installing new agents.
A manifest with `requires_confirmation: true` marks an agent that may do such things, but only by
proposing: it explores read-only, then returns a **confirmation request** listing the exact steps
(commands with their directories, or files to write) with why and the risk. The task lands in
"needs you" as "approve: …"; opening it shows every step and every file, with **Approve and run**
and **Reject**. On approval, code runs the steps verbatim as you, one at a time, logging each on
the task; a failing step stops the rest. The agent never holds the permission itself. A hard deny
list still applies to approved commands (no `sudo`, recursive deletes, `curl`, sysadmin commands,
credential access), and every path must be under your home directory or the project.

- **github**: repositories, pushes, pull requests (open, merge, close), issues, labels, releases.
  It refuses to force-push or delete unless the task says so, and then names it in the risk.
- **agent-creator**: writes a complete agent package (manifest, prompt, verifier, tests) from a
  specification and installs it under `~/.config/agentpipe/agents/<name>/`, running its tests as
  the last step. This is how the architect grows the roster: when a goal needs a skill no agent
  has, it delegates the creation with the full spec, you approve the files, and on its next
  review it delegates the waiting work to the new agent. Lighter **agent proposals** (a note
  without a task, shown under "Suggested agents" and in `agentpipe agents proposals`) are for gaps
  the goal does not depend on; `agentpipe agents new NAME --from ID` scaffolds one by hand.

`agentpipe show ID` prints a request (`--full` includes file contents); `approve` and `reject`
decide it from the terminal.

### Projects: streams of work

A project is one stream of work with its own queue, goal and progress: a repository in its own
directory, or a long-lived branch of another project's repository. Any number of them share the
queue and the worker. One is **current**: every command defaults to it, and the worker takes its
tasks first (the others keep running behind it unless you pause them).

```bash
agentpipe use                                # which project am I on?
agentpipe use lighting                       # switch; `status`, `list`, `add` now mean lighting
agentpipe projects                           # every stream: status, branch, open/done, goal
agentpipe status                             # one line per stream, then the current one in detail
agentpipe list --project all                 # tasks across every stream

# ask the architect to create and configure a stream from a description
agentpipe projects new lighting "A branch of ashardalon for reworking dungeon lighting; start by measuring torch radius"
agentpipe add "Create a stream called tools: a new repo at ~/src/tools for asset scripts, with a private GitHub repo"

# or create one yourself
agentpipe projects create lighting --goal "..." --branch-of ashardalon [--branch lighting]
agentpipe projects create tools --goal "..." --new [--path ~/src/tools] [--github me/tools] [--kickoff "first goal"]
agentpipe projects create dragons --goal "..." --clone me/dragons
agentpipe projects create legacy --goal "..." --path ~/src/legacy        # an existing checkout

agentpipe projects pause|resume|archive NAME # paused/archived streams run nothing; their tasks wait
agentpipe projects approve NAME              # run the GitHub steps an architect-made stream waits on
agentpipe projects finish lighting           # open the PR merging the stream branch into its parent

# other repositories a stream works from: fetched read-only INTO the checkout, under upstream/<name>/
agentpipe projects upstream add egirard/TabletopTemplate --project nile1978     # -> ~/src/Nile1978/upstream/tabletop-template
agentpipe projects upstream list | update tabletop-template | remove tabletop-template
agentpipe projects budget nile1978 --daily-usd 15   # this stream's own daily Claude cap
```

What the architect may do when it creates a stream: clone a repository, `git init` a new one
(its first commit carries a placeholder `agentpipe.json` with `true` commands and an
`AGENTPIPE.md` saying so, so branches cut from it pass the checks before a toolchain exists),
fetch the stream's upstream repositories, create a stream branch, register the project, and queue
its first tasks: `project-setup` (writes `agentpipe.json` and `AGENTPIPE.md` when the repo has
none) and an architect task for the kickoff goal. An architect that needs an upstream it does not
have returns it in `upstreams`, the worker fetches it and runs the architect again with the
files in front of it. Anything that changes GitHub (creating a repository, pushing the stream branch) is held:
the stream does not run, the task ends in `attention`, and `agentpipe projects approve NAME` does
it. Creating a stream yourself with `projects create` runs those steps at once.

In a **branch stream** (`--branch-of`), tasks start from the stream branch and their pull
requests target it; the stream shares its parent's checkout, setup and `agentpipe.json`. When
it is done, `projects finish` opens the one PR into the parent's base, which you merge.

**Upstream repositories.** A stream often works from another repository: a template to scaffold
from, a rules reference, a specification. `agentpipe projects upstream add owner/repo` (or an
`upstreams` list when the architect creates the stream, or `upstreams` in an architect's
result for its own project) clones it read-only into `<checkout>/upstream/<name>/`, excluded
from git through `.git/info/exclude` and symlinked into every worktree like `node_modules`.
Because it is inside the checkout, every agent reads it with its ordinary tools (`Read`, `ls`,
`cat`, `find`, `git -C upstream/<name> log`), and Claude agents read PDFs and images there
too. The commit it was fetched at is recorded in the project config and printed in every prompt,
so provenance is pinned without anyone re-deriving it. Fetching is a read: no approval round.
Copying files from an upstream into the project is the **upstream-importer** agent: a task with a
JSON spec (include and exclude globs, renames, literal substitutions, files to keep verbatim,
files to make executable); code copies, the worker commits and opens the PR, and docs-writer or
coder adapt the copies afterwards.

Inside a registered checkout, commands pick that checkout's project (the current one if several
streams share it, else the one whose branch is checked out). `--project NAME` or
`AGENTPIPE_PROJECT=NAME` override everything. The worker rereads the config before every task, so
switching, pausing and new streams take effect without a restart.

`agentpipe projects add ashardalon ~/src/Ashardalon --base main --push` still registers an
existing checkout directly (`--link` names what to symlink from your checkout into each worktree,
default `node_modules`; `--setup` runs once per worktree). A repo can carry `agentpipe.json`
(pipeline commands and models) and `AGENTPIPE.md` (guidance every agent reads: conventions,
no-go areas, how to run things).

### Machine config

`~/.config/agentpipe/agentpipe.json`:

```json
{
  "projects": {
    "ashardalon": { "path": "/home/girard/src/Ashardalon", "base": "main", "push": true, "goal": "The board game in the browser" },
    "lighting": { "path": "/home/girard/src/Ashardalon", "base": "lighting", "push": true, "parent": "ashardalon", "goal": "Rework dungeon lighting", "status": "paused" },
    "nile1978": { "path": "/home/girard/src/Nile1978", "base": "main", "push": true, "goal": "...", "dailyUsd": 15,
                  "upstreams": { "tabletop-template": { "repo": "egirard/TabletopTemplate", "sha": "eccb7f2a…", "fetched": "2026-10-03T…" } } }
  },
  "defaultProject": "ashardalon",
  "worker": { "pollSec": 30, "pauseSec": 300, "maxAttempts": 3, "lanes": { "gpu": 1, "cloud": 1 } },
  "worktrees": { "root": "", "link": ["node_modules"], "cleanup": true },
  "architect": { "maxRounds": 4, "maxOpenTasks": 300, "maxItemsPerReview": 12, "maxSubtasks": 30, "model": "" },
  "budgets": { "taskUsd": 5, "dailyUsd": 40, "agentAttentionRate": 0.5, "agentWindow": 10 },
  "notifications": { "webhook": "", "command": "", "events": ["attention", "failed", "digest", "budget", "agent-health", "worker"] }
}
```

Budgets are Claude spend as Claude Code reports it: per task (the task ends in attention when it
runs out) and per UTC day (cloud tasks wait for tomorrow; local ones keep going). A project's own
`dailyUsd` (`agentpipe projects budget NAME --daily-usd N`) stops that stream's cloud tasks
when it alone has spent that much, so one stream's self-improvement cannot starve another. `agentpipe spend`
breaks it down. Notifications go to a webhook (Discord, Slack, ntfy and the like accept the body
as sent) and/or a command, for tasks needing you, the architect's digest, budget events and
agents whose recent runs mostly needed intervention. Interrupted tasks are requeued on restart,
up to `maxAttempts`.

### Shell access

Agents never get a raw shell. A manifest names capability groups (`git-read`, `gh-read`,
`gh-comment`, `checks`, `package-read`); `src/shell-policy.ts` turns them into Claude Code tool
permissions and into a hook that checks every command before it runs, with a deny list that
nothing overrides (no git writes, no `gh` state changes, no network tools, no leaving the
checkout, no credentials). Only `shell-runner` holds the broad `ops` group; other agents delegate
commands to it. Read-only git also works on upstream copies (`git -C upstream/<name> log`), and
`chmod +x` on one file in the checkout is allowed to agents that commit; models cannot set modes
otherwise, so a plan step marks scripts and hooks `executable` and the pipeline sets 755.
`agentpipe shell-check --groups git-read --command "git log -3"` shows what the policy would say.

## The status page

`agentpipe web` (systemd user unit `agentpipe-web`) serves a status page and a JSON API:

| URL | What |
|---|---|
| `http://mothership.local:8081/` | the page: online/offline, queue counts and an **Add task** form (an `agentpipe add` from the browser, project and agent selectable, architect by default), system checks (Ollama, GPU, worker, timer, Open WebUI, token, disks), machine meters, in-flight and needs-you lists, history with filters, latest architect digest, suggested agents, agent registry, link to the LLM chat |
| `https://mothership.local:8443/` | the same over HTTPS, needed for offline mode (below) |
| `/api/status?history=60` | everything the page shows, as JSON (includes open agent proposals) |
| `/api/history?limit=200&project=…` | finished tasks |
| `/api/task/ID` | one task with events, children, replies and its `report.md` |
| `/api/proposals?all=1` | agent proposals (open by default) |
| `POST /api/tasks` | `{description, project?, agent?, title?, priority?, acceptance?}`: queue a task |
| `POST /api/task/ID/reply` | `{text, requeue?}`: answer the agent; requeues a stopped task |
| `POST /api/task/ID/retry`, `POST /api/task/ID/cancel` | `{}` / `{reason?}` |
| `POST /api/task/ID/edit` | `{title?, description?, acceptance?, agent?, priority?, files?}`: change what a task asks for (not while running); the "edit task" form on the page |
| `POST /api/task/ID/approve`, `POST /api/task/ID/reject` | decide a confirmation request; approve runs its steps while the page polls the task |
| `POST /api/proposal/ID/dismiss` | drop a suggested agent |
| `POST /api/upgrade` | `{force?}`: pull, install, and schedule a restart of the worker and web units |
| `/ca.crt` | the server's self-signed certificate |

In the **Needs you** list an `attention` row shows what the agent is asking; clicking a row opens
the task: the description, the agent's report, the run report, earlier replies, and a reply box.
"Reply and continue" stores the answer and requeues the task; "Retry as is" and "Cancel task" do
what the CLI commands do. Writes are accepted only from the page's own origin with a JSON body
(browsers send `Sec-Fetch-Site`; a form on another site cannot pass), and from non-browser
clients such as `curl`. There is no login: the page is meant for a LAN, like the rest of the box.
When the page is offline (stale snapshot) the buttons are disabled.

Open task details survive the 20-second refresh: the lists are rebuilt only when their rows
change, open detail rows are moved rather than rebuilt, and a half-typed reply stays where it
is. A detail whose task changed status is refreshed in place.

**Upgrading the box from the page.** The server checks `origin` every ten minutes; when the
deployed checkout is behind, a banner lists the waiting commits with an **Upgrade now** button.
It pulls (fast-forward only, refusing if the checkout has local changes), runs `bun install`, and
schedules a restart of `agentpipe-worker` and `agentpipe-web` three seconds later through a
transient systemd timer, so the web server can restart itself. A running task blocks the upgrade
unless you confirm interrupting it (it is requeued). `agentpipe upgrade` does the same from a
shell, `--check` only reports.

The page polls every 20 seconds and keeps the last snapshot in the browser. When the server stops
answering it switches to "offline since …" and shows the stale snapshot dimmed. For that to work
when you *open* the page while the box is down, the browser must be able to load the page shell
without the server, which needs a service worker, which needs HTTPS. One-time setup per browser:

1. Download `http://mothership.local:8081/ca.crt`.
2. Windows: double-click it, Install Certificate, Current User, "Place all certificates in the
   following store", Trusted Root Certification Authorities. macOS: add to the login keychain and
   set Trust to Always. iOS: install the profile, then enable it under Certificate Trust Settings.
3. Open `https://mothership.local:8443/` once. Pin the tab or install it as an app (Chrome: address
   bar, Install). From then on it opens even when mothership is off.

The certificate covers `mothership`, `mothership.local`, `mothership.home` and the LAN IP; it is
generated on first start into `~/.local/share/agentpipe/web/` and lasts ten years. Delete those
files to regenerate it (for example after the IP changes).

### Reaching the box by name

The NixOS config publishes `mothership.local` via mDNS (Avahi), which Windows, macOS, iOS and
Android resolve without the router. The router's own `mothership` / `mothership.home` names also
work, but Chrome ignores the router when its Secure DNS setting is a fixed provider: check
`chrome://settings/security`, "Use secure DNS", and pick "With your current service provider" (or
type the `.local` name, which Chrome always resolves through the operating system).

## The agent registry

An agent is a directory named after it, holding everything the agent needs:

```
src/agents/<name>/            built-ins (this repo)
~/.config/agentpipe/agents/<name>/   yours, on this machine
<project agentsDir>/<name>/   per project, if set in the project config

  agent.json     manifest: description, runtime, when to use, inputs, outputs, permissions
  prompt.md      system prompt (claude and ollama runtimes)
  verify.ts      output verification: checks the agent's promise (files changed, findings named, ...)
  tests/         bun tests: cheap checks always, the real run behind AGENTPIPE_E2E=1
  ...            helper scripts, supplemental prompts, fixtures
```

Later directories override earlier ones by name; `"enabled": false` hides a built-in.
`agentpipe agents` lists what is loaded with verifier and test columns; `agentpipe agents show NAME`
prints one; `agentpipe agents new NAME --runtime claude` scaffolds a complete package;
`agentpipe agents test [NAME] [--e2e]` runs its tests.

| Field | Meaning |
|---|---|
| `runtime` | `pipeline`: the coder loop above. `claude`: one Claude Code session in the repo. `ollama`: one local model call. `shell`: a command. |
| `description`, `when_to_use`, `inputs`, `outputs` | What the architect reads to pick this agent and to write it a task. Spend words here. |
| `can_delegate` | May create subtasks. The result schema then enumerates registered agent names, so it cannot invent one. |
| `can_create_projects` | `claude` only: may return `projects` (new streams). Code creates them; GitHub steps wait for `agentpipe projects approve`. |
| `commits` | May change files. The worker gives it a branch, verifies, runs lint + full unit tests, commits, and pushes/opens a PR when green and the project pushes. |
| `verify` | Output verification; defaults to `verify.ts` in the agent directory. Any problem it returns turns `done` into `attention` and blocks the push. |
| `shell` | Shell capability groups; see "Shell access". Raw `Bash(...)` tools are refused. |
| `paths` | Globs a file-changing agent may touch; anything else fails verification. |
| `lane` | `gpu` or `cloud`; defaults by runtime. |
| `context` | What the worker adds to the prompt: `repo-overview`, `files`, `branch-diff`, `queue`, `catalog`. |
| `model` | Claude alias or Ollama model; empty = project default. |
| `task_prefix` | `pipeline` only: text prepended to the task before planning (how `unit-tester` differs from `coder`). |
| `command` | `shell` only. Task fields arrive as `AGENTPIPE_TASK_ID/TITLE/DESCRIPTION/FILES/BRANCH`, plus `AGENTPIPE_REPO` and `AGENTPIPE_AGENT_DIR`. Exit 0 = done. |

Every non-pipeline agent must answer with one JSON object: `status` (done / attention / failed),
`summary` (markdown for humans), `findings[]`, `subtasks[]`. Then its verifier gets one look at the
result and the changed files before anything is committed or pushed.

Built-ins: `architect` (also creates streams), `project-setup` (writes a new stream's `agentpipe.json` and `AGENTPIPE.md`), `coder`, `unit-tester`, `code-reviewer`, `local-reviewer` (Ollama, no
cloud), `a11y-reviewer`, `ux-reviewer`, `docs-writer`, `graphics-designer` (SVG/CSS only),
`project-manager`, `gitbot` (reports and comments, never merges), `shell-runner` (the only agent
with a broad, vetted shell), `e2e-runner` (shell), `upstream-importer` (shell, commits: copies
files from an upstream repository into the project from a JSON spec, no model). The status page
lists them all with their metadata, shell groups and track record.

The full design and authoring guide, with the result contract, runtime behaviour, verification,
delegation rules, testing and a worked example, is in [docs/AGENTS.md](docs/AGENTS.md).

## Setup on mothership

Toolchain comes from the NixOS config (bun, node, ripgrep, podman, claude-code). The cloud roles run
through Claude Code in headless mode (`claude -p`), so they are covered by a Claude subscription:
no API key. Mint a long-lived token on any machine with a browser and copy it to the server:

```bash
claude setup-token          # on your laptop; prints a one-year token
ssh girard@mothership 'umask 077; mkdir -p ~/.config/agentpipe; echo "CLAUDE_CODE_OAUTH_TOKEN=<token>" > ~/.config/agentpipe/env'
```

Then on the server:

```bash
git clone <this repo> ~/src/agentpipe      # or rsync from the workstation
cd ~/src/agentpipe && bun install
mkdir -p ~/.local/bin
ln -sf ~/src/agentpipe/src/cli.ts ~/.local/bin/agentpipe
ln -sf ~/src/agentpipe/scripts/agentpipe-e2e ~/.local/bin/agentpipe-e2e
```

Clone the project you want it to work on and install its deps:

```bash
git clone https://github.com/egirard/Ashardalon.git ~/src/Ashardalon
cd ~/src/Ashardalon && bun install
cp ~/src/agentpipe/agentpipe.example.json agentpipe.json   # optional, edit to taste
agentpipe doctor
agentpipe projects add ashardalon ~/src/Ashardalon --base main --push
```

The NixOS config declares two user units: `agentpipe-worker.service` (always on, restarts on
failure) and `agentpipe-architect.timer` (every two hours). After `./install.sh rebuild` from the
workstation they start on their own; `systemctl --user status agentpipe-worker agentpipe-architect.timer`.

## One-off use (without the queue)

```bash
cd ~/src/Ashardalon
agentpipe run "Add a 'Skip turn' button to the hero turn panel that ends the hero phase without an action; cover it with a unit test on the reducer and keep e2e 011 green"
```

The run creates a branch `agentpipe/<slug>-<date>`, commits once per green step, and writes
`.agentpipe/runs/<stamp>/` with `plan.json`, `run.log` (every prompt and response), and `report.md`.
Review the branch like any PR. Nothing is pushed.

Other commands:

- `agentpipe plan "task"` runs only the architect. Edit the plan, then `agentpipe resume path/to/plan.json`.
- `agentpipe run --local-only "task"` never calls Claude. Needs a plan: use `resume` with a hand-written plan.
- `agentpipe run --no-e2e ...` skips the Playwright specs.
- `agentpipe doctor` checks Ollama, Claude Code auth, and the toolchain.

## When a step fails

The local model's answer is checked before it touches the tree: a file that comes back as a
fragment (under 40% of what it was) or JSON that does not parse is refused with the reason, so a
truncated rewrite is never committed. The local reviewer may send a step back once; after that,
green lint and tests win and the final cloud review sees the disputed diff.

Every attempt is recorded: which files the coder wrote, its explanation, the exact lint/test output
(clipped in prompts, complete on disk under `.agentpipe/runs/<stamp>/checks/`), the local reviewer's
verdict, and what the cloud fixer did. When a step is exhausted, the working tree is reverted to the
last good commit and the architect receives that whole history, with the log paths so it can read
the full output. It returns a revised plan for the remaining work, splitting, re-specifying or
re-ordering steps, or gives up with a stated reason. `limits.replans` (default 2) caps this per run.
An e2e failure after a commit keeps the commit and replans from there.

## Getting the result into GitHub

By default nothing leaves the machine: the run ends on a local `agentpipe/…` branch for you to
review. With `--push` (or `"push": true` in `agentpipe.json`), a fully green run pushes the branch
to `origin` and, if the GitHub CLI is authenticated, opens a pull request with the report as its
body. It never merges. One-time setup on the server:

```bash
gh auth login        # device-code flow works headless; grants push rights via HTTPS too
cd ~/src/Ashardalon && gh auth setup-git
```

## What good tasks look like

Small and testable. "Add X with a unit test" or "fix bug Y, reproduce it in a test first".
A task that needs a new screenshot baseline will stall on purpose: the pipeline never updates
baselines. Do that by hand with `bun run test:e2e:update` and commit it.

## Costs

Local steps are free. Per run, Claude Code is invoked once for the plan, once per escalated step,
and once for the final review, all against your subscription's usage limits. `run.log` records
every invocation with its turn count and the cost Claude Code reports.

## Tuning

`agentpipe.json` in the repo root, all fields optional (see `agentpipe.example.json`):

| Field | Meaning |
|---|---|
| `models.coder` / `models.reviewer` | Ollama model names. One model for both avoids swapping in 8 GB of VRAM. |
| `models.cloud` | Claude Code model alias or id: `opus`, `sonnet`, or a full id. Empty = Claude Code's default. |
| `claudeBin` | Path to the `claude` executable. |
| `numCtx` | Context window handed to Ollama. 8k keeps a 7B Q4 model fully on the GPU; 16k spills to CPU. |
| `limits.localAttempts` | Local tries per step before escalation. |
| `limits.replans` | How many times the architect may revise the plan after a failed step. |
| `push` | Push green runs and open a PR (`--push`). |
| `limits.coderContextChars` | How much source the coder sees per step. |
| `limits.coderMaxFileChars` | A writable file larger than this (default 20,000) skips the local coder, which must return whole files, and goes straight to the cloud fixer. |
| `commands.*` | Lint, unit, e2e commands. `unit` receives file paths after `--` for targeted runs. |
| `setup` | Command the worker runs once in every fresh worktree before a task uses it (`bun install`), unless the machine's project config sets its own `setup`. `project-setup` writes it. |

## e2e on NixOS

`agentpipe-e2e` runs `playwright test` inside `mcr.microsoft.com/playwright:v<version>-noble`
via rootless podman (or `CONTAINER_RUNTIME=docker`), with the repo bind-mounted and a container-private `node_modules` volume.
The version comes from the repo's installed `@playwright/test`, so it always matches the lockfile,
and the Chromium build matches what generated the committed Linux baselines.

## License

Apache License 2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
