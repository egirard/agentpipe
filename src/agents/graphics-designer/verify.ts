import { defineVerifier, forbidPaths, nonEmptySummary, onlyPaths, requireChanges, svgWellFormed } from "../../verify.ts";

const ASSET_FILES = ["**/*.svg", "**/*.css", "**/*.scss", "**/*.pcss", "static/**", "public/**", "**/assets/**", "**/tokens.*", "**/theme.*"];

/** Vector and style files only, and every changed SVG is clean. */
export default defineVerifier(async (ctx) => {
  const problems = [...nonEmptySummary(ctx.result, 60), ...onlyPaths(ctx.changedFiles, ASSET_FILES, "non-asset"), ...forbidPaths(ctx.changedFiles, ["**/*.png", "**/*-snapshots/**"], "is a raster or baseline file")];
  if (ctx.result.status === "done") problems.push(...requireChanges(ctx.changedFiles, "asset changes"));
  for (const f of ctx.changedFiles.filter((f) => f.endsWith(".svg") && ctx.exists(f))) problems.push(...svgWellFormed(ctx.read(f), f));
  return problems;
});
