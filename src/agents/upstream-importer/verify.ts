import { defineVerifier, forbidPaths, nonEmptySummary, requireChanges } from "../../verify.ts";

/**
 * The importer promises files copied from an upstream with their provenance stated: on done,
 * something changed, nothing landed in a protected tree, and the report names the upstream commit.
 */
export default defineVerifier(async (ctx) => {
  const problems = [...nonEmptySummary(ctx.result, 40), ...forbidPaths(ctx.changedFiles, [".git/**", ".agentpipe/**", "upstream/**", "**/node_modules/**"], "is a protected path the importer must never write")];
  if (ctx.result.status !== "done") return problems;
  problems.push(...requireChanges(ctx.changedFiles, "imported files"));
  if (!/\bcommit [0-9a-f]{7,40}\b/.test(ctx.result.summary)) problems.push("the report does not name the upstream commit the files came from");
  return problems;
});
