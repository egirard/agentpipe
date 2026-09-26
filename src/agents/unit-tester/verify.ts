import { defineVerifier, nonEmptySummary, onlyPaths, requireChanges } from "../../verify.ts";

const TEST_FILES = ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx", "**/__tests__/**", "test/**", "tests/**", "**/*.test.js"];

/** The unit tester promises tests and nothing else. */
export default defineVerifier(async (ctx) => {
  const problems = [...nonEmptySummary(ctx.result, 100), ...onlyPaths(ctx.changedFiles, TEST_FILES, "non-test")];
  if (ctx.result.status === "done") problems.push(...requireChanges(ctx.changedFiles, "test files"));
  return problems;
});
