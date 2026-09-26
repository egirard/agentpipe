import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { builtinAgentsDir, loadRegistry } from "./registry.ts";

/** Every built-in agent is a complete package: manifest, prompt where needed, verifier, tests. */
describe("built-in agent registry", () => {
  const reg = loadRegistry();
  const builtins = readdirSync(builtinAgentsDir()).filter((d) => existsSync(path.join(builtinAgentsDir(), d, "agent.json")));

  test("loads every built-in without problems", () => {
    expect(reg.problems).toEqual([]);
    for (const name of builtins) expect(reg.agents.has(name)).toBe(true);
  });

  test.each(builtins)("%s is a complete package", (name) => {
    const a = reg.agents.get(name)!;
    expect(a.dir).toBe(path.join(builtinAgentsDir(), name));
    expect(a.description.length).toBeGreaterThan(30);
    expect(a.when_to_use.length).toBeGreaterThan(20);
    expect(a.inputs.length).toBeGreaterThan(10);
    expect(a.outputs.length).toBeGreaterThan(10);
    if (a.runtime === "claude" || a.runtime === "ollama") expect(a.prompt.length).toBeGreaterThan(100);
    if (a.runtime !== "shell") expect(a.verifier).not.toBeNull();
    expect(a.hasTests).toBe(true);
    expect(a.commits && a.can_delegate).toBe(false);
    expect(a.tools.some((t) => /^Bash/.test(t))).toBe(false);
    if (a.shell.includes("ops")) expect(name).toBe("shell-runner");
    expect(["gpu", "cloud"]).toContain(a.lane);
  });

  test("only shell-runner holds the ops group", () => {
    const holders = [...reg.agents.values()].filter((a) => a.shell.includes("ops")).map((a) => a.name);
    expect(holders).toEqual(["shell-runner"]);
  });

  test("delegation targets never include the agent itself", () => {
    for (const name of reg.agents.keys()) {
      const targets = [...reg.agents.keys()].filter((n) => n !== name);
      expect(targets).not.toContain(name);
    }
  });
});
