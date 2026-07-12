import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { discoverServers } from "./config-scanner.js";
import { type InterceptionMetadata, ResponseInterceptor } from "./interceptor.js";
import {
  type InterceptorPlugin,
  type PluginFinding,
  secretRedactionPlugin,
  toolPoisoningScanner,
} from "./plugins.js";
import { suggestCommand } from "./parsing.js";
import { rankTools } from "./ranking.js";
import {
  type Snapshot,
  computeSnapshotDiff,
  takeSnapshot as takeSnapshotFromTarget,
} from "./snapshot.js";
import { TargetManager } from "./target-manager.js";
import { validateProtocol } from "./validator.js";
import { AuditLogger } from "./audit.js";

export interface ServerOptions {
  outDir?: string;
  timeoutMs?: number;
  maxTextLength?: number;
  mediaThresholdKb?: number;
  sandbox?: "auto" | "docker" | "native" | "audit" | "none";
  allowRead?: string[];
  allowWrite?: string[];
  allowNet?: string[];
  denyRead?: string[];
  denyWrite?: string[];
  denyNet?: string[];
  scan?: boolean;
  /** Scan tools/list metadata for tool-poisoning (default: true). */
  scanTools?: boolean;
  /** Redact secrets from tool/resource/prompt result content (default: false). */
  redactSecrets?: boolean;
  /** When redacting, also redact email addresses (PII). */
  redactEmails?: boolean;
  /** If set, append a JSONL audit trail of every MCP request/response here. */
  auditLogPath?: string;
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
 *   find_tools            → Relevance-ranked, compact tool discovery (context firewall)
 *   get_mcp_server_stderr → View target server stderr output
 *   list_available_mcp_servers → Discover other local MCP servers from config files
 *
 * Note: list_available_mcp_servers exists to help agents discover other local server configurations.
 */
export async function startServer(opts: ServerOptions): Promise<void> {
  let target: TargetManager | null = null;
  let previousSnapshot: Snapshot | null = null;
  let cachedSpawnConfig: { command: string; args: string[]; env?: Record<string, string> } | null =
    null;

  const auditLogger = opts.auditLogPath ? new AuditLogger(opts.auditLogPath) : null;

  const interceptor = new ResponseInterceptor({
    outDir: opts.outDir,
    defaultTimeoutMs: opts.timeoutMs,
    maxTextLength: opts.maxTextLength,
    mediaThresholdKb: opts.mediaThresholdKb,
    // Tool-poisoning defense is on by default: the agent's context is exactly
    // what this attack targets. Opt out with scanTools: false. Secret redaction
    // is opt-in (it mutates result content).
    plugins: (() => {
      const p: InterceptorPlugin[] = [];
      if (opts.scanTools !== false) p.push(toolPoisoningScanner());
      if (opts.redactSecrets) p.push(secretRedactionPlugin({ redactEmails: opts.redactEmails }));
      return p;
    })(),
  });

  /** Format plugin findings as a warning block appended to a tool listing. */
  function formatFindings(findings: PluginFinding[]): string[] {
    if (findings.length === 0) return [];
    const lines = ["", "--- ⚠️ Tool Safety Findings ---"];
    for (const f of findings) {
      const loc = f.location ? ` [${f.location}]` : "";
      lines.push(`  (${f.severity})${loc} ${f.message}`);
    }
    lines.push(
      "Note: invisible/bidi characters were stripped automatically; review flagged tools before use.",
    );
    return lines;
  }

  const mcpServer = new McpServer(
    { name: "run-mcp", version: PKG_VERSION },
    {
      capabilities: {
        tools: {},
        logging: {},
      },
    },
  );

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** Set up stderr and disconnect listeners on the target. */
  function setupTargetListeners(t: TargetManager): void {
    if (auditLogger) {
      t.on("history", (rec: any) => {
        auditLogger.log("request", {
          method: rec.method,
          params: rec.params,
          durationMs: rec.durationMs,
          isError: rec.error !== undefined,
          error: rec.error,
        });
      });
    }

    t.on("stderr", (text) => {
      mcpServer
        .sendLoggingMessage({
          level: "info",
          logger: "target-stderr",
          data: text,
        })
        .catch(() => {});
    });

    t.on("disconnected", () => {
      const pid = t.getStatus().pid;
      mcpServer
        .sendLoggingMessage({
          level: "error",
          logger: "run-mcp",
          data: `Target server disconnected unexpectedly! (PID: ${pid})`,
        })
        .catch(() => {});
    });

    t.on("notification", (record: any) => {
      mcpServer.server
        .notification({
          method: record.method,
          params: record.params,
        })
        .catch(() => {});
    });

    t.on("sampling_request", async ({ request, respond, reject }) => {
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

    t.on("elicitation_request", async ({ request, respond, reject }) => {
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

  /** Take a snapshot of the current target's primitives. */
  async function takeSnapshot(): Promise<Snapshot> {
    if (!target) return {};
    return takeSnapshotFromTarget(target);
  }

  /** Compute diff between previousSnapshot and current, formatted as text lines. */
  function diffSnapshot(current: Snapshot): string[] {
    if (!previousSnapshot) return [];
    return computeSnapshotDiff(previousSnapshot, current);
  }

  /** Auto-connect to a target server if not already connected. */
  async function ensureConnected(
    command?: string,
    args?: string[],
    env?: Record<string, string>,
  ): Promise<string | null> {
    if (target?.connected) return null;

    let cmdToUse = command;
    let argsToUse = args;
    let envToUse = env;

    if (!cmdToUse && cachedSpawnConfig) {
      cmdToUse = cachedSpawnConfig.command;
      argsToUse = cachedSpawnConfig.args;
      envToUse = cachedSpawnConfig.env;
    }

    if (!cmdToUse) {
      return "Not connected to a target server. Provide command/args to auto-connect, or call connect_to_mcp first.";
    }

    // Clean up any previous (disconnected) target
    if (target) {
      await target.close();
      target = null;
    }

    target = new TargetManager(cmdToUse, argsToUse ?? [], {
      sandbox: opts.sandbox,
      allowRead: opts.allowRead,
      allowWrite: opts.allowWrite,
      allowNet: opts.allowNet,
      denyRead: opts.denyRead,
      denyWrite: opts.denyWrite,
      denyNet: opts.denyNet,
      env: envToUse,
    });
    setupTargetListeners(target);
    try {
      await target.connect();
    } catch (err) {
      await target.close().catch(() => {});
      target = null;
      throw err;
    }
    cachedSpawnConfig = { command: cmdToUse, args: argsToUse ?? [], env: envToUse };
    return null;
  }

  /** Build include data for connect response. */
  async function buildIncludeData(include: string[], summary = false): Promise<string[]> {
    if (!target?.connected || include.length === 0) return [];

    const lines: string[] = [];

    if (include.includes("tools")) {
      try {
        const listed = await target.listTools();
        // Run tools through the interceptor plugins (tool-poisoning scan) before
        // they enter the agent's context.
        const { tools, findings } = await interceptor.processToolList(listed.tools as any);
        let displayTools = summary
          ? tools.map((t: any) => ({ name: t.name, description: t.description }))
          : tools;
        let jsonStr = JSON.stringify(displayTools, null, 2);
        if (!summary && jsonStr.length > 20000) {
          displayTools = tools.map((t: any) => ({ name: t.name, description: t.description }));
          jsonStr = JSON.stringify(displayTools, null, 2);
          lines.push(
            "",
            "--- Tools ---",
            jsonStr,
            "[Note: Full schemas omitted to protect context window. Use list_mcp_primitives with name='tool_name' to inspect schemas individually.]",
          );
        } else {
          lines.push("", "--- Tools ---", jsonStr);
        }
        lines.push(...formatFindings(findings));
      } catch (err: any) {
        lines.push("", "--- Tools ---", `Error: ${err.message}`);
      }
    }

    if (include.includes("resources")) {
      try {
        const { resources } = await target.listResources();
        let displayResources = summary
          ? resources.map((r: any) => ({
              name: r.name,
              uri: r.uri,
              description: r.description,
            }))
          : resources;
        let jsonStr = JSON.stringify(displayResources, null, 2);
        if (!summary && jsonStr.length > 20000) {
          displayResources = resources.map((r: any) => ({
            name: r.name,
            uri: r.uri,
            description: r.description,
          }));
          jsonStr = JSON.stringify(displayResources, null, 2);
          lines.push(
            "",
            "--- Resources ---",
            jsonStr,
            "[Note: Full schemas omitted to protect context window.]",
          );
        } else {
          lines.push("", "--- Resources ---", jsonStr);
        }
      } catch (err: any) {
        lines.push("", "--- Resources ---", `Error: ${err.message}`);
      }
    }

    if (include.includes("resource_templates")) {
      try {
        const { resourceTemplates } = await target.listResourceTemplates();
        const displayTemplates = summary
          ? resourceTemplates.map((t: any) => ({
              name: t.name,
              uriTemplate: t.uriTemplate,
              description: t.description,
            }))
          : resourceTemplates;
        lines.push("", "--- Resource Templates ---", JSON.stringify(displayTemplates, null, 2));
      } catch (err: any) {
        lines.push("", "--- Resource Templates ---", `Error: ${err.message}`);
      }
    }

    if (include.includes("prompts")) {
      try {
        const { prompts } = await target.listPrompts();
        const displayPrompts = summary
          ? prompts.map((p) => ({ name: p.name, description: p.description }))
          : prompts;
        lines.push("", "--- Prompts ---", JSON.stringify(displayPrompts, null, 2));
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
        "Use the 'include' parameter to get tools/resources/prompts/resource_templates in the response, saving round trips.",
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
          .array(z.enum(["tools", "resources", "resource_templates", "prompts"]))
          .optional()
          .describe(
            "Primitives to include in the response. " +
              "Saves round trips vs calling list_mcp_primitives separately. " +
              "On reconnect, also shows a diff of what changed since the last connection.",
          ),
        summary: z
          .boolean()
          .optional()
          .describe(
            "If true, returns only the name and description of each primitive (omitting full schemas) when included to save tokens.",
          ),
        sandbox: z
          .enum(["auto", "docker", "native", "audit", "none"])
          .optional()
          .describe("Sandbox mode to use for this server"),
      },
    },
    async ({ command, args, env, include, summary, sandbox }) => {
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
        target = new TargetManager(command, args ?? [], {
          sandbox: sandbox ?? opts.sandbox,
          allowRead: opts.allowRead,
          allowWrite: opts.allowWrite,
          allowNet: opts.allowNet,
          denyRead: opts.denyRead,
          denyWrite: opts.denyWrite,
          denyNet: opts.denyNet,
          env,
        });
        setupTargetListeners(target);
        try {
          await target.connect();
        } catch (err) {
          await target.close().catch(() => {});
          target = null;
          throw err;
        }
        cachedSpawnConfig = { command, args: args ?? [], env };

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
          lines.push(...diffSnapshot(currentSnapshot));
        }

        // Update snapshot
        previousSnapshot = currentSnapshot;

        // Add included data if requested
        if (include && include.length > 0) {
          lines.push(...(await buildIncludeData(include, summary)));
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
        "List tools, resources, resource templates, and/or prompts on the connected MCP server. " +
        "Specify which types to include. Defaults to all available. " +
        "Use 'name' to filter to a specific item (e.g. describe a single tool's schema).",
      inputSchema: {
        type: z
          .array(z.enum(["tools", "resources", "resource_templates", "prompts"]))
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
              "For tools: matches tool name. For resources: matches URI. For resource templates: matches URI template. For prompts: matches prompt name. " +
              "Returns the full schema/details for just that item.",
          ),
        summary: z
          .boolean()
          .optional()
          .describe(
            "If true, returns only the name and description of each primitive (omitting full schemas) to save tokens.",
          ),
        cursor: z
          .string()
          .optional()
          .describe("Cursor for pagination (returned from a previous list call)"),
      },
    },
    async ({ type, name, summary, cursor }) => {
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
      const requested = type ?? ["tools", "resources", "resource_templates", "prompts"];
      const sections: string[] = [];

      if (requested.includes("tools") && caps.tools) {
        try {
          const result = await target.listTools({ cursor });
          // Scan for tool-poisoning before surfacing tool metadata to the agent.
          const scanned = await interceptor.processToolList(result.tools as any);
          let tools: any[] = scanned.tools;
          if (name) {
            tools = tools.filter((t: any) => t.name === name);
            if (tools.length === 0) {
              const available = scanned.tools.map((t: any) => t.name).join(", ");
              sections.push("--- Tools ---", `Tool "${name}" not found.\nAvailable: ${available}`);
            } else {
              sections.push("--- Tools ---", JSON.stringify(tools[0], null, 2));
            }
          } else {
            const displayTools = summary
              ? tools.map((t: any) => ({ name: t.name, description: t.description }))
              : tools;
            sections.push("--- Tools ---", JSON.stringify(displayTools, null, 2));
          }
          if (result.nextCursor) {
            sections.push(`--- Tools Next Cursor: ${result.nextCursor} ---`);
          }
          sections.push(...formatFindings(scanned.findings));
        } catch (err: any) {
          sections.push("--- Tools ---", `Error: ${err.message}`);
        }
      }

      if (requested.includes("resources") && caps.resources) {
        try {
          const result = await target.listResources({ cursor });
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
            const displayResources = summary
              ? resources.map((r: any) => ({
                  name: r.name,
                  uri: r.uri,
                  description: r.description,
                }))
              : resources;
            sections.push("--- Resources ---", JSON.stringify(displayResources, null, 2));
          }
          if (result.nextCursor) {
            sections.push(`--- Resources Next Cursor: ${result.nextCursor} ---`);
          }
        } catch (err: any) {
          sections.push("--- Resources ---", `Error: ${err.message}`);
        }
      }

      if (requested.includes("resource_templates") && caps.resources) {
        try {
          const result = await target.listResourceTemplates({ cursor });
          let templates = result.resourceTemplates;
          if (name) {
            templates = templates.filter((t: any) => t.uriTemplate === name || t.name === name);
            if (templates.length === 0) {
              const available = result.resourceTemplates.map((t: any) => t.uriTemplate).join(", ");
              sections.push(
                "--- Resource Templates ---",
                `Resource Template "${name}" not found.\nAvailable: ${available}`,
              );
            } else {
              sections.push("--- Resource Templates ---", JSON.stringify(templates[0], null, 2));
            }
          } else {
            const displayTemplates = summary
              ? templates.map((t: any) => ({
                  name: t.name,
                  uriTemplate: t.uriTemplate,
                  description: t.description,
                }))
              : templates;
            sections.push("--- Resource Templates ---", JSON.stringify(displayTemplates, null, 2));
          }
          if (result.nextCursor) {
            sections.push(`--- Resource Templates Next Cursor: ${result.nextCursor} ---`);
          }
        } catch (err: any) {
          sections.push("--- Resource Templates ---", `Error: ${err.message}`);
        }
      }

      if (requested.includes("prompts") && caps.prompts) {
        try {
          const result = await target.listPrompts({ cursor });
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
            const displayPrompts = summary
              ? prompts.map((p) => ({ name: p.name, description: p.description }))
              : prompts;
            sections.push("--- Prompts ---", JSON.stringify(displayPrompts, null, 2));
          }
          if (result.nextCursor) {
            sections.push(`--- Prompts Next Cursor: ${result.nextCursor} ---`);
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

  // ─── find_tools ─────────────────────────────────────────────────────────

  mcpServer.registerTool(
    "find_tools",
    {
      title: "Find Tools",
      description:
        "Search the connected server's tools by relevance to a query and return a " +
        "short, ranked list of compact summaries (name + description) — WITHOUT full " +
        "schemas. Use this to discover the right tool without loading the entire tool " +
        "catalog into context (avoids the 'tools tax'). Then inspect one schema with " +
        "list_mcp_primitives(name='...') and invoke it with call_mcp_primitive.",
      inputSchema: {
        query: z
          .string()
          .describe(
            "What you want to do — natural language or keywords (e.g. 'take a screenshot')",
          ),
        limit: z.number().optional().describe("Max number of tools to return (default 5)"),
        include_schema: z
          .boolean()
          .optional()
          .describe("Include the full input schema for each matched tool (default false)"),
      },
    },
    async ({ query, limit, include_schema }) => {
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
        const listed = await target.listTools();
        // Run the tool-poisoning scanner over metadata before ranking/surfacing.
        const { tools, findings } = await interceptor.processToolList(listed.tools as any);
        const ranked = rankTools(query, tools as any[], limit ?? 5);

        if (ranked.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No tools matched "${query}" among ${tools.length} tool(s). Try broader keywords, or list_mcp_primitives to browse.`,
              },
            ],
          };
        }

        const matches = ranked.map(({ tool, score }) => {
          const entry: Record<string, unknown> = {
            name: (tool as any).name,
            description: (tool as any).description,
            score,
          };
          if (include_schema) entry.inputSchema = (tool as any).inputSchema;
          return entry;
        });

        const lines = [
          `Top ${matches.length} of ${tools.length} tool(s) for "${query}":`,
          JSON.stringify(matches, null, 2),
          "",
          "Next: list_mcp_primitives(name='<tool>') for the full schema, then call_mcp_primitive to invoke it.",
        ];
        lines.push(...formatFindings(findings));

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error searching tools: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // ─── list_available_mcp_servers ─────────────────────────────────────────

  mcpServer.registerTool(
    "list_available_mcp_servers",
    {
      title: "List Available MCP Servers",
      description:
        "Scans common configuration files (VS Code, Claude Desktop, Cursor, etc.) " +
        "and returns a list of local MCP servers that the user has configured on their machine. " +
        "This is useful for discovering what other servers are available to connect to.",
    },
    async () => {
      try {
        const servers = await discoverServers({ scan: opts.scan });

        if (servers.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No configured MCP servers discovered in common locations.",
              },
            ],
          };
        }

        const lines: string[] = ["Discovered the following MCP server configurations:"];

        // Deduplicate similar to the REPL
        const uniqueServers = new Map<string, any>();
        for (const s of servers) {
          const key = `${s.name}::${s.config.command}::${(s.config.args || []).join(" ")}`;
          if (!uniqueServers.has(key)) {
            uniqueServers.set(key, s);
          } else if (s.source.includes("Project")) {
            uniqueServers.set(key, s);
          }
        }

        const list = Array.from(uniqueServers.values()).map((s) => ({
          name: s.name,
          source: s.source,
          command: s.config.command,
          args: s.config.args || [],
        }));

        lines.push(JSON.stringify(list, null, 2));

        return { content: [{ type: "text" as const, text: lines.join("\n\n") }] };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error discovering servers: ${err.message}` }],
          isError: true,
        };
      }
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
        args: z
          .record(z.unknown())
          .optional()
          .describe("Arguments for the tool or prompt (alias for 'arguments')"),

        // Auto-connect params (only needed if not already connected)
        auto_connect: z
          .object({
            command: z.string().describe("Command to spawn the server (e.g. 'node')."),
            args: z
              .array(z.string())
              .optional()
              .describe("Arguments for the server command (e.g. ['src/index.js'])"),
            env: z
              .record(z.string())
              .optional()
              .describe("Extra environment variables for the server process"),
          })
          .optional()
          .describe(
            "Provide this to automatically spawn and connect to a server if not already connected. Required if no active connection exists.",
          ),

        // Lifecycle
        disconnect_after: z
          .boolean()
          .optional()
          .describe("Tear down the connection after this call (default: false)"),
        timeout_ms: z.number().optional().describe("Timeout in ms (only applies to type: 'tool')"),
        include_metadata: z
          .boolean()
          .optional()
          .describe(
            "Include a structured metadata content item with latency, interception info, " +
              "and content statistics. Useful for programmatic consumption.",
          ),
        max_text_length: z
          .number()
          .optional()
          .describe(
            "Max text response length before truncation for this call. Use -1 to disable truncation.",
          ),
      },
    },
    async ({
      type: primitiveType,
      name,
      arguments: callArgs,
      args: callArgsAlias,
      auto_connect,
      disconnect_after,
      timeout_ms,
      include_metadata,
      max_text_length,
    }) => {
      const finalArgs = callArgs ?? callArgsAlias;
      // Ensure connection
      try {
        const connectError = await ensureConnected(
          auto_connect?.command,
          auto_connect?.args,
          auto_connect?.env,
        );
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
              const providedKeys = Object.keys((finalArgs as Record<string, unknown>) ?? {});
              const missingProps = requiredProps.filter((p: string) => !providedKeys.includes(p));

              if (missingProps.length > 0) {
                return {
                  content: [
                    {
                      type: "text" as const,
                      text:
                        `Tool "${name}" requires: ${missingProps.join(", ")}. ` +
                        `Received: ${JSON.stringify(finalArgs ?? {})}`,
                    },
                  ],
                  isError: true,
                };
              }
            } catch {
              // Validation is best-effort — skip if listTools fails
            }

            const startMs = Date.now();
            let interceptionMeta: InterceptionMetadata | undefined;

            if (include_metadata) {
              const { result: toolResult, metadata } = await interceptor.callToolWithMetadata(
                target!,
                name,
                (finalArgs as Record<string, unknown>) ?? {},
                timeout_ms,
                max_text_length,
              );
              result = toolResult;
              interceptionMeta = metadata;
            } else {
              result = await interceptor.callTool(
                target!,
                name,
                (finalArgs as Record<string, unknown>) ?? {},
                timeout_ms,
                max_text_length,
              );
            }
            const elapsedMs = Date.now() - startMs;

            // We no longer append inline timing to text responses as it corrupts JSON outputs for LLMs.
            // Timing is still available via include_metadata: true.
            const resultContent = (result as any).content;

            // Prepend metadata content item when requested
            if (include_metadata && Array.isArray(resultContent)) {
              const meta: Record<string, unknown> = {
                latency_ms: elapsedMs,
                content_items: resultContent.length,
                is_error: (result as any).isError === true,
              };
              if (interceptionMeta) {
                meta.truncated = interceptionMeta.truncated;
                meta.images_saved = interceptionMeta.imagesSaved;
                meta.audio_saved = interceptionMeta.audioSaved;
                meta.original_size_bytes = interceptionMeta.originalSizeBytes;
              }
              resultContent.unshift({
                type: "text" as const,
                text: `--- metadata ---\n${JSON.stringify(meta)}`,
              });
              (result as any).meta = meta;
            }

            break;
          }

          case "resource": {
            const startMs = Date.now();
            const resourceResult = (await interceptor.readResource(
              target!,
              { uri: name },
              timeout_ms,
              max_text_length,
            )) as any;
            const elapsedMs = Date.now() - startMs;
            const contentItems = resourceResult.contents.map((c: any) => {
              if (c.text !== undefined) {
                return { type: "text" as const, text: c.text };
              } else {
                return { type: "text" as const, text: `[Resource blob: ${c.uri}]` };
              }
            });
            result = { content: contentItems };

            if (include_metadata) {
              const meta: Record<string, unknown> = {
                latency_ms: elapsedMs,
                content_items: contentItems.length,
                is_error: false,
              };
              contentItems.unshift({
                type: "text" as const,
                text: `--- metadata ---\n${JSON.stringify(meta)}`,
              });
              (result as any).meta = meta;
            }
            break;
          }

          case "prompt": {
            // Best-effort pre-call validation for prompts
            try {
              const { prompts } = await target!.listPrompts();
              const promptNames = prompts.map((p: any) => p.name);
              const matchedPrompt = prompts.find((p: any) => p.name === name);

              if (!matchedPrompt) {
                const suggestion = suggestCommand(name, promptNames);
                const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
                return {
                  content: [
                    {
                      type: "text" as const,
                      text:
                        `Prompt "${name}" not found.${hint}\n` +
                        `Available prompts: ${promptNames.join(", ")}`,
                    },
                  ],
                  isError: true,
                };
              }
            } catch {
              // Validation is best-effort
            }

            const startMs = Date.now();
            const promptResult = (await interceptor.getPrompt(
              target!,
              {
                name,
                arguments: (finalArgs as Record<string, string>) ?? {},
              },
              timeout_ms,
              max_text_length,
            )) as any;
            const elapsedMs = Date.now() - startMs;
            const contentItems: any[] = [];
            for (const msg of promptResult.messages) {
              const role = msg.role;
              const content = msg.content;
              const prefix = `[${role.toUpperCase()} MESSAGE]`;
              if (content.type === "text") {
                contentItems.push({ type: "text" as const, text: `${prefix}\n${content.text}` });
              } else if (Array.isArray(content)) {
                for (const item of content) {
                  if (item.type === "text") {
                    contentItems.push({ type: "text" as const, text: `${prefix}\n${item.text}` });
                  } else {
                    contentItems.push(item);
                  }
                }
              } else {
                contentItems.push(content);
              }
            }
            result = { content: contentItems };

            if (include_metadata) {
              const meta: Record<string, unknown> = {
                latency_ms: elapsedMs,
                content_items: contentItems.length,
                is_error: false,
              };
              contentItems.unshift({
                type: "text" as const,
                text: `--- metadata ---\n${JSON.stringify(meta)}`,
              });
              (result as any).meta = meta;
            }
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

  mcpServer.registerTool(
    "validate_mcp_server",
    {
      title: "Validate MCP Server",
      description:
        "Attempts to spawn the target MCP server, connect to it, check its tools, " +
        "collect any stderr/errors, and shut it down cleanly. " +
        "Returns pass/fail status and captured diagnostics.",
      inputSchema: {
        command: z.string().describe("Command to run (e.g. 'node', 'python')"),
        args: z.array(z.string()).optional().describe("Arguments to pass"),
        env: z.record(z.string()).optional().describe("Extra environment variables"),
        deep: z
          .boolean()
          .optional()
          .describe("If true, performs deep protocol and schema compliance checks"),
      },
    },
    async ({ command, args, env, deep }) => {
      if (deep) {
        try {
          const report = await validateProtocol(command, args ?? [], env);
          const checksSummary = report.checks
            .map((c) => `[${c.status}] ${c.name}: ${c.message || "(no message)"}`)
            .join("\n");

          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Validation Result: ${report.status}\n\n` + `Checks Summary:\n${checksSummary}`,
              },
            ],
            isError: report.status === "FAIL",
          };
        } catch (err: any) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Validation Result: FAILED\nError: ${err.message}`,
              },
            ],
            isError: true,
          };
        }
      }

      const tempTarget = new TargetManager(command, args ?? [], {
        sandbox: opts.sandbox,
        allowRead: opts.allowRead,
        allowWrite: opts.allowWrite,
        allowNet: opts.allowNet,
        denyRead: opts.denyRead,
        denyWrite: opts.denyWrite,
        denyNet: opts.denyNet,
        env,
      });
      const stderrLines: string[] = [];
      tempTarget.on("stderr", (text: string) => {
        stderrLines.push(text);
      });

      try {
        const connectPromise = tempTarget.connect();
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Connection timed out after 5000ms")), 5000),
        );

        await Promise.race([connectPromise, timeoutPromise]);

        const toolsResult = await tempTarget.listTools();
        const caps = tempTarget.getServerCapabilities() ?? {};
        const ver = tempTarget.getServerVersion();

        await tempTarget.close();

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Validation Result: SUCCESS\n` +
                `Server Name: ${ver?.name ?? "unknown"}\n` +
                `Server Version: ${ver?.version ?? "unknown"}\n` +
                `Tools Count: ${toolsResult.tools.length}\n` +
                `Capabilities: ${Object.keys(caps).join(", ") || "none"}\n\n` +
                `Captured Stderr:\n${stderrLines.join("\n") || "(none)"}`,
            },
          ],
        };
      } catch (err: any) {
        await tempTarget.close().catch(() => {});
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Validation Result: FAILED\n` +
                `Error: ${err.message}\n\n` +
                `Captured Stderr:\n${stderrLines.join("\n") || "(none)"}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  mcpServer.registerTool(
    "search_all_local_mcp_servers",
    {
      title: "Search All Local MCP Servers",
      description:
        "Scans all configured/discovered local MCP servers, connects to them, " +
        "and searches their tool names/descriptions or resource names/URIs for a query string.",
      inputSchema: {
        query: z.string().describe("Search query (case-insensitive substring match)"),
        type: z
          .array(z.enum(["tools", "resources", "prompts"]))
          .optional()
          .describe("Primitives to search. Defaults to ['tools']."),
      },
    },
    async ({ query, type }) => {
      const searchTypes = type ?? ["tools"];
      const lowerQuery = query.toLowerCase();

      try {
        const servers = await discoverServers({ scan: opts.scan });
        if (servers.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No local MCP servers found to search." }],
          };
        }

        const uniqueServers = new Map<string, any>();
        for (const s of servers) {
          const key = `${s.name}::${s.config.command}::${(s.config.args || []).join(" ")}`;
          if (!uniqueServers.has(key)) {
            uniqueServers.set(key, s);
          } else if (s.source.includes("Project")) {
            uniqueServers.set(key, s);
          }
        }

        const matchResults: any[] = [];

        for (const s of uniqueServers.values()) {
          const tempTarget = new TargetManager(s.config.command, s.config.args || [], {
            sandbox: opts.sandbox,
            allowRead: opts.allowRead,
            allowWrite: opts.allowWrite,
            allowNet: opts.allowNet,
            denyRead: opts.denyRead,
            denyWrite: opts.denyWrite,
            denyNet: opts.denyNet,
            env: s.config.env,
          });
          try {
            await Promise.race([
              tempTarget.connect(),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("Timeout")), 3000),
              ),
            ]);

            const caps = tempTarget.getServerCapabilities() ?? {};

            if (searchTypes.includes("tools") && caps.tools) {
              const { tools } = await tempTarget.listTools();
              for (const t of tools) {
                if (
                  t.name.toLowerCase().includes(lowerQuery) ||
                  (t.description && t.description.toLowerCase().includes(lowerQuery))
                ) {
                  matchResults.push({
                    server: s.name,
                    primitive: "tool",
                    name: t.name,
                    description: t.description,
                  });
                }
              }
            }

            if (searchTypes.includes("resources") && caps.resources) {
              const { resources } = await tempTarget.listResources();
              for (const r of resources as any[]) {
                if (
                  (r.name && r.name.toLowerCase().includes(lowerQuery)) ||
                  r.uri.toLowerCase().includes(lowerQuery) ||
                  (r.description && r.description.toLowerCase().includes(lowerQuery))
                ) {
                  matchResults.push({
                    server: s.name,
                    primitive: "resource",
                    name: r.name || r.uri,
                    uri: r.uri,
                    description: r.description,
                  });
                }
              }
            }

            if (searchTypes.includes("prompts") && caps.prompts) {
              const { prompts } = await tempTarget.listPrompts();
              for (const p of prompts) {
                if (
                  p.name.toLowerCase().includes(lowerQuery) ||
                  (p.description && p.description.toLowerCase().includes(lowerQuery))
                ) {
                  matchResults.push({
                    server: s.name,
                    primitive: "prompt",
                    name: p.name,
                    description: p.description,
                  });
                }
              }
            }
          } catch {
            // Ignore individual server connection or query errors
          } finally {
            await tempTarget.close().catch(() => {});
          }
        }

        if (matchResults.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No matches found for query "${query}".`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Search results for "${query}":\n\n${JSON.stringify(matchResults, null, 2)}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error searching servers: ${err.message}` }],
          isError: true,
        };
      }
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
