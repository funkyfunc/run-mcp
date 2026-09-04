#!/usr/bin/env node

import { program } from "commander";
import { pickDiscoveredServer } from "./config-scanner.js";
import { runHeadless, type HeadlessOperation, type HeadlessOptions } from "./headless.js";
import { parseEnvFlags } from "./parsing.js";
import { startRepl } from "./repl.js";
import { startServer } from "./server.js";
import {
  assertValidSessionName,
  closeSession,
  describeSessionMismatch,
  formatUptime,
  getSession,
  listSessions,
  runSessionDaemon,
  sendDaemonRequest,
  SessionError,
  spawnSessionDaemon,
} from "./session.js";
import type { TransportMode } from "./target-manager.js";
import { validateProtocol, type ValidationReport } from "./validator.js";
import { colors } from "./colors.js";

// ─── Pre-process argv to split target command from run-mcp arguments ─────────

let activeTargetCommand: string[] | undefined;
let argvToParse = process.argv;

const dashDashIndex = process.argv.indexOf("--");
if (dashDashIndex !== -1) {
  activeTargetCommand = process.argv.slice(dashDashIndex + 1);
  argvToParse = [...process.argv.slice(0, dashDashIndex)];
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

function fail(message: string, exitCode: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(exitCode);
}

/** Validate that a target command was provided, or exit with usage help. */
function requireTargetCommand(targetCommand: string[], subcommandUsage: string): string[] {
  const target = activeTargetCommand ?? targetCommand;
  if (!target || target.length === 0) {
    fail(
      "Error: Target server command must be separated by '--'.\n" +
        "This avoids option parsing conflicts.\n\n" +
        `Usage: ${subcommandUsage}`,
      64,
    );
  }
  return target;
}

/** `--env KEY=VAL` values → env map, or exit 64 on a malformed token. */
function parseEnvOption(values: string[] | undefined): Record<string, string> | undefined {
  if (!values || values.length === 0) return undefined;
  try {
    return parseEnvFlags(values);
  } catch (err: any) {
    fail(`Error: ${err.message}`, 64);
  }
}

/** Minutes (fractions allowed) → ms, or exit 64 on garbage. */
function parseIdleTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const minutes = Number.parseFloat(value);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    fail(`Error: --idle-timeout must be a positive number of minutes, got "${value}".`, 64);
  }
  return Math.round(minutes * 60_000);
}

const collect = (value: string, previous?: string[]) => [...(previous ?? []), value];

const ENV_OPTION = [
  "-e, --env <KEY=VALUE>",
  "Environment variable for the target server (repeatable). Only PATH/HOME and a few " +
    "basics are inherited; anything else your server reads must be passed here.",
] as const;

const TRANSPORT_OPTION = [
  "--transport <mode>",
  "Transport for http(s) targets: auto (default), http (Streamable HTTP), sse",
] as const;

// ─── Sessions (client side) ──────────────────────────────────────────────────

interface SessionCallOpts extends HeadlessOptions {
  idleTimeoutMs?: number;
}

async function handleHeadlessSession(
  sessionName: string,
  operation: HeadlessOperation,
  opts: SessionCallOpts,
  subcommandUsage: string,
): Promise<void> {
  assertValidSessionName(sessionName);
  let session = await getSession(sessionName);

  if (session) {
    const mismatch = describeSessionMismatch(sessionName, session, {
      command: activeTargetCommand,
      cwd: process.cwd(),
      env: opts.env,
    });
    if (mismatch) fail(`Error: ${mismatch}`, 64);
  } else {
    if (!activeTargetCommand) {
      fail(
        `Error: Session "${sessionName}" is not running.\n` +
          "Please provide a target command after '--' to start it.\n\n" +
          `Usage: ${subcommandUsage}`,
        64,
      );
    }
    session = await spawnSessionDaemon(sessionName, activeTargetCommand, {
      transport: opts.transport,
      idleTimeoutMs: opts.idleTimeoutMs,
      env: opts.env,
    });
  }

  const response = await sendDaemonRequest(session, "execute", { operation, opts });

  // The daemon holds the target's stderr pipe, so `--show-stderr` can't stream
  // live; it comes back with the response and is replayed here, still on stderr.
  if (response.stderr && response.stderr.length > 0) {
    process.stderr.write(`${response.stderr.join("\n")}\n`);
  }
  process.stdout.write(`${JSON.stringify(response.result, null, 2)}\n`);
  process.exit(response.hasError ? 1 : 0);
}

// ─── Headless subcommand registration ────────────────────────────────────────

program.enablePositionalOptions();

interface HeadlessOpts {
  outDir?: string;
  timeout?: string;
  raw?: boolean;
  showStderr?: boolean;
  mediaThreshold?: string;
  session?: string;
  transport?: string;
  idleTimeout?: string;
  env?: string[];
}

function parseHeadlessOpts(opts: HeadlessOpts): SessionCallOpts {
  return {
    idleTimeoutMs: parseIdleTimeout(opts.idleTimeout),
    outDir: opts.outDir,
    timeoutMs: opts.timeout ? Number.parseInt(opts.timeout, 10) : undefined,
    raw: opts.raw,
    showStderr: opts.showStderr,
    mediaThresholdKb: opts.mediaThreshold ? Number.parseInt(opts.mediaThreshold, 10) : undefined,
    transport: opts.transport as TransportMode | undefined,
    env: parseEnvOption(opts.env),
  };
}

interface HeadlessCommandConfig {
  name: string;
  description: string;
  args: Array<{ name: string; required: boolean; description: string }>;
  extraOptions?: Array<{ flags: string; description: string }>;
  buildOperation: (...positionalArgs: any[]) => HeadlessOperation;
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
    .option(...ENV_OPTION, collect)
    .option("--show-stderr", "Stream target server stderr to process stderr")
    .option(
      "--session <name>",
      "Keep the server running between commands: spawned on the first call, reused after (skips the cold start)",
    )
    .option(
      "--idle-timeout <minutes>",
      "With --session: close the session after this long without a command (default: never)",
    )
    .option(...TRANSPORT_OPTION)
    .allowUnknownOption();

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
      try {
        await handleHeadlessSession(opts.session, operation, parsedOpts, usageStr);
      } catch (err: any) {
        if (err instanceof SessionError) fail(err.message, err.exitCode);
        fail(`Error (session "${opts.session}"): ${err.message}`, 1);
      }
    } else if (operation.type === "reconnect") {
      fail(
        "Error: reconnect restarts the server behind a running session; pass --session <name>.\n" +
          "Without a session every command already starts a fresh server.\n\n" +
          `Usage: ${usageStr}`,
        64,
      );
    } else {
      const target = requireTargetCommand(targetCommand ?? [], usageStr);
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
  buildOperation: (tool: string, jsonArgs?: string) => ({ type: "call", tool, args: jsonArgs }),
  usageHint: "call <tool> [json_args] -- <server_command...>",
});

registerHeadlessCommand({
  name: "list-tools",
  description: "List all tools on a target MCP server as JSON",
  args: [],
  buildOperation: () => ({ type: "list-tools" }),
  usageHint: "list-tools -- <server_command...>",
});

registerHeadlessCommand({
  name: "list-resources",
  description: "List all resources on a target MCP server as JSON",
  args: [],
  buildOperation: () => ({ type: "list-resources" }),
  usageHint: "list-resources -- <server_command...>",
});

registerHeadlessCommand({
  name: "list-prompts",
  description: "List all prompts on a target MCP server as JSON",
  args: [],
  buildOperation: () => ({ type: "list-prompts" }),
  usageHint: "list-prompts -- <server_command...>",
});

registerHeadlessCommand({
  name: "read",
  description: "Read a resource by URI from a target MCP server",
  args: [{ name: "uri", required: true, description: "Resource URI to read" }],
  buildOperation: (uri: string) => ({ type: "read", uri }),
  usageHint: "read <uri> -- <server_command...>",
});

registerHeadlessCommand({
  name: "describe",
  description: "Print a tool's full schema as JSON",
  args: [{ name: "tool", required: true, description: "Tool name to describe" }],
  buildOperation: (tool: string) => ({ type: "describe", tool }),
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
    type: "get-prompt",
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
    type: "stderr",
    count: count ? Number.parseInt(count, 10) : undefined,
  }),
  usageHint: "stderr [count] --session <name>  (or: stderr -- <server_command...>)",
});

registerHeadlessCommand({
  name: "reconnect",
  description:
    "Restart the server behind a session after a code edit and report which tools/resources/prompts changed",
  args: [],
  buildOperation: () => ({ type: "reconnect" }),
  usageHint: "reconnect --session <name>",
});

// ─── Subcommand: daemon ───────────────────────────────────────────────────────

program
  .command("daemon", { hidden: true })
  .argument("<session_name>", "Session name")
  .argument("[target_command...]", "Target server command")
  .option(...TRANSPORT_OPTION)
  .option(...ENV_OPTION, collect)
  .option("--idle-timeout-ms <ms>", "Exit after this long without a request")
  .description("Start run-mcp in background session daemon mode (spawned by --session)")
  .allowUnknownOption()
  .action(
    async (
      sessionName: string,
      targetCommand: string[],
      opts: { transport?: string; idleTimeoutMs?: string; env?: string[] },
    ) => {
      const targetCmd = activeTargetCommand ?? targetCommand;
      if (!targetCmd || targetCmd.length === 0) {
        fail("Error: No target command provided for daemon.", 64);
      }
      await runSessionDaemon(sessionName, targetCmd, {
        transport: opts.transport as TransportMode | undefined,
        idleTimeoutMs: opts.idleTimeoutMs ? Number.parseInt(opts.idleTimeoutMs, 10) : undefined,
        env: parseEnvOption(opts.env),
      });
    },
  );

// ─── Subcommand: sessions ────────────────────────────────────────────────────

program
  .command("sessions")
  .description("List running sessions as JSON: name, pid, command, cwd, uptime, idle timeout")
  .action(async () => {
    const now = Date.now();
    const rows = (await listSessions()).map((s) => ({
      name: s.name,
      pid: s.pid,
      command: s.command.join(" "),
      cwd: s.cwd,
      env_keys: Object.keys(s.env ?? {}),
      started_at: new Date(s.startedAt).toISOString(),
      uptime: formatUptime(now - s.startedAt),
      idle_timeout: s.idleTimeoutMs ? formatUptime(s.idleTimeoutMs) : null,
    }));
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  });

// ─── Subcommand: close-session ───────────────────────────────────────────────

program
  .command("close-session")
  .argument("<session_name>", "Session name")
  .description("Stop a running session daemon")
  .action(async (sessionName: string) => {
    console.log(await closeSession(sessionName));
  });

// ─── Subcommand: validate ────────────────────────────────────────────────────

program
  .command("validate")
  .description("Validate an MCP server command and perform diagnostics")
  .argument("[target_command...]", "Target server command")
  .option("--deep", "Perform deep protocol and schema compliance checks")
  .option("--json", "Format output as JSON")
  .option("--session <name>", "Validate the server already running behind a session")
  .option(...ENV_OPTION, collect)
  .allowUnknownOption()
  .action(
    async (
      targetCommand: string[],
      opts: { deep?: boolean; json?: boolean; session?: string; env?: string[] },
    ) => {
      const target = activeTargetCommand ?? targetCommand ?? [];
      if (!opts.session && target.length === 0) {
        fail("Error: Target server command must be provided.", 64);
      }
      const env = parseEnvOption(opts.env);

      /** Run the checks against a fresh spawn, or the session's live target. */
      const runValidation = async (): Promise<ValidationReport> => {
        if (!opts.session) return validateProtocol(target[0], target.slice(1), env);
        const session = await getSession(opts.session);
        if (!session) {
          fail(
            `Error: Session "${opts.session}" is not running. Start it with any headless command, e.g.\n` +
              `  run-mcp list-tools --session ${opts.session} -- <server_command...>`,
            64,
          );
        }
        return sendDaemonRequest<ValidationReport>(session, "validate");
      };

      const statusLabel = (status: ValidationReport["status"]) =>
        status === "PASS"
          ? colors.green("PASS")
          : status === "WARN"
            ? colors.yellow("WARN")
            : colors.red("FAIL");

      try {
        const report = await runValidation();

        if (opts.deep) {
          if (opts.json) {
            process.stdout.write(JSON.stringify(report, null, 2) + "\n");
          } else {
            const overall =
              report.status === "PASS"
                ? colors.green("SUCCESS")
                : report.status === "WARN"
                  ? colors.yellow("WARNING")
                  : colors.red("FAILED");
            console.log(`Validation Result: ${overall}\n`);
            for (const check of report.checks) {
              console.log(`  [${statusLabel(check.status)}] ${check.name}: ${check.message || ""}`);
            }
          }
          process.exit(report.status === "FAIL" ? 1 : 0);
        }

        // Quick mode: a one-screen summary built from the report's structured fields.
        if (report.status === "FAIL") {
          const handshake = report.checks.find((c) => c.name === "handshake_connection");
          const error = handshake?.message || "Validation failed";
          if (opts.json) {
            process.stdout.write(JSON.stringify({ success: false, error }, null, 2) + "\n");
          } else {
            console.error(colors.red("Validation Result: FAILED"));
            console.error(`Error: ${error}`);
          }
          process.exit(1);
        }

        if (opts.json) {
          process.stdout.write(
            JSON.stringify(
              {
                success: true,
                serverName: report.serverName ?? "unknown",
                serverVersion: report.serverVersion ?? "unknown",
                capabilities: report.capabilities,
                toolCount: report.toolCount,
              },
              null,
              2,
            ) + "\n",
          );
        } else {
          console.log(colors.green("Validation Result: SUCCESS"));
          console.log(
            `  Server: ${report.serverName ?? "unknown"} (version: ${report.serverVersion ?? "unknown"})`,
          );
          console.log(`  Capabilities: ${report.capabilities.join(", ") || "none"}`);
          console.log(`  Tools: ${report.toolCount ?? 0}`);
        }
        process.exit(0);
      } catch (err: any) {
        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ success: false, error: err.message }, null, 2) + "\n",
          );
        } else {
          console.error(colors.red(`Error: ${err.message}`));
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
  .option(...ENV_OPTION, collect)
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
  .option(...TRANSPORT_OPTION)
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
  $ run-mcp --env API_KEY=sk-123 -- node srv.js   # Pass an env var to the server
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
  $ run-mcp call echo text=hi --env API_KEY=sk-123 -- node my-server.js

Headless Sessions (the loop from a shell — the server stays up between commands):
  $ run-mcp call echo text=hi --session dev -- node my-server.js   # first call spawns it
  $ run-mcp call echo text=again --session dev                     # reused, no cold start
  $ run-mcp stderr --session dev                                   # its stderr so far
  $ run-mcp reconnect --session dev             # after an edit: restart + diff primitives
  $ run-mcp validate --deep --session dev
  $ run-mcp sessions                            # what's running, with what command, since when
  $ run-mcp call echo text=hi --session dev --idle-timeout 30 -- node my-server.js   # auto-close after 30 idle minutes
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
        env?: string[];
        mcp?: boolean;
        openMedia?: boolean;
        watch?: boolean;
        scan?: boolean;
        transport?: string;
      },
    ) => {
      const target = activeTargetCommand ?? targetCommand ?? [];
      const cliEnv = parseEnvOption(opts.env);
      const replOptions = {
        script: opts.script,
        outDir: opts.outDir,
        mediaThresholdKb: opts.mediaThreshold
          ? Number.parseInt(opts.mediaThreshold, 10)
          : undefined,
        openMedia: opts.openMedia,
        watch: opts.watch,
        transport: opts.transport as TransportMode | undefined,
      };

      // A target command starts the REPL.
      if (target.length > 0) {
        await startRepl(target, { ...replOptions, env: cliEnv });
        return;
      }

      // No target: an agent (non-TTY stdin, or --mcp) gets the MCP server...
      if (opts.mcp || !process.stdin.isTTY) {
        await startServer({
          outDir: opts.outDir,
          timeoutMs: opts.timeout ? Number.parseInt(opts.timeout, 10) : undefined,
          maxTextLength: opts.maxText ? Number.parseInt(opts.maxText, 10) : undefined,
          mediaThresholdKb: opts.mediaThreshold
            ? Number.parseInt(opts.mediaThreshold, 10)
            : undefined,
          scan: opts.scan,
          transport: opts.transport as TransportMode | undefined,
        });
        return;
      }

      // ...and a human in a terminal gets a picker over their configured servers.
      const selected = await pickDiscoveredServer({ scan: opts.scan });
      if (!selected) {
        console.log("Run 'run-mcp --help' to see manual usage instructions.");
        return;
      }
      await startRepl([selected.config.command, ...(selected.config.args || [])], {
        ...replOptions,
        // The config's env is threaded into the child, not mutated onto
        // process.env; explicit --env values win over it.
        env: selected.config.env || cliEnv ? { ...selected.config.env, ...cliEnv } : undefined,
      });
    },
  );

program.parse(argvToParse);
