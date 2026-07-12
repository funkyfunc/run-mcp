import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import { writeFileSync, rmSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, relative, resolve, posix } from "node:path";
import { tmpdir } from "node:os";
import treeKill from "tree-kill";
import { hasControlChar, loadSettings, SandboxPolicy } from "./settings.js";
import { NetworkAuditProxy } from "./proxy-audit.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ListRootsRequestSchema,
  LoggingMessageNotificationSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  type ServerCapabilities,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

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
  sandbox: "auto" | "docker" | "native" | "audit" | "none";
}

/** Minimum uptime (ms) before a crash is considered "transient" and worth retrying. */
const MIN_UPTIME_FOR_RESTART_MS = 5_000;

/** Maximum consecutive reconnect attempts before giving up. */
const MAX_RECONNECT_ATTEMPTS = 3;

/** After this many ms of stable connection, reset the retry counter. */
const STABLE_CONNECTION_RESET_MS = 60_000;

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
function isCommandAvailable(cmd: string): boolean {
  try {
    const checkCmd = process.platform === "win32" ? `where ${cmd}` : `command -v ${cmd}`;
    execSync(checkCmd, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

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

  private _proxy: NetworkAuditProxy | null = null;
  private _proxyPort = 0;

  private sandboxMode: "auto" | "docker" | "native" | "audit" | "none";
  private _tempSbPath: string | null = null;
  private _tempDockerPaths: string[] = [];
  private _useWindowsMxc = false;
  private sandboxOptions: {
    allowRead?: string[];
    allowWrite?: string[];
    allowNet?: string[];
    denyRead?: string[];
    denyWrite?: string[];
    denyNet?: string[];
  };

  /**
   * Extra environment variables to inject into the target child process.
   * Threaded through to the child env in `_getDefaultEnvironment()` rather than
   * mutated onto the parent `process.env` — the latter both leaks secrets across
   * connections in the long-lived agent server and never actually reached the
   * child (the transport only forwards a fixed safe-var whitelist).
   */
  private readonly _extraEnv: Record<string, string>;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    options: {
      sandbox?: "auto" | "docker" | "native" | "audit" | "none";
      allowRead?: string[];
      allowWrite?: string[];
      allowNet?: string[];
      denyRead?: string[];
      denyWrite?: string[];
      denyNet?: string[];
      env?: Record<string, string>;
    } = {},
  ) {
    super();
    this.sandboxMode = options.sandbox ?? "none";
    this._extraEnv = options.env ?? {};
    this.sandboxOptions = {
      allowRead: options.allowRead,
      allowWrite: options.allowWrite,
      allowNet: options.allowNet,
      denyRead: options.denyRead,
      denyWrite: options.denyWrite,
      denyNet: options.denyNet,
    };
  }

  /**
   * Enable auto-reconnect behavior.
   * Only applies to interactive REPL mode — proxy mode manages its own lifecycle.
   */
  enableAutoReconnect(): void {
    this._autoReconnect = true;
  }

  /**
   * Spawn the target MCP server and establish the MCP client connection.
   * Stderr from the child process is emitted as 'stderr' events.
   */
  async connect(): Promise<void> {
    this._intentionalClose = false;
    this._everConnected = false;
    try {
      // Detect if we should use SSE or Stdio based on the command
      if (this.command.startsWith("http://") || this.command.startsWith("https://")) {
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        this.transport = new SSEClientTransport(new URL(this.command));
      } else {
        const policy = new SandboxPolicy();
        const fileSettings = loadSettings();
        if (fileSettings.sandbox) {
          policy.mergeConfig(fileSettings.sandbox, process.cwd());
        }
        policy.mergeCliOverrides(this.sandboxOptions);
        policy.applyCredentialProtections();

        // Start proxy if network allowed and sandbox active
        if (
          this.sandboxMode !== "none" &&
          this.sandboxMode !== "audit" &&
          policy.networkAllow.size > 0 &&
          !policy.networkDeny.has("*")
        ) {
          this._proxy = new NetworkAuditProxy((host) => policy.isNetworkAllowed(host));
          this._proxyPort = await this._proxy.start();
        }

        const { command: finalCommand, args: finalArgs } = await this._maybeWrapCommand(policy);

        const stdioTransport = new StdioClientTransport({
          command: finalCommand,
          args: finalArgs,
          stderr: "pipe",
          env: this._getDefaultEnvironment(),
        });

        if (this._useWindowsMxc) {
          await this._applyWindowsMxcOverride(stdioTransport, finalCommand, finalArgs, policy);
        }

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

            if (this.sandboxMode === "audit") {
              const lowerText = text.toLowerCase();
              if (
                lowerText.includes("eperm") ||
                lowerText.includes("eacces") ||
                lowerText.includes("permission denied") ||
                lowerText.includes("operation not permitted") ||
                lowerText.includes("enotfound") ||
                lowerText.includes("command not found") ||
                lowerText.includes("cannot execute")
              ) {
                console.error(
                  `\x1b[31m⚠️  [SANDBOX AUDIT] Blocked unauthorized side-effect: ${text}\x1b[0m`,
                );
              }
            }

            this.emit("stderr", text);
          }
        });

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
        },
      );

      // ─── Notification handlers ──────────────────────────────────────────────

      // Logging messages from server
      this.client.setNotificationHandler(
        LoggingMessageNotificationSchema,
        async (notification: any) => {
          const record: ServerNotification = {
            method: "notifications/message",
            params: notification.params,
            timestamp: Date.now(),
          };
          this._pushNotification(record);
          this.emit("notification", record);
        },
      );

      // Tool list changed
      this.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        const record: ServerNotification = {
          method: "notifications/tools/list_changed",
          timestamp: Date.now(),
        };
        this._pushNotification(record);
        this.emit("notification", record);
      });

      // Resource list changed
      this.client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
        const record: ServerNotification = {
          method: "notifications/resources/list_changed",
          timestamp: Date.now(),
        };
        this._pushNotification(record);
        this.emit("notification", record);
      });

      // Resource updated (subscription)
      this.client.setNotificationHandler(
        ResourceUpdatedNotificationSchema,
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
      this.client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
        const record: ServerNotification = {
          method: "notifications/prompts/list_changed",
          timestamp: Date.now(),
        };
        this._pushNotification(record);
        this.emit("notification", record);
      });

      // ─── Request handlers (sampling, roots) ──────────────────────────────────

      // Sampling: createMessage
      this.client.setRequestHandler(CreateMessageRequestSchema, async (request: any) => {
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
      this.client.setRequestHandler(ElicitRequestSchema, async (request: any) => {
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
      this.client.setRequestHandler(ListRootsRequestSchema, async () => {
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

      this._connected = true;
      this._everConnected = true;
      this.startTime = Date.now();

      // Try to capture child PID from transport internals (only valid for stdio)
      const proc = (this.transport as any)._process;
      if (proc?.pid) {
        this.childPid = proc.pid;
      } else {
        this.childPid = null;
      }

      this.emit("connected");
      this._registerCleanup();
      this._startStableTimer();
    } catch (err) {
      await this.close().catch(() => {});
      throw err;
    }
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
   * Available after connect() completes.
   */
  getServerVersion(): { name: string; version: string } | undefined {
    return this.client?.getServerVersion() as { name: string; version: string } | undefined;
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
   * List all tools exposed by the target MCP server.
   * Supports cursor-based pagination via params.
   */
  async listTools(params?: Record<string, unknown>) {
    this._assertConnected();
    const start = Date.now();
    const result = await this.client!.listTools(params as any);
    this.recordResponse();
    this._addHistory("tools/list", params, result, Date.now() - start);
    return result;
  }

  /**
   * Call a tool on the target MCP server.
   * We apply a massive SDK-level timeout (e.g. 10 hours) because we want to handle
   * timeouts in the interceptor via Promise.race, and we DO NOT want to send
   * protocol-level cancellation requests to the target server if the agent gives up.
   * This allows long-running builds (like mobile app compiling) to finish in the background.
   */
  async callTool(name: string, args: Record<string, unknown> = {}, _timeoutMs?: number) {
    this._assertConnected();
    const requestOptions = { timeout: 3600_000 * 10 }; // 10 hours
    const start = Date.now();
    const result = await this.client!.callTool(
      { name, arguments: args },
      undefined,
      requestOptions,
    );
    this.recordResponse();
    this._addHistory(`tools/call ${name}`, args, result, Date.now() - start);
    return result;
  }

  // ─── Resources ──────────────────────────────────────────────────────────────

  /**
   * List resources exposed by the target MCP server.
   * Supports cursor-based pagination.
   */
  async listResources(params?: Record<string, unknown>) {
    this._assertConnected();
    const start = Date.now();
    const result = await this.client!.listResources(params as any);
    this.recordResponse();
    this._addHistory("resources/list", params, result, Date.now() - start);
    return result;
  }

  /**
   * List resource templates exposed by the target MCP server.
   * Supports cursor-based pagination.
   */
  async listResourceTemplates(params?: Record<string, unknown>) {
    this._assertConnected();
    const start = Date.now();
    const result = await this.client!.listResourceTemplates(params as any);
    this.recordResponse();
    this._addHistory("resources/templates/list", params, result, Date.now() - start);
    return result;
  }

  /**
   * Read a specific resource by URI from the target MCP server.
   */
  async readResource(params: { uri: string; [key: string]: unknown }) {
    this._assertConnected();
    const start = Date.now();
    const result = await this.client!.readResource(params as any);
    this.recordResponse();
    this._addHistory(`resources/read ${params.uri}`, params, result, Date.now() - start);
    return result;
  }

  /**
   * Subscribe to resource updates on the target MCP server.
   */
  async subscribeResource(params: { uri: string }) {
    this._assertConnected();
    const start = Date.now();
    const result = await this.client!.subscribeResource(params);
    this.recordResponse();
    this._addHistory(`resources/subscribe ${params.uri}`, params, result, Date.now() - start);
    return result;
  }

  /**
   * Unsubscribe from resource updates on the target MCP server.
   */
  async unsubscribeResource(params: { uri: string }) {
    this._assertConnected();
    const start = Date.now();
    const result = await this.client!.unsubscribeResource(params);
    this.recordResponse();
    this._addHistory(`resources/unsubscribe ${params.uri}`, params, result, Date.now() - start);
    return result;
  }

  // ─── Prompts ────────────────────────────────────────────────────────────────

  /**
   * List prompts exposed by the target MCP server.
   * Supports cursor-based pagination.
   */
  async listPrompts(params?: Record<string, unknown>) {
    this._assertConnected();
    const start = Date.now();
    const result = await this.client!.listPrompts(params as any);
    this.recordResponse();
    this._addHistory("prompts/list", params, result, Date.now() - start);
    return result;
  }

  /**
   * Get a specific prompt by name from the target MCP server.
   */
  async getPrompt(params: { name: string; arguments?: Record<string, string> }) {
    this._assertConnected();
    const start = Date.now();
    const result = await this.client!.getPrompt(params);
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

  // ─── Completion ─────────────────────────────────────────────────────────────

  /**
   * Request completion from the target MCP server (for autocomplete UX).
   */
  async complete(params: Record<string, unknown>) {
    this._assertConnected();
    const start = Date.now();
    const result = await this.client!.complete(params as any);
    this.recordResponse();
    this._addHistory("completion/complete", params, result, Date.now() - start);
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
    this._history.push(record);
    if (this._history.length > MAX_HISTORY) {
      this._history = this._history.slice(-MAX_HISTORY);
    }
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
      await this.client.sendRootsListChanged();
    } catch {
      // Server may not support roots notifications — ignore
    }
  }

  // ─── Notification forwarding ────────────────────────────────────────────────

  /**
   * Access the underlying MCP client for advanced use cases like
   * subscribing to notifications with proper SDK schemas.
   * Prefer the typed methods above when possible.
   */
  getRawClient(): Client | null {
    return this.client;
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
   * Returns current connection status, PID, uptime, and diagnostics.
   */
  getStatus(): TargetStatus {
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
      sandbox: this.sandboxMode,
    };
  }

  /**
   * Cleanly shut down the client connection and forcefully kill the child process tree.
   */
  async close(): Promise<void> {
    this._intentionalClose = true;
    this._clearStableTimer();

    const pidToKill = this.childPid;

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

    // Clean up temporary Seatbelt files
    if (this._tempSbPath && existsSync(this._tempSbPath)) {
      try {
        rmSync(this._tempSbPath, { force: true });
      } catch {
        // ignore
      }
      this._tempSbPath = null;
    }

    // Clean up temporary Docker files/directories
    for (const p of this._tempDockerPaths) {
      if (existsSync(p)) {
        try {
          rmSync(p, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
    this._tempDockerPaths = [];

    // Shut down proxy if active
    if (this._proxy) {
      try {
        await this._proxy.close();
      } catch {
        // ignore
      }
      this._proxy = null;
      this._proxyPort = 0;
    }

    this._connected = false;
    this.childPid = null;
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

    // Clean up old connection state
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

  private async _maybeWrapCommand(
    policy: SandboxPolicy,
  ): Promise<{ command: string; args: string[] }> {
    let command = this.command;
    let args = [...this.args];

    let modeToUse = this.sandboxMode;
    if (modeToUse === "auto") {
      if (process.platform === "darwin") {
        if (isCommandAvailable("sandbox-exec")) {
          modeToUse = "native";
        } else {
          process.stderr.write("Warning: sandbox-exec is not available. Sandboxing disabled.\n");
          modeToUse = "none";
        }
      } else if (process.platform === "linux") {
        if (isCommandAvailable("bwrap")) {
          modeToUse = "native";
        } else {
          process.stderr.write("Warning: bwrap is not available. Sandboxing disabled.\n");
          modeToUse = "none";
        }
      } else if (process.platform === "win32") {
        let hasMxc = false;
        try {
          const mxcModule = "@microsoft/mxc-sdk";
          await import(mxcModule);
          hasMxc = true;
        } catch {
          // not found
        }
        if (hasMxc) {
          modeToUse = "native";
        } else {
          process.stderr.write(
            "Warning: @microsoft/mxc-sdk is not available. Sandboxing disabled.\n",
          );
          modeToUse = "none";
        }
      } else {
        process.stderr.write(
          `Warning: Sandboxing not supported on platform "${process.platform}". Sandboxing disabled.\n`,
        );
        modeToUse = "none";
      }
    }

    if (modeToUse === "docker") {
      let image = "node:20";
      if (command.includes("python")) {
        image = "python:3";
      }
      const cwd = process.cwd();
      const dockerArgs = [
        "run",
        "-i",
        "--rm",
        "--net=none",
        "-v",
        `${cwd}:/workspace`,
        "-w",
        "/workspace",
      ];

      // Translate fileReadDeny/fileWriteDeny into Docker mount masking
      const deniedPaths = new Set([...policy.fileReadDeny, ...policy.fileWriteDeny]);
      if (deniedPaths.size > 0) {
        const absCwd = resolve(cwd);
        const sep = process.platform === "win32" ? "\\" : "/";
        let emptyDir: string | null = null;
        let emptyFile: string | null = null;

        for (const p of deniedPaths) {
          const absP = resolve(p);
          if (absP === absCwd || absP.startsWith(absCwd + sep)) {
            const rel = relative(absCwd, absP);
            const containerPath = posix.join("/workspace", rel.replace(/\\/g, "/"));

            // The `-v host:container:ro` spec is colon-delimited. A denied path
            // containing a colon or control char would corrupt the spec and could
            // silently drop the mask. Refuse to launch rather than run a sandbox
            // whose deny rule we can't guarantee (fail closed).
            if (containerPath.includes(":") || hasControlChar(containerPath)) {
              throw new Error(
                `Cannot enforce sandbox deny rule for path "${p}": ` +
                  `its container path contains a character unsafe for a Docker volume spec. ` +
                  `Refusing to start rather than run an unenforced sandbox.`,
              );
            }

            let isDir = false;
            if (existsSync(absP)) {
              try {
                isDir = statSync(absP).isDirectory();
              } catch {
                // ignore
              }
            }

            if (isDir) {
              if (!emptyDir) {
                emptyDir = join(
                  tmpdir(),
                  `run-mcp-empty-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                );
                mkdirSync(emptyDir, { recursive: true });
                this._tempDockerPaths.push(emptyDir);
              }
              dockerArgs.push("-v", `${emptyDir}:${containerPath}:ro`);
            } else {
              if (!emptyFile) {
                emptyFile = join(
                  tmpdir(),
                  `run-mcp-empty-file-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                );
                writeFileSync(emptyFile, "", "utf8");
                this._tempDockerPaths.push(emptyFile);
              }
              dockerArgs.push("-v", `${emptyFile}:${containerPath}:ro`);
            }
          }
        }
      }

      args = [...dockerArgs, image, command, ...args];
      command = "docker";
    } else if (modeToUse === "native" || modeToUse === "audit") {
      const isAudit = modeToUse === "audit";

      if (process.platform === "darwin") {
        if (!isCommandAvailable("sandbox-exec")) {
          throw new Error(
            "sandbox-exec not found. Native sandboxing is not available on this macOS host.",
          );
        }
        const cwd = process.cwd();
        const tmp = tmpdir();
        const nodeBinDir = join(process.execPath, "..");
        const nodeInstallDir = join(nodeBinDir, "..");
        const profile = policy.getSeatbeltProfile({
          tmp,
          cwd,
          nodeBinDir,
          nodeInstallDir,
          audit: isAudit,
        });
        const tempSbPath = join(
          tmp,
          `run-mcp-sandbox-${Date.now()}-${Math.random().toString(36).slice(2)}.sb`,
        );
        writeFileSync(tempSbPath, profile, "utf8");
        this._tempSbPath = tempSbPath;

        args = ["-f", tempSbPath, command, ...args];
        command = "sandbox-exec";
      } else if (process.platform === "linux") {
        if (!isCommandAvailable("bwrap")) {
          throw new Error(
            "bwrap not found. Native sandboxing is not available on this Linux host.",
          );
        }
        const cwd = process.cwd();
        const tmp = tmpdir();

        const bwrapArgs = [
          "--ro-bind",
          "/usr",
          "/usr",
          "--ro-bind",
          "/lib",
          "/lib",
          "--ro-bind-try",
          "/lib64",
          "/lib64",
          "--ro-bind-try",
          "/bin",
          "/bin",
          "--ro-bind-try",
          "/sbin",
          "/sbin",
          "--ro-bind-try",
          "/etc",
          "/etc",
          "--ro-bind",
          cwd,
          cwd,
          "--dev",
          "/dev",
          "--proc",
          "/proc",
          "--unshare-pid",
          "--unshare-user",
          "--unshare-ipc",
        ];

        if (isAudit) {
          bwrapArgs.push("--unshare-net");
          bwrapArgs.push("--ro-bind", tmp, tmp);
        } else {
          bwrapArgs.push("--bind", tmp, tmp);

          // Outbound network permission
          if (policy.networkAllow.size === 0 || policy.networkDeny.has("*")) {
            bwrapArgs.push("--unshare-net");
          }

          // Whitelisted file reads
          for (const p of policy.fileReadAllow) {
            if (existsSync(p)) {
              bwrapArgs.push("--ro-bind", p, p);
            }
          }

          // Whitelisted file writes
          for (const p of policy.fileWriteAllow) {
            if (existsSync(p)) {
              bwrapArgs.push("--bind", p, p);
            }
          }
        }

        // Apply Bubblewrap deny rules (masking)
        const deniedPaths = new Set([...policy.fileReadDeny, ...policy.fileWriteDeny]);
        for (const p of deniedPaths) {
          if (existsSync(p)) {
            try {
              const stats = statSync(p);
              if (stats.isDirectory()) {
                bwrapArgs.push("--tmpfs", p);
              } else {
                bwrapArgs.push("--ro-bind", "/dev/null", p);
              }
            } catch {
              // ignore
            }
          }
        }

        args = [...bwrapArgs, command, ...args];
        command = "bwrap";
      } else if (process.platform === "win32") {
        let hasMxc = false;
        try {
          const mxcModule = "@microsoft/mxc-sdk";
          await import(mxcModule);
          hasMxc = true;
        } catch {
          // not found
        }
        if (!hasMxc) {
          throw new Error(
            "@microsoft/mxc-sdk not found. Native sandboxing is not available on this Windows host.",
          );
        }
        this._useWindowsMxc = true;
      } else {
        throw new Error(`Native sandboxing not supported on platform "${process.platform}"`);
      }
    }

    return { command, args };
  }

  private async _applyWindowsMxcOverride(
    transport: any,
    command: string,
    args: string[],
    policyObj: SandboxPolicy,
  ): Promise<void> {
    const mxcModule = "@microsoft/mxc-sdk";
    const mxcSdk = await import(mxcModule);

    const isAudit = this.sandboxMode === "audit";
    const readPaths = isAudit
      ? [process.cwd()]
      : [process.cwd(), tmpdir(), ...Array.from(policyObj.fileReadAllow)];
    const writePaths = isAudit ? [] : [tmpdir(), ...Array.from(policyObj.fileWriteAllow)];

    if (policyObj.fileReadDeny.size > 0 || policyObj.fileWriteDeny.size > 0) {
      process.stderr.write(
        "Warning: The Windows MXC sandbox does not support granular file deny rules. Denied paths may still be accessible if they are inside allowed directories.\n",
      );
    }

    const policy = {
      filesystem: {
        read: readPaths,
        write: writePaths,
      },
      network: {
        outbound: isAudit ? "block" : policyObj.networkAllow.size > 0 ? "allow" : "block",
      },
    };
    const config = mxcSdk.createConfigFromPolicy(policy);

    transport.start = async () => {
      if (transport._process) {
        throw new Error("StdioClientTransport already started!");
      }
      return new Promise<void>((resolve, reject) => {
        try {
          const env = {
            ...this._getDefaultEnvironment(),
            ...transport._serverParams.env,
          };

          transport._process = mxcSdk.spawnSandboxFromConfig(config, command, args, {
            env,
            stdio: ["pipe", "pipe", transport._serverParams.stderr ?? "inherit"],
            cwd: transport._serverParams.cwd,
          });

          transport._process.on("error", (error: any) => {
            reject(error);
            transport.onerror?.(error);
          });
          transport._process.on("spawn", () => {
            resolve();
          });
          transport._process.on("close", () => {
            transport._process = undefined;
            transport.onclose?.();
          });
          transport._process.stdin?.on("error", (error: any) => {
            transport.onerror?.(error);
          });
          transport._process.stdout?.on("data", (chunk: any) => {
            transport._readBuffer.append(chunk);
            transport.processReadBuffer();
          });
          transport._process.stdout?.on("error", (error: any) => {
            transport.onerror?.(error);
          });
          if (transport._stderrStream && transport._process.stderr) {
            transport._process.stderr.pipe(transport._stderrStream);
          }
        } catch (err) {
          reject(err);
        }
      });
    };
  }

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
            "USERPROFILE",
            "SYSTEMROOT",
          ]
        : ["HOME", "PATH", "SHELL", "USER"];
    for (const key of safeVars) {
      if (process.env[key]) {
        env[key] = process.env[key]!;
      }
    }
    // Caller-supplied env for this specific target. Applied after the safe-var
    // whitelist so callers can override, but before proxy vars below so the
    // network-audit proxy configuration always wins for sandbox integrity.
    for (const [key, value] of Object.entries(this._extraEnv)) {
      env[key] = value;
    }
    if (this._proxyPort) {
      const proxyUrl = `http://127.0.0.1:${this._proxyPort}`;
      env["http_proxy"] = proxyUrl;
      env["https_proxy"] = proxyUrl;
      env["HTTP_PROXY"] = proxyUrl;
      env["HTTPS_PROXY"] = proxyUrl;
      env["all_proxy"] = proxyUrl;
      env["ALL_PROXY"] = proxyUrl;
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
      for (const instance of TargetManager._instances) {
        instance.close().catch(() => {});
      }
    };

    process.on("exit", cleanupAll);
    process.on("SIGINT", () => {
      cleanupAll();
      process.exit(130);
    });
    process.on("SIGTERM", () => {
      cleanupAll();
      process.exit(143);
    });
  }
}
