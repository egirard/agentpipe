import { defineVerifier, noChanges, nonEmptySummary, subtasksActionable } from "../../verify.ts";

/** The shell-runner promises a report of every command with its verdict, and changes nothing itself. */
export default defineVerifier(async (ctx) => {
  const problems = [...noChanges(ctx.changedFiles), ...nonEmptySummary(ctx.result, 120), ...subtasksActionable(ctx.result, 120)];
  if (ctx.result.status === "done" && !/exit(ed)?\s*(code)?\s*\d|refused/i.test(ctx.result.summary)) problems.push("summary reports neither an exit code nor a refusal for any command");
  return problems;
});
