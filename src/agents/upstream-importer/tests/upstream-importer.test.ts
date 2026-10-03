import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadGlobalConfig, updateGlobalConfig } from "../../../global.ts";
import { Store } from "../../../store.ts";
import { fakeContext, loadAgent, makeScratch } from "../../../testkit.ts";
import { sh } from "../../../util.ts";
import { runWorker } from "../../../worker.ts";
import { parseSpec, renderReport, runImport } from "../import.ts";
import verify from "../verify.ts";

/** A small "template" repository to import from: text with placeholders, a script, a binary, things that must never be copied. */
async function template(dir: string) {
  for (const [rel, text] of Object.entries({
    "README.md": "# {{GAME}}\n\nA {{PROJECT}} game.\n",
    "docs/guide.md": "Guide for {{GAME}}.\n",
    "docs/skip.md": "not wanted\n",
    "scripts/verify.sh": "#!/bin/sh\necho {{GAME}}\n",
    "package.json": '{"name":"{{PROJECT}}"}\n',
    "LICENSE": "MIT\n",
    "node_modules/x/index.js": "nope\n",
    "secret.txtZone.Identifier": "nope\n",
  })) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  writeFileSync(path.join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  const r = await sh("git init -q -b main && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm template", dir, 60);
  if (!r.ok) throw new Error(r.output);
  return (await sh("git rev-parse HEAD", dir, 30)).output.trim();
}

describe("upstream-importer", () => {
  test("manifest: a shell agent that commits, with a spec contract the architect can follow", () => {
    const { manifest, problems } = loadAgent("upstream-importer", import.meta.dir + "/..");
    expect(problems).toEqual([]);
    expect(manifest.runtime).toBe("shell");
    expect(manifest.commits).toBe(true);
    expect(manifest.can_delegate).toBe(false);
    expect(manifest.command).toContain("$AGENTPIPE_AGENT_DIR/import.ts");
    expect(manifest.inputs).toContain('"upstream"');
    expect(manifest.when_to_use).toContain("Not for fetching");
  });

  test("parseSpec reads the fenced block and rejects a spec without include", () => {
    const s = parseSpec('Import the docs.\n\n```json\n{"upstream": "tt", "include": ["docs/**"]}\n```\nThen docs-writer adapts them.');
    expect(s.upstream).toBe("tt");
    expect(s.overwrite).toBe(false);
    expect(() => parseSpec("no block here")).toThrow(/json block/);
    expect(() => parseSpec('```json\n{"upstream": "tt"}\n```')).toThrow(/include/);
  });

  test("copies, renames, substitutes, keeps modes and binaries, skips protected and existing files", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agentpipe-import-"));
    try {
      const repo = path.join(root, "repo");
      mkdirSync(path.join(repo, "docs"), { recursive: true });
      writeFileSync(path.join(repo, "docs/guide.md"), "mine\n");
      const sha = await template(path.join(repo, "upstream", "tt"));
      const spec = parseSpec(JSON.stringify({ upstream: "tt", include: ["**/*"], exclude: ["docs/skip.md", "LICENSE"], rename: { "docs/": "doc/", "": "" }, substitute: { "{{GAME}}": "Nile", "{{PROJECT}}": "nile" }, verbatim: ["package.json"], executable: ["scripts/*.sh"] }));
      const r = runImport(repo, spec);
      const to = (from: string) => r.copied.find((c) => c.from === from)?.to;
      expect(to("README.md")).toBe("README.md");
      expect(to("docs/guide.md")).toBe("doc/guide.md");
      expect(readFileSync(path.join(repo, "README.md"), "utf8")).toBe("# Nile\n\nA nile game.\n");
      expect(readFileSync(path.join(repo, "package.json"), "utf8")).toBe('{"name":"{{PROJECT}}"}\n');
      expect(readFileSync(path.join(repo, "docs/guide.md"), "utf8")).toBe("mine\n");
      expect(statSync(path.join(repo, "scripts/verify.sh")).mode & 0o111).toBeTruthy();
      expect(r.copied.find((c) => c.from === "logo.png")?.binary).toBe(true);
      expect(readFileSync(path.join(repo, "logo.png")).length).toBe(8);
      expect(r.copied.map((c) => c.from)).not.toContain("node_modules/x/index.js");
      expect(r.copied.map((c) => c.from)).not.toContain("secret.txtZone.Identifier");
      expect(r.copied.map((c) => c.from)).not.toContain("LICENSE");
      expect(r.sha).toBe(sha);
      const text = renderReport(spec, r);
      expect(text).toContain(`commit ${sha}`);
      expect(text).toContain("2 substitution(s)");
      // Second run: everything exists, nothing is overwritten.
      const again = runImport(repo, spec);
      expect(again.copied).toEqual([]);
      expect(again.skipped.length).toBeGreaterThan(3);
      expect(runImport(repo, { ...spec, overwrite: true }).copied.length).toBe(r.copied.length);
      expect(() => runImport(repo, { ...spec, upstream: "nope" })).toThrow(/upstream\/nope does not exist/);
      const escape = runImport(repo, { ...spec, overwrite: true, rename: { "": "../out/" } });
      expect(escape.copied).toEqual([]);
      expect(escape.skipped[0].why).toContain("outside the project");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("verifier wants imported files and a provenance commit on done, and refuses protected paths", async () => {
    const ok = await verify(fakeContext({ result: { status: "done", summary: "Imported 3 file(s) from upstream/tt (x/y) at commit 0123456789abcdef0123456789abcdef01234567.", findings: [], subtasks: [] }, files: { "README.md": "x" } }));
    expect(ok).toEqual([]);
    const none = await verify(fakeContext({ result: { status: "done", summary: "Imported 0 file(s) from upstream/tt (x/y) at commit 0123456789abcdef0123456789abcdef01234567.", findings: [], subtasks: [] } }));
    expect(none.join(" ")).toContain("imported files");
    const bad = await verify(fakeContext({ result: { status: "done", summary: "Imported some files, trust me, from somewhere over there.", findings: [], subtasks: [] }, files: { ".agentpipe/x": "x" } }));
    expect(bad.join(" ")).toContain("protected");
    expect(bad.join(" ")).toContain("upstream commit");
  });

  // The real runtime, worker and worktree, no model: the upstream is symlinked into the worktree,
  // the script runs, the worker commits the import on a branch.
  test("imports through the worker onto a branch", async () => {
    const scratch = await makeScratch();
    try {
      const sha = await template(path.join(scratch.repo, "upstream", "tt"));
      updateGlobalConfig((g) => {
        g.projects.scratch.upstreams = { tt: { repo: "egirard/TabletopTemplate", sha, fetched: new Date().toISOString() } };
      });
      const store = new Store();
      const t = store.add({ project: "scratch", agent: "upstream-importer", title: "Import the template docs", description: 'Bring the template in.\n\n```json\n{"upstream": "tt", "include": ["docs/**", "README.md"], "exclude": ["docs/skip.md"], "substitute": {"{{GAME}}": "Nile", "{{PROJECT}}": "nile"}}\n```\n', created_by: "test" });
      await runWorker(store, loadGlobalConfig(), { once: true });
      const task = store.get(t.id)!;
      expect(task.status).toBe("done");
      expect(task.summary).toContain(`commit ${sha}`);
      expect(task.branch).toMatch(/^agentpipe\/upstream-importer/);
      const files = (await sh(`git ls-tree -r --name-only ${JSON.stringify(task.branch!)}`, scratch.repo, 30)).output.trim().split("\n");
      expect(files).toContain("docs/guide.md");
      expect(files).toContain("README.md");
      expect(files).not.toContain("docs/skip.md");
      expect(files.some((f) => f.startsWith("upstream/"))).toBe(false);
      expect((await sh(`git show ${JSON.stringify(task.branch + ":docs/guide.md")}`, scratch.repo, 30)).output).toContain("Guide for Nile");
      expect(task.summary).toContain("README.md already exists");
      store.close();
    } finally {
      scratch.cleanup();
    }
  }, 60_000);
});
