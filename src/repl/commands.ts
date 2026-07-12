import { execFile } from "node:child_process";
import type { Interface as ReadlineInterface } from "node:readline";
import { checkbox, confirm, input, search } from "@inquirer/prompts";
import { colors as pc } from "../colors.js";
import { ResponseInterceptor } from "../interceptor.js";
import {
  formatJson,
  formatToolDescription,
  groupToolsByPrefix,
  LOG_LEVELS,
  parseCallArgs,
  parseCommandLine,
  parseHttpieArgs,
  resolveAlias,
  scaffoldArgs,
  suggestCommand,
} from "../parsing.js";
import { TargetManager } from "../target-manager.js";
import {
  activeRl,
  setActiveRl,
  setGlobalPauseReadlineClose,
  isScriptMode,
  setDeferNextPrompt,
  cachedToolNames,
  cachedResourceUris,
  cachedPromptNames,
  callHistory,
  lastToolArgsMap,
} from "./state.js";
import { replHistory, appendToHistoryFile } from "./history.js";
import { saveWizardDefaults } from "./wizard.js";
import { printResultBlock, printHelp, printShortHelp, sanitizeServerText } from "./ui.js";
import { getActiveCommands, refreshCaches } from "./completer.js";
import { startReadlineLoop } from "./index.js";

// Re-export shared variables
export let lastCommand: string | null = null;
export function setLastCommand(val: string | null) {
  lastCommand = val;
}

export class AbortFlowError extends Error {
  constructor() {
    super("Aborted by user.");
    this.name = "AbortFlowError";
  }
}

export function isAbortError(err: any): boolean {
  if (!err) return false;
  return (
    err.name === "ExitPromptError" ||
    err.name === "AbortError" ||
    err.message === "Prompt was aborted" ||
    (typeof err.message === "string" && err.message.includes("User force closed"))
  );
}

export async function withSuspendedReadline<T>(
  target: TargetManager,
  interceptor: ResponseInterceptor,
  fn: () => Promise<T>,
): Promise<T> {
  const wasActive = !!activeRl;
  if (wasActive) {
    setGlobalPauseReadlineClose(true);
    activeRl!.close();
    setActiveRl(null);
  }
  try {
    return await fn();
  } finally {
    if (wasActive) {
      setGlobalPauseReadlineClose(false);
      if (!isScriptMode) {
        // Defer the initial prompt so the caller can finish printing output
        // before the ✓> prompt reclaims the line.
        setDeferNextPrompt(true);
        startReadlineLoop(target, interceptor);
      }
    }
  }
}
export async function handleCommand(
  input: string,
  target: TargetManager,
  interceptor: ResponseInterceptor,
): Promise<any> {
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

    case "?":
      printShortHelp();
      return;

    case "view": {
      const filepath = rest.trim();
      if (!filepath) {
        console.error(pc.red("Error: Please specify a file path to view."));
        return;
      }
      // Use execFile (no shell) so the path is passed as a literal argument and
      // cannot be interpreted as shell (e.g. `view "; rm -rf ~ #`).
      const isMac = process.platform === "darwin";
      const isWin = process.platform === "win32";
      const [opener, openerArgs] = isMac
        ? ["open", [filepath]]
        : isWin
          ? ["cmd", ["/c", "start", "", filepath]]
          : ["xdg-open", [filepath]];
      execFile(opener, openerArgs, (err) => {
        if (err) {
          console.error(pc.red(`Error opening file: ${err.message}`));
        } else {
          console.log(pc.green(`Opened ${filepath}`));
        }
      });
      return;
    }

    case "menu":
    case "explore":
    case "interactive":
      if (activeRl) {
        setGlobalPauseReadlineClose(true);
        activeRl.close();
        setActiveRl(null);
        setGlobalPauseReadlineClose(false);
      }
      mainMenuLoop(target, interceptor);
      return;

    case "tools/list":
      await cmdToolsList(target);
      return;

    case "tools/describe":
      await cmdToolsDescribe(target, rest);
      return;

    case "tools/call":
      return await cmdToolsCall(target, interceptor, rest);

    case "tools/scaffold":
      await cmdToolsScaffold(target, rest);
      return;

    case "tools/forget":
      cmdToolsForget(rest);
      return;

    case "resources/list":
      await cmdResourcesList(target);
      return;

    case "resources/read":
      return await cmdResourcesRead(target, rest, interceptor);

    case "resources/templates":
      await cmdResourcesTemplates(target);
      return;

    case "prompts/list":
      await cmdPromptsList(target);
      return;

    case "prompts/get":
      return await cmdPromptsGet(target, rest, interceptor);

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
        return await handleCommand(lastCommand, target, interceptor);
      } else {
        console.log(pc.yellow("No previous command to re-run."));
      }
      return;

    case "status":
      cmdStatus(target);
      return;

    case "exit":
    case "quit": {
      console.log(pc.dim("Shutting down..."));
      await target.close();
      process.exit(0);
      return; // unreachable, satisfies linter
    }

    default: {
      // If it matches a tool name, execute it directly as tools/call. `cmd` is
      // lowercased by parseCommandLine, so match case-insensitively and dispatch
      // with the tool's real casing — otherwise a tool like `getWeather` could
      // never be invoked by its bare name.
      const matchedTool = cachedToolNames.find((n) => n.toLowerCase() === cmd);
      if (matchedTool) {
        const rebuilt = rest ? `${matchedTool} ${rest}` : matchedTool;
        return await cmdToolsCall(target, interceptor, rebuilt);
      }

      // Suggest the closest known command if it's a likely typo
      const suggestion = suggestCommand(cmd, getActiveCommands());
      if (suggestion) {
        console.log(pc.yellow(`Unknown command: ${cmd}.`));
        try {
          await withSuspendedReadline(target, interceptor, async () => {
            const runIt = await confirm({
              message: `Did you mean ${pc.bold(suggestion)}?`,
              default: true,
            });
            if (runIt) {
              const rebuiltCommand = rest ? `${suggestion} ${rest}` : suggestion;
              return await handleCommand(rebuiltCommand, target, interceptor);
            }
          });
        } catch (err: any) {
          if (!isAbortError(err)) throw err;
          throw new AbortFlowError();
        }
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

  // Print as a formatted table. Tool names/descriptions are untrusted server
  // output — sanitize to prevent terminal escape (ANSI/OSC) injection.
  const safeNames = new Map(tools.map((t) => [t, sanitizeServerText(t.name)]));
  const nameWidth = Math.max(8, ...tools.map((t) => safeNames.get(t)!.length));

  console.log(pc.bold(`  ${"Name".padEnd(nameWidth)}  Description`));
  console.log(pc.dim(`  ${"─".repeat(nameWidth)}  ${"─".repeat(50)}`));

  for (const tool of tools) {
    const safeDesc = tool.description ? sanitizeServerText(tool.description) : "";
    const desc = safeDesc
      ? safeDesc.length > 60
        ? `${safeDesc.slice(0, 57)}...`
        : safeDesc
      : pc.dim("(no description)");
    console.log(`  ${pc.green(safeNames.get(tool)!.padEnd(nameWidth))}  ${desc}`);
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

  // Change 3: Smarter describe output. formatToolDescription emits plain text
  // (no ANSI of our own), so sanitizing its whole output strips any escape
  // sequences embedded in untrusted names/descriptions/arg docs without harming
  // our formatting.
  console.log();
  console.log(
    sanitizeServerText(
      formatToolDescription({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
        annotations: tool.annotations as Record<string, unknown>,
      }),
    ),
  );
  console.log();
}

async function cmdToolsCall(
  target: TargetManager,
  interceptor: ResponseInterceptor,
  rest: string,
): Promise<any> {
  // Check for --clear flag (ignore remembered interactive defaults). Match only a
  // standalone flag token so a JSON value like {"note":"--clear"} is not mangled.
  const clearPrevious = /(?:^|\s)--clear(?=\s|$)/.test(rest);
  const cleanedRest = clearPrevious ? rest.replace(/(?:^|\s)--clear(?=\s|$)/, " ").trim() : rest;

  // Parse: <name> <json_args> [--timeout <ms>]
  const { toolName, jsonArgs, timeoutMs } = parseCallArgs(cleanedRest);

  if (!toolName) {
    // In interactive mode with cached tools: launch the fuzzy picker
    if (!isScriptMode && cachedToolNames.length > 0 && process.stdin.isTTY) {
      const picked = await withSuspendedReadline(target, interceptor, async () => {
        const tools = await target.listTools();
        return pickInteractive(
          tools.tools.map((t) => ({ name: t.name, description: t.description })),
          "Pick a tool to call:",
        );
      });
      if (!picked) return;
      // Recurse with the selected tool name to enter interactive arg prompt
      return cmdToolsCall(target, interceptor, picked);
    }

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
    const trimmed = jsonArgs.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        args = JSON.parse(trimmed);
      } catch (err: any) {
        console.error(pc.red(`Invalid JSON: ${err.message}`));
        console.log(pc.dim(`  Received: ${jsonArgs}`));
        return;
      }
    } else {
      try {
        args = parseHttpieArgs(trimmed);
      } catch (err: any) {
        console.error(pc.red(`Invalid shorthand arguments: ${err.message}`));
        return;
      }
    }

    // Change 4: Check for missing required args and show scaffold
    const { tools } = await target.listTools();
    const tool = tools.find((t) => t.name === toolName);

    if (!tool) {
      console.log(pc.red(`\n  ✗ Tool "${toolName}" not found.`));
      const toolNames = tools.map((t) => t.name);
      const suggestion = suggestCommand(toolName, toolNames);
      if (suggestion) {
        console.log(pc.yellow(`  💡 Did you mean "${suggestion}"?`));
      } else {
        const preview = toolNames.slice(0, 6);
        const more = toolNames.length > 6 ? `, ... (${toolNames.length} total)` : "";
        console.log(pc.dim(`  Available tools: ${preview.join(", ")}${more}`));
      }
      return { isError: true, content: [{ type: "text", text: `Tool not found: ${toolName}` }] };
    }

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
  } else {
    // Interactive tool calling — no JSON provided
    const collectedArgs = await interactiveArgPrompt(target, interceptor, toolName, clearPrevious);
    if (collectedArgs === null) return; // User cancelled or error
    args = collectedArgs;

    // Push fully composed command to history so up-arrow gives the reproducible command
    if (!isScriptMode) {
      const fullCmd = `tools/call ${toolName} ${JSON.stringify(args)}`;
      replHistory.push(fullCmd);
      appendToHistoryFile(fullCmd).catch(() => {});
      if (activeRl) {
        // Update the active Readline instance's internal history array directly
        (activeRl as any).history.unshift(fullCmd);
      }
    }
  }

  console.log(pc.dim(`  Calling ${toolName}...`));
  const startTime = Date.now();

  const result = await interceptor.callTool(target, toolName, args, timeoutMs);

  const elapsed = Date.now() - startTime;

  // Track for timing command
  callHistory.push({ toolName, durationMs: elapsed, timestamp: startTime });

  // Store args for replay on next interactive call
  lastToolArgsMap.set(toolName, { ...args });
  saveWizardDefaults().catch(() => {});

  // Print result with visual separator
  const isError = (result as any).isError === true;

  console.log();
  printResultBlock({
    label: isError ? "Error" : "Result",
    labelColor: isError ? "red" : "green",
    elapsed,
    toolName,
  });

  const content = (result as any).content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === "text") {
        // item.text is untrusted server output. The JSON branches below are safe
        // (JSON.stringify escapes control chars); the raw-text branches must be
        // sanitized to prevent terminal escape (ANSI/OSC) injection.
        const safeText = sanitizeServerText(item.text);
        if (isError) {
          console.log(pc.red(`  ✗ ${safeText}`));
        } else {
          try {
            const parsed = JSON.parse(item.text);
            if (typeof parsed === "object" && parsed !== null) {
              console.log(formatJson(parsed, 2, true));
            } else {
              console.log(pc.yellow(`  ${safeText}`));
            }
          } catch {
            console.log(pc.yellow(`  ${safeText}`));
          }
        }
      } else {
        console.log(formatJson(item, 2, true));
      }
    }
  } else {
    console.log(formatJson(result, 2, true));
  }

  if (isError) {
    const errText = Array.isArray(content)
      ? content
          .map((c) => (c as any).text || "")
          .join(" ")
          .toLowerCase()
      : typeof content === "object"
        ? ((content as any).text || "").toLowerCase()
        : "";

    if (
      errText.includes("argument") ||
      errText.includes("validation") ||
      errText.includes("schema") ||
      errText.includes("missing") ||
      errText.includes("invalid")
    ) {
      console.log(
        pc.yellow(
          `  💡 Tip: Check the tool arguments via 'tools/describe ${toolName}' \n          or view the raw server stderr above.`,
        ),
      );
    }
  }

  console.log();
  return result;
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
  interceptor: ResponseInterceptor,
  toolName: string,
  clearPrevious: boolean = false,
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
  if (isScriptMode) {
    console.log(pc.yellow(`  Tool "${toolName}" requires arguments.`));
    const scaffolded = scaffoldArgs(schema);
    console.log(pc.dim(`  Usage: tools/call ${toolName} ${scaffolded}`));
    return null;
  }

  const required = (schema.required as string[]) ?? [];
  const allProps = Object.entries(properties);
  const requiredProps = allProps.filter(([name]) => required.includes(name));
  const optionalProps = allProps.filter(([name]) => !required.includes(name));

  // Check for remembered args from a previous call
  const previousArgs = clearPrevious ? undefined : lastToolArgsMap.get(toolName);

  // Show tool info
  console.log();
  console.log(`  ${pc.bold(tool.name)}${tool.description ? pc.dim(` — ${tool.description}`) : ""}`);
  if (previousArgs) {
    console.log(pc.dim(`  Previous: ${JSON.stringify(previousArgs)}`));
    console.log(pc.dim("  Press Enter to reuse values, or type to override."));
  }
  console.log();

  const collectedArgs: Record<string, unknown> = {};

  return await withSuspendedReadline(target, interceptor, async () => {
    const abortController = new AbortController();
    const onData = (data: Buffer) => {
      if (data.toString() === "\x1b") {
        abortController.abort();
      }
    };
    process.stdin.on("data", onData);

    try {
      // Phase 2a: Prompt for required args with live JSON template
      for (const [name, prop] of requiredProps) {
        printJsonTemplate(collectedArgs, allProps, name);

        const typeStr = (prop.type as string) ?? "any";
        const desc = (prop.description as string) ?? "";
        const prevVal = previousArgs?.[name];
        const label = desc
          ? `${name} ${pc.dim(`(${typeStr})`)} ${pc.dim(desc)}`
          : `${name} ${pc.dim(`(${typeStr})`)}`;

        const answerStr = await input(
          {
            message: label,
            default: prevVal !== undefined ? String(prevVal) : undefined,
            validate: (val) => {
              if (!val && typeStr !== "string") {
                return "This argument is required and cannot be empty.";
              }
              if (
                val &&
                (typeStr === "number" || typeStr === "integer") &&
                Number.isNaN(Number(val))
              ) {
                return "Must be a valid number.";
              }
              return true;
            },
          },
          { signal: abortController.signal },
        );
        collectedArgs[name] = coerceValue(answerStr, typeStr);
      }

      // Phase 2b: Checkbox toggle for optional args
      if (optionalProps.length > 0) {
        // Pre-select optional args that were used in the previous call
        const previouslyUsedOptionals = previousArgs
          ? optionalProps.filter(([name]) => name in previousArgs).map(([name]) => name)
          : [];

        const selectedNames = await checkbox(
          {
            message: "Select optional arguments to provide:",
            choices: optionalProps.map(([name, prop]) => {
              const typeStr = (prop.type as string) ?? "any";
              const desc = (prop.description as string) ?? "";
              return {
                name: desc ? `${name} (${typeStr}) - ${desc}` : `${name} (${typeStr})`,
                value: name,
                checked: previouslyUsedOptionals.includes(name),
              };
            }),
          },
          { signal: abortController.signal },
        );

        const selectedOptionals = optionalProps.filter(([name]) => selectedNames.includes(name));

        for (const [name, prop] of selectedOptionals) {
          printJsonTemplate(collectedArgs, allProps, name);

          const typeStr = (prop.type as string) ?? "any";
          const desc = (prop.description as string) ?? "";
          const prevVal = previousArgs?.[name];
          const label = desc
            ? `${name} ${pc.dim(`(${typeStr})`)} ${pc.dim(desc)}`
            : `${name} ${pc.dim(`(${typeStr})`)}`;

          const answerStr = await input(
            {
              message: label,
              default: prevVal !== undefined ? String(prevVal) : undefined,
              validate: (val) => {
                if (
                  val &&
                  (typeStr === "number" || typeStr === "integer") &&
                  Number.isNaN(Number(val))
                ) {
                  return "Must be a valid number.";
                }
                return true;
              },
            },
            { signal: abortController.signal },
          );
          collectedArgs[name] = coerceValue(answerStr, typeStr);
        }
      }

      // Show final JSON and confirm execution
      console.log();
      console.log(formatJson(collectedArgs, 2, true));
      const shouldExecute = await confirm(
        { message: "Execute?", default: true },
        { signal: abortController.signal },
      );
      if (!shouldExecute) return null;
      return collectedArgs;
    } catch (err: any) {
      if (!isAbortError(err)) {
        throw err;
      }
      return null;
    } finally {
      process.stdin.off("data", onData);
    }
  });
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
export function question(rl: ReadlineInterface, prompt: string): Promise<string> {
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

async function cmdResourcesRead(
  target: TargetManager,
  rest: string,
  interceptor?: ResponseInterceptor,
): Promise<any> {
  const uri = rest.trim();

  // Change 5: Inline help hint
  if (!uri) {
    // In interactive mode with cached resources: launch the fuzzy picker
    if (!isScriptMode && cachedResourceUris.length > 0 && process.stdin.isTTY && interceptor) {
      const picked = await withSuspendedReadline(target, interceptor, async () => {
        const { resources } = await target.listResources();
        return pickInteractive(
          (resources as any[]).map((r) => ({
            name: r.uri,
            description: r.description || r.name,
          })),
          "Pick a resource to read:",
        );
      });
      if (!picked) return;
      // Recurse with the selected URI
      return cmdResourcesRead(target, picked, interceptor);
    }

    console.log(pc.yellow("  Usage: resources/read <uri>"));
    if (cachedResourceUris.length > 0) {
      const preview = cachedResourceUris.slice(0, 5);
      const more =
        cachedResourceUris.length > 5 ? `, ... (${cachedResourceUris.length} total)` : "";
      console.log(pc.dim(`\n  Available resources: ${preview.join(", ")}${more}`));
    }
    return;
  }

  const startTime = Date.now();
  const result = await target.readResource({ uri });
  const elapsed = Date.now() - startTime;

  console.log();
  printResultBlock({ label: "Resource", labelColor: "cyan", elapsed, detail: uri });

  for (const item of result.contents) {
    if ((item as any).text !== undefined) {
      const text = (item as any).text;
      const safeText = sanitizeServerText(text);
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed === "object" && parsed !== null) {
          console.log(formatJson(parsed, 2, true));
        } else {
          console.log(pc.yellow(`  ${safeText}`));
        }
      } catch {
        console.log(pc.yellow(`  ${safeText}`));
      }
    } else if ((item as any).blob !== undefined) {
      const mimeType = (item as any).mimeType ?? "application/octet-stream";
      const sizeBytes = Buffer.from((item as any).blob, "base64").length;
      console.log(pc.dim(`  [Binary: ${mimeType}, ${sizeBytes} bytes]`));
    } else {
      console.log(formatJson(item, 2, true));
    }
  }

  console.log();
  return result;
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

async function cmdPromptsGet(
  target: TargetManager,
  rest: string,
  interceptor?: ResponseInterceptor,
): Promise<any> {
  const { toolName: promptName, jsonArgs } = parseCallArgs(rest);

  // Change 5: Inline help hint
  if (!promptName) {
    // In interactive mode with cached prompts: launch the fuzzy picker
    if (!isScriptMode && cachedPromptNames.length > 0 && process.stdin.isTTY && interceptor) {
      const picked = await withSuspendedReadline(target, interceptor, async () => {
        const { prompts } = await target.listPrompts();
        return pickInteractive(
          prompts.map((p) => ({ name: p.name, description: p.description })),
          "Pick a prompt to get:",
        );
      });
      if (!picked) return;
      // Recurse with the selected prompt name
      return cmdPromptsGet(target, picked);
    }

    console.log(pc.yellow("  Usage: prompts/get <name> [json_args]"));
    if (cachedPromptNames.length > 0) {
      console.log(pc.dim(`\n  Available prompts: ${cachedPromptNames.join(", ")}`));
    }
    return;
  }

  let promptArgs: Record<string, string> = {};
  if (jsonArgs) {
    const trimmed = jsonArgs.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        promptArgs = JSON.parse(trimmed) as Record<string, string>;
      } catch (err: any) {
        console.error(pc.red(`Invalid JSON: ${err.message}`));
        console.log(pc.dim(`  Received: ${jsonArgs}`));
        return;
      }
    } else {
      try {
        promptArgs = parseHttpieArgs(trimmed) as Record<string, string>;
      } catch (err: any) {
        console.error(pc.red(`Invalid shorthand arguments: ${err.message}`));
        return;
      }
    }
  }

  const { prompts } = await target.listPrompts();
  const prompt = prompts.find((p) => p.name === promptName);
  if (!prompt) {
    console.log(pc.red(`\n  ✗ Prompt "${promptName}" not found.`));
    const promptNames = prompts.map((p) => p.name);
    const suggestion = suggestCommand(promptName, promptNames);
    if (suggestion) {
      console.log(pc.yellow(`  💡 Did you mean "${suggestion}"?`));
    } else {
      console.log(pc.dim(`  Available prompts: ${promptNames.join(", ")}`));
    }
    return { isError: true, content: [{ type: "text", text: `Prompt not found: ${promptName}` }] };
  }
  const startTime = Date.now();
  const result = await target.getPrompt({ name: promptName, arguments: promptArgs });
  const elapsed = Date.now() - startTime;

  if (result.messages.length === 0) {
    console.log(pc.dim("  No messages returned."));
    return;
  }

  console.log();
  printResultBlock({ label: "Prompt", labelColor: "blue", elapsed, detail: promptName });

  for (const msg of result.messages) {
    const role = msg.role === "user" ? pc.blue("user") : pc.magenta("assistant");
    const text = (msg.content as any).text ?? JSON.stringify(msg.content);
    const safeText = sanitizeServerText(text);
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null) {
        console.log(`  ${pc.bold(role)}:`);
        console.log(formatJson(parsed, 4, true));
      } else {
        console.log(`  ${pc.bold(role)}: ${pc.yellow(safeText)}`);
      }
    } catch {
      console.log(`  ${pc.bold(role)}: ${pc.yellow(safeText)}`);
    }
  }

  console.log();
  return result;
}

// ─── Ping ───────────────────────────────────────────────────────────────────

async function cmdPing(target: TargetManager): Promise<void> {
  try {
    const elapsed = await target.ping();
    console.log();
    console.log(pc.green(`  ✓ Pong! Round-trip: ${elapsed}ms`));
    console.log();
  } catch (err: any) {
    console.log();
    console.error(pc.red(`  ✗ Ping failed: ${err.message}`));
    console.log();
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

// ─── Tools Forget ───────────────────────────────────────────────────────────────

function cmdToolsForget(rest: string): void {
  const toolName = rest.trim();
  if (toolName) {
    if (lastToolArgsMap.has(toolName)) {
      lastToolArgsMap.delete(toolName);
      saveWizardDefaults().catch(() => {});
      console.log(pc.green(`  Cleared remembered args for ${pc.bold(toolName)}.`));
    } else {
      console.log(pc.yellow(`  No remembered args for "${toolName}".`));
    }
  } else {
    const count = lastToolArgsMap.size;
    lastToolArgsMap.clear();
    saveWizardDefaults().catch(() => {});
    console.log(pc.green(`  Cleared remembered args for ${count} tool${count === 1 ? "" : "s"}.`));
  }
}

// ─── Interactive Pickers ────────────────────────────────────────────────────

/**
 * Show a fuzzy-search picker for a subset of MCP primitives.
 * Returns the selected name/URI or null if the user cancels (Escape).
 *
 * Used by `tools/call`, `resources/read`, `prompts/get` when invoked without
 * a specific target name, giving users a discoverable way to pick items.
 */
async function pickInteractive(
  items: { name: string; description?: string }[],
  message: string,
): Promise<string | null> {
  if (items.length === 0) return null;

  // Non-TTY fallback: can't show interactive picker
  if (!process.stdin.isTTY) return null;

  const choices = items.map((item) => ({
    name: item.name,
    value: item.name,
    description: item.description || "",
  }));

  try {
    const picked = await search({
      message,
      source: async (term: string | undefined) => {
        if (!term) return choices;
        const lower = term.toLowerCase();
        return choices.filter(
          (c) =>
            c.name.toLowerCase().includes(lower) || c.description.toLowerCase().includes(lower),
        );
      },
    });
    return picked as string;
  } catch (err: any) {
    if (isAbortError(err)) return null;
    throw err;
  }
}

// ─── Interactive Menu Loop ──────────────────────────────────────────────────────

async function showMainMenu(
  target: TargetManager,
  interceptor: ResponseInterceptor,
): Promise<boolean> {
  const choices: { name: string; value: any; description: string }[] = [];

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
  } catch {
    // ignore
  }

  if (caps.resources) {
    try {
      const { resources } = await target.listResources();
      for (const r of resources as any[]) {
        choices.push({
          name: `📄 Resource: ${r.name || r.uri}`,
          value: { type: "resource", uri: r.uri },
          description: r.description || `Read resource ${r.uri}`,
        });
      }
    } catch {
      // ignore
    }
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
    } catch {
      // ignore
    }
  }

  // Add system commands
  choices.push({
    name: "⚙️  Check Server Status",
    value: { type: "command", name: "status" },
    description: "View connection status and server info",
  });
  choices.push({
    name: "🔄 Reconnect Server",
    value: { type: "command", name: "reconnect" },
    description: "Restart the target MCP server",
  });
  choices.push({
    name: "⌨️  Type a raw command",
    value: { type: "raw" },
    description: "Drop to the traditional REPL prompt (use 'menu' to return)",
  });
  choices.push({
    name: "🚪 Exit",
    value: { type: "command", name: "exit" },
    description: "Close connection and exit",
  });

  // Non-TTY fallback: shouldn't normally happen because mainMenuLoop handles isTTY
  if (!process.stdin.isTTY) return false;

  try {
    const answer = (await search({
      message: "Select an action (start typing to search):",
      source: async (term: string | undefined) => {
        if (!term) return choices;
        const lower = term.toLowerCase();
        return choices.filter(
          (c) =>
            c.name.toLowerCase().includes(lower) || c.description.toLowerCase().includes(lower),
        );
      },
    })) as any;

    if (answer.type === "tool") {
      await cmdToolsCall(target, interceptor, answer.name);
    } else if (answer.type === "resource") {
      await cmdResourcesRead(target, answer.uri);
    } else if (answer.type === "prompt") {
      await cmdPromptsGet(target, answer.name);
    } else if (answer.type === "command") {
      if (answer.name === "status") {
        cmdStatus(target);
      } else if (answer.name === "reconnect") {
        await cmdReconnect(target);
      } else if (answer.name === "exit") {
        console.log(pc.dim("\nShutting down..."));
        await target.close();
        process.exit(0);
      }
    } else if (answer.type === "raw") {
      return true; // Signal to enter raw prompt
    }
    return false; // Remain in menu loop
  } catch (err: any) {
    if (isAbortError(err)) {
      console.log(pc.dim("\nShutting down..."));
      await target.close();
      process.exit(0);
    }
    throw err;
  }
}

export async function mainMenuLoop(target: TargetManager, interceptor: ResponseInterceptor) {
  if (isScriptMode || !process.stdin.isTTY) {
    startReadlineLoop(target, interceptor);
    return;
  }

  while (true) {
    try {
      const dropToRaw = await showMainMenu(target, interceptor);
      if (dropToRaw) {
        console.log(pc.dim("  Entering raw command mode. Type 'menu' to return."));
        startReadlineLoop(target, interceptor);
        break; // Exit the menu loop, readline takes over
      }
    } catch (err: any) {
      console.error(pc.red(`Error in menu: ${err.message}`));
      // Fallback to readline on fatal error
      startReadlineLoop(target, interceptor);
      break;
    }
  }
}
