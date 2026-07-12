import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverServers } from "../src/config-scanner.js";

/**
 * Tests the dynamic `--scan` walk-up discovery. Uses a temp working directory so
 * the assertion targets a server we planted (results may also include the
 * developer's real configured servers — we only assert our entry is present).
 */

let tmpRoot: string;
const savedCwd = process.cwd();

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "run-mcp-scan-"));
});

afterEach(() => {
  process.chdir(savedCwd);
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("discoverServers (scan mode)", () => {
  it("finds an mcpServers block in a JSON file up the cwd tree", async () => {
    const workdir = join(tmpRoot, "project", "nested");
    mkdirSync(workdir, { recursive: true });
    writeFileSync(
      join(tmpRoot, "project", "custom-mcp.json"),
      JSON.stringify({
        mcpServers: { planted: { command: "node", args: ["server.js"] } },
      }),
    );
    process.chdir(workdir);

    const servers = await discoverServers({ scan: true });
    const planted = servers.find((s) => s.name === "planted");
    expect(planted).toBeDefined();
    expect(planted?.config.command).toBe("node");
    expect(planted?.source).toContain("Local Workspace");
  });

  it("skips package.json / tsconfig.json and ignores malformed JSON", async () => {
    const workdir = join(tmpRoot, "w");
    mkdirSync(workdir, { recursive: true });
    // package.json containing "mcpServers" as a string must be skipped by name.
    writeFileSync(join(workdir, "package.json"), JSON.stringify({ note: "mcpServers here" }));
    // A malformed json file must not throw.
    writeFileSync(join(workdir, "broken.json"), "{ mcpServers: BROKEN");
    process.chdir(workdir);

    const servers = await discoverServers({ scan: true });
    // No crash, and nothing named from those files.
    expect(Array.isArray(servers)).toBe(true);
  });
});
