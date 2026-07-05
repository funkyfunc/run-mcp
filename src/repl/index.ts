import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { colors as pc } from "../colors.js";
import { ResponseInterceptor } from "../interceptor.js";
import { groupToolsByPrefix, interpolateString } from "../parsing.js";
import { type Snapshot, computeSnapshotDiff, takeSnapshot } from "../snapshot.js";
import type { ServerNotification } from "../target-manager.js";
import { TargetManager } from "../target-manager.js";
import { FileWatcher } from "../watcher.js";
import {
  activeRl,
  setActiveRl,
  closed,
  setClosed,
  isScriptMode,
  setIsScriptMode,
  globalPauseReadlineClose,
  deferNextPrompt,
  setDeferNextPrompt,
  cachedToolNames,
} from "./state.js";
import { replHistory, loadHistory, appendToHistoryFile } from "./history.js";
import { loadWizardDefaults } from "./wizard.js";
import { printBanner } from "./ui.js";
import { completer, refreshCaches, resetTabCycle } from "./completer.js";
import { handleCommand, mainMenuLoop, AbortFlowError, question } from "./commands.js";

interface ReplOptions {
  script?: string;
  outDir?: string;
  mediaThresholdKb?: number;
  openMedia?: boolean;
  watch?: boolean;
  sandbox?: "auto" | "docker" | "native" | "audit" | "none";
  allowRead?: string[];
  allowWrite?: string[];
  allowNet?: string[];
  denyRead?: string[];
  denyWrite?: string[];
  denyNet?: string[];
}

function getPrompt(target: TargetManager): string {
  if (target.connected) return `${pc.green("✓")}${pc.cyan("> ")}`;
  return `${pc.red("✗")}${pc.cyan("> ")}`;
}

export function startReadlineLoop(target: TargetManager, interceptor: ResponseInterceptor) {
  if (isScriptMode || activeRl) return;

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: getPrompt(target),
    terminal: true,
    completer,
    history: [...replHistory].reverse(), // Node's readline history expects newest first
  });

  setActiveRl(rl);
  setClosed(false);

  // Reset tab cycling on any non-tab keypress
  if (process.stdin.isTTY) {
    process.stdin.on("keypress", (_str: string, key: any) => {
      if (!key || key.name !== "tab") {
        resetTabCycle();
      }
    });
  }

  // When resuming after withSuspendedReadline, defer the prompt
  // so the calling command handler can finish its output first.
  if (!deferNextPrompt) {
    rl.prompt();
  }
  setDeferNextPrompt(false);

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
        if (err instanceof AbortFlowError) {
          console.log(pc.yellow("  Aborted."));
        } else if (err?.message?.includes("-32601") || err?.code === -32601) {
          let msg = "Server does not support this feature (Method not found)";
          if (trimmed.startsWith("prompts/")) msg = "This server does not have any prompts.";
          else if (trimmed.startsWith("resources/"))
            msg = "This server does not have any resources.";
          else if (trimmed.startsWith("tools/")) msg = "This server does not have any tools.";
          console.log(pc.yellow(`  ${msg}`));
        } else {
          console.error(pc.red(`✗ Error: ${err.message}`));
        }
      }
      if (activeRl) {
        setImmediate(() => {
          if (activeRl) {
            console.log();
            activeRl.setPrompt(getPrompt(target));
            activeRl.prompt();
          }
        });
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
    replHistory.push(trimmed);
    appendToHistoryFile(trimmed).catch(() => {});
    queue.push(trimmed);
    processQueue();
  });

  rl.on("close", async () => {
    setClosed(true);
    setActiveRl(null);

    if (!globalPauseReadlineClose) {
      console.log(pc.dim("\nShutting down..."));
      await target.close();
      process.exit(0);
    }
  });
}

export async function startRepl(targetCommand: string[], opts: ReplOptions): Promise<void> {
  const [command, ...args] = targetCommand;
  const target = new TargetManager(command, args, {
    sandbox: opts.sandbox,
    allowRead: opts.allowRead,
    allowWrite: opts.allowWrite,
    allowNet: opts.allowNet,
    denyRead: opts.denyRead,
    denyWrite: opts.denyWrite,
    denyNet: opts.denyNet,
  });
  const interceptor = new ResponseInterceptor({
    outDir: opts.outDir,
    mediaThresholdKb: opts.mediaThresholdKb,
    openMedia: opts.openMedia,
  });

  setIsScriptMode(!!opts.script);

  if (!isScriptMode) {
    await loadHistory();
    await loadWizardDefaults();
  }

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

  // ─── Watch mode ──────────────────────────────────────────────────────────

  let watchSnapshot: Snapshot | null = null;

  if (opts.watch && !isScriptMode) {
    const watchPath = process.cwd();
    const watcher = new FileWatcher(watchPath);

    // Take initial snapshot for diffing
    watchSnapshot = await takeSnapshot(target);

    watcher.on("change", async ({ files }: { files: string[] }) => {
      const displayFiles =
        files.length <= 3
          ? files.join(", ")
          : `${files.slice(0, 3).join(", ")} (+${files.length - 3} more)`;

      console.log();
      console.log(pc.cyan(`  ⟳ File change detected: ${displayFiles}`));
      console.log(pc.dim("    Reconnecting..."));

      try {
        await target.close();
        await new Promise((resolve) => setTimeout(resolve, 200));
        await target.connect();
        const s = target.getStatus();
        console.log(pc.green(`  ✓ Reconnected (PID: ${s.pid})`));

        // Compute and display diff
        const newSnapshot = await takeSnapshot(target);
        if (watchSnapshot) {
          const diffLines = computeSnapshotDiff(watchSnapshot, newSnapshot);
          if (diffLines.length > 0) {
            for (const line of diffLines) {
              console.log(pc.dim(`  ${line}`));
            }
          }
        }
        watchSnapshot = newSnapshot;

        // Refresh tab completion caches
        await refreshCaches(target);

        // Re-prompt if readline is active
        if (activeRl) {
          activeRl.setPrompt(getPrompt(target));
          activeRl.prompt();
        }
      } catch (err: any) {
        console.error(pc.red(`  ✗ Reconnect failed: ${err.message}`));
        console.log(pc.dim("    Fix the issue and save again, or use 'reconnect' manually."));
        if (activeRl) {
          activeRl.setPrompt(getPrompt(target));
          activeRl.prompt();
        }
      }
    });

    watcher.on("error", (err: Error) => {
      console.error(pc.yellow(`  ⚠ Watch error: ${err.message}`));
    });

    watcher.start();
    console.log(pc.dim(`  👁 Watching ${watchPath} for changes`));

    // Clean up watcher on process exit
    const cleanup = () => watcher.stop();
    process.on("exit", cleanup);
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  }

  // ─── Startup: gather counts + show banner ─────────────────────────────────

  let toolCount: number;
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

    const isHarness = serverName === "run-mcp";
    printBanner(serverName, serverVersion, toolCount, resourceCount, promptCount, isHarness);

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
    const scriptContext: Record<string, any> = {};
    let expectError = false;

    for (const line of lines) {
      let trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        if (trimmed === "# @expect-error") {
          expectError = true;
        }
        continue;
      }

      if (trimmed.endsWith("# @expect-error")) {
        expectError = true;
        trimmed = trimmed.replace(/\s*#\s*@expect-error$/, "");
      }

      const interpolated = interpolateString(trimmed, scriptContext);

      try {
        const res = await handleCommand(interpolated, target, interceptor);
        if (res !== undefined) {
          scriptContext.LAST = res;
        }

        const isErrorRes = res && typeof res === "object" && res.isError === true;

        if (expectError && !isErrorRes) {
          console.error(pc.red(`✗ Expected an error but the command succeeded.`));
          await target.close();
          process.exit(1);
        }
        if (!expectError && isErrorRes) {
          console.error(pc.red(`✗ Command failed unexpectedly.`));
          await target.close();
          process.exit(1);
        }
        if (expectError && isErrorRes) {
          console.log(pc.yellow(`  ✓ Expected error caught: tool returned isError: true`));
        }
      } catch (err: any) {
        if (expectError) {
          console.log(pc.yellow(`  ✓ Expected error caught: ${err.message}`));
        } else {
          if (err?.message?.includes("-32601") || err?.code === -32601) {
            let msg = "Server does not support this feature (Method not found)";
            if (trimmed.startsWith("prompts/")) msg = "This server does not have any prompts.";
            else if (trimmed.startsWith("resources/"))
              msg = "This server does not have any resources.";
            else if (trimmed.startsWith("tools/")) msg = "This server does not have any tools.";
            console.log(pc.yellow(`  ${msg}`));
          } else {
            console.error(pc.red(`✗ Error: ${err.message}`));
          }
          console.log(pc.dim("\nShutting down..."));
          await target.close();
          process.exit(1);
        }
      }

      expectError = false;
    }

    console.log(pc.dim("\nShutting down..."));
    await target.close();
    process.exit(0);
  } else {
    // Interactive mode: start the main menu loop
    mainMenuLoop(target, interceptor);
  }
}

/**
 * Read all lines from a script file.
 */
async function readScriptLines(filepath: string): Promise<string[]> {
  const content = await readFile(filepath, "utf8");
  return content.split("\n");
}
