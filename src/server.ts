import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ResponseInterceptor } from "./interceptor.js";
import { suggestCommand } from "./parsing.js";
import { TargetManager } from "./target-manager.js";

export interface ServerOptions {
  outDir?: string;
  timeoutMs?: number;
  maxTextLength?: number;
}

// ─── Snapshot types for reconnect diffing ──────────────────────────────────

interface ToolSnapshot {
  name: string;
  hash: string;
}

interface ResourceSnapshot {
  uri: string;
  name: string;
}

interface PromptSnapshot {
  name: string;
  hash: string;
}

interface Snapshot {
  tools?: ToolSnapshot[];
  resources?: ResourceSnapshot[];
  prompts?: PromptSnapshot[];
}

interface DiffEntry {
  added: string[];
  removed: string[];
  modified: string[];
}

/**
 * Hash a tool/prompt definition for change detection.
 * Includes description + schema so we detect both schema and doc changes.
 */
function hashDefinition(obj: Record<string, unknown>): string {
  return createHash("md5").update(JSON.stringify(obj)).digest("hex").slice(0, 12);
}

/**
 * Compute a diff between two lists of named+hashed items.
 */
function computeDiff(
  prev: { name: string; hash: string }[],
  curr: { name: string; hash: string }[],
): DiffEntry {
  const prevMap = new Map(prev.map((p) => [p.name, p.hash]));
  const currMap = new Map(curr.map((c) => [c.name, c.hash]));

  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];

  for (const [name, hash] of currMap) {
    if (!prevMap.has(name)) {
      added.push(name);
    } else if (prevMap.get(name) !== hash) {
      modified.push(name);
    }
  }
  for (const name of prevMap.keys()) {
    if (!currMap.has(name)) {
      removed.push(name);
    }
  }

  return { added, removed, modified };
}

/**
 * Compute a diff between two resource lists (no hash — just presence).
 */
function computeResourceDiff(prev: ResourceSnapshot[], curr: ResourceSnapshot[]): DiffEntry {
  const prevUris = new Set(prev.map((r) => r.uri));
  const currUris = new Set(curr.map((r) => r.uri));

  const added = [...currUris].filter((u) => !prevUris.has(u));
  const removed = [...prevUris].filter((u) => !currUris.has(u));

  return { added, removed, modified: [] };
}

/**
 * Format a diff entry as a human-readable summary line.
 */
function formatDiffLine(label: string, diff: DiffEntry): string {
  const parts: string[] = [];
  if (diff.added.length > 0) parts.push(`+${diff.added.length} added`);
  if (diff.modified.length > 0) parts.push(`~${diff.modified.length} modified`);
  if (diff.removed.length > 0) parts.push(`-${diff.removed.length} removed`);

  if (parts.length === 0) return `  ${label}: unchanged`;

  const details = parts.join(", ");
  const names = [...diff.added, ...diff.modified, ...diff.removed];
  return `  ${label}: ${details} (${names.join(", ")})`;
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
 * Tools:
 *   connect_to_mcp        → Spawn and connect to a local MCP server
 *   disconnect_from_mcp   → Tear down the connection
 *   mcp_server_status     → Check connection status
 *   call_mcp_primitive    → Call a tool, read a resource, or get a prompt (auto-connects if needed)
 *   list_mcp_primitives   → List tools, resources, and/or prompts
 *   get_mcp_server_stderr → View target server stderr output
 */
export async function startServer(opts: ServerOptions): Promise<void> {
  let target: TargetManager | null = null;
  let previousSnapshot: Snapshot | null = null;

  const interceptor = new ResponseInterceptor({
    outDir: opts.outDir,
    defaultTimeoutMs: opts.timeoutMs,
    maxTextLength: opts.maxTextLength,
  });

  const mcpServer = new McpServer(
    { name: "run-mcp", version: "1.4.0" },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** Take a snapshot of the current target's primitives. */
  async function takeSnapshot(): Promise<Snapshot> {
    if (!target?.connected) return {};

    const snap: Snapshot = {};
    const caps = target.getServerCapabilities() ?? {};

    if (caps.tools) {
      try {
        const { tools } = await target.listTools();
        snap.tools = tools.map((t) => ({
          name: t.name,
          hash: hashDefinition({
            description: t.description,
            inputSchema: t.inputSchema,
          }),
        }));
      } catch {
        /* ignore */
      }
    }

    if (caps.resources) {
      try {
        const { resources } = await target.listResources();
        snap.resources = resources.map((r) => ({
          uri: (r as any).uri,
          name: (r as any).name ?? "",
        }));
      } catch {
        /* ignore */
      }
    }

    if (caps.prompts) {
      try {
        const { prompts } = await target.listPrompts();
        snap.prompts = prompts.map((p) => ({
          name: p.name,
          hash: hashDefinition({ description: p.description }),
        }));
      } catch {
        /* ignore */
      }
    }

    return snap;
  }

  /** Compute diff between previousSnapshot and current, formatted as text lines. */
  function computeSnapshotDiff(current: Snapshot): string[] {
    if (!previousSnapshot) return [];

    const lines: string[] = ["", "Changes since last connection:"];

    if (current.tools && previousSnapshot.tools) {
      lines.push(formatDiffLine("Tools", computeDiff(previousSnapshot.tools, current.tools)));
    }
    if (current.resources && previousSnapshot.resources) {
      lines.push(
        formatDiffLine(
          "Resources",
          computeResourceDiff(previousSnapshot.resources, current.resources),
        ),
      );
    }
    if (current.prompts && previousSnapshot.prompts) {
      lines.push(formatDiffLine("Prompts", computeDiff(previousSnapshot.prompts, current.prompts)));
    }

    // If only "unchanged" entries, simplify
    const hasChanges = lines.some(
      (l) => l.includes("+") || l.includes("~") || l.includes("-removed"),
    );
    if (!hasChanges) {
      return ["", "Changes since last connection: none"];
    }

    return lines;
  }

  /** Auto-connect to a target server if not already connected. */
  async function ensureConnected(
    command?: string,
    args?: string[],
    env?: Record<string, string>,
  ): Promise<string | null> {
    if (target?.connected) return null;

    if (!command) {
      return "Not connected to a target server. Provide command/args to auto-connect, or call connect_to_mcp first.";
    }

    // Clean up any previous (disconnected) target
    if (target) {
      await target.close();
      target = null;
    }

    // Set env vars if provided
    if (env) {
      for (const [key, value] of Object.entries(env)) {
        process.env[key] = value;
      }
    }

    target = new TargetManager(command, args ?? []);
    await target.connect();
    return null;
  }

  /** Build include data for connect response. */
  async function buildIncludeData(include: string[]): Promise<string[]> {
    if (!target?.connected || include.length === 0) return [];

    const lines: string[] = [];

    if (include.includes("tools")) {
      try {
        const { tools } = await target.listTools();
        lines.push("", "--- Tools ---", JSON.stringify(tools, null, 2));
      } catch (err: any) {
        lines.push("", "--- Tools ---", `Error: ${err.message}`);
      }
    }

    if (include.includes("resources")) {
      try {
        const { resources } = await target.listResources();
        lines.push("", "--- Resources ---", JSON.stringify(resources, null, 2));
      } catch (err: any) {
        lines.push("", "--- Resources ---", `Error: ${err.message}`);
      }
    }

    if (include.includes("prompts")) {
      try {
        const { prompts } = await target.listPrompts();
        lines.push("", "--- Prompts ---", JSON.stringify(prompts, null, 2));
      } catch (err: any) {
        lines.push("", "--- Prompts ---", `Error: ${err.message}`);
      }
    }

    return lines;
  }

  // ─── connect_to_mcp ─────────────────────────────────────────────────────

  mcpServer.registerTool(
    "connect_to_mcp",
    {
      title: "Connect to MCP Server",
      description:
        "Spawn and connect to a local MCP server process. " +
        "Use this to test an MCP server you're building. " +
        "Only one connection at a time — call disconnect_from_mcp first if already connected. " +
        "Use the 'include' parameter to get tools/resources/prompts in the response, saving round trips.",
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
        include: z
          .array(z.enum(["tools", "resources", "prompts"]))
          .optional()
          .describe(
            "Primitives to include in the response. " +
              "Saves round trips vs calling list_mcp_primitives separately. " +
              "On reconnect, also shows a diff of what changed since the last connection.",
          ),
      },
    },
    async ({ command, args, env, include }) => {
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
          "Use call_mcp_primitive to call tools, read resources, or get prompts.",
          "Use disconnect_from_mcp when done, or to reconnect after code changes.",
        ];

        // Take snapshot for future diffs
        const currentSnapshot = await takeSnapshot();

        // Compute diff if we have a previous snapshot and include was requested
        if (previousSnapshot && include && include.length > 0) {
          lines.push(...computeSnapshotDiff(currentSnapshot));
        }

        // Update snapshot
        previousSnapshot = currentSnapshot;

        // Add included data if requested
        if (include && include.length > 0) {
          lines.push(...(await buildIncludeData(include)));
        }

        // Surface server instructions if present
        const instructions = target.getInstructions();
        if (instructions) {
          lines.push("", "--- Server Instructions ---", instructions);
        }

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

  // ─── list_mcp_primitives ────────────────────────────────────────────────

  mcpServer.registerTool(
    "list_mcp_primitives",
    {
      title: "List MCP Primitives",
      description:
        "List tools, resources, and/or prompts on the connected MCP server. " +
        "Specify which types to include. Defaults to all available. " +
        "Use 'name' to filter to a specific item (e.g. describe a single tool's schema).",
      inputSchema: {
        type: z
          .array(z.enum(["tools", "resources", "prompts"]))
          .optional()
          .describe(
            "Which primitives to list. Defaults to all that the server supports. " +
              "Example: ['tools'] to list only tools.",
          ),
        name: z
          .string()
          .optional()
          .describe(
            "Filter to a specific item by name. " +
              "For tools: matches tool name. For resources: matches URI. For prompts: matches prompt name. " +
              "Returns the full schema/details for just that item.",
          ),
      },
    },
    async ({ type, name }) => {
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

      const caps = target.getServerCapabilities() ?? {};
      const requested = type ?? ["tools", "resources", "prompts"];
      const sections: string[] = [];

      if (requested.includes("tools") && caps.tools) {
        try {
          const result = await target.listTools();
          let tools = result.tools;
          if (name) {
            tools = tools.filter((t) => t.name === name);
            if (tools.length === 0) {
              const available = result.tools.map((t) => t.name).join(", ");
              sections.push("--- Tools ---", `Tool "${name}" not found.\nAvailable: ${available}`);
            } else {
              sections.push("--- Tools ---", JSON.stringify(tools[0], null, 2));
            }
          } else {
            sections.push("--- Tools ---", JSON.stringify(tools, null, 2));
          }
        } catch (err: any) {
          sections.push("--- Tools ---", `Error: ${err.message}`);
        }
      }

      if (requested.includes("resources") && caps.resources) {
        try {
          const result = await target.listResources();
          let resources = result.resources;
          if (name) {
            resources = resources.filter((r: any) => r.uri === name || r.name === name);
            if (resources.length === 0) {
              const available = result.resources.map((r: any) => r.uri).join(", ");
              sections.push(
                "--- Resources ---",
                `Resource "${name}" not found.\nAvailable: ${available}`,
              );
            } else {
              sections.push("--- Resources ---", JSON.stringify(resources[0], null, 2));
            }
          } else {
            sections.push("--- Resources ---", JSON.stringify(resources, null, 2));
          }
        } catch (err: any) {
          sections.push("--- Resources ---", `Error: ${err.message}`);
        }
      }

      if (requested.includes("prompts") && caps.prompts) {
        try {
          const result = await target.listPrompts();
          let prompts = result.prompts;
          if (name) {
            prompts = prompts.filter((p) => p.name === name);
            if (prompts.length === 0) {
              const available = result.prompts.map((p) => p.name).join(", ");
              sections.push(
                "--- Prompts ---",
                `Prompt "${name}" not found.\nAvailable: ${available}`,
              );
            } else {
              sections.push("--- Prompts ---", JSON.stringify(prompts[0], null, 2));
            }
          } else {
            sections.push("--- Prompts ---", JSON.stringify(prompts, null, 2));
          }
        } catch (err: any) {
          sections.push("--- Prompts ---", `Error: ${err.message}`);
        }
      }

      if (sections.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No matching primitives found. The server may not support the requested types.",
            },
          ],
        };
      }

      return {
        content: [{ type: "text" as const, text: sections.join("\n") }],
      };
    },
  );

  // ─── call_mcp_primitive ─────────────────────────────────────────────────

  mcpServer.registerTool(
    "call_mcp_primitive",
    {
      title: "Call MCP Primitive",
      description:
        "Call a tool, read a resource, or get a prompt on a target MCP server. " +
        "If not connected, provide command/args and a connection will be opened automatically. " +
        "Use disconnect_after to tear down the connection when done, " +
        "or leave it open (default) for subsequent calls.",
      inputSchema: {
        // What to call
        type: z.enum(["tool", "resource", "prompt"]).describe("The MCP primitive type to invoke"),
        name: z.string().describe("Tool name, resource URI, or prompt name"),
        arguments: z
          .record(z.unknown())
          .optional()
          .describe("Arguments for the tool or prompt (not used for resources)"),

        // Auto-connect params (only needed if not already connected)
        command: z
          .string()
          .optional()
          .describe(
            "Command to spawn the server (e.g. 'node'). Required if not already connected.",
          ),
        args: z
          .array(z.string())
          .optional()
          .describe("Arguments for the server command (e.g. ['src/index.js'])"),
        env: z
          .record(z.string())
          .optional()
          .describe("Extra environment variables for the server process"),

        // Lifecycle
        disconnect_after: z
          .boolean()
          .optional()
          .describe("Tear down the connection after this call (default: false)"),
        timeout_ms: z.number().optional().describe("Timeout in ms (only applies to type: 'tool')"),
      },
    },
    async ({
      type: primitiveType,
      name,
      arguments: callArgs,
      command,
      args,
      env,
      disconnect_after,
      timeout_ms,
    }) => {
      // Ensure connection
      try {
        const connectError = await ensureConnected(command, args, env);
        if (connectError) {
          return {
            content: [{ type: "text" as const, text: connectError }],
            isError: true,
          };
        }
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Failed to auto-connect: ${err.message}\n\n` +
                "Check that the command is correct and the server starts without errors.",
            },
          ],
          isError: true,
        };
      }

      let result: any;

      try {
        switch (primitiveType) {
          case "tool": {
            // Best-effort pre-call validation
            try {
              const { tools } = await target!.listTools();
              const toolNames = tools.map((t: any) => t.name);
              const matchedTool = tools.find((t: any) => t.name === name);

              if (!matchedTool) {
                const suggestion = suggestCommand(name, toolNames);
                const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
                return {
                  content: [
                    {
                      type: "text" as const,
                      text:
                        `Tool "${name}" not found.${hint}\n` +
                        `Available tools: ${toolNames.join(", ")}`,
                    },
                  ],
                  isError: true,
                };
              }

              // Check required properties
              const schema = matchedTool.inputSchema as any;
              const requiredProps: string[] = schema?.required ?? [];
              const providedKeys = Object.keys((callArgs as Record<string, unknown>) ?? {});
              const missingProps = requiredProps.filter((p: string) => !providedKeys.includes(p));

              if (missingProps.length > 0) {
                return {
                  content: [
                    {
                      type: "text" as const,
                      text:
                        `Tool "${name}" requires: ${missingProps.join(", ")}. ` +
                        `Received: ${JSON.stringify(callArgs ?? {})}`,
                    },
                  ],
                  isError: true,
                };
              }
            } catch {
              // Validation is best-effort — skip if listTools fails
            }

            const startMs = Date.now();
            result = await interceptor.callTool(
              target!,
              name,
              (callArgs as Record<string, unknown>) ?? {},
              timeout_ms,
            );
            const elapsedMs = Date.now() - startMs;

            // Append timing to text responses
            const resultContent = (result as any).content;
            if (Array.isArray(resultContent) && resultContent.length > 0) {
              const lastItem = resultContent[resultContent.length - 1];
              if (lastItem.type === "text") {
                lastItem.text += ` (${elapsedMs}ms)`;
              }
            }

            break;
          }

          case "resource": {
            const resourceResult = await target!.readResource({ uri: name });
            result = {
              content: [
                { type: "text" as const, text: JSON.stringify(resourceResult.contents, null, 2) },
              ],
            };
            break;
          }

          case "prompt": {
            const promptResult = await target!.getPrompt({
              name,
              arguments: (callArgs as Record<string, string>) ?? {},
            });
            result = {
              content: [
                { type: "text" as const, text: JSON.stringify(promptResult.messages, null, 2) },
              ],
            };
            break;
          }
        }
      } catch (err: any) {
        result = {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }

      // Disconnect after if requested
      if (disconnect_after && target) {
        previousSnapshot = await takeSnapshot();
        await target.close();
        target = null;
      }

      return result;
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
  process.stderr.write("[server] Waiting for connect_to_mcp or call_mcp_primitive call...\n");
}
