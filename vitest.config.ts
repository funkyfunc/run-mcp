import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

export default defineConfig({
  define: {
    PKG_VERSION: JSON.stringify(pkg.version),
  },
  test: {
    // Tests are written in TypeScript and import from src/ directly
    include: ["tests/**/*.test.ts"],
    // Increase timeout for integration tests that spawn child processes
    testTimeout: 20_000,
    // Run test files sequentially to avoid port/stdio conflicts
    fileParallelism: false,
  },
});
