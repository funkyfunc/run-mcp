import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { MOCK_SERVER_ARGS, MOCK_SERVER_CMD } from "./helpers.js";

/**
 * Tests for the server mode (consolidated tool surface).
 *
 * Spawns `run-mcp server`, connects an MCP Client to it, then uses
 * the server's tools (connect_to_mcp, call_mcp_primitive, etc.) to
 * dynamically test the mock MCP server.
 */

const SERVER_BIN = resolve(import.meta.dirname, "../dist/index.js");

let client: Client | null = null;
let transport: StdioClientTransport | null = null;
const testOutDir: string | null = null;

afterEach(async () => {
  // Disconnect from mock server before closing
  if (client) {
    try {
      await client.callTool({ name: "disconnect_from_mcp", arguments: {} });
    } catch {
      /* ignore */
    }
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    client = null;
  }
  if (transport) {
    try {
      await transport.close();
    } catch {
      /* ignore */
    }
    transport = null;
  }
  if (testOutDir && existsSync(testOutDir)) {
    await rm(testOutDir, { recursive: true, force: true });
  }
});

async function startRunMcpServer(extraArgs: string[] = []): Promise<Client> {
  transport = new StdioClientTransport({
    command: "node",
    args: [SERVER_BIN, ...extraArgs],
    stderr: "pipe",
  });

  client = new Client({ name: "server-test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

async function connectToMockServer(c: Client, extra: Record<string, unknown> = {}): Promise<any> {
  return await c.callTool({
    name: "connect_to_mcp",
    arguments: {
      command: MOCK_SERVER_CMD,
      args: MOCK_SERVER_ARGS,
      ...extra,
    },
  });
}

function getText(result: any): string {
  return result.content?.[0]?.text ?? "";
}

// ═══════════════════════════════════════════════════════════════════════════
// Server tool discovery
// ═══════════════════════════════════════════════════════════════════════════

describe("server: tool discovery", () => {
  it("exposes exactly 7 consolidated tools", async () => {
    const c = await startRunMcpServer();
    const result = await c.listTools();
    const names = result.tools.map((t) => t.name);

    expect(names).toContain("connect_to_mcp");
    expect(names).toContain("disconnect_from_mcp");
    expect(names).toContain("mcp_server_status");
    expect(names).toContain("call_mcp_primitive");
    expect(names).toContain("list_mcp_primitives");
    expect(names).toContain("get_mcp_server_stderr");
    expect(names).toContain("list_available_mcp_servers");
    expect(names).toHaveLength(7);
  }, 15_000);

  it("tools have descriptions", async () => {
    const c = await startRunMcpServer();
    const result = await c.listTools();

    for (const tool of result.tools) {
      expect(tool.description).toBeTruthy();
    }
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// Connection lifecycle
// ═══════════════════════════════════════════════════════════════════════════

describe("server: connection lifecycle", () => {
  it("connects to a local MCP server", async () => {
    const c = await startRunMcpServer();
    const result = await connectToMockServer(c);

    const text = getText(result);
    expect(text).toContain("Connected to MCP server");
    expect(text).toContain("PID:");
    expect(text).toContain("Tools available:");
  }, 15_000);

  it("returns error when connecting while already connected", async () => {
    const c = await startRunMcpServer();
    await connectToMockServer(c);

    // Try to connect again
    const result = await connectToMockServer(c);
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Already connected");
  }, 15_000);

  it("disconnects successfully", async () => {
    const c = await startRunMcpServer();
    await connectToMockServer(c);

    const result = await c.callTool({ name: "disconnect_from_mcp", arguments: {} });
    expect(getText(result)).toContain("Disconnected");
  }, 15_000);

  it("returns error when disconnecting with no connection", async () => {
    const c = await startRunMcpServer();
    const result = await c.callTool({ name: "disconnect_from_mcp", arguments: {} });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("No target server");
  }, 15_000);

  it("can reconnect after disconnect", async () => {
    const c = await startRunMcpServer();
    await connectToMockServer(c);
    await c.callTool({ name: "disconnect_from_mcp", arguments: {} });

    // Reconnect
    const result = await connectToMockServer(c);
    expect(getText(result)).toContain("Connected to MCP server");
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// Server status
// ═══════════════════════════════════════════════════════════════════════════

describe("server: status", () => {
  it("shows status when connected", async () => {
    const c = await startRunMcpServer();
    await connectToMockServer(c);

    const result = await c.callTool({ name: "mcp_server_status", arguments: {} });
    const text = getText(result);
    expect(text).toContain("Connected: true");
    expect(text).toContain("PID:");
  }, 15_000);

  it("shows status when not connected", async () => {
    const c = await startRunMcpServer();
    const result = await c.callTool({ name: "mcp_server_status", arguments: {} });
    expect(getText(result)).toContain("No target server connected");
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// call_mcp_primitive: tool calls
// ═══════════════════════════════════════════════════════════════════════════

describe("server: call_mcp_primitive — tools", () => {
  it("calls a tool on the connected server", async () => {
    const c = await startRunMcpServer();
    await connectToMockServer(c);

    const result = await c.callTool({
      name: "call_mcp_primitive",
      arguments: { type: "tool", name: "echo", arguments: { text: "hello from primitive" } },
    });
    expect(getText(result)).toMatch(/^hello from primitive \(\d+ms\)$/);
  }, 15_000);

  it("intercepts screenshots", async () => {
    const c = await startRunMcpServer();
    await connectToMockServer(c);

    const result = await c.callTool({
      name: "call_mcp_primitive",
      arguments: { type: "tool", name: "screenshot" },
    });
    expect(getText(result)).toMatch(/\[Image saved to .+\.png/);
  }, 15_000);

  it("intercepts audio", async () => {
    const c = await startRunMcpServer();
    await connectToMockServer(c);

    const result = await c.callTool({
      name: "call_mcp_primitive",
      arguments: { type: "tool", name: "audio_tool" },
    });
    expect(getText(result)).toMatch(/\[Audio saved to .+\.wav/);
  }, 15_000);

  it("returns error when not connected and no command provided", async () => {
    const c = await startRunMcpServer();
    const result = await c.callTool({
      name: "call_mcp_primitive",
      arguments: { type: "tool", name: "echo", arguments: { text: "test" } },
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Not connected");
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// call_mcp_primitive: auto-connect
// ═══════════════════════════════════════════════════════════════════════════

describe("server: call_mcp_primitive — auto-connect", () => {
  it("auto-connects when command is provided", async () => {
    const c = await startRunMcpServer();

    // No explicit connect — just call with command/args
    const result = await c.callTool({
      name: "call_mcp_primitive",
      arguments: {
        type: "tool",
        name: "echo",
        arguments: { text: "auto-connected" },
        command: MOCK_SERVER_CMD,
        args: MOCK_SERVER_ARGS,
      },
    });
    expect(getText(result)).toMatch(/^auto-connected \(\d+ms\)$/);
  }, 15_000);

  it("disconnect_after tears down after call", async () => {
    const c = await startRunMcpServer();

    // Call with disconnect_after
    const result = await c.callTool({
      name: "call_mcp_primitive",
      arguments: {
        type: "tool",
        name: "echo",
        arguments: { text: "one-shot" },
        command: MOCK_SERVER_CMD,
        args: MOCK_SERVER_ARGS,
        disconnect_after: true,
      },
    });
    expect(getText(result)).toMatch(/^one-shot \(\d+ms\)$/);

    // Verify disconnected — status should show not connected
    const status = await c.callTool({ name: "mcp_server_status", arguments: {} });
    expect(getText(status)).toContain("No target server connected");
  }, 15_000);

  it("uses existing connection when already connected", async () => {
    const c = await startRunMcpServer();
    await connectToMockServer(c);

    // Call without command/args — should use existing connection
    const result = await c.callTool({
      name: "call_mcp_primitive",
      arguments: { type: "tool", name: "echo", arguments: { text: "reuse" } },
    });
    expect(getText(result)).toMatch(/^reuse \(\d+ms\)$/);
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// call_mcp_primitive: resources
// ═══════════════════════════════════════════════════════════════════════════

describe("server: call_mcp_primitive — resources", () => {
  it("reads a resource by URI", async () => {
    const c = await startRunMcpServer();
    await connectToMockServer(c);

    const result = await c.callTool({
      name: "call_mcp_primitive",
      arguments: { type: "resource", name: "docs://readme" },
    });
    expect(getText(result)).toContain("Mock Server");
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// call_mcp_primitive: prompts
// ═══════════════════════════════════════════════════════════════════════════

describe("server: call_mcp_primitive — prompts", () => {
  it("gets a prompt with arguments", async () => {
    const c = await startRunMcpServer();
    await connectToMockServer(c);

    const result = await c.callTool({
      name: "call_mcp_primitive",
      arguments: {
        type: "prompt",
        name: "greeting",
        arguments: { name: "TestAgent" },
      },
    });
    expect(getText(result)).toContain("TestAgent");
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// list_mcp_primitives
// ═══════════════════════════════════════════════════════════════════════════

describe("server: list_mcp_primitives", () => {
  it("lists tools by default", async () => {
    const c = await startRunMcpServer();
    await connectToMockServer(c);

    const result = await c.callTool({
      name: "list_mcp_primitives",
      arguments: {},
    });
    const text = getText(result);
    expect(text).toContain("echo");
    expect(text).toContain("greet");
    expect(text).toContain("--- Tools ---");
  }, 15_000);

  it("lists only tools when requested", async () => {
    const c = await startRunMcpServer();
    await connectToMockServer(c);

    const result = await c.callTool({
      name: "list_mcp_primitives",
      arguments: { type: ["tools"] },
    });
    const text = getText(result);
    expect(text).toContain("--- Tools ---");
    expect(text).not.toContain("--- Resources ---");
    expect(text).not.toContain("--- Prompts ---");
  }, 15_000);

  it("lists resources and prompts", async () => {
    const c = await startRunMcpServer();
    await connectToMockServer(c);

    const result = await c.callTool({
      name: "list_mcp_primitives",
      arguments: { type: ["resources", "prompts"] },
    });
    const text = getText(result);
    expect(text).toContain("docs://readme");
    expect(text).toContain("greeting");
    expect(text).not.toContain("--- Tools ---");
  }, 15_000);

  it("returns error when not connected", async () => {
    const c = await startRunMcpServer();
    const result = await c.callTool({
      name: "list_mcp_primitives",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("No target server connected");
  }, 15_000);

  it("filters to a single tool by name", async () => {
    const c = await startRunMcpServer();
    await connectToMockServer(c);

    const result = await c.callTool({
      name: "list_mcp_primitives",
      arguments: { type: ["tools"], name: "echo" },
    });
    const text = getText(result);
    expect(text).toContain("echo");
    expect(text).toContain("inputSchema");
    // Should NOT contain other tools
    expect(text).not.toContain("greet");
    expect(text).not.toContain("screenshot");
  }, 15_000);

  it("shows available tools when name not found", async () => {
    const c = await startRunMcpServer();
    await connectToMockServer(c);

    const result = await c.callTool({
      name: "list_mcp_primitives",
      arguments: { type: ["tools"], name: "nonexistent" },
    });
    const text = getText(result);
    expect(text).toContain('Tool "nonexistent" not found');
    expect(text).toContain("Available:");
    expect(text).toContain("echo");
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// connect_to_mcp: include flags
// ═══════════════════════════════════════════════════════════════════════════

describe("server: connect_to_mcp — include flags", () => {
  it("includes tools in connect response", async () => {
    const c = await startRunMcpServer();
    const result = await connectToMockServer(c, { include: ["tools"] });
    const text = getText(result);

    expect(text).toContain("Connected to MCP server");
    expect(text).toContain("--- Tools ---");
    expect(text).toContain("echo");
  }, 15_000);

  it("includes all primitives when requested", async () => {
    const c = await startRunMcpServer();
    const result = await connectToMockServer(c, {
      include: ["tools", "resources", "prompts"],
    });
    const text = getText(result);

    expect(text).toContain("--- Tools ---");
    expect(text).toContain("--- Resources ---");
    expect(text).toContain("--- Prompts ---");
  }, 15_000);

  it("connect without include returns only summary", async () => {
    const c = await startRunMcpServer();
    const result = await connectToMockServer(c);
    const text = getText(result);

    expect(text).toContain("Connected to MCP server");
    expect(text).not.toContain("--- Tools ---");
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// connect_to_mcp: reconnect diff
// ═══════════════════════════════════════════════════════════════════════════

describe("server: connect_to_mcp — reconnect diff", () => {
  it("shows unchanged on reconnect to same server", async () => {
    const c = await startRunMcpServer();

    // First connect (no diff)
    await connectToMockServer(c, { include: ["tools"] });
    await c.callTool({ name: "disconnect_from_mcp", arguments: {} });

    // Second connect — should show diff
    const result = await connectToMockServer(c, { include: ["tools"] });
    const text = getText(result);
    expect(text).toContain("Changes since last connection");
    // Same server — nothing changed
    expect(text).toMatch(/unchanged|none/i);
  }, 25_000);

  it("does not show diff on first connect", async () => {
    const c = await startRunMcpServer();
    const result = await connectToMockServer(c, { include: ["tools"] });
    const text = getText(result);

    expect(text).not.toContain("Changes since last connection");
  }, 15_000);

  it("does not show diff when include is not specified", async () => {
    const c = await startRunMcpServer();

    // First connect with include
    await connectToMockServer(c, { include: ["tools"] });
    await c.callTool({ name: "disconnect_from_mcp", arguments: {} });

    // Second connect WITHOUT include — should not show diff
    const result = await connectToMockServer(c);
    const text = getText(result);
    expect(text).not.toContain("Changes since last connection");
  }, 25_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// Diagnostics
// ═══════════════════════════════════════════════════════════════════════════

describe("server: diagnostics", () => {
  it("captures stderr from target server", async () => {
    const c = await startRunMcpServer();
    await connectToMockServer(c);

    // The mock server writes to stderr on startup
    const result = await c.callTool({
      name: "get_mcp_server_stderr",
      arguments: {},
    });
    expect(getText(result)).toContain("Mock MCP server running on stdio");
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// Pre-call schema validation
// ═══════════════════════════════════════════════════════════════════════════

describe("server: call_mcp_primitive — schema validation", () => {
  it("returns error with suggestion for typo tool name", async () => {
    const c = await startRunMcpServer();
    await connectToMockServer(c);

    const result = await c.callTool({
      name: "call_mcp_primitive",
      arguments: { type: "tool", name: "ech", arguments: { text: "hi" } },
    });
    expect(result.isError).toBe(true);
    const text = getText(result);
    expect(text).toContain('Tool "ech" not found');
    expect(text).toContain('Did you mean "echo"');
  }, 15_000);

  it("returns error without suggestion for unrelated tool name", async () => {
    const c = await startRunMcpServer();
    await connectToMockServer(c);

    const result = await c.callTool({
      name: "call_mcp_primitive",
      arguments: { type: "tool", name: "xyzzy_nonexistent_tool", arguments: {} },
    });
    expect(result.isError).toBe(true);
    const text = getText(result);
    expect(text).toContain('Tool "xyzzy_nonexistent_tool" not found');
    expect(text).not.toContain("Did you mean");
    expect(text).toContain("Available tools:");
  }, 15_000);

  it("returns error for missing required arguments", async () => {
    const c = await startRunMcpServer();
    await connectToMockServer(c);

    const result = await c.callTool({
      name: "call_mcp_primitive",
      arguments: { type: "tool", name: "greet", arguments: {} },
    });
    expect(result.isError).toBe(true);
    const text = getText(result);
    expect(text).toContain('Tool "greet" requires:');
    expect(text).toContain("name");
  }, 15_000);

  it("appends timing to successful tool call responses", async () => {
    const c = await startRunMcpServer();
    await connectToMockServer(c);

    const result = await c.callTool({
      name: "call_mcp_primitive",
      arguments: { type: "tool", name: "echo", arguments: { text: "timing test" } },
    });
    const text = getText(result);
    expect(text).toMatch(/timing test \(\d+ms\)/);
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// call_mcp_primitive: include_metadata
// ═══════════════════════════════════════════════════════════════════════════

describe("server: call_mcp_primitive — include_metadata", () => {
  it("returns metadata content item when include_metadata is true", async () => {
    const c = await startRunMcpServer();
    await connectToMockServer(c);

    const result = await c.callTool({
      name: "call_mcp_primitive",
      arguments: {
        type: "tool",
        name: "echo",
        arguments: { text: "meta test" },
        include_metadata: true,
      },
    });

    const content = (result as any).content;
    expect(content.length).toBeGreaterThanOrEqual(2);

    // First item should be the metadata
    const metaItem = content[0];
    expect(metaItem.type).toBe("text");
    expect(metaItem.text).toContain("--- metadata ---");

    // Parse the metadata JSON
    const metaJson = JSON.parse(metaItem.text.replace("--- metadata ---\n", ""));
    expect(metaJson.latency_ms).toBeTypeOf("number");
    expect(metaJson.latency_ms).toBeGreaterThanOrEqual(0);
    expect(metaJson.content_items).toBe(1); // echo returns 1 content item
    expect(metaJson.is_error).toBe(false);
    expect(metaJson.truncated).toBe(false);
    expect(metaJson.images_saved).toBe(0);
    expect(metaJson.audio_saved).toBe(0);
    expect(metaJson.original_size_bytes).toBeTypeOf("number");

    // Second item should be the actual result WITHOUT inline timing
    const resultItem = content[1];
    expect(resultItem.text).toBe("meta test");
    expect(resultItem.text).not.toMatch(/\(\d+ms\)/);
  }, 15_000);

  it("reports images_saved in metadata for screenshots", async () => {
    const c = await startRunMcpServer();
    await connectToMockServer(c);

    const result = await c.callTool({
      name: "call_mcp_primitive",
      arguments: {
        type: "tool",
        name: "screenshot",
        include_metadata: true,
      },
    });

    const content = (result as any).content;
    const metaJson = JSON.parse(content[0].text.replace("--- metadata ---\n", ""));
    expect(metaJson.images_saved).toBe(1);
  }, 15_000);

  it("omits metadata when include_metadata is false/absent", async () => {
    const c = await startRunMcpServer();
    await connectToMockServer(c);

    const result = await c.callTool({
      name: "call_mcp_primitive",
      arguments: {
        type: "tool",
        name: "echo",
        arguments: { text: "no meta" },
      },
    });

    const content = (result as any).content;
    expect(content.length).toBe(1);
    // Should have inline timing instead of metadata
    expect(content[0].text).toMatch(/no meta \(\d+ms\)/);
  }, 15_000);
});
