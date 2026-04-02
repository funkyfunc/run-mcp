import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { MOCK_SERVER_ARGS, MOCK_SERVER_CMD } from "./helpers.js";

/**
 * Tests for the proxy mode.
 *
 * Spawns `run-mcp proxy` pointing at the mock server,
 * then connects an MCP Client to the proxy and verifies
 * that ALL MCP primitives are forwarded correctly:
 *  - tools (list, call, annotations, isError, audio)
 *  - resources (list, read, templates)
 *  - prompts (list, get)
 *  - capability mirroring
 */

const PROXY_BIN = resolve(import.meta.dirname, "../dist/index.js");

let client: Client | null = null;
let transport: StdioClientTransport | null = null;
let testOutDir: string | null = null;

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
  if (testOutDir && existsSync(testOutDir)) {
    await rm(testOutDir, { recursive: true, force: true });
  }
});

async function connectProxy(extraArgs: string[] = []): Promise<Client> {
  transport = new StdioClientTransport({
    command: "node",
    args: [PROXY_BIN, "proxy", ...extraArgs, MOCK_SERVER_CMD, ...MOCK_SERVER_ARGS],
    stderr: "pipe",
  });

  client = new Client({ name: "proxy-test-client", version: "1.0.0" }, { capabilities: {} });

  await client.connect(transport);
  return client;
}

// ═══════════════════════════════════════════════════════════════════════════
// Capability mirroring
// ═══════════════════════════════════════════════════════════════════════════

describe("proxy: capability mirroring", () => {
  it("mirrors tools capability from target", async () => {
    const c = await connectProxy();
    const caps = c.getServerCapabilities();

    expect(caps?.tools).toBeDefined();
  }, 15_000);

  it("mirrors resources capability from target", async () => {
    const c = await connectProxy();
    const caps = c.getServerCapabilities();

    expect(caps?.resources).toBeDefined();
  }, 15_000);

  it("mirrors prompts capability from target", async () => {
    const c = await connectProxy();
    const caps = c.getServerCapabilities();

    expect(caps?.prompts).toBeDefined();
  }, 15_000);
});

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
    expect(names).toContain("audio_tool");
    expect(names).toContain("error_tool");
  }, 15_000);

  it("preserves tool descriptions", async () => {
    const c = await connectProxy();
    const result = await c.listTools();
    const echo = result.tools.find((t) => t.name === "echo");

    expect(echo?.description).toBe("Echoes back the provided text");
  }, 15_000);

  it("preserves tool annotations", async () => {
    const c = await connectProxy();
    const result = await c.listTools();
    const greet = result.tools.find((t) => t.name === "greet");

    expect(greet?.annotations).toBeDefined();
    expect(greet?.annotations?.readOnlyHint).toBe(true);
    expect(greet?.annotations?.destructiveHint).toBe(false);
    expect(greet?.annotations?.idempotentHint).toBe(true);
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

  it("intercepts audio through proxy", async () => {
    const c = await connectProxy();
    const result = await c.callTool({ name: "audio_tool", arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;

    expect(content[0].type).toBe("text");
    expect(content[0].text).toMatch(/\[Audio saved to .+\.wav/);
  }, 15_000);

  it("preserves isError flag from target", async () => {
    const c = await connectProxy();
    const result = await c.callTool({ name: "error_tool", arguments: {} });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe("Something went wrong in the tool");
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// Proxy resources
// ═══════════════════════════════════════════════════════════════════════════

describe("proxy: resources", () => {
  it("lists resources from the target server", async () => {
    const c = await connectProxy();
    const result = await c.listResources();
    const uris = result.resources.map((r) => r.uri);

    expect(uris).toContain("docs://readme");
    expect(uris).toContain("docs://config");
  }, 15_000);

  it("reads a resource by URI", async () => {
    const c = await connectProxy();
    const result = await c.readResource({ uri: "docs://readme" });

    expect(result.contents.length).toBeGreaterThan(0);
    const content = result.contents[0] as { uri: string; text: string; mimeType?: string };
    expect(content.text).toContain("Mock Server");
    expect(content.mimeType).toBe("text/markdown");
  }, 15_000);

  it("lists resource templates from the target server", async () => {
    const c = await connectProxy();
    const result = await c.listResourceTemplates();

    expect(result.resourceTemplates.length).toBeGreaterThan(0);
    const template = result.resourceTemplates[0];
    expect(template.uriTemplate).toContain("{page}");
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// Proxy prompts
// ═══════════════════════════════════════════════════════════════════════════

describe("proxy: prompts", () => {
  it("lists prompts from the target server", async () => {
    const c = await connectProxy();
    const result = await c.listPrompts();
    const names = result.prompts.map((p) => p.name);

    expect(names).toContain("greeting");
  }, 15_000);

  it("gets a prompt with arguments", async () => {
    const c = await connectProxy();
    const result = await c.getPrompt({ name: "greeting", arguments: { name: "Agent" } });

    expect(result.messages.length).toBeGreaterThan(0);
    const msg = result.messages[0];
    expect(msg.role).toBe("user");
    const content = msg.content as { type: string; text: string };
    expect(content.text).toContain("Agent");
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// Proxy CLI options
// ═══════════════════════════════════════════════════════════════════════════

describe("proxy: CLI options", () => {
  it("respects --out-dir for image saving", async () => {
    testOutDir = join(tmpdir(), `run-mcp-proxy-test-${Date.now()}`);
    const c = await connectProxy(["--out-dir", testOutDir]);
    await c.callTool({ name: "screenshot", arguments: {} });

    const files = await readdir(testOutDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/\.png$/);
  }, 15_000);
});
