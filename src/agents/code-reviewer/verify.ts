import { defineVerifier, findingsHavePaths, noChanges, nonEmptySummary, subtasksActionable } from "../../verify.ts";

/** A review names files for anything that must change, changes nothing itself, and files actionable fixes. */
export default defineVerifier(async (ctx) => [
  ...noChanges(ctx.changedFiles),
  ...nonEmptySummary(ctx.result, 150),
  ...findingsHavePaths(ctx.result, ["blocker", "major"]),
  ...subtasksActionable(ctx.result, 150),
]);
