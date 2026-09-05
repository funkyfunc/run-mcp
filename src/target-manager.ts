import { EventEmitter } from "node:events";
import treeKill from "tree-kill";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type {
  DiscoverResult,
  McpSubscription,
  ServerCapabilities,
  SubscriptionFilter,
  Transport,
  VersionNegotiationOptions,
} from "@modelcontextprotocol/client";
import { z } from "zod";

export interface TargetStatus {
  pid: number | null;
  uptime: number;
  connected: boolean;
  command: string;
  args: string[];
  lastResponseTime: number | null;
  stderrLineCount: number;
  reconnectAttempts: number;
  maxReconnectAttempts: number;
  /** Protocol era the connection negotiated: "legacy" (2025 `initialize`) or "modern" (2026-07-28). */
  protocolEra: ProtocolEra | null;
  /** The negotiated protocol revision, e.g. "2025-11-25" or "2026-07-28". */
  protocolVersion: string | null;
  /** Lines the server wrote to stdout that were not JSON-RPC (see `getStdoutNoise`). */
  stdoutNoiseCount: number;
  /** Transport-level errors the SDK reported (see `getTransportErrors`). */
  transportErrorCount: number;
}

/**
 * Transport selection for http(s) targets:
 *  - "http": Streamable HTTP (the current MCP remote transport).
 *  - "sse":  legacy HTTP+SSE (deprecated in the SDK; kept for old servers).
 *  - "auto": try Streamable HTTP first, fall back to SSE on failure.
 * Ignored for stdio (local command) targets.
 */
export type TransportMode = "auto" | "http" | "sse";

/**
 * Which protocol handshake to open with (`--protocol`):
 *  - "legacy": the 2025 `initialize` handshake, byte for byte. The default —
 *    a spawn-per-invocation tool must not pay a probe on every connect.
 *  - "auto":   probe with `server/discover`; fall back to `initialize` against
 *    a 2025-only server (on stdio the probe spawns a short-lived sibling process).
 *  - a revision such as "2026-07-28": pin that revision; no fallback. This is
 *    how a server author proves the modern path of their server works.
 */
export type ProtocolMode = "legacy" | "auto" | (string & {});

export type ProtocolEra = "legacy" | "modern";

const PIN_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Validate a `--protocol` value; throws with a coaching message on garbage. */
export function parseProtocolMode(value: string): ProtocolMode {
  if (value === "legacy" || value === "auto" || PIN_PATTERN.test(value)) return value;
  throw new Error(
    `--protocol expects "legacy" (default), "auto", or a revision to pin such as "2026-07-28"; got "${value}".`,
  );
}

function toVersionNegotiation(mode: ProtocolMode): VersionNegotiationOptions | undefined {
  if (mode === "legacy") return undefined;
  if (mode === "auto") return { mode: "auto" };
  return { mode: { pin: mode } };
}

/** What the connection negotiated, for banners, status, and validate. */
export interface ProtocolInfo {
  era: ProtocolEra | null;
  version: string | null;
  /** The `server/discover` advertisement, present only on a modern connection. */
  discover: DiscoverResult | null;
}

/** Client input the target asked for while a call was in flight. */
export interface InputRequestCounts {
  elicitation: number;
  sampling: number;
  roots: number;
  total: number;
}

export interface TransportErrorRecord {
  message: string;
  timestamp: number;
}

/** What `subscribeResource` did, which depends on the era. */
export interface SubscribeOutcome {
  era: ProtocolEra;
  /**
   * Modern era only: the subset of the requested filter the server agreed to
   * deliver. An empty `resourceSubscriptions` means the server took the
   * stream but will never send updates for that URI.
   */
  honoredFilter?: SubscriptionFilter;
}

export interface SubscriptionInfo {
  /** Filter run-mcp asked for on the list-changed stream (modern era). */
  listChangedRequested: SubscriptionFilter | null;
  /** What the server honored of it. */
  listChangedHonored: SubscriptionFilter | null;
  /** URIs with an open per-resource stream (modern) or a legacy subscribe (legacy). */
  resourceUris: string[];
}

/**
 * Turn a connect failure into what the caller should do next. Shared by the
 * REPL, headless mode, and the agent server so the coaching is identical.
 */
export function describeConnectFailure(
  err: unknown,
  command: string,
): { message: string; hint: string | null } {
  const anyErr = err as { message?: string; code?: unknown } | undefined;
  const message = anyErr?.message ?? String(err);
  const code = anyErr?.code;
  if (message.includes("ENOENT") || message.includes("spawn")) {
    return {
      message: `command "${command}" not found.`,
      hint: `Check that "${command}" is installed and in your PATH.`,
    };
  }
  if (code === -32022 || /unsupported protocol version/i.test(message)) {
    return {
      message,
      hint:
        "The server refused the 2025 handshake (it serves only the 2026-07-28 revision). " +
        "Retry with --protocol auto, or pin it with --protocol 2026-07-28.",
    };
  }
  if (code === "ERA_NEGOTIATION_FAILED") {
    return {
      message,
      hint:
        "The pinned revision was not offered. Use --protocol auto to connect on whatever the " +
        "server speaks, or drop --protocol for the 2025 handshake.",
    };
  }
  return { message, hint: null };
}

/** Minimum uptime (ms) before a crash is considered "transient" and worth retrying. */
const MIN_UPTIME_FOR_RESTART_MS = 5_000;

/** Maximum consecutive reconnect attempts before giving up. */
const MAX_RECONNECT_ATTEMPTS = 3;

/** After this many ms of stable connection, reset the retry counter. */
const STABLE_CONNECTION_RESET_MS = 60_000;

/**
 * The SDK closes the connection when one stdout message exceeds this. Its
 * default (10 MB) is below what a screenshot-heavy tool returns; the
 * interceptor exists to handle oversized results, so give it room.
 */
const MAX_STDIO_MESSAGE_BYTES = 256 * 1024 * 1024;

// ─── Request History ────────────────────────────────────────────────────────

export interface HistoryRecord {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs: number;
  timestamp: number;
}

const MAX_HISTORY = 100;

/**
 * Cap on the serialized size of a result retained in the in-memory history
 * ring. Without it, 100 retained multi-MB tool results (screenshots, big
 * reads) pin hundreds of MB per target in long-lived sessions. The `history`
 * event still carries the full record for audit sinks.
 */
const MAX_HISTORY_RESULT_CHARS = 64_000;

// ─── Notification types ─────────────────────────────────────────────────────

export interface ServerNotification {
  method: string;
  params?: Record<string, unknown>;
  timestamp: number;
}

// ─── Root types ─────────────────────────────────────────────────────────────

export interface Root {
  uri: string;
  name?: string;
}

/**
 * Manages the lifecycle of a target MCP server process.
 *
 * Spawns the target as a child process via StdioClientTransport,
 * exposes the MCP Client for tools/resources/prompts, captures stderr,
 * and ensures graceful cleanup on exit.
 *
 * Auto-reconnect:
 *   If the server crashes after being alive for ≥5s, it is treated as a
 *   transient failure and automatically restarted (up to 3 times).
 *   If it crashes within 5s of startup, it's considered a startup bug
 *   and no retry is attempted.
 */
export class TargetManager extends EventEmitter {
  private client: Client | null = null;
  private transport: Transport | null = null;
  private startTime: number = 0;
  private childPid: number | null = null;
  private _connected = false;

  // Enhanced status tracking
  private _lastResponseTime: number | null = null;
  private _stderrLineCount: number = 0;
  private _stderrLines: string[] = [];
  private static readonly MAX_STDERR_LINES = 200;

  // Diagnostics the SDK would otherwise swallow
  private _stdoutNoise: string[] = [];
  private _stdoutNoiseCount = 0;
  private _transportErrors: TransportErrorRecord[] = [];
  private static readonly MAX_DIAGNOSTICS = 50;

  // Auto-reconnect state
  private _reconnectAttempts: number = 0;
  private _stableTimer: ReturnType<typeof setTimeout> | null = null;
  private _autoReconnect: boolean = false;
  private _reconnecting: boolean = false;
  private _intentionalClose: boolean = false;
  private _everConnected: boolean = false;

  // Request history
  private _history: HistoryRecord[] = [];
  private _historyIdCounter = 0;

  // Notifications
  private _notifications: ServerNotification[] = [];
  private static readonly MAX_NOTIFICATIONS = 200;

  // Roots
  private _roots: Root[] = [];

  // Client input the server asked for (elicitation / sampling / roots)
  private _inputRequestTotals = { elicitation: 0, sampling: 0, roots: 0 };
  private _lastCallInputRequests: InputRequestCounts = {
    elicitation: 0,
    sampling: 0,
    roots: 0,
    total: 0,
  };

  // Modern-era subscription streams
  private _listChangedRequested: SubscriptionFilter | null = null;
  private _listChangedSubscription: McpSubscription | null = null;
  private _resourceSubscriptions = new Map<string, McpSubscription>();
  private _legacyResourceSubscriptions = new Set<string>();

  /**
   * Extra environment variables to inject into the target child process.
   * Threaded through to the child env in `_getDefaultEnvironment()` rather than
   * mutated onto the parent `process.env` — the latter both leaks secrets across
   * connections in the long-lived agent server and never actually reached the
   * child (the transport only forwards a fixed safe-var whitelist).
   */
  private readonly _extraEnv: Record<string, string>;

  // Transport selection for http(s) targets.
  private readonly transportMode: TransportMode;
  /** Which handshake to open with. */
  private readonly protocolMode: ProtocolMode;
  /** Set during an auto-mode fallback so the retry uses SSE instead of Streamable HTTP. */
  private _httpTriedStreamable = false;
  /** Once a transport kind is known to work, reconnects reuse it directly. */
  private _resolvedHttpTransport: "http" | "sse" | null = null;
  /** The http transport kind used by the in-flight connect attempt. */
  private _activeHttpKind: "http" | "sse" | null = null;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    options: {
      env?: Record<string, string>;
      transport?: TransportMode;
      protocol?: ProtocolMode;
    } = {},
  ) {
    super();
    this._extraEnv = options.env ?? {};
    this.transportMode = options.transport ?? "auto";
    this.protocolMode = options.protocol ?? "legacy";
  }

  /**
   * Enable auto-reconnect behavior.
   * Only applies to interactive REPL mode.
   */
  enableAutoReconnect(): void {
    this._autoReconnect = true;
  }

  /**
   * Establish the MCP client connection to the target.
   * For a local command this spawns a child process (stderr emitted as 'stderr'
   * events); for an http(s) URL it connects over Streamable HTTP (falling back to
   * SSE in auto mode). See the `transport` constructor option.
   */
  async connect(): Promise<void> {
    return this._connect(false);
  }

  private async _connect(isHttpFallback: boolean): Promise<void> {
    this._intentionalClose = false;
    this._everConnected = false;
    if (!isHttpFallback) this._httpTriedStreamable = false;
    const isHttpUrl = this.command.startsWith("http://") || this.command.startsWith("https://");
    try {
      // Detect transport: HTTP(S) URL → Streamable HTTP / SSE, else spawn stdio.
      if (isHttpUrl) {
        this._activeHttpKind = this._selectHttpTransportKind();
        const url = new URL(this.command);
        if (this._activeHttpKind === "sse") {
          // eslint-disable-next-line @typescript-eslint/no-deprecated
          this.transport = new SSEClientTransport(url);
        } else {
          this.transport = new StreamableHTTPClientTransport(url);
        }
      } else {
        const stdioTransport = new StdioClientTransport({
          command: this.command,
          args: [...this.args],
          stderr: "pipe",
          env: this._getDefaultEnvironment(),
          maxBufferSize: MAX_STDIO_MESSAGE_BYTES,
        });

        // Capture stderr from child process
        stdioTransport.stderr?.on("data", (chunk: Buffer) => {
          const text = chunk.toString().trimEnd();
          if (text) {
            const lines = text.split("\n");
            this._stderrLineCount += lines.length;
            // Store in ring buffer for later retrieval
            this._stderrLines.push(...lines);
            if (this._stderrLines.length > TargetManager.MAX_STDERR_LINES) {
              this._stderrLines = this._stderrLines.slice(-TargetManager.MAX_STDERR_LINES);
            }

            this.emit("stderr", text);
          }
        });

        this._teeStdout(stdioTransport);
        this.transport = stdioTransport;
      }

      this.client = new Client(
        { name: "run-mcp", version: PKG_VERSION },
        {
          capabilities: {
            roots: { listChanged: true },
            sampling: {},
            elicitation: {},
          },
          versionNegotiation: toVersionNegotiation(this.protocolMode),
        },
      );

      // Errors the transport reports outside any request (a message that
      // parsed as JSON but isn't valid JSON-RPC, a write failure, a buffer
      // overflow). The SDK only hands them to this callback; without it they
      // vanish, and the server under development gets no blame for them.
      this.client.onerror = (error: Error) => {
        this._recordTransportError(error);
      };

      // ─── Notification handlers ──────────────────────────────────────────────

      // Logging messages from server
      this.client.setNotificationHandler("notifications/message", async (notification: any) => {
        const record: ServerNotification = {
          method: "notifications/message",
          params: notification.params,
          timestamp: Date.now(),
        };
        this._pushNotification(record);
        this.emit("notification", record);
      });

      // Tool list changed
      this.client.setNotificationHandler("notifications/tools/list_changed", async () => {
        const record: ServerNotification = {
          method: "notifications/tools/list_changed",
          timestamp: Date.now(),
        };
        this._pushNotification(record);
        this.emit("notification", record);
      });

      // Resource list changed
      this.client.setNotificationHandler("notifications/resources/list_changed", async () => {
        const record: ServerNotification = {
          method: "notifications/resources/list_changed",
          timestamp: Date.now(),
        };
        this._pushNotification(record);
        this.emit("notification", record);
      });

      // Resource updated (subscription)
      this.client.setNotificationHandler(
        "notifications/resources/updated",
        async (notification: any) => {
          const record: ServerNotification = {
            method: "notifications/resources/updated",
            params: notification.params,
            timestamp: Date.now(),
          };
          this._pushNotification(record);
          this.emit("notification", record);
        },
      );

      // Prompt list changed
      this.client.setNotificationHandler("notifications/prompts/list_changed", async () => {
        const record: ServerNotification = {
          method: "notifications/prompts/list_changed",
          timestamp: Date.now(),
        };
        this._pushNotification(record);
        this.emit("notification", record);
      });

      // ─── Request handlers (sampling, elicitation, roots) ────────────────────
      //
      // The same handlers serve both eras: a 2025-era server sends these as
      // server→client requests; on 2026-07-28 the SDK fulfils a server's
      // `input_required` result through them and retries the call. Either way
      // the counts below tell the caller how much client input the call needed.

      // Sampling: createMessage
      this.client.setRequestHandler("sampling/createMessage", async (request: any) => {
        this._inputRequestTotals.sampling++;
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Sampling request timed out (no response from user in 5 minutes)"));
          }, 300_000);

          this.emit("sampling_request", {
            request: request.params,
            respond: (result: any) => {
              clearTimeout(timeout);
              resolve(result);
            },
            reject: (err: Error) => {
              clearTimeout(timeout);
              reject(err);
            },
          });
        });
      });

      // Elicitation: create
      this.client.setRequestHandler("elicitation/create", async (request: any) => {
        this._inputRequestTotals.elicitation++;
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Elicitation request timed out (no response from user in 5 minutes)"));
          }, 300_000);

          this.emit("elicitation_request", {
            request: request.params,
            respond: (result: any) => {
              clearTimeout(timeout);
              resolve(result);
            },
            reject: (err: Error) => {
              clearTimeout(timeout);
              reject(err);
            },
          });
        });
      });

      // Roots: list
      this.client.setRequestHandler("roots/list", async () => {
        this._inputRequestTotals.roots++;
        return { roots: this._roots };
      });

      this.client.onclose = () => {
        this._connected = false;
        this._clearStableTimer();

        if (this._intentionalClose || !this._everConnected) {
          // User asked to close or connection was never fully established — don't reconnect
          return;
        }

        this.emit("disconnected");
        this._maybeReconnect();
      };

      await this.client.connect(this.transport);

      // Remember which http transport worked so reconnects skip re-probing.
      if (isHttpUrl && this._activeHttpKind) {
        this._resolvedHttpTransport = this._activeHttpKind;
      }

      this._connected = true;
      this._everConnected = true;
      this.startTime = Date.now();

      // Child PID (stdio only).
      this.childPid =
        this.transport instanceof StdioClientTransport ? (this.transport.pid ?? null) : null;

      // On a modern connection nothing arrives unsolicited: open the stream
      // that carries list_changed notifications, or the REPL's cache refresh
      // and get_server_notifications would silently see nothing.
      await this._openListChangedStream();

      this.emit("connected");
      this._registerCleanup();
      this._startStableTimer();
    } catch (err) {
      await this.close().catch(() => {});

      // Auto mode: if the Streamable HTTP attempt failed and we haven't yet
      // tried SSE, fall back to it once (many servers still only speak SSE).
      if (
        isHttpUrl &&
        this.transportMode === "auto" &&
        this._activeHttpKind === "http" &&
        !this._httpTriedStreamable
      ) {
        this._httpTriedStreamable = true;
        process.stderr.write(
          "Streamable HTTP connection failed; falling back to legacy SSE transport...\n",
        );
        return this._connect(true);
      }

      throw err;
    }
  }

  /** Decide which http transport kind to use for the current connect attempt. */
  private _selectHttpTransportKind(): "http" | "sse" {
    if (this._resolvedHttpTransport) return this._resolvedHttpTransport;
    if (this.transportMode === "sse") return "sse";
    // auto (first attempt) and explicit "http" both start with Streamable HTTP.
    if (this.transportMode === "auto" && this._httpTriedStreamable) return "sse";
    return "http";
  }

  /**
   * Watch the child's stdout for lines that are not JSON-RPC. The SDK's read
   * buffer skips them silently (so hot-reload banners don't kill the
   * connection), which means the single most common stdio bug — logging to
   * stdout — would otherwise leave no trace. The tee is attached right after
   * spawn, before the handshake, so startup banners are caught too.
   */
  private _teeStdout(transport: StdioClientTransport): void {
    const originalStart = transport.start.bind(transport);
    transport.start = async () => {
      await originalStart();
      // The child process is not part of the public transport surface; the
      // pid is, so guard on it and degrade to "no tee" if the shape changes.
      const proc = (transport as unknown as { _process?: { stdout?: NodeJS.ReadableStream } })
        ._process;
      const stdout = proc?.stdout;
      if (!stdout || typeof stdout.on !== "function") return;
      let pending = "";
      stdout.on("data", (chunk: Buffer | string) => {
        pending += chunk.toString();
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.replace(/\r$/, "");
          if (!line.trim()) continue;
          if (line.trimStart().startsWith("{")) {
            try {
              JSON.parse(line);
              continue;
            } catch {
              // fall through: not JSON after all
            }
          }
          this._recordStdoutNoise(line);
        }
      });
    };
  }

  private _recordStdoutNoise(line: string): void {
    this._stdoutNoiseCount++;
    this._stdoutNoise.push(line);
    if (this._stdoutNoise.length > TargetManager.MAX_DIAGNOSTICS) {
      this._stdoutNoise = this._stdoutNoise.slice(-TargetManager.MAX_DIAGNOSTICS);
    }
    this.emit("stdout_noise", line);
  }

  private _recordTransportError(error: Error): void {
    const record = { message: error?.message ?? String(error), timestamp: Date.now() };
    this._transportErrors.push(record);
    if (this._transportErrors.length > TargetManager.MAX_DIAGNOSTICS) {
      this._transportErrors = this._transportErrors.slice(-TargetManager.MAX_DIAGNOSTICS);
    }
    this.emit("transport_error", record);
  }

  /**
   * Lines the server wrote to stdout that were not JSON-RPC messages. Any
   * entry here is a bug in the server: stdout is the protocol channel, and a
   * stricter client than the SDK would have dropped the connection.
   */
  getStdoutNoise(count?: number): string[] {
    if (!count || count >= this._stdoutNoise.length) return [...this._stdoutNoise];
    return this._stdoutNoise.slice(-count);
  }

  /** Transport-level errors the SDK reported (malformed JSON-RPC, write failures, overflow). */
  getTransportErrors(count?: number): TransportErrorRecord[] {
    if (!count || count >= this._transportErrors.length) return [...this._transportErrors];
    return this._transportErrors.slice(-count);
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Record that a response was received (for status tracking).
   */
  recordResponse(): void {
    this._lastResponseTime = Date.now();
  }

  // ─── Server introspection ───────────────────────────────────────────────────

  /**
   * Returns the target server's advertised capabilities.
   * Available after connect() completes.
   */
  getServerCapabilities(): ServerCapabilities | undefined {
    return this.client?.getServerCapabilities();
  }

  /**
   * Returns the target server's instructions string (if any).
   * Agents may use this for system prompts or behavioral hints.
   */
  getInstructions(): string | undefined {
    return this.client?.getInstructions();
  }

  /**
   * Returns the target server's name and version from the MCP handshake.
   * Available after connect() completes. On a modern connection this comes
   * from the `_meta` identity stamp; a server that omits it is anonymous.
   */
  getServerVersion(): { name: string; version: string } | undefined {
    return this.client?.getServerVersion() as { name: string; version: string } | undefined;
  }

  /** Which era and revision the connection negotiated. */
  getProtocolInfo(): ProtocolInfo {
    return {
      era: (this.client?.getProtocolEra() as ProtocolEra | undefined) ?? null,
      version: this.client?.getNegotiatedProtocolVersion() ?? null,
      discover: this.client?.getDiscoverResult() ?? null,
    };
  }

  /** The `--protocol` mode this target was created with. */
  get protocol(): ProtocolMode {
    return this.protocolMode;
  }

  // ─── Ping ──────────────────────────────────────────────────────────────────

  /**
   * Send a ping to the target MCP server and return the round-trip time.
   */
  async ping(): Promise<number> {
    this._assertConnected();
    const start = Date.now();
    await this.client!.ping();
    const elapsed = Date.now() - start;
    this.recordResponse();
    this._addHistory("ping", undefined, { ok: true }, elapsed);
    return elapsed;
  }

  // ─── Tools ──────────────────────────────────────────────────────────────────

  /**
   * List tools exposed by the target MCP server. Without a cursor the SDK
   * walks every page; with one it returns exactly that page. The response
   * cache is bypassed: a harness must always show the live server.
   */
  async listTools(params?: Record<string, unknown>) {
    this._assertConnected();
    const start = Date.now();
    const result = await this.client!.listTools(params as any, { cacheMode: "bypass" });
    this.recordResponse();
    this._addHistory("tools/list", params, result, Date.now() - start);
    return result;
  }

  /** Every tool. (The SDK aggregates pages itself; kept as the explicit "all" verb.) */
  async listAllTools(): Promise<{ tools: any[] }> {
    const { tools } = await this.listTools();
    return { tools: tools ?? [] };
  }

  /**
   * Call a tool on the target MCP server.
   * We apply a massive SDK-level timeout (e.g. 10 hours) because we want to handle
   * timeouts in the interceptor via Promise.race, and we DO NOT want to send
   * protocol-level cancellation requests to the target server if the agent gives up.
   * This allows long-running builds (like mobile app compiling) to finish in the background.
   */
  async callTool(name: string, args: Record<string, unknown> = {}) {
    this._assertConnected();
    const requestOptions = { timeout: 3600_000 * 10 }; // 10 hours
    const start = Date.now();
    const result = await this._countingInputRequests(() =>
      this.client!.callTool({ name, arguments: args }, requestOptions),
    );
    this.recordResponse();
    this._addHistory(`tools/call ${name}`, args, result, Date.now() - start);
    return result;
  }

  /**
   * How much client input (elicitation, sampling, roots) the most recent
   * tool call / resource read / prompt get needed. Zero for a call that
   * completed in one round.
   */
  getLastCallInputRequests(): InputRequestCounts {
    return { ...this._lastCallInputRequests };
  }

  private async _countingInputRequests<T>(fn: () => Promise<T>): Promise<T> {
    const before = { ...this._inputRequestTotals };
    try {
      return await fn();
    } finally {
      const after = this._inputRequestTotals;
      const elicitation = after.elicitation - before.elicitation;
      const sampling = after.sampling - before.sampling;
      const roots = after.roots - before.roots;
      this._lastCallInputRequests = {
        elicitation,
        sampling,
        roots,
        total: elicitation + sampling + roots,
      };
    }
  }

  // ─── Resources ──────────────────────────────────────────────────────────────

  /**
   * List resources exposed by the target MCP server (all pages unless a
   * cursor is given; cache bypassed).
   */
  async listResources(params?: Record<string, unknown>) {
    this._assertConnected();
    const start = Date.now();
    const result = await this.client!.listResources(params as any, { cacheMode: "bypass" });
    this.recordResponse();
    this._addHistory("resources/list", params, result, Date.now() - start);
    return result;
  }

  /** Every resource. */
  async listAllResources(): Promise<{ resources: any[] }> {
    const { resources } = await this.listResources();
    return { resources: resources ?? [] };
  }

  /**
   * List resource templates exposed by the target MCP server.
   */
  async listResourceTemplates(params?: Record<string, unknown>) {
    this._assertConnected();
    const start = Date.now();
    const result = await this.client!.listResourceTemplates(params as any, {
      cacheMode: "bypass",
    });
    this.recordResponse();
    this._addHistory("resources/templates/list", params, result, Date.now() - start);
    return result;
  }

  /** Every resource template. */
  async listAllResourceTemplates(): Promise<{ resourceTemplates: any[] }> {
    const { resourceTemplates } = await this.listResourceTemplates();
    return { resourceTemplates: resourceTemplates ?? [] };
  }

  /**
   * Read a specific resource by URI from the target MCP server.
   */
  async readResource(params: { uri: string; [key: string]: unknown }) {
    this._assertConnected();
    const start = Date.now();
    const result = await this._countingInputRequests(() =>
      this.client!.readResource(params as any, { cacheMode: "bypass" }),
    );
    this.recordResponse();
    this._addHistory(`resources/read ${params.uri}`, params, result, Date.now() - start);
    return result;
  }

  /**
   * Subscribe to updates for a resource. On a 2025-era connection this is the
   * `resources/subscribe` RPC; on 2026-07-28 that verb no longer exists, so a
   * `subscriptions/listen` stream naming the URI is opened instead, and the
   * outcome reports what the server actually agreed to deliver.
   */
  async subscribeResource(params: { uri: string }): Promise<SubscribeOutcome> {
    this._assertConnected();
    const start = Date.now();
    if (this.getProtocolInfo().era === "modern") {
      const existing = this._resourceSubscriptions.get(params.uri);
      if (existing) return { era: "modern", honoredFilter: existing.honoredFilter };
      const subscription = await this.client!.listen({ resourceSubscriptions: [params.uri] });
      this._resourceSubscriptions.set(params.uri, subscription);
      void subscription.closed.then((reason) => {
        if (this._resourceSubscriptions.get(params.uri) === subscription) {
          this._resourceSubscriptions.delete(params.uri);
        }
        this.emit("subscription_closed", { uri: params.uri, reason });
      });
      this.recordResponse();
      this._addHistory(
        `subscriptions/listen ${params.uri}`,
        params,
        { honoredFilter: subscription.honoredFilter },
        Date.now() - start,
      );
      return { era: "modern", honoredFilter: subscription.honoredFilter };
    }
    const result = await this.client!.subscribeResource(params);
    this._legacyResourceSubscriptions.add(params.uri);
    this.recordResponse();
    this._addHistory(`resources/subscribe ${params.uri}`, params, result, Date.now() - start);
    return { era: "legacy" };
  }

  /**
   * Unsubscribe from resource updates: the `resources/unsubscribe` RPC on a
   * 2025-era connection, closing the per-resource stream on 2026-07-28.
   */
  async unsubscribeResource(params: { uri: string }): Promise<void> {
    this._assertConnected();
    const start = Date.now();
    const stream = this._resourceSubscriptions.get(params.uri);
    if (stream) {
      this._resourceSubscriptions.delete(params.uri);
      await stream.close();
      this._addHistory(`subscriptions/close ${params.uri}`, params, {}, Date.now() - start);
      return;
    }
    const result = await this.client!.unsubscribeResource(params);
    this._legacyResourceSubscriptions.delete(params.uri);
    this.recordResponse();
    this._addHistory(`resources/unsubscribe ${params.uri}`, params, result, Date.now() - start);
  }

  /** What run-mcp is subscribed to, and (modern era) what the server honored. */
  getSubscriptionInfo(): SubscriptionInfo {
    return {
      listChangedRequested: this._listChangedRequested,
      listChangedHonored: this._listChangedSubscription?.honoredFilter ?? null,
      resourceUris: [...this._resourceSubscriptions.keys(), ...this._legacyResourceSubscriptions],
    };
  }

  /**
   * Modern era: ask for every list_changed type the server advertises. The
   * server's `honoredFilter` is kept so status and validate can show whether
   * it actually agreed to deliver them.
   */
  private async _openListChangedStream(): Promise<void> {
    if (this.getProtocolInfo().era !== "modern" || !this.client) return;
    const caps = this.getServerCapabilities() ?? {};
    const filter: SubscriptionFilter = {};
    if ((caps.tools as any)?.listChanged) filter.toolsListChanged = true;
    if ((caps.prompts as any)?.listChanged) filter.promptsListChanged = true;
    if ((caps.resources as any)?.listChanged) filter.resourcesListChanged = true;
    if (Object.keys(filter).length === 0) return;
    this._listChangedRequested = filter;
    try {
      const subscription = await this.client.listen(filter);
      this._listChangedSubscription = subscription;
      void subscription.closed.then((reason) => {
        if (this._listChangedSubscription === subscription) this._listChangedSubscription = null;
        this.emit("subscription_closed", { uri: null, reason });
      });
    } catch (err) {
      // A server that advertises listChanged but rejects the stream is worth
      // knowing about; it is not a connect failure.
      this._recordTransportError(
        new Error(`subscriptions/listen for list_changed failed: ${(err as Error).message}`),
      );
    }
  }

  private async _closeSubscriptions(): Promise<void> {
    const streams = [...this._resourceSubscriptions.values()];
    if (this._listChangedSubscription) streams.push(this._listChangedSubscription);
    this._resourceSubscriptions.clear();
    this._legacyResourceSubscriptions.clear();
    this._listChangedSubscription = null;
    this._listChangedRequested = null;
    await Promise.all(streams.map((s) => s.close().catch(() => {})));
  }

  // ─── Prompts ────────────────────────────────────────────────────────────────

  /**
   * List prompts exposed by the target MCP server.
   */
  async listPrompts(params?: Record<string, unknown>) {
    this._assertConnected();
    const start = Date.now();
    const result = await this.client!.listPrompts(params as any, { cacheMode: "bypass" });
    this.recordResponse();
    this._addHistory("prompts/list", params, result, Date.now() - start);
    return result;
  }

  /** Every prompt. */
  async listAllPrompts(): Promise<{ prompts: any[] }> {
    const { prompts } = await this.listPrompts();
    return { prompts: prompts ?? [] };
  }

  /**
   * Get a specific prompt by name from the target MCP server.
   */
  async getPrompt(params: { name: string; arguments?: Record<string, string> }) {
    this._assertConnected();
    const start = Date.now();
    const result = await this._countingInputRequests(() => this.client!.getPrompt(params));
    this.recordResponse();
    this._addHistory(`prompts/get ${params.name}`, params, result, Date.now() - start);
    return result;
  }

  // ─── Logging ────────────────────────────────────────────────────────────────

  /**
   * Set the logging level on the target MCP server.
   */
  async setLoggingLevel(level: string) {
    this._assertConnected();
    const start = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- deprecated by SEP-2577 but still served for 12 months; run-mcp exists to exercise it
    const result = await this.client!.setLoggingLevel(level as any);
    this.recordResponse();
    this._addHistory(`logging/setLevel ${level}`, { level }, result, Date.now() - start);
    return result;
  }

  /**
   * Send a raw JSON-RPC request to the target MCP server bypassing client-side validation.
   */
  async requestRaw(method: string, params?: Record<string, unknown>): Promise<any> {
    this._assertConnected();
    const start = Date.now();
    const result = await this.client!.request({ method, params }, z.any());
    this.recordResponse();
    this._addHistory(method, params, result, Date.now() - start);
    return result;
  }

  // ─── Request History ────────────────────────────────────────────────────────

  /**
   * Get the request/response history.
   * @param count - Number of recent records to return (default: all)
   */
  getHistory(count?: number): HistoryRecord[] {
    if (!count || count >= this._history.length) return [...this._history];
    return this._history.slice(-count);
  }

  /**
   * Clear the history buffer.
   */
  clearHistory(): void {
    this._history = [];
  }

  private _addHistory(method: string, params: unknown, result: unknown, durationMs: number): void {
    const record: HistoryRecord = {
      id: ++this._historyIdCounter,
      method,
      params: params as Record<string, unknown>,
      result,
      durationMs,
      timestamp: Date.now(),
    };
    this._history.push({ ...record, result: this._boundHistoryResult(result) });
    if (this._history.length > MAX_HISTORY) {
      this._history = this._history.slice(-MAX_HISTORY);
    }
    // The event carries the FULL result; only the retained ring buffer is bounded.
    this.emit("history", record);
  }

  /** Replace oversized results with a placeholder before retaining in history. */
  private _boundHistoryResult(result: unknown): unknown {
    let serialized: string;
    try {
      serialized = JSON.stringify(result) ?? "";
    } catch {
      return result;
    }
    if (serialized.length <= MAX_HISTORY_RESULT_CHARS) return result;
    return {
      _historyElided: true,
      note:
        `Result (${serialized.length.toLocaleString()} serialized chars) elided from ` +
        `in-memory history to bound memory.`,
    };
  }

  // ─── Notification History ───────────────────────────────────────────────────

  /**
   * Get recent server notifications.
   * @param count - Number of recent notifications to return (default: all)
   */
  getNotifications(count?: number): ServerNotification[] {
    if (!count || count >= this._notifications.length) return [...this._notifications];
    return this._notifications.slice(-count);
  }

  /**
   * Clear the notification buffer.
   */
  clearNotifications(): void {
    this._notifications = [];
  }

  private _pushNotification(record: ServerNotification): void {
    this._notifications.push(record);
    if (this._notifications.length > TargetManager.MAX_NOTIFICATIONS) {
      this._notifications = this._notifications.slice(-TargetManager.MAX_NOTIFICATIONS);
    }
  }

  // ─── Roots Management ─────────────────────────────────────────────────────

  /**
   * Get the current roots list that this client advertises.
   */
  getRoots(): Root[] {
    return [...this._roots];
  }

  /**
   * Add a root and send notification to the server.
   */
  async addRoot(root: Root): Promise<void> {
    // Prevent duplicates
    if (this._roots.some((r) => r.uri === root.uri)) return;
    this._roots.push(root);
    await this._sendRootsChanged();
  }

  /**
   * Remove a root by URI and send notification to the server.
   */
  async removeRoot(uri: string): Promise<boolean> {
    const before = this._roots.length;
    this._roots = this._roots.filter((r) => r.uri !== uri);
    if (this._roots.length < before) {
      await this._sendRootsChanged();
      return true;
    }
    return false;
  }

  private async _sendRootsChanged(): Promise<void> {
    if (!this._connected || !this.client) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- deprecated by SEP-2577 but still served for 12 months; run-mcp exists to exercise it
      await this.client.sendRootsListChanged();
    } catch {
      // Server may not support roots notifications — ignore
    }
  }

  // ─── Status & lifecycle ─────────────────────────────────────────────────────

  /**
   * Returns the last N lines of stderr output from the target server.
   * Useful for debugging crashes or unexpected behavior.
   */
  getStderrLines(count?: number): string[] {
    if (!count || count >= this._stderrLines.length) return [...this._stderrLines];
    return this._stderrLines.slice(-count);
  }

  /**
   * Wait briefly for a dying target's stderr to arrive.
   *
   * `connect()` rejects when the transport closes, which can win the race
   * against the child's final stderr 'data' event. Resolves as soon as any
   * stderr has been captured, or after `deadlineMs`. Meant for failure paths
   * only, so the happy path pays nothing.
   */
  async waitForStderr(deadlineMs = 250): Promise<void> {
    const POLL_MS = 25;
    for (let waited = 0; waited < deadlineMs; waited += POLL_MS) {
      if (this._stderrLines.length > 0) return;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  /**
   * Returns current connection status, PID, uptime, and diagnostics.
   */
  getStatus(): TargetStatus {
    const protocol = this.getProtocolInfo();
    return {
      pid: this.childPid,
      uptime: this._connected ? (Date.now() - this.startTime) / 1000 : 0,
      connected: this._connected,
      command: this.command,
      args: this.args,
      lastResponseTime: this._lastResponseTime,
      stderrLineCount: this._stderrLineCount,
      reconnectAttempts: this._reconnectAttempts,
      maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
      protocolEra: protocol.era,
      protocolVersion: protocol.version,
      stdoutNoiseCount: this._stdoutNoiseCount,
      transportErrorCount: this._transportErrors.length,
    };
  }

  /**
   * Cleanly shut down the client connection and forcefully kill the child process tree.
   */
  async close(): Promise<void> {
    this._intentionalClose = true;
    this._clearStableTimer();

    const pidToKill = this.childPid;

    await this._closeSubscriptions();

    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // Ignore close errors
      }
      this.client = null;
    }
    if (this.transport) {
      try {
        await this.transport.close();
      } catch {
        // Ignore close errors
      }
      this.transport = null;
    }

    // Forcefully clean up any orphaned grandchild processes
    if (pidToKill) {
      await new Promise<void>((resolve) => {
        treeKill(pidToKill, "SIGKILL", () => resolve());
      });
    }

    this._connected = false;
    this.childPid = null;
    // Drop this instance from the static cleanup set — otherwise long-lived
    // sessions that connect/disconnect many targets (agent server, server
    // search) retain every dead manager's history and stderr buffers forever.
    TargetManager._instances.delete(this);
  }

  // ─── Auto-reconnect logic ──────────────────────────────────────────────────

  /**
   * Decide whether to attempt auto-reconnect after a disconnect.
   *
   * Rules:
   *  1. Auto-reconnect must be enabled
   *  2. Server must have been alive for ≥5s (otherwise it's a startup bug)
   *  3. Must not exceed MAX_RECONNECT_ATTEMPTS consecutive retries
   *  4. Must not already be reconnecting
   */
  private async _maybeReconnect(): Promise<void> {
    if (!this._autoReconnect || this._reconnecting) return;

    const uptimeMs = Date.now() - this.startTime;

    // Startup crash — don't retry, it's likely a bug
    if (uptimeMs < MIN_UPTIME_FOR_RESTART_MS) {
      this.emit("reconnect_failed", {
        reason: "startup_crash",
        message:
          `Server crashed after ${(uptimeMs / 1000).toFixed(1)}s — ` +
          `too soon to be a transient failure (min ${MIN_UPTIME_FOR_RESTART_MS / 1000}s). Not retrying.`,
      });
      return;
    }

    // Too many retries
    if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.emit("reconnect_failed", {
        reason: "max_retries",
        message: `Server has crashed ${this._reconnectAttempts} times in a row. Giving up.`,
      });
      return;
    }

    // Attempt reconnect
    this._reconnecting = true;
    this._reconnectAttempts++;

    this.emit("reconnecting", {
      attempt: this._reconnectAttempts,
      maxAttempts: MAX_RECONNECT_ATTEMPTS,
    });

    // Clean up old connection state before connect() builds a fresh one.
    await this._closeSubscriptions();
    this.client = null;
    this.transport = null;
    this.childPid = null;

    try {
      await this.connect();
      this.emit("reconnected", { attempt: this._reconnectAttempts });
    } catch (err: any) {
      this.emit("reconnect_failed", {
        reason: "connect_error",
        message: `Reconnect attempt ${this._reconnectAttempts} failed: ${err.message}`,
      });
    } finally {
      this._reconnecting = false;
    }
  }

  /**
   * After STABLE_CONNECTION_RESET_MS of being connected, reset the retry counter.
   * This way, a server that crashes once after 10 minutes of stability
   * gets a fresh set of retries.
   */
  private _startStableTimer(): void {
    this._clearStableTimer();
    this._stableTimer = setTimeout(() => {
      if (this._connected) {
        this._reconnectAttempts = 0;
      }
    }, STABLE_CONNECTION_RESET_MS);
  }

  private _clearStableTimer(): void {
    if (this._stableTimer) {
      clearTimeout(this._stableTimer);
      this._stableTimer = null;
    }
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  private _getDefaultEnvironment(): Record<string, string> {
    const env: Record<string, string> = {};
    const safeVars =
      process.platform === "win32"
        ? [
            "APPDATA",
            "HOMEDRIVE",
            "HOMEPATH",
            "LOCALAPPDATA",
            "PATH",
            "TEMP",
            "USERNAME",
            "USERPROFILE",
            "SYSTEMROOT",
          ]
        : ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];
    for (const key of safeVars) {
      const value = process.env[key];
      // Skip function-shaped values (the shellshock pattern), as the SDK does.
      if (value && !value.startsWith("()")) env[key] = value;
    }
    // Caller-supplied env for this specific target. Applied after the safe-var
    // whitelist so callers can override it.
    for (const [key, value] of Object.entries(this._extraEnv)) {
      env[key] = value;
    }
    return env;
  }

  private _assertConnected(): void {
    if (!this._connected || !this.client) {
      throw new Error("Not connected to target MCP server");
    }
  }

  private static _cleanupRegistered = false;
  private static _instances = new Set<TargetManager>();

  private _registerCleanup(): void {
    TargetManager._instances.add(this);

    if (TargetManager._cleanupRegistered) return;
    TargetManager._cleanupRegistered = true;

    const cleanupAll = () => {
      for (const instance of [...TargetManager._instances]) {
        instance.close().catch(() => {});
      }
    };

    // Give tree-kills a bounded window to actually land before exiting.
    // Firing close() and exiting synchronously races the kills against process
    // teardown and can leave orphaned grandchildren.
    const SHUTDOWN_GRACE_MS = 500;
    const closeAllWithGrace = async (): Promise<void> => {
      const closes = [...TargetManager._instances].map((i) => i.close().catch(() => {}));
      const grace = new Promise<void>((resolve) => {
        setTimeout(resolve, SHUTDOWN_GRACE_MS).unref?.();
      });
      await Promise.race([Promise.all(closes), grace]);
    };

    // 'exit' can't await async work — keep the best-effort sync sweep.
    process.on("exit", cleanupAll);
    process.on("SIGINT", () => {
      void closeAllWithGrace().then(() => process.exit(130));
    });
    process.on("SIGTERM", () => {
      void closeAllWithGrace().then(() => process.exit(143));
    });
  }
}
