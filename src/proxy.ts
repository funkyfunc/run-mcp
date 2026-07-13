import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ResponseInterceptor } from "./interceptor.js";
import { TargetManager } from "./target-manager.js";
import { TargetPool, type PoolBackendConfig, type PooledServer } from "./target-pool.js";
import { toolPoisoningScanner, outputCompressionPlugin } from "./plugins.js";
import { rankTools } from "./ranking.js";
import { groupToolsByPrefix } from "./parsing.js";
import {
  type BackendTool,
  type CompressionLevel,
  DEFAULT_COMPRESSION_LEVEL,
  applyToolFilters,
  coerceStructuredArgs,
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

// ─── Single-backend surface (B1) ────────────────────────────────────────────

async function registerSingleSurface(
  mcpServer: McpServer,
  interceptor: ResponseInterceptor,
  level: CompressionLevel,
  filters: { include?: string[]; exclude?: string[] },
  target: TargetManager,
): Promise<void> {
  try {
    await target.connect();
  } catch (err: any) {
    process.stderr.write(`[proxy] Failed to connect to backend: ${err.message}\n`);
    process.exit(1);
  }

  const loadTools = async (): Promise<BackendTool[]> => {
    const { tools } = await target.listTools();
    const { tools: scanned } = await interceptor.processToolList(tools as any);
    return applyToolFilters(scanned as BackendTool[], filters);
  };

  const initialTools = await loadTools();

  mcpServer.registerTool(
    "get_tool_schema",
    {
      title: "Get Tool Schema",
      description: getToolSchemaDescription(initialTools, level),
      inputSchema: { name: z.string().describe("Exact backend tool name to fetch the schema for") },
    },
    async ({ name }) => {
      const tools = await loadTools();
      const tool = tools.find((t) => t.name === name);
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
      const tools = await loadTools();
      const tool = tools.find((t) => t.name === name);
      if (!tool) return notFound(name, tools);
      return runTool(interceptor, target, name, tool, (input as Record<string, unknown>) ?? {});
    },
  );

  if (level === "max") {
    mcpServer.registerTool(
      "list_tools",
      { title: "List Tools", description: "Enumerate the available backend tool names." },
      async () => ({
        content: [{ type: "text" as const, text: buildCatalog(await loadTools(), level) }],
      }),
    );
  }

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
  const pool = new TargetPool(backends, { sandbox: opts.sandbox, transport: opts.transport });
  await pool.connectAll();

  const connected = pool.connectedServers();
  if (connected.length === 0) {
    process.stderr.write("[proxy] No backends connected. Exiting.\n");
    process.exit(1);
  }

  /** A server's current (scanned + filtered) tools. */
  const serverTools = async (s: PooledServer): Promise<BackendTool[]> => {
    const { tools } = await s.target.listTools();
    const { tools: scanned } = await interceptor.processToolList(tools as any);
    return applyToolFilters(scanned as BackendTool[], filters);
  };

  /** Build the Level-1 server overview (embedded free in list_servers' description). */
  const serverOverview = async (): Promise<string> => {
    const lines: string[] = [];
    for (const s of connected) {
      const tools = await serverTools(s);
      lines.push(
        `<server>${s.prefix}: ${describeServer(s, tools)} (${tools.length} tools)</server>`,
      );
    }
    return lines.join("\n");
  };

  const overview = await serverOverview();

  mcpServer.registerTool(
    "list_servers",
    {
      title: "List Servers",
      description:
        "List the backend MCP servers this proxy fronts and what each is for. " +
        "Available servers:\n" +
        overview,
    },
    async () => ({ content: [{ type: "text" as const, text: await serverOverview() }] }),
  );

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
      const rankable: BackendTool[] = [];
      for (const s of connected) {
        for (const t of await serverTools(s)) {
          rankable.push({ ...t, name: namespaceToolName(s.prefix, t.name) });
        }
      }
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
        const available = connected.map((c) => c.prefix).join(", ");
        return {
          content: [
            {
              type: "text" as const,
              text: `Server "${server}" not found.\nAvailable: ${available}`,
            },
          ],
          isError: true,
        };
      }
      const tools = (await serverTools(s)).map((t) => ({
        ...t,
        name: namespaceToolName(s.prefix, t.name),
      }));
      return { content: [{ type: "text" as const, text: buildCatalog(tools, level) }] };
    },
  );

  const resolve = async (
    namespaced: string,
  ): Promise<{ server: PooledServer; tool: BackendTool } | undefined> => {
    const parsed = parseNamespacedName(namespaced);
    if (!parsed) return undefined;
    const server = pool.serverByPrefix(parsed.prefix);
    if (!server) return undefined;
    const tool = (await serverTools(server)).find((t) => t.name === parsed.tool);
    return tool ? { server, tool } : undefined;
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
      if (!found) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Tool "${name}" not found. Use find_tools to discover names.`,
            },
          ],
          isError: true,
        };
      }
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
      if (!found) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Tool "${name}" not found. Use find_tools to discover names.`,
            },
          ],
          isError: true,
        };
      }
      const parsed = parseNamespacedName(name)!;
      return runTool(
        interceptor,
        found.server.target,
        parsed.tool,
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
    `[proxy] Multiplexing proxy on stdio (level: ${level}, ${connected.length}/${pool.servers.length} backend(s) connected).\n`,
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
