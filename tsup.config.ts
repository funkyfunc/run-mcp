import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  outDir: "dist",
  clean: true,
  sourcemap: false,
  dts: false,
  external: ["@modelcontextprotocol/sdk", "commander", "picocolors", "zod"],
  define: {
    PKG_VERSION: JSON.stringify(pkg.version),
  },
});
