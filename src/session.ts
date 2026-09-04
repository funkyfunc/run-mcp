/**
 * Persistent headless sessions: the shell dev loop.
 *
 * `run-mcp call … --session dev -- node server.js` spawns a detached daemon
 * that keeps the target running; every later command with the same name
 * attaches to it over a local socket and gets an answer without a cold start.
 *
 * Three pieces live here:
 *   - the session record on disk (`$TMPDIR/run-mcp/sessions/<name>.json`) and
 *     the pure checks against it (`describeSessionMismatch`)
 *   - the client side: `spawnSessionDaemon`, `sendDaemonRequest`, `closeSession`
 *   - the daemon itself: `runSessionDaemon`
 *
 * Transport is a Unix domain socket inside the owner-only session directory
 * (a named pipe on Windows), so no other local user can reach the target.
 */

import { createHash } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { TargetManager, type TransportMode } from "./target-manager.js";
import { ResponseInterceptor } from "./interceptor.js";
import {
  DEFAULT_HEADLESS_TIMEOUT_MS,
  executeOperation,
  type HeadlessOperation,
  type HeadlessOptions,
  type OperationOutcome,
} from "./headless.js";
import { validateProtocol, type ValidationReport } from "./validator.js";
import { computeSnapshotDiff, takeSnapshot } from "./snapshot.js";

export const SESSION_DIR = join(tmpdir(), "run-mcp", "sessions");

export interface SessionData {
  /** Where the daemon listens: a Unix socket path, or a Windows named pipe. */
  socketPath: string;
  pid: number;
  /** The server command the daemon was started with. */
  command: string[];
  /** Where it was started — a relative `node server.js` means a different server elsewhere. */
  cwd: string;
  /** Extra env the target was spawned with (`--env`). */
  env: Record<string, string>;
  /** Epoch ms. */
  startedAt: number;
  /** Auto-close after this long without a request; absent = never. */
  idleTimeoutMs?: number;
}

/**
 * Written in place of SessionData when the daemon's first connect fails, so the
 * client that spawned it can report the server's own stderr instead of a
 * generic "failed to spawn". Consumed (deleted) by that client.
 */
export interface SessionFailure {
  failed: true;
  error: string;
  stderr: string[];
}

export interface SessionSpawnOptions {
  transport?: TransportMode;
  idleTimeoutMs?: number;
  env?: Record<string, string>;
}

/** Thrown by the client side; `exitCode` follows sysexits(3). */
export class SessionError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = "SessionError";
  }
}

// ─── Session record ──────────────────────────────────────────────────────────

const SESSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Session names become file names; keep them to a safe character set. */
export function assertValidSessionName(name: string): void {
  if (!SESSION_NAME_PATTERN.test(name)) {
    throw new SessionError(
      `Session name "${name}" is invalid. Use letters, digits, ".", "_" or "-" (e.g. "dev").`,
      64,
    );
  }
}

export function getSessionPath(name: string): string {
  return join(SESSION_DIR, `${name}.json`);
}

/**
 * Where the daemon for `name` listens. Unix socket paths have a short hard
 * limit (104 bytes on macOS), so a long name falls back to a hash.
 */
export function getSocketPath(name: string): string {
  if (process.platform === "win32") return `\\\\.\\pipe\\run-mcp-${name}`;
  const direct = join(SESSION_DIR, `${name}.sock`);
  if (direct.length <= 96) return direct;
  const short = createHash("sha1").update(name).digest("hex").slice(0, 16);
  return join(SESSION_DIR, `${short}.sock`);
}

export async function readSessionFile(name: string): Promise<SessionData | SessionFailure | null> {
  const path = getSessionPath(name);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function removeSessionFiles(name: string): Promise<void> {
  await rm(getSessionPath(name), { force: true }).catch(() => {});
  if (process.platform !== "win32") {
    await rm(getSocketPath(name), { force: true }).catch(() => {});
  }
}

/** A live session, or null. Prunes the files if the daemon is gone. */
export async function getSession(name: string): Promise<SessionData | null> {
  const parsed = await readSessionFile(name);
  if (!parsed || "failed" in parsed || !("socketPath" in parsed)) return null;
  try {
    process.kill(parsed.pid, 0);
    return parsed;
  } catch {
    await removeSessionFiles(name);
    return null;
  }
}

/** Every live session (dead ones are pruned on the way), oldest first. */
export async function listSessions(): Promise<Array<SessionData & { name: string }>> {
  if (!existsSync(SESSION_DIR)) return [];
  const names = (await readdir(SESSION_DIR))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length));
  const live: Array<SessionData & { name: string }> = [];
  for (const name of names) {
    const session = await getSession(name);
    if (session) live.push({ name, ...session });
  }
  return live.sort((a, b) => a.startedAt - b.startedAt);
}

export function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

/** Keys whose values differ between two env maps (missing counts as different). */
function differingEnvKeys(a: Record<string, string>, b: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => a[k] !== b[k]).sort();
}

/**
 * Why an existing session can't serve the caller's request, or null if it can.
 *
 * Attaching with an explicit command that isn't the one the session runs is
 * almost always a mistake (two projects sharing a name, or an edited command
 * the caller expects to take effect), so it is refused rather than quietly
 * answered from the wrong server. The same goes for a different `--env`.
 * Attaching with no command and no env always works.
 */
export function describeSessionMismatch(
  name: string,
  session: Pick<SessionData, "command" | "cwd" | "env">,
  asked: { command?: string[]; cwd: string; env?: Record<string, string> },
): string | null {
  const problems: string[] = [];

  if (asked.command && asked.command.length > 0) {
    const sameCommand = JSON.stringify(asked.command) === JSON.stringify(session.command);
    const sameCwd = session.cwd === asked.cwd;
    if (!sameCommand || !sameCwd) {
      problems.push(
        `running: ${session.command.join(" ")}  (in ${session.cwd})`,
        `asked:   ${asked.command.join(" ")}  (in ${asked.cwd})`,
      );
    }
  }

  if (asked.env) {
    const differing = differingEnvKeys(session.env ?? {}, asked.env);
    if (differing.length > 0) {
      // Values may be secrets: name the keys, not what they hold.
      problems.push(`env differs for: ${differing.join(", ")}`);
    }
  }

  if (problems.length === 0) return null;
  return [
    `Session "${name}" is already running a different server.`,
    ...problems.map((p) => `  ${p}`),
    `Either omit the command (and --env) to use the running server, run \`run-mcp close-session ${name}\` first, ` +
      "or pick another session name.",
  ].join("\n");
}

// ─── Client side ─────────────────────────────────────────────────────────────

interface DaemonRequest {
  jsonrpc: "2.0";
  method: "execute" | "validate" | "close";
  params: unknown;
  id: number;
}

export function sendDaemonRequest<T = OperationOutcome>(
  session: SessionData,
  method: DaemonRequest["method"],
  params: unknown = {},
): Promise<T> {
  const request: DaemonRequest = { jsonrpc: "2.0", method, params, id: 1 };
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection({ path: session.socketPath });
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
          resolvePromise(parsed.result as T);
        }
      } catch (err) {
        reject(new Error(`Failed to parse daemon response: ${err}`));
      }
    });
    socket.on("error", reject);
  });
}

/**
 * Start a detached daemon for `name` running `target`, and wait for it to
 * report in. Resolves with the live session; throws a SessionError carrying
 * the server's stderr (exit 69) if the target dies on its first start.
 */
export async function spawnSessionDaemon(
  name: string,
  target: string[],
  opts: SessionSpawnOptions,
): Promise<SessionData> {
  // The daemon is this same CLI in `daemon` mode, on the same Node binary we
  // are running under (a bare `node` from PATH could be a different version).
  const binPath = resolve(import.meta.dirname, "./index.js");
  const daemonArgs = ["daemon", name];
  if (opts.transport) daemonArgs.push("--transport", opts.transport);
  if (opts.idleTimeoutMs) daemonArgs.push("--idle-timeout-ms", String(opts.idleTimeoutMs));
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    daemonArgs.push("--env", `${key}=${value}`);
  }
  // The target command is separated with `--` so it isn't swallowed during the
  // daemon's re-parse.
  daemonArgs.push("--", ...target);
  const daemonProcess = spawn(process.execPath, [binPath, ...daemonArgs], {
    detached: true,
    stdio: "ignore",
  });
  daemonProcess.unref();

  // Poll until the session file appears (up to 5s). The daemon's stdio is
  // detached, so a server that dies on this first start reports through the
  // same file: a failure record carrying its stderr.
  for (let attempt = 0; attempt < 50; attempt++) {
    const record = await readSessionFile(name);
    if (record && "failed" in record) {
      await removeSessionFiles(name);
      const lines = [`Error: ${record.error}`, `Command: ${target.join(" ")}`];
      if (record.stderr.length > 0) {
        lines.push("--- Target server stderr ---", ...record.stderr);
      } else {
        lines.push(
          "The target produced no stderr output before exiting. Check that the command " +
            "runs standalone in a shell.",
        );
      }
      throw new SessionError(lines.join("\n"), 69);
    }
    const session = await getSession(name);
    if (session) return session;
    await new Promise((r) => setTimeout(r, 100));
  }

  throw new SessionError(`Error: Failed to spawn background daemon for session "${name}".`, 1);
}

/** Ask a session's daemon to stop; fall back to SIGTERM if it doesn't answer. */
export async function closeSession(name: string): Promise<string> {
  const session = await getSession(name);
  if (!session) return `Session "${name}" is not running.`;
  try {
    await sendDaemonRequest(session, "close");
    return `Session "${name}" stopped successfully.`;
  } catch {
    try {
      process.kill(session.pid, "SIGTERM");
      await removeSessionFiles(name);
      return `Session "${name}" stopped (SIGTERM).`;
    } catch {
      return `Failed to stop session "${name}".`;
    }
  }
}

// ─── Daemon ──────────────────────────────────────────────────────────────────

/**
 * The daemon process: connect to the target once, then answer requests over
 * the session socket until `close` or the idle timeout. Never returns; exits
 * the process when done.
 */
export async function runSessionDaemon(
  name: string,
  targetCmd: string[],
  opts: SessionSpawnOptions,
): Promise<void> {
  const [command, ...args] = targetCmd;
  const commandLine = targetCmd.join(" ");
  const startedAt = Date.now();
  const env = opts.env ?? {};
  const spawnTarget = () => new TargetManager(command, args, { transport: opts.transport, env });

  // Restrict the dir and files to the owner: the socket inside is the only
  // way to drive the target, and other local users must not find it.
  await mkdir(SESSION_DIR, { recursive: true, mode: 0o700 });
  const writeSessionFile = (record: SessionData | SessionFailure) =>
    writeFile(getSessionPath(name), JSON.stringify(record), { encoding: "utf8", mode: 0o600 });

  // Mutable: `reconnect` swaps in a fresh instance. A failed reconnect keeps
  // the dead instance around so `stderr` can still show why it died.
  let target = spawnTarget();

  try {
    await target.connect();
  } catch (err: any) {
    // Our stdio is detached; the failure record is how the spawning client
    // learns why (and gets the server's stderr, which is the actual answer).
    await target.waitForStderr();
    await writeSessionFile({
      failed: true,
      error: `Failed to connect: ${err?.message ?? String(err)}`,
      stderr: target.getStderrLines(40),
    });
    process.exit(1);
  }

  let idleTimeoutMs = opts.idleTimeoutMs;
  const socketPath = getSocketPath(name);
  const sessionRecord = (): SessionData => ({
    socketPath,
    pid: process.pid,
    command: targetCmd,
    cwd: process.cwd(),
    env,
    startedAt,
    ...(idleTimeoutMs ? { idleTimeoutMs } : {}),
  });

  // Idle timeout: a forgotten session would otherwise keep its server (and
  // whatever the server holds — a browser, say) alive until reboot.
  let idleTimer: NodeJS.Timeout | undefined;
  const shutdown = async () => {
    await target.close().catch(() => {});
    await removeSessionFiles(name);
    process.exit(0);
  };
  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    if (idleTimeoutMs) {
      idleTimer = setTimeout(() => void shutdown(), idleTimeoutMs);
      idleTimer.unref?.();
    }
  };

  /** Restart the target and diff its primitives against the outgoing run. */
  const reconnect = async (): Promise<OperationOutcome> => {
    const previous = await takeSnapshot(target);
    await target.close().catch(() => {});

    const next = spawnTarget();
    target = next;
    try {
      await next.connect();
    } catch (err: any) {
      await next.waitForStderr();
      const stderr = next.getStderrLines(40);
      return {
        result: {
          reconnected: false,
          error: `Failed to connect: ${err?.message ?? String(err)}`,
          command: commandLine,
          stderr,
          hint:
            stderr.length > 0
              ? "The server's stderr above is almost certainly the cause. Fix it and run reconnect again."
              : "The server produced no stderr before exiting. Check that it runs standalone in a shell.",
        },
        hasError: true,
      };
    }

    const current = await takeSnapshot(next);
    const changes = computeSnapshotDiff(previous, current).filter((line) => line !== "");
    return {
      result: { reconnected: true, pid: next.getStatus().pid, command: commandLine, changes },
      hasError: false,
    };
  };

  const execute = async (
    operation: HeadlessOperation,
    callOpts: HeadlessOptions & { idleTimeoutMs?: number },
  ): Promise<OperationOutcome> => {
    // A later call may change the idle timeout; it is recorded so `sessions`
    // shows the value actually in force.
    if (callOpts.idleTimeoutMs && callOpts.idleTimeoutMs !== idleTimeoutMs) {
      idleTimeoutMs = callOpts.idleTimeoutMs;
      touch();
      await writeSessionFile(sessionRecord());
    }
    if (operation.type === "reconnect") return reconnect();

    if (!target.connected && operation.type !== "stderr") {
      throw new Error(
        "The session's target server is not connected (it exited or failed to " +
          `restart). See why with: run-mcp stderr --session ${name} — ` +
          `then: run-mcp reconnect --session ${name}`,
      );
    }
    // Per-call interceptor so --out-dir/--timeout/--media-threshold mean the
    // same thing they do without a session.
    const interceptor = new ResponseInterceptor({
      outDir: callOpts.outDir,
      defaultTimeoutMs: callOpts.timeoutMs ?? DEFAULT_HEADLESS_TIMEOUT_MS,
      mediaThresholdKb: callOpts.mediaThresholdKb,
    });
    const stderrStart = target.getStatus().stderrLineCount;
    return executeOperation(target, interceptor, operation, callOpts, stderrStart);
  };

  const handleRequest = async (req: DaemonRequest): Promise<unknown> => {
    touch();
    switch (req.method) {
      case "execute": {
        const { operation, opts: callOpts } = req.params as {
          operation: HeadlessOperation;
          opts: HeadlessOptions & { idleTimeoutMs?: number };
        };
        return execute(operation, callOpts);
      }
      case "validate":
        return validateProtocol(command, args, undefined, { target }) as Promise<ValidationReport>;
      case "close":
        // Reply first; the caller's socket closes when we exit.
        setImmediate(() => void shutdown());
        return { ok: true };
      default:
        throw new Error(`Unknown daemon method: ${(req as any).method}`);
    }
  };

  // One request per connection, newline-delimited JSON, reply then end.
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", async (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let id = 1;
        try {
          const req = JSON.parse(trimmed) as DaemonRequest;
          id = req.id ?? 1;
          const result = await handleRequest(req);
          socket.write(JSON.stringify({ jsonrpc: "2.0", result, id }) + "\n");
        } catch (err: any) {
          socket.write(
            JSON.stringify({ jsonrpc: "2.0", error: { message: err.message }, id }) + "\n",
          );
        }
        socket.end();
      }
    });
    socket.on("error", () => {});
  });

  // A stale socket file from a daemon that died uncleanly would make listen fail.
  if (process.platform !== "win32") await rm(socketPath, { force: true }).catch(() => {});
  server.listen(socketPath, async () => {
    await writeSessionFile(sessionRecord());
    touch();
  });
  server.on("error", async () => {
    await target.close().catch(() => {});
    process.exit(1);
  });
}
