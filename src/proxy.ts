import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ResponseInterceptor } from "./interceptor.js";
import { TargetManager } from "./target-manager.js";
import { TargetPool, type PoolBackendConfig, type PooledServer } from "./target-pool.js";
import { ToolListCache } from "./tool-cache.js";
import { toolPoisoningScanner, outputCompressionPlugin } from "./plugins.js";
import { rankTools } from "./ranking.js";
import { groupToolsByPrefix } from "./parsing.js";
import {
  type BackendTool,
  type CompressionLevel,
  DEFAULT_COMPRESSION_LEVEL,
  applyToolFilters,
  coerceStructuredArgs,
  fitCatalogLevel,
  flattenToolResult,
  formatSchemaResponse,
  getToolSchemaDescription,
  buildCatalog,
  formatCatalogEntry,
  firstSentence,
  namespaceToolName,
  parseNamespacedName,
} from "./compression.js";

export interface ProxyOptions {
  /** Single-backend command + args (B1). Mutually exclusive with `backends`. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Multiple named backends (B2 multiplexer). */
  backends?: PoolBackendConfig[];
  /** Compression level for the tool catalog (default: medium). */
  level?: CompressionLevel;
  /** Restrict the exposed backend tools before compression. */
  includeTools?: string[];
  excludeTools?: string[];
  /** Sandbox + transport options forwarded to the backend(s). */
  sandbox?: "auto" | "docker" | "native" | "audit" | "none";
  transport?: "auto" | "http" | "sse";
  /** Compress backend tool output text (lossless JSON minify). */
  compressOutput?: boolean;
}

/**
 * Transparent **compressing proxy**. run-mcp presents itself to a downstream MCP
 * client as a normal MCP server but replaces the backend tool catalog with a tiny
 * discovery-on-demand surface, slashing the tokens a client spends on tool
 * metadata. Real calls route through the interceptor (poisoning scan + optional
 * output compression still apply).
 *
 *  - **Single backend (B1):** `get_tool_schema` + `invoke_tool` (+ `list_tools` at
 *    `max`); the compact catalog lives in `get_tool_schema`'s description.
 *  - **Multiple backends (B2):** a Dynamic-Context-Loading surface — `list_servers`
 *    (Level 1 overview, free in its description), `find_tools` (cross-server BM25),
 *    `list_server_tools` (Level 2), `get_tool_schema`/`invoke_tool` (namespaced
 *    `server__tool`).
 *
 * Reliability behavior:
 *  - Backend tool lists are **cached** (invalidated by `tools/list_changed`, TTL
 *    fallback) instead of re-fetched per call.
 *  - Backends **auto-reconnect** after a stable-start crash; a downed backend is
 *    reported honestly ("backend down"), not as "tool not found".
 *  - Backend **sampling/elicitation requests are forwarded** to the downstream
 *    client instead of timing out.
 *  - Catalog descriptions refresh only when the catalog truly changes, keeping
 *    the surface prompt-cache-stable.
 */
export async function startProxyServer(opts: ProxyOptions): Promise<void> {
  const level = opts.level ?? DEFAULT_COMPRESSION_LEVEL;
  const filters = { include: opts.includeTools, exclude: opts.excludeTools };

  const interceptor = new ResponseInterceptor({
    plugins: [toolPoisoningScanner(), ...(opts.compressOutput ? [outputCompressionPlugin()] : [])],
  });

  const mcpServer = new McpServer(
    { name: "run-mcp-proxy", version: PKG_VERSION },
    { capabilities: { tools: {} } },
  );

  const backends = opts.backends ?? [];
  if (backends.length >= 2) {
    await registerMultiplexSurface(mcpServer, interceptor, level, filters, backends, opts);
  } else {
    // Single backend: either the lone config entry or the `-- cmd` form.
    const single = backends[0];
    const command = single?.command ?? opts.command;
    if (!command) {
      process.stderr.write("[proxy] No backend command provided.\n");
      process.exit(1);
    }
    const target = new TargetManager(command, single?.args ?? opts.args ?? [], {
      sandbox: opts.sandbox,
      transport: opts.transport,
      env: single?.env ?? opts.env,
    });
    await registerSingleSurface(mcpServer, interceptor, level, filters, target);
  }

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

/**
 * Forward backend-initiated sampling/elicitation requests to the downstream
 * client. Without this, a backend that requests sampling waits five minutes
 * behind the proxy and gets a timeout rejection.
 */
function forwardClientRequests(mcpServer: McpServer, target: TargetManager): void {
  target.on("sampling_request", async ({ request, respond, reject }: any) => {
    try {
      const result = await mcpServer.server.request(
        { method: "sampling/createMessage", params: request },
        z.any(),
      );
      respond(result);
    } catch (err: any) {
      reject(err);
    }
  });

  target.on("elicitation_request", async ({ request, respond, reject }: any) => {
    try {
      const result = await mcpServer.server.request(
        { method: "elicitation/create", params: request },
        z.any(),
      );
      respond(result);
    } catch (err: any) {
      reject(err);
    }
  });
}

/** Fetch, scan, and filter a backend's full (pagination-followed) tool list. */
function scannedToolsFetcher(
  target: TargetManager,
  interceptor: ResponseInterceptor,
  filters: { include?: string[]; exclude?: string[] },
): () => Promise<BackendTool[]> {
  return async () => {
    const { tools } = await target.listAllTools();
    const { tools: scanned } = await interceptor.processToolList(tools as any);
    return applyToolFilters(scanned as BackendTool[], filters);
  };
}

// ─── Single-backend surface (B1) ────────────────────────────────────────────

async function registerSingleSurface(
  mcpServer: McpServer,
  interceptor: ResponseInterceptor,
  requestedLevel: CompressionLevel,
  filters: { include?: string[]; exclude?: string[] },
  target: TargetManager,
): Promise<void> {
  try {
    await target.connect();
  } catch (err: any) {
    process.stderr.write(`[proxy] Failed to connect to backend: ${err.message}\n`);
    process.exit(1);
  }

  target.enableAutoReconnect();
  forwardClientRequests(mcpServer, target);

  const cache = new ToolListCache<BackendTool>(scannedToolsFetcher(target, interceptor, filters));
  const initialTools = await cache.get();

  // Pin the effective level at startup: past ~4k tokens the embedded catalog
  // costs more context than the compression saves, so escalate (with a notice
  // — never silently).
  const fit = fitCatalogLevel(initialTools, requestedLevel);
  const level = fit.level;
  if (fit.escalated) {
    process.stderr.write(
      `[proxy] Catalog too large at level "${requestedLevel}" ` +
        `(${initialTools.length} tools) — escalated to "${level}" to protect context.\n`,
    );
  }

  const backendDown = () => ({
    content: [
      {
        type: "text" as const,
        text:
          "Backend server is disconnected (it may have crashed). run-mcp is attempting " +
          "to auto-reconnect — retry shortly, or restart the proxy if this persists.",
      },
    ],
    isError: true as const,
  });

  /** Look up a tool, force-refreshing the cache once before declaring a miss. */
  const findTool = async (name: string) => {
    let tools = await cache.get();
    let tool = tools.find((t) => t.name === name);
    if (!tool) {
      tools = await cache.refresh();
      tool = tools.find((t) => t.name === name);
    }
    return { tool, tools };
  };

  const getSchemaTool = mcpServer.registerTool(
    "get_tool_schema",
    {
      title: "Get Tool Schema",
      description: getToolSchemaDescription(initialTools, level),
      inputSchema: { name: z.string().describe("Exact backend tool name to fetch the schema for") },
    },
    async ({ name }) => {
      if (!target.connected) return backendDown();
      const { tool, tools } = await findTool(name);
      if (!tool) return notFound(name, tools);
      return { content: [{ type: "text" as const, text: formatSchemaResponse(tool) }] };
    },
  );

  mcpServer.registerTool(
    "invoke_tool",
    {
      title: "Invoke Tool",
      description: "Invoke one backend tool by name with a JSON input object.",
      inputSchema: {
        name: z.string().describe("Exact backend tool name to invoke"),
        input: z.record(z.unknown()).optional().describe("Arguments object for the tool"),
      },
    },
    async ({ name, input }) => {
      if (!target.connected) return backendDown();
      const { tool, tools } = await findTool(name);
      if (!tool) return notFound(name, tools);
      return runTool(interceptor, target, name, tool, (input as Record<string, unknown>) ?? {});
    },
  );

  if (level === "max") {
    mcpServer.registerTool(
      "list_tools",
      { title: "List Tools", description: "Enumerate the available backend tool names." },
      async () => {
        if (!target.connected) return backendDown();
        return {
          content: [{ type: "text" as const, text: buildCatalog(await cache.get(), level) }],
        };
      },
    );
  }

  // Keep the embedded catalog honest without churning it: refresh the cache on
  // the backend's own change signals and update the description ONLY when the
  // catalog text actually changed (prompt-cache stability).
  let lastDescription = getToolSchemaDescription(initialTools, level);
  const syncCatalogDescription = async () => {
    try {
      const tools = await cache.refresh();
      const description = getToolSchemaDescription(tools, level);
      if (description === lastDescription) return;
      lastDescription = description;
      getSchemaTool.update({ description });
    } catch {
      // Backend hiccup — the next signal or TTL refresh will catch up.
    }
  };
  target.on("notification", (record: { method: string }) => {
    if (record.method === "notifications/tools/list_changed") void syncCatalogDescription();
  });
  target.on("reconnected", () => void syncCatalogDescription());

  mcpServer.server.onclose = async () => {
    await target.close();
    process.exit(0);
  };
  process.stderr.write(
    `[proxy] Compressing proxy on stdio (level: ${level}, ${initialTools.length} backend tool(s)).\n`,
  );
}

// ─── Multiplexing surface (B2, Dynamic Context Loading) ─────────────────────

async function registerMultiplexSurface(
  mcpServer: McpServer,
  interceptor: ResponseInterceptor,
  level: CompressionLevel,
  filters: { include?: string[]; exclude?: string[] },
  backends: PoolBackendConfig[],
  opts: ProxyOptions,
): Promise<void> {
  const pool = new TargetPool(backends, {
    sandbox: opts.sandbox,
    transport: opts.transport,
    autoReconnect: true,
  });
  await pool.connectAll();

  if (pool.connectedServers().length === 0) {
    process.stderr.write("[proxy] No backends connected. Exiting.\n");
    process.exit(1);
  }

  // Per-backend cached tool lists (scanned + filtered).
  const caches = new Map<string, ToolListCache<BackendTool>>();
  for (const s of pool.servers) {
    caches.set(s.prefix, new ToolListCache(scannedToolsFetcher(s.target, interceptor, filters)));
    forwardClientRequests(mcpServer, s.target);
  }

  /** A server's current (scanned + filtered) tools, from cache. */
  const serverTools = (s: PooledServer): Promise<BackendTool[]> => caches.get(s.prefix)!.get();

  /** Build the Level-1 server overview — every backend, with live status. */
  const serverOverview = async (): Promise<string> => {
    const lines = await Promise.all(
      pool.servers.map(async (s) => {
        if (!s.connected) {
          const reason = s.error ? ` — ${s.error}` : "";
          return `<server>${s.prefix}: DOWN${reason}. Tools unavailable until it reconnects.</server>`;
        }
        try {
          const tools = await serverTools(s);
          return `<server>${s.prefix}: ${describeServer(s, tools)} (${tools.length} tools)</server>`;
        } catch (err: any) {
          return `<server>${s.prefix}: unavailable (${err.message})</server>`;
        }
      }),
    );
    return lines.join("\n");
  };

  const overview = await serverOverview();
  const LIST_SERVERS_DESCRIPTION =
    "List the backend MCP servers this proxy fronts and what each is for. " +
    "Available servers:\n";

  const listServersTool = mcpServer.registerTool(
    "list_servers",
    {
      title: "List Servers",
      description: LIST_SERVERS_DESCRIPTION + overview,
    },
    async () => ({ content: [{ type: "text" as const, text: await serverOverview() }] }),
  );

  // Keep the embedded overview honest without churning it (prompt-cache
  // stability): recompute on backend change signals, update only on real change.
  let lastOverview = overview;
  const syncOverview = async () => {
    try {
      const current = await serverOverview();
      if (current === lastOverview) return;
      lastOverview = current;
      listServersTool.update({ description: LIST_SERVERS_DESCRIPTION + current });
    } catch {
      // Transient — the next signal will catch up.
    }
  };
  for (const s of pool.servers) {
    s.target.on("notification", (record: { method: string }) => {
      if (record.method !== "notifications/tools/list_changed") return;
      void caches
        .get(s.prefix)!
        .refresh()
        .then(syncOverview)
        .catch(() => {});
    });
    s.target.on("reconnected", () => {
      void caches
        .get(s.prefix)!
        .refresh()
        .then(syncOverview)
        .catch(() => {});
    });
    s.target.on("disconnected", () => void syncOverview());
  }

  mcpServer.registerTool(
    "find_tools",
    {
      title: "Find Tools",
      description:
        "Search all backend servers' tools by relevance to a query (BM25). Returns " +
        "ranked, namespaced tool names (server__tool) with brief summaries — then use " +
        "get_tool_schema for the full schema and invoke_tool to run it.",
      inputSchema: {
        query: z.string().describe("What you want to do (keywords or natural language)"),
        limit: z.number().optional().describe("Max results (default 8)"),
      },
    },
    async ({ query, limit }) => {
      const connected = pool.connectedServers();
      const perServer = await Promise.all(
        connected.map(async (s) =>
          (await serverTools(s)).map((t) => ({ ...t, name: namespaceToolName(s.prefix, t.name) })),
        ),
      );
      const rankable: BackendTool[] = perServer.flat();
      const ranked = rankTools(query, rankable, limit ?? 8);
      if (ranked.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No tools matched "${query}" across ${connected.length} server(s).`,
            },
          ],
        };
      }
      const text = ranked.map(({ tool }) => formatCatalogEntry(tool, "medium")).join("\n");
      return { content: [{ type: "text" as const, text }] };
    },
  );

  const knownPrefixes = () =>
    pool.servers.map((s) => (s.connected ? s.prefix : `${s.prefix} (down)`)).join(", ");

  const backendDown = (s: PooledServer) => ({
    content: [
      {
        type: "text" as const,
        text:
          `Backend server "${s.prefix}" is down${s.error ? ` (${s.error})` : ""}. ` +
          "run-mcp attempts to auto-reconnect after stable-start crashes — retry shortly, " +
          "or check the backend with list_servers.",
      },
    ],
    isError: true as const,
  });

  mcpServer.registerTool(
    "list_server_tools",
    {
      title: "List Server Tools",
      description:
        "List one backend server's tools (namespaced). Use the prefix from list_servers.",
      inputSchema: { server: z.string().describe("Server prefix (e.g. from list_servers)") },
    },
    async ({ server }) => {
      const s = pool.serverByPrefix(server);
      if (!s) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Server "${server}" not found.\nAvailable: ${knownPrefixes()}`,
            },
          ],
          isError: true,
        };
      }
      if (!s.connected) return backendDown(s);
      const tools = (await serverTools(s)).map((t) => ({
        ...t,
        name: namespaceToolName(s.prefix, t.name),
      }));
      return { content: [{ type: "text" as const, text: buildCatalog(tools, level) }] };
    },
  );

  type Resolution =
    | { ok: true; server: PooledServer; tool: BackendTool }
    | { ok: false; response: { content: { type: "text"; text: string }[]; isError: true } };

  const resolve = async (namespaced: string): Promise<Resolution> => {
    const fail = (text: string): Resolution => ({
      ok: false,
      response: { content: [{ type: "text" as const, text }], isError: true },
    });

    const parsed = parseNamespacedName(namespaced);
    if (!parsed) {
      return fail(
        `Tool "${namespaced}" is not a namespaced name (expected server__tool). ` +
          "Use find_tools to discover names.",
      );
    }
    const server = pool.serverByPrefix(parsed.prefix);
    if (!server) {
      return fail(
        `Server "${parsed.prefix}" not found.\nAvailable: ${knownPrefixes()}. ` +
          "Use find_tools to discover names.",
      );
    }
    if (!server.connected) return { ok: false, response: backendDown(server) };

    // Force-refresh once before declaring a miss — the backend may have added
    // the tool since the last cache fill.
    const cache = caches.get(server.prefix)!;
    let tool = (await cache.get()).find((t) => t.name === parsed.tool);
    if (!tool) tool = (await cache.refresh()).find((t) => t.name === parsed.tool);
    if (!tool) {
      return fail(
        `Tool "${parsed.tool}" not found on server "${parsed.prefix}". ` +
          "Use list_server_tools or find_tools to discover names.",
      );
    }
    return { ok: true, server, tool };
  };

  mcpServer.registerTool(
    "get_tool_schema",
    {
      title: "Get Tool Schema",
      description:
        "Get the full schema for one namespaced tool (server__tool). Use find_tools or " +
        "list_server_tools to discover names.",
      inputSchema: { name: z.string().describe("Namespaced tool name, e.g. github__create_issue") },
    },
    async ({ name }) => {
      const found = await resolve(name);
      if (!found.ok) return found.response;
      // Present the schema under the namespaced name.
      const display = { ...found.tool, name };
      return { content: [{ type: "text" as const, text: formatSchemaResponse(display) }] };
    },
  );

  mcpServer.registerTool(
    "invoke_tool",
    {
      title: "Invoke Tool",
      description: "Invoke one namespaced tool (server__tool) with a JSON input object.",
      inputSchema: {
        name: z.string().describe("Namespaced tool name, e.g. github__create_issue"),
        input: z.record(z.unknown()).optional().describe("Arguments object for the tool"),
      },
    },
    async ({ name, input }) => {
      const found = await resolve(name);
      if (!found.ok) return found.response;
      return runTool(
        interceptor,
        found.server.target,
        found.tool.name,
        found.tool,
        (input as Record<string, unknown>) ?? {},
      );
    },
  );

  mcpServer.server.onclose = async () => {
    await pool.close();
    process.exit(0);
  };
  process.stderr.write(
    `[proxy] Multiplexing proxy on stdio (level: ${level}, ` +
      `${pool.connectedServers().length}/${pool.servers.length} backend(s) connected).\n`,
  );
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

function notFound(name: string, tools: BackendTool[]) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Tool "${name}" not found.\nAvailable: ${tools.map((t) => t.name).join(", ")}`,
      },
    ],
    isError: true as const,
  };
}

async function runTool(
  interceptor: ResponseInterceptor,
  target: TargetManager,
  toolName: string,
  tool: BackendTool,
  input: Record<string, unknown>,
) {
  const args = coerceStructuredArgs(tool.inputSchema, input);
  try {
    const result = await interceptor.callTool(target, toolName, args);
    return {
      content: [{ type: "text" as const, text: flattenToolResult(result) }],
      isError: (result as any).isError === true,
    };
  } catch (err: any) {
    return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
  }
}

/**
 * A one-line description of a server for the overview, preferring (in order): a
 * config-supplied description, the server's own MCP `instructions`, or a heuristic
 * derived from its tool catalog.
 */
function describeServer(server: PooledServer, tools: BackendTool[]): string {
  if (server.description) return server.description.trim();

  const instructions = server.target.getInstructions();
  if (instructions && instructions.trim()) return firstSentence(instructions);

  if (tools.length === 0) return "no tools";
  const groups = groupToolsByPrefix(tools.map((t) => t.name));
  if (!groups.has("All")) {
    return `groups: ${[...groups.keys()].join(", ")}`;
  }
  const names = tools.slice(0, 5).map((t) => t.name);
  return `tools: ${names.join(", ")}${tools.length > 5 ? ", …" : ""}`;
}
