/**
 * Headless single-shot executor for CLI subcommands.
 *
 * Connects to a target MCP server, executes exactly one operation,
 * writes the JSON result to stdout, and exits. All status/progress
 * messages go to stderr so stdout remains pipe-clean.
 *
 * Design principles:
 *   - stdout: only machine-parseable JSON, no ANSI, no extra text
 *   - stderr: human-readable status (connecting, timing, errors)
 *   - Exit 0: success
 *   - Exit 1: tool error, connection failure, or server error
 *   - Exit 2: usage error (bad args, missing target command)
 */

import { ResponseInterceptor } from "./interceptor.js";
import { TargetManager } from "./target-manager.js";

/** Default timeout for headless tool calls (30 seconds). */
const DEFAULT_HEADLESS_TIMEOUT_MS = 30_000;

export interface HeadlessOptions {
  outDir?: string;
  timeoutMs?: number;
  raw?: boolean;
}

export type HeadlessOperation =
  | { type: "call"; tool: string; args?: string }
  | { type: "list-tools" }
  | { type: "list-resources" }
  | { type: "list-prompts" }
  | { type: "read"; uri: string }
  | { type: "describe"; tool: string }
  | { type: "get-prompt"; name: string; args?: string };

/**
 * Connect → execute one operation → print JSON to stdout → exit.
 *
 * All status messages go to stderr. Only the JSON result is written
 * to stdout so the output can be piped directly into jq, etc.
 */
export async function runHeadless(
  targetCommand: string[],
  operation: HeadlessOperation,
  opts: HeadlessOptions = {},
): Promise<void> {
  const [command, ...args] = targetCommand;
  const target = new TargetManager(command, args);
  const interceptor = new ResponseInterceptor({
    outDir: opts.outDir,
    defaultTimeoutMs: opts.timeoutMs ?? DEFAULT_HEADLESS_TIMEOUT_MS,
  });

  // Suppress server stderr by default — don't pollute the terminal
  // (errors are surfaced through the MCP protocol response)
  target.on("stderr", () => {});

  try {
    process.stderr.write(`Connecting to ${targetCommand.join(" ")}...\n`);
    await target.connect();

    const status = target.getStatus();
    process.stderr.write(`Connected (PID: ${status.pid})\n`);

    const result = await executeOperation(target, interceptor, operation, opts);

    // Write clean JSON to stdout
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

    await target.close();
    process.exit(0);
  } catch (err: any) {
    const msg = err.message ?? String(err);

    // Detect connection errors and provide actionable messages
    if (msg.includes("ENOENT") || msg.includes("spawn")) {
      process.stderr.write(
        `Error: command "${command}" not found. Check that it is installed and in your PATH.\n`,
      );
    } else if (msg.includes("timed out")) {
      process.stderr.write(`Error: ${msg}\n`);
    } else {
      process.stderr.write(`Error: ${msg}\n`);
    }

    await target.close().catch(() => {});
    process.exit(1);
  }
}

/**
 * Execute the requested operation and return the result to be printed.
 *
 * For `call`, returns the content array by default or the full result
 * envelope when `--raw` is specified.
 */
async function executeOperation(
  target: TargetManager,
  interceptor: ResponseInterceptor,
  operation: HeadlessOperation,
  opts: HeadlessOptions,
): Promise<unknown> {
  switch (operation.type) {
    case "call": {
      let parsedArgs: Record<string, unknown> = {};
      if (operation.args) {
        try {
          parsedArgs = JSON.parse(operation.args);
        } catch (err: any) {
          process.stderr.write(`Error: Invalid JSON arguments: ${err.message}\n`);
          process.stderr.write(`  Received: ${operation.args}\n`);
          process.exit(2);
        }
      }

      const result = await interceptor.callTool(target, operation.tool, parsedArgs);

      // Check for isError and exit 1
      if ((result as any).isError) {
        const content = (result as any).content;
        if (Array.isArray(content)) {
          const errorText = content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n");
          if (errorText) {
            process.stderr.write(`Tool error: ${errorText}\n`);
          }
        }
        // Still output the result for programmatic consumption
        if (opts.raw) return result;
        return (result as any).content ?? result;
      }

      if (opts.raw) return result;
      return (result as any).content ?? result;
    }

    case "list-tools": {
      const { tools } = await target.listTools();
      return tools;
    }

    case "list-resources": {
      const { resources } = await target.listResources();
      return resources;
    }

    case "list-prompts": {
      const { prompts } = await target.listPrompts();
      return prompts;
    }

    case "read": {
      const result = await target.readResource({ uri: operation.uri });
      return result;
    }

    case "describe": {
      const { tools } = await target.listTools();
      const tool = tools.find((t) => t.name === operation.tool);
      if (!tool) {
        const available = tools.map((t) => t.name).join(", ");
        process.stderr.write(
          `Error: Tool "${operation.tool}" not found.\n` + `Available tools: ${available}\n`,
        );
        process.exit(1);
      }
      return tool;
    }

    case "get-prompt": {
      let parsedArgs: Record<string, string> | undefined;
      if (operation.args) {
        try {
          parsedArgs = JSON.parse(operation.args);
        } catch (err: any) {
          process.stderr.write(`Error: Invalid JSON arguments: ${err.message}\n`);
          process.stderr.write(`  Received: ${operation.args}\n`);
          process.exit(2);
        }
      }

      const result = await target.getPrompt({
        name: operation.name,
        arguments: parsedArgs,
      });
      return result;
    }
  }
}
