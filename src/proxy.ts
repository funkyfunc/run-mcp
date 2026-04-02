import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  LoggingMessageNotificationSchema,
  PromptListChangedNotificationSchema,
  ReadResourceRequestSchema,
  ResourceListChangedNotificationSchema,
  SetLevelRequestSchema,
  SubscribeRequestSchema,
  ToolListChangedNotificationSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ResponseInterceptor } from "./interceptor.js";
import { TargetManager } from "./target-manager.js";

export interface ProxyOptions {
  outDir?: string;
  timeoutMs?: number;
  maxTextLength?: number;
}

/**
 * Starts the MCP Proxy mode.
 *
 * Exposes an MCP Server on stdio (for the parent AI agent) that transparently
 * proxies ALL MCP primitives (tools, resources, prompts, logging, completion)
 * to the target MCP server.
 *
 * Tool responses run through the ResponseInterceptor for image/audio extraction,
 * timeouts, and truncation. All other primitives are forwarded as-is.
 *
 * Capabilities are dynamically mirrored from the target server, so the agent
 * sees exactly the same feature surface as if it were connected directly.
 *
 * Uses McpServer but registers handlers on the underlying `.server` property
 * to bypass McpServer's schema re-validation — a transparent proxy must
 * forward tool schemas and arguments as-is.
 */
export async function startProxy(targetCommand: string[], opts: ProxyOptions): Promise<void> {
  const [command, ...args] = targetCommand;
  const target = new TargetManager(command, args);
  const interceptor = new ResponseInterceptor({
    outDir: opts.outDir,
    defaultTimeoutMs: opts.timeoutMs,
    maxTextLength: opts.maxTextLength,
  });

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

  // ─── Mirror target capabilities ─────────────────────────────────────────

  const targetCaps = target.getServerCapabilities() ?? {};
  const proxyCaps: Record<string, unknown> = {};

  // Always forward tools (core use case)
  proxyCaps.tools = targetCaps.tools ?? {};

  // Conditionally mirror resources, prompts, logging, completion
  if (targetCaps.resources) proxyCaps.resources = targetCaps.resources;
  if (targetCaps.prompts) proxyCaps.prompts = targetCaps.prompts;
  if (targetCaps.logging) proxyCaps.logging = targetCaps.logging;
  if (targetCaps.completions) proxyCaps.completions = targetCaps.completions;

  process.stderr.write(`[proxy] Mirroring capabilities: ${Object.keys(proxyCaps).join(", ")}\n`);

  // Log target instructions if available (helpful diagnostic for agent developers)
  const instructions = target.getInstructions();
  if (instructions) {
    process.stderr.write(
      `[proxy] Target instructions: ${instructions.slice(0, 200)}${instructions.length > 200 ? "..." : ""}\n`,
    );
  }

  // Create McpServer with mirrored capabilities, then use the underlying
  // low-level server for transparent request handling.
  const mcpServer = new McpServer(
    {
      name: "run-mcp-proxy",
      version: "1.3.0",
    },
    { capabilities: proxyCaps },
  );
  const server = mcpServer.server;

  // ─── Tools ──────────────────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const result = await target.listTools(request.params);
    return result;
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: toolArgs } = request.params;

    try {
      const result = await interceptor.callTool(
        target,
        name,
        (toolArgs as Record<string, unknown>) ?? {},
      );

      // Return the full result — interceptor has already handled
      // images/audio/truncation in-place, preserving all properties:
      // content, structuredContent, isError, _meta, etc.
      return result;
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });

  // ─── Resources (conditional) ────────────────────────────────────────────

  if (targetCaps.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
      return await target.listResources(request.params);
    });

    server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
      return await target.listResourceTemplates(request.params);
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      return await target.readResource(request.params);
    });

    if (targetCaps.resources.subscribe) {
      server.setRequestHandler(SubscribeRequestSchema, async (request) => {
        return await target.subscribeResource(request.params);
      });

      server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
        return await target.unsubscribeResource(request.params);
      });
    }
  }

  // ─── Prompts (conditional) ──────────────────────────────────────────────

  if (targetCaps.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
      return await target.listPrompts(request.params);
    });

    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      return await target.getPrompt(request.params);
    });
  }

  // ─── Logging (conditional) ──────────────────────────────────────────────

  if (targetCaps.logging) {
    server.setRequestHandler(SetLevelRequestSchema, async (request) => {
      return await target.setLoggingLevel(request.params.level);
    });
  }

  // ─── Completion (conditional) ───────────────────────────────────────────

  if (targetCaps.completions) {
    server.setRequestHandler(CompleteRequestSchema, async (request) => {
      return await target.complete(request.params);
    });
  }

  // ─── Notification forwarding (target → agent) ──────────────────────────

  const rawClient = target.getRawClient();
  if (rawClient) {
    // Forward tool list changes
    if (targetCaps.tools && (targetCaps.tools as any).listChanged) {
      rawClient.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        server.notification({ method: "notifications/tools/list_changed" } as any);
      });
    }

    // Forward resource list changes
    if (targetCaps.resources && (targetCaps.resources as any).listChanged) {
      rawClient.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
        server.notification({ method: "notifications/resources/list_changed" } as any);
      });
    }

    // Forward prompt list changes
    if (targetCaps.prompts && (targetCaps.prompts as any).listChanged) {
      rawClient.setNotificationHandler(PromptListChangedNotificationSchema, () => {
        server.notification({ method: "notifications/prompts/list_changed" } as any);
      });
    }

    // Forward logging messages from target to agent
    if (targetCaps.logging) {
      rawClient.setNotificationHandler(LoggingMessageNotificationSchema, (notification: any) => {
        server.notification({
          method: "notifications/message",
          params: notification.params,
        } as any);
      });
    }
  }

  // ─── Connect proxy server to parent stdio ─────────────────────────────

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
