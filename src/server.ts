import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { dedupeServers, discoverServers } from "./config-scanner.js";
import { type InterceptionMetadata, ResponseInterceptor } from "./interceptor.js";
import { suggestCommand } from "./parsing.js";
import {
  type Snapshot,
  computeSnapshotDiff,
  takeSnapshot as takeSnapshotFromTarget,
} from "./snapshot.js";
import { describeConnectFailure, TargetManager, type ProtocolMode } from "./target-manager.js";
import { validateProtocol } from "./validator.js";

export interface ServerOptions {
  outDir?: string;
  timeoutMs?: number;
  maxTextLength?: number;
  mediaThresholdKb?: number;
  scan?: boolean;
  /** Transport for http(s) targets: auto (default), http (Streamable), or sse. */
  transport?: "auto" | "http" | "sse";
  /** Default handshake for targets (`--protocol`); a connect call can override it. */
  protocol?: ProtocolMode;
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
 *   reconnect_to_mcp      → Restart the target after a code edit and diff what changed
 *   mcp_server_status     → Check connection status
 *   call_mcp_primitive    → Call a tool, read a resource, or get a prompt (auto-connects if needed)
 *   list_mcp_primitives   → List tools, resources, and/or prompts
 *   get_server_notifications → Inspect notifications the target emitted (list_changed, updates, logs)
 *   subscribe_to_resource → Exercise a server's resource-subscription support
 *   read_result           → Page through an oversized result spilled to disk
 *   get_mcp_server_stderr → View target server stderr output
 *   list_available_mcp_servers → Discover other local MCP servers from config files
 *
 * Note: list_available_mcp_servers exists to help agents discover other local server configurations.
 */
export async function startServer(opts: ServerOptions): Promise<void> {
  let target: TargetManager | null = null;
  let previousSnapshot: Snapshot | null = null;
  let cachedSpawnConfig: {
    command: string;
    args: string[];
    env?: Record<string, string>;
    protocol?: ProtocolMode;
  } | null = null;
  /**
   * Cached tools/list of the CURRENT target, used by call_mcp_primitive's
   * pre-call validation so every tool call doesn't pay an extra round trip.
   * Invalidated on connect/disconnect and on tools/list_changed; a lookup miss
   * forces one fresh fetch before erroring (see getToolsForValidation).
   */
  let cachedToolList: any[] | null = null;

  const interceptor = new ResponseInterceptor({
    outDir: opts.outDir,
    defaultTimeoutMs: opts.timeoutMs,
    maxTextLength: opts.maxTextLength,
    mediaThresholdKb: opts.mediaThresholdKb,
  });

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
    t.on("stderr", (text) => {
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- deprecated by SEP-2577 but still served for 12 months; run-mcp exists to exercise it
      const sent = mcpServer.sendLoggingMessage({
        level: "info",
        logger: "target-stderr",
        data: text,
      });
      sent.catch(() => {});
    });

    t.on("disconnected", () => {
      const pid = t.getStatus().pid;
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- deprecated by SEP-2577 but still served for 12 months; run-mcp exists to exercise it
      const sent = mcpServer.sendLoggingMessage({
        level: "error",
        logger: "run-mcp",
        data: `Target server disconnected unexpectedly! (PID: ${pid})`,
      });
      sent.catch(() => {});
    });

    t.on("notification", (record: any) => {
      if (record.method === "notifications/tools/list_changed") {
        cachedToolList = null;
      }
      mcpServer.server
        .notification({
          method: record.method,
          params: record.params,
        })
        .catch(() => {});
    });

    t.on("sampling_request", async ({ request, respond, reject }) => {
      try {
        const result = await mcpServer.server.request({
          method: "sampling/createMessage",
          params: request,
        });
        respond(result);
      } catch (err: any) {
        reject(err);
      }
    });

    t.on("elicitation_request", async ({ request, respond, reject }) => {
      try {
        const result = await mcpServer.server.request({
          method: "elicitation/create",
          params: request,
        });
        respond(result);
      } catch (err: any) {
        reject(err);
      }
    });
  }

  /**
   * Stderr of the most recently retired target, kept after it is torn down.
   *
   * A server that fails to start is exactly the case where its stderr matters
   * most — it is the only evidence of *why* — and it is also the case where the
   * TargetManager gets discarded. Without this, the transport's opaque
   * "Connection closed" would be all the caller ever sees.
   */
  let lastStderr: string[] = [];

  /** Tear down a target, preserving its stderr for post-mortem reads. */
  async function retireTarget(): Promise<void> {
    if (!target) return;
    const captured = target.getStderrLines();
    if (captured.length > 0) lastStderr = captured;
    await target.close().catch(() => {});
    target = null;
    cachedToolList = null;
  }

  /**
   * Build a connect-failure message that carries the target's own stderr inline.
   * The dying server's output is the actionable part; making the caller spend a
   * second round trip to find it (or worse, find it already discarded) is the
   * difference between a fixable error and a dead end.
   */
  function formatConnectFailure(err: any, command: string, args: string[]): string {
    const { message, hint } = describeConnectFailure(err, command);
    const lines = [`Failed to connect: ${message}`, `Command: ${command} ${args.join(" ")}`];
    if (hint) lines.push(hint);
    const stderrLines = lastStderr.slice(-40);
    if (stderrLines.length > 0) {
      lines.push(
        "",
        "--- Target server stderr (this is almost certainly the cause) ---",
        stderrLines.join("\n"),
      );
    } else {
      lines.push(
        "",
        "The target produced no stderr output before exiting. Check that the command is " +
          "correct and runs standalone in a shell.",
      );
    }
    return lines.join("\n");
  }

  /**
   * Client-side context the target server can observe: the roots we advertise
   * and the log verbosity we asked it for.
   *
   * run-mcp advertises `roots: { listChanged: true }` to every target, so a
   * server under development is entitled to ask `roots/list` and get a real
   * answer. Held here (not on the TargetManager) so it survives reconnects —
   * the roots you configured must not silently vanish when you restart after an
   * edit.
   */
  let configuredRoots: { uri: string; name?: string }[] = [];
  let configuredLogLevel: string | null = null;

  /** Seed a not-yet-connected target with the configured roots. */
  async function applyRoots(t: TargetManager): Promise<void> {
    for (const root of configuredRoots) await t.addRoot(root);
  }

  /**
   * Post-connect half of the client context: the log level (which needs a live
   * connection) plus a short report of what the server can now see.
   */
  async function applyClientContext(t: TargetManager): Promise<string[]> {
    const notes: string[] = [];
    if (configuredRoots.length > 0) {
      notes.push(`Roots advertised to the server: ${configuredRoots.map((r) => r.uri).join(", ")}`);
    }
    if (configuredLogLevel) {
      try {
        await t.setLoggingLevel(configuredLogLevel);
        notes.push(`Log level set to "${configuredLogLevel}".`);
      } catch (err: any) {
        // A server without the logging capability is not a connect failure.
        notes.push(
          `Note: could not set log level "${configuredLogLevel}" — ${err.message}. ` +
            "Does the server declare the 'logging' capability?",
        );
      }
    }
    return notes;
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
    protocol?: ProtocolMode,
  ): Promise<string | null> {
    if (target?.connected) return null;

    let cmdToUse = command;
    let argsToUse = args;
    let envToUse = env;
    let protocolToUse = protocol;

    if (!cmdToUse && cachedSpawnConfig) {
      cmdToUse = cachedSpawnConfig.command;
      argsToUse = cachedSpawnConfig.args;
      envToUse = cachedSpawnConfig.env;
      protocolToUse = protocolToUse ?? cachedSpawnConfig.protocol;
    }

    if (!cmdToUse) {
      return "Not connected to a target server. Provide command/args to auto-connect, or call connect_to_mcp first.";
    }

    // Clean up any previous (disconnected) target
    await retireTarget();

    target = new TargetManager(cmdToUse, argsToUse ?? [], {
      env: envToUse,
      transport: opts.transport,
      protocol: protocolToUse ?? opts.protocol,
    });
    setupTargetListeners(target);
    await applyRoots(target);
    try {
      await target.connect();
    } catch (err) {
      await target.waitForStderr();
      await retireTarget();
      throw Object.assign(new Error(formatConnectFailure(err, cmdToUse, argsToUse ?? [])), {
        alreadyFormatted: true,
      });
    }
    if (configuredLogLevel) {
      await target.setLoggingLevel(configuredLogLevel).catch(() => {});
    }
    cachedSpawnConfig = {
      command: cmdToUse,
      args: argsToUse ?? [],
      env: envToUse,
      protocol: protocolToUse,
    };
    return null;
  }

  /** One line naming the era and revision the target negotiated. */
  function describeProtocolLine(t: TargetManager): string {
    const { era, version } = t.getProtocolInfo();
    if (!version) return "Protocol: unknown";
    const eraNote =
      era === "modern"
        ? " (modern era: server/discover, subscriptions/listen, input_required)"
        : " (legacy era: initialize handshake — pass protocol='auto' or '2026-07-28' to test the modern path if the server serves it)";
    return `Protocol: ${version}${eraNote}`;
  }

  /** Conduct problems the SDK forgives but a server author must hear about. */
  function conductWarnings(t: TargetManager): string[] {
    const lines: string[] = [];
    const noise = t.getStdoutNoise();
    if (noise.length > 0) {
      lines.push(
        "",
        `⚠ The server wrote ${t.getStatus().stdoutNoiseCount} non-JSON line(s) to stdout. stdout is the ` +
          "protocol channel; a stricter client would have dropped the connection. Log to stderr instead. Last lines:",
        ...noise.slice(-5).map((l) => `  ${l}`),
      );
    }
    const errors = t.getTransportErrors();
    if (errors.length > 0) {
      lines.push(
        "",
        `⚠ The transport reported ${errors.length} error(s):`,
        ...errors.slice(-5).map((e) => `  ${e.message}`),
      );
    }
    return lines;
  }

  /** Tools list for pre-call validation, cached per connection. */
  async function getToolsForValidation(): Promise<any[]> {
    if (cachedToolList) return cachedToolList;
    const { tools } = await target!.listTools();
    cachedToolList = tools as any[];
    return cachedToolList;
  }

  /** Build include data for connect response. */
  async function buildIncludeData(include: string[], summary = false): Promise<string[]> {
    if (!target?.connected || include.length === 0) return [];

    const lines: string[] = [];

    if (include.includes("tools")) {
      try {
        const listed = await target.listTools();
        const tools = listed.tools as any[];
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
      inputSchema: z.object({
        command: z.string().describe("Command to run (e.g. 'node', 'python', 'npx')"),
        args: z
          .array(z.string())
          .optional()
          .describe("Arguments to pass (e.g. ['src/index.js'] or ['-y', 'some-server'])"),
        env: z
          .record(z.string(), z.string())
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
        roots: z
          .array(
            z.object({
              uri: z.string().describe("Root URI, e.g. 'file:///Users/me/project'"),
              name: z.string().optional().describe("Human-readable label for the root"),
            }),
          )
          .optional()
          .describe(
            "Filesystem roots to advertise to the target server. run-mcp declares the " +
              "'roots' capability, so a server that calls roots/list gets these back — set " +
              "them if the server under test consumes roots, or it will correctly see none. " +
              "Persisted across reconnect_to_mcp.",
          ),
        log_level: z
          .enum(["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"])
          .optional()
          .describe(
            "Ask the target server to set its logging verbosity (requires the server's " +
              "'logging' capability). Persisted across reconnect_to_mcp.",
          ),
        protocol: z
          .string()
          .optional()
          .describe(
            "Handshake to open with: 'legacy' (default; the 2025 initialize), 'auto' (probe for " +
              "2026-07-28 and fall back), or a revision to pin such as '2026-07-28' (no fallback — " +
              "use this to prove the modern path of a server that serves both eras). Persisted across reconnect_to_mcp.",
          ),
      }),
    },
    async ({ command, args, env, include, summary, roots, log_level, protocol }) => {
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
      await retireTarget();

      if (roots !== undefined) configuredRoots = roots;
      if (log_level !== undefined) configuredLogLevel = log_level;

      try {
        target = new TargetManager(command, args ?? [], {
          env,
          transport: opts.transport,
          protocol: protocol ?? opts.protocol,
        });
        setupTargetListeners(target);
        // Roots must be in place before connect: a server may ask for them as
        // soon as initialization completes.
        await applyRoots(target);
        try {
          await target.connect();
        } catch (err) {
          await target.waitForStderr();
          await retireTarget();
          throw Object.assign(new Error(formatConnectFailure(err, command, args ?? [])), {
            alreadyFormatted: true,
          });
        }
        cachedSpawnConfig = { command, args: args ?? [], env, protocol };
        const contextNotes = await applyClientContext(target);

        const status = target.getStatus();
        const caps = target.getServerCapabilities() ?? {};

        // Gather a summary of what the target exposes
        const capSummary: string[] = [];
        if (caps.tools) capSummary.push("tools");
        if (caps.resources) capSummary.push("resources");
        if (caps.prompts) capSummary.push("prompts");
        if (caps.logging) capSummary.push("logging");

        // The snapshot doubles as the tool count for the summary line.
        const currentSnapshot = await takeSnapshot();
        const toolCount = currentSnapshot.tools?.length ?? 0;

        const lines = [
          `Connected to MCP server (PID: ${status.pid})`,
          `Command: ${command} ${(args ?? []).join(" ")}`,
          describeProtocolLine(target),
          `Capabilities: ${capSummary.join(", ") || "none"}`,
          `Tools available: ${toolCount}`,
          "",
          "Use call_mcp_primitive to call tools, read resources, or get prompts.",
          "Use reconnect_to_mcp after editing your server's code.",
          ...contextNotes,
          ...conductWarnings(target),
        ];

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
        // A connect failure arrives pre-formatted with the target's stderr;
        // anything thrown later (listTools, snapshot) gets the same treatment.
        const text = err.alreadyFormatted
          ? err.message
          : formatConnectFailure(err, command, args ?? []);
        await retireTarget();
        return {
          content: [{ type: "text" as const, text }],
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
      await retireTarget();

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

  // ─── reconnect_to_mcp ───────────────────────────────────────────────────

  mcpServer.registerTool(
    "reconnect_to_mcp",
    {
      title: "Reconnect to MCP Server",
      description:
        "Restart the current target server and report what changed. " +
        "This is the tool to use after editing your server's code — it replaces " +
        "disconnect_from_mcp + connect_to_mcp with one call, reuses the command it " +
        "was already started with, and diffs the tools/resources/prompts against the " +
        "previous run so you can see the effect of your edit.",
      inputSchema: z.object({
        include: z
          .array(z.enum(["tools", "resources", "resource_templates", "prompts"]))
          .optional()
          .describe(
            "Primitives to include in full in the response. The change diff is always shown.",
          ),
        summary: z
          .boolean()
          .optional()
          .describe("If true, included primitives omit full schemas to save tokens."),
        roots: z
          .array(z.object({ uri: z.string(), name: z.string().optional() }))
          .optional()
          .describe("Replace the advertised roots. Omit to keep the ones already configured."),
        log_level: z
          .enum(["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"])
          .optional()
          .describe("Change the target's log level. Omit to keep the one already configured."),
        protocol: z
          .string()
          .optional()
          .describe(
            "Change the handshake for this restart ('legacy', 'auto', or a pin like '2026-07-28'). " +
              "Omit to keep the one the server was connected with.",
          ),
      }),
    },
    async ({ include, summary, roots, log_level, protocol }) => {
      if (!cachedSpawnConfig) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "No server has been started yet, so there is nothing to restart. " +
                "Call connect_to_mcp with a command first.",
            },
          ],
          isError: true,
        };
      }

      const { command, args, env } = cachedSpawnConfig;
      if (protocol !== undefined) cachedSpawnConfig.protocol = protocol;
      const protocolToUse = cachedSpawnConfig.protocol ?? opts.protocol;

      if (roots !== undefined) configuredRoots = roots;
      if (log_level !== undefined) configuredLogLevel = log_level;

      // Snapshot the outgoing server before tearing it down, so the diff
      // reflects this edit rather than whatever connect_to_mcp last recorded.
      if (target?.connected) {
        previousSnapshot = await takeSnapshot();
      }
      await retireTarget();

      target = new TargetManager(command, args, {
        env,
        transport: opts.transport,
        protocol: protocolToUse,
      });
      setupTargetListeners(target);
      await applyRoots(target);
      try {
        await target.connect();
      } catch (err) {
        await target.waitForStderr();
        await retireTarget();
        return {
          content: [{ type: "text" as const, text: formatConnectFailure(err, command, args) }],
          isError: true,
        };
      }

      const contextNotes = await applyClientContext(target);
      const status = target.getStatus();
      const lines = [
        `Reconnected to MCP server (PID: ${status.pid})`,
        `Command: ${command} ${args.join(" ")}`,
        describeProtocolLine(target),
        ...contextNotes,
        ...conductWarnings(target),
      ];

      const currentSnapshot = await takeSnapshot();
      // diffSnapshot returns [] only when there is no baseline to compare against.
      const diff = diffSnapshot(currentSnapshot);
      lines.push("", ...(diff.length > 0 ? diff : ["No previous run to compare against."]));
      previousSnapshot = currentSnapshot;

      if (include && include.length > 0) {
        lines.push(...(await buildIncludeData(include, summary)));
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
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

      const subs = target.getSubscriptionInfo();
      const honored = Object.entries(subs.listChangedHonored ?? {})
        .filter(([, v]) => v === true)
        .map(([k]) => k);
      const lines = [
        `Connected: ${status.connected}`,
        `PID: ${status.pid}`,
        `Uptime: ${status.uptime.toFixed(1)}s`,
        `Command: ${status.command} ${status.args.join(" ")}`,
        describeProtocolLine(target),
        `Capabilities: ${Object.keys(caps).join(", ") || "none"}`,
        `Stderr lines: ${status.stderrLineCount}`,
        `Last response: ${status.lastResponseTime ? new Date(status.lastResponseTime).toISOString() : "none"}`,
      ];
      if (subs.listChangedRequested) {
        lines.push(
          `list_changed stream: requested ${Object.keys(subs.listChangedRequested).join(", ")}; ` +
            `server honored ${honored.length > 0 ? honored.join(", ") : "none"}`,
        );
      }
      if (subs.resourceUris.length > 0) {
        lines.push(`Resource subscriptions: ${subs.resourceUris.join(", ")}`);
      }
      lines.push(...conductWarnings(target));

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
      inputSchema: z.object({
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
          .describe(
            "Cursor for pagination, returned from a previous list call. A cursor belongs to " +
              "one list, so pass exactly one 'type' with it. Without a cursor every page is " +
              "fetched and the full catalog is returned.",
          ),
      }),
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

      if (cursor && requested.length !== 1) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "A cursor is only valid for the list it came from. Pass exactly one 'type' " +
                `together with 'cursor' (got ${requested.length}).`,
            },
          ],
          isError: true,
        };
      }
      const t = target;
      const listTools = () => (cursor ? t.listTools({ cursor }) : t.listAllTools());
      const listResources = () => (cursor ? t.listResources({ cursor }) : t.listAllResources());
      const listResourceTemplates = () =>
        cursor ? t.listResourceTemplates({ cursor }) : t.listAllResourceTemplates();
      const listPrompts = () => (cursor ? t.listPrompts({ cursor }) : t.listAllPrompts());

      if (requested.includes("tools") && caps.tools) {
        try {
          const result = (await listTools()) as { tools: any[]; nextCursor?: string };
          let tools: any[] = result.tools;
          if (name) {
            tools = tools.filter((t: any) => t.name === name);
            if (tools.length === 0) {
              const available = result.tools.map((t: any) => t.name).join(", ");
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
        } catch (err: any) {
          sections.push("--- Tools ---", `Error: ${err.message}`);
        }
      }

      if (requested.includes("resources") && caps.resources) {
        try {
          const result = (await listResources()) as { resources: any[]; nextCursor?: string };
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
          const result = (await listResourceTemplates()) as {
            resourceTemplates: any[];
            nextCursor?: string;
          };
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
          const result = (await listPrompts()) as { prompts: any[]; nextCursor?: string };
          let prompts = result.prompts;
          if (name) {
            prompts = prompts.filter((p: any) => p.name === name);
            if (prompts.length === 0) {
              const available = result.prompts.map((p: any) => p.name).join(", ");
              sections.push(
                "--- Prompts ---",
                `Prompt "${name}" not found.\nAvailable: ${available}`,
              );
            } else {
              sections.push("--- Prompts ---", JSON.stringify(prompts[0], null, 2));
            }
          } else {
            const displayPrompts = summary
              ? prompts.map((p: any) => ({ name: p.name, description: p.description }))
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

        const list = dedupeServers(servers).map((s) => ({
          name: s.name,
          source: s.source,
          command: s.config.command,
          args: s.config.args || [],
          // Names only: values are often secrets, and connect_to_mcp takes env explicitly.
          env_keys: Object.keys(s.config.env ?? {}),
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
      inputSchema: z.object({
        // What to call
        type: z.enum(["tool", "resource", "prompt"]).describe("The MCP primitive type to invoke"),
        name: z.string().describe("Tool name, resource URI, or prompt name"),
        arguments: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Arguments for the tool or prompt (not used for resources)"),
        args: z
          .record(z.string(), z.unknown())
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
              .record(z.string(), z.string())
              .optional()
              .describe("Extra environment variables for the server process"),
            protocol: z
              .string()
              .optional()
              .describe(
                "Handshake to open with: 'legacy' (default), 'auto', or a pin like '2026-07-28'.",
              ),
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
      }),
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
          auto_connect?.protocol,
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
            // Best-effort pre-call validation (cached tools list — no extra
            // round trip on the happy path; one forced refetch on a miss)
            try {
              let tools = await getToolsForValidation();
              let matchedTool = tools.find((t: any) => t.name === name);
              if (!matchedTool) {
                cachedToolList = null;
                tools = await getToolsForValidation();
                matchedTool = tools.find((t: any) => t.name === name);
              }
              const toolNames = tools.map((t: any) => t.name);

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
                meta.results_saved = interceptionMeta.resultsSaved;
                meta.original_size_bytes = interceptionMeta.originalSizeBytes;
                // Client input the call needed (elicitation / sampling / roots):
                // server→client requests on a 2025-era connection, input_required
                // rounds the SDK fulfilled on 2026-07-28.
                meta.input_requests = interceptionMeta.inputRequests;
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

      // Disconnect after if requested. Goes through retireTarget so the
      // server's stderr survives — a tool call that misbehaved is exactly when
      // you want to read it, and disconnect_after is often set on that call.
      if (disconnect_after && target) {
        previousSnapshot = await takeSnapshot();
        await retireTarget();
      }

      return result;
    },
  );

  // ─── get_server_notifications ───────────────────────────────────────────

  mcpServer.registerTool(
    "get_server_notifications",
    {
      title: "Get Server Notifications",
      description:
        "Show the notifications the target server has emitted — tools/resources/prompts " +
        "list_changed, resource updates from subscriptions, and logging messages. " +
        "Use this to verify your server actually emits what you think it does: " +
        "notifications travel outside the request/response flow, so a tool call result " +
        "will never show them.",
      inputSchema: z.object({
        count: z.number().optional().describe("Return only the most recent N notifications."),
        method: z
          .string()
          .optional()
          .describe(
            "Only return notifications whose method contains this string, " +
              "e.g. 'list_changed' or 'resources/updated'.",
          ),
        clear: z
          .boolean()
          .optional()
          .describe(
            "Clear the buffer after reading. Useful to establish a clean baseline " +
              "before triggering the behavior you want to observe.",
          ),
      }),
    },
    async ({ count, method, clear }) => {
      if (!target) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Not connected to a target server. Call connect_to_mcp first.",
            },
          ],
          isError: true,
        };
      }

      let records = target.getNotifications(count);
      if (method) {
        records = records.filter((r) => r.method.includes(method));
      }
      if (clear) target.clearNotifications();

      if (records.length === 0) {
        const qualifier = method ? ` matching "${method}"` : "";
        return {
          content: [
            {
              type: "text" as const,
              text:
                `No notifications${qualifier} received from the target server.\n\n` +
                "If you expected one, check that your server actually sends it (e.g. " +
                "sendToolListChanged / sendResourceUpdated) and that it declares the " +
                "matching capability.",
            },
          ],
        };
      }

      const formatted = records.map((r) => ({
        method: r.method,
        params: r.params,
        at: new Date(r.timestamp).toISOString(),
      }));

      return {
        content: [
          {
            type: "text" as const,
            text:
              `${records.length} notification(s) from the target server:\n` +
              JSON.stringify(formatted, null, 2) +
              (clear ? "\n\n(buffer cleared)" : ""),
          },
        ],
      };
    },
  );

  // ─── subscribe_to_resource ──────────────────────────────────────────────

  mcpServer.registerTool(
    "subscribe_to_resource",
    {
      title: "Subscribe to Resource",
      description:
        "Subscribe to (or unsubscribe from) a resource URI so the server sends " +
        "notifications/resources/updated when it changes. Read those with " +
        "get_server_notifications. This is the only way to exercise a server's " +
        "subscription support from here.",
      inputSchema: z.object({
        uri: z.string().describe("Resource URI to subscribe to"),
        unsubscribe: z
          .boolean()
          .optional()
          .describe("If true, unsubscribe from this URI instead of subscribing."),
      }),
    },
    async ({ uri, unsubscribe }) => {
      if (!target?.connected) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Not connected to a target server. Call connect_to_mcp first.",
            },
          ],
          isError: true,
        };
      }

      const caps = target.getServerCapabilities() ?? {};
      if (!(caps.resources as any)?.subscribe) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "The target server does not declare resource subscription support " +
                "(capabilities.resources.subscribe). If your server should support it, " +
                "declare the capability — otherwise clients will never subscribe.",
            },
          ],
          isError: true,
        };
      }

      try {
        if (unsubscribe) {
          await target.unsubscribeResource({ uri });
          return {
            content: [{ type: "text" as const, text: `Unsubscribed from "${uri}".` }],
          };
        }
        const outcome = await target.subscribeResource({ uri });
        const how =
          outcome.era === "modern"
            ? (outcome.honoredFilter?.resourceSubscriptions ?? []).includes(uri)
              ? `Opened a subscriptions/listen stream for "${uri}"; the server honored the URI. `
              : `Opened a subscriptions/listen stream, but the server did NOT honor "${uri}" in its ` +
                "acknowledgement — it will never send updates for it. Check the server's subscription filter handling. "
            : `Subscribed to "${uri}" (resources/subscribe). `;
        return {
          content: [
            {
              type: "text" as const,
              text:
                how +
                "Trigger a change, then call get_server_notifications(method='resources/updated') " +
                "to confirm the server sent the update.",
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Subscription failed: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // ─── read_result ────────────────────────────────────────────────────────

  mcpServer.registerTool(
    "read_result",
    {
      title: "Read Spilled Result",
      description:
        "Read a slice of an oversized tool/resource result that was saved to disk. " +
        "When a response is truncated, its note includes a result id (e.g. 'r2') — " +
        "pass that id here with an offset to page through the full payload without " +
        "needing filesystem access. Ids are per-session.",
      inputSchema: z.object({
        id: z.string().describe("Result id from the truncation note (e.g. 'r2')"),
        offset: z.number().optional().describe("Character offset to start from (default 0)"),
        length: z
          .number()
          .optional()
          .describe("Max characters to return (default: the configured max text length)"),
      }),
    },
    async ({ id, offset, length }) => {
      const defaultLength = opts.maxTextLength ?? 50_000;
      const requested = length && length > 0 ? Math.min(length, defaultLength) : defaultLength;
      let slice;
      try {
        slice = await interceptor.readSpilledResult(id, offset ?? 0, requested);
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error reading result: ${err.message}` }],
          isError: true,
        };
      }
      if (!slice) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Unknown result id "${id}". Ids come from truncation notes in this session ` +
                `(e.g. "result id: r2") and don't survive a restart.`,
            },
          ],
          isError: true,
        };
      }
      const end = slice.offset + slice.text.length;
      const more = end < slice.totalChars ? ` — more available (continue at offset ${end})` : "";
      const header = `[result ${id}: chars ${slice.offset.toLocaleString()}–${end.toLocaleString()} of ${slice.totalChars.toLocaleString()}${more}]`;
      return { content: [{ type: "text" as const, text: `${header}\n${slice.text}` }] };
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
      inputSchema: z.object({
        lines: z
          .number()
          .optional()
          .describe("Number of recent lines to return (default: all, max 200)"),
      }),
    },
    async ({ lines }) => {
      // Falls back to the retired target's buffer: the most valuable stderr is
      // the stderr of a server that just died, and that target is already gone.
      const stderrLines = target
        ? target.getStderrLines(lines)
        : lines
          ? lastStderr.slice(-lines)
          : lastStderr;

      if (!target && stderrLines.length > 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `(from the last target, which is no longer running)\n\n${stderrLines.join("\n")}`,
            },
          ],
        };
      }

      const conduct = target ? conductWarnings(target) : [];

      if (stderrLines.length === 0 && conduct.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No stderr output captured." }],
        };
      }

      const text = [
        stderrLines.length > 0 ? stderrLines.join("\n") : "No stderr output captured.",
        ...conduct,
      ].join("\n");
      return { content: [{ type: "text" as const, text }] };
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
      inputSchema: z.object({
        command: z.string().describe("Command to run (e.g. 'node', 'python')"),
        args: z.array(z.string()).optional().describe("Arguments to pass"),
        env: z.record(z.string(), z.string()).optional().describe("Extra environment variables"),
        deep: z
          .boolean()
          .optional()
          .describe("If true, performs deep protocol and schema compliance checks"),
        protocol: z
          .string()
          .optional()
          .describe(
            "Handshake to validate with: 'legacy' (default), 'auto', or a pin like '2026-07-28'.",
          ),
      }),
    },
    async ({ command, args, env, deep, protocol }) => {
      const protocolToUse = protocol ?? opts.protocol;
      if (deep) {
        try {
          const report = await validateProtocol(command, args ?? [], env, {
            protocol: protocolToUse,
          });
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
        env,
        transport: opts.transport,
        protocol: protocolToUse,
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
                `${describeProtocolLine(tempTarget)}\n` +
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
