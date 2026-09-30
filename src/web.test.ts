import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadGlobalConfig, saveGlobalConfig } from "./global.ts";
import { Store } from "./store.ts";
import { createHandler } from "./web.ts";

/** The status page's write API: same-origin JSON only, then the same actions as the CLI. */
let root: string;
let store: Store;
let handler: (req: Request) => Promise<Response>;
const saved = { data: process.env.AGENTPIPE_DATA_DIR, config: process.env.AGENTPIPE_CONFIG_DIR };

const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  handler(new Request(`http://mothership:8081${p}`, { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers }, body: JSON.stringify(body) }));

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "agentpipe-web-"));
  process.env.AGENTPIPE_DATA_DIR = path.join(root, "data");
  process.env.AGENTPIPE_CONFIG_DIR = path.join(root, "config");
  mkdirSync(path.join(root, "repo"));
  const g = loadGlobalConfig();
  g.projects.demo = { path: path.join(root, "repo"), base: "main", push: false };
  g.defaultProject = "demo";
  saveGlobalConfig(g);
  store = new Store();
  handler = createHandler(store, g, { port: 0, tlsPort: 0, host: "127.0.0.1", ollamaUrl: "http://127.0.0.1:1", webuiUrl: "http://127.0.0.1:1/" }, null);
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
  for (const [k, v] of [["AGENTPIPE_DATA_DIR", saved.data], ["AGENTPIPE_CONFIG_DIR", saved.config]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("write API", () => {
  test("adds a task for the architect and shows it in the detail view", async () => {
    const res = await post("/api/tasks", { description: "Add a skip-turn button", priority: "10", acceptance: "a\nb" });
    expect(res.status).toBe(201);
    const d = await res.json();
    expect(d.task.agent).toBe("architect");
    expect(d.task.project).toBe("demo");
    expect(d.task.priority).toBe(10);
    expect(d.task.created_by).toBe("web");
    const detail = await (await handler(new Request(`http://mothership:8081/api/task/${d.task.id}`))).json();
    expect(detail.task.acceptance).toEqual(["a", "b"]);
    expect(detail.replies).toEqual([]);
    expect(detail.report).toBeNull();
  });
  test("refuses bad input with 400 and a message, not a stack", async () => {
    const res = await post("/api/tasks", { description: "" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/description/);
    const res2 = await post("/api/tasks", { description: "x", agent: "nope" });
    expect(res2.status).toBe(400);
    expect((await res2.json()).error).toMatch(/nope/);
    expect((await post("/api/task/999/retry", {})).status).toBe(400);
    expect((await post("/api/nothing", {})).status).toBe(404);
  });
  test("refuses cross-site and non-JSON writes", async () => {
    expect((await post("/api/tasks", { description: "x" }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    const form = await handler(new Request("http://mothership:8081/api/tasks", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" }, body: "description=x" }));
    expect(form.status).toBe(415);
    expect((await handler(new Request("http://mothership:8081/api/tasks", { method: "OPTIONS" }))).status).toBe(405);
    // curl and friends send no Sec-Fetch-Site: allowed.
    const curl = await handler(new Request("http://mothership:8081/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ description: "from curl" }) }));
    expect(curl.status).toBe(201);
    expect(store.counts("demo").queued).toBe(1);
  });
  test("reply requeues an attention task and returns the refreshed detail; retry and cancel work", async () => {
    const t = store.add({ project: "demo", agent: "coder", title: "x", description: "x" });
    store.setStatus(t.id, "running");
    store.update(t.id, { summary: "Which colour?" });
    store.setStatus(t.id, "attention");
    const r = await (await post(`/api/task/${t.id}/reply`, { text: "Blue." })).json();
    expect(r.requeued).toBe(true);
    expect(r.task.status).toBe("queued");
    expect(r.replies.map((x: any) => x.text)).toEqual(["Blue."]);
    expect((await post(`/api/task/${t.id}/reply`, { text: "  " })).status).toBe(400);
    const c = await (await post(`/api/task/${t.id}/cancel`, { reason: "moot" })).json();
    expect(c.task.status).toBe("cancelled");
    expect(c.task.error).toBe("moot");
    const rt = await (await post(`/api/task/${t.id}/retry`, {})).json();
    expect(rt.task.status).toBe("queued");
  });
  test("status lists open proposals with the parsed spec, needs-you rows carry the ask, and dismiss removes them", async () => {
    store.proposeAgent({ name: "db-migrator", spec: { name: "db-migrator", runtime: "claude", description: "Writes SQL migrations for the schema.", why: "SQL is off limits to the coder.", inputs: "", outputs: "", commits: true, shell: [] }, task_id: null, project: "demo", proposed_by: "architect-review" });
    const t = store.add({ project: "demo", agent: "coder", title: "x", description: "x" });
    store.setStatus(t.id, "running");
    store.update(t.id, { summary: "## Question\nShould the **modal** close on `Escape`?\n\nMore text." });
    store.setStatus(t.id, "attention");
    const s = await (await handler(new Request("http://mothership:8081/api/status"))).json();
    expect(s.proposals.length).toBe(1);
    expect(s.proposals[0].proposal.runtime).toBe("claude");
    const row = s.queue[0].needsYou.find((x: any) => x.id === t.id);
    expect(row.ask).toBe("Question Should the modal close on Escape? More text.");
    const d = await (await post(`/api/proposal/${s.proposals[0].id}/dismiss`, {})).json();
    expect(d.proposal.status).toBe("dismissed");
    expect((await (await handler(new Request("http://mothership:8081/api/proposals"))).json()).proposals).toEqual([]);
    expect((await (await handler(new Request("http://mothership:8081/api/proposals?all=1"))).json()).proposals.length).toBe(1);
  });
  test("task detail includes the run report when there is one", async () => {
    const run = path.join(root, "run");
    mkdirSync(run);
    writeFileSync(path.join(run, "report.md"), "# coder: x\n\nall good");
    const t = store.add({ project: "demo", agent: "coder", title: "x", description: "x" });
    store.update(t.id, { run_dir: run });
    const d = await (await handler(new Request(`http://mothership:8081/api/task/${t.id}`))).json();
    expect(d.report).toContain("all good");
  });
});
