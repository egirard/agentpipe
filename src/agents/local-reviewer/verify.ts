import { defineVerifier, noChanges, nonEmptySummary } from "../../verify.ts";
export default defineVerifier(async (ctx) => [...noChanges(ctx.changedFiles), ...nonEmptySummary(ctx.result, 40)]);
