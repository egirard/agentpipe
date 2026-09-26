import { describe, expect, test } from "bun:test";
import { fakeContext, loadAgent } from "../../../testkit.ts";
import verify from "../verify.ts";

describe("local-reviewer", () => {
  test("manifest loads as an ollama agent without delegation", () => {
    const { manifest, problems } = loadAgent("local-reviewer", import.meta.dir + "/..");
    expect(problems).toEqual([]);
    expect(manifest.runtime).toBe("ollama");
    expect(manifest.can_delegate).toBe(false);
  });
  test("rejects an empty review", async () => {
    expect((await verify(fakeContext({ result: { status: "done", summary: "ok", findings: [], subtasks: [] } }))).length).toBe(1);
  });
});
