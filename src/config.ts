import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Everything tunable lives here. Repo-level overrides come from `agentpipe.json` at the repo root. */
export interface Config {
  repo: string;
  ollamaUrl: string;
  models: {
    /** Local model that writes code. */
    coder: string;
    /** Local model that reviews diffs. */
    reviewer: string;
    /** Claude Code model for planning, escalation, and final review: "opus", "sonnet", or a full id. Empty = Claude Code's default. */
    cloud: string;
  };
  /** Claude Code executable. */
  claudeBin: string;
  /** Tokens of context for the local model. 8k keeps a 7B Q4 model fully on an 8 GB GPU; 16k spills layers to CPU. */
  numCtx: number;
  commands: {
    lint: string;
    unit: string;
    /** Receives spec paths as extra args. */
    e2e: string;
  };
  limits: {
    /** Local coder attempts per step before escalating to the cloud model. */
    localAttempts: number;
    /** Cloud fixer tool-loop iterations. */
    cloudIterations: number;
    /** How many times the architect may revise the plan after a step fails. */
    replans: number;
    /** Max characters of source handed to the local coder per step. */
    coderContextChars: number;
    /** A writable file larger than this skips the local coder (it must return whole files and cannot hold one this big) and goes to the cloud fixer. */
    coderMaxFileChars: number;
    /** Max characters of test output inlined into a prompt. Full outputs are always saved under the run dir. */
    testOutputChars: number;
    /** Seconds before a test command is killed. */
    commandTimeoutSec: number;
  };
  /** Use Claude Code at all. Off = local only; steps that fail locally are reported, not escalated. */
  cloudEnabled: boolean;
  /** Have the cloud model review the final diff before the run is declared done. */
  cloudFinalReview: boolean;
  /** Run e2e specs named by the plan after unit tests pass. */
  runE2e: boolean;
  /** After a fully green run: push the branch to origin and open a PR with `gh` if available. Never merges. */
  push: boolean;
  /** Command the worker runs once in every fresh worktree before a task uses it (e.g. "bun install"), unless the project config sets its own. */
  setup: string;
}

export const DEFAULTS: Omit<Config, "repo"> = {
  ollamaUrl: "http://127.0.0.1:11434",
  models: {
    coder: "qwen2.5-coder:7b",
    reviewer: "qwen2.5-coder:7b",
    cloud: "opus",
  },
  claudeBin: "claude",
  numCtx: 8192,
  commands: {
    lint: "bun run lint",
    unit: "bun run test:unit",
    e2e: "agentpipe-e2e",
  },
  limits: {
    localAttempts: 3,
    cloudIterations: 25,
    replans: 2,
    coderContextChars: 40_000,
    coderMaxFileChars: 20_000,
    testOutputChars: 12_000,
    commandTimeoutSec: 900,
  },
  cloudEnabled: true,
  cloudFinalReview: true,
  runE2e: true,
  push: false,
  setup: "",
};

/** Load KEY=VALUE lines from ~/.config/agentpipe/env into process.env (does not override existing vars). */
export function loadEnvFile(): string | null {
  const p = path.join(homedir(), ".config", "agentpipe", "env");
  if (!existsSync(p)) return null;
  for (const raw of readFileSync(p, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
  return p;
}

function deepMerge<T extends object>(base: T, over: Partial<T> | undefined): T {
  if (!over) return base;
  const out: any = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof (base as any)[k] === "object") {
      out[k] = deepMerge((base as any)[k], v as any);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export function loadConfig(repo: string, cliOverrides: Partial<Config> = {}): Config {
  loadEnvFile();
  const repoAbs = path.resolve(repo);
  let fileCfg: Partial<Config> = {};
  const cfgPath = path.join(repoAbs, "agentpipe.json");
  if (existsSync(cfgPath)) fileCfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const envCfg: Partial<Config> = {};
  if (process.env.OLLAMA_URL) envCfg.ollamaUrl = process.env.OLLAMA_URL;
  const merged = deepMerge(deepMerge(deepMerge({ ...DEFAULTS, repo: repoAbs }, fileCfg), envCfg), cliOverrides);
  merged.repo = repoAbs;
  return merged;
}
