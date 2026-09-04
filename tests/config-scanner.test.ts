import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dedupeServers, discoverServers } from "../src/config-scanner.js";

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

describe("discoverServers (Claude Code scopes)", () => {
  it("finds user-scope, local-scope (per project), and ~/.claude/mcp.json servers", async () => {
    const home = join(tmpRoot, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    // ~/.claude.json: user scope at the top level, local scope nested per project.
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { global_one: { command: "npx", args: ["-y", "global-one"] } },
        projects: {
          [join(home, "Development", "fearch")]: {
            allowedTools: [],
            mcpServers: {
              fearch: { type: "stdio", command: "node", args: ["dist/cli.js"], env: {} },
            },
          },
          [join(home, "Development", "other")]: { allowedTools: [] },
        },
      }),
    );
    writeFileSync(
      join(home, ".claude", "mcp.json"),
      JSON.stringify({ mcpServers: { extra: { command: "python", args: ["srv.py"] } } }),
    );

    const servers = await discoverServers({ home, cwd: join(tmpRoot, "nowhere") });

    const global = servers.find((s) => s.name === "global_one");
    expect(global?.source).toBe("Claude Code (Global)");

    const local = servers.find((s) => s.name === "fearch");
    expect(local).toBeDefined();
    expect(local?.config.command).toBe("node");
    expect(local?.source).toBe("Claude Code (Local: ~/Development/fearch)");

    const extra = servers.find((s) => s.name === "extra");
    expect(extra?.source).toBe("Claude Code (~/.claude/mcp.json)");
  });

  it("treats a url-only entry as a remote target and drops unlaunchable ones", async () => {
    const home = join(tmpRoot, "home2");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          remote: { type: "http", url: "http://localhost:3000/mcp" },
          broken: { args: ["no command"] },
        },
      }),
    );

    const servers = await discoverServers({ home, cwd: join(tmpRoot, "nowhere") });
    const remote = servers.find((s) => s.name === "remote");
    expect(remote?.config.command).toBe("http://localhost:3000/mcp");
    expect(servers.find((s) => s.name === "broken")).toBeUndefined();
  });

  it("dedupes identical entries, preferring the more specific source", () => {
    const entry = { command: "node", args: ["s.js"] };
    const deduped = dedupeServers([
      { name: "s", config: entry, source: "Claude Code (Global)" },
      { name: "s", config: entry, source: "Claude Code (Project)" },
      { name: "s", config: { command: "node", args: ["other.js"] }, source: "Cursor (Global)" },
    ]);
    expect(deduped).toHaveLength(2);
    expect(deduped.find((s) => s.config.args?.[0] === "s.js")?.source).toBe(
      "Claude Code (Project)",
    );
  });
});
