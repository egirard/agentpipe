import { describe, expect, test } from "bun:test";
import { fakeContext, loadAgent } from "../../../testkit.ts";
import verify from "../verify.ts";

const result = { status: "done" as const, summary: "Added icons/skip.svg matching the existing 24px stroke icons; e2e 011 screenshots will differ.", findings: [], subtasks: [] };

describe("graphics-designer", () => {
  test("manifest loads", () => {
    const { manifest, problems } = loadAgent("graphics-designer", import.meta.dir + "/..");
    expect(problems).toEqual([]);
    expect(manifest.commits).toBe(true);
  });
  test("checks svg hygiene", async () => {
    const good = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';
    expect(await verify(fakeContext({ result, files: { "static/icons/skip.svg": good } }))).toEqual([]);
    const bad = '<svg xmlns="http://www.w3.org/2000/svg" width="24"><metadata>x</metadata><script>1</script></svg>';
    const p = await verify(fakeContext({ result, files: { "static/icons/skip.svg": bad } }));
    expect(p.length).toBeGreaterThanOrEqual(3);
    expect((await verify(fakeContext({ result, files: { "src/App.svelte": "" } }))).join(" ")).toContain("non-asset");
  });
});
