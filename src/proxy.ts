import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ResponseInterceptor } from "./interceptor.js";
import { TargetManager } from "./target-manager.js";

interface ProxyOptions {
  outDir?: string;
}

/**
 * Starts the MCP Proxy mode.
 *
 * Exposes an MCP Server on stdio (for the parent AI agent) that transparently
 * proxies tools/list and tools/call to the target MCP server, running all
 * responses through the ResponseInterceptor for image extraction, timeouts,
 * and truncation.
 *
 * Uses McpServer but registers handlers on the underlying `.server` property
 * to bypass McpServer's schema re-validation — a transparent proxy must
 * forward tool schemas and arguments as-is.
 */
export async function startProxy(targetCommand: string[], opts: ProxyOptions): Promise<void> {
  const [command, ...args] = targetCommand;
  const target = new TargetManager(command, args);
  const interceptor = new ResponseInterceptor({ outDir: opts.outDir });

  // Redirect server stderr to our stderr (can't use stdout — that's the MCP channel)
  target.on("stderr", (text: string) => {
    process.stderr.write(`[target] ${text}\n`);
  });

  // Connect to the target MCP server
  process.stderr.write("[proxy] Connecting to target MCP server...\n");
  try {
    await target.connect();
  } catch (err: any) {
    process.stderr.write(`[proxy] Failed to connect to target: ${err.message}\n`);
    process.exit(1);
  }

  const status = target.getStatus();
  process.stderr.write(`[proxy] Connected to target (PID: ${status.pid})\n`);

  // Create McpServer, then use the underlying low-level server for transparent
  // request handling (McpServer.registerTool re-validates schemas, which breaks
  // passthrough of arbitrary tool arguments).
  const mcpServer = new McpServer(
    {
      name: "run-mcp-proxy",
      version: "1.1.0",
    },
    { capabilities: { tools: {} } },
  );
  const server = mcpServer.server;

  // ─── ListTools: pass through from target ──────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const result = await target.listTools();
    return { tools: result.tools };
  });

  // ─── CallTool: pass through interceptor → target ──────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: toolArgs } = request.params;

    try {
      const result = await interceptor.callTool(
        target,
        name,
        (toolArgs as Record<string, unknown>) ?? {},
      );

      // Map intercepted content to proper MCP content types
      const content = ((result as any).content ?? []).map((item: any) => {
        if (item.type === "image") {
          return { type: "image" as const, data: item.data, mimeType: item.mimeType };
        }
        return { type: "text" as const, text: String(item.text ?? "") };
      });

      return { content };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });

  // ─── Connect proxy server to parent stdio ─────────────────────────────────

  const transport = new StdioServerTransport();

  server.onclose = async () => {
    process.stderr.write("[proxy] Parent disconnected, shutting down...\n");
    await target.close();
    process.exit(0);
  };

  await mcpServer.connect(transport);
  process.stderr.write("[proxy] Proxy server running on stdio.\n");

  // Clean up target if we get terminated
  target.on("disconnected", () => {
    process.stderr.write("[proxy] Target server disconnected.\n");
    process.exit(1);
  });
}
