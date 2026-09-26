import { describe, expect, test } from "bun:test";
import { fakeContext, loadAgent } from "../../../testkit.ts";
import verify from "../verify.ts";

describe("a11y-reviewer", () => {
  test("manifest loads and delegates without committing", () => {
    const { manifest, problems } = loadAgent("a11y-reviewer", import.meta.dir + "/..");
    expect(problems).toEqual([]);
    expect(manifest.can_delegate).toBe(true);
    expect(manifest.commits).toBe(false);
  });
  test("rejects a major finding without a path", async () => {
    const p = await verify(fakeContext({ result: { status: "done", summary: "x".repeat(210), findings: [{ severity: "major", description: "no focus ring" }], subtasks: [] } }));
    expect(p.join(" ")).toContain("no file path");
  });
});
