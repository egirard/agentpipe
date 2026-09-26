import { describe, expect, test } from "bun:test";
import { fakeContext, loadAgent } from "../../../testkit.ts";
import verify from "../verify.ts";

const result = { status: "done" as const, summary: "# agentpipe run\n- result: OK\n## Steps\n- step-1 Add tests for clamp: passed, committed def456\n## Full unit suite: passed\n", findings: [], subtasks: [] };

describe("unit-tester", () => {
  test("manifest loads with a task prefix", () => {
    const { manifest, problems } = loadAgent("unit-tester", import.meta.dir + "/..");
    expect(problems).toEqual([]);
    expect(manifest.task_prefix).toContain("unit tests only");
  });
  test("accepts test-only changes, rejects production changes", async () => {
    expect(await verify(fakeContext({ result, files: { "src/utils.test.ts": "" } }))).toEqual([]);
    const p = await verify(fakeContext({ result, files: { "src/utils.test.ts": "", "src/utils.ts": "" } }));
    expect(p.join(" ")).toContain("src/utils.ts");
  });
});
