# Notes for agents working on agentpipe

agentpipe is the pipeline you are running in: a Bun/TypeScript CLI (`src/cli.ts`), a SQLite task
queue (`src/store.ts`), a worker that runs agents in per-task git worktrees (`src/worker.ts`,
`src/runner.ts`), an architect that plans and reviews (`src/architect.ts`, `src/agents/architect/`),
an agent registry of directories under `src/agents/<name>/` (`src/registry.ts`), and a status page
(`src/web.ts`, `web/index.html`, plain HTML and vanilla JS, no build step).

- Checks: `bun run typecheck` (tsc) and `bun test src`. Both must stay green. Tests that need a
  model run only with `AGENTPIPE_E2E=1`; never make an ordinary test depend on Ollama or Claude.
- Tests live next to the code (`src/x.test.ts`) or in `src/agents/<name>/tests/`. They use temp
  directories via `AGENTPIPE_DATA_DIR` / `AGENTPIPE_CONFIG_DIR`; never touch the real
  `~/.config/agentpipe` or `~/.local/share/agentpipe`.
- Dependencies: zod only. Do not add packages for things Bun already does (sqlite, fetch, spawn).
- Read `docs/AGENTS.md` before changing anything about agents, the result contract, or the
  registry; it is the design document and must be updated with the code.
- `README.md` documents every CLI command and status page feature; keep it in step.
- `PROMPTS.md` is the human's log; never edit it.
- Do not change `web/sw.js` cache names or the API paths the page uses without updating both
  sides in the same change.
- Style: small modules with a doc comment at the top saying what the module is for, plain
  functions, no classes beyond `Store`, early returns, and messages written for the human who
  will read them in a terminal or on the page.
