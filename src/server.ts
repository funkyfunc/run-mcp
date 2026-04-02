import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ResponseInterceptor } from "./interceptor.js";
import { TargetManager } from "./target-manager.js";

export interface ServerOptions {
  outDir?: string;
  timeoutMs?: number;
  maxTextLength?: number;
}

/**
 * Starts `run-mcp` as an MCP Server exposing tools for dynamically testing
 * local MCP servers.
 *
 * This is the "test harness" mode: an agent building an MCP server can
 * connect to it, inspect its tools/resources/prompts, call tools (with
 * interception), disconnect, make code changes, and reconnect — all
 * within the same conversation.
 *
 * Unlike proxy mode (which is transparent middleware), this mode exposes
 * run-mcp's OWN tools with well-defined schemas. The agent explicitly
 * invokes `connect_to_mcp`, `call_mcp_tool`, etc.
 */
export async function startServer(opts: ServerOptions): Promise<void> {
  let target: TargetManager | null = null;
  const interceptor = new ResponseInterceptor({
    outDir: opts.outDir,
    defaultTimeoutMs: opts.timeoutMs,
    maxTextLength: opts.maxTextLength,
  });

  const mcpServer = new McpServer(
    { name: "run-mcp", version: "1.3.0" },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // ─── connect_to_mcp ─────────────────────────────────────────────────────

  mcpServer.registerTool(
    "connect_to_mcp",
    {
      title: "Connect to MCP Server",
      description:
        "Spawn and connect to a local MCP server process. " +
        "Use this to test an MCP server you're building. " +
        "Only one connection at a time — call disconnect_from_mcp first if already connected.",
      inputSchema: {
        command: z.string().describe("Command to run (e.g. 'node', 'python', 'npx')"),
        args: z
          .array(z.string())
          .optional()
          .describe("Arguments to pass (e.g. ['src/index.js'] or ['-y', 'some-server'])"),
        env: z
          .record(z.string())
          .optional()
          .describe("Extra environment variables for the child process"),
      },
    },
    async ({ command, args, env }) => {
      if (target?.connected) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Already connected to a target server. Call disconnect_from_mcp first, then connect again.",
            },
          ],
          isError: true,
        };
      }

      // Clean up any previous (disconnected) target
      if (target) {
        await target.close();
        target = null;
      }

      try {
        // If env vars are provided, set them before spawning
        if (env) {
          for (const [key, value] of Object.entries(env)) {
            process.env[key] = value;
          }
        }

        target = new TargetManager(command, args ?? []);
        await target.connect();

        const status = target.getStatus();
        const caps = target.getServerCapabilities() ?? {};

        // Gather a summary of what the target exposes
        const capSummary: string[] = [];
        if (caps.tools) capSummary.push("tools");
        if (caps.resources) capSummary.push("resources");
        if (caps.prompts) capSummary.push("prompts");
        if (caps.logging) capSummary.push("logging");

        // Try to count tools for a helpful summary
        let toolCount = 0;
        try {
          const tools = await target.listTools();
          toolCount = tools.tools.length;
        } catch {
          /* ignore */
        }

        const lines = [
          `Connected to MCP server (PID: ${status.pid})`,
          `Command: ${command} ${(args ?? []).join(" ")}`,
          `Capabilities: ${capSummary.join(", ") || "none"}`,
          `Tools available: ${toolCount}`,
          "",
          "Use list_mcp_tools, call_mcp_tool, list_mcp_resources, etc. to interact with it.",
          "Use disconnect_from_mcp when done, or to reconnect after code changes.",
        ];

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        target = null;
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Failed to connect: ${err.message}\n\n` +
                "Check that the command is correct and the server starts without errors. " +
                "You can also check get_mcp_server_stderr after a failed connect for more details.",
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ─── disconnect_from_mcp ────────────────────────────────────────────────

  mcpServer.registerTool(
    "disconnect_from_mcp",
    {
      title: "Disconnect from MCP Server",
      description:
        "Tear down the current MCP server connection. " +
        "Call this before reconnecting after code changes.",
    },
    async () => {
      if (!target) {
        return {
          content: [{ type: "text" as const, text: "No target server is connected." }],
          isError: true,
        };
      }

      const status = target.getStatus();
      await target.close();
      target = null;

      return {
        content: [
          {
            type: "text" as const,
            text: `Disconnected from MCP server (was PID: ${status.pid}, uptime: ${status.uptime.toFixed(1)}s).`,
          },
        ],
      };
    },
  );

  // ─── mcp_server_status ──────────────────────────────────────────────────

  mcpServer.registerTool(
    "mcp_server_status",
    {
      title: "MCP Server Status",
      description:
        "Check the current target server connection status, PID, uptime, and capabilities.",
    },
    async () => {
      if (!target) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No target server connected. Use connect_to_mcp to connect to one.",
            },
          ],
        };
      }

      const status = target.getStatus();
      const caps = target.getServerCapabilities() ?? {};

      const lines = [
        `Connected: ${status.connected}`,
        `PID: ${status.pid}`,
        `Uptime: ${status.uptime.toFixed(1)}s`,
        `Command: ${status.command} ${status.args.join(" ")}`,
        `Capabilities: ${Object.keys(caps).join(", ") || "none"}`,
        `Stderr lines: ${status.stderrLineCount}`,
        `Last response: ${status.lastResponseTime ? new Date(status.lastResponseTime).toISOString() : "none"}`,
      ];

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  // ─── list_mcp_tools ─────────────────────────────────────────────────────

  mcpServer.registerTool(
    "list_mcp_tools",
    {
      title: "List MCP Tools",
      description:
        "List all tools exposed by the connected MCP server, including descriptions, input schemas, and annotations.",
    },
    async () => {
      if (!target?.connected) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No target server connected. Use connect_to_mcp first.",
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await target.listTools();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result.tools, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error listing tools: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // ─── call_mcp_tool ──────────────────────────────────────────────────────

  mcpServer.registerTool(
    "call_mcp_tool",
    {
      title: "Call MCP Tool",
      description:
        "Call a tool on the connected MCP server. " +
        "Responses go through the interceptor: images/audio are saved to disk, " +
        "timeouts are enforced, and oversized text is truncated.",
      inputSchema: {
        name: z.string().describe("Name of the tool to call"),
        arguments: z
          .record(z.unknown())
          .optional()
          .describe("Arguments to pass to the tool (as a JSON object)"),
        timeout_ms: z
          .number()
          .optional()
          .describe("Timeout for this specific call in milliseconds (overrides default)"),
      },
    },
    async ({ name, arguments: toolArgs, timeout_ms }) => {
      if (!target?.connected) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No target server connected. Use connect_to_mcp first.",
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await interceptor.callTool(
          target,
          name,
          (toolArgs as Record<string, unknown>) ?? {},
          timeout_ms,
        );

        // The interceptor returns Record<string, unknown> but the result
        // is always a valid CallToolResult with content array
        return result as any;
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // ─── list_mcp_resources ─────────────────────────────────────────────────

  mcpServer.registerTool(
    "list_mcp_resources",
    {
      title: "List MCP Resources",
      description: "List all resources exposed by the connected MCP server.",
    },
    async () => {
      if (!target?.connected) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No target server connected. Use connect_to_mcp first.",
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await target.listResources();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.resources, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error listing resources: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // ─── read_mcp_resource ──────────────────────────────────────────────────

  mcpServer.registerTool(
    "read_mcp_resource",
    {
      title: "Read MCP Resource",
      description: "Read a specific resource by URI from the connected MCP server.",
      inputSchema: {
        uri: z.string().describe("URI of the resource to read (e.g. 'docs://readme')"),
      },
    },
    async ({ uri }) => {
      if (!target?.connected) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No target server connected. Use connect_to_mcp first.",
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await target.readResource({ uri });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.contents, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error reading resource: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // ─── list_mcp_prompts ───────────────────────────────────────────────────

  mcpServer.registerTool(
    "list_mcp_prompts",
    {
      title: "List MCP Prompts",
      description: "List all prompts exposed by the connected MCP server.",
    },
    async () => {
      if (!target?.connected) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No target server connected. Use connect_to_mcp first.",
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await target.listPrompts();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.prompts, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error listing prompts: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // ─── get_mcp_prompt ─────────────────────────────────────────────────────

  mcpServer.registerTool(
    "get_mcp_prompt",
    {
      title: "Get MCP Prompt",
      description: "Get a specific prompt by name from the connected MCP server.",
      inputSchema: {
        name: z.string().describe("Name of the prompt"),
        arguments: z.record(z.string()).optional().describe("Arguments to pass to the prompt"),
      },
    },
    async ({ name, arguments: promptArgs }) => {
      if (!target?.connected) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No target server connected. Use connect_to_mcp first.",
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await target.getPrompt({
          name,
          arguments: (promptArgs as Record<string, string>) ?? {},
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.messages, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error getting prompt: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // ─── get_mcp_server_stderr ──────────────────────────────────────────────

  mcpServer.registerTool(
    "get_mcp_server_stderr",
    {
      title: "Get MCP Server Stderr",
      description:
        "Get recent stderr output from the target MCP server. " +
        "Useful for debugging crashes, startup failures, or unexpected behavior.",
      inputSchema: {
        lines: z
          .number()
          .optional()
          .describe("Number of recent lines to return (default: all, max 200)"),
      },
    },
    async ({ lines }) => {
      if (!target) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No target server (current or previous). Nothing to show.",
            },
          ],
        };
      }

      const stderrLines = target.getStderrLines(lines);
      if (stderrLines.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No stderr output captured." }],
        };
      }

      return {
        content: [{ type: "text" as const, text: stderrLines.join("\n") }],
      };
    },
  );

  // ─── Start the MCP server on stdio ──────────────────────────────────────

  const transport = new StdioServerTransport();

  mcpServer.server.onclose = async () => {
    if (target) {
      await target.close();
    }
    process.exit(0);
  };

  await mcpServer.connect(transport);
  process.stderr.write("[server] run-mcp test harness running on stdio.\n");
  process.stderr.write("[server] Waiting for connect_to_mcp call...\n");
}
