import { describe, expect, test } from "bun:test";
import { parsePrUrl } from "./pr.ts";

describe("parsePrUrl", () => {
  test("reads owner, repo and number from a github pull request url", () => {
    expect(parsePrUrl("https://github.com/egirard/agentpipe/pull/42")).toEqual({ owner: "egirard", repo: "agentpipe", number: 42 });
  });
  test("ignores a trailing path and query", () => {
    expect(parsePrUrl("https://github.com/egirard/agentpipe/pull/42/files?w=1")).toEqual({ owner: "egirard", repo: "agentpipe", number: 42 });
    expect(parsePrUrl("https://www.github.com/egirard/agentpipe/pull/7")).toEqual({ owner: "egirard", repo: "agentpipe", number: 7 });
  });
  test("rejects other hosts, missing numbers and junk", () => {
    for (const bad of ["https://gitlab.com/egirard/agentpipe/pull/42", "https://github.com/egirard/agentpipe/pull/abc", "https://github.com/egirard/agentpipe", "not a url", ""]) {
      expect(parsePrUrl(bad)).toBeNull();
    }
  });
});
