#!/usr/bin/env node

import { program } from "commander";
import { createConnection, createServer } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { pickDiscoveredServer } from "./config-scanner.js";
import { runHeadless, executeOperation } from "./headless.js";
import { startRepl } from "./repl.js";
import { startServer } from "./server.js";
import { TargetManager } from "./target-manager.js";
import { ResponseInterceptor } from "./interceptor.js";
import { validateProtocol } from "./validator.js";

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

function sendDaemonRequest(
  port: number,
  request: unknown,
): Promise<{ result: unknown; hasError: boolean }> {
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
          resolve(parsed.result as { result: unknown; hasError: boolean });
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

    // Spawn the daemon process in background
    const binPath = resolve(import.meta.dirname, "./index.js");
    const daemonArgs = ["daemon", sessionName];
    if (opts.sandbox) {
      daemonArgs.push("--sandbox", opts.sandbox);
    }
    daemonArgs.push(...target);
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

    process.stdout.write(`${JSON.stringify(response.result, null, 2)}\n`);
    process.exit(response.hasError ? 1 : 0);
  } catch (err: any) {
    process.stderr.write(`Error communicating with session daemon: ${err.message}\n`);
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
  sandbox?: string;
  allowRead?: string[];
  allowWrite?: string[];
  allowNet?: string[];
  denyRead?: string[];
  denyWrite?: string[];
  denyNet?: string[];
}

function parseHeadlessOpts(opts: HeadlessOpts) {
  return {
    outDir: opts.outDir,
    timeoutMs: opts.timeout ? Number.parseInt(opts.timeout, 10) : undefined,
    raw: opts.raw,
    showStderr: opts.showStderr,
    mediaThresholdKb: opts.mediaThreshold ? Number.parseInt(opts.mediaThreshold, 10) : undefined,
    sandbox: opts.sandbox as "auto" | "docker" | "native" | "audit" | "none" | undefined,
    allowRead: opts.allowRead,
    allowWrite: opts.allowWrite,
    allowNet: opts.allowNet,
    denyRead: opts.denyRead,
    denyWrite: opts.denyWrite,
    denyNet: opts.denyNet,
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
    .option("--session <name>", "Persistent session name")
    .option("--sandbox <mode>", "Sandbox execution mode: auto, docker, native, audit, none", "none")
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
    } else {
      const target = requireTargetCommand(activeTargetCommand ?? targetCommand, usageStr);
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

// ─── Subcommand: daemon ───────────────────────────────────────────────────────

program
  .command("daemon")
  .argument("<session_name>", "Session name")
  .argument("[target_command...]", "Target server command")
  .description("Start run-mcp in background session daemon mode")
  .option("--sandbox <mode>", "Sandbox execution mode: auto, docker, native, audit, none", "none")
  .allowUnknownOption()
  .action(async (sessionName: string, targetCommand: string[], opts: { sandbox?: string }) => {
    const targetCmd = activeTargetCommand ?? targetCommand;
    if (!targetCmd || targetCmd.length === 0) {
      process.stderr.write("Error: No target command provided for daemon.\n");
      process.exit(64);
    }

    const server = createServer();
    server.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      const port = (addr as any).port;

      const target = new TargetManager(targetCmd[0], targetCmd.slice(1), {
        sandbox: opts.sandbox as any,
      });
      const interceptor = new ResponseInterceptor();

      try {
        await target.connect();
      } catch (err: any) {
        process.stderr.write(`Daemon failed to connect to target: ${err.message}\n`);
        process.exit(1);
      }

      await mkdir(SESSION_DIR, { recursive: true });
      await writeFile(
        getSessionPath(sessionName),
        JSON.stringify({ port, pid: process.pid }),
        "utf8",
      );

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
              if (req.method === "execute") {
                const { operation, opts } = req.params;
                const { result, hasError } = await executeOperation(
                  target,
                  interceptor,
                  operation,
                  opts,
                );
                socket.write(
                  JSON.stringify({ jsonrpc: "2.0", result: { result, hasError }, id: req.id }) +
                    "\n",
                );
                socket.end();
              } else if (req.method === "close") {
                socket.write(
                  JSON.stringify({ jsonrpc: "2.0", result: { ok: true }, id: req.id }) + "\n",
                );
                socket.end();
                await target.close().catch(() => {});
                await rm(getSessionPath(sessionName), { force: true }).catch(() => {});
                process.exit(0);
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
  .option("--sandbox <mode>", "Sandbox execution mode: auto, docker, native, audit, none", "none")
  .allowUnknownOption()
  .action(
    async (targetCommand: string[], opts: { deep?: boolean; json?: boolean; sandbox?: string }) => {
      const target = activeTargetCommand ?? targetCommand ?? [];
      if (target.length === 0) {
        process.stderr.write("Error: Target server command must be provided.\n");
        process.exit(64);
      }

      try {
        if (opts.deep) {
          const report = await validateProtocol(target[0], target.slice(1));
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
          const report = await validateProtocol(target[0], target.slice(1));

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
  .option("--sandbox <mode>", "Sandbox execution mode: auto, docker, native, audit, none", "none")
  .option(
    "--scan",
    "Scan the current workspace and parent directories for any JSON files containing mcpServers",
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

Headless Commands (pipe-friendly, JSON output):
  $ run-mcp call echo '{"text":"hi"}' -- node my-server.js
  $ run-mcp list-tools -- node my-server.js | jq '.[].name'
  $ run-mcp list-resources -- node my-server.js
  $ run-mcp list-prompts -- node my-server.js
  $ run-mcp read docs://readme -- node my-server.js
  $ run-mcp describe echo -- node my-server.js
  $ run-mcp get-prompt greeting '{"name":"Ada"}' -- node my-server.js
  $ run-mcp validate --deep -- node my-server.js

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
  disconnect_from_mcp  → Tear down and reconnect after changes
  mcp_server_status    → Check connection status
  get_mcp_server_stderr → View target server stderr output
  validate_mcp_server  → Validate an MCP server command and collect diagnostics
  search_all_local_mcp_servers → Scan and search all local MCP servers for a query

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
        sandbox?: string;
        allowRead?: string[];
        allowWrite?: string[];
        allowNet?: string[];
        denyRead?: string[];
        denyWrite?: string[];
        denyNet?: string[];
        scan?: boolean;
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
          sandbox: opts.sandbox as any,
          allowRead: opts.allowRead,
          allowWrite: opts.allowWrite,
          allowNet: opts.allowNet,
          denyRead: opts.denyRead,
          denyWrite: opts.denyWrite,
          denyNet: opts.denyNet,
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
            sandbox: opts.sandbox as any,
            allowRead: opts.allowRead,
            allowWrite: opts.allowWrite,
            allowNet: opts.allowNet,
            denyRead: opts.denyRead,
            denyWrite: opts.denyWrite,
            denyNet: opts.denyNet,
            scan: opts.scan,
          });
        } else {
          // Human is running it in a terminal without arguments -> pick a config
          const selected = await pickDiscoveredServer({ scan: opts.scan });

          if (!selected) {
            // User aborted or no configs found
            console.log("Run 'run-mcp --help' to see manual usage instructions.");
            return;
          }

          // Environment variables from config
          if (selected.config.env) {
            Object.assign(process.env, selected.config.env);
          }

          await startRepl([selected.config.command, ...(selected.config.args || [])], {
            script: opts.script,
            outDir: opts.outDir,
            mediaThresholdKb: opts.mediaThreshold
              ? Number.parseInt(opts.mediaThreshold, 10)
              : undefined,
            openMedia: opts.openMedia,
            watch: opts.watch,
            sandbox: opts.sandbox as any,
            allowRead: opts.allowRead,
            allowWrite: opts.allowWrite,
            allowNet: opts.allowNet,
            denyRead: opts.denyRead,
            denyWrite: opts.denyWrite,
            denyNet: opts.denyNet,
          });
        }
      }
    },
  );

// Dynamically add allow/deny options to all commands that support --sandbox
for (const cmd of [program, ...program.commands]) {
  if (cmd.options.some((o: any) => o.long === "--sandbox")) {
    cmd
      .option("--allow-read <paths...>", "Paths to allow reading under the sandbox")
      .option("--allow-write <paths...>", "Paths to allow writing under the sandbox")
      .option(
        "--allow-net <domains...>",
        "Network domains to allow connecting to under the sandbox",
      )
      .option("--deny-read <paths...>", "Paths to deny reading under the sandbox")
      .option("--deny-write <paths...>", "Paths to deny writing under the sandbox")
      .option("--deny-net <domains...>", "Network domains to deny connecting to under the sandbox");
  }
}

program.parse(argvToParse);
