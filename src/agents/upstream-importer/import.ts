#!/usr/bin/env bun
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * The upstream-importer's command: copy files from `<repo>/upstream/<name>/` into the project
 * checkout according to a JSON spec in the task description, then print the report that becomes
 * the task's summary. Runs inside the task's worktree with the worker's AGENTPIPE_* environment;
 * the worker commits what it wrote. Exit 0 = done (something was imported), 2 = attention.
 */
const Spec = z.object({
  upstream: z.string().min(1),
  include: z.array(z.string()).min(1),
  exclude: z.array(z.string()).default([]),
  rename: z.record(z.string(), z.string()).default({}),
  substitute: z.record(z.string(), z.string()).default({}),
  verbatim: z.array(z.string()).default([]),
  executable: z.array(z.string()).default([]),
  overwrite: z.boolean().default(false),
});
type Spec = z.infer<typeof Spec>;

/** Never copied, whatever the spec says: repository internals, installed or generated trees, Windows marker files. */
const NEVER = ["**/.git/**", ".git/**", "**/node_modules/**", "node_modules/**", ".direnv/**", ".svelte-kit/**", "build/**", "dist/**", "playwright-report/**", "test-results/**", "**/*Zone.Identifier", ".agentpipe/**", "upstream/**"];
/** Never written into the project, whatever the rename says. */
const PROTECTED = /^(\.git|\.agentpipe|upstream)(\/|$)/;

function matches(file: string, globs: string[]): boolean {
  return globs.some((g) => new Bun.Glob(g).match(file));
}

/** The first fenced JSON block in the description, or the whole description when it is JSON. */
export function parseSpec(text: string): Spec {
  const m = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/```\s*(\{[\s\S]*?\})\s*```/);
  const raw = m ? m[1] : text.trim().startsWith("{") ? text.trim() : null;
  if (!raw) throw new Error('the task description has no ```json block with the import spec ({"upstream": "...", "include": [...], ...})');
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error(`the import spec is not valid JSON: ${(e as Error).message}`);
  }
  const r = Spec.safeParse(obj);
  if (!r.success) throw new Error(`the import spec is incomplete: ${r.error.issues.map((i) => `${i.path.join(".") || "spec"}: ${i.message}`).join("; ")}`);
  return r.data;
}

/** Destination for a source path: the longest matching rename prefix wins; "" maps to the root. */
function destOf(rel: string, rename: Record<string, string>): string {
  const prefixes = Object.keys(rename).sort((a, b) => b.length - a.length);
  for (const p of prefixes) {
    if (p === "" || rel === p.replace(/\/$/, "") || rel.startsWith(p)) {
      const to = rename[p];
      return p === "" ? path.posix.join(to, rel) : to + rel.slice(p.length);
    }
  }
  return rel;
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function sha(dir: string): string {
  const r = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dir, stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : "unknown";
}

function remote(dir: string): string {
  const r = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: dir, stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : "unknown";
}

export interface ImportReport {
  copied: { from: string; to: string; substitutions: number; binary: boolean; executable: boolean }[];
  skipped: { from: string; why: string }[];
  excluded: number;
  sha: string;
  repo: string;
}

export function runImport(repo: string, spec: Spec): ImportReport {
  const src = path.join(repo, "upstream", spec.upstream);
  if (!existsSync(src)) throw new Error(`upstream/${spec.upstream} does not exist in this checkout; register it first: agentpipe projects upstream add owner/repo --name ${spec.upstream}`);
  const report: ImportReport = { copied: [], skipped: [], excluded: 0, sha: sha(src), repo: remote(src) };
  const entries = [...new Bun.Glob("**/*").scanSync({ cwd: src, dot: true, onlyFiles: true })].sort();
  for (const rel of entries) {
    if (matches(rel, NEVER) || !matches(rel, spec.include) || matches(rel, spec.exclude)) {
      report.excluded++;
      continue;
    }
    const to = path.posix.normalize(destOf(rel, spec.rename));
    if (to.startsWith("../") || path.isAbsolute(to) || PROTECTED.test(to)) {
      report.skipped.push({ from: rel, why: `destination ${to} is outside the project or protected` });
      continue;
    }
    const abs = path.join(repo, to);
    if (existsSync(abs) && !spec.overwrite) {
      report.skipped.push({ from: rel, why: `${to} already exists (set "overwrite": true to replace it)` });
      continue;
    }
    const buf = readFileSync(path.join(src, rel));
    const binary = isBinary(buf);
    let substitutions = 0;
    let out: Buffer | string = buf;
    if (!binary && !matches(rel, spec.verbatim)) {
      let text = buf.toString("utf8");
      for (const [find, replace] of Object.entries(spec.substitute)) {
        if (!find) continue;
        const parts = text.split(find);
        substitutions += parts.length - 1;
        text = parts.join(replace);
      }
      out = text;
    }
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, out);
    const executable = Boolean(statSync(path.join(src, rel)).mode & 0o111) || matches(rel, spec.executable) || matches(to, spec.executable);
    chmodSync(abs, executable ? 0o755 : 0o644);
    report.copied.push({ from: rel, to, substitutions, binary, executable });
  }
  return report;
}

export function renderReport(spec: Spec, r: ImportReport): string {
  const lines = [`Imported ${r.copied.length} file(s) from upstream/${spec.upstream} (${r.repo}) at commit ${r.sha}.`, ""];
  if (r.copied.length) {
    lines.push("## Copied");
    for (const c of r.copied) lines.push(`- ${c.from}${c.to !== c.from ? ` -> ${c.to}` : ""}${c.binary ? " (binary, byte for byte)" : c.substitutions ? ` (${c.substitutions} substitution(s))` : ""}${c.executable ? " [executable]" : ""}`);
    lines.push("");
  }
  if (r.skipped.length) {
    lines.push("## Skipped");
    for (const s of r.skipped) lines.push(`- ${s.from}: ${s.why}`);
    lines.push("");
  }
  lines.push(`Excluded by the include/exclude globs or the built-in never-copy list: ${r.excluded} file(s).`);
  lines.push(`Provenance: ${r.repo} commit ${r.sha}; substitutions: ${Object.keys(spec.substitute).length ? Object.entries(spec.substitute).map(([k, v]) => `${JSON.stringify(k)} -> ${JSON.stringify(v)}`).join(", ") : "none"}.`);
  return lines.join("\n");
}

if (import.meta.main) {
  const repo = process.env.AGENTPIPE_REPO ?? process.cwd();
  try {
    const spec = parseSpec(process.env.AGENTPIPE_TASK_DESCRIPTION ?? "");
    const r = runImport(repo, spec);
    console.log(renderReport(spec, r));
    if (!r.copied.length) {
      console.log("\nNothing was imported: no file matched the include globs, or every match already exists. Check the globs against the upstream tree (paths are relative to the upstream root).");
      process.exit(2);
    }
  } catch (e) {
    console.log(`Import not done: ${(e as Error).message}`);
    process.exit(2);
  }
}
