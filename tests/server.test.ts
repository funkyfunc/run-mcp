import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { MOCK_SERVER_ARGS, MOCK_SERVER_CMD } from "./helpers.js";

/**
 * Tests for the server mode.
 *
 * Spawns `run-mcp server`, connects an MCP Client to it, then uses
 * the server's tools (connect_to_mcp, list_mcp_tools, etc.) to
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
    args: [SERVER_BIN, "server", ...extraArgs],
    stderr: "pipe",
  });

  client = new Client({ name: "server-test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

async function connectToMockServer(c: Client): Promise<any> {
  return await c.callTool({
    name: "connect_to_mcp",
    arguments: {
      command: MOCK_SERVER_CMD,
      args: MOCK_SERVER_ARGS,
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
  it("exposes all run-mcp tools", async () => {
    const c = await startRunMcpServer();
    const result = await c.listTools();
    const names = result.tools.map((t) => t.name);

    expect(names).toContain("connect_to_mcp");
    expect(names).toContain("disconnect_from_mcp");
    expect(names).toContain("mcp_server_status");
    expect(names).toContain("list_mcp_tools");
    expect(names).toContain("call_mcp_tool");
    expect(names).toContain("list_mcp_resources");
    expect(names).toContain("read_mcp_resource");
    expect(names).toContain("list_mcp_prompts");
    expect(names).toContain("get_mcp_prompt");
    expect(names).toContain("get_mcp_server_stderr");
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
// Tool operations
// ═══════════════════════════════════════════════════════════════════════════

describe("server: tool operations", () => {
  it("lists tools on the connected server", async () => {
    const c = await startRunMcpServer();
    await connectToMockServer(c);

    const result = await c.callTool({ name: "list_mcp_tools", arguments: {} });
    const text = getText(result);
    expect(text).toContain("echo");
    expect(text).toContain("greet");
    expect(text).toContain("screenshot");
  }, 15_000);

  it("calls a tool on the connected server", async () => {
    const c = await startRunMcpServer();
    await connectToMockServer(c);

    const result = await c.callTool({
      name: "call_mcp_tool",
      arguments: { name: "echo", arguments: { text: "hello from server mode" } },
    });
    expect(getText(result)).toBe("hello from server mode");
  }, 15_000);

  it("intercepts screenshots through server mode", async () => {
    const c = await startRunMcpServer();
    await connectToMockServer(c);

    const result = await c.callTool({
      name: "call_mcp_tool",
      arguments: { name: "screenshot" },
    });
    expect(getText(result)).toMatch(/\[Image saved to .+\.png/);
  }, 15_000);

  it("intercepts audio through server mode", async () => {
    const c = await startRunMcpServer();
    await connectToMockServer(c);

    const result = await c.callTool({
      name: "call_mcp_tool",
      arguments: { name: "audio_tool" },
    });
    expect(getText(result)).toMatch(/\[Audio saved to .+\.wav/);
  }, 15_000);

  it("returns error when calling tool while disconnected", async () => {
    const c = await startRunMcpServer();
    const result = await c.callTool({
      name: "call_mcp_tool",
      arguments: { name: "echo", arguments: { text: "test" } },
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("No target server connected");
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// Resource operations
// ═══════════════════════════════════════════════════════════════════════════

describe("server: resource operations", () => {
  it("lists resources on the connected server", async () => {
    const c = await startRunMcpServer();
    await connectToMockServer(c);

    const result = await c.callTool({ name: "list_mcp_resources", arguments: {} });
    const text = getText(result);
    expect(text).toContain("docs://readme");
    expect(text).toContain("docs://config");
  }, 15_000);

  it("reads a resource by URI", async () => {
    const c = await startRunMcpServer();
    await connectToMockServer(c);

    const result = await c.callTool({
      name: "read_mcp_resource",
      arguments: { uri: "docs://readme" },
    });
    expect(getText(result)).toContain("Mock Server");
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// Prompt operations
// ═══════════════════════════════════════════════════════════════════════════

describe("server: prompt operations", () => {
  it("lists prompts on the connected server", async () => {
    const c = await startRunMcpServer();
    await connectToMockServer(c);

    const result = await c.callTool({ name: "list_mcp_prompts", arguments: {} });
    expect(getText(result)).toContain("greeting");
  }, 15_000);

  it("gets a prompt with arguments", async () => {
    const c = await startRunMcpServer();
    await connectToMockServer(c);

    const result = await c.callTool({
      name: "get_mcp_prompt",
      arguments: { name: "greeting", arguments: { name: "TestAgent" } },
    });
    expect(getText(result)).toContain("TestAgent");
  }, 15_000);
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
