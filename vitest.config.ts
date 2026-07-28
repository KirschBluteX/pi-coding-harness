import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    reporters: ["default"],
    passWithNoTests: false,
    // Keep SQLite-heavy suites stable on memory-constrained, high-core hosts.
    maxWorkers: 2,
  },
});
