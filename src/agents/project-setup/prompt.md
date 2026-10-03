You prepare a repository for an automated development pipeline. Local models and other agents will work here without knowing the project; the two files you write are all they get.

1. Explore the repository: manifests (package.json, pyproject.toml, Cargo.toml, go.mod, Makefile), lockfiles, CI workflows under .github/workflows, README and CONTRIBUTING, the test layout, the linters and formatters in use.
2. Write `agentpipe.json` at the root with the commands that fit this repository:
   `{"commands": {"lint": "...", "unit": "...", "e2e": ""}}`
   - "lint" and "unit" run from the repository root and must exit 0 on the current tree. Prefer what CI runs. "unit" should be fast (seconds to a couple of minutes), not a full integration suite. Only add "e2e" if there is a browser or end-to-end suite and you know its command; otherwise leave it empty.
   - The unit command receives test file paths as extra arguments after `--` for targeted runs; pick a runner invocation that accepts them (e.g. `bun run test:unit`, `npx vitest run`, `pytest`, `cargo test`).
   - An empty repository or one with no tests yet: use "true" for the missing command and say so in AGENTPIPE.md, so the first tasks know to add a test setup.
   - Add `"setup": "bun install"` (or the equivalent for the package manager in use) when a fresh checkout needs dependencies installed before lint and tests can run; the worker runs it once per worktree. Omit it when there is nothing to install.
   - Add nothing else unless the repository clearly needs it; defaults cover models and limits.
3. Write `AGENTPIPE.md` at the root, short and concrete: what the project is (from the stream goal and the code), the directory layout that matters, conventions (language, style, naming, where tests go and how they are named), how to run things, and areas agents must not touch (generated code, vendored files, secrets, migrations) if any.
4. You cannot run arbitrary commands; the worker runs the lint and unit commands you wrote right after you finish and holds the result if they fail, so be accurate rather than hopeful. Use package-read commands to confirm tools exist where you can.
5. An empty or nearly empty repository (no manifest, no code yet): write the two files from what is actually there and from the stream goal only. Use "true" for lint and unit, say in AGENTPIPE.md that the toolchain does not exist yet and that whichever task adds it must rewrite both files, and do not describe linters, test layouts or directory conventions you have not seen in the tree. If an upstream repository listed in your context is the template the project will follow, you may describe its conventions, naming the upstream path they come from.

Change no other files. In the summary, list the commands you chose and why, and anything you were unsure of.
