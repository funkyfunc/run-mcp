import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ResponseInterceptor } from "./interceptor.js";
import { TargetManager } from "./target-manager.js";
import { toolPoisoningScanner, outputCompressionPlugin } from "./plugins.js";
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
} from "./compression.js";

export interface ProxyOptions {
  /** Backend command + args (single backend for B1). */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Compression level for the tool catalog (default: medium). */
  level?: CompressionLevel;
  /** Restrict the exposed backend tools before compression. */
  includeTools?: string[];
  excludeTools?: string[];
  /** Sandbox + transport options forwarded to the backend TargetManager. */
  sandbox?: "auto" | "docker" | "native" | "audit" | "none";
  transport?: "auto" | "http" | "sse";
  /** Compress backend tool output text (lossless JSON minify). */
  compressOutput?: boolean;
}

/**
 * Transparent **compressing proxy** (Stage B1, single backend).
 *
 * run-mcp presents itself to a downstream MCP client as a normal MCP server, but
 * instead of forwarding the backend's full tool catalog it exposes a tiny
 * discovery-on-demand surface — `get_tool_schema` + `invoke_tool` (+ `list_tools`
 * at `max`) — with the compact catalog embedded in `get_tool_schema`'s
 * description. This slashes the tokens a client spends on tool metadata while
 * routing real calls through the existing interceptor (so the tool-poisoning
 * scanner and output compression still apply).
 */
export async function startProxyServer(opts: ProxyOptions): Promise<void> {
  const level = opts.level ?? DEFAULT_COMPRESSION_LEVEL;

  const interceptor = new ResponseInterceptor({
    plugins: [
      toolPoisoningScanner(),
      ...(opts.compressOutput ? [outputCompressionPlugin()] : []),
    ],
  });

  const target = new TargetManager(opts.command, opts.args ?? [], {
    sandbox: opts.sandbox,
    transport: opts.transport,
    env: opts.env,
  });

  try {
    await target.connect();
  } catch (err: any) {
    process.stderr.write(`[proxy] Failed to connect to backend: ${err.message}\n`);
    process.exit(1);
  }

  /** Read + filter + scan the backend's current tools. */
  async function loadTools(): Promise<BackendTool[]> {
    const { tools } = await target.listTools();
    // Scan metadata (strips invisible chars) before it reaches the client.
    const { tools: scanned } = await interceptor.processToolList(tools as any);
    return applyToolFilters(scanned as BackendTool[], {
      include: opts.includeTools,
      exclude: opts.excludeTools,
    });
  }

  const mcpServer = new McpServer(
    { name: "run-mcp-proxy", version: PKG_VERSION },
    { capabilities: { tools: {} } },
  );

  // ─── get_tool_schema ──────────────────────────────────────────────────────
  // The catalog lives in this tool's description; refresh it on each connection.
  const initialTools = await loadTools();

  mcpServer.registerTool(
    "get_tool_schema",
    {
      title: "Get Tool Schema",
      description: getToolSchemaDescription(initialTools, level),
      inputSchema: {
        name: z.string().describe("Exact backend tool name to fetch the full schema for"),
      },
    },
    async ({ name }) => {
      const tools = await loadTools();
      const tool = tools.find((t) => t.name === name);
      if (!tool) {
        const available = tools.map((t) => t.name).join(", ");
        return {
          content: [
            {
              type: "text" as const,
              text: `Tool "${name}" not found.\nAvailable: ${available}`,
            },
          ],
          isError: true,
        };
      }
      return { content: [{ type: "text" as const, text: formatSchemaResponse(tool) }] };
    },
  );

  // ─── invoke_tool ──────────────────────────────────────────────────────────
  mcpServer.registerTool(
    "invoke_tool",
    {
      title: "Invoke Tool",
      description: "Invoke one backend tool by name with a JSON input object.",
      inputSchema: {
        name: z.string().describe("Exact backend tool name to invoke"),
        input: z
          .record(z.unknown())
          .optional()
          .describe("Arguments object for the tool (matching its schema)"),
      },
    },
    async ({ name, input }) => {
      const tools = await loadTools();
      const tool = tools.find((t) => t.name === name);
      if (!tool) {
        const available = tools.map((t) => t.name).join(", ");
        return {
          content: [
            { type: "text" as const, text: `Tool "${name}" not found.\nAvailable: ${available}` },
          ],
          isError: true,
        };
      }
      const args = coerceStructuredArgs(tool.inputSchema, (input as Record<string, unknown>) ?? {});
      try {
        const result = await interceptor.callTool(target, name, args);
        return {
          content: [{ type: "text" as const, text: flattenToolResult(result) }],
          isError: (result as any).isError === true,
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // ─── list_tools (max compression only) ────────────────────────────────────
  if (level === "max") {
    mcpServer.registerTool(
      "list_tools",
      {
        title: "List Tools",
        description: "Enumerate the available backend tool names.",
      },
      async () => {
        const tools = await loadTools();
        return { content: [{ type: "text" as const, text: buildCatalog(tools, level) }] };
      },
    );
  }

  const transport = new StdioServerTransport();
  mcpServer.server.onclose = async () => {
    await target.close();
    process.exit(0);
  };

  await mcpServer.connect(transport);
  process.stderr.write(
    `[proxy] Compressing proxy running on stdio (level: ${level}, ${initialTools.length} backend tool(s)).\n`,
  );
}
