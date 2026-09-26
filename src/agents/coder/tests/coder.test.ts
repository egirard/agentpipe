import { describe, expect, test } from "bun:test";
import { fakeContext, loadAgent, runAgentE2E } from "../../../testkit.ts";
import verify from "../verify.ts";

const summary = "# agentpipe run\n- result: OK\n## Steps\n- step-1 passed with lint and unit green, committed abc123\n## Final review\nVERDICT: approve\n";
const shOk = async () => ({ ok: true, code: 0, output: "abc123 Add clamp\n", timedOut: false, seconds: 0 });

describe("coder", () => {
  test("manifest loads", () => {
    const { manifest, problems } = loadAgent("coder", import.meta.dir + "/..");
    expect(problems).toEqual([]);
    expect(manifest.runtime).toBe("pipeline");
  });
  test("accepts committed changes on a branch", async () => {
    expect(await verify(fakeContext({ result: { status: "done", summary, findings: [], subtasks: [] }, files: { "src/utils.ts": "x" }, branch: "agentpipe/x", sh: shOk }))).toEqual([]);
  });
  test("rejects baseline changes and empty done", async () => {
    const p = await verify(fakeContext({ result: { status: "done", summary, findings: [], subtasks: [] }, files: { "e2e/011.spec.ts-snapshots/a.png": "" }, branch: "agentpipe/x", sh: shOk }));
    expect(p.join(" ")).toContain("baseline");
    const q = await verify(fakeContext({ result: { status: "done", summary, findings: [], subtasks: [] }, branch: "agentpipe/x", sh: async () => ({ ok: true, code: 0, output: "", timedOut: false, seconds: 0 }) }));
    expect(q.join(" ")).toContain("no file changes");
  });
  test.skipIf(!process.env.AGENTPIPE_E2E)("implements a helper with a test", async () => {
    const r = await runAgentE2E("coder", "Add export function clamp(value: number, min: number, max: number): number to src/utils.ts and a vitest unit test in src/utils.test.ts (in range, below, above). The repo's unit command is a no-op; just create the files.");
    expect(["done", "attention"]).toContain(r.task.status);
    expect(r.task.branch).toMatch(/^agentpipe\//);
  }, 30 * 60_000);
});
