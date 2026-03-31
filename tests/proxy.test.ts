import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { MOCK_SERVER_ARGS, MOCK_SERVER_CMD } from "./helpers.js";

/**
 * Tests for the proxy mode.
 *
 * Spawns `run-mcp proxy` pointing at the mock server,
 * then connects an MCP Client to the proxy and verifies
 * that tools are forwarded correctly.
 */

const PROXY_BIN = resolve(import.meta.dirname, "../dist/index.js");

let client: Client | null = null;
let transport: StdioClientTransport | null = null;

afterEach(async () => {
  if (client) {
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
});

async function connectProxy(): Promise<Client> {
  transport = new StdioClientTransport({
    command: "node",
    args: [PROXY_BIN, "proxy", MOCK_SERVER_CMD, ...MOCK_SERVER_ARGS],
    stderr: "pipe",
  });

  client = new Client({ name: "proxy-test-client", version: "1.0.0" }, { capabilities: {} });

  await client.connect(transport);
  return client;
}

// ═══════════════════════════════════════════════════════════════════════════
// Proxy tool listing
// ═══════════════════════════════════════════════════════════════════════════

describe("proxy: tools/list", () => {
  it("forwards tools from the target server", async () => {
    const c = await connectProxy();
    const result = await c.listTools();
    const names = result.tools.map((t) => t.name);

    expect(names).toContain("echo");
    expect(names).toContain("greet");
    expect(names).toContain("slow");
    expect(names).toContain("screenshot");
  }, 15_000);

  it("preserves tool descriptions", async () => {
    const c = await connectProxy();
    const result = await c.listTools();
    const echo = result.tools.find((t) => t.name === "echo");

    expect(echo?.description).toBe("Echoes back the provided text");
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// Proxy tool calling
// ═══════════════════════════════════════════════════════════════════════════

describe("proxy: tools/call", () => {
  it("forwards echo call and returns result", async () => {
    const c = await connectProxy();
    const result = await c.callTool({ name: "echo", arguments: { text: "proxied" } });
    const content = result.content as Array<{ type: string; text: string }>;

    expect(content[0].text).toBe("proxied");
  }, 15_000);

  it("intercepts screenshot images through proxy", async () => {
    const c = await connectProxy();
    const result = await c.callTool({ name: "screenshot", arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;

    // The proxy's interceptor should have saved the image
    expect(content[0].type).toBe("text");
    expect(content[0].text).toMatch(/\[Image saved to .+\.png/);
  }, 15_000);

  it("forwards greet call correctly", async () => {
    const c = await connectProxy();
    const result = await c.callTool({ name: "greet", arguments: { name: "ProxyTest" } });
    const content = result.content as Array<{ type: string; text: string }>;

    expect(content[0].text).toBe("Hello, ProxyTest!");
  }, 15_000);
});
