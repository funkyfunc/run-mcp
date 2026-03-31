import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: false,
  // Don't bundle node_modules — keep them as external imports
  external: ["@modelcontextprotocol/sdk", "commander", "picocolors", "zod"],
});
