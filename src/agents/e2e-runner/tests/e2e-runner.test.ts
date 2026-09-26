import { describe, expect, test } from "bun:test";
import { loadAgent, runAgentE2E } from "../../../testkit.ts";

describe("e2e-runner", () => {
  test("manifest loads as a shell agent", () => {
    const { manifest, problems } = loadAgent("e2e-runner", import.meta.dir + "/..");
    expect(problems).toEqual([]);
    expect(manifest.runtime).toBe("shell");
    expect(manifest.command).toContain("agentpipe-e2e");
  });
  // Cheap real run: the scratch repo has no Playwright, so agentpipe-e2e exits 2 and the task lands in attention with the output.
  test("reports a failing command as attention", async () => {
    const r = await runAgentE2E("e2e-runner", "Run the e2e suite");
    expect(r.task.status).toBe("attention");
    expect(r.result?.summary).toContain("agentpipe-e2e");
  }, 60_000);
});
