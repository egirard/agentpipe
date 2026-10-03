import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PlanStep } from "../plan.ts";
import { applyModes, checkCoderFiles, tooBigForLocal } from "./coder.ts";

/** The guards around what the local model returns: no fragments, no broken JSON, modes set, big files skipped. */
let repo: string;
beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "agentpipe-coder-"));
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

const step = (files: PlanStep["files"]): PlanStep => ({ id: "step-1", title: "t", description: "d", files, context_files: [], acceptance: [], unit_tests: [], e2e_specs: [] });

describe("checkCoderFiles", () => {
  test("refuses a fragment returned as the whole file, and invalid JSON; accepts the rest", () => {
    mkdirSync(path.join(repo, "web"));
    writeFileSync(path.join(repo, "web/index.html"), "<html>" + "x".repeat(44_000) + "</html>");
    writeFileSync(path.join(repo, "small.ts"), "export const a = 1;\n");
    const s = step([{ path: "web/index.html", action: "modify" }, { path: "small.ts", action: "modify" }, { path: "cfg.json", action: "create" }, { path: "new.ts", action: "create" }]);
    const r = checkCoderFiles({ repo }, s, [
      { path: "web/index.html", content: "<html>fragment</html>" },
      { path: "small.ts", content: "x" },
      { path: "cfg.json", content: "{ not json" },
      { path: "new.ts", content: "export const b = 2;\n" },
      { path: "other.ts", content: "ignored, not writable" },
      { path: "new.ts", content: "   " },
    ]);
    expect(r.problems.length).toBe(2);
    expect(r.problems[0]).toContain("web/index.html");
    expect(r.problems[0]).toContain("fragment");
    expect(r.problems[1]).toContain("cfg.json");
    expect(r.files.map((f) => f.path)).toEqual(["small.ts", "new.ts"]);
  });
  test("a genuine shrink of a small file is allowed", () => {
    writeFileSync(path.join(repo, "a.ts"), "x".repeat(1500));
    const r = checkCoderFiles({ repo }, step([{ path: "a.ts", action: "modify" }]), [{ path: "a.ts", content: "short" }]);
    expect(r.problems).toEqual([]);
  });
});

describe("applyModes and tooBigForLocal", () => {
  test("marks executable files 755 and finds files the local model cannot hold", () => {
    mkdirSync(path.join(repo, "scripts"));
    writeFileSync(path.join(repo, "scripts/v.sh"), "#!/bin/sh\n");
    writeFileSync(path.join(repo, "big.html"), "y".repeat(30_000));
    const s = step([{ path: "scripts/v.sh", action: "create", executable: true }, { path: "missing.sh", action: "create", executable: true }, { path: "big.html", action: "modify" }]);
    expect(applyModes(repo, s)).toEqual(["scripts/v.sh"]);
    expect(statSync(path.join(repo, "scripts/v.sh")).mode & 0o111).toBeTruthy();
    const limits = { localAttempts: 3, cloudIterations: 1, replans: 1, coderContextChars: 40_000, coderMaxFileChars: 20_000, testOutputChars: 1, commandTimeoutSec: 1 };
    expect(tooBigForLocal({ repo, limits }, s)).toContain("big.html is 30000 characters");
    expect(tooBigForLocal({ repo, limits: { ...limits, coderMaxFileChars: 50_000 } }, s)).toBeNull();
  });
});
