import { defineVerifier, forbidPaths, nonEmptySummary, onlyPaths, requireChanges } from "../../verify.ts";

const OUTPUT_FILES = ["docs/**", "**/*.md", "**/*.csv"];

/**
 * The transcriber promises text files under docs/ (or Markdown/CSV where the task says) with
 * their provenance stated, the originals untouched, and a report that names each source file and
 * every gap it marked.
 */
export default defineVerifier(async (ctx) => {
  const problems = [...nonEmptySummary(ctx.result, 120), ...onlyPaths(ctx.changedFiles, OUTPUT_FILES, "non-transcription"), ...forbidPaths(ctx.changedFiles, ["upstream/**"], "is an upstream original; transcriptions go into the project")];
  if (ctx.result.status !== "done") return problems;
  problems.push(...requireChanges(ctx.changedFiles, "transcription files"));
  for (const f of ctx.changedFiles.filter((p) => /\.(md|csv)$/i.test(p))) {
    let text = "";
    try {
      text = ctx.read(f);
    } catch {
      continue; // deleted or unreadable: nothing to check for a header
    }
    if (!/source|transcribed from|upstream\//i.test(text.slice(0, 1500))) problems.push(`${f} does not name its source in its header`);
  }
  if (!/\[(unreadable|uncertain)|no gaps|0 gaps|nothing (was )?marked/i.test(ctx.result.summary)) problems.push("the report must list the gaps marked [unreadable]/[uncertain], or say there were none");
  return problems;
});
