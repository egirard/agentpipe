import { defineVerifier, noChanges, nonEmptySummary, subtasksActionable } from "../../verify.ts";
/** Reports only: nothing changes on disk, and the report is substantial. */
export default defineVerifier(async (ctx) => [...noChanges(ctx.changedFiles), ...nonEmptySummary(ctx.result, 120), ...subtasksActionable(ctx.result, 120)]);
