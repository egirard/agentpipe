import { describe, expect, test } from "bun:test";
import { checkCommand, hookSettings, projectCommandPatterns, toolsForGroups } from "./shell-policy.ts";

describe("shell policy", () => {
  test("read-only git is allowed for git-read, writes never are", () => {
    for (const c of ["git diff main...HEAD", "git log --oneline -20", "git show abc123", "git status", "git branch --list", "git blame src/a.ts", "git fetch origin"]) expect(checkCommand(c, ["git-read"]).ok).toBe(true);
    for (const c of ["git push", "git commit -m x", "git checkout main", "git reset --hard", "git branch -D x", "git rebase main", "git stash"]) expect(checkCommand(c, ["git-read", "ops"]).ok).toBe(false);
  });
  test("gh read verbs only, comment needs gh-comment", () => {
    expect(checkCommand("gh pr view 12 --json title", ["gh-read"]).ok).toBe(true);
    expect(checkCommand("gh pr comment 12 --body hi", ["gh-read"]).ok).toBe(false);
    expect(checkCommand("gh pr comment 12 --body hi", ["gh-read", "gh-comment"]).ok).toBe(true);
    for (const c of ["gh pr merge 12", "gh pr close 12", "gh auth token", "gh api repos/x/y", "gh repo delete x"]) expect(checkCommand(c, ["gh-read", "gh-comment", "ops"]).ok).toBe(false);
  });
  test("pipelines are checked per segment; filters may follow", () => {
    expect(checkCommand("git log --oneline | head -5", ["git-read"]).ok).toBe(true);
    expect(checkCommand("git log --oneline | tee /tmp/x", ["git-read"]).ok).toBe(false);
    expect(checkCommand("git status && rm -rf src", ["git-read", "ops"]).ok).toBe(false);
    expect(checkCommand("ls; git push", ["ops"]).ok).toBe(false);
  });
  test("deny list beats every group", () => {
    for (const c of ["sudo ls", "curl http://x", "wget http://x", "ssh host", "kill 1", "eval ls", "bash -c ls", "ls $(cat x)", "ls `cat x`", "echo hi > file", "printenv", "cat .env", "cat ~/.config/gh/hosts.yml", "python3 -c 'print(1)'", "cd .. && ls", "rm -r x"]) {
      const v = checkCommand(c, ["ops", "git-read", "gh-read", "checks", "package-read"]);
      expect(v.ok).toBe(false);
    }
    expect(checkCommand("bun run test:unit 2>/dev/null", ["checks"]).ok).toBe(true);
    expect(checkCommand("bun run lint 2>&1 | tail -20", ["checks"]).ok).toBe(true);
  });
  test("no groups means no shell", () => {
    expect(checkCommand("ls", []).ok).toBe(false);
    expect(checkCommand("", ["ops"]).ok).toBe(false);
  });
  test("project commands extend the checks group", () => {
    const extra = projectCommandPatterns(["bun run lint", "bun run test:unit"]);
    expect(checkCommand("bun run test:unit -- src/utils.test.ts", ["checks"], extra).ok).toBe(true);
    expect(toolsForGroups(["checks"], ["bun run lint"])).toContain("Bash(bun run lint *)");
  });
  test("hook settings point at the shell-check entry point", () => {
    const s = hookSettings(["git-read"], ["bun run lint"]) as any;
    const cmd = s.hooks.PreToolUse[0].hooks[0].command as string;
    expect(s.hooks.PreToolUse[0].matcher).toBe("Bash");
    expect(cmd).toContain("shell-check");
    expect(cmd).toContain("git-read");
  });
});

describe("approved commands", () => {
  test("lift the git/gh rules, keep the hard ones, and read --source as a flag", async () => {
    const { checkApprovedCommand } = await import("./shell-policy.ts");
    expect(checkApprovedCommand("gh repo create egirard/x --private --source . --remote origin --push").ok).toBe(true);
    expect(checkApprovedCommand("git push -u origin main").ok).toBe(true);
    expect(checkApprovedCommand("gh pr merge 12 --squash --delete-branch").ok).toBe(true);
    expect(checkApprovedCommand("source ~/.bashrc").ok).toBe(false);
    expect(checkApprovedCommand("ls; source x").ok).toBe(false);
    expect(checkApprovedCommand("sudo apt install x").ok).toBe(false);
    expect(checkApprovedCommand("rm -rf build").ok).toBe(false);
    expect(checkApprovedCommand("curl https://x").ok).toBe(false);
    expect(checkApprovedCommand("echo $GITHUB_TOKEN").ok).toBe(false);
    expect(checkApprovedCommand("systemctl --user restart agentpipe-worker").ok).toBe(false);
  });
});

describe("policy changes after the Nile1978 run", () => {
  test("find -exec is not indirect execution; eval, exec and source as commands still are", () => {
    const g = ["ops", "git-read"];
    expect(checkCommand("find upstream/tt -type f -exec file {} +", g).ok).toBe(true);
    for (const c of ["exec bash", "ls; exec sh", "eval ls", "source x.sh", "ls && source ~/.bashrc", "bash -c ls", "ls | xargs rm"]) expect(checkCommand(c, g).ok).toBe(false);
  });
  test("git -C inside the checkout reads; outside, with .., or writing is refused", () => {
    expect(checkCommand("git -C upstream/tt log --oneline -3", ["git-read"]).ok).toBe(true);
    expect(checkCommand("git -C upstream/tt rev-parse HEAD", ["git-read"]).ok).toBe(true);
    expect(checkCommand("git -C upstream/tt branch -a", ["git-read"]).ok).toBe(true);
    for (const c of ["git -C /home/x/.cache log", "git -C ~/src/x log", "git -C ../x log", "git -C upstream/../../x log", "git -C upstream/tt push", "git -C upstream/tt checkout main", "git -C upstream/tt commit -m x"]) expect(checkCommand(c, ["git-read", "ops"]).ok).toBe(false);
  });
  test("chmod +x on one file in the checkout is allowed through checks; anything else chmod is denied", () => {
    expect(checkCommand("chmod +x scripts/verify-change.sh", ["checks"]).ok).toBe(true);
    expect(checkCommand("chmod 755 .husky/pre-commit", ["checks"]).ok).toBe(true);
    for (const c of ["chmod 777 x", "chmod -R +x .", "chmod +x /etc/passwd", "chmod +x ../x", "find . -exec chmod 777 {} +", "find . -exec chmod +x {} +", "chmod +x a b"]) expect(checkCommand(c, ["ops", "checks"]).ok).toBe(false);
  });
  test("a shell agent's own script is allowed under ops", () => {
    expect(checkCommand('bun "$AGENTPIPE_AGENT_DIR/import.ts"', ["ops"]).ok).toBe(true);
    expect(checkCommand("bun $AGENTPIPE_AGENT_DIR/import.ts", ["ops"]).ok).toBe(true);
    expect(checkCommand("bun /tmp/x.ts", ["ops"]).ok).toBe(false);
  });
});
