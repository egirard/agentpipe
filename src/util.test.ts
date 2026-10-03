import { describe, expect, test } from "bun:test";
import { clip, stripAnsi } from "./util.ts";

describe("stripAnsi", () => {
  test("removes real escape sequences", () => {
    expect(stripAnsi("\x1b[31mFAIL\x1b[0m src/x.test.ts")).toBe("FAIL src/x.test.ts");
    expect(stripAnsi("\x1b[1;32m✓\x1b[39m ok \x1b[2K\x1b[G")).toBe("✓ ok ");
  });
  test("leaves ordinary brackets alone (diffs and code are not escape sequences)", () => {
    const code = "plugins: [sveltekit()],\nbranches: [main]\nconst [a, b] = x;\n- [blocker] src/x.ts\n[m] [s] [0m]";
    expect(stripAnsi(code)).toBe(code);
  });
});

describe("clip", () => {
  test("keeps head and tail", () => {
    const s = "a".repeat(100) + "b".repeat(100);
    const c = clip(s, 40);
    expect(c.startsWith("aaaaaaaaaa")).toBe(true);
    expect(c.endsWith("bbbbbbbbbb")).toBe(true);
    expect(c).toContain("chars omitted");
    expect(clip("short", 40)).toBe("short");
  });
});
