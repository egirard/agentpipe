import { describe, expect, test } from "bun:test";
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
  test.skipIf(!process.env.AGENTPIPE_E2E)("writes a package for approval", async () => {
    const r = await runAgentE2E("agent-creator", "Create an agent named changelog-writer (claude runtime, commits, paths CHANGELOG.md) that adds an entry to CHANGELOG.md for a given branch's changes. Inputs: the branch. Outputs: a branch with the CHANGELOG.md change.");
    expect(r.task.status).toBe("attention");
    expect(r.task.confirmation?.request.steps.some((s) => /agent\.json$/.test(s.path ?? ""))).toBe(true);
  }, 25 * 60_000);
});
