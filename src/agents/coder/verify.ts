import { defineVerifier, forbidPaths, nonEmptySummary, requireChanges } from "../../verify.ts";

const BASELINES = ["**/*-snapshots/**", "**/__screenshots__/**", "**/*.png"];

/** The coder promises a branch with committed, tested changes and no baseline edits. */
export default defineVerifier(async (ctx) => {
  const problems = [...nonEmptySummary(ctx.result, 100), ...forbidPaths(ctx.changedFiles, BASELINES, "is a screenshot baseline; the pipeline must never update those")];
  if (ctx.result.status === "done") {
    problems.push(...requireChanges(ctx.changedFiles));
    if (!ctx.branch) problems.push("done without a branch");
    const log = await ctx.sh(`git log --oneline ${ctx.baseSha}..HEAD`);
    if (!log.output.trim()) problems.push("done but nothing is committed on the branch");
  }
  return problems;
});
