import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { MOCK_SERVER_ARGS, MOCK_SERVER_CMD } from "./helpers.js";

const execFileAsync = promisify(execFile);

/** Path to the built CLI entry point. */
const CLI_PATH = resolve(import.meta.dirname, "../dist/index.js");

/** Target command tokens for the mock server. */
const TARGET = ["--", MOCK_SERVER_CMD, ...MOCK_SERVER_ARGS];

/**
 * Run a headless CLI command and return stdout, stderr, and exit code.
 * If the command exits non-zero, we still capture the output.
 */
async function runCli(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [CLI_PATH, ...args], {
      timeout: 30_000,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      exitCode: err.code ?? 1,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Headless CLI Integration Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe("headless: call", () => {
  it("calls a tool and outputs JSON to stdout", async () => {
    const { stdout, stderr, exitCode } = await runCli([
      "call",
      "echo",
      '{"text":"hello from headless"}',
      ...TARGET,
    ]);

    expect(exitCode).toBe(0);

    const result = JSON.parse(stdout);
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].type).toBe("text");
    expect(result[0].text).toBe("hello from headless");

    // stderr should have status messages
    expect(stderr).toContain("Connecting");
    expect(stderr).toContain("Connected");
  }, 15_000);

  it("outputs full result with --raw flag", async () => {
    const { stdout, exitCode } = await runCli([
      "call",
      "echo",
      '{"text":"raw test"}',
      "--raw",
      ...TARGET,
    ]);

    expect(exitCode).toBe(0);

    const result = JSON.parse(stdout);
    // Raw mode should include the content array as a property
    expect(result).toHaveProperty("content");
    expect(result.content[0].text).toBe("raw test");
  }, 15_000);

  it("exits 1 when calling nonexistent tool", async () => {
    const { stderr, exitCode } = await runCli(["call", "nonexistent_tool_xyz", ...TARGET]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Error");
  }, 15_000);

  it("exits 2 with invalid JSON args", async () => {
    const { stderr, exitCode } = await runCli(["call", "echo", "{bad json}", ...TARGET]);

    expect(exitCode).toBe(2);
    expect(stderr).toContain("Invalid JSON");
  }, 15_000);

  it("exits 2 when no target command after --", async () => {
    const { stderr, exitCode } = await runCli(["call", "echo"]);

    expect(exitCode).toBe(2);
    expect(stderr).toContain("No target server command");
  }, 15_000);

  it("stdout contains no ANSI escape sequences", async () => {
    const { stdout, exitCode } = await runCli([
      "call",
      "echo",
      '{"text":"clean output"}',
      ...TARGET,
    ]);

    expect(exitCode).toBe(0);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: testing for ANSI escapes
    expect(stdout).not.toMatch(/\x1b\[/);
  }, 15_000);
});

describe("headless: list-tools", () => {
  it("outputs tool array as JSON", async () => {
    const { stdout, exitCode } = await runCli(["list-tools", ...TARGET]);

    expect(exitCode).toBe(0);

    const tools = JSON.parse(stdout);
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);

    // Each tool should have required fields
    const names = tools.map((t: any) => t.name);
    expect(names).toContain("echo");
    expect(names).toContain("greet");

    // Should have inputSchema
    const echoTool = tools.find((t: any) => t.name === "echo");
    expect(echoTool).toHaveProperty("inputSchema");
  }, 15_000);
});

describe("headless: list-resources", () => {
  it("outputs resource array as JSON", async () => {
    const { stdout, exitCode } = await runCli(["list-resources", ...TARGET]);

    expect(exitCode).toBe(0);

    const resources = JSON.parse(stdout);
    expect(Array.isArray(resources)).toBe(true);
    expect(resources.length).toBeGreaterThan(0);

    const uris = resources.map((r: any) => r.uri);
    expect(uris).toContain("docs://readme");
  }, 15_000);
});

describe("headless: list-prompts", () => {
  it("outputs prompt array as JSON", async () => {
    const { stdout, exitCode } = await runCli(["list-prompts", ...TARGET]);

    expect(exitCode).toBe(0);

    const prompts = JSON.parse(stdout);
    expect(Array.isArray(prompts)).toBe(true);

    const names = prompts.map((p: any) => p.name);
    expect(names).toContain("greeting");
  }, 15_000);
});

describe("headless: read", () => {
  it("reads a resource and outputs content", async () => {
    const { stdout, exitCode } = await runCli(["read", "docs://readme", ...TARGET]);

    expect(exitCode).toBe(0);

    const result = JSON.parse(stdout);
    expect(result).toHaveProperty("contents");
  }, 15_000);
});

describe("headless: describe", () => {
  it("outputs a tool's full schema", async () => {
    const { stdout, exitCode } = await runCli(["describe", "echo", ...TARGET]);

    expect(exitCode).toBe(0);

    const tool = JSON.parse(stdout);
    expect(tool.name).toBe("echo");
    expect(tool).toHaveProperty("inputSchema");
    expect(tool).toHaveProperty("description");
  }, 15_000);

  it("exits 1 for nonexistent tool", async () => {
    const { stderr, exitCode } = await runCli(["describe", "nonexistent_tool", ...TARGET]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("not found");
  }, 15_000);
});

describe("headless: get-prompt", () => {
  it("gets a prompt and outputs result", async () => {
    const { stdout, exitCode } = await runCli([
      "get-prompt",
      "greeting",
      '{"name":"Ada"}',
      ...TARGET,
    ]);

    expect(exitCode).toBe(0);

    const result = JSON.parse(stdout);
    expect(result).toHaveProperty("messages");
  }, 15_000);
});

describe("headless: timeout", () => {
  it("enforces timeout on slow tool", async () => {
    const { stderr, exitCode } = await runCli([
      "call",
      "slow",
      '{"ms":10000}',
      "--timeout",
      "500",
      ...TARGET,
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("timed out");
  }, 15_000);
});

describe("headless: connection error", () => {
  it("exits 1 with actionable error for missing command", async () => {
    const { stderr, exitCode } = await runCli(["list-tools", "--", "nonexistent_binary_xyz_12345"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("not found");
  }, 15_000);
});
