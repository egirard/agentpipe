import { defineVerifier, nonEmptySummary, onlyPaths, requireChanges } from "../../verify.ts";

const DOC_FILES = ["**/*.md", "**/*.mdx", "**/*.txt", "**/*.rst", "docs/**", "LICENSE*", "CHANGELOG*"];

/** The docs writer promises documentation changes and nothing else. */
export default defineVerifier(async (ctx) => {
  const problems = [...nonEmptySummary(ctx.result, 60), ...onlyPaths(ctx.changedFiles, DOC_FILES, "non-documentation")];
  if (ctx.result.status === "done") problems.push(...requireChanges(ctx.changedFiles, "documentation changes"));
  return problems;
});
