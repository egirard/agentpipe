import { describe, expect, test } from "bun:test";
import { fakeContext, loadAgent, runAgentE2E } from "../../../testkit.ts";
import verify from "../verify.ts";

const result = { status: "done" as const, summary: "Rewrote README.md sections Install and Use to match the current CLI flags.", findings: [], subtasks: [] };

describe("docs-writer", () => {
  test("manifest loads as a committing agent", () => {
    const { manifest, problems } = loadAgent("docs-writer", import.meta.dir + "/..");
    expect(problems).toEqual([]);
    expect(manifest.commits).toBe(true);
  });
  test("accepts markdown, rejects source edits and empty done", async () => {
    expect(await verify(fakeContext({ result, files: { "README.md": "" } }))).toEqual([]);
    expect((await verify(fakeContext({ result, files: { "README.md": "", "src/a.ts": "" } }))).join(" ")).toContain("src/a.ts");
    expect((await verify(fakeContext({ result }))).join(" ")).toContain("no documentation");
  });
  test.skipIf(!process.env.AGENTPIPE_E2E)("edits only documentation", async () => {
    const r = await runAgentE2E("docs-writer", "Add a 'Usage' section to README.md explaining that src/utils.ts exports the constant one.");
    expect(r.task.status).toBe("done");
    expect(r.task.branch).toMatch(/^agentpipe\/docs-writer/);
  }, 15 * 60_000);
});
