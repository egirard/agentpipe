import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { configDir } from "../../../global.ts";
import { fakeContext, loadAgent, runAgentE2E } from "../../../testkit.ts";
import verify from "../verify.ts";

const dir = path.join(configDir(), "agents", "sql-reviewer");
const manifest = { name: "sql-reviewer", description: "Reviews SQL migrations and queries for safety, performance and reversibility.", runtime: "claude", when_to_use: "After a coder task that adds or changes SQL.", inputs: "The branch to review.", outputs: "A report with findings.", shell: ["git-read"], context: ["branch-diff"] };
const request = {
  title: "Install the sql-reviewer agent (4 files) and run its tests",
  why: "The architect needs a reviewer for SQL migrations; no registered agent reads SQL for safety and reversibility.",
  risk: "Nothing irreversible: four new files under the machine agents directory; delete the directory to uninstall.",
  steps: [
    { kind: "write" as const, path: path.join(dir, "agent.json"), content: JSON.stringify(manifest, null, 2), why: "manifest" },
    { kind: "write" as const, path: path.join(dir, "prompt.md"), content: "You review SQL.\n\nLook at every migration...", why: "prompt" },
    { kind: "write" as const, path: path.join(dir, "verify.ts"), content: "export default async () => [];", why: "verifier" },
    { kind: "write" as const, path: path.join(dir, "tests", "sql-reviewer.test.ts"), content: "import { test } from 'bun:test'; test('x', () => {});", why: "tests" },
    { kind: "command" as const, command: `bun test ${path.join(dir, "tests")}`, cwd: "/home/x/src/agentpipe", why: "check the package" },
  ],
  links: ["https://example.com/spec"],
  continue_after: false,
};
const base = { status: "attention" as const, summary: "Design: sql-reviewer is a read-only claude agent with the git-read group, run after coder tasks that touch migrations. Its verifier requires findings to name files. The prompt covers reversibility, locking and index use. Look at prompt.md first.", findings: [], subtasks: [] };

describe("agent-creator", () => {
  test("manifest loads and requires confirmation", () => {
    const { manifest, problems } = loadAgent("agent-creator", import.meta.dir + "/..");
    expect(problems).toEqual([]);
    expect(manifest.requires_confirmation).toBe(true);
    expect(manifest.context).toContain("agentpipe");
  });
  test("accepts a complete package; rejects wrong places, bad manifests, missing files and no test run", async () => {
    expect(await verify(fakeContext({ result: { ...base, confirmation: request } }))).toEqual([]);
    const outside = { ...request, steps: [{ ...request.steps[0], path: "/tmp/sql-reviewer/agent.json" }, ...request.steps.slice(1)] };
    expect((await verify(fakeContext({ result: { ...base, confirmation: outside } }))).join(" ")).toContain("not under the machine agents directory");
    const badName = { ...request, steps: [{ ...request.steps[0], content: JSON.stringify({ ...manifest, name: "other" }) }, ...request.steps.slice(1)] };
    expect((await verify(fakeContext({ result: { ...base, confirmation: badName } }))).join(" ")).toContain('names "other"');
    const noPrompt = { ...request, steps: request.steps.filter((s) => !/prompt\.md$/.test(s.path ?? "")) };
    expect((await verify(fakeContext({ result: { ...base, confirmation: noPrompt } }))).join(" ")).toContain("prompt.md");
    const noTest = { ...request, steps: request.steps.slice(0, -1) };
    expect((await verify(fakeContext({ result: { ...base, confirmation: noTest } }))).join(" ")).toContain("last step must run");
    const ops = { ...request, steps: [{ ...request.steps[0], content: JSON.stringify({ ...manifest, shell: ["ops"] }) }, ...request.steps.slice(1)] };
    expect((await verify(fakeContext({ result: { ...base, confirmation: ops } }))).join(" ")).toContain("ops");
  });
  test("a revision of an installed package may rewrite one file, but must quote what it replaces", async () => {
    // Install a package in a scratch machine agents directory, then revise only its prompt.
    const root = mkdtempSync(path.join(tmpdir(), "agentpipe-creator-"));
    const saved = process.env.AGENTPIPE_CONFIG_DIR;
    process.env.AGENTPIPE_CONFIG_DIR = root;
    try {
      const pkg = path.join(root, "agents", "sql-reviewer");
      mkdirSync(path.join(pkg, "tests"), { recursive: true });
      writeFileSync(path.join(pkg, "agent.json"), JSON.stringify(manifest));
      writeFileSync(path.join(pkg, "prompt.md"), "You review SQL. Run find -exec file on everything.");
      writeFileSync(path.join(pkg, "verify.ts"), "export default async () => [];");
      writeFileSync(path.join(pkg, "tests", "sql-reviewer.test.ts"), "");
      const revision = {
        ...request,
        title: "Fix sql-reviewer's prompt: stop asking for find -exec",
        risk: "Only prompt.md changes; the previous text is quoted in the summary for restoring.",
        steps: [{ kind: "write" as const, path: path.join(pkg, "prompt.md"), content: "You review SQL. Read each migration with the Read tool.", why: "drop the refused command" }, { kind: "command" as const, command: `bun test ${path.join(pkg, "tests")}`, cwd: "/home/x/src/agentpipe", why: "check" }],
      };
      const summary = "Fix: the prompt told the agent to batch `file` through find -exec, which the policy refuses as indirect execution. Before: 'Run find -exec file on everything.' After: 'Read each migration with the Read tool.' Nothing else changes; the manifest, verifier and tests stay as installed.";
      expect(await verify(fakeContext({ result: { ...base, summary, confirmation: revision } }))).toEqual([]);
      const silent = { ...revision, risk: "Only prompt.md changes." };
      expect((await verify(fakeContext({ result: { ...base, summary: "Fixed the prompt so the agent reads migrations with the Read tool instead of running a refused command; nothing else in the package changes and the tests still pass as the last step.", confirmation: silent } }))).join(" ")).toContain("previous content");
      // A brand-new package still needs every file.
      const fresh = { ...revision, steps: [{ ...revision.steps[0], path: path.join(root, "agents", "other-agent", "prompt.md") }, revision.steps[1]] };
      expect((await verify(fakeContext({ result: { ...base, summary, confirmation: fresh } }))).join(" ")).toContain("agent.json is missing");
    } finally {
      if (saved === undefined) delete process.env.AGENTPIPE_CONFIG_DIR;
      else process.env.AGENTPIPE_CONFIG_DIR = saved;
      rmSync(root, { recursive: true, force: true });
    }
  });
  test.skipIf(!process.env.AGENTPIPE_E2E)("writes a package for approval", async () => {
    const r = await runAgentE2E("agent-creator", "Create an agent named changelog-writer (claude runtime, commits, paths CHANGELOG.md) that adds an entry to CHANGELOG.md for a given branch's changes. Inputs: the branch. Outputs: a branch with the CHANGELOG.md change.");
    expect(r.task.status).toBe("attention");
    expect(r.task.confirmation?.request.steps.some((s) => /agent\.json$/.test(s.path ?? ""))).toBe(true);
  }, 25 * 60_000);
});
