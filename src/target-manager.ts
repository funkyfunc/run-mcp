import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EventEmitter } from "node:events";

export interface TargetStatus {
  pid: number | null;
  uptime: number;
  connected: boolean;
  command: string;
  args: string[];
}

/**
 * Manages the lifecycle of a target MCP server process.
 *
 * Spawns the target as a child process via StdioClientTransport,
 * exposes the MCP Client for listTools/callTool, captures stderr,
 * and ensures graceful cleanup on exit.
 */
export class TargetManager extends EventEmitter {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private startTime: number = 0;
  private childPid: number | null = null;
  private _connected = false;

  constructor(
    private readonly command: string,
    private readonly args: string[],
  ) {
    super();
  }

  /**
   * Spawn the target MCP server and establish the MCP client connection.
   * Stderr from the child process is emitted as 'stderr' events.
   */
  async connect(): Promise<void> {
    this.transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      stderr: "pipe",
    });

    // Capture stderr from child process
    this.transport.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trimEnd();
      if (text) {
        this.emit("stderr", text);
      }
    });

    this.client = new Client(
      { name: "run-mcp", version: "1.0.0" },
      { capabilities: {} },
    );

    this.client.onclose = () => {
      this._connected = false;
      this.emit("disconnected");
    };

    await this.client.connect(this.transport);

    this._connected = true;
    this.startTime = Date.now();

    // Try to capture child PID from transport internals
    // StdioClientTransport exposes the child process indirectly
    const proc = (this.transport as any)._process;
    if (proc?.pid) {
      this.childPid = proc.pid;
    }

    this.emit("connected");
    this._registerCleanup();
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * List all tools exposed by the target MCP server.
   */
  async listTools() {
    this._assertConnected();
    return this.client!.listTools();
  }

  /**
   * Call a tool on the target MCP server.
   */
  async callTool(name: string, args: Record<string, unknown> = {}) {
    this._assertConnected();
    return this.client!.callTool({ name, arguments: args });
  }

  /**
   * Returns current connection status, PID, and uptime.
   */
  getStatus(): TargetStatus {
    return {
      pid: this.childPid,
      uptime: this._connected ? (Date.now() - this.startTime) / 1000 : 0,
      connected: this._connected,
      command: this.command,
      args: this.args,
    };
  }

  /**
   * Cleanly shut down the client connection and child process.
   */
  async close(): Promise<void> {
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

  private _assertConnected(): void {
    if (!this._connected || !this.client) {
      throw new Error("Not connected to target MCP server");
    }
  }

  private _cleanupRegistered = false;

  private _registerCleanup(): void {
    if (this._cleanupRegistered) return;
    this._cleanupRegistered = true;

    const cleanup = () => {
      this.close().catch(() => {});
    };

    process.on("exit", cleanup);
    process.on("SIGINT", () => {
      cleanup();
      process.exit(130);
    });
    process.on("SIGTERM", () => {
      cleanup();
      process.exit(143);
    });
  }
}
