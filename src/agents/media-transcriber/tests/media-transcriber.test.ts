import { describe, expect, test } from "bun:test";
import { fakeContext, loadAgent, runAgentE2E } from "../../../testkit.ts";
import verify from "../verify.ts";

const header = "# Source of the Nile rules, chapter 3\n\nSource: upstream/rules-reference/rulebook.pdf (commit 1a2b3c4), pages 12-18, transcribed 2026-10-03. Gaps marked: 1.\n\n## 3.1 Movement\n...";
const good = { status: "done" as const, summary: "Transcribed upstream/rules-reference/rulebook.pdf pages 12-18 into docs/rules/chapter-3.md. Gaps: one [uncertain] on page 14 (the movement cost of swamp is 2 or 3; the scan is smudged). No other passages were unclear.", findings: [], subtasks: [] };

describe("media-transcriber", () => {
  test("manifest loads as a committing agent limited to docs", () => {
    const { manifest, problems } = loadAgent("media-transcriber", import.meta.dir + "/..");
    expect(problems).toEqual([]);
    expect(manifest.commits).toBe(true);
    expect(manifest.paths).toContain("docs/**");
    expect(manifest.shell).toEqual(["git-read"]);
  });
  test("accepts a sourced transcription with its gaps reported", async () => {
    expect(await verify(fakeContext({ result: good, files: { "docs/rules/chapter-3.md": header } }))).toEqual([]);
  });
  test("rejects code changes, edits to the originals, missing provenance and a report without gaps", async () => {
    expect((await verify(fakeContext({ result: good, files: { "docs/rules/chapter-3.md": header, "src/rules.ts": "" } }))).join(" ")).toContain("src/rules.ts");
    expect((await verify(fakeContext({ result: good, files: { "upstream/rules-reference/notes.md": header } }))).join(" ")).toContain("upstream original");
    expect((await verify(fakeContext({ result: good, files: { "docs/rules/chapter-3.md": "## 3.1 Movement\nMove one hex." } }))).join(" ")).toContain("does not name its source");
    expect((await verify(fakeContext({ result: { ...good, summary: "Transcribed the rulebook chapter 3 into docs/rules/chapter-3.md; movement, combat and trading sections are complete and formatted as in the source document with page references." }, files: { "docs/rules/chapter-3.md": header } }))).join(" ")).toContain("gaps");
    expect((await verify(fakeContext({ result: good }))).join(" ")).toContain("no transcription files");
  });
  test.skipIf(!process.env.AGENTPIPE_E2E)("transcribes a text source into docs", async () => {
    const r = await runAgentE2E("media-transcriber", "Transcribe README.md (treat it as the source document) into docs/transcript.md with a header naming the source; mark nothing as unreadable unless it is.");
    expect(r.task.status).toBe("done");
    expect(r.task.branch).toMatch(/^agentpipe\/media-transcriber/);
  }, 20 * 60_000);
});
