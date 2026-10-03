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

## 13. 2026-09-29

I'd like to add support for "projects" into mothership's system, allowing us to work on and track progress on  multiple streams.  So for example, the "ashardalon" stream is currently active, but I would like to be able to switch to a different stream.  I'll name these streams and ask the architext to create and configure new streams.  Commands will default to the current project/stream.  These will typically correspond to a directory on device and a repository on github, but might also be a git branch.

`Outcome: current project with agentpipe use, pause/resume/archive, branch streams, architect-created streams (GitHub steps held for projects approve), project-setup agent; tests green, left uncommitted.`

## 14. 2026-09-29

Please add an apache license to this project and make the github repository public.

`Outcome: added Apache-2.0 LICENSE, NOTICE, package.json license and README section (commit 8b9e2fc, pushed); scanned history for secrets, then made egirard/agentpipe public.`

## 15. 2026-09-29

I want to introduce a lightweight prompting so that I can ask unimportant questions (what port is the server on, for example) without cluttering up prompt.md. When I want to give a lightweight prompt, I will prefix it with "OTR: ", and you will not add it to prompts.md and not add the summary result.

`Outcome: saved the PROMPTS.md logging rule with the OTR exception as a persistent memory; backfilled prompts 13-15.`

## 16. 2026-09-29

 Let's expand the mothership status page to better support projects and command queues.  (1) Add an "add" command button for the queue, which will effectively provide a way to initiate an "agentpipt add" to the architect.  (2) Provide a way to review "attention" tags to open up the details of the attention feedback, and allow the user response to be appended to the given agent's context so that it can continue.  Note that we don't currently have a command line interface to add a response to a given task, so this might require additional infrastructure as well as a command line interface. (3) Expand the architect to suggest potential agents that could be created in order to enable activities that are currently impossible to complete. (4) We probably need to add a "cancelled" status for tasks that proved to be impossible.

`Outcome: status page gained an Add task form, reply/retry/cancel on task details (POST API, same-origin JSON), agent proposals section; agentpipe reply + replies table, continuation context for rerun agents; cancelled is a first-class agent status; architect proposes missing agents. 84 tests green, left uncommitted.`

## 17. 2026-09-30

I want to introduce a lightweight prompting so that I can ask unimportant questions (what port is the server on, for example) without cluttering up prompt.md. When I want to give a lightweight prompt, I will prefix it with "OTR: ", and you will not add it to prompts.md and not add the summary result.

`Outcome: already in effect since prompt 15 (persistent memory); confirmed, nothing to change.`

## 18. 2026-09-30

let's introduce a new category of agents: RequiresConfirmation.  These agents can perform actions that are otherwise prohibited but only with the user's permission.  For now, let's create a github agent that can do github commands (create new projects, checkout and commit, etc). Another agent can create new agents with the user's permission (where the call to CreateAgent would provide all of the agent's details and metadata, sometimes with links to additional metadata.  For these user permission agents, clicking on the attention will provide all of the pertinent information along with an approve or cancel option.  Also, please correct the web ui which loses context every time it reloads - we currently can't view the details before a reload/update triggers... can we make the ui persistant so that we don't close all of the child frames on a reload?  Also, let's make sure the architect sees the CreateAgent capability and uses it to suggest improvements to the pipeline.  Let's provide an automatic way to upgrade the deployed agentpipe (maybe set a notification in the ui that an update is available, click to rebuild).  Also, let's provide access to project agentpipe on mothership.

`Outcome: requires_confirmation agents (github, agent-creator) that propose exact steps for approve/reject on the page or CLI; architect delegates missing skills to agent-creator and GitHub work to github; page keeps open details and typed text across polls; update banner + agentpipe upgrade; agentpipe registered as a project on mothership. 106 tests green, deployed.`

## 19. 2026-09-30

agentpipe is not available in the project list; the text input fields lose their content and context at reload.

`Outcome: web server now re-reads projects per request (it had a stale copy); page saves drafts and open rows to browser storage, restores them on reload, and reloads itself when the server commit changes. Verified in headless Chromium on mothership; deployed (f073c2d).`

## 20. 2026-10-02

The mothership experiment has proven that our agent system needs some work.  Please review the installation and evaluate what happened and what went wrong.  I think we need to revise some of the agents.  For example, we should have a "check out a git repository within this directory, flagged as untracked within this repository" so that we can properly integrate content from other repositories.  There are likely many other points of failure, so please evaluate.

`Outcome: post-mortem of the Nile1978 run on mothership from the task DB, digests, run logs and code; root causes ranked (stripAnsi corrupting diffs, upstream cache outside the checkout, subtasks bound to the parent project, chmod/file-mode gap, 7B coder context limits); no code changed.`

## 21. 2026-10-02

I paused the worker and merged the pr's.  Please institute the improvements as you've described.  After you've finished, I'd like you to review the system's ability to implement the tasks as laid out in Task #5/#6.  I am intending to delete all of the Nile1978 work and restart that task as a follow-up test of our operations, but would like to maintain those assets to assist your evaluation efforts.

`Outcome: shipped and deployed (30c3ac2, 61df28d): stripAnsi fix, upstream repositories inside the checkout with CLI/architect support, upstream-importer agent, coder guards (big files, fragments, modes, reviewer cap), policy fixes (-exec, git -C, chmod +x), in-run confirmation retry, cross-project subtasks, agentpipe edit, per-project budgets, fresh streams start runnable; 166 tests green here and on mothership; upstream-fetcher retired to ~/.config/agentpipe/agents.retired. Nile1978 assets left untouched. Walk-through of the #5/#6 brief in the reply.`

## 22. 2026-10-02

(1) agentpipe on mothership has suggested a number of agents.  Please review these suggestions and evaluate which should be added to the system (I suspect some have already been added?); Clean up the recommendation list to remove old entries.  (2) the entire suggestion system should flow through agentpipe's github issues, where each issue should be open for feedback from the developer; the architect should respond to comments from the developer, including an "approve" or "please implement" message.  (3) We should be able to cancel all open tasks in a project within the status ui.  This would allow us to cancel the mess around Nile1978.  (4) Budgets should be visible and controllable within the status page.  This suggests that each project have a tab showing all of the project details (budget, tasks, status, etc) where the dev can control the project.  We can also have an "All projects" tab that shows all tasks (but probably not the per-project budget or other controls).

`Outcome: reviewed the six proposals (two already covered by upstream-importer, rules-media-reader built as the new media-transcriber, agent-maintainer folded into agent-creator, issue-reviewer absorbed by the architect, page-tester deferred) and closed them all with reasons; proposals now become GitHub issues (sweep, decision words, architect answers feedback, approval queues agent-creator); status page has an All projects tab and per-project tabs with budget, status, pause/resume and Cancel all open tasks; worker no longer overwrites a cancellation with a late result. 197 tests green, deployed (9cb9cc2).`
