import path from "node:path";
import { agentpipeRoot } from "./global.ts";

/**
 * The one place that decides which shell commands agents may run.
 *
 * Agents do not ask for raw `Bash(...)` tools. A manifest names capability groups
 * (`"shell": ["git-read", "gh-read"]`) and this module turns them into two independent layers:
 *
 *   1. `--allowedTools` patterns for Claude Code, so a command outside the groups is never even
 *      offered a permission;
 *   2. a PreToolUse hook (`agentpipe shell-check`) that Claude Code runs before every Bash call.
 *      It parses the command, applies the deny list, and checks every pipeline segment against
 *      the groups. Exit code 2 blocks the call and the reason is shown to the model.
 *
 * Shell-runtime agents (a fixed `command` in the manifest) and shell verifiers go through
 * `checkCommand` too, with the `ops` group, before the worker runs them.
 *
 * Only `shell-runner` is granted `ops`; every other agent that needs a command outside its
 * groups delegates a subtask to it.
 */

export interface ShellGroup {
  description: string;
  /** Whole-segment regexes (anchored) a command segment must match. */
  allow: RegExp[];
  /** Claude Code allowedTools patterns for the first layer. */
  tools: string[];
}

const GIT_READ = ["diff", "log", "show", "status", "blame", "ls-files", "rev-parse", "describe", "shortlog", "merge-base", "merge-tree", "cat-file", "name-rev"];

export const SHELL_GROUPS: Record<string, ShellGroup> = {
  "git-read": {
    description: "inspect history and diffs; never changes the tree or refs",
    allow: [new RegExp(`^git\\s+(${GIT_READ.join("|")})(\\s|$)`), /^git\s+branch(\s+(--list|-a|-r|--show-current|--contains\s+\S+|--merged|--no-merged))*\s*$/, /^git\s+remote(\s+-v)?\s*$/, /^git\s+fetch(\s+\S+)*\s*$/, /^git\s+worktree\s+list\s*$/],
    tools: [...GIT_READ.map((v) => `Bash(git ${v} *)`), ...GIT_READ.map((v) => `Bash(git ${v})`), "Bash(git branch *)", "Bash(git branch)", "Bash(git remote *)", "Bash(git fetch *)", "Bash(git worktree list)"],
  },
  "gh-read": {
    description: "read pull requests, issues and workflow runs",
    allow: [/^gh\s+pr\s+(list|view|checks|diff|status)(\s|$)/, /^gh\s+issue\s+(list|view|status)(\s|$)/, /^gh\s+run\s+(list|view)(\s|$)/, /^gh\s+auth\s+status\s*$/, /^gh\s+repo\s+view(\s|$)/],
    tools: ["Bash(gh pr list *)", "Bash(gh pr view *)", "Bash(gh pr checks *)", "Bash(gh pr diff *)", "Bash(gh pr status *)", "Bash(gh issue list *)", "Bash(gh issue view *)", "Bash(gh run list *)", "Bash(gh run view *)", "Bash(gh auth status)", "Bash(gh repo view *)"],
  },
  "gh-comment": {
    description: "post comments on pull requests and issues (no merging, closing or editing)",
    allow: [/^gh\s+(pr|issue)\s+comment(\s|$)/],
    tools: ["Bash(gh pr comment *)", "Bash(gh issue comment *)"],
  },
  checks: {
    description: "run the project's lint and unit tests",
    allow: [/^bun\s+run\s+(lint|test|test:unit|check|typecheck)(\s|$)/, /^bunx\s+vitest(\s|$)/, /^bun\s+test(\s|$)/, /^npm\s+(run\s+)?(lint|test|test:unit|check)(\s|$)/, /^npx\s+vitest(\s|$)/, /^bunx\s+(eslint|tsc|svelte-check|prettier\s+--check)(\s|$)/],
    tools: ["Bash(bun run lint*)", "Bash(bun run test*)", "Bash(bun run check*)", "Bash(bun run typecheck*)", "Bash(bunx vitest *)", "Bash(bun test *)", "Bash(npm run lint*)", "Bash(npm run test*)", "Bash(npm test*)", "Bash(npx vitest *)", "Bash(bunx eslint *)", "Bash(bunx tsc *)", "Bash(bunx svelte-check *)", "Bash(bunx prettier --check *)"],
  },
  "package-read": {
    description: "inspect dependencies and tool versions",
    allow: [/^bun\s+(outdated|pm\s+ls|--version)(\s|$)/, /^npm\s+(view|ls|outdated|--version)(\s|$)/, /^node\s+--version\s*$/],
    tools: ["Bash(bun outdated *)", "Bash(bun outdated)", "Bash(bun pm ls*)", "Bash(bun --version)", "Bash(npm view *)", "Bash(npm ls*)", "Bash(npm outdated*)", "Bash(node --version)"],
  },
  ops: {
    description: "shell-runner only: builds, installs, test suites, file inspection inside the checkout",
    allow: [
      /^(ls|cat|head|tail|wc|find|rg|grep|du|df|file|stat|tree|pwd|env\s+--version|which|jq|sort|uniq|cut|tr|diff|realpath|basename|dirname|date|uname)(\s|$)/,
      /^bun\s+(install(\s+--frozen-lockfile)?|run\s+[\w:.-]+|test|x\s+[\w@/.:-]+|build|outdated|pm\s+ls|--version)(\s|$)/,
      /^bunx\s+[\w@/.:-]+(\s|$)/,
      /^npm\s+(ci|run\s+[\w:.-]+|test|view|ls|outdated|--version)(\s|$)/,
      /^npx\s+[\w@/.:-]+(\s|$)/,
      /^node\s+(--version|-e\s|[\w./-]+\.(js|mjs|cjs))(\s|$)/,
      /^agentpipe-e2e(\s|$)/,
      /^podman\s+(ps|images|version|info)(\s|$)/,
    ],
    tools: ["Bash(ls *)", "Bash(cat *)", "Bash(head *)", "Bash(tail *)", "Bash(wc *)", "Bash(find *)", "Bash(rg *)", "Bash(grep *)", "Bash(du *)", "Bash(df *)", "Bash(file *)", "Bash(stat *)", "Bash(tree *)", "Bash(jq *)", "Bash(bun *)", "Bash(bunx *)", "Bash(npm *)", "Bash(npx *)", "Bash(node *)", "Bash(agentpipe-e2e *)", "Bash(agentpipe-e2e)", "Bash(podman ps*)", "Bash(podman images*)", "Bash(podman version)"],
  },
};

/** Segments that are pure filters and may follow a pipe regardless of group. */
const FILTERS = /^(head|tail|grep|rg|sort|uniq|wc|cut|tr|jq|sed\s+-n|awk|column|less|cat|xargs\s+-0\s+echo|tee\s+\/dev\/null)(\s|$)/;

/** Always refused, whatever the group. Each entry: [regex, reason]. */
export const DENY: [RegExp, string][] = [
  [/\bsudo\b|\bdoas\b|\bsu\s/, "privilege escalation"],
  [/\brm\s+(-[a-zA-Z]*r|--recursive)/, "recursive delete"],
  [/\brm\s+.*(\/|~|\$HOME|\.\.)/, "delete outside the working set"],
  [/\bgit\s+(push|reset|clean|rebase|merge|commit|cherry-pick|revert|stash|checkout|switch|restore|filter-branch|update-ref|reflog\s+expire|gc|prune|remote\s+(add|remove|set-url)|config|worktree\s+(add|remove|prune)|branch\s+(-[dDmM]|--delete|--move))\b/, "git command that changes the tree, refs or remotes (the worker owns those)"],
  [/\bgh\s+(pr\s+(merge|close|edit|ready|review|reopen|create|checkout)|issue\s+(close|edit|delete|reopen|create|transfer)|repo\s+(delete|edit|create|fork|clone|sync)|release|secret|variable|auth\s+(login|logout|refresh|token|setup-git)|api\b|workflow\s+(run|enable|disable)|run\s+(cancel|rerun|delete))/, "gh command that changes state or exposes credentials"],
  [/\b(curl|wget|fetch)\b.*\|\s*(ba|z|da)?sh\b/, "piping a download into a shell"],
  [/\b(curl|wget)\b/, "network access from an agent shell"],
  [/\b(nc|ncat|netcat|telnet|ssh|scp|rsync|sftp|ftp)\b/, "network or remote shell tool"],
  [/\b(chmod|chown|chgrp|mkfs|mount|umount|dd|fdisk|parted|shutdown|reboot|systemctl|journalctl|kill|pkill|killall|crontab|nohup|setsid)\b/, "system administration command"],
  [/\b(eval|exec|source|\.\s+\/|bash\s+-c|sh\s+-c|zsh\s+-c|xargs\s+(?!-0\s+echo))\b/, "indirect execution"],
  [/\$\(|`|<\(|>\(/, "command substitution"],
  [/(^|[^2&])>(?!\s*(\/dev\/null|&2|&1))/, "writing to a file via redirection (use the Edit tool)"],
  [/\b(printenv|env)\s*$|\$\{?[A-Z_]*(TOKEN|SECRET|KEY|PASSWORD)[A-Z_]*\}?/, "reading credentials from the environment"],
  [/~\/\.(ssh|gnupg|config\/gh|claude|aws|netrc)|\/etc\/(shadow|passwd|sudoers)|\.env\b/, "credential or system file"],
  [/\bpython3?\s+-c\b|\bperl\s+-e\b|\bruby\s+-e\b/, "inline script execution"],
  [/\bcd\s+(\/|~|\.\.)/, "leaving the checkout"],
];

/**
 * Deny entries that stay in force for steps a human approved (requires_confirmation agents). The
 * git/gh state-changing entries are exactly what those agents exist for, so they are lifted; the
 * rest (privilege escalation, deleting trees, network shells, sysadmin, indirect execution,
 * credentials) stay, because a human skimming a command list should not be the only defence.
 */
export const APPROVED_DENY: [RegExp, string][] = DENY.filter(([, why]) => !why.startsWith("git command") && !why.startsWith("gh command") && !why.startsWith("writing to a file") && why !== "indirect execution").concat([
  // As in DENY, except `source` counts only as a command, so `gh repo create --source .` passes.
  [/\b(eval|exec|bash\s+-c|sh\s+-c|zsh\s+-c|xargs\s+(?!-0\s+echo))\b|(^|[;&|]\s*)source\s|(^|\s)\.\s+\//, "indirect execution"],
]);

/** Whether an approved-by-a-human command may run at all. Only the hard deny list applies; no allow list. */
export function checkApprovedCommand(command: string): PolicyVerdict {
  const cmd = command.trim();
  if (!cmd) return { ok: false, reason: "empty command" };
  for (const [re, why] of APPROVED_DENY) if (re.test(cmd)) return { ok: false, reason: `${why} (${re.source.slice(0, 40)}...)` };
  return { ok: true };
}

export interface PolicyVerdict {
  ok: boolean;
  reason?: string;
  segments?: string[];
}

function splitSegments(command: string): string[] {
  // Split on control operators; keep it simple and conservative (quotes are not parsed, so a
  // quoted `;` splits too, which can only make the check stricter).
  return command
    .replace(/\r?\n/g, " ; ")
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((s) => s.trim().replace(/^\(+|\)+$/g, "").trim())
    .filter(Boolean);
}

/** Decide whether `command` may run for an agent holding `groups`. `extraAllow` are project-specific anchored regexes (e.g. its lint command). */
export function checkCommand(command: string, groups: string[], extraAllow: RegExp[] = []): PolicyVerdict {
  const cmd = command.trim();
  if (!cmd) return { ok: false, reason: "empty command" };
  for (const [re, why] of DENY) if (re.test(cmd)) return { ok: false, reason: `${why} (${re.source.slice(0, 40)}...)` };
  const allow = [...groups.flatMap((g) => SHELL_GROUPS[g]?.allow ?? []), ...extraAllow];
  if (!allow.length) return { ok: false, reason: "this agent has no shell groups" };
  const segments = splitSegments(cmd);
  for (const [i, seg] of segments.entries()) {
    const s = seg.replace(/^(time|nice(\s+-n\s+\d+)?|timeout\s+\d+[smh]?)\s+/, "");
    if (allow.some((re) => re.test(s))) continue;
    if (i > 0 && FILTERS.test(s)) continue;
    return { ok: false, reason: `"${seg}" is not covered by shell groups [${groups.join(", ")}]`, segments };
  }
  return { ok: true, segments };
}

/** Claude Code allowedTools for a set of groups plus the project's own lint/unit commands. */
export function toolsForGroups(groups: string[], projectCommands: string[] = []): string[] {
  const out = new Set<string>();
  for (const g of groups) for (const t of SHELL_GROUPS[g]?.tools ?? []) out.add(t);
  if (groups.includes("checks")) for (const c of projectCommands) {
    out.add(`Bash(${c})`);
    out.add(`Bash(${c} *)`);
  }
  return [...out];
}

/** Anchored regexes for the project's own commands, so `checks` covers e.g. `bun run test:unit -- src/x.test.ts`. */
export function projectCommandPatterns(projectCommands: string[]): RegExp[] {
  return projectCommands.filter(Boolean).map((c) => new RegExp("^" + c.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(\\s|$)"));
}

/** Settings JSON handed to `claude --settings`: the PreToolUse hook that enforces the policy. */
export function hookSettings(groups: string[], projectCommands: string[] = []): object {
  const args = [`--groups`, groups.join(",") || "none", ...projectCommands.flatMap((c) => ["--allow", c])];
  const command = [JSON.stringify(process.execPath), JSON.stringify(path.join(agentpipeRoot(), "src", "cli.ts")), "shell-check", ...args.map((a) => JSON.stringify(a))].join(" ");
  return { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command, timeout: 20 }] }] } };
}

/** Entry point for the hook: reads Claude Code's JSON from stdin, exits 2 with a reason to block. */
export async function shellCheckMain(argv: string[]): Promise<number> {
  let groups: string[] = [];
  const allow: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--groups") groups = (argv[++i] ?? "").split(",").filter((g) => g && g !== "none");
    else if (argv[i] === "--allow") allow.push(argv[++i] ?? "");
    else if (argv[i] === "--command") {
      // Manual use: agentpipe shell-check --groups git-read --command "git log -3"
      const v = checkCommand(argv[++i] ?? "", groups, projectCommandPatterns(allow));
      console.log(v.ok ? "allowed" : `blocked: ${v.reason}`);
      return v.ok ? 0 : 2;
    }
  }
  let input = "";
  for await (const chunk of Bun.stdin.stream()) input += new TextDecoder().decode(chunk);
  let command = "";
  try {
    const data = JSON.parse(input);
    if (data.tool_name && data.tool_name !== "Bash") return 0;
    command = String(data.tool_input?.command ?? "");
  } catch {
    process.stderr.write("shell-check: could not parse hook input; blocking\n");
    return 2;
  }
  const v = checkCommand(command, groups, projectCommandPatterns(allow));
  if (!v.ok) {
    process.stderr.write(`Blocked by agentpipe shell policy: ${v.reason}. Your shell groups: [${groups.join(", ") || "none"}]. If this command is genuinely needed, delegate a subtask to the shell-runner agent describing the command and why.\n`);
    return 2;
  }
  return 0;
}
