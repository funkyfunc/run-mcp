import { TargetManager } from "./target-manager.js";
import { normalizeServerName } from "./compression.js";

export interface PoolBackendConfig {
  /** Config key / logical server name. */
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Optional human description for the server overview. */
  description?: string;
}

export interface PooledServer {
  name: string;
  /** Normalized, collision-free tool-name prefix (e.g. `best_browser`). */
  prefix: string;
  description?: string;
  target: TargetManager;
  connected: boolean;
  error?: string;
}

/**
 * Manages a pool of backend MCP servers for the multiplexing compressing proxy
 * (Stage B2). Spawns each backend, connects eagerly with **failure isolation**
 * (one backend failing to start does not sink the proxy), and namespaces tools by
 * a collision-free per-server prefix so `invoke_tool` can route to the owner.
 *
 * With `autoReconnect` enabled, a backend that crashes mid-session is restarted
 * by its TargetManager (min-uptime / retry-cap rules apply) and its `connected`
 * flag tracks the live state, so the proxy can report a backend as down instead
 * of silently dropping its tools.
 */
export class TargetPool {
  readonly servers: PooledServer[];

  constructor(
    configs: PoolBackendConfig[],
    shared: {
      sandbox?: "auto" | "docker" | "native" | "audit" | "none";
      transport?: "auto" | "http" | "sse";
      /** Auto-restart backends that crash after a stable start (proxy mode). */
      autoReconnect?: boolean;
    } = {},
  ) {
    const usedPrefixes = new Set<string>();
    this.servers = configs.map((cfg) => {
      // Ensure prefixes are unique even if two names normalize to the same value.
      let prefix = normalizeServerName(cfg.name);
      let n = 2;
      while (usedPrefixes.has(prefix)) prefix = `${normalizeServerName(cfg.name)}_${n++}`;
      usedPrefixes.add(prefix);

      const server: PooledServer = {
        name: cfg.name,
        prefix,
        description: cfg.description,
        target: new TargetManager(cfg.command, cfg.args ?? [], {
          sandbox: shared.sandbox,
          transport: shared.transport,
          env: cfg.env,
        }),
        connected: false,
      };

      if (shared.autoReconnect) server.target.enableAutoReconnect();

      // Track live connection state so prefix resolution and the server
      // overview reflect reality, not the startup snapshot.
      server.target.on("connected", () => {
        server.connected = true;
        server.error = undefined;
      });
      server.target.on("disconnected", () => {
        server.connected = false;
        server.error = "backend disconnected unexpectedly";
      });
      server.target.on("reconnect_failed", ({ message }: { message: string }) => {
        server.connected = false;
        server.error = message;
      });

      return server;
    });
  }

  /** Connect every backend, isolating failures (logged to stderr, kept as error). */
  async connectAll(): Promise<void> {
    await Promise.all(
      this.servers.map(async (s) => {
        try {
          await s.target.connect();
          s.connected = true;
        } catch (err: any) {
          s.connected = false;
          s.error = err?.message ?? String(err);
          process.stderr.write(`[proxy] Backend "${s.name}" failed to connect: ${s.error}\n`);
          await s.target.close().catch(() => {});
        }
      }),
    );
  }

  /** The backends that are currently connected. */
  connectedServers(): PooledServer[] {
    return this.servers.filter((s) => s.connected);
  }

  /**
   * Resolve a `prefix` to its server, connected or not — callers distinguish
   * "unknown server" (undefined) from "known but down" (`!server.connected`)
   * so agents get an honest "backend down" instead of "tool not found".
   */
  serverByPrefix(prefix: string): PooledServer | undefined {
    return this.servers.find((s) => s.prefix === prefix);
  }

  async close(): Promise<void> {
    await Promise.all(this.servers.map((s) => s.target.close().catch(() => {})));
  }
}
