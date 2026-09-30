import { describe, expect, test } from "bun:test";
import { fakeContext, loadAgent, runAgentE2E } from "../../../testkit.ts";
import verify from "../verify.ts";

const result = { status: "done" as const, summary: "Chose bun run lint and bun test from package.json scripts and the CI workflow.", findings: [], subtasks: [] };
const notes = "# Agent notes\n\nTypeScript on Bun. Source lives in src/, tests next to the code as *.test.ts and run with bun test. Lint with bun run lint. Do not edit generated files under dist/. Keep functions small and name tests after the behaviour they check.";
const good = { "agentpipe.json": JSON.stringify({ commands: { lint: "bun run lint", unit: "bun test", e2e: "" } }), "AGENTPIPE.md": notes };

describe("project-setup", () => {
  test("manifest loads as a committing agent limited to the two files", () => {
    const { manifest, problems } = loadAgent("project-setup", import.meta.dir + "/..");
    expect(problems).toEqual([]);
    expect(manifest.commits).toBe(true);
    expect(manifest.paths).toEqual(["agentpipe.json", "AGENTPIPE.md"]);
  });
  test("accepts both files with commands", async () => {
    expect(await verify(fakeContext({ result, files: good }))).toEqual([]);
  });
  test("rejects missing commands, bad JSON, thin notes and other files", async () => {
    const p1 = await verify(fakeContext({ result, files: { ...good, "agentpipe.json": JSON.stringify({ commands: { lint: "" } }) } }));
    expect(p1.join(" ")).toContain("commands.lint");
    expect(p1.join(" ")).toContain("commands.unit");
    expect((await verify(fakeContext({ result, files: { ...good, "agentpipe.json": "{nope" } }))).join(" ")).toContain("not valid JSON");
    expect((await verify(fakeContext({ result, files: { ...good, "AGENTPIPE.md": "# hi" } }))).join(" ")).toContain("too short");
    expect((await verify(fakeContext({ result, files: { ...good, "src/a.ts": "" } }))).join(" ")).toContain("src/a.ts");
  });
  test.skipIf(!process.env.AGENTPIPE_E2E)("writes a working agentpipe.json", async () => {
    const r = await runAgentE2E("project-setup", "Set up agentpipe for this repository.", { files: { "package.json": JSON.stringify({ scripts: { lint: "true", test: "true" } }) } });
    expect(r.task.status).toBe("done");
  }, 15 * 60_000);
});
