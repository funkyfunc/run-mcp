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
 *   - Exit codes follow sysexits(3):
 *       0   success
 *       1   the tool reported isError, or a session/daemon error
 *       64  usage error (bad args, missing target command)
 *       65  malformed input data (invalid JSON arguments)
 *       66  the target command was not found
 *       69  the target server failed to start or connect
 */

import { ResponseInterceptor } from "./interceptor.js";
import { parseHttpieArgs } from "./parsing.js";
import { TargetManager, type TransportMode } from "./target-manager.js";

/** Default timeout for headless tool calls (30 seconds). */
export const DEFAULT_HEADLESS_TIMEOUT_MS = 30_000;

export interface HeadlessOptions {
  outDir?: string;
  timeoutMs?: number;
  raw?: boolean;
  showStderr?: boolean;
  mediaThresholdKb?: number;
  transport?: TransportMode;
  /** Extra environment variables for the target process (`--env KEY=VAL`). */
  env?: Record<string, string>;
}

export type HeadlessOperation =
  | { type: "call"; tool: string; args?: string }
  | { type: "list-tools" }
  | { type: "list-resources" }
  | { type: "list-prompts" }
  | { type: "read"; uri: string }
  | { type: "describe"; tool: string }
  | { type: "get-prompt"; name: string; args?: string }
  | { type: "stderr"; count?: number }
  | { type: "reconnect" };

/** What an operation produced, plus the target stderr it generated on the way. */
export interface OperationOutcome {
  result: unknown;
  hasError: boolean;
  /**
   * Target stderr lines written while this operation ran. Only populated when
   * the caller asked for them (`--show-stderr` in session mode, where the
   * daemon holds the pipe and the caller can't stream it live).
   */
  stderr?: string[];
}

/**
 * Target stderr lines written after `startCount` lines had already been seen.
 * The TargetManager keeps a bounded buffer, so the window is clamped to what
 * is still retained.
 */
export function stderrSince(target: TargetManager, startCount: number): string[] {
  const all = target.getStderrLines();
  const total = target.getStatus().stderrLineCount;
  const fresh = Math.max(0, total - startCount);
  return fresh >= all.length ? all : all.slice(all.length - fresh);
}

/**
 * Give the target's trailing stderr a moment to arrive. Stdout and stderr are
 * separate pipes, so a line written just before the JSON-RPC response can
 * still be in flight when the response has already been parsed.
 */
async function settleStderr(): Promise<void> {
  await new Promise((r) => setTimeout(r, 30));
}

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
    transport: opts.transport,
    env: opts.env,
  });
  const interceptor = new ResponseInterceptor({
    outDir: opts.outDir,
    defaultTimeoutMs: opts.timeoutMs ?? DEFAULT_HEADLESS_TIMEOUT_MS,
    mediaThresholdKb: opts.mediaThresholdKb,
  });

  if (operation.type === "reconnect") {
    process.stderr.write(
      "Error: reconnect restarts the server behind a running session; pass --session <name>.\n" +
        "Without a session every command already starts a fresh server.\n",
    );
    process.exit(64);
  }

  // Stream or suppress server stderr
  if (opts.showStderr) {
    target.on("stderr", (text) => {
      process.stderr.write(`${text}\n`);
    });
  } else {
    target.on("stderr", () => {});
  }

  try {
    process.stderr.write(`Connecting to ${targetCommand.join(" ")}...\n`);
    await target.connect();
    const status = target.getStatus();
    process.stderr.write(`Connected (PID: ${status.pid})\n`);

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

    // A server that dies on connect explains itself on stderr — surface it here
    // rather than discarding it with the process (the agent server does the same).
    if (!opts.showStderr) {
      await target.waitForStderr();
      const lines = target.getStderrLines(40);
      if (lines.length > 0) {
        process.stderr.write(`--- Target server stderr ---\n${lines.join("\n")}\n`);
      }
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
  /**
   * Stderr lines already seen before this operation began. Zero (the default)
   * means "everything since spawn", which is what a one-shot run wants; a
   * session daemon passes the current count so the window covers this call only.
   */
  stderrStart = 0,
): Promise<OperationOutcome> {
  const outcome = await runOperation(target, interceptor, operation, opts, stderrStart);
  if (opts.showStderr && stderrStart > 0) {
    await settleStderr();
    outcome.stderr = stderrSince(target, stderrStart);
  }
  return outcome;
}

/**
 * Parse a positional argument string as either a JSON object or HTTPie-style
 * `key=value` shorthand. Exits 65 on malformed JSON.
 */
function parseArgsString(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      return JSON.parse(trimmed);
    } catch (err: any) {
      process.stderr.write(`Error: Invalid JSON arguments: ${err.message}\n`);
      process.stderr.write(`  Received: ${raw}\n`);
      process.exit(65);
    }
  }
  return parseHttpieArgs(trimmed);
}

async function runOperation(
  target: TargetManager,
  interceptor: ResponseInterceptor,
  operation: HeadlessOperation,
  opts: HeadlessOptions,
  stderrStart: number,
): Promise<OperationOutcome> {
  switch (operation.type) {
    case "call": {
      const parsedArgs = parseArgsString(operation.args);
      const result = await interceptor.callTool(target, operation.tool, parsedArgs);

      // `--raw` is the "give me everything" envelope, so it also carries what the
      // server wrote to stderr during this call — as data, not as a stream the
      // caller has to disentangle from stdout.
      if (opts.raw) {
        await settleStderr();
        (result as Record<string, unknown>).stderr = stderrSince(target, stderrStart);
      }

      const hasError = (result as any).isError === true;
      if (hasError) {
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
      }

      // Still output the result on error, for programmatic consumption.
      if (opts.raw) return { result, hasError };
      return { result: (result as any).content ?? result, hasError };
    }

    case "list-tools": {
      const { tools } = await target.listAllTools();
      return { result: tools, hasError: false };
    }

    case "list-resources": {
      const { resources } = await target.listAllResources();
      return { result: resources, hasError: false };
    }

    case "list-prompts": {
      const { prompts } = await target.listAllPrompts();
      return { result: prompts, hasError: false };
    }

    case "read": {
      const result = await interceptor.readResource(target, { uri: operation.uri });
      return { result, hasError: false };
    }

    case "describe": {
      const { tools } = await target.listAllTools();
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
      const parsedArgs = operation.args
        ? (parseArgsString(operation.args) as Record<string, string>)
        : undefined;
      const result = await interceptor.getPrompt(target, {
        name: operation.name,
        arguments: parsedArgs,
      });
      return { result, hasError: false };
    }

    case "stderr": {
      await settleStderr();
      return { result: target.getStderrLines(operation.count), hasError: false };
    }

    case "reconnect": {
      // Only meaningful for a long-lived target; the session daemon handles it
      // (it owns the TargetManager and has to swap it out). runHeadless rejects
      // it before we get here.
      throw new Error("reconnect is only available with --session");
    }
  }
}
