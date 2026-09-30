import { defineVerifier, nonEmptySummary, onlyPaths, requireChanges } from "../../verify.ts";

/** Project setup promises a loadable agentpipe.json with real commands and a useful AGENTPIPE.md, and nothing else. */
export default defineVerifier(async (ctx) => {
  const problems = [...nonEmptySummary(ctx.result, 60), ...onlyPaths(ctx.changedFiles, ["agentpipe.json", "AGENTPIPE.md"], "setup")];
  if (ctx.result.status !== "done") return problems;
  problems.push(...requireChanges(ctx.changedFiles, "agentpipe.json or AGENTPIPE.md changes"));
  if (!ctx.exists("agentpipe.json")) problems.push("agentpipe.json is missing");
  else {
    try {
      const cfg = JSON.parse(ctx.read("agentpipe.json"));
      for (const k of ["lint", "unit"]) if (typeof cfg?.commands?.[k] !== "string" || !cfg.commands[k].trim()) problems.push(`agentpipe.json: commands.${k} must be a non-empty command ("true" if there is none yet)`);
    } catch (e) {
      problems.push(`agentpipe.json is not valid JSON: ${(e as Error).message}`);
    }
  }
  if (!ctx.exists("AGENTPIPE.md")) problems.push("AGENTPIPE.md is missing");
  else if (ctx.read("AGENTPIPE.md").trim().length < 200) problems.push("AGENTPIPE.md is too short to guide an agent (under 200 characters)");
  return problems;
});
