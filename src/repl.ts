import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import pc from "picocolors";
import { ResponseInterceptor } from "./interceptor.js";
import {
  formatJson,
  parseCallArgs,
  parseCommandLine,
  scaffoldArgs,
  suggestCommand,
} from "./parsing.js";
import { TargetManager } from "./target-manager.js";

/** All known REPL commands for typo suggestion and tab completion. */
const KNOWN_COMMANDS = [
  "tools/list",
  "tools/describe",
  "tools/call",
  "tools/scaffold",
  "resources/list",
  "resources/read",
  "resources/templates",
  "prompts/list",
  "prompts/get",
  "timing",
  "status",
  "reconnect",
  "!!",
  "last",
  "help",
  "exit",
  "quit",
];

interface ReplOptions {
  script?: string;
  outDir?: string;
}

// ─── Tab completion caches ────────────────────────────────────────────────────

let cachedToolNames: string[] = [];
let cachedResourceUris: string[] = [];
let cachedPromptNames: string[] = [];

async function refreshCaches(target: TargetManager): Promise<void> {
  const caps = target.getServerCapabilities() ?? {};

  try {
    const { tools } = await target.listTools();
    cachedToolNames = tools.map((t) => t.name);
  } catch {
    /* ignore */
  }

  if (caps.resources) {
    try {
      const { resources } = await target.listResources();
      cachedResourceUris = resources.map((r: any) => r.uri);
    } catch {
      /* ignore */
    }
  }

  if (caps.prompts) {
    try {
      const { prompts } = await target.listPrompts();
      cachedPromptNames = prompts.map((p) => p.name);
    } catch {
      /* ignore */
    }
  }
}

const completer = (line: string): [string[], string] => {
  // Tool-name completion for tools/call, tools/describe, tools/scaffold
  for (const prefix of ["tools/call ", "tools/describe ", "tools/scaffold "]) {
    if (line.startsWith(prefix)) {
      const partial = line.slice(prefix.length).split(" ")[0];
      const matches = cachedToolNames.filter((n) => n.startsWith(partial));
      return [matches.map((m) => `${prefix}${m}`), line];
    }
  }

  // Resource URI completion for resources/read
  if (line.startsWith("resources/read ")) {
    const partial = line.slice("resources/read ".length);
    const matches = cachedResourceUris.filter((u) => u.startsWith(partial));
    return [matches.map((m) => `resources/read ${m}`), line];
  }

  // Prompt name completion for prompts/get
  if (line.startsWith("prompts/get ")) {
    const partial = line.slice("prompts/get ".length).split(" ")[0];
    const matches = cachedPromptNames.filter((n) => n.startsWith(partial));
    return [matches.map((m) => `prompts/get ${m}`), line];
  }

  // Command-level completion
  const matches = KNOWN_COMMANDS.filter((c) => c.startsWith(line));
  return [matches, line];
};

// ─── Performance tracking ─────────────────────────────────────────────────────

interface CallRecord {
  toolName: string;
  durationMs: number;
  timestamp: number;
}

const callHistory: CallRecord[] = [];

// ─── Last command tracking ────────────────────────────────────────────────────

let lastCommand: string | null = null;

// ─── Prompt helpers ───────────────────────────────────────────────────────────

function getPrompt(target: TargetManager): string {
  if (target.connected) return `${pc.green("✓")}${pc.cyan("> ")}`;
  return `${pc.red("✗")}${pc.cyan("> ")}`;
}

/**
 * Starts the interactive REPL (or script-driven) mode.
 *
 * Auto-connects to the target MCP server, then accepts shorthand commands
 * like `tools/list`, `tools/call <name> <json>`, `tools/describe <name>`, etc.
 */
export async function startRepl(targetCommand: string[], opts: ReplOptions): Promise<void> {
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

    target.on(
      "reconnecting",
      ({ attempt, maxAttempts }: { attempt: number; maxAttempts: number }) => {
        console.log(
          pc.yellow(`\n⟳ Server disconnected. Reconnecting (${attempt}/${maxAttempts})...`),
        );
      },
    );

    target.on("reconnected", async ({ attempt }: { attempt: number }) => {
      const s = target.getStatus();
      console.log(pc.green(`✓ Reconnected (PID: ${s.pid}, attempt ${attempt})`));
      await refreshCaches(target);
    });

    target.on("reconnect_failed", ({ reason, message }: { reason: string; message: string }) => {
      console.error(pc.red(`✗ ${message}`));
      if (reason === "max_retries") {
        console.log(
          pc.dim("  Use 'exit' to quit or wait for the server to be fixed and restart manually."),
        );
      }
    });
  }

  // List tools and show startup summary
  try {
    const { tools } = await target.listTools();
    const parts = [`${tools.length} tool(s)`];

    const caps = target.getServerCapabilities() ?? {};

    if (caps.resources) {
      try {
        const { resources } = await target.listResources();
        parts.push(`${resources.length} resource(s)`);
      } catch {
        /* ignore */
      }
    }

    if (caps.prompts) {
      try {
        const { prompts } = await target.listPrompts();
        parts.push(`${prompts.length} prompt(s)`);
      } catch {
        /* ignore */
      }
    }

    console.log(
      pc.cyan(`  ${parts.join(", ")} available. Type ${pc.bold("help")} for commands.\n`),
    );
  } catch (err: any) {
    console.log(pc.yellow(`  Warning: Could not list tools: ${err.message}\n`));
  }

  // Populate tab completion caches
  await refreshCaches(target);

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
    // Interactive mode: readline prompt with tab completion
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: getPrompt(target),
      terminal: true,
      completer,
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
        rl.setPrompt(getPrompt(target));
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

  // Track last command for !! / last (but don't record !! itself)
  if (cmd !== "!!" && cmd !== "last") {
    lastCommand = input;
  }

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

    case "tools/scaffold":
      await cmdToolsScaffold(target, rest);
      return;

    case "resources/list":
      await cmdResourcesList(target);
      return;

    case "resources/read":
      await cmdResourcesRead(target, rest);
      return;

    case "resources/templates":
      await cmdResourcesTemplates(target);
      return;

    case "prompts/list":
      await cmdPromptsList(target);
      return;

    case "prompts/get":
      await cmdPromptsGet(target, rest);
      return;

    case "timing":
      cmdTiming();
      return;

    case "reconnect":
      await cmdReconnect(target);
      return;

    case "!!":
    case "last":
      if (lastCommand) {
        console.log(pc.dim(`  Re-running: ${lastCommand}`));
        await handleCommand(lastCommand, target, interceptor);
      } else {
        console.log(pc.yellow("No previous command to re-run."));
      }
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

  console.log(pc.bold(`  ${"Name".padEnd(nameWidth)}  Description`));
  console.log(pc.dim(`  ${"─".repeat(nameWidth)}  ${"─".repeat(50)}`));

  for (const tool of tools) {
    const desc = tool.description
      ? tool.description.length > 60
        ? `${tool.description.slice(0, 57)}...`
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

  // Track for timing command
  callHistory.push({ toolName, durationMs: elapsed, timestamp: startTime });

  // Print result content — colorize errors
  const isError = (result as any).isError === true;
  const content = (result as any).content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === "text") {
        console.log(isError ? pc.red(`✗ ${item.text}`) : item.text);
      } else {
        console.log(formatJson(item, 2));
      }
    }
  } else {
    console.log(formatJson(result, 2));
  }

  console.log(pc.dim(`  (${elapsed}ms)`));
}

async function cmdToolsScaffold(target: TargetManager, rest: string): Promise<void> {
  const name = rest.trim();
  if (!name) {
    console.log(pc.yellow("Usage: tools/scaffold <tool_name>"));
    return;
  }

  const { tools } = await target.listTools();
  const tool = tools.find((t) => t.name === name);

  if (!tool) {
    console.log(pc.red(`Tool "${name}" not found.`));
    const suggestion = suggestCommand(
      name,
      tools.map((t) => t.name),
    );
    if (suggestion) {
      console.log(pc.yellow(`Did you mean ${pc.bold(suggestion)}?`));
    } else {
      console.log(pc.dim(`Available: ${tools.map((t) => t.name).join(", ")}`));
    }
    return;
  }

  const scaffolded = scaffoldArgs(tool.inputSchema as Record<string, unknown>);
  console.log(pc.cyan("\n  Ready-to-paste command:"));
  console.log(`  tools/call ${name} ${scaffolded}\n`);
}

// ─── Resources ──────────────────────────────────────────────────────────────

async function cmdResourcesList(target: TargetManager): Promise<void> {
  const { resources } = await target.listResources();

  if (resources.length === 0) {
    console.log(pc.dim("  No resources available."));
    return;
  }

  const uriWidth = Math.max(6, ...resources.map((r: any) => (r.uri as string).length));

  console.log(pc.bold(`  ${"URI".padEnd(uriWidth)}  Name`));
  console.log(pc.dim(`  ${"─".repeat(uriWidth)}  ${"─".repeat(40)}`));

  for (const r of resources) {
    const uri = (r as any).uri as string;
    const name = (r as any).name ?? pc.dim("(unnamed)");
    console.log(`  ${pc.green(uri.padEnd(uriWidth))}  ${name}`);
  }

  console.log(pc.dim(`\n  ${resources.length} resource(s) total.`));
}

async function cmdResourcesRead(target: TargetManager, rest: string): Promise<void> {
  const uri = rest.trim();
  if (!uri) {
    console.log(pc.yellow("Usage: resources/read <uri>"));
    return;
  }

  const result = await target.readResource({ uri });

  for (const item of result.contents) {
    if ((item as any).text !== undefined) {
      console.log((item as any).text);
    } else if ((item as any).blob !== undefined) {
      const mimeType = (item as any).mimeType ?? "application/octet-stream";
      const sizeBytes = Buffer.from((item as any).blob, "base64").length;
      console.log(pc.dim(`[Binary: ${mimeType}, ${sizeBytes} bytes]`));
    } else {
      console.log(formatJson(item, 2));
    }
  }
}

async function cmdResourcesTemplates(target: TargetManager): Promise<void> {
  const { resourceTemplates } = await target.listResourceTemplates();

  if (resourceTemplates.length === 0) {
    console.log(pc.dim("  No resource templates available."));
    return;
  }

  const uriWidth = Math.max(
    12,
    ...resourceTemplates.map((t: any) => (t.uriTemplate as string).length),
  );

  console.log(pc.bold(`  ${"URI Template".padEnd(uriWidth)}  Name`));
  console.log(pc.dim(`  ${"─".repeat(uriWidth)}  ${"─".repeat(40)}`));

  for (const t of resourceTemplates) {
    const uriTemplate = (t as any).uriTemplate as string;
    const name = (t as any).name ?? pc.dim("(unnamed)");
    console.log(`  ${pc.green(uriTemplate.padEnd(uriWidth))}  ${name}`);
  }

  console.log(pc.dim(`\n  ${resourceTemplates.length} template(s) total.`));
}

// ─── Prompts ────────────────────────────────────────────────────────────────

async function cmdPromptsList(target: TargetManager): Promise<void> {
  const { prompts } = await target.listPrompts();

  if (prompts.length === 0) {
    console.log(pc.dim("  No prompts available."));
    return;
  }

  const nameWidth = Math.max(8, ...prompts.map((p) => p.name.length));

  console.log(pc.bold(`  ${"Name".padEnd(nameWidth)}  Description`));
  console.log(pc.dim(`  ${"─".repeat(nameWidth)}  ${"─".repeat(50)}`));

  for (const p of prompts) {
    const desc = p.description
      ? p.description.length > 60
        ? `${p.description.slice(0, 57)}...`
        : p.description
      : pc.dim("(no description)");
    console.log(`  ${pc.green(p.name.padEnd(nameWidth))}  ${desc}`);
  }

  console.log(pc.dim(`\n  ${prompts.length} prompt(s) total.`));
}

async function cmdPromptsGet(target: TargetManager, rest: string): Promise<void> {
  const { toolName: promptName, jsonArgs } = parseCallArgs(rest);

  if (!promptName) {
    console.log(pc.yellow("Usage: prompts/get <prompt_name> [json_args]"));
    return;
  }

  let promptArgs: Record<string, string> = {};
  if (jsonArgs) {
    try {
      promptArgs = JSON.parse(jsonArgs);
    } catch (err: any) {
      console.error(pc.red(`Invalid JSON: ${err.message}`));
      console.log(pc.dim(`  Received: ${jsonArgs}`));
      return;
    }
  }

  const result = await target.getPrompt({ name: promptName, arguments: promptArgs });

  for (const msg of result.messages) {
    const role = msg.role === "user" ? pc.blue("user") : pc.magenta("assistant");
    const text = (msg.content as any).text ?? JSON.stringify(msg.content);
    console.log(`  ${pc.bold(role)}: ${text}`);
  }
}

// ─── Reconnect ──────────────────────────────────────────────────────────────

async function cmdReconnect(target: TargetManager): Promise<void> {
  console.log(pc.cyan("⟳ Disconnecting..."));
  await target.close();
  await new Promise((resolve) => setTimeout(resolve, 200));

  console.log(pc.cyan("⟳ Reconnecting..."));
  const { command, args } = target.getStatus();
  console.log(pc.dim(`  Command: ${command} ${args.join(" ")}`));

  try {
    await target.connect();
    const s = target.getStatus();
    console.log(pc.green(`✓ Reconnected (PID: ${s.pid})`));

    const { tools } = await target.listTools();
    console.log(pc.cyan(`  ${tools.length} tool(s) available.\n`));

    await refreshCaches(target);
  } catch (err: any) {
    console.error(pc.red(`✗ Failed to reconnect: ${err.message}`));
  }
}

// ─── Timing ─────────────────────────────────────────────────────────────────

function cmdTiming(): void {
  if (callHistory.length === 0) {
    console.log(pc.dim("  No tool calls recorded yet."));
    return;
  }

  // Group by tool name
  const groups = new Map<string, number[]>();
  for (const record of callHistory) {
    const list = groups.get(record.toolName) ?? [];
    list.push(record.durationMs);
    groups.set(record.toolName, list);
  }

  const nameWidth = Math.max(8, ...[...groups.keys()].map((n) => n.length));

  console.log(pc.bold("\n  Tool Call Performance"));
  console.log(pc.dim(`  ${"─".repeat(nameWidth + 50)}`));

  let totalCalls = 0;
  let totalMs = 0;
  let slowestName = "";
  let slowestMs = 0;

  for (const [name, durations] of groups) {
    const count = durations.length;
    totalCalls += count;

    const sorted = [...durations].sort((a, b) => a - b);
    const avg = Math.round(sorted.reduce((a, b) => a + b, 0) / count);
    const p95 = sorted[Math.floor(count * 0.95)];
    const max = sorted[sorted.length - 1];

    totalMs += sorted.reduce((a, b) => a + b, 0);
    if (max > slowestMs) {
      slowestMs = max;
      slowestName = name;
    }

    console.log(
      `  ${pc.green(name.padEnd(nameWidth))}  × ${count}  avg: ${avg}ms    p95: ${p95}ms    max: ${max}ms`,
    );
  }

  const overallAvg = Math.round(totalMs / totalCalls);
  console.log(
    pc.dim(
      `\n  Total: ${totalCalls} call(s), avg ${overallAvg}ms, slowest: ${slowestName} (${slowestMs}ms)`,
    ),
  );
  console.log();
}

// ─── Status ─────────────────────────────────────────────────────────────────

function cmdStatus(target: TargetManager): void {
  const s = target.getStatus();

  const uptimeStr =
    s.uptime >= 60
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

// ─── Help ───────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
${pc.bold("Tool Commands:")}

  ${pc.green("tools/list")}                         List all available tools
  ${pc.green("tools/describe")} <name>              Show a tool's input schema
  ${pc.green("tools/call")} <name> <json> [opts]    Call a tool with JSON arguments
    Options: ${pc.dim("--timeout <ms>")}            Override default timeout (60s)
  ${pc.green("tools/scaffold")} <name>              Generate a template for a tool's arguments

${pc.bold("Resource Commands:")}

  ${pc.green("resources/list")}                     List all available resources
  ${pc.green("resources/read")} <uri>               Read a resource by URI
  ${pc.green("resources/templates")}                List resource templates

${pc.bold("Prompt Commands:")}

  ${pc.green("prompts/list")}                       List all available prompts
  ${pc.green("prompts/get")} <name> [json_args]    Get a prompt with arguments

${pc.bold("Session Commands:")}

  ${pc.green("!!")} / ${pc.green("last")}                           Re-run the last command
  ${pc.green("reconnect")}                          Disconnect and reconnect to the server
  ${pc.green("timing")}                             Show tool call performance stats
  ${pc.green("status")}                             Show target server status
  ${pc.green("help")}                               Show this help
  ${pc.green("exit")} / ${pc.green("quit")}                         Disconnect and exit

${pc.dim("Lines starting with # are treated as comments.")}
${pc.dim('JSON arguments can contain spaces: tools/call say {"message": "hello world"}')}
`);
}

/**
 * Read all lines from a script file.
 */
async function readScriptLines(filepath: string): Promise<string[]> {
  const content = await readFile(filepath, "utf-8");
  return content.split("\n");
}
