import { readFile } from "node:fs/promises";
import type { Interface as ReadlineInterface } from "node:readline";
import { createInterface } from "node:readline";
import { search, input, confirm, select } from "@inquirer/prompts";
import pc from "picocolors";
import { ResponseInterceptor } from "./interceptor.js";
import {
  formatJson,
  formatToolDescription,
  groupToolsByPrefix,
  LOG_LEVELS,
  parseCallArgs,
  parseCommandLine,
  resolveAlias,
  scaffoldArgs,
  suggestCommand,
} from "./parsing.js";
import type { ServerNotification } from "./target-manager.js";
import { TargetManager } from "./target-manager.js";

/** All known REPL commands for typo suggestion and tab completion. */
const KNOWN_COMMANDS = [
  "explore",
  "interactive",
  "tools/list",
  "tools/describe",
  "tools/call",
  "tools/scaffold",
  "resources/list",
  "resources/read",
  "resources/templates",
  "resources/subscribe",
  "resources/unsubscribe",
  "prompts/list",
  "prompts/get",
  "ping",
  "log-level",
  "history",
  "notifications",
  "roots/list",
  "roots/add",
  "roots/remove",
  "timing",
  "status",
  "reconnect",
  "!!",
  "last",
  "help",
  "exit",
  "quit",
  // Short aliases
  "tl",
  "td",
  "tc",
  "ts",
  "rl",
  "rr",
  "rt",
  "rs",
  "ru",
  "pl",
  "pg",
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

// ─── Tab cycling state ────────────────────────────────────────────────────────

interface TabCycleState {
  matches: string[];
  index: number;
  original: string;
}

let tabCycleState: TabCycleState | null = null;

function resetTabCycle(): void {
  tabCycleState = null;
}

/**
 * Compute raw completion matches for a given line.
 * Extracted so the completer can call it without side effects.
 */
function computeMatches(line: string): [string[], string] {
  // Expand alias before attempting completion
  const expanded = resolveAlias(line);
  const effective = expanded ?? line;

  // Tool-name completion for tools/call, tools/describe, tools/scaffold
  for (const prefix of ["tools/call ", "tools/describe ", "tools/scaffold "]) {
    if (effective.startsWith(prefix)) {
      const partial = effective.slice(prefix.length).split(" ")[0];
      const matches = cachedToolNames.filter((n) => n.startsWith(partial));
      return [matches.map((m) => `${prefix}${m}`), effective];
    }
  }

  // Resource URI completion for resources/read
  if (effective.startsWith("resources/read ")) {
    const partial = effective.slice("resources/read ".length);
    const matches = cachedResourceUris.filter((u) => u.startsWith(partial));
    return [matches.map((m) => `resources/read ${m}`), effective];
  }

  // Prompt name completion for prompts/get
  if (effective.startsWith("prompts/get ")) {
    const partial = effective.slice("prompts/get ".length).split(" ")[0];
    const matches = cachedPromptNames.filter((n) => n.startsWith(partial));
    return [matches.map((m) => `prompts/get ${m}`), effective];
  }

  // Command-level completion
  const matches = KNOWN_COMMANDS.filter((c) => c.startsWith(line));
  return [matches, line];
}

/**
 * Readline completer with menu-complete style tab cycling.
 *
 * First tab: shows all matches (default readline behavior).
 * Subsequent tabs: cycles through matches one by one, replacing the line.
 */
const completer = (line: string): [string[], string] => {
  // If we're in a tab-cycling session, cycle to the next match
  if (tabCycleState) {
    const inCycle = line === tabCycleState.original || tabCycleState.matches.includes(line);

    if (inCycle) {
      tabCycleState.index = (tabCycleState.index + 1) % tabCycleState.matches.length;
      const next = tabCycleState.matches[tabCycleState.index];

      // Replace the line content after readline finishes processing
      setImmediate(() => {
        if (activeRl) {
          (activeRl as any).line = next;
          (activeRl as any).cursor = next.length;
          (activeRl as any)._refreshLine();
        }
      });

      // Return empty so readline doesn't print the matches again
      return [[], ""];
    }

    // Line changed to something unexpected — reset and do fresh completion
    tabCycleState = null;
  }

  // Normal completion
  const [matches, matchLine] = computeMatches(line);

  // Multiple matches → initialize cycling for the next tab press
  if (matches.length > 1) {
    tabCycleState = { matches, index: -1, original: line };
  }

  return [matches, matchLine];
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

class AbortFlowError extends Error {
  constructor() {
    super("Aborted by user.");
    this.name = "AbortFlowError";
  }
}

// ─── Module-level readline reference for interactive prompting ────────────────
let activeRl: ReadlineInterface | null = null;
let isScriptMode = false;
let globalPauseReadlineClose = false;

// ─── Prompt helpers ───────────────────────────────────────────────────────────

function getPrompt(target: TargetManager): string {
  if (target.connected) return `${pc.green("✓")}${pc.cyan("> ")}`;
  return `${pc.red("✗")}${pc.cyan("> ")}`;
}

// ─── Box drawing helpers ──────────────────────────────────────────────────────

function printBanner(
  serverName: string,
  serverVersion: string,
  toolCount: number,
  resourceCount: number,
  promptCount: number,
): void {
  const parts: string[] = [];
  parts.push(`${pc.bold(toolCount.toString())} tools`);
  if (resourceCount > 0) parts.push(`${pc.bold(resourceCount.toString())} resources`);
  if (promptCount > 0) parts.push(`${pc.bold(promptCount.toString())} prompts`);

  const title = serverVersion ? `${serverName} ${pc.dim(`v${serverVersion}`)}` : serverName;

  const BOX_WIDTH = 53; // inner width between │ and │

  const padLine = (content: string): string => {
    const visible = stripAnsi(content).length;
    const padding = Math.max(0, BOX_WIDTH - visible);
    return `${pc.cyan("  │")}${content}${"".padEnd(padding)}${pc.cyan("│")}`;
  };

  const partsStr = `  ${parts.join(" • ")}`;

  console.log();
  console.log(pc.cyan(`  ┌${"─".repeat(BOX_WIDTH)}┐`));
  console.log(padLine(`  ${title}`));
  console.log(padLine(partsStr));
  console.log(pc.cyan(`  ├${"─".repeat(BOX_WIDTH)}┤`));
  console.log(padLine("  Quick start:"));
  console.log(padLine(`    ${pc.green("tools/list")}                  See all tools`));
  console.log(padLine(`    ${pc.green("tools/call")} ${pc.dim("<name>")}           Call a tool`));
  console.log(padLine(`    ${pc.green("help")}                        All commands`));
  console.log(padLine(""));
  console.log(padLine(pc.dim("  Tab completion is active. Start typing to explore.")));
  console.log(pc.cyan(`  └${"─".repeat(BOX_WIDTH)}┘`));
  console.log();
}

/** Strip ANSI escape codes for measuring display width. */
function stripAnsi(str: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping requires matching \x1b
  return str.replace(/\x1b\[[0-9;]*m/g, "");
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

  isScriptMode = !!opts.script;

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
  if (!isScriptMode) {
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

    // ─── Live notification display ──────────────────────────────────────────

    target.on("notification", (notification: ServerNotification) => {
      const method = notification.method;
      if (method === "notifications/message") {
        const lvl = (notification.params as any)?.level ?? "info";
        const data = (notification.params as any)?.data ?? "";
        const text = typeof data === "string" ? data : JSON.stringify(data);
        console.log(pc.dim(`\n  [${lvl}] ${text}`));
      } else if (method === "notifications/tools/list_changed") {
        console.log(pc.yellow("\n  ⟳ Server tools changed. Run tools/list to see updates."));
        refreshCaches(target).catch(() => {});
      } else if (method === "notifications/resources/list_changed") {
        console.log(pc.yellow("\n  ⟳ Server resources changed. Run resources/list to see."));
        refreshCaches(target).catch(() => {});
      } else if (method === "notifications/resources/updated") {
        const uri = (notification.params as any)?.uri ?? "unknown";
        console.log(pc.yellow(`\n  ⟳ Resource updated: ${uri}`));
      } else if (method === "notifications/prompts/list_changed") {
        console.log(pc.yellow("\n  ⟳ Server prompts changed. Run prompts/list to see."));
        refreshCaches(target).catch(() => {});
      }
    });

    // ─── Sampling requests ──────────────────────────────────────────────────

    target.on("sampling_request", async ({ request, respond, reject: rejectFn }: any) => {
      console.log(pc.magenta("\n  ╔══ Sampling Request ══════════════════════════════════"));
      const messages = request?.messages ?? [];
      for (const msg of messages) {
        const role = msg.role === "user" ? pc.blue("user") : pc.magenta("assistant");
        const text = msg.content?.text ?? JSON.stringify(msg.content);
        console.log(pc.magenta(`  ║ ${role}: ${text}`));
      }
      console.log(pc.magenta("  ╚═════════════════════════════════════════════════════"));
      if (activeRl) {
        try {
          const answer = await question(activeRl, `  ${pc.bold("Approve? [y/N/text]:")} `);
          const trimmed = answer.trim().toLowerCase();
          if (trimmed === "y" || trimmed === "yes") {
            respond({
              model: "user-approved",
              role: "assistant",
              content: { type: "text", text: "Approved by user." },
            });
          } else if (trimmed === "n" || trimmed === "no" || trimmed === "") {
            rejectFn(new Error("Sampling request rejected by user"));
          } else {
            respond({
              model: "user-provided",
              role: "assistant",
              content: { type: "text", text: answer.trim() },
            });
          }
        } catch (err) {
          if (err instanceof AbortFlowError) {
            rejectFn(new Error("Sampling request rejected by user"));
          } else {
            throw err;
          }
        }
      } else {
        rejectFn(new Error("No interactive terminal available for sampling approval"));
      }
    });

    // ─── Elicitation requests ───────────────────────────────────────────────

    target.on("elicitation_request", async ({ request, respond, reject: rejectFn }: any) => {
      console.log(pc.cyan("\n  ╔══ Elicitation Request ════════════════════════════════"));
      console.log(pc.cyan(`  ║ ${request?.message ?? "Server requests input"}`));
      console.log(pc.cyan("  ╚═════════════════════════════════════════════════════"));
      if (activeRl) {
        try {
          const answer = await question(
            activeRl,
            `  ${pc.bold("Your response (empty to decline):")} `,
          );
          if (answer.trim() === "") {
            respond({ action: "decline" });
          } else {
            try {
              const parsed = JSON.parse(answer.trim());
              respond({ action: "accept", content: parsed });
            } catch {
              respond({ action: "accept", content: { value: answer.trim() } });
            }
          }
        } catch (err) {
          if (err instanceof AbortFlowError) {
            respond({ action: "decline" });
          } else {
            throw err;
          }
        }
      } else {
        rejectFn(new Error("No interactive terminal available for elicitation"));
      }
    });
  }

  // ─── Startup: gather counts + show banner ─────────────────────────────────

  let toolCount = 0;
  let resourceCount = 0;
  let promptCount = 0;

  try {
    const { tools } = await target.listTools();
    toolCount = tools.length;

    const caps = target.getServerCapabilities() ?? {};

    if (caps.resources) {
      try {
        const { resources } = await target.listResources();
        resourceCount = resources.length;
      } catch {
        /* ignore */
      }
    }

    if (caps.prompts) {
      try {
        const { prompts } = await target.listPrompts();
        promptCount = prompts.length;
      } catch {
        /* ignore */
      }
    }

    // Show rich banner
    const serverInfo = target.getServerVersion();
    const serverName = serverInfo?.name ?? "MCP Server";
    const serverVersion = serverInfo?.version ?? "";

    printBanner(serverName, serverVersion, toolCount, resourceCount, promptCount);

    // Show categorized summary for servers with many tools
    if (toolCount >= 10) {
      const groups = groupToolsByPrefix(
        cachedToolNames.length > 0 ? cachedToolNames : tools.map((t) => t.name),
      );
      if (!groups.has("All")) {
        // Has meaningful groups
        for (const [label, members] of groups) {
          console.log(`  ${pc.bold(label.padEnd(16))} ${pc.dim(members.join(", "))}`);
        }
        console.log();
      }
    }
  } catch (err: any) {
    console.log(pc.yellow(`  Warning: Could not list tools: ${err.message}\n`));
  }

  // Populate tab completion caches
  await refreshCaches(target);

  if (isScriptMode) {
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
    // Interactive mode: start the readline event loop
    startReadlineLoop(target, interceptor);
  }
}

/**
 * Starts the readline loop. Extracted so it can be temporarily closed and 
 * restarted when we need to hand over stdin/stdout to Inquirer.
 */
function startReadlineLoop(target: TargetManager, interceptor: ResponseInterceptor) {
  if (isScriptMode || activeRl) return;

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: getPrompt(target),
    terminal: true,
    completer,
  });
  activeRl = rl;

  // Reset tab cycling on any non-tab keypress
  if (process.stdin.isTTY) {
    process.stdin.on("keypress", (_str: string, key: any) => {
      if (!key || key.name !== "tab") {
        resetTabCycle();
      }
    });
  }

  rl.prompt();

  // Queue commands to prevent interleaving
  let processing = false;
  let closed = false;
  const queue: string[] = [];

  const processQueue = async () => {
    if (processing) return;
    processing = true;

    while (queue.length > 0) {
      const trimmed = queue.shift()!;
      try {
        await handleCommand(trimmed, target, interceptor);
      } catch (err: any) {
        if (err instanceof AbortFlowError) {
          console.log(pc.yellow("  Aborted."));
        } else {
          console.error(pc.red(`✗ Error: ${err.message}`));
        }
      }
      if (!closed && activeRl) {
        activeRl.setPrompt(getPrompt(target));
        activeRl.prompt();
      }
    }

    processing = false;
  };

  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      if (!closed && activeRl) activeRl.prompt();
      return;
    }
    queue.push(trimmed);
    processQueue();
  });

  rl.on("close", async () => {
    closed = true;
    activeRl = null;
    
    if (!globalPauseReadlineClose) {
      console.log(pc.dim("\nShutting down..."));
      await target.close();
      process.exit(0);
    }
  });
}

/**
 * Dispatch a single REPL command string.
 */
async function handleCommand(
  input: string,
  target: TargetManager,
  interceptor: ResponseInterceptor,
): Promise<void> {
  // Expand aliases before parsing
  const expanded = resolveAlias(input);
  const effective = expanded ?? input;

  // Parse the command and arguments
  const { cmd, rest } = parseCommandLine(effective);

  // Track last command for !! / last (but don't record !! itself)
  if (cmd !== "!!" && cmd !== "last") {
    lastCommand = input;
  }

  switch (cmd) {
    case "help":
      printHelp();
      return;

    case "explore":
    case "interactive":
      // Close readline temporarily to allow inquirer to take over stdin/stdout
      if (activeRl) {
        globalPauseReadlineClose = true;
        activeRl.close();
        activeRl = null;
      }
      try {
        await cmdExplore(target, interceptor);
      } finally {
        globalPauseReadlineClose = false;
        if (!isScriptMode) {
          startReadlineLoop(target, interceptor);
        }
      }
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

    case "ping":
      await cmdPing(target);
      return;

    case "log-level":
      await cmdLogLevel(target, rest);
      return;

    case "history":
      cmdHistory(target, rest);
      return;

    case "notifications":
      cmdNotifications(target, rest);
      return;

    case "resources/subscribe":
      await cmdResourcesSubscribe(target, rest);
      return;

    case "resources/unsubscribe":
      await cmdResourcesUnsubscribe(target, rest);
      return;

    case "roots/list":
      cmdRootsList(target);
      return;

    case "roots/add":
      await cmdRootsAdd(target, rest);
      return;

    case "roots/remove":
      await cmdRootsRemove(target, rest);
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

  // Show grouped summary for large tool sets
  if (tools.length >= 10) {
    const groups = groupToolsByPrefix(tools.map((t) => t.name));
    if (!groups.has("All")) {
      console.log();
      console.log(pc.bold("  Groups:"));
      for (const [label, members] of groups) {
        console.log(`    ${pc.cyan(label.padEnd(16))} ${pc.dim(members.join(", "))}`);
      }
    }
  }
}

async function cmdToolsDescribe(target: TargetManager, rest: string): Promise<void> {
  const name = rest.trim();

  // Change 5: Inline help hint when no args given
  if (!name) {
    console.log(pc.yellow("  Usage: tools/describe <name>"));
    if (cachedToolNames.length > 0) {
      const preview = cachedToolNames.slice(0, 6);
      const more = cachedToolNames.length > 6 ? `, ... (${cachedToolNames.length} total)` : "";
      console.log(pc.dim(`\n  Available tools: ${preview.join(", ")}${more}`));
      console.log(pc.dim(`  Type ${pc.bold("tools/list")} for all.`));
    }
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

  // Change 3: Smarter describe output
  console.log();
  console.log(
    formatToolDescription({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
      annotations: tool.annotations as Record<string, unknown>,
    }),
  );
  console.log();
}

async function cmdToolsCall(
  target: TargetManager,
  interceptor: ResponseInterceptor,
  rest: string,
): Promise<void> {
  // Parse: <name> <json_args> [--timeout <ms>]
  const { toolName, jsonArgs, timeoutMs } = parseCallArgs(rest);

  if (!toolName) {
    console.log(pc.yellow("  Usage: tools/call <name> [json_args] [--timeout <ms>]"));
    if (cachedToolNames.length > 0) {
      const preview = cachedToolNames.slice(0, 6);
      const more = cachedToolNames.length > 6 ? `, ... (${cachedToolNames.length} total)` : "";
      console.log(pc.dim(`\n  Available tools: ${preview.join(", ")}${more}`));
      console.log(
        pc.dim(`  Run without args for ${pc.bold("interactive mode")}: tools/call <name>`),
      );
    }
    return;
  }

  let args: Record<string, unknown> = {};

  if (jsonArgs) {
    // User provided JSON — parse it
    try {
      args = JSON.parse(jsonArgs);
    } catch (err: any) {
      console.error(pc.red(`Invalid JSON: ${err.message}`));
      console.log(pc.dim(`  Received: ${jsonArgs}`));
      return;
    }

    // Change 4: Check for missing required args and show scaffold
    const { tools } = await target.listTools();
    const tool = tools.find((t) => t.name === toolName);
    if (tool) {
      const schema = tool.inputSchema as Record<string, unknown>;
      const required = (schema.required as string[]) ?? [];
      const missing = required.filter((r) => !(r in args));

      if (missing.length > 0) {
        console.log(pc.yellow(`\n  Missing required arguments: ${missing.join(", ")}`));
        console.log();
        const scaffolded = scaffoldArgs(schema);
        console.log(pc.dim("  Try:"));
        console.log(`    tools/call ${toolName} ${scaffolded}`);
        console.log();
        console.log(pc.dim("  Or run without args for interactive mode:"));
        console.log(`    tools/call ${toolName}`);
        console.log();
        return;
      }
    }
  } else {
    // Change 2: Interactive tool calling — no JSON provided
    const collectedArgs = await interactiveArgPrompt(target, toolName);
    if (collectedArgs === null) return; // User cancelled or error
    args = collectedArgs;
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

// ─── Interactive Argument Prompting ─────────────────────────────────────────

/**
 * Prompt the user interactively for a tool's arguments.
 * Shows the JSON template being built progressively.
 *
 * Returns the collected args object, or null if the tool wasn't found
 * or we're in script mode.
 */
async function interactiveArgPrompt(
  target: TargetManager,
  toolName: string,
): Promise<Record<string, unknown> | null> {
  const { tools } = await target.listTools();
  const tool = tools.find((t) => t.name === toolName);

  if (!tool) {
    console.log(pc.red(`Tool "${toolName}" not found.`));
    const suggestion = suggestCommand(
      toolName,
      tools.map((t) => t.name),
    );
    if (suggestion) {
      console.log(pc.yellow(`Did you mean ${pc.bold(suggestion)}?`));
    } else {
      console.log(pc.dim(`Available: ${tools.map((t) => t.name).join(", ")}`));
    }
    return null;
  }

  const schema = tool.inputSchema as Record<string, unknown>;
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;

  // No args needed — just proceed
  if (!properties || Object.keys(properties).length === 0) {
    return {};
  }

  // In script mode, can't prompt interactively
  if (isScriptMode || !activeRl) {
    console.log(pc.yellow(`  Tool "${toolName}" requires arguments.`));
    const scaffolded = scaffoldArgs(schema);
    console.log(pc.dim(`  Usage: tools/call ${toolName} ${scaffolded}`));
    return null;
  }

  const required = (schema.required as string[]) ?? [];
  const allProps = Object.entries(properties);
  const requiredProps = allProps.filter(([name]) => required.includes(name));
  const optionalProps = allProps.filter(([name]) => !required.includes(name));

  // Show tool info
  console.log();
  console.log(`  ${pc.bold(tool.name)}${tool.description ? pc.dim(` — ${tool.description}`) : ""}`);
  console.log();

  const collectedArgs: Record<string, unknown> = {};

  // Phase 2a: Prompt for required args with live JSON template
  for (const [name, prop] of requiredProps) {
    // Show current JSON template state
    printJsonTemplate(collectedArgs, allProps, name);

    const typeStr = (prop.type as string) ?? "any";
    const desc = (prop.description as string) ?? "";
    const label = desc
      ? `${name} ${pc.dim(`(${typeStr})`)} ${pc.dim(desc)}`
      : `${name} ${pc.dim(`(${typeStr})`)}`;

    const answer = await question(activeRl, `  ${label}: `);
    collectedArgs[name] = coerceValue(answer, typeStr);
  }

  // Phase 2b: Checkbox toggle for optional args
  if (optionalProps.length > 0) {
    const selectedOptionals = await checkboxSelect(optionalProps);

    for (const [name, prop] of selectedOptionals) {
      printJsonTemplate(collectedArgs, allProps, name);

      const typeStr = (prop.type as string) ?? "any";
      const desc = (prop.description as string) ?? "";
      const label = desc
        ? `${name} ${pc.dim(`(${typeStr})`)} ${pc.dim(desc)}`
        : `${name} ${pc.dim(`(${typeStr})`)}`;

      const answer = await question(activeRl, `  ${label}: `);
      collectedArgs[name] = coerceValue(answer, typeStr);
    }
  }

  // Show final JSON
  console.log();
  console.log(pc.dim(`  ${JSON.stringify(collectedArgs)}`));

  return collectedArgs;
}

/**
 * Print the JSON template showing filled and unfilled values.
 */
function printJsonTemplate(
  filled: Record<string, unknown>,
  allProps: [string, Record<string, unknown>][],
  currentProp: string,
): void {
  const parts: string[] = [];
  for (const [name] of allProps) {
    if (name in filled) {
      parts.push(`"${name}": ${pc.green(JSON.stringify(filled[name]))}`);
    } else if (name === currentProp) {
      parts.push(`"${name}": ${pc.yellow("▒")}`);
    } else {
      parts.push(`"${name}": ${pc.dim("▒")}`);
    }
  }
  console.log(pc.dim("  { ") + parts.join(pc.dim(", ")) + pc.dim(" }"));
  console.log();
}

/**
 * Coerce a string input to the appropriate type based on schema type.
 */
function coerceValue(input: string, type: string): unknown {
  switch (type) {
    case "number":
    case "integer": {
      const n = Number(input);
      return Number.isNaN(n) ? input : n;
    }
    case "boolean":
      return input.toLowerCase() === "true" || input === "1";
    default:
      return input;
  }
}

/**
 * Promise wrapper around readline.question().
 */
function question(rl: ReadlineInterface, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let aborted = false;

    const onKeypress = (_str: string, key: any) => {
      if (key && key.name === "escape") {
        aborted = true;
        cleanup();
        process.stdout.write("\x1b[2K\r");
        
        // Clear rl buffer and simulate Enter to release .question callback
        rl.write("", { ctrl: true, name: "u" });
        rl.write("\n");
      }
    };

    const cleanup = () => {
      if (process.stdin.isTTY) {
        process.stdin.removeListener("keypress", onKeypress);
      }
    };

    if (process.stdin.isTTY) {
      process.stdin.on("keypress", onKeypress);
    }

    rl.question(prompt, (answer) => {
      cleanup();
      if (aborted) {
        reject(new AbortFlowError());
      } else {
        resolve(answer);
      }
    });
  });
}

/**
 * Interactive checkbox selector for optional properties.
 * Uses raw mode to handle arrow keys and space bar.
 *
 * Returns the selected [name, prop] entries.
 */
async function checkboxSelect(
  options: [string, Record<string, unknown>][],
): Promise<[string, Record<string, unknown>][]> {
  if (options.length === 0) return [];

  // Can't do raw-mode selection without a TTY
  if (!process.stdin.isTTY) return [];

  const selected = new Set<number>();
  let cursor = 0;

  const nameWidth = Math.max(6, ...options.map(([n]) => n.length));

  const render = () => {

    console.log(
      `\x1b[2K` +
        pc.dim(
          `  Optional arguments (${pc.bold("↑↓")} move, ${pc.bold("Space")} toggle, ${pc.bold("Enter")} confirm):`,
        ),
    );
    
    const cols = process.stdout.columns || 80;
    const reservedWidth = 20 + nameWidth; // Marker + Checkbox + Name + Type + spaces
    const maxDescLen = Math.max(0, cols - reservedWidth - 2); // -2 for safety margin

    for (let i = 0; i < options.length; i++) {
      const [name, prop] = options[i];
      const check = selected.has(i) ? pc.green("✓") : " ";
      const marker = i === cursor ? pc.cyan("›") : " ";
      const typeStr = (prop.type as string) ?? "any";
      
      let desc = (prop.description as string) ?? "";
      if (desc.length > maxDescLen && maxDescLen > 3) {
        desc = desc.slice(0, maxDescLen - 3) + "...";
      } else if (desc.length > maxDescLen) {
        desc = desc.slice(0, maxDescLen);
      }

      console.log(
        `\x1b[2K  ${marker} [${check}] ${pc.bold(name.padEnd(nameWidth))}  ${pc.dim(typeStr.padEnd(8))}  ${pc.dim(desc)}`,
      );
    }
  };

  return new Promise((resolve, reject) => {
    // Pause the readline so we get raw keystrokes
    activeRl?.pause();

    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    render();

    const onData = (data: Buffer) => {
      const key = data.toString();

      // Arrow up / k
      if (key === "\x1b[A" || key === "k") {
        cursor = (cursor - 1 + options.length) % options.length;
      }
      // Arrow down / j
      else if (key === "\x1b[B" || key === "j") {
        cursor = (cursor + 1) % options.length;
      }
      // Space — toggle
      else if (key === " ") {
        if (selected.has(cursor)) {
          selected.delete(cursor);
        } else {
          selected.add(cursor);
        }
      }
      // Enter — confirm
      else if (key === "\r" || key === "\n") {
        cleanup();
        const result = options.filter((_, i) => selected.has(i));
        resolve(result);
        return;
      }
      // Ctrl+C / Escape — cancel
      else if (key === "\x03" || key === "\x1b") {
        cleanup();
        console.log();
        reject(new AbortFlowError());
        return;
      }

      // Clear and re-render
      // Move up by (options.length + 1) lines and clear
      process.stdout.write(`\x1b[${options.length + 1}A`);
      for (let i = 0; i < options.length + 1; i++) {
        process.stdout.write("\x1b[2K\n");
      }
      process.stdout.write(`\x1b[${options.length + 1}A`);
      render();
    };

    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(wasRaw ?? false);
      // Clear the selector display
      process.stdout.write(`\x1b[${options.length + 1}A`);
      for (let i = 0; i < options.length + 1; i++) {
        process.stdout.write("\x1b[2K\n");
      }
      process.stdout.write(`\x1b[${options.length + 1}A`);

      // Show what was selected
      if (selected.size > 0) {
        const names = options.filter((_, i) => selected.has(i)).map(([n]) => n);
        console.log(pc.dim(`  Including optional: ${names.join(", ")}`));
      } else {
        console.log(pc.dim("  No optional arguments selected."));
      }

      // Resume readline
      activeRl?.resume();
    };

    process.stdin.on("data", onData);
  });
}

async function cmdToolsScaffold(target: TargetManager, rest: string): Promise<void> {
  const name = rest.trim();

  // Change 5: Inline help hint
  if (!name) {
    console.log(pc.yellow("  Usage: tools/scaffold <name>"));
    if (cachedToolNames.length > 0) {
      const preview = cachedToolNames.slice(0, 6);
      const more = cachedToolNames.length > 6 ? `, ... (${cachedToolNames.length} total)` : "";
      console.log(pc.dim(`\n  Available tools: ${preview.join(", ")}${more}`));
    }
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

  // Change 5: Inline help hint
  if (!uri) {
    console.log(pc.yellow("  Usage: resources/read <uri>"));
    if (cachedResourceUris.length > 0) {
      const preview = cachedResourceUris.slice(0, 5);
      const more =
        cachedResourceUris.length > 5 ? `, ... (${cachedResourceUris.length} total)` : "";
      console.log(pc.dim(`\n  Available resources: ${preview.join(", ")}${more}`));
    }
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

  // Change 5: Inline help hint
  if (!promptName) {
    console.log(pc.yellow("  Usage: prompts/get <name> [json_args]"));
    if (cachedPromptNames.length > 0) {
      console.log(pc.dim(`\n  Available prompts: ${cachedPromptNames.join(", ")}`));
    }
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

// ─── Ping ───────────────────────────────────────────────────────────────────

async function cmdPing(target: TargetManager): Promise<void> {
  try {
    const elapsed = await target.ping();
    console.log(pc.green(`  ✓ Pong! Round-trip: ${elapsed}ms`));
  } catch (err: any) {
    console.error(pc.red(`  ✗ Ping failed: ${err.message}`));
  }
}

// ─── Log Level ──────────────────────────────────────────────────────────────

async function cmdLogLevel(target: TargetManager, rest: string): Promise<void> {
  const level = rest.trim().toLowerCase();

  if (!level) {
    console.log(pc.yellow("  Usage: log-level <level>"));
    console.log(pc.dim(`  Valid levels: ${LOG_LEVELS.join(", ")}`));
    return;
  }

  if (!LOG_LEVELS.includes(level as any)) {
    const suggestion = suggestCommand(level, [...LOG_LEVELS]);
    const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
    console.log(pc.red(`  Unknown log level: "${level}".${hint}`));
    console.log(pc.dim(`  Valid levels: ${LOG_LEVELS.join(", ")}`));
    return;
  }

  try {
    await target.setLoggingLevel(level);
    console.log(pc.green(`  ✓ Logging level set to: ${level}`));
  } catch (err: any) {
    console.error(pc.red(`  ✗ Failed to set log level: ${err.message}`));
    const caps = target.getServerCapabilities();
    if (!caps?.logging) {
      console.log(pc.dim("  The server does not advertise logging support."));
    }
  }
}

// ─── History ────────────────────────────────────────────────────────────────

function cmdHistory(target: TargetManager, rest: string): void {
  const arg = rest.trim();

  if (arg === "clear") {
    target.clearHistory();
    console.log(pc.dim("  History cleared."));
    return;
  }

  const count = arg ? Number.parseInt(arg, 10) : 20;
  const records = target.getHistory(Number.isNaN(count) ? 20 : count);

  if (records.length === 0) {
    console.log(pc.dim("  No request history yet."));
    return;
  }

  console.log(pc.bold("\n  Request History"));
  console.log(pc.dim(`  ${"─".repeat(70)}`));

  for (const rec of records) {
    const time = new Date(rec.timestamp).toLocaleTimeString();
    const dur = `${rec.durationMs}ms`;
    const hasError = rec.error ? pc.red(" ✗") : "";
    console.log(
      `  ${pc.dim(`#${rec.id}`)} ${pc.dim(time)} ${pc.green(rec.method.padEnd(30))} ${pc.cyan(dur.padStart(8))}${hasError}`,
    );
  }

  const total = target.getHistory().length;
  console.log(
    pc.dim(`\n  Showing ${records.length} of ${total} total. Use "history clear" to reset.`),
  );
  console.log();
}

// ─── Notifications ──────────────────────────────────────────────────────────

function cmdNotifications(target: TargetManager, rest: string): void {
  const arg = rest.trim();

  if (arg === "clear") {
    target.clearNotifications();
    console.log(pc.dim("  Notifications cleared."));
    return;
  }

  const count = arg ? Number.parseInt(arg, 10) : 20;
  const records = target.getNotifications(Number.isNaN(count) ? 20 : count);

  if (records.length === 0) {
    console.log(pc.dim("  No notifications received yet."));
    console.log(pc.dim("  Notifications appear inline as they arrive from the server."));
    return;
  }

  console.log(pc.bold("\n  Server Notifications"));
  console.log(pc.dim(`  ${"─".repeat(70)}`));

  for (const n of records) {
    const time = new Date(n.timestamp).toLocaleTimeString();
    const params = n.params ? ` ${pc.dim(JSON.stringify(n.params))}` : "";
    console.log(`  ${pc.dim(time)} ${pc.yellow(n.method)}${params}`);
  }

  const total = target.getNotifications().length;
  console.log(
    pc.dim(`\n  Showing ${records.length} of ${total} total. Use "notifications clear" to reset.`),
  );
  console.log();
}

// ─── Resource Subscriptions ─────────────────────────────────────────────────

async function cmdResourcesSubscribe(target: TargetManager, rest: string): Promise<void> {
  const uri = rest.trim();
  if (!uri) {
    console.log(pc.yellow("  Usage: resources/subscribe <uri>"));
    if (cachedResourceUris.length > 0) {
      console.log(pc.dim(`  Available: ${cachedResourceUris.join(", ")}`));
    }
    return;
  }

  try {
    await target.subscribeResource({ uri });
    console.log(pc.green(`  ✓ Subscribed to: ${uri}`));
    console.log(pc.dim("  You'll see notifications when this resource changes."));
  } catch (err: any) {
    console.error(pc.red(`  ✗ Subscribe failed: ${err.message}`));
  }
}

async function cmdResourcesUnsubscribe(target: TargetManager, rest: string): Promise<void> {
  const uri = rest.trim();
  if (!uri) {
    console.log(pc.yellow("  Usage: resources/unsubscribe <uri>"));
    return;
  }

  try {
    await target.unsubscribeResource({ uri });
    console.log(pc.green(`  ✓ Unsubscribed from: ${uri}`));
  } catch (err: any) {
    console.error(pc.red(`  ✗ Unsubscribe failed: ${err.message}`));
  }
}

// ─── Roots Management ───────────────────────────────────────────────────────

function cmdRootsList(target: TargetManager): void {
  const roots = target.getRoots();
  if (roots.length === 0) {
    console.log(pc.dim("  No roots configured."));
    console.log(pc.dim("  Use roots/add <uri> [name] to add one."));
    return;
  }

  console.log(pc.bold("\n  Client Roots"));
  for (const r of roots) {
    const name = r.name ? ` (${r.name})` : "";
    console.log(`  ${pc.green(r.uri)}${pc.dim(name)}`);
  }
  console.log();
}

async function cmdRootsAdd(target: TargetManager, rest: string): Promise<void> {
  const parts = rest.trim().split(/\s+/);
  const uri = parts[0];
  const name = parts.slice(1).join(" ") || undefined;

  if (!uri) {
    console.log(pc.yellow("  Usage: roots/add <uri> [name]"));
    console.log(pc.dim('  Example: roots/add file:///Users/me/project "My Project"'));
    return;
  }

  await target.addRoot({ uri, name });
  console.log(pc.green(`  ✓ Root added: ${uri}`));
  console.log(pc.dim("  Server has been notified of the change."));
}

async function cmdRootsRemove(target: TargetManager, rest: string): Promise<void> {
  const uri = rest.trim();
  if (!uri) {
    console.log(pc.yellow("  Usage: roots/remove <uri>"));
    const roots = target.getRoots();
    if (roots.length > 0) {
      console.log(pc.dim(`  Current roots: ${roots.map((r) => r.uri).join(", ")}`));
    }
    return;
  }

  const removed = await target.removeRoot(uri);
  if (removed) {
    console.log(pc.green(`  ✓ Root removed: ${uri}`));
  } else {
    console.log(pc.yellow(`  Root not found: ${uri}`));
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
  ${pc.green("tools/call")} <name> [json] [opts]    Call a tool (interactive if no json)
    Options: ${pc.dim("--timeout <ms>")}            Override default timeout (60s)
  ${pc.green("tools/scaffold")} <name>              Generate a template for a tool's arguments

${pc.bold("Resource Commands:")}

  ${pc.green("resources/list")}                     List all available resources
  ${pc.green("resources/read")} <uri>               Read a resource by URI
  ${pc.green("resources/templates")}                List resource templates
  ${pc.green("resources/subscribe")} <uri>          Subscribe to resource changes
  ${pc.green("resources/unsubscribe")} <uri>        Unsubscribe from resource changes

${pc.bold("Prompt Commands:")}

  ${pc.green("prompts/list")}                       List all available prompts
  ${pc.green("prompts/get")} <name> [json_args]    Get a prompt with arguments

${pc.bold("Protocol Commands:")}

  ${pc.green("ping")}                               Verify connection, show round-trip time
  ${pc.green("log-level")} <level>                  Set server logging verbosity
  ${pc.green("history")} [count|clear]              Show request/response history
  ${pc.green("notifications")} [count|clear]        Show server notifications

${pc.bold("Roots Management:")}

  ${pc.green("roots/list")}                         Show configured client roots
  ${pc.green("roots/add")} <uri> [name]             Add a root directory
  ${pc.green("roots/remove")} <uri>                 Remove a root directory

${pc.bold("Session Commands:")}

  ${pc.green("!!")} / ${pc.green("last")}                           Re-run the last command
  ${pc.green("reconnect")}                          Disconnect and reconnect to the server
  ${pc.green("timing")}                             Show tool call performance stats
  ${pc.green("status")}                             Show target server status
  ${pc.green("help")}                               Show this help
  ${pc.green("exit")} / ${pc.green("quit")}                         Disconnect and exit

${pc.bold("Shortcuts:")}

  ${pc.green("tl")}  tools/list          ${pc.green("rl")}  resources/list     ${pc.green("pl")}  prompts/list
  ${pc.green("td")}  tools/describe      ${pc.green("rr")}  resources/read     ${pc.green("pg")}  prompts/get
  ${pc.green("tc")}  tools/call          ${pc.green("rt")}  resources/templates
  ${pc.green("ts")}  tools/scaffold      ${pc.green("rs")}  resources/subscribe
                          ${pc.green("ru")}  resources/unsubscribe

${pc.dim("Lines starting with # are treated as comments.")}
${pc.dim('JSON arguments can contain spaces: tools/call say {"message": "hello world"}')}
${pc.dim("Run tools/call <name> without JSON for interactive argument prompting.")}
`);
}

/**
 * Read all lines from a script file.
 */
async function readScriptLines(filepath: string): Promise<string[]> {
  const content = await readFile(filepath, "utf-8");
  return content.split("\n");
}
// ─── Explorer ─────────────────────────────────────────────────────────────────

async function cmdExplore(target: TargetManager, interceptor: ResponseInterceptor) {
  const choices = [];

  const caps = target.getServerCapabilities() ?? {};

  try {
    const { tools } = await target.listTools();
    for (const t of tools) {
      choices.push({
        name: `🛠️  Tool: ${t.name}`,
        value: { type: "tool", name: t.name },
        description: t.description || `Call the ${t.name} tool`,
      });
    }
  } catch {}

  if (caps.resources) {
    try {
      const { resources } = await target.listResources();
      for (const r of (resources as any[])) {
        choices.push({
          name: `📄 Resource: ${r.name || r.uri}`,
          value: { type: "resource", uri: r.uri },
          description: r.description || `Read resource ${r.uri}`,
        });
      }
    } catch {}
  }

  if (caps.prompts) {
    try {
      const { prompts } = await target.listPrompts();
      for (const p of prompts) {
        choices.push({
          name: `💬 Prompt: ${p.name}`,
          value: { type: "prompt", name: p.name },
          description: p.description || `Get the ${p.name} prompt`,
        });
      }
    } catch {}
  }

  if (choices.length === 0) {
    console.log(pc.yellow("No tools, resources, or prompts found."));
    return;
  }

  try {
    const answer = await search({
      message: "Explore server capabilities:",
      source: async (term: string | undefined) => {
        if (!term) return choices;
        const lower = term.toLowerCase();
        return choices.filter(
          (c) =>
            c.name.toLowerCase().includes(lower) ||
            c.description.toLowerCase().includes(lower),
        );
      },
    });

    if (answer.type === "tool") {
      await cmdToolsCall(target, interceptor, answer.name);
    } else if (answer.type === "resource") {
      await cmdResourcesRead(target, answer.uri);
    } else if (answer.type === "prompt") {
      await cmdPromptsGet(target, answer.name);
    }
  } catch (err: any) {
    if (err.name !== "ExitPromptError") {
      // ignore
    }
  }
}
