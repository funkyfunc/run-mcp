import { execFile } from "node:child_process";
import { rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  options: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [CLI_PATH, ...args], {
      timeout: 30_000,
      cwd: options.cwd,
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

describe("headless: --env", () => {
  it("passes --env values to the target, which otherwise inherits almost nothing", async () => {
    // Without --env: the parent's variable does not reach the child (only a
    // PATH/HOME-style whitelist is inherited), so a server reading an API key
    // from its environment would see nothing.
    const inherited = await runCli(["call", "env_echo", "name=RUN_MCP_TEST_SECRET", ...TARGET]);
    expect(inherited.exitCode).toBe(0);
    expect(JSON.parse(inherited.stdout)[0].text).toBe("<unset>");

    const passed = await runCli([
      "call",
      "env_echo",
      "name=RUN_MCP_TEST_SECRET",
      "--env",
      "RUN_MCP_TEST_SECRET=hunter=2",
      ...TARGET,
    ]);
    expect(passed.exitCode).toBe(0);
    // The first "=" splits key from value, so values may contain "=".
    expect(JSON.parse(passed.stdout)[0].text).toBe("hunter=2");
  }, 20_000);

  it("rejects a malformed --env token", async () => {
    const { stderr, exitCode } = await runCli(["call", "echo", "--env", "NOEQUALS", ...TARGET]);
    expect(exitCode).toBe(64);
    expect(stderr).toContain("--env expects KEY=VALUE");
    expect(stderr).toContain("NOEQUALS");
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

// ═══════════════════════════════════════════════════════════════════════════════
// Stderr as data, and the session dev loop (stderr / reconnect / validate)
// ═══════════════════════════════════════════════════════════════════════════════

describe("headless: stderr as data (one-shot)", () => {
  it("`stderr` prints the server's startup output as a JSON array", async () => {
    const { stdout, exitCode } = await runCli(["stderr", ...TARGET]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toContain("Mock MCP server running on stdio");
  }, 15_000);

  it("`call --raw` carries a stderr field with what the server wrote", async () => {
    const { stdout, exitCode } = await runCli([
      "call",
      "log_stderr",
      "line=audit-raw",
      "--raw",
      ...TARGET,
    ]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.content[0].text).toBe("logged: audit-raw");
    expect(result.stderr).toContain("Mock MCP server running on stdio");
    expect(result.stderr).toContain("audit-raw");
  }, 15_000);

  it("a server that dies on connect has its stderr printed, not just 'Connection closed'", async () => {
    const { STARTUP_CRASH_CMD, STARTUP_CRASH_ARGS } = await import("./helpers.js");
    const { stderr, exitCode } = await runCli([
      "list-tools",
      "--",
      STARTUP_CRASH_CMD,
      ...STARTUP_CRASH_ARGS,
    ]);
    expect(exitCode).toBe(69);
    expect(stderr).toContain("--- Target server stderr ---");
    expect(stderr).toContain("[startup-crash] FATAL");
  }, 20_000);

  it("`reconnect` without a session is refused with a pointer to --session", async () => {
    const { stderr, exitCode } = await runCli(["reconnect", ...TARGET]);
    expect(exitCode).toBe(64);
    expect(stderr).toContain("--session");
  }, 15_000);
});

describe("headless: session dev loop", () => {
  const session = `dev-loop-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  it("stderr, --show-stderr, --raw, reconnect, validate, and --timeout all work on a session", async () => {
    try {
      // Spawn the session.
      const first = await runCli(["list-tools", "--session", session, ...TARGET]);
      expect(first.exitCode).toBe(0);
      expect(JSON.parse(first.stdout).some((t: any) => t.name === "log_stderr")).toBe(true);

      // A sessioned call prints nothing but the result.
      const quiet = await runCli(["call", "echo", "text=quiet", "--session", session]);
      expect(quiet.exitCode).toBe(0);
      expect(quiet.stderr).toBe("");
      expect(JSON.parse(quiet.stdout)[0].text).toBe("quiet");

      // --show-stderr replays only what this call wrote (not the startup line).
      const shown = await runCli([
        "call",
        "log_stderr",
        "line=audit-shown",
        "--session",
        session,
        "--show-stderr",
      ]);
      expect(shown.exitCode).toBe(0);
      expect(shown.stderr).toContain("audit-shown");
      expect(shown.stderr).not.toContain("Mock MCP server running on stdio");

      // --raw carries the per-call stderr window.
      const raw = await runCli([
        "call",
        "log_stderr",
        "line=audit-raw",
        "--session",
        session,
        "--raw",
      ]);
      expect(raw.exitCode).toBe(0);
      expect(JSON.parse(raw.stdout).stderr).toEqual(["audit-raw"]);

      // `stderr` shows everything since the server started; `stderr N` the tail.
      const all = await runCli(["stderr", "--session", session]);
      expect(all.exitCode).toBe(0);
      const lines = JSON.parse(all.stdout);
      expect(lines[0]).toBe("Mock MCP server running on stdio");
      expect(lines).toContain("audit-shown");
      expect(lines).toContain("audit-raw");
      const tail = await runCli(["stderr", "1", "--session", session]);
      expect(JSON.parse(tail.stdout)).toEqual(["audit-raw"]);

      // --timeout applies per call.
      const slow = await runCli([
        "call",
        "slow",
        "ms:=10000",
        "--timeout",
        "500",
        "--session",
        session,
      ]);
      expect(slow.exitCode).toBe(1);
      expect(slow.stderr).toContain("timed out");

      // validate runs against the running instance.
      const quick = await runCli(["validate", "--json", "--session", session]);
      expect(quick.exitCode).toBe(0);
      expect(JSON.parse(quick.stdout).success).toBe(true);
      const deep = await runCli(["validate", "--deep", "--json", "--session", session]);
      expect(deep.exitCode).toBe(0);
      const report = JSON.parse(deep.stdout);
      expect(report.status).toBe("PASS");
      expect(report.checks[0].name).toBe("handshake_connection");
      expect(report.checks[0].message).toContain("already-running session");

      // reconnect restarts the server: fresh PID, fresh stderr buffer, diff reported.
      const before = JSON.parse((await runCli(["stderr", "--session", session])).stdout);
      expect(before.length).toBeGreaterThan(1);
      const rc = await runCli(["reconnect", "--session", session]);
      expect(rc.exitCode).toBe(0);
      const rcResult = JSON.parse(rc.stdout);
      expect(rcResult.reconnected).toBe(true);
      expect(typeof rcResult.pid).toBe("number");
      expect(rcResult.changes).toEqual(["Changes since last connection: none"]);
      const after = JSON.parse((await runCli(["stderr", "--session", session])).stdout);
      expect(after).toEqual(["Mock MCP server running on stdio"]);

      // Still usable afterwards.
      const again = await runCli(["call", "echo", "text=after", "--session", session]);
      expect(JSON.parse(again.stdout)[0].text).toBe("after");
    } finally {
      await runCli(["close-session", session]);
    }
  }, 60_000);

  it("validate on a session that isn't running exits 64 with a hint", async () => {
    const { stderr, exitCode } = await runCli(["validate", "--session", "no-such-session-xyz"]);
    expect(exitCode).toBe(64);
    expect(stderr).toContain("is not running");
    expect(stderr).toContain("--session no-such-session-xyz");
  }, 15_000);
});

describe("headless: session reconnect after an edit", () => {
  it("diffs primitives, keeps a crashed target's stderr readable, and recovers", async () => {
    const { STARTUP_CRASH_CMD, STARTUP_CRASH_ARGS, SECOND_SERVER_CMD, SECOND_SERVER_ARGS } =
      await import("./helpers.js");
    const dir = join(tmpdir(), `run-mcp-edit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const pointer = join(dir, "target.txt");
    const wrapper = join(dir, "wrap.sh");
    const session = `edit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const point = (cmd: string, args: string[]) =>
      writeFileSync(pointer, [cmd, ...args].join(" ") + "\n");

    // The "edit": a wrapper whose target is whatever the pointer file names.
    const { mkdirSync, chmodSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(wrapper, `#!/bin/sh\nexec $(cat "${pointer}")\n`);
    chmodSync(wrapper, 0o755);

    try {
      point(MOCK_SERVER_CMD, MOCK_SERVER_ARGS);
      const first = await runCli(["list-tools", "--session", session, "--", wrapper]);
      expect(first.exitCode).toBe(0);

      // Edit to a server with a different tool set → the diff says so.
      point(SECOND_SERVER_CMD, SECOND_SERVER_ARGS);
      const swapped = JSON.parse((await runCli(["reconnect", "--session", session])).stdout);
      expect(swapped.reconnected).toBe(true);
      expect(swapped.changes.join("\n")).toMatch(/Tools: .*removed/);

      // Edit to a server that crashes at startup → failure carries stderr inline.
      point(STARTUP_CRASH_CMD, STARTUP_CRASH_ARGS);
      const crashed = await runCli(["reconnect", "--session", session]);
      expect(crashed.exitCode).toBe(1);
      const crash = JSON.parse(crashed.stdout);
      expect(crash.reconnected).toBe(false);
      expect(crash.stderr.join("\n")).toContain("[startup-crash] FATAL");

      // The dead target's stderr stays readable; calls say what to do.
      const post = JSON.parse((await runCli(["stderr", "--session", session])).stdout);
      expect(post.join("\n")).toContain("[startup-crash] FATAL");
      const dead = await runCli(["call", "echo", "text=x", "--session", session]);
      expect(dead.exitCode).toBe(1);
      expect(dead.stderr).toContain("not connected");
      expect(dead.stderr).toContain(`reconnect --session ${session}`);
      const deadValidate = await runCli(["validate", "--json", "--session", session]);
      expect(deadValidate.exitCode).toBe(1);
      expect(JSON.parse(deadValidate.stdout).success).toBe(false);

      // Fix the edit → reconnect recovers.
      point(MOCK_SERVER_CMD, MOCK_SERVER_ARGS);
      const fixed = JSON.parse((await runCli(["reconnect", "--session", session])).stdout);
      expect(fixed.reconnected).toBe(true);
      const alive = await runCli(["call", "echo", "text=alive", "--session", session]);
      expect(JSON.parse(alive.stdout)[0].text).toBe("alive");
    } finally {
      await runCli(["close-session", session]);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("headless: session hygiene", () => {
  it("a server that dies on the first sessioned call reports its stderr and leaves no session", async () => {
    const { STARTUP_CRASH_CMD, STARTUP_CRASH_ARGS } = await import("./helpers.js");
    const session = `crash-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { stderr, exitCode } = await runCli([
      "list-tools",
      "--session",
      session,
      "--",
      STARTUP_CRASH_CMD,
      ...STARTUP_CRASH_ARGS,
    ]);
    expect(exitCode).toBe(69);
    expect(stderr).toContain("--- Target server stderr ---");
    expect(stderr).toContain("[startup-crash] FATAL");
    expect(stderr).not.toContain("Failed to spawn background daemon");
    const listed = JSON.parse((await runCli(["sessions"])).stdout);
    expect(listed.some((s: any) => s.name === session)).toBe(false);
  }, 20_000);

  it("lists sessions, refuses a mismatched command or cwd, and honours --idle-timeout", async () => {
    const { SECOND_SERVER_CMD, SECOND_SERVER_ARGS } = await import("./helpers.js");
    const session = `hyg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      // 0.05 minutes = 3s idle timeout.
      const first = await runCli([
        "call",
        "echo",
        "text=hi",
        "--session",
        session,
        "--idle-timeout",
        "0.05",
        ...TARGET,
      ]);
      expect(first.exitCode).toBe(0);

      // `sessions` shows it with its command, cwd, and idle timeout.
      const listed = JSON.parse((await runCli(["sessions"])).stdout);
      const row = listed.find((s: any) => s.name === session);
      expect(row).toBeDefined();
      expect(row.command).toBe([MOCK_SERVER_CMD, ...MOCK_SERVER_ARGS].join(" "));
      expect(row.cwd).toBe(process.cwd());
      expect(row.pid).toBeGreaterThan(0);
      expect(row.idle_timeout).toBe("3s");

      // Same command, same cwd: fine. Different command: refused, both shown.
      const same = await runCli(["call", "echo", "text=same", "--session", session, ...TARGET]);
      expect(same.exitCode).toBe(0);
      const other = await runCli([
        "call",
        "echo",
        "text=x",
        "--session",
        session,
        "--",
        SECOND_SERVER_CMD,
        ...SECOND_SERVER_ARGS,
      ]);
      expect(other.exitCode).toBe(64);
      expect(other.stderr).toContain("already running a different server");
      expect(other.stderr).toContain(`close-session ${session}`);

      // Same command from another directory: refused (a relative path would be
      // a different server). Attaching without a command from there: fine.
      const elsewhere = await runCli(["call", "echo", "text=x", "--session", session, ...TARGET], {
        cwd: tmpdir(),
      });
      expect(elsewhere.exitCode).toBe(64);
      expect(elsewhere.stderr).toContain("already running a different server");
      const attach = await runCli(["call", "echo", "text=attach", "--session", session], {
        cwd: tmpdir(),
      });
      expect(attach.exitCode).toBe(0);
      expect(JSON.parse(attach.stdout)[0].text).toBe("attach");

      // A later call can change the timeout; `sessions` shows the value in force.
      await runCli(["call", "echo", "text=y", "--session", session, "--idle-timeout", "0.1"]);
      const updated = JSON.parse((await runCli(["sessions"])).stdout);
      expect(updated.find((s: any) => s.name === session).idle_timeout).toBe("6s");

      // ...and then it closes itself.
      await new Promise((r) => setTimeout(r, 7_500));
      const after = JSON.parse((await runCli(["sessions"])).stdout);
      expect(after.some((s: any) => s.name === session)).toBe(false);
      const gone = await runCli(["call", "echo", "text=z", "--session", session]);
      expect(gone.exitCode).toBe(64);
      expect(gone.stderr).toContain("is not running");
    } finally {
      await runCli(["close-session", session]);
    }
  }, 60_000);

  it("spawns the daemon with --env, and refuses a later call that asks for different env", async () => {
    const session = `env-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      const first = await runCli([
        "call",
        "env_echo",
        "name=RUN_MCP_SESSION_SECRET",
        "--session",
        session,
        "--env",
        "RUN_MCP_SESSION_SECRET=s3cret",
        ...TARGET,
      ]);
      expect(first.exitCode).toBe(0);
      expect(JSON.parse(first.stdout)[0].text).toBe("s3cret");

      // `sessions` names the keys, never the values.
      const listed = JSON.parse((await runCli(["sessions"])).stdout);
      expect(listed.find((s: any) => s.name === session).env_keys).toEqual([
        "RUN_MCP_SESSION_SECRET",
      ]);
      expect(JSON.stringify(listed)).not.toContain("s3cret");

      // Attaching with no --env: fine, the running server keeps its env.
      const attach = await runCli([
        "call",
        "env_echo",
        "name=RUN_MCP_SESSION_SECRET",
        "--session",
        session,
      ]);
      expect(JSON.parse(attach.stdout)[0].text).toBe("s3cret");

      // Same env again: fine. A different value: refused, key named, value not shown.
      const same = await runCli([
        "call",
        "echo",
        "text=ok",
        "--session",
        session,
        "--env",
        "RUN_MCP_SESSION_SECRET=s3cret",
        ...TARGET,
      ]);
      expect(same.exitCode).toBe(0);
      const changed = await runCli([
        "call",
        "echo",
        "text=x",
        "--session",
        session,
        "--env",
        "RUN_MCP_SESSION_SECRET=leaked-value-xyz",
      ]);
      expect(changed.exitCode).toBe(64);
      expect(changed.stderr).toContain("env differs for: RUN_MCP_SESSION_SECRET");
      expect(changed.stderr).not.toContain("leaked-value-xyz");
    } finally {
      await runCli(["close-session", session]);
    }
  }, 30_000);

  it("rejects a session name that is not a safe file name", async () => {
    const { stderr, exitCode } = await runCli([
      "call",
      "echo",
      "text=z",
      "--session",
      "../escape",
      ...TARGET,
    ]);
    expect(exitCode).toBe(64);
    expect(stderr).toContain('Session name "../escape" is invalid');
  }, 15_000);

  it("rejects a non-numeric --idle-timeout", async () => {
    const { stderr, exitCode } = await runCli([
      "call",
      "echo",
      "text=z",
      "--session",
      "unused",
      "--idle-timeout",
      "soon",
      ...TARGET,
    ]);
    expect(exitCode).toBe(64);
    expect(stderr).toContain("--idle-timeout must be a positive number of minutes");
  }, 15_000);
});
