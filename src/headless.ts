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
import { parseHttpieArgs } from "./parsing.js";
import { TargetManager } from "./target-manager.js";
import { Cassette, type CassetteMode } from "./cassette.js";

/** Default timeout for headless tool calls (30 seconds). */
const DEFAULT_HEADLESS_TIMEOUT_MS = 30_000;

export interface HeadlessOptions {
  outDir?: string;
  timeoutMs?: number;
  raw?: boolean;
  showStderr?: boolean;
  sandbox?: "auto" | "docker" | "native" | "audit" | "none";
  allowRead?: string[];
  allowWrite?: string[];
  allowNet?: string[];
  denyRead?: string[];
  denyWrite?: string[];
  denyNet?: string[];
  cassettePath?: string;
  cassetteMode?: CassetteMode;
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
  const target = new TargetManager(command, args, {
    sandbox: opts.sandbox,
    allowRead: opts.allowRead,
    allowWrite: opts.allowWrite,
    allowNet: opts.allowNet,
    denyRead: opts.denyRead,
    denyWrite: opts.denyWrite,
    denyNet: opts.denyNet,
  });
  const cassette = opts.cassettePath
    ? new Cassette(opts.cassettePath, opts.cassetteMode ?? "auto")
    : undefined;
  const interceptor = new ResponseInterceptor({
    outDir: opts.outDir,
    defaultTimeoutMs: opts.timeoutMs ?? DEFAULT_HEADLESS_TIMEOUT_MS,
    cassette,
  });

  // Stream or suppress server stderr
  if (opts.showStderr) {
    target.on("stderr", (text) => {
      process.stderr.write(`${text}\n`);
    });
  } else {
    target.on("stderr", () => {});
  }

  // In replay mode, interceptor-routed operations (call/read/get-prompt) are
  // served from the cassette, so we can run fully offline without spawning the
  // target. List operations still need a live server.
  const replayableOffline = new Set(["call", "read", "get-prompt"]);
  const skipConnect = cassette?.mode === "replay" && replayableOffline.has(operation.type);

  try {
    if (skipConnect) {
      process.stderr.write(`Replaying from cassette (offline)...\n`);
    } else {
      process.stderr.write(`Connecting to ${targetCommand.join(" ")}...\n`);
      await target.connect();
      const status = target.getStatus();
      process.stderr.write(`Connected (PID: ${status.pid})\n`);
    }

    const { result, hasError } = await executeOperation(target, interceptor, operation, opts);

    // Write clean JSON to stdout
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

    await target.close();
    process.exit(hasError ? 1 : 0);
  } catch (err: any) {
    const msg = err.message ?? String(err);

    // Detect connection errors and provide actionable messages
    let exitCode: number;
    if (msg.includes("ENOENT") || msg.includes("spawn")) {
      process.stderr.write(
        `Error: command "${command}" not found. Check that it is installed and in your PATH.\n`,
      );
      exitCode = 66; // EX_NOINPUT
    } else {
      process.stderr.write(`Error: ${msg}\n`);
      exitCode = 69; // EX_UNAVAILABLE
    }

    await target.close().catch(() => {});
    process.exit(exitCode);
  }
}

/**
 * Execute the requested operation and return the result to be printed.
 *
 * For `call`, returns the content array by default or the full result
 * envelope when `--raw` is specified.
 */
export async function executeOperation(
  target: TargetManager,
  interceptor: ResponseInterceptor,
  operation: HeadlessOperation,
  opts: HeadlessOptions,
): Promise<{ result: unknown; hasError: boolean }> {
  switch (operation.type) {
    case "call": {
      let parsedArgs: Record<string, unknown> = {};
      if (operation.args) {
        const trimmed = operation.args.trim();
        if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
          try {
            parsedArgs = JSON.parse(trimmed);
          } catch (err: any) {
            process.stderr.write(`Error: Invalid JSON arguments: ${err.message}\n`);
            process.stderr.write(`  Received: ${operation.args}\n`);
            process.exit(65);
          }
        } else {
          parsedArgs = parseHttpieArgs(trimmed);
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
        if (opts.raw) return { result, hasError: true };
        return { result: (result as any).content ?? result, hasError: true };
      }

      if (opts.raw) return { result, hasError: false };
      return { result: (result as any).content ?? result, hasError: false };
    }

    case "list-tools": {
      const { tools } = await target.listTools();
      return { result: tools, hasError: false };
    }

    case "list-resources": {
      const { resources } = await target.listResources();
      return { result: resources, hasError: false };
    }

    case "list-prompts": {
      const { prompts } = await target.listPrompts();
      return { result: prompts, hasError: false };
    }

    case "read": {
      const result = await interceptor.readResource(target, { uri: operation.uri });
      return { result, hasError: false };
    }

    case "describe": {
      const { tools } = await target.listTools();
      const tool = tools.find((t) => t.name === operation.tool);
      if (!tool) {
        const available = tools.map((t) => t.name).join(", ");
        process.stderr.write(
          `Error: Tool "${operation.tool}" not found.\n` + `Available tools: ${available}\n`,
        );
        process.exit(64);
      }
      return { result: tool, hasError: false };
    }

    case "get-prompt": {
      let parsedArgs: Record<string, string> | undefined;
      if (operation.args) {
        const trimmed = operation.args.trim();
        if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
          try {
            parsedArgs = JSON.parse(trimmed) as Record<string, string>;
          } catch (err: any) {
            process.stderr.write(`Error: Invalid JSON arguments: ${err.message}\n`);
            process.stderr.write(`  Received: ${operation.args}\n`);
            process.exit(65);
          }
        } else {
          parsedArgs = parseHttpieArgs(trimmed) as Record<string, string>;
        }
      }

      const result = await interceptor.getPrompt(target, {
        name: operation.name,
        arguments: parsedArgs,
      });
      return { result, hasError: false };
    }
  }
}
