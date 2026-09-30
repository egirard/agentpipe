import path from "node:path";
import { configDir, expandHome } from "../../global.ts";
import { AgentManifest } from "../../registry.ts";
import { defineVerifier, noChanges, nonEmptySummary } from "../../verify.ts";

/**
 * The agent-creator promises an installable package: every file under the machine agents
 * directory for one agent, a manifest that parses and matches the directory, a prompt where the
 * runtime needs one, a verifier and a test, and the test run as the last step.
 */
export default defineVerifier(async (ctx) => {
  const { result } = ctx;
  const problems = [...noChanges(ctx.changedFiles), ...nonEmptySummary(result, 200)];
  const c = result.confirmation;
  if (result.status === "attention" && !c && !/\?/.test(result.summary)) problems.push("attention without a confirmation request must ask the human a question");
  if (!c) return problems;
  if (result.status !== "attention") problems.push(`a confirmation request goes with status attention, not ${result.status}`);
  const root = path.join(configDir(), "agents");
  const writes = c.steps.filter((s) => s.kind === "write");
  const dirs = new Set<string>();
  const files = new Map<string, string>();
  for (const w of writes) {
    const abs = path.normalize(expandHome(w.path ?? ""));
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      problems.push(`${w.path} is not under the machine agents directory ${root}`);
      continue;
    }
    const [name, ...rest] = rel.split(path.sep);
    dirs.add(name);
    files.set(rest.join("/"), w.content ?? "");
  }
  if (dirs.size !== 1) problems.push(`the package must write exactly one agent directory (found ${[...dirs].join(", ") || "none"})`);
  const name = [...dirs][0] ?? "";
  const manifestText = files.get("agent.json");
  if (!manifestText) problems.push("agent.json is missing");
  else {
    try {
      const m = AgentManifest.parse(JSON.parse(manifestText));
      if (m.name !== name) problems.push(`agent.json names "${m.name}" but the directory is "${name}"`);
      if ((m.runtime === "claude" || m.runtime === "ollama") && !m.prompt && !files.get("prompt.md")?.trim()) problems.push(`${m.runtime} agents need prompt.md`);
      if (m.shell.includes("ops")) problems.push("the ops shell group is reserved for shell-runner");
      if (m.runtime === "shell" && !m.command) problems.push("shell agents need a command");
    } catch (e) {
      problems.push(`agent.json does not parse as a manifest: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  if (!files.has("verify.ts")) problems.push("verify.ts is missing");
  if (![...files.keys()].some((f) => f.startsWith("tests/") && f.endsWith(".test.ts"))) problems.push("tests/<name>.test.ts is missing");
  const last = c.steps[c.steps.length - 1];
  if (last.kind !== "command" || !/^bun test\b/.test(last.command ?? "")) problems.push("the last step must run the package's tests (bun test <dir>/tests)");
  if (result.subtasks.length) problems.push("a confirmation request cannot come with subtasks");
  return problems;
});
