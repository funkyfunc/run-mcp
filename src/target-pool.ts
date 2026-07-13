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
 */
export class TargetPool {
  readonly servers: PooledServer[];

  constructor(
    configs: PoolBackendConfig[],
    shared: {
      sandbox?: "auto" | "docker" | "native" | "audit" | "none";
      transport?: "auto" | "http" | "sse";
    } = {},
  ) {
    const usedPrefixes = new Set<string>();
    this.servers = configs.map((cfg) => {
      // Ensure prefixes are unique even if two names normalize to the same value.
      let prefix = normalizeServerName(cfg.name);
      let n = 2;
      while (usedPrefixes.has(prefix)) prefix = `${normalizeServerName(cfg.name)}_${n++}`;
      usedPrefixes.add(prefix);

      return {
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

  /** The backends that connected successfully. */
  connectedServers(): PooledServer[] {
    return this.servers.filter((s) => s.connected);
  }

  /** Resolve a `prefix` back to its connected server. */
  serverByPrefix(prefix: string): PooledServer | undefined {
    return this.servers.find((s) => s.connected && s.prefix === prefix);
  }

  async close(): Promise<void> {
    await Promise.all(this.servers.map((s) => s.target.close().catch(() => {})));
  }
}
