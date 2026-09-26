import { describe, expect, test } from "bun:test";
import { fakeContext, loadAgent } from "../../../testkit.ts";
import verify from "../verify.ts";

describe("project-manager", () => {
  test("manifest loads read-only with gh access limited to listed verbs", () => {
    const { manifest, problems } = loadAgent("project-manager", import.meta.dir + "/..");
    expect(problems).toEqual([]);
    expect(manifest.commits).toBe(false);
    for (const t of manifest.tools) expect(t).not.toMatch(/gh pr (merge|close)|git push|branch -D/);
  });
  test("rejects a report that changed files", async () => {
    const p = await verify(fakeContext({ result: { status: "done", summary: "x".repeat(130), findings: [], subtasks: [] }, files: { "a.txt": "" } }));
    expect(p.join(" ")).toContain("not allowed");
  });
});
