import { defineVerifier, findingsHavePaths, noChanges, nonEmptySummary, subtasksActionable } from "../../verify.ts";

/** An audit changes nothing, names the component for every real finding, and files actionable fixes. */
export default defineVerifier(async (ctx) => [
  ...noChanges(ctx.changedFiles),
  ...nonEmptySummary(ctx.result, 200),
  ...findingsHavePaths(ctx.result, ["blocker", "major"]),
  ...subtasksActionable(ctx.result, 150),
]);
