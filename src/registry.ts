import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { agentpipeRoot, configDir, type ProjectConfig } from "./global.ts";
import { SHELL_GROUPS } from "./shell-policy.ts";
import { sha1 } from "./util.ts";

/**
 * The agent registry. An agent is a directory:
 *
 *   src/agents/<name>/
 *     agent.json      manifest (required)
 *     prompt.md       system prompt (claude and ollama runtimes)
 *     verify.ts       output verification: default export (ctx) => string[] of problems
 *     tests/          bun tests for the agent (cheap ones always; e2e behind AGENTPIPE_E2E=1)
 *     ...             anything else the agent needs: helper scripts, supplemental prompts, fixtures
 *
 * A bare `<name>.json` (+ `<name>.md`) file is still accepted for quick local agents.
 *
 * Three directories are merged in this order, later ones overriding earlier ones by name:
 *   1. <agentpipe>/src/agents/           built-ins, versioned with this repo
 *   2. ~/.config/agentpipe/agents/       your additions on this machine
 *   3. <project agentsDir>               per-project agents (set `agentsDir` in the project config)
 *
 * The architect sees the catalog (name, description, when_to_use, inputs, outputs) and can only
 * delegate to agents that exist here: the subtask JSON schema enumerates the registered names.
 */
export const Runtime = z.enum(["pipeline", "claude", "ollama", "shell"]);
export type Runtime = z.infer<typeof Runtime>;

export const ContextKind = z.enum(["repo-overview", "files", "branch-diff", "queue", "catalog"]);
export type ContextKind = z.infer<typeof ContextKind>;

export const AgentManifest = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "kebab-case name"),
  description: z.string().min(10).describe("One or two sentences. The architect chooses agents by this."),
  runtime: Runtime.describe(
    "pipeline: the coder loop (plan -> local coder -> lint/tests -> review -> commit -> PR). claude: one Claude Code session in the repo. ollama: one local model call. shell: a command.",
  ),
  when_to_use: z.string().default("").describe("Longer guidance for the architect: when this agent is the right choice and when it is not."),
  inputs: z.string().default("").describe("What a task description for this agent must contain."),
  outputs: z.string().default("").describe("What the agent produces: a branch/PR, a report, subtasks."),
  can_delegate: z.boolean().default(false).describe("May create subtasks for other agents."),
  commits: z.boolean().default(false).describe("May change files. The worker gives it a branch, verifies, runs lint + unit tests, commits, and opens a PR."),
  model: z.string().default("").describe("Claude Code model alias (claude runtime) or Ollama model (ollama runtime). Empty = project default."),
  tools: z.array(z.string()).default([]).describe("Extra non-shell Claude Code tools. Bash(...) entries are refused here: shell access is granted through `shell` groups only."),
  shell: z.array(z.string()).default([]).describe("Shell capability groups from src/shell-policy.ts: git-read, gh-read, gh-comment, checks, package-read, ops (shell-runner only). Enforced by allowedTools and a PreToolUse hook."),
  paths: z.array(z.string()).default([]).describe("commits=true only: globs the agent may change. Any other changed file fails verification. Empty = anywhere in the repo."),
  lane: z.string().default("").describe("Worker lane; default gpu for pipeline/ollama, cloud for claude/shell."),
  max_turns: z.number().int().positive().default(40),
  timeout_sec: z.number().int().positive().default(2700),
  context: z.array(ContextKind).default(["repo-overview", "files", "branch-diff"]).describe("What the worker puts in the prompt besides the task."),
  task_prefix: z.string().default("").describe("pipeline runtime: text prepended to the task before planning."),
  command: z.string().default("").describe("shell runtime: the command. Task fields arrive as AGENTPIPE_TASK_* env vars."),
  prompt: z.string().default("").describe("System prompt. Usually left empty and kept in prompt.md."),
  verify: z
    .string()
    .default("")
    .describe("Output verification. A .ts/.js path (relative to the agent directory) whose default export is (ctx) => problems[], or a shell command (exit 0 = pass). Default: verify.ts in the agent directory if present."),
  tags: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
});
export type AgentManifest = z.infer<typeof AgentManifest> & {
  /** Path of the manifest file. */
  source: string;
  /** The agent's directory (null for a bare json file). */
  dir: string | null;
  /** Resolved verifier: absolute script path, or a shell command, or null. */
  verifier: { kind: "script"; path: string } | { kind: "command"; command: string } | null;
  /** Whether tests/ exists in the agent directory. */
  hasTests: boolean;
  /** Extra files in the agent directory besides the well-known ones. */
  extras: string[];
  /** Hash of manifest + prompt + verifier text: the agent's version for track records. */
  version: string;
};

export interface Registry {
  agents: Map<string, AgentManifest>;
  dirs: string[];
  problems: string[];
}

export function builtinAgentsDir(): string {
  return path.join(agentpipeRoot(), "src", "agents");
}

export function registryDirs(project?: ProjectConfig): string[] {
  const dirs = [builtinAgentsDir(), path.join(configDir(), "agents")];
  if (project?.agentsDir) dirs.push(path.isAbsolute(project.agentsDir) ? project.agentsDir : path.join(project.path, project.agentsDir));
  return dirs;
}

const WELL_KNOWN = new Set(["agent.json", "prompt.md", "verify.ts", "verify.js", "tests", "README.md"]);

function loadOne(manifestPath: string, promptPath: string, dir: string | null, reg: Registry): AgentManifest | null {
  const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  const parsed = AgentManifest.parse(raw);
  const prompt = parsed.prompt || (existsSync(promptPath) ? readFileSync(promptPath, "utf8").trim() : "");
  let verifier: AgentManifest["verifier"] = null;
  if (parsed.verify) {
    if (/\.(ts|js|mjs)$/.test(parsed.verify)) {
      const p = path.isAbsolute(parsed.verify) ? parsed.verify : path.join(dir ?? path.dirname(manifestPath), parsed.verify);
      if (!existsSync(p)) reg.problems.push(`${manifestPath}: verify script ${p} does not exist`);
      else verifier = { kind: "script", path: p };
    } else verifier = { kind: "command", command: parsed.verify };
  } else if (dir) {
    for (const f of ["verify.ts", "verify.js"]) if (existsSync(path.join(dir, f))) verifier = { kind: "script", path: path.join(dir, f) };
  }
  const hasTests = Boolean(dir && existsSync(path.join(dir, "tests")));
  const extras = dir ? readdirSync(dir).filter((f) => !WELL_KNOWN.has(f)) : [];
  const verifierText = verifier?.kind === "script" ? readFileSync(verifier.path, "utf8") : verifier?.command ?? "";
  const version = sha1(JSON.stringify(raw) + "\n" + prompt + "\n" + verifierText);
  const m: AgentManifest = { ...parsed, prompt, source: manifestPath, dir, verifier, hasTests, extras, version };
  if (!m.lane) m.lane = m.runtime === "pipeline" || m.runtime === "ollama" ? "gpu" : "cloud";
  const bashTools = m.tools.filter((t) => /^Bash\b/.test(t));
  if (bashTools.length) {
    reg.problems.push(`${manifestPath}: raw shell tools are not allowed (${bashTools.join(", ")}); use "shell" groups instead`);
    m.tools = m.tools.filter((t) => !/^Bash\b/.test(t));
  }
  for (const g of m.shell) if (!SHELL_GROUPS[g]) reg.problems.push(`${manifestPath}: unknown shell group "${g}" (have: ${Object.keys(SHELL_GROUPS).join(", ")})`);
  if (m.shell.includes("ops") && m.name !== "shell-runner") reg.problems.push(`${manifestPath}: only shell-runner may hold the ops group; removed`);
  m.shell = m.shell.filter((g) => SHELL_GROUPS[g] && (g !== "ops" || m.name === "shell-runner"));
  if (m.paths.length && !m.commits && m.runtime !== "pipeline") reg.problems.push(`${manifestPath}: "paths" only applies to agents that change files (commits=true or the pipeline runtime)`);
  const expected = dir ? path.basename(dir) : path.basename(manifestPath, ".json");
  if (m.name !== expected) reg.problems.push(`${manifestPath}: name "${m.name}" does not match the ${dir ? "directory" : "file"} name "${expected}"`);
  if ((m.runtime === "claude" || m.runtime === "ollama") && !m.prompt) reg.problems.push(`${manifestPath}: ${m.runtime} agents need a prompt (inline "prompt" or ${path.basename(promptPath)})`);
  if (m.runtime === "shell" && !m.command) reg.problems.push(`${manifestPath}: shell agents need a "command"`);
  if (m.runtime === "ollama" && m.can_delegate) reg.problems.push(`${manifestPath}: ollama agents cannot delegate reliably; can_delegate ignored`);
  if (m.runtime === "ollama" && m.commits) reg.problems.push(`${manifestPath}: ollama agents cannot edit files; commits ignored`);
  if (m.can_delegate && !m.context.includes("catalog")) m.context = [...m.context, "catalog"];
  return m;
}

export function loadRegistry(project?: ProjectConfig): Registry {
  const reg: Registry = { agents: new Map(), dirs: registryDirs(project), problems: [] };
  for (const root of reg.dirs) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root).sort()) {
      const full = path.join(root, entry);
      let manifestPath: string, promptPath: string, dir: string | null;
      if (statSync(full).isDirectory()) {
        manifestPath = path.join(full, "agent.json");
        if (!existsSync(manifestPath)) continue;
        promptPath = path.join(full, "prompt.md");
        dir = full;
      } else if (entry.endsWith(".json")) {
        manifestPath = full;
        promptPath = full.replace(/\.json$/, ".md");
        dir = null;
      } else continue;
      try {
        const m = loadOne(manifestPath, promptPath, dir, reg);
        if (!m) continue;
        if (!m.enabled) {
          reg.agents.delete(m.name);
          continue;
        }
        reg.agents.set(m.name, m);
      } catch (e) {
        reg.problems.push(`${manifestPath}: ${(e as Error).message.split("\n")[0]}`);
      }
    }
  }
  return reg;
}

export function requireAgent(reg: Registry, name: string): AgentManifest {
  const a = reg.agents.get(name);
  if (!a) throw new Error(`no agent "${name}" in the registry (have: ${[...reg.agents.keys()].join(", ")})`);
  return a;
}

/** Names an agent may delegate to: every registered agent except itself. */
export function delegateTargets(reg: Registry, self?: string): string[] {
  return [...reg.agents.keys()].filter((n) => n !== self);
}

export interface AgentHealth {
  runs: number;
  done: number;
  attention: number;
  failed: number;
  rate: number;
}

/** The catalog as the architect reads it, with each agent's recent track record when known. */
export function renderCatalog(reg: Registry, names = [...reg.agents.keys()], health?: (name: string) => AgentHealth | null, warnRate = 0.5): string {
  const lines: string[] = [];
  for (const n of names) {
    const a = reg.agents.get(n);
    if (!a) continue;
    lines.push(`### ${a.name}  (runtime: ${a.runtime}${a.commits ? ", produces a branch/PR" : ""}${a.can_delegate ? ", can delegate" : ""})`);
    lines.push(a.description);
    const h = health?.(n);
    if (h && h.runs) lines.push(`Track record (last ${h.runs}): ${h.done} done, ${h.attention} attention, ${h.failed} failed${h.rate >= warnRate ? ". WARNING: this agent has been failing or escalating often; prefer another agent or give it smaller, more precise tasks" : ""}.`);
    if (a.when_to_use) lines.push(`When to use: ${a.when_to_use}`);
    if (a.inputs) lines.push(`Task description must include: ${a.inputs}`);
    if (a.outputs) lines.push(`Produces: ${a.outputs}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** `agentpipe agents new NAME`: a complete agent package in the machine directory (or --dir). */
export function scaffoldAgent(name: string, runtime: Runtime, root = path.join(configDir(), "agents")): string[] {
  AgentManifest.shape.name.parse(name);
  const dir = path.join(root, name);
  if (existsSync(dir)) throw new Error(`${dir} already exists`);
  mkdirSync(path.join(dir, "tests"), { recursive: true });
  const manifest: Record<string, unknown> = {
    name,
    description: `TODO: one or two sentences the architect can choose this agent by.`,
    runtime,
    when_to_use: "TODO: when this agent is right, and when it is not.",
    inputs: "TODO: what the task description must contain",
    outputs: runtime === "pipeline" ? "A branch with commits and, when green, a pull request." : "A report with findings; optionally subtasks.",
    can_delegate: runtime === "claude",
    commits: false,
    context: ["repo-overview", "files", "branch-diff"],
    tags: [],
  };
  if (runtime === "claude") manifest.shell = ["git-read"];
  if (runtime === "shell") manifest.command = "echo TODO";
  if (runtime === "pipeline") manifest.task_prefix = "";
  const written: string[] = [];
  const write = (rel: string, text: string) => {
    writeFileSync(path.join(dir, rel), text);
    written.push(path.join(dir, rel));
  };
  write("agent.json", JSON.stringify(manifest, null, 2) + "\n");
  if (runtime === "claude" || runtime === "ollama") {
    write("prompt.md", `You are the ${name} agent in an automated development pipeline.\n\nTODO, in this order: your role and setting; what to examine and how; what a good result contains (findings with file paths, what becomes a subtask vs a recommendation); what not to do; how to decide between status done and attention for this role.\n`);
  }
  const lib = path.relative(dir, path.join(agentpipeRoot(), "src", "verify.ts")).split(path.sep).join("/");
  write(
    "verify.ts",
    `import { defineVerifier, nonEmptySummary } from "${lib.startsWith(".") ? lib : "./" + lib}";

/** Output verification for ${name}: return a list of problems; empty means the output is acceptable. */
export default defineVerifier(async (ctx) => {
  const problems: string[] = [];
  problems.push(...nonEmptySummary(ctx.result, 80));
  // TODO: check that what this agent promises in its manifest actually exists, e.g.
  //   problems.push(...onlyPaths(ctx.changedFiles, ["docs/**", "*.md"]));
  //   if (!ctx.exists("CHANGELOG.md")) problems.push("CHANGELOG.md was not created");
  return problems;
});
`,
  );
  const kit = path.relative(path.join(dir, "tests"), path.join(agentpipeRoot(), "src", "testkit.ts")).split(path.sep).join("/");
  write(
    `tests/${name}.test.ts`,
    `import { describe, expect, test } from "bun:test";
import { fakeContext, loadAgent, runAgentE2E } from "${kit.startsWith(".") ? kit : "./" + kit}";
import verify from "../verify.ts";

describe("${name}", () => {
  test("manifest loads without problems", () => {
    const { manifest, problems } = loadAgent("${name}", import.meta.dir + "/..");
    expect(problems).toEqual([]);
    expect(manifest.description.length).toBeGreaterThan(20);
  });

  test("verifier rejects an empty result", async () => {
    const ctx = fakeContext({ result: { status: "done", summary: "", findings: [], subtasks: [] } });
    expect((await verify(ctx)).length).toBeGreaterThan(0);
  });

  // Runs the real agent on a scratch project. Costs model time; only with AGENTPIPE_E2E=1.
  test.skipIf(!process.env.AGENTPIPE_E2E)("end to end", async () => {
    const r = await runAgentE2E("${name}", "TODO: a realistic task for this agent", { agentDir: import.meta.dir + "/.." });
    expect(["done", "attention", "waiting"]).toContain(r.task.status);
  }, 20 * 60_000);
});
`,
  );
  return written;
}
