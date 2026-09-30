import { describe, expect, test } from "bun:test";
import { fakeContext, loadAgent, runAgentE2E } from "../../../testkit.ts";
import verify from "../verify.ts";

const request = {
  title: "Create github.com/egirard/tools and push main",
  why: "The task asks for a private GitHub repository for the tools project so its branches and pull requests have somewhere to go.",
  risk: "Nothing irreversible: an empty private repository is created; remove it on GitHub if unwanted.",
  steps: [
    { kind: "command" as const, command: "git init -b main", cwd: "~/src/tools", why: "the directory is not a repository yet" },
    { kind: "command" as const, command: "gh repo create egirard/tools --private --source . --remote origin --push", cwd: "~/src/tools", why: "creates the repository and pushes main" },
  ],
  links: [],
  continue_after: false,
};
const base = { status: "attention" as const, summary: "~/src/tools exists with 12 files and no .git. gh is logged in as egirard. Two commands create the repository and push main; check the repository page afterwards.", findings: [], subtasks: [] };

describe("github", () => {
  test("manifest loads and requires confirmation", () => {
    const { manifest, problems } = loadAgent("github", import.meta.dir + "/..");
    expect(problems).toEqual([]);
    expect(manifest.requires_confirmation).toBe(true);
    expect(manifest.commits).toBe(false);
    expect(manifest.shell).toEqual(["git-read", "gh-read"]);
  });
  test("accepts a clean request; rejects writes, placeholders, silent destruction and wrong statuses", async () => {
    expect(await verify(fakeContext({ result: { ...base, confirmation: request } }))).toEqual([]);
    const p1 = await verify(fakeContext({ result: { ...base, confirmation: { ...request, steps: [{ kind: "write", path: "~/x", content: "y", why: "no" }] } } }));
    expect(p1.join(" ")).toContain("not file writes");
    const p2 = await verify(fakeContext({ result: { ...base, confirmation: { ...request, steps: [{ kind: "command", command: "gh pr merge NUMBER --squash", why: "merge" }] } } }));
    expect(p2.join(" ")).toContain("placeholder");
    const p3 = await verify(fakeContext({ result: { ...base, confirmation: { ...request, steps: [{ kind: "command", command: "git push --force origin main", why: "overwrite" }] } } }));
    expect(p3.join(" ")).toContain("risk does not say so");
    expect(await verify(fakeContext({ result: { ...base, confirmation: { ...request, risk: "Force-pushes main: irreversible for anyone who pulled.", steps: [{ kind: "command", command: "git push --force origin main", why: "overwrite" }] } } }))).toEqual([]);
    const p4 = await verify(fakeContext({ result: { ...base, status: "done", confirmation: request } }));
    expect(p4.join(" ")).toContain("status attention");
    const p5 = await verify(fakeContext({ result: { ...base, summary: "Nothing to do here, I think, so leaving it as is for the moment without any change at all." } }));
    expect(p5.join(" ")).toContain("ask the human a question");
  });
  test.skipIf(!process.env.AGENTPIPE_E2E)("proposes commands instead of running them", async () => {
    const r = await runAgentE2E("github", "Push the current main branch of this repository to a new private GitHub repository named agentpipe-scratch-test under my account, and nothing else.");
    expect(r.task.status).toBe("attention");
    expect(r.task.confirmation?.status).toBe("pending");
    expect(r.task.confirmation?.request.steps.some((s) => /gh repo create/.test(s.command ?? ""))).toBe(true);
  }, 20 * 60_000);
});
