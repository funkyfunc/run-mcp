import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import pc from "picocolors";
import { TargetManager } from "./target-manager.js";
import { ResponseInterceptor } from "./interceptor.js";
import { parseCommandLine, parseCallArgs, formatJson, suggestCommand } from "./parsing.js";

/** All known REPL commands for typo suggestion. */
const KNOWN_COMMANDS = [
  "tools/list", "tools/describe", "tools/call",
  "status", "help", "exit", "quit",
];

interface ReplOptions {
  script?: string;
  outDir?: string;
}

/**
 * Starts the interactive REPL (or script-driven) mode.
 *
 * Auto-connects to the target MCP server, then accepts shorthand commands
 * like `tools/list`, `tools/call <name> <json>`, `tools/describe <name>`, etc.
 */
export async function startRepl(
  targetCommand: string[],
  opts: ReplOptions,
): Promise<void> {
  const [command, ...args] = targetCommand;
  const target = new TargetManager(command, args);
  const interceptor = new ResponseInterceptor({ outDir: opts.outDir });

  // Stream server stderr to console in dim text
  target.on("stderr", (text: string) => {
    for (const line of text.split("\n")) {
      console.error(pc.dim(`[server] ${line}`));
    }
  });

  // Connect to target
  console.log(pc.cyan("⟳ Connecting to target MCP server..."));
  console.log(pc.dim(`  Command: ${targetCommand.join(" ")}`));

  try {
    await target.connect();
  } catch (err: any) {
    const msg = err.message ?? String(err);
    if (msg.includes("ENOENT") || msg.includes("spawn")) {
      console.error(pc.red(`✗ Failed to start server: command "${command}" not found.`));
      console.error(pc.dim(`  Check that "${command}" is installed and in your PATH.`));
    } else {
      console.error(pc.red(`✗ Failed to connect: ${msg}`));
      console.error(pc.dim(`  Check that the target command starts a valid MCP server on stdio.`));
    }
    process.exit(1);
  }

  const status = target.getStatus();
  console.log(pc.green(`✓ Connected (PID: ${status.pid})`));

  // Enable auto-reconnect for interactive mode (not script mode)
  if (!opts.script) {
    target.enableAutoReconnect();

    target.on("reconnecting", ({ attempt, maxAttempts }: { attempt: number; maxAttempts: number }) => {
      console.log(pc.yellow(`\n⟳ Server disconnected. Reconnecting (${attempt}/${maxAttempts})...`));
    });

    target.on("reconnected", ({ attempt }: { attempt: number }) => {
      const s = target.getStatus();
      console.log(pc.green(`✓ Reconnected (PID: ${s.pid}, attempt ${attempt})`));
    });

    target.on("reconnect_failed", ({ reason, message }: { reason: string; message: string }) => {
      console.error(pc.red(`✗ ${message}`));
      if (reason === "max_retries") {
        console.log(pc.dim("  Use 'exit' to quit or wait for the server to be fixed and restart manually."));
      }
    });
  }

  // List tools on startup
  try {
    const { tools } = await target.listTools();
    console.log(pc.cyan(`  ${tools.length} tool(s) available. Type ${pc.bold("help")} for commands.\n`));
  } catch (err: any) {
    console.log(pc.yellow(`  Warning: Could not list tools: ${err.message}\n`));
  }

  const isScript = !!opts.script;

  if (isScript) {
    // Script mode: read all lines, then execute sequentially
    const lines = await readScriptLines(opts.script!);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      try {
        await handleCommand(trimmed, target, interceptor);
      } catch (err: any) {
        console.error(pc.red(`✗ Error: ${err.message}`));
        console.log(pc.dim("\nShutting down..."));
        await target.close();
        process.exit(1);
      }
    }

    console.log(pc.dim("\nShutting down..."));
    await target.close();
    process.exit(0);
  } else {
    // Interactive mode: readline prompt
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: pc.cyan("> "),
      terminal: true,
    });
    rl.prompt();

    // Queue commands to prevent interleaving
    let processing = false;
    const queue: string[] = [];

    const processQueue = async () => {
      if (processing) return;
      processing = true;

      while (queue.length > 0) {
        const trimmed = queue.shift()!;
        try {
          await handleCommand(trimmed, target, interceptor);
        } catch (err: any) {
          console.error(pc.red(`✗ Error: ${err.message}`));
        }
        rl.prompt();
      }

      processing = false;
    };

    rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        rl.prompt();
        return;
      }
      queue.push(trimmed);
      processQueue();
    });

    rl.on("close", async () => {
      console.log(pc.dim("\nShutting down..."));
      await target.close();
      process.exit(0);
    });
  }
}

/**
 * Dispatch a single REPL command string.
 */
async function handleCommand(
  input: string,
  target: TargetManager,
  interceptor: ResponseInterceptor,
): Promise<void> {
  // Parse the command and arguments
  const { cmd, rest } = parseCommandLine(input);

  switch (cmd) {
    case "help":
      printHelp();
      return;

    case "tools/list":
      await cmdToolsList(target);
      return;

    case "tools/describe":
      await cmdToolsDescribe(target, rest);
      return;

    case "tools/call":
      await cmdToolsCall(target, interceptor, rest);
      return;

    case "status":
      cmdStatus(target);
      return;

    case "exit":
    case "quit":
      process.emit("SIGINT", "SIGINT");
      return;

    default: {
      // Suggest the closest known command if it's a likely typo
      const suggestion = suggestCommand(cmd, KNOWN_COMMANDS);
      if (suggestion) {
        console.log(pc.yellow(`Unknown command: ${cmd}. Did you mean ${pc.bold(suggestion)}?`));
      } else {
        console.log(pc.yellow(`Unknown command: ${cmd}. Type ${pc.bold("help")} for usage.`));
      }
    }
  }
}

// ─── Command Implementations ────────────────────────────────────────────────

async function cmdToolsList(target: TargetManager): Promise<void> {
  const { tools } = await target.listTools();

  if (tools.length === 0) {
    console.log(pc.dim("  No tools available."));
    return;
  }

  // Print as a formatted table
  const nameWidth = Math.max(8, ...tools.map((t) => t.name.length));

  console.log(
    pc.bold(
      `  ${"Name".padEnd(nameWidth)}  Description`,
    ),
  );
  console.log(pc.dim(`  ${"─".repeat(nameWidth)}  ${"─".repeat(50)}`));

  for (const tool of tools) {
    const desc = tool.description
      ? tool.description.length > 60
        ? tool.description.slice(0, 57) + "..."
        : tool.description
      : pc.dim("(no description)");
    console.log(`  ${pc.green(tool.name.padEnd(nameWidth))}  ${desc}`);
  }

  console.log(pc.dim(`\n  ${tools.length} tool(s) total.`));
}

async function cmdToolsDescribe(target: TargetManager, rest: string): Promise<void> {
  const name = rest.trim();
  if (!name) {
    console.log(pc.yellow("Usage: tools/describe <tool_name>"));
    return;
  }

  const { tools } = await target.listTools();
  const tool = tools.find((t) => t.name === name);

  if (!tool) {
    console.log(pc.red(`Tool "${name}" not found.`));
    console.log(pc.dim(`Available: ${tools.map((t) => t.name).join(", ")}`));
    return;
  }

  console.log(pc.bold(`\n  ${tool.name}`));
  if (tool.description) {
    console.log(pc.dim(`  ${tool.description}`));
  }
  console.log(pc.cyan("\n  Input Schema:"));
  console.log(formatJson(tool.inputSchema, 4));
}

async function cmdToolsCall(
  target: TargetManager,
  interceptor: ResponseInterceptor,
  rest: string,
): Promise<void> {
  // Parse: <name> <json_args> [--timeout <ms>]
  const { toolName, jsonArgs, timeoutMs } = parseCallArgs(rest);

  if (!toolName) {
    console.log(pc.yellow("Usage: tools/call <tool_name> [json_args] [--timeout <ms>]"));
    return;
  }

  let args: Record<string, unknown> = {};
  if (jsonArgs) {
    try {
      args = JSON.parse(jsonArgs);
    } catch (err: any) {
      console.error(pc.red(`Invalid JSON: ${err.message}`));
      console.log(pc.dim(`  Received: ${jsonArgs}`));
      return;
    }
  }

  console.log(pc.dim(`  Calling ${toolName}...`));
  const startTime = Date.now();

  const result = await interceptor.callTool(target, toolName, args, timeoutMs);

  const elapsed = Date.now() - startTime;

  // Print result content
  const content = (result as any).content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === "text") {
        console.log(item.text);
      } else {
        console.log(formatJson(item, 2));
      }
    }
  } else {
    console.log(formatJson(result, 2));
  }

  console.log(pc.dim(`  (${elapsed}ms)`));
}

function cmdStatus(target: TargetManager): void {
  const s = target.getStatus();

  const uptimeStr = s.uptime >= 60
    ? `${Math.floor(s.uptime / 60)}m ${(s.uptime % 60).toFixed(0)}s`
    : `${s.uptime.toFixed(1)}s`;

  const lastRespStr = s.lastResponseTime
    ? `${((Date.now() - s.lastResponseTime) / 1000).toFixed(1)}s ago`
    : "never";

  console.log(pc.bold("\n  Target Server Status"));
  console.log(`  ${pc.dim("Connected:")}      ${s.connected ? pc.green("yes") : pc.red("no")}`);
  console.log(`  ${pc.dim("PID:")}            ${s.pid ?? "N/A"}`);
  console.log(`  ${pc.dim("Uptime:")}         ${uptimeStr}`);
  console.log(`  ${pc.dim("Last response:")}  ${lastRespStr}`);
  console.log(`  ${pc.dim("Stderr lines:")}   ${s.stderrLineCount.toLocaleString()}`);
  console.log(`  ${pc.dim("Reconnects:")}     ${s.reconnectAttempts}/${s.maxReconnectAttempts}`);
  console.log(`  ${pc.dim("Command:")}        ${s.command} ${s.args.join(" ")}`);
  console.log();
}

function printHelp(): void {
  console.log(`
${pc.bold("Available Commands:")}

  ${pc.green("tools/list")}                         List all available tools
  ${pc.green("tools/describe")} <name>              Show a tool's input schema
  ${pc.green("tools/call")} <name> <json> [opts]    Call a tool with JSON arguments
    Options: ${pc.dim("--timeout <ms>")}            Override default timeout (60s)
  ${pc.green("status")}                             Show target server status
  ${pc.green("help")}                               Show this help
  ${pc.green("exit")} / ${pc.green("quit")}                         Disconnect and exit

${pc.dim("Lines starting with # are treated as comments.")}
${pc.dim("JSON arguments can contain spaces: tools/call say {\"message\": \"hello world\"}")}
`);
}

/**
 * Read all lines from a script file.
 */
async function readScriptLines(filepath: string): Promise<string[]> {
  const content = await readFile(filepath, "utf-8");
  return content.split("\n");
}
