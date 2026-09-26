# Prompts

## 1. 2026-09-23

So we have a local llm on mothership, and I want to use it for code development.  To that end, I'd like to imagine the architect breaking a problem into a number of smaller tasks which are then handed off to agents (who may also break their assignments into multiple tasks where it's reasonable.)  Thus the architect might spin up hundreds of smaller tasks which are queued for various agents to complete, then wake after an hour or two to review their progress and outcomes before dispatching another set of assignments.  To assist in this, I imagine that we will have a variety of agents available: coder, code reviewer, gitbot, ux designer, a11y reviewer, unit tester, project manager, graphics designer, etc.  (This is the model I described previously, so perhaps some or all of this is already deployed.  If so, please give me instructions on how to spin up new requests for the architect, how to review progress on tasks, and how these tasks get integrated back into a github repository.)

`Outcome: assessed the deployed single-run pipeline against the vision; gave run/review/PR instructions and named the gaps (no queue, no timer, fixed roles).`

## 2. 2026-09-23

yes, please build those systems, along with some kind of "agent registry" that allows us to add new agent capabilities into the system moving forward and also allowing the architect to find and make use of those agents.

`Outcome: built the SQLite queue, worker service, 2-hourly architect review timer and agent registry (12 agents); verified end to end and deployed to mothership.`

## 3. 2026-09-24

I'd like to get a status page on mothership, served up through http.  When mothership is offline this page should report it (so it would need to be a persistant page with a worker that can test the system.  It would also report on the number of tasks in the queue, and give the history of completed tasks as well.  Finally, it should have a link to the llm interface as well.  Also, chrome on this machine doesn't recognize "mothership" by its name, but can attach to the address.... can we fix that?

`Outcome: status server on :8081/:8443 with service-worker offline mode, queue counts, history, checks and LLM link; Chrome name failure traced to its Secure DNS setting; Avahi added for mothership.local.`

## 4. 2026-09-24

chrome://settings/security does not show a "with your current..." option.  Did step 1 but unclear on directions for 2.

`Outcome: confirmed rebuild landed and mothership.local resolves; started the user units, fixed the certificate generation; gave step-by-step gh auth login instructions.`

## 5. 2026-09-24

great.  As I understand it, this system can access github issues, correct?

`Outcome: answered no (PR access only); outlined three levels of issue integration to build after GitHub login.`

## 6. 2026-09-25

Please construct a design document for agents, describing how they are constructed, how they operate, and providing guidelines for authoring agents.  Each agent should advertise a specific skill, and when assigned a task should proceed to execute the task and either report success (which will typically also include some generated asset) OR report a failure (which could be an error log, feedback report, or an escalation that some aspect of the action needs to be reviewed and revised).  In some cases, an agent could be responsible for spinning up other agents with appropriate instructions for their action.

`Outcome: wrote docs/AGENTS.md covering anatomy, runtimes, the result contract, delegation, authoring guidelines, a worked example and known limits.`

## 7. 2026-09-25

that's great.  I'd also like to establish that agents will take a named directory under src/agents, where any configuration details, supplemental prompts, helper routines or scripts, and one or more e2e tests will live.  I expect that most agents will have an "output verification" step which ensures that a file was generated as per spec, that it lives up to the specifications, etc.  Additionally, mothership's status page will have a list of agents available, along with some amount of metadata describing them.

`Outcome: agents became src/agents/<name>/ packages with verify.ts and tests/ (two tiers); verification wired into every run; status page lists agents with metadata and track record.`

## 8. 2026-09-25

please give advice on the agent pattern that we've built

`Outcome: assessment of strengths, failure points at scale, and an ordered list of recommendations.`

## 9. 2026-09-26

Please take action on your recommendations.  Limit shell access to a specific agent (or agents) that can ensure that the commands given are safe.  Worktrees are a good suggestion as well.  Finally, this system should operate on multiple repositories stored in different directories (ashardalon was only an example).

`Outcome: shell policy with groups, deny list and PreToolUse hook (shell-runner is the only broad-shell agent); per-task worktrees with gpu/cloud lanes; multi-project support; acceptance criteria, path allowlists, budgets, track record, notifications; verified with PR #702.`

## 10. 2026-09-26

the claude cost reported - is that actual cost, or is it included for free in the max 20x plan?

`Outcome: explained the figure is Claude Code's list-price estimate, covered by the Max plan; useful as a usage proxy and throttle, not a bill.`

## 11. 2026-09-26

Record all prompts I give you for this project in PROMPTS.md for later reference, verbatim and without commentary. At the conclusion of each prompt, insert a terse summary of the outcome (generally limited to 1 or 2 lines) that is flagged (using `inline code`)

`Outcome: created PROMPTS.md with all prompts to date; future prompts are appended in the same form.`

## 12. 2026-09-26

Please push this repository into github.  I don't think we've pushed it yet, so we might need to create a new private project to track this work.

`Outcome: initialised git, created private repo https://github.com/egirard/agentpipe, pushed main; mothership copy now tracks the same history.`
