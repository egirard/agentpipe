import { defineVerifier, noChanges, nonEmptySummary, subtasksActionable } from "../../verify.ts";

/** The architect promises a plan: subtasks a stranger could act on, and no code of its own. */
export default defineVerifier(async (ctx) => {
  const { result } = ctx;
  const problems = [...noChanges(ctx.changedFiles), ...nonEmptySummary(result, 200)];
  if (result.status === "done" && result.subtasks.length === 0) problems.push("status is done but no subtasks were created; a plan with nothing to do should be attention with the reason");
  problems.push(...subtasksActionable(result, 200));
  const coderTasks = result.subtasks.filter((s) => s.agent === "coder" || s.agent === "unit-tester");
  for (const s of coderTasks) if (!/test/i.test(s.description)) problems.push(`coder subtask "${s.title.slice(0, 60)}" does not mention tests; every code change needs its acceptance tests named`);
  return problems;
});
