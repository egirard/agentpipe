import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadGlobalConfig, updateGlobalConfig } from "./global.ts";
import { addUpstream, listUpstreams, removeUpstream, renderUpstreams, updateUpstream, upstreamName } from "./upstreams.ts";
import { sh } from "./util.ts";

/** Upstream copies: cloned into the checkout, excluded from git, pinned in the config, updatable, removable. */
let root: string;
const saved = { data: process.env.AGENTPIPE_DATA_DIR, config: process.env.AGENTPIPE_CONFIG_DIR };

async function gitRepo(dir: string, files: Record<string, string>) {
  mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  const r = await sh("git init -q -b main && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init", dir, 60);
  if (!r.ok) throw new Error(r.output);
  return (await sh("git rev-parse HEAD", dir, 30)).output.trim();
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "agentpipe-upstreams-"));
  process.env.AGENTPIPE_DATA_DIR = path.join(root, "data");
  process.env.AGENTPIPE_CONFIG_DIR = path.join(root, "config");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [k, v] of [["AGENTPIPE_DATA_DIR", saved.data], ["AGENTPIPE_CONFIG_DIR", saved.config]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("upstreams", () => {
  test("names come from the repository", () => {
    expect(upstreamName("egirard/TabletopTemplate")).toBe("tabletop-template");
    expect(upstreamName("https://github.com/egirard/SourceOfTheNileRulesReference.git")).toBe("source-of-the-nile-rules-reference");
    expect(upstreamName("/tmp/x/my_repo/")).toBe("my-repo");
  });

  test("add clones into upstream/, excludes it from git, records the commit; update and remove follow", async () => {
    const project = path.join(root, "proj");
    await gitRepo(project, { "README.md": "# p\n" });
    const source = path.join(root, "template");
    const sha1 = await gitRepo(source, { "docs/a.md": "A\n", "package.json": "{}\n" });
    updateGlobalConfig((g) => {
      g.projects.proj = { path: project, base: "main", push: false };
      g.defaultProject = "proj";
    });

    const r = await addUpstream("proj", { repo: source, name: "tt" });
    expect(r.name).toBe("tt");
    expect(r.sha).toBe(sha1);
    expect(existsSync(path.join(project, "upstream", "tt", "docs", "a.md"))).toBe(true);
    // Excluded from the project's git: status stays clean, the exclude file names it.
    expect((await sh("git status --porcelain", project, 30)).output.trim()).toBe("");
    expect(readFileSync(path.join(project, ".git", "info", "exclude"), "utf8")).toContain("/upstream");
    const cfg = loadGlobalConfig().projects.proj;
    expect(cfg.upstreams?.tt.repo).toBe(source);
    expect(cfg.upstreams?.tt.sha).toBe(sha1);
    expect(renderUpstreams(cfg)).toContain(`upstream/tt/: ${source} at commit ${sha1}`);
    expect(listUpstreams(cfg)[0]).toContain("tt: ");

    // Same repo again: an update, not a second clone. A different repo under the name: refused.
    writeFileSync(path.join(source, "docs", "b.md"), "B\n");
    await sh("git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm more", source, 30);
    const sha2 = (await sh("git rev-parse HEAD", source, 30)).output.trim();
    const again = await addUpstream("proj", { repo: source, name: "tt" });
    expect(again.sha).toBe(sha2);
    expect(existsSync(path.join(project, "upstream", "tt", "docs", "b.md"))).toBe(true);
    expect(loadGlobalConfig().projects.proj.upstreams?.tt.sha).toBe(sha2);
    await expect(addUpstream("proj", { repo: path.join(root, "other"), name: "tt" })).rejects.toThrow(/pick another name/);
    expect((await updateUpstream("proj", "tt")).sha).toBe(sha2);
    await expect(updateUpstream("proj", "nope")).rejects.toThrow(/no upstream "nope"/);

    expect(removeUpstream("proj", "tt")).toContain("removed");
    expect(existsSync(path.join(project, "upstream", "tt"))).toBe(false);
    expect(loadGlobalConfig().projects.proj.upstreams).toBeUndefined();
    expect(renderUpstreams(loadGlobalConfig().projects.proj)).toBe("");
  });

  test("a failed clone leaves nothing behind", async () => {
    const project = path.join(root, "proj");
    await gitRepo(project, { "README.md": "# p\n" });
    updateGlobalConfig((g) => void (g.projects.proj = { path: project, base: "main", push: false }));
    await expect(addUpstream("proj", { repo: path.join(root, "does-not-exist") })).rejects.toThrow(/could not fetch/);
    expect(existsSync(path.join(project, "upstream", "does-not-exist"))).toBe(false);
    expect(loadGlobalConfig().projects.proj.upstreams).toBeUndefined();
  });
});
