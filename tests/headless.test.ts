import { execFile } from "node:child_process";
import { existsSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  MOCK_SERVER_ARGS,
  MOCK_SERVER_CMD,
  POISONED_SERVER_ARGS,
  POISONED_SERVER_CMD,
} from "./helpers.js";

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

describe("headless: tool-poisoning scanner", () => {
  const POISON_TARGET = ["--", POISONED_SERVER_CMD, ...POISONED_SERVER_ARGS];
  const TAG = String.fromCodePoint(0xe0041); // invisible Unicode Tag char in the fixture

  it("strips invisible chars from list-tools JSON and warns on stderr", async () => {
    const { stdout, stderr, exitCode } = await runCli(["list-tools", ...POISON_TARGET]);
    expect(exitCode).toBe(0);
    // stdout stays clean JSON with the invisible char removed...
    expect(stdout).not.toContain(TAG);
    const tools = JSON.parse(stdout);
    expect(tools.map((t: any) => t.name)).toContain("lookup");
    // ...and the finding is surfaced on stderr, not stdout.
    expect(stderr).toContain("tool-safety");
    expect(stdout).not.toContain("tool-safety");
  }, 15_000);

  it("--no-scan-tools disables scanning", async () => {
    const { stderr, exitCode } = await runCli(["list-tools", "--no-scan-tools", ...POISON_TARGET]);
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("tool-safety");
  }, 15_000);
});

describe("headless: output compression", () => {
  it("--compress-output minifies a JSON tool result losslessly", async () => {
    const plain = await runCli(["call", "json_data", ...TARGET]);
    const compressed = await runCli(["call", "json_data", "--compress-output", ...TARGET]);

    expect(plain.exitCode).toBe(0);
    expect(compressed.exitCode).toBe(0);

    const plainText = JSON.parse(plain.stdout)[0].text;
    const compressedText = JSON.parse(compressed.stdout)[0].text;

    // Compressed output is strictly smaller...
    expect(compressedText.length).toBeLessThan(plainText.length);
    // ...but the parsed value is identical (lossless).
    expect(JSON.parse(compressedText)).toEqual(JSON.parse(plainText));
  }, 15_000);

  it("leaves a non-JSON result byte-identical", async () => {
    const { stdout, exitCode } = await runCli([
      "call",
      "echo",
      '{"text":"plain unchanged text"}',
      "--compress-output",
      ...TARGET,
    ]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)[0].text).toBe("plain unchanged text");
  }, 15_000);
});

describe("headless: record & replay", () => {
  it("records a tool response then replays it offline with no target", async () => {
    const cassette = join(
      tmpdir(),
      `run-mcp-cass-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    try {
      // Record against the live mock server.
      const rec = await runCli([
        "call",
        "echo",
        '{"text":"vcr"}',
        "--cassette",
        cassette,
        "--record",
        ...TARGET,
      ]);
      expect(rec.exitCode).toBe(0);
      expect(JSON.parse(rec.stdout)[0].text).toBe("vcr");
      expect(existsSync(cassette)).toBe(true);

      // Replay offline: NO target command provided at all.
      const rep = await runCli([
        "call",
        "echo",
        '{"text":"vcr"}',
        "--cassette",
        cassette,
        "--replay",
      ]);
      expect(rep.exitCode).toBe(0);
      expect(JSON.parse(rep.stdout)[0].text).toBe("vcr");
      expect(rep.stderr).toContain("Replaying from cassette");
      expect(rep.stderr).not.toContain("Connecting");
    } finally {
      if (existsSync(cassette)) rmSync(cassette, { force: true });
    }
  }, 20_000);

  it("errors on a replay miss", async () => {
    const cassette = join(
      tmpdir(),
      `run-mcp-cass-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    try {
      const res = await runCli([
        "call",
        "echo",
        '{"text":"never recorded"}',
        "--cassette",
        cassette,
        "--replay",
      ]);
      expect(res.exitCode).not.toBe(0);
      expect(res.stderr).toContain("No cassette recording");
    } finally {
      if (existsSync(cassette)) rmSync(cassette, { force: true });
    }
  }, 15_000);
});

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
    expect(stderr.toLowerCase()).toContain("error");
  }, 15_000);

  it("exits 65 with invalid JSON args", async () => {
    const { stderr, exitCode } = await runCli(["call", "echo", "{bad json}", ...TARGET]);

    expect(exitCode).toBe(65);
    expect(stderr).toContain("Invalid JSON");
  }, 15_000);

  it("exits 64 when no target command after --", async () => {
    const { stderr, exitCode } = await runCli(["call", "echo"]);

    expect(exitCode).toBe(64);
    expect(stderr).toContain("separated by '--'");
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

  it("exits 64 for nonexistent tool", async () => {
    const { stderr, exitCode } = await runCli(["describe", "nonexistent_tool", ...TARGET]);

    expect(exitCode).toBe(64);
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

    expect(exitCode).toBe(69);
    expect(stderr).toContain("timed out");
  }, 15_000);
});

describe("headless: connection error", () => {
  it("exits 66 with actionable error for missing command", async () => {
    const { stderr, exitCode } = await runCli(["list-tools", "--", "nonexistent_binary_xyz_12345"]);

    expect(exitCode).toBe(66);
    expect(stderr).toContain("not found");
  }, 15_000);
});

describe("headless: show-stderr flag", () => {
  it("streams target server stderr to process stderr when --show-stderr is passed", async () => {
    const { stderr, exitCode } = await runCli([
      "call",
      "echo",
      '{"text":"hello"}',
      "--show-stderr",
      ...TARGET,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toContain("Mock MCP server running on stdio");
  }, 15_000);
});

describe("headless: HTTPie shorthand arguments", () => {
  it("calls tool using shorthand string args", async () => {
    const { stdout, exitCode } = await runCli(["call", "echo", "text=hello_shorthand", ...TARGET]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result[0].text).toBe("hello_shorthand");
  }, 15_000);

  it("calls tool using shorthand JSON args", async () => {
    const { stdout, exitCode } = await runCli(["call", "greet", "name=Alice", ...TARGET]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result[0].text).toBe("Hello, Alice!");
  }, 15_000);
});

describe("headless: persistent sessions", () => {
  it("spawns a background session daemon and runs consecutive calls on it", async () => {
    // 1. Spawns session 'test-session-1' on target
    const { stdout: out1, exitCode: code1 } = await runCli([
      "call",
      "echo",
      "text=hello_session",
      "--session",
      "test-session-1",
      ...TARGET,
    ]);

    expect(code1).toBe(0);
    const res1 = JSON.parse(out1);
    expect(res1[0].text).toBe("hello_session");

    // 2. Runs call on the active session without target command
    const { stdout: out2, exitCode: code2 } = await runCli([
      "call",
      "echo",
      "text=hello_again",
      "--session",
      "test-session-1",
    ]);

    expect(code2).toBe(0);
    const res2 = JSON.parse(out2);
    expect(res2[0].text).toBe("hello_again");

    // 3. Closes the session
    const { exitCode: code3 } = await runCli(["close-session", "test-session-1"]);
    expect(code3).toBe(0);
  }, 30_000);
});

describe("REPL find command (script mode)", () => {
  it("ranks tools by relevance to the query", async () => {
    const scriptPath = resolve(tmpdir(), `test-find-${Date.now()}.txt`);
    writeFileSync(scriptPath, `find take a screenshot`, "utf8");

    const { stdout, exitCode } = await runCli(["-s", scriptPath, ...TARGET]);
    unlinkSync(scriptPath);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("screenshot");
    expect(stdout).toContain("tools/describe");
  }, 15_000);
});

describe("script mode: variable extraction and error handling", () => {
  it("extracts variables using $LAST", async () => {
    const scriptPath = resolve(tmpdir(), `test-script-${Date.now()}.txt`);
    writeFileSync(
      scriptPath,
      `tools/call echo {"text": "first_value"}\ntools/call echo text=$LAST.content[0].text`,
      "utf8",
    );

    const { stdout, exitCode } = await runCli(["-s", scriptPath, ...TARGET]);
    unlinkSync(scriptPath);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("first_value");
  });

  it("exits with 1 when unexpected error occurs", async () => {
    const scriptPath = resolve(tmpdir(), `test-script-error-${Date.now()}.txt`);
    writeFileSync(scriptPath, `tools/call error_tool {}`, "utf8");

    const { exitCode } = await runCli(["-s", scriptPath, ...TARGET]);
    unlinkSync(scriptPath);

    expect(exitCode).toBe(1);
  });

  it("exits with 0 when error is expected via @expect-error", async () => {
    const scriptPath = resolve(tmpdir(), `test-script-expect-error-${Date.now()}.txt`);
    writeFileSync(scriptPath, `# @expect-error\ntools/call error_tool {}`, "utf8");

    const { exitCode, stdout } = await runCli(["-s", scriptPath, ...TARGET]);
    unlinkSync(scriptPath);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Expected error caught");
  });

  it("exits with 1 when expected error succeeds", async () => {
    const scriptPath = resolve(tmpdir(), `test-script-expect-fail-${Date.now()}.txt`);
    writeFileSync(
      scriptPath,
      `# @expect-error\ntools/call echo {"text": "this succeeds but should fail"}`,
      "utf8",
    );

    const { exitCode, stderr } = await runCli(["-s", scriptPath, ...TARGET]);
    unlinkSync(scriptPath);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Expected an error but the command succeeded");
  });
});

describe("headless: separator relaxing", () => {
  it("calls a tool successfully without the '--' double-dash separator", async () => {
    const { stdout, exitCode } = await runCli([
      "call",
      "echo",
      '{"text":"no double-dash test"}',
      MOCK_SERVER_CMD,
      ...MOCK_SERVER_ARGS,
    ]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result[0].text).toBe("no double-dash test");
  }, 15_000);
});
