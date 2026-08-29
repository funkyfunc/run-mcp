#!/usr/bin/env node

import { program } from "commander";
import { createConnection, createServer } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { pickDiscoveredServer } from "./config-scanner.js";
import {
  runHeadless,
  executeOperation,
  DEFAULT_HEADLESS_TIMEOUT_MS,
  type OperationOutcome,
} from "./headless.js";
import { startRepl } from "./repl.js";
import { startServer } from "./server.js";
import { TargetManager } from "./target-manager.js";
import { ResponseInterceptor } from "./interceptor.js";
import { validateProtocol, type ValidationReport } from "./validator.js";
import { computeSnapshotDiff, takeSnapshot } from "./snapshot.js";

// ─── Headless subcommand helper ───────────────────────────────────────────────

/**
 * Validate that a target command was provided, or exit with usage help.
 */
function requireTargetCommand(targetCommand: string[], subcommandUsage: string): string[] {
  const target = activeTargetCommand ?? targetCommand;
  if (!target || target.length === 0) {
    process.stderr.write(`Error: Target server command must be separated by '--'.\n`);
    process.stderr.write(`This avoids option parsing conflicts.\n\n`);
    process.stderr.write(`Usage: ${subcommandUsage}\n`);
    process.exit(64);
  }
  return target;
}

const SESSION_DIR = join(tmpdir(), "run-mcp", "sessions");

interface SessionData {
  port: number;
  pid: number;
}

function getSessionPath(name: string): string {
  return join(SESSION_DIR, `${name}.json`);
}

async function getSession(name: string): Promise<SessionData | null> {
  const path = getSessionPath(name);
  if (!existsSync(path)) return null;
  try {
    const data = await readFile(path, "utf8");
    const parsed = JSON.parse(data) as SessionData;
    try {
      process.kill(parsed.pid, 0);
      return parsed;
    } catch {
      await rm(path, { force: true }).catch(() => {});
      return null;
    }
  } catch {
    return null;
  }
}

function sendDaemonRequest<T = OperationOutcome>(port: number, request: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ port });
    let buffer = "";

    socket.on("connect", () => {
      socket.write(JSON.stringify(request) + "\n");
    });

    socket.on("data", (data) => {
      buffer += data.toString();
    });

    socket.on("end", () => {
      try {
        const parsed = JSON.parse(buffer);
        if (parsed.error) {
          reject(new Error(parsed.error.message));
        } else {
          resolve(parsed.result as T);
        }
      } catch (err) {
        reject(new Error(`Failed to parse daemon response: ${err}`));
      }
    });

    socket.on("error", (err) => {
      reject(err);
    });
  });
}

async function handleHeadlessSession(
  sessionName: string,
  targetCommand: string[],
  operation: any,
  opts: any,
  subcommandUsage: string,
): Promise<void> {
  let session = await getSession(sessionName);

  if (!session) {
    // Check if we have activeTargetCommand. If not, fail with coaching error
    if (!activeTargetCommand) {
      process.stderr.write(`Error: Session "${sessionName}" is not running.\n`);
      process.stderr.write(`Please provide a target command after '--' to start it.\n\n`);
      process.stderr.write(`Usage: ${subcommandUsage}\n`);
      process.exit(64);
    }

    const target = activeTargetCommand;

    // Spawn the daemon process in background. The target command is separated
    // with `--` so it isn't swallowed during the daemon's re-parse.
    const binPath = resolve(import.meta.dirname, "./index.js");
    const daemonArgs = ["daemon", sessionName];
    if (opts.transport) daemonArgs.push("--transport", opts.transport);
    daemonArgs.push("--", ...target);
    const daemonProcess = spawn("node", [binPath, ...daemonArgs], {
      detached: true,
      stdio: "ignore",
    });
    daemonProcess.unref();

    // Poll until session file exists and is readable (up to 5s)
    let attempts = 0;
    while (attempts < 50) {
      session = await getSession(sessionName);
      if (session) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
      attempts++;
    }

    if (!session) {
      process.stderr.write(
        `Error: Failed to spawn background daemon for session "${sessionName}".\n`,
      );
      process.exit(1);
    }
  }

  // Forward request to daemon
  try {
    const response = await sendDaemonRequest(session.port, {
      jsonrpc: "2.0",
      method: "execute",
      params: { operation, opts },
      id: 1,
    });

    // The daemon holds the target's stderr pipe, so `--show-stderr` can't stream
    // live; it comes back with the response and is replayed here, still on stderr.
    if (response.stderr && response.stderr.length > 0) {
      process.stderr.write(`${response.stderr.join("\n")}\n`);
    }
    process.stdout.write(`${JSON.stringify(response.result, null, 2)}\n`);
    process.exit(response.hasError ? 1 : 0);
  } catch (err: any) {
    process.stderr.write(`Error (session "${sessionName}"): ${err.message}\n`);
    process.exit(1);
  }
}

// ─── Shared headless options ──────────────────────────────────────────────────

interface HeadlessOpts {
  outDir?: string;
  timeout?: string;
  raw?: boolean;
  showStderr?: boolean;
  mediaThreshold?: string;
  session?: string;
  cassette?: string;
  record?: boolean;
  replay?: boolean;
  transport?: string;
}

function parseHeadlessOpts(opts: HeadlessOpts) {
  return {
    outDir: opts.outDir,
    timeoutMs: opts.timeout ? Number.parseInt(opts.timeout, 10) : undefined,
    raw: opts.raw,
    showStderr: opts.showStderr,
    mediaThresholdKb: opts.mediaThreshold ? Number.parseInt(opts.mediaThreshold, 10) : undefined,
    cassettePath: opts.cassette,
    cassetteMode: opts.record ? ("record" as const) : opts.replay ? ("replay" as const) : undefined,
    transport: opts.transport as "auto" | "http" | "sse" | undefined,
  };
}

// ─── Pre-process argv to split target command from run-mcp arguments ─────────

let activeTargetCommand: string[] | undefined;
let argvToParse = process.argv;

const dashDashIndex = process.argv.indexOf("--");
if (dashDashIndex !== -1) {
  activeTargetCommand = process.argv.slice(dashDashIndex + 1);
  argvToParse = [...process.argv.slice(0, dashDashIndex)];
}

// ─── Enable positional options for subcommand support ─────────────────────────

program.enablePositionalOptions();

// ─── Headless subcommand registration helper ─────────────────────────────────

interface HeadlessCommandConfig {
  name: string;
  description: string;
  args: Array<{ name: string; required: boolean; description: string }>;
  extraOptions?: Array<{ flags: string; description: string }>;
  buildOperation: (...positionalArgs: any[]) => any;
  usageHint: string;
}

function registerHeadlessCommand(config: HeadlessCommandConfig) {
  const cmd = program.command(config.name).description(config.description);

  for (const arg of config.args) {
    const wrapped = arg.required ? `<${arg.name}>` : `[${arg.name}]`;
    cmd.argument(wrapped, arg.description);
  }
  cmd.argument("[target_command...]", "Target server command (after --)");

  // Shared options for all headless commands
  cmd
    .option("-o, --out-dir <path>", "Output directory for saved media")
    .option("-t, --timeout <ms>", "Timeout in milliseconds (default: 30000)")
    .option(
      "-m, --media-threshold <kb>",
      "Media size threshold in KB to save to disk (0 to always save, -1 to keep inline)",
    )
    .option("--show-stderr", "Stream target server stderr to process stderr")
    .option(
      "--session <name>",
      "Keep the server running between commands: spawned on the first call, reused after (skips the cold start)",
    )
    .option(
      "--cassette <file>",
      "Record/replay responses to a cassette file (auto: replay if present, else record)",
    )
    .option("--record", "Force (re)recording into the --cassette file")
    .option("--replay", "Force replay-only from the --cassette file (error on a miss)")
    .option(
      "--transport <mode>",
      "Transport for http(s) targets: auto (default), http (Streamable HTTP), sse",
    )
    .allowUnknownOption();

  // Command-specific options
  for (const opt of config.extraOptions ?? []) {
    cmd.option(opt.flags, opt.description);
  }

  cmd.action(async (...actionArgs: any[]) => {
    // Commander passes positional args first, then opts, then the Command object
    // For N defined args + [target_command...], we get N+1 positional + opts + cmd
    const positionalCount = config.args.length;
    const positionalArgs = actionArgs.slice(0, positionalCount);
    const targetCommand: string[] = actionArgs[positionalCount];
    const opts: HeadlessOpts = actionArgs[positionalCount + 1];

    const operation = config.buildOperation(...positionalArgs);
    const parsedOpts = parseHeadlessOpts(opts);
    const usageStr = `run-mcp ${config.usageHint}`;

    if (opts.session) {
      await handleHeadlessSession(opts.session, targetCommand, operation, parsedOpts, usageStr);
    } else if (operation.type === "reconnect") {
      process.stderr.write(
        "Error: reconnect restarts the server behind a running session; pass --session <name>.\n" +
          "Without a session every command already starts a fresh server.\n\n" +
          `Usage: ${usageStr}\n`,
      );
      process.exit(64);
    } else {
      // Offline replay (call/read/get-prompt) needs no target command — the
      // response comes from the cassette. Every other case requires the target.
      const offlineReplayable = new Set(["call", "read", "get-prompt"]);
      const canRunOffline =
        parsedOpts.cassetteMode === "replay" && offlineReplayable.has(operation.type);
      const provided = activeTargetCommand ?? targetCommand ?? [];
      const target =
        canRunOffline && provided.length === 0 ? [] : requireTargetCommand(provided, usageStr);
      await runHeadless(target, operation, parsedOpts);
    }
  });
}

// ─── Headless subcommands ─────────────────────────────────────────────────────

registerHeadlessCommand({
  name: "call",
  description: "Call a tool on a target MCP server and print the result as JSON",
  args: [
    { name: "tool", required: true, description: "Tool name to call" },
    { name: "json_args", required: false, description: "JSON arguments for the tool" },
  ],
  extraOptions: [
    { flags: "--raw", description: "Print the full result object including metadata" },
  ],
  buildOperation: (tool: string, jsonArgs?: string) => ({
    type: "call" as const,
    tool,
    args: jsonArgs,
  }),
  usageHint: "call <tool> [json_args] -- <server_command...>",
});

registerHeadlessCommand({
  name: "list-tools",
  description: "List all tools on a target MCP server as JSON",
  args: [],
  buildOperation: () => ({ type: "list-tools" as const }),
  usageHint: "list-tools -- <server_command...>",
});

registerHeadlessCommand({
  name: "list-resources",
  description: "List all resources on a target MCP server as JSON",
  args: [],
  buildOperation: () => ({ type: "list-resources" as const }),
  usageHint: "list-resources -- <server_command...>",
});

registerHeadlessCommand({
  name: "list-prompts",
  description: "List all prompts on a target MCP server as JSON",
  args: [],
  buildOperation: () => ({ type: "list-prompts" as const }),
  usageHint: "list-prompts -- <server_command...>",
});

registerHeadlessCommand({
  name: "read",
  description: "Read a resource by URI from a target MCP server",
  args: [{ name: "uri", required: true, description: "Resource URI to read" }],
  buildOperation: (uri: string) => ({ type: "read" as const, uri }),
  usageHint: "read <uri> -- <server_command...>",
});

registerHeadlessCommand({
  name: "describe",
  description: "Print a tool's full schema as JSON",
  args: [{ name: "tool", required: true, description: "Tool name to describe" }],
  buildOperation: (tool: string) => ({ type: "describe" as const, tool }),
  usageHint: "describe <tool> -- <server_command...>",
});

registerHeadlessCommand({
  name: "get-prompt",
  description: "Get a prompt with optional arguments from a target MCP server",
  args: [
    { name: "name", required: true, description: "Prompt name" },
    { name: "json_args", required: false, description: "JSON arguments for the prompt" },
  ],
  buildOperation: (name: string, jsonArgs?: string) => ({
    type: "get-prompt" as const,
    name,
    args: jsonArgs,
  }),
  usageHint: "get-prompt <name> [json_args] -- <server_command...>",
});

registerHeadlessCommand({
  name: "stderr",
  description:
    "Print the target server's captured stderr as a JSON array of lines (with --session: everything since it started; otherwise: its startup output)",
  args: [{ name: "count", required: false, description: "Only the last N lines" }],
  buildOperation: (count?: string) => ({
    type: "stderr" as const,
    count: count ? Number.parseInt(count, 10) : undefined,
  }),
  usageHint: "stderr [count] --session <name>  (or: stderr -- <server_command...>)",
});

registerHeadlessCommand({
  name: "reconnect",
  description:
    "Restart the server behind a session after a code edit and report which tools/resources/prompts changed",
  args: [],
  buildOperation: () => ({ type: "reconnect" as const }),
  usageHint: "reconnect --session <name>",
});

// ─── Subcommand: daemon ───────────────────────────────────────────────────────

program
  .command("daemon")
  .argument("<session_name>", "Session name")
  .argument("[target_command...]", "Target server command")
  .option(
    "--transport <mode>",
    "Transport for http(s) targets: auto (default), http (Streamable HTTP), sse",
  )
  .description("Start run-mcp in background session daemon mode")
  .allowUnknownOption()
  .action(async (sessionName: string, targetCommand: string[], opts: { transport?: string }) => {
    const targetCmd = activeTargetCommand ?? targetCommand;
    if (!targetCmd || targetCmd.length === 0) {
      process.stderr.write("Error: No target command provided for daemon.\n");
      process.exit(64);
    }

    const [command, ...args] = targetCmd;
    const commandLine = [command, ...args].join(" ");
    const transport = opts.transport as "auto" | "http" | "sse" | undefined;
    const spawnTarget = () => new TargetManager(command, args, { transport });

    const server = createServer();
    server.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      const port = (addr as any).port;

      // Mutable: `reconnect` swaps in a fresh instance. A failed reconnect keeps
      // the dead instance around so `stderr` can still show why it died.
      let target = spawnTarget();

      try {
        await target.connect();
      } catch (err: any) {
        process.stderr.write(`Daemon failed to connect to target: ${err.message}\n`);
        process.exit(1);
      }

      // The daemon accepts commands over a loopback TCP socket whose port lives
      // in this session file. Restrict the dir/file to the owner so other local
      // users can't discover the port and drive the target. (Same-user local
      // processes are already inside the trust boundary — they run as you.)
      await mkdir(SESSION_DIR, { recursive: true, mode: 0o700 });
      await writeFile(getSessionPath(sessionName), JSON.stringify({ port, pid: process.pid }), {
        encoding: "utf8",
        mode: 0o600,
      });

      /** Wait briefly for a dying target's stderr, the way the agent server does. */
      const settleStderr = async (t: TargetManager) => {
        for (let waited = 0; waited < 250; waited += 25) {
          if (t.getStderrLines().length > 0) return;
          await new Promise((r) => setTimeout(r, 25));
        }
      };

      /** Restart the target and diff its primitives against the outgoing run. */
      const reconnect = async (): Promise<OperationOutcome> => {
        const previous = await takeSnapshot(target);
        await target.close().catch(() => {});

        const next = spawnTarget();
        target = next;
        try {
          await next.connect();
        } catch (err: any) {
          await settleStderr(next);
          const stderr = next.getStderrLines(40);
          return {
            result: {
              reconnected: false,
              error: `Failed to connect: ${err?.message ?? String(err)}`,
              command: commandLine,
              stderr,
              hint:
                stderr.length > 0
                  ? "The server's stderr above is almost certainly the cause. Fix it and run reconnect again."
                  : "The server produced no stderr before exiting. Check that it runs standalone in a shell.",
            },
            hasError: true,
          };
        }

        const current = await takeSnapshot(next);
        const changes = computeSnapshotDiff(previous, current).filter((line) => line !== "");
        return {
          result: {
            reconnected: true,
            pid: next.getStatus().pid,
            command: commandLine,
            changes,
          },
          hasError: false,
        };
      };

      server.on("connection", (socket) => {
        let buffer = "";
        socket.on("data", async (data) => {
          buffer += data.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const req = JSON.parse(trimmed);
              const reply = (result: unknown) => {
                socket.write(JSON.stringify({ jsonrpc: "2.0", result, id: req.id }) + "\n");
                socket.end();
              };

              if (req.method === "execute") {
                const { operation, opts } = req.params;
                if (operation.type === "reconnect") {
                  reply(await reconnect());
                  continue;
                }
                // Per-call interceptor so --out-dir/--timeout/--media-threshold
                // mean the same thing they do without a session.
                const interceptor = new ResponseInterceptor({
                  outDir: opts.outDir,
                  defaultTimeoutMs: opts.timeoutMs ?? DEFAULT_HEADLESS_TIMEOUT_MS,
                  mediaThresholdKb: opts.mediaThresholdKb,
                });
                if (!target.connected && operation.type !== "stderr") {
                  throw new Error(
                    "The session's target server is not connected (it exited or failed to " +
                      `restart). See why with: run-mcp stderr --session ${sessionName} — ` +
                      `then: run-mcp reconnect --session ${sessionName}`,
                  );
                }
                const stderrStart = target.getStatus().stderrLineCount;
                reply(await executeOperation(target, interceptor, operation, opts, stderrStart));
              } else if (req.method === "validate") {
                const report = await validateProtocol(command, args, undefined, { target });
                reply(report);
              } else if (req.method === "close") {
                reply({ ok: true });
                await target.close().catch(() => {});
                await rm(getSessionPath(sessionName), { force: true }).catch(() => {});
                process.exit(0);
              } else {
                throw new Error(`Unknown daemon method: ${req.method}`);
              }
            } catch (err: any) {
              socket.write(
                JSON.stringify({ jsonrpc: "2.0", error: { message: err.message }, id: 1 }) + "\n",
              );
              socket.end();
            }
          }
        });
      });
    });
  });

// ─── Subcommand: close-session ───────────────────────────────────────────────

program
  .command("close-session")
  .argument("<session_name>", "Session name")
  .description("Stop a running session daemon")
  .action(async (sessionName: string) => {
    const session = await getSession(sessionName);
    if (!session) {
      console.log(`Session "${sessionName}" is not running.`);
      return;
    }

    try {
      await sendDaemonRequest(session.port, {
        jsonrpc: "2.0",
        method: "close",
        params: {},
        id: 1,
      });
      console.log(`Session "${sessionName}" stopped successfully.`);
    } catch {
      try {
        process.kill(session.pid, "SIGTERM");
        console.log(`Session "${sessionName}" stopped (SIGTERM).`);
      } catch {
        console.log(`Failed to stop session "${sessionName}".`);
      }
    }
  });

// ─── Subcommand: validate ────────────────────────────────────────────────────

program
  .command("validate")
  .description("Validate an MCP server command and perform diagnostics")
  .argument("[target_command...]", "Target server command")
  .option("--deep", "Perform deep protocol and schema compliance checks")
  .option("--json", "Format output as JSON")
  .option("--session <name>", "Validate the server already running behind a session")
  .allowUnknownOption()
  .action(
    async (targetCommand: string[], opts: { deep?: boolean; json?: boolean; session?: string }) => {
      const target = activeTargetCommand ?? targetCommand ?? [];
      if (!opts.session && target.length === 0) {
        process.stderr.write("Error: Target server command must be provided.\n");
        process.exit(64);
      }

      /** Run the checks against a fresh spawn, or the session's live target. */
      const runValidation = async (): Promise<ValidationReport> => {
        if (!opts.session) return validateProtocol(target[0], target.slice(1));
        const session = await getSession(opts.session);
        if (!session) {
          process.stderr.write(
            `Error: Session "${opts.session}" is not running. Start it with any headless command, e.g.\n` +
              `  run-mcp list-tools --session ${opts.session} -- <server_command...>\n`,
          );
          process.exit(64);
        }
        return sendDaemonRequest<ValidationReport>(session.port, {
          jsonrpc: "2.0",
          method: "validate",
          params: {},
          id: 1,
        });
      };

      try {
        if (opts.deep) {
          const report = await runValidation();
          if (opts.json) {
            process.stdout.write(JSON.stringify(report, null, 2) + "\n");
          } else {
            console.log(
              `Validation Result: ${report.status === "PASS" ? "\x1b[32mSUCCESS\x1b[0m" : report.status === "WARN" ? "\x1b[33mWARNING\x1b[0m" : "\x1b[31mFAILED\x1b[0m"}\n`,
            );
            for (const check of report.checks) {
              const statusStr =
                check.status === "PASS"
                  ? "\x1b[32mPASS\x1b[0m"
                  : check.status === "WARN"
                    ? "\x1b[33mWARN\x1b[0m"
                    : "\x1b[31mFAIL\x1b[0m";
              console.log(`  [${statusStr}] ${check.name}: ${check.message || ""}`);
            }
          }
          process.exit(report.status === "FAIL" ? 1 : 0);
        } else {
          const report = await runValidation();

          const handshake = report.checks.find((c) => c.name === "handshake_connection");
          const metadata = report.checks.find((c) => c.name === "implementation_metadata");
          const tools = report.checks.find((c) => c.name === "tools_capability");
          const caps = report.checks.find((c) => c.name === "server_capabilities");

          if (report.status === "FAIL") {
            if (opts.json) {
              process.stdout.write(
                JSON.stringify(
                  { success: false, error: handshake?.message || "Validation failed" },
                  null,
                  2,
                ) + "\n",
              );
            } else {
              console.error(`\x1b[31mValidation Result: FAILED\x1b[0m`);
              console.error(`Error: ${handshake?.message || "Unknown error"}`);
            }
            process.exit(1);
          }

          if (opts.json) {
            process.stdout.write(
              JSON.stringify(
                {
                  success: true,
                  serverName: metadata?.message?.match(/"([^"]+)"/)?.[1] || "unknown",
                  capabilities: caps?.message || "none",
                },
                null,
                2,
              ) + "\n",
            );
          } else {
            console.log(`\x1b[32mValidation Result: SUCCESS\x1b[0m`);
            console.log(`  ${metadata?.message || "Implementation metadata OK."}`);
            console.log(`  ${caps?.message || "Capabilities OK."}`);
            console.log(`  ${tools?.message || "Tools OK."}`);
          }
          process.exit(0);
        }
      } catch (err: any) {
        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ success: false, error: err.message }, null, 2) + "\n",
          );
        } else {
          console.error(`\x1b[31mError: ${err.message}\x1b[0m`);
        }
        process.exit(1);
      }
    },
  );

// ─── Default: REPL or Agent Server ───────────────────────────────────────────

program
  .name("run-mcp")
  .description("A smart interactive REPL and live test harness for MCP servers")
  .version(PKG_VERSION)
  .passThroughOptions()
  .allowUnknownOption()
  .argument(
    "[target_command...]",
    "Command to spawn the target MCP server (starts REPL if provided, Agent server otherwise)",
  )
  .option("-o, --out-dir <path>", "Directory to save intercepted images and audio")
  .option(
    "-t, --timeout <ms>",
    "Default tool call timeout in milliseconds (default: 300000) (Agent Mode only)",
  )
  .option(
    "--max-text <chars>",
    "Max text response length before truncation (default: 50000) (Agent Mode only)",
  )
  .option(
    "-m, --media-threshold <kb>",
    "Media size threshold in KB to save to disk (0 to always save, -1 to keep inline)",
  )
  .option("--mcp", "Force start Agent Server mode even if run interactively without arguments")
  .option("-s, --script <file>", "Read commands from a file instead of stdin (REPL Mode only)")
  .option("--color <mode>", "Color output mode: always, never, auto (default: auto)")
  .option(
    "--open-media",
    "Automatically open intercepted images and audio files using the host OS viewer",
  )
  .option(
    "--scan",
    "Scan the current workspace and parent directories for any JSON files containing mcpServers",
  )
  .option(
    "--transport <mode>",
    "Transport for http(s) targets: auto (default), http (Streamable HTTP), sse",
  )
  .option(
    "-w, --watch",
    "Watch the current directory for file changes and auto-reconnect (REPL Mode only)",
  )
  .addHelpText(
    "after",
    `
Examples:
  $ run-mcp                                       # Test harness (agent mode)
  $ run-mcp -- node my-server.js                  # Interactive testing (human REPL mode)
  $ run-mcp -w -- node my-server.js               # Watch mode: auto-reconnect on file changes
  $ run-mcp -s test.txt -- node my-server.js      # Run a script in REPL mode
  $ run-mcp -- npx -y some-mcp-server             # Test an npx server
  $ run-mcp --out-dir ./test-output               # Agent mode with options
  $ run-mcp --out-dir ./screenshots -- node srv.js # REPL mode with options

Headless Commands (one call per invocation, JSON on stdout):
  $ run-mcp call echo '{"text":"hi"}' -- node my-server.js
  $ run-mcp list-tools -- node my-server.js | jq '.[].name'
  $ run-mcp list-resources -- node my-server.js
  $ run-mcp list-prompts -- node my-server.js
  $ run-mcp read docs://readme -- node my-server.js
  $ run-mcp describe echo -- node my-server.js
  $ run-mcp get-prompt greeting '{"name":"Ada"}' -- node my-server.js
  $ run-mcp validate --deep -- node my-server.js
  $ run-mcp stderr -- node my-server.js                # what the server printed at startup
  $ run-mcp call echo text=hi --raw -- node my-server.js   # full result + "stderr" field

Headless Sessions (the loop from a shell — the server stays up between commands):
  $ run-mcp call echo text=hi --session dev -- node my-server.js   # first call spawns it
  $ run-mcp call echo text=again --session dev                     # reused, no cold start
  $ run-mcp stderr --session dev                                   # its stderr so far
  $ run-mcp reconnect --session dev             # after an edit: restart + diff primitives
  $ run-mcp validate --deep --session dev
  $ run-mcp close-session dev

Agent Mode Configuration (mcp.json):
  {
    "mcpServers": {
      "run-mcp": {
        "command": "npx",
        "args": ["-y", "run-mcp"]
      }
    }
  }

Agent Mode Tools:
  connect_to_mcp       → Spawn and connect (use include to get tools/resources/prompts)
  call_mcp_primitive   → Call a tool, read a resource, or get a prompt (auto-connects)
  list_mcp_primitives  → List tools, resources, and/or prompts
  get_server_notifications → Inspect notifications the target emitted (list_changed, updates, logs)
  subscribe_to_resource → Exercise a server's resource-subscription support
  reconnect_to_mcp     → Restart the target after a code edit and diff what changed
  read_result          → Page through an oversized result spilled to disk
  disconnect_from_mcp  → Tear down and reconnect after changes
  mcp_server_status    → Check connection status
  get_mcp_server_stderr → View target server stderr output
  validate_mcp_server  → Validate an MCP server command and collect diagnostics
  list_available_mcp_servers → List local MCP servers found in config files

REPL Mode Commands (once connected):
  tools/list                          List all available tools
  tools/describe <name>               Show a tool's input schema
  tools/call <name> [json] [opts]     Call a tool (interactive if no json)
  tools/scaffold <name>               Generate argument template for a tool
  resources/list                      List all available resources
  resources/read <uri>                Read a resource by URI
  resources/templates                 List resource templates
  resources/subscribe <uri>           Subscribe to resource changes
  resources/unsubscribe <uri>         Unsubscribe from resource changes
  prompts/list                        List all available prompts
  prompts/get <name> [json_args]      Get a prompt with arguments
  ping                                Verify connection, show round-trip time
  log-level <level>                   Set server logging verbosity
  history [count|clear]               Show request/response history
  notifications [count|clear]         Show server notifications
  roots/list                          Show configured client roots
  roots/add <uri> [name]              Add a root directory
  roots/remove <uri>                  Remove a root directory
  !! / last                           Re-run the last command
  reconnect                           Disconnect and reconnect
  timing                              Show tool call performance stats
  status                              Show target server status

Shortcuts: tl td tc ts rl rr rt rs ru pl pg (see help for details)`,
  )
  .action(
    async (
      targetCommand: string[],
      opts: {
        script?: string;
        outDir?: string;
        timeout?: string;
        maxText?: string;
        mediaThreshold?: string;
        mcp?: boolean;
        openMedia?: boolean;
        watch?: boolean;
        scan?: boolean;
        transport?: string;
      },
    ) => {
      const target = activeTargetCommand ?? targetCommand ?? [];

      // If we have a target command, start the REPL mode
      if (target && target.length > 0) {
        await startRepl(target, {
          script: opts.script,
          outDir: opts.outDir,
          mediaThresholdKb: opts.mediaThreshold
            ? Number.parseInt(opts.mediaThreshold, 10)
            : undefined,
          openMedia: opts.openMedia,
          watch: opts.watch,
          transport: opts.transport as any,
        });
      } else {
        // No target command provided
        if (opts.mcp || !process.stdin.isTTY) {
          // Agent server mode
          await startServer({
            outDir: opts.outDir,
            timeoutMs: opts.timeout ? Number.parseInt(opts.timeout, 10) : undefined,
            maxTextLength: opts.maxText ? Number.parseInt(opts.maxText, 10) : undefined,
            mediaThresholdKb: opts.mediaThreshold
              ? Number.parseInt(opts.mediaThreshold, 10)
              : undefined,
            scan: opts.scan,
            transport: opts.transport as any,
          });
        } else {
          // Human is running it in a terminal without arguments -> pick a config
          const selected = await pickDiscoveredServer({ scan: opts.scan });

          if (!selected) {
            // User aborted or no configs found
            console.log("Run 'run-mcp --help' to see manual usage instructions.");
            return;
          }

          await startRepl([selected.config.command, ...(selected.config.args || [])], {
            script: opts.script,
            outDir: opts.outDir,
            mediaThresholdKb: opts.mediaThreshold
              ? Number.parseInt(opts.mediaThreshold, 10)
              : undefined,
            openMedia: opts.openMedia,
            watch: opts.watch,
            transport: opts.transport as any,
            // Config env is threaded into the child, not mutated onto process.env.
            env: selected.config.env,
          });
        }
      }
    },
  );

program.parse(argvToParse);
