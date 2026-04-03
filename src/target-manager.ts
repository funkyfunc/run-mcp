import { EventEmitter } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";

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
}

/** Minimum uptime (ms) before a crash is considered "transient" and worth retrying. */
const MIN_UPTIME_FOR_RESTART_MS = 5_000;

/** Maximum consecutive reconnect attempts before giving up. */
const MAX_RECONNECT_ATTEMPTS = 3;

/** After this many ms of stable connection, reset the retry counter. */
const STABLE_CONNECTION_RESET_MS = 60_000;

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
  private transport: StdioClientTransport | null = null;
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

  constructor(
    private readonly command: string,
    private readonly args: string[],
  ) {
    super();
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

    this.transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      stderr: "pipe",
    });

    // Capture stderr from child process
    this.transport.stderr?.on("data", (chunk: Buffer) => {
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

    this.client = new Client({ name: "run-mcp", version: "1.3.1" }, { capabilities: {} });

    this.client.onclose = () => {
      this._connected = false;
      this._clearStableTimer();

      if (this._intentionalClose) {
        // User asked to close — don't reconnect
        return;
      }

      this.emit("disconnected");
      this._maybeReconnect();
    };

    await this.client.connect(this.transport);

    this._connected = true;
    this.startTime = Date.now();

    // Try to capture child PID from transport internals
    const proc = (this.transport as any)._process;
    if (proc?.pid) {
      this.childPid = proc.pid;
    }

    this.emit("connected");
    this._registerCleanup();
    this._startStableTimer();
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

  // ─── Tools ──────────────────────────────────────────────────────────────────

  /**
   * List all tools exposed by the target MCP server.
   * Supports cursor-based pagination via params.
   */
  async listTools(params?: Record<string, unknown>) {
    this._assertConnected();
    const result = await this.client!.listTools(params as any);
    this.recordResponse();
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
    const result = await this.client!.callTool(
      { name, arguments: args },
      undefined,
      requestOptions,
    );
    this.recordResponse();
    return result;
  }

  // ─── Resources ──────────────────────────────────────────────────────────────

  /**
   * List resources exposed by the target MCP server.
   * Supports cursor-based pagination.
   */
  async listResources(params?: Record<string, unknown>) {
    this._assertConnected();
    const result = await this.client!.listResources(params as any);
    this.recordResponse();
    return result;
  }

  /**
   * List resource templates exposed by the target MCP server.
   * Supports cursor-based pagination.
   */
  async listResourceTemplates(params?: Record<string, unknown>) {
    this._assertConnected();
    const result = await this.client!.listResourceTemplates(params as any);
    this.recordResponse();
    return result;
  }

  /**
   * Read a specific resource by URI from the target MCP server.
   */
  async readResource(params: { uri: string; [key: string]: unknown }) {
    this._assertConnected();
    const result = await this.client!.readResource(params as any);
    this.recordResponse();
    return result;
  }

  /**
   * Subscribe to resource updates on the target MCP server.
   */
  async subscribeResource(params: { uri: string }) {
    this._assertConnected();
    const result = await this.client!.subscribeResource(params);
    this.recordResponse();
    return result;
  }

  /**
   * Unsubscribe from resource updates on the target MCP server.
   */
  async unsubscribeResource(params: { uri: string }) {
    this._assertConnected();
    const result = await this.client!.unsubscribeResource(params);
    this.recordResponse();
    return result;
  }

  // ─── Prompts ────────────────────────────────────────────────────────────────

  /**
   * List prompts exposed by the target MCP server.
   * Supports cursor-based pagination.
   */
  async listPrompts(params?: Record<string, unknown>) {
    this._assertConnected();
    const result = await this.client!.listPrompts(params as any);
    this.recordResponse();
    return result;
  }

  /**
   * Get a specific prompt by name from the target MCP server.
   */
  async getPrompt(params: { name: string; arguments?: Record<string, string> }) {
    this._assertConnected();
    const result = await this.client!.getPrompt(params);
    this.recordResponse();
    return result;
  }

  // ─── Logging ────────────────────────────────────────────────────────────────

  /**
   * Set the logging level on the target MCP server.
   */
  async setLoggingLevel(level: string) {
    this._assertConnected();
    const result = await this.client!.setLoggingLevel(level as any);
    this.recordResponse();
    return result;
  }

  // ─── Completion ─────────────────────────────────────────────────────────────

  /**
   * Request completion from the target MCP server (for autocomplete UX).
   */
  async complete(params: Record<string, unknown>) {
    this._assertConnected();
    const result = await this.client!.complete(params as any);
    this.recordResponse();
    return result;
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
    };
  }

  /**
   * Cleanly shut down the client connection and child process.
   */
  async close(): Promise<void> {
    this._intentionalClose = true;
    this._clearStableTimer();

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
