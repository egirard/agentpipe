import { describe, expect, test } from "bun:test";
import { fakeContext, loadAgent, runAgentE2E } from "../../../testkit.ts";
import verify from "../verify.ts";

const summary = "Reviewed agentpipe/x against main. The clamp helper is correct; the test covers bounds. One nit on JSDoc. VERDICT: approve.".padEnd(160, ".");

describe("code-reviewer", () => {
  test("manifest loads", () => {
    const { manifest, problems } = loadAgent("code-reviewer", import.meta.dir + "/..");
    expect(problems).toEqual([]);
    expect(manifest.context).toContain("branch-diff");
  });
  test("requires paths on blockers", async () => {
    const ok = await verify(fakeContext({ result: { status: "done", summary, findings: [{ severity: "blocker", path: "src/a.ts", description: "off by one" }], subtasks: [] } }));
    expect(ok).toEqual([]);
    const bad = await verify(fakeContext({ result: { status: "done", summary, findings: [{ severity: "blocker", description: "off by one" }], subtasks: [] } }));
    expect(bad.join(" ")).toContain("no file path");
  });
  test.skipIf(!process.env.AGENTPIPE_E2E)("reviews a branch", async () => {
    const r = await runAgentE2E("code-reviewer", "Review branch main against itself: confirm there is nothing to review and say so.", { branch: "main" });
    expect(["done", "attention"]).toContain(r.task.status);
  }, 15 * 60_000);
});
