import { loadRegistry } from "../../registry.ts";
import { defineVerifier, noChanges, nonEmptySummary, subtasksActionable } from "../../verify.ts";

/**
 * The architect promises a plan: subtasks a stranger could act on, or well-formed new projects,
 * and no code of its own. Agents it proposes must be new names with a reason; a plan that is
 * "done" with nothing to do is not a plan.
 */
export default defineVerifier(async (ctx) => {
  const { result } = ctx;
  const problems = [...noChanges(ctx.changedFiles), ...nonEmptySummary(result, 200)];
  const projects = result.projects ?? [];
  const proposals = result.agent_proposals ?? [];
  if (result.status === "done" && result.subtasks.length === 0 && projects.length === 0) problems.push("status is done but no subtasks or projects were created; a plan with nothing to do should be attention with the reason" + (proposals.length ? " (agents were proposed: return attention so the human creates them)" : ""));
  if (result.status === "cancelled" && (result.subtasks.length || projects.length)) problems.push("status is cancelled but subtasks or projects were returned; a cancelled goal plans nothing");
  const registered = new Set(loadRegistry(ctx.project).agents.keys());
  for (const p of proposals) {
    if (registered.has(p.name)) problems.push(`proposed agent "${p.name}" already exists; delegate to it instead of proposing it`);
    if (!/\S/.test(p.why) || p.why.trim().length < 20) problems.push(`proposed agent "${p.name}" does not say why it is needed`);
  }
  for (const s of result.subtasks) if (proposals.some((p) => p.name === s.agent)) problems.push(`subtask "${s.title.slice(0, 60)}" names proposed agent "${s.agent}", which does not exist yet; work for it waits until a human creates it`);
  for (const p of projects) {
    if (p.kind === "branch" && !p.parent) problems.push(`project ${p.name}: a branch stream needs "parent"`);
    if (p.kind === "clone" && !p.repo) problems.push(`project ${p.name}: clone needs "repo"`);
    if (p.kind !== "branch" && p.parent) problems.push(`project ${p.name}: "parent" only applies to branch streams`);
  }
  problems.push(...subtasksActionable(result, 200));
  const coderTasks = result.subtasks.filter((s) => s.agent === "coder" || s.agent === "unit-tester");
  for (const s of coderTasks) if (!/test/i.test(s.description)) problems.push(`coder subtask "${s.title.slice(0, 60)}" does not mention tests; every code change needs its acceptance tests named`);
  return problems;
});
