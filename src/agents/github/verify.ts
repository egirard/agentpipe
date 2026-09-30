import { defineVerifier, noChanges, nonEmptySummary } from "../../verify.ts";

/**
 * The github agent promises exact, reversible-by-default commands: every step is a git, gh, mkdir
 * or a few housekeeping commands, nothing destructive unless the risk says so, no files written.
 */
const ALLOWED = /^(git|gh|mkdir|cp|mv|ln|touch|echo|cat|ls|test|true)\b/;
/** Destructive shapes and the word the risk statement must then contain. */
const DESTRUCTIVE: [RegExp, RegExp][] = [
  [/--force\b|\s-f\b|--force-with-lease|\bpush\s+.*\+\S+|\bfilter-branch\b/, /force|rewrit/i],
  [/--delete\b|\bbranch\s+-[dD]\b|\brepo\s+delete\b|\bissue\s+delete\b|\brelease\s+delete\b/, /delet/i],
  [/\breset\s+--hard\b|\bclean\s+-[a-z]*f/, /discard|reset|lose/i],
  [/\bvisibility\b|--public\b/, /public|visib/i],
];

export default defineVerifier(async (ctx) => {
  const { result } = ctx;
  const problems = [...noChanges(ctx.changedFiles), ...nonEmptySummary(result, 80)];
  const c = result.confirmation;
  if (result.status === "attention" && !c && !/\?/.test(result.summary)) problems.push("attention without a confirmation request must ask the human a question");
  if (!c) return problems;
  if (result.status !== "attention") problems.push(`a confirmation request goes with status attention, not ${result.status}`);
  c.steps.forEach((s, i) => {
    const n = `step ${i + 1}`;
    if (s.kind !== "command") return void problems.push(`${n}: the github agent proposes commands, not file writes`);
    const cmd = (s.command ?? "").trim();
    if (!ALLOWED.test(cmd)) problems.push(`${n}: "${cmd.slice(0, 50)}" is not a git/gh command`);
    if (/<[A-Z_]+>|\bowner\/name\b|\bNUMBER\b|\bBRANCH\b(?!\S)/.test(cmd) && !/"[^"]*\b(BRANCH|NUMBER)\b[^"]*"/.test(cmd)) problems.push(`${n}: looks like a placeholder was left in "${cmd.slice(0, 50)}"`);
    for (const [shape, word] of DESTRUCTIVE) if (shape.test(cmd) && !word.test(c.risk)) problems.push(`${n}: destructive command "${cmd.slice(0, 50)}" but the risk does not say so`);
  });
  if (result.subtasks.length) problems.push("a confirmation request cannot come with subtasks");
  return problems;
});
