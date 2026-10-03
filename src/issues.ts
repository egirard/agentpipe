import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { agentpipeRoot } from "./global.ts";
import type { IssueComment } from "./proposals.ts";
import { sh } from "./util.ts";

/**
 * The `gh` layer for GitHub issues: create one, read it with its comments, comment, close. Code
 * calls these for the proposal discussion (src/proposal-sync.ts); agents never do, they go through
 * the github agent. Every call goes through an injectable runner so the sync can be tested
 * without a network, and bodies travel in temp files so quoting can never break them.
 */
export interface IssueView {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | string;
  title: string;
  body: string;
  comments: IssueComment[];
}

/** Runs one gh command line; `sh` in production, a fake in tests. */
export type GhRunner = (cmd: string, cwd: string) => Promise<{ ok: boolean; output: string }>;

export interface IssuesClient {
  repo: string;
  create(title: string, body: string): Promise<{ url: string; number: number }>;
  view(number: number): Promise<IssueView>;
  comment(number: number, body: string): Promise<void>;
  close(number: number, comment: string, reason: "completed" | "not planned"): Promise<void>;
  reopen(number: number): Promise<void>;
}

export class GhError extends Error {}

/** owner/name from a GitHub remote URL (https or ssh), or null for anything else. */
export function repoFromRemoteUrl(url: string): string | null {
  const m = url.trim().match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The repository that holds proposal issues: the configured one, else the agentpipe checkout's origin. */
export async function proposalsRepo(configured: string, run: GhRunner = defaultRunner, root = agentpipeRoot()): Promise<string | null> {
  if (configured.trim()) return configured.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  const r = await run("git remote get-url origin", root);
  return r.ok ? repoFromRemoteUrl(r.output) : null;
}

/** Maps `gh issue view --json number,url,state,title,body,comments`; missing or odd fields become empty values. */
export function parseIssueView(raw: unknown): IssueView {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const comments: IssueComment[] = (Array.isArray(o.comments) ? o.comments : []).map((c: any) => ({
    author: str(c?.author?.login),
    association: str(c?.authorAssociation),
    createdAt: str(c?.createdAt),
    body: str(c?.body),
  }));
  return { number: Number(o.number) || 0, url: str(o.url), state: str(o.state).toUpperCase(), title: str(o.title), body: str(o.body), comments };
}

const defaultRunner: GhRunner = (cmd, cwd) => sh(cmd, cwd, 120).then((r) => ({ ok: r.ok, output: r.output }));

function withBodyFile<T>(body: string, fn: (file: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "agentpipe-issue-"));
  const file = path.join(dir, "body.md");
  writeFileSync(file, body);
  return fn(file).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** A client bound to one repository. Commands run from the agentpipe root (any directory works for `--repo`). */
export function issuesClient(repo: string, run: GhRunner = defaultRunner, cwd = agentpipeRoot()): IssuesClient {
  const q = (s: string) => JSON.stringify(s);
  const must = async (cmd: string): Promise<string> => {
    const r = await run(cmd, cwd);
    if (!r.ok) throw new GhError(`${cmd.split(" ").slice(0, 3).join(" ")} failed: ${r.output.trim().slice(0, 300)}`);
    return r.output;
  };
  return {
    repo,
    async create(title, body) {
      const out = await withBodyFile(body, (f) => must(`gh issue create --repo ${q(repo)} --title ${q(title)} --body-file ${q(f)}`));
      const url = out.trim().split("\n").find((l) => /^https:\/\/github\.com\//.test(l.trim()))?.trim();
      const number = Number(url?.match(/\/issues\/(\d+)/)?.[1]);
      if (!url || !number) throw new GhError(`gh issue create printed no issue URL: ${out.trim().slice(0, 200)}`);
      return { url, number };
    },
    async view(number) {
      const out = await must(`gh issue view ${number} --repo ${q(repo)} --json number,url,state,title,body,comments`);
      let raw: unknown;
      try {
        raw = JSON.parse(out);
      } catch {
        throw new GhError(`gh issue view ${number} returned no JSON: ${out.trim().slice(0, 200)}`);
      }
      return parseIssueView(raw);
    },
    async comment(number, body) {
      await withBodyFile(body, (f) => must(`gh issue comment ${number} --repo ${q(repo)} --body-file ${q(f)}`));
    },
    async close(number, comment, reason) {
      await must(`gh issue close ${number} --repo ${q(repo)} --reason ${q(reason)} --comment ${q(comment)}`);
    },
    async reopen(number) {
      await must(`gh issue reopen ${number} --repo ${q(repo)}`);
    },
  };
}
