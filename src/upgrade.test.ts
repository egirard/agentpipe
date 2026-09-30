import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "./store.ts";
import { checkForUpdate, runUpgrade } from "./upgrade.ts";
import { sh } from "./util.ts";

/** The deployed checkout against its origin: nothing available, then a commit upstream, then pulled. */
let root: string;
const saved = { data: process.env.AGENTPIPE_DATA_DIR };
const git = (args: string, cwd: string) => sh(`git -c user.email=t@t -c user.name=t ${args}`, cwd, 60);

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "agentpipe-upgrade-"));
  process.env.AGENTPIPE_DATA_DIR = path.join(root, "data");
  await git(`init -q --bare -b main ${JSON.stringify(path.join(root, "origin.git"))}`, root);
  await git(`clone -q ${JSON.stringify(path.join(root, "origin.git"))} upstream`, root);
  writeFileSync(path.join(root, "upstream", "package.json"), '{"name":"x","dependencies":{}}\n');
  await git("add -A && git -c user.email=t@t -c user.name=t commit -qm first && git push -q origin main", path.join(root, "upstream"));
  await git(`clone -q ${JSON.stringify(path.join(root, "origin.git"))} deployed`, root);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (saved.data === undefined) delete process.env.AGENTPIPE_DATA_DIR;
  else process.env.AGENTPIPE_DATA_DIR = saved.data;
});

describe("upgrade", () => {
  test("detects commits upstream, refuses dirty or busy, pulls when clean", async () => {
    const deployed = path.join(root, "deployed");
    const none = await checkForUpdate({ maxAgeMs: 0, root: deployed });
    expect(none.error).toBeNull();
    expect(none.available).toBe(false);
    expect(none.branch).toBe("main");

    writeFileSync(path.join(root, "upstream", "new.txt"), "x\n");
    await git("add -A && git -c user.email=t@t -c user.name=t commit -qm 'Add new.txt' && git push -q origin main", path.join(root, "upstream"));
    const u = await checkForUpdate({ maxAgeMs: 0, root: deployed });
    expect(u.available).toBe(true);
    expect(u.behind).toBe(1);
    expect(u.commits).toEqual(["Add new.txt"]);
    // Cached within maxAge.
    expect((await checkForUpdate({ maxAgeMs: 60_000, root: deployed })).checkedAt).toBe(u.checkedAt);

    const store = new Store();
    writeFileSync(path.join(deployed, "local.txt"), "edit\n");
    const dirty = await runUpgrade(store, { restart: "none", root: deployed });
    expect(dirty.ok).toBe(false);
    expect(dirty.lines[0]).toMatch(/local changes/);
    rmSync(path.join(deployed, "local.txt"));

    const t = store.add({ project: "p", agent: "coder", title: "busy", description: "busy" });
    store.setStatus(t.id, "running");
    const busy = await runUpgrade(store, { restart: "none", root: deployed });
    expect(busy.ok).toBe(false);
    expect(busy.lines[0]).toMatch(/running/);

    const done = await runUpgrade(store, { restart: "none", root: deployed, force: true });
    expect(done.ok).toBe(true);
    expect(done.lines[0]).toMatch(/pulled 1 commit/);
    expect(done.lines).toContain("bun install: ok");
    expect((await checkForUpdate({ maxAgeMs: 0, root: deployed })).available).toBe(false);
    store.setStatus(t.id, "done");
    const again = await runUpgrade(store, { restart: "none", root: deployed });
    expect(again.lines[0]).toMatch(/already up to date/);
    store.close();
  });
});
