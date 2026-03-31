import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests are written in TypeScript and import from src/ directly
    include: ["tests/**/*.test.ts"],
    // Increase timeout for integration tests that spawn child processes
    testTimeout: 20_000,
    // Run test files sequentially to avoid port/stdio conflicts
    fileParallelism: false,
  },
});
