import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CRASHY_SERVER_ARGS,
  CRASHY_SERVER_CMD,
  MOCK_SERVER_ARGS,
  MOCK_SERVER_CMD,
  POISONED_SERVER_ARGS,
  POISONED_SERVER_CMD,
} from "./helpers.js";

/**
 * End-to-end tests for the compressing proxy (Stage B1). A real MCP Client
 * connects to `run-mcp proxy -- <mock>` and exercises the wrapper surface.
 */

const CLI = resolve(import.meta.dirname, "../dist/index.js");

let client: Client | null = null;
let transport: StdioClientTransport | null = null;

async function startProxy(extra: string[] = []): Promise<Client> {
  transport = new StdioClientTransport({
    command: "node",
    args: [CLI, "proxy", ...extra, "--", MOCK_SERVER_CMD, ...MOCK_SERVER_ARGS],
    stderr: "pipe",
  });
  client = new Client({ name: "proxy-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

afterEach(async () => {
  try {
    await client?.close();
  } catch {
    /* ignore */
  }
  try {
    await transport?.close();
  } catch {
    /* ignore */
  }
  client = null;
  transport = null;
});

describe("compressing proxy (B1)", () => {
  it("exposes only the wrapper tools with the catalog in the description", async () => {
    const c = await startProxy(["-c", "medium"]);
    const { tools } = await c.listTools();
    const names = tools.map((t) => t.name);

    expect(names).toEqual(["get_tool_schema", "invoke_tool"]);
    const catalog = tools.find((t) => t.name === "get_tool_schema")!.description!;
    expect(catalog).toContain("Available tools:");
    expect(catalog).toContain("<tool>greet(name): Returns a greeting</tool>");
  }, 15_000);

  it("get_tool_schema returns the full schema for one tool", async () => {
    const c = await startProxy();
    const res: any = await c.callTool({ name: "get_tool_schema", arguments: { name: "greet" } });
    const text = res.content[0].text as string;
    expect(text).toContain("<tool>greet(name): Returns a greeting</tool>");
    // The JSON schema block is present and parseable.
    const schema = JSON.parse(text.slice(text.indexOf("{")));
    expect(schema.properties.name).toBeDefined();
  }, 15_000);

  it("invoke_tool routes to the backend and returns the flattened result", async () => {
    const c = await startProxy();
    const res: any = await c.callTool({
      name: "invoke_tool",
      arguments: { name: "greet", input: { name: "Ada" } },
    });
    expect(res.content[0].text).toBe("Hello, Ada!");
  }, 15_000);

  it("get_tool_schema errors helpfully for an unknown tool", async () => {
    const c = await startProxy();
    const res: any = await c.callTool({ name: "get_tool_schema", arguments: { name: "nope" } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("not found");
  }, 15_000);

  it("max compression adds list_tools and withholds the upfront catalog", async () => {
    const c = await startProxy(["-c", "max"]);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_tool_schema",
      "invoke_tool",
      "list_tools",
    ]);
    expect(tools.find((t) => t.name === "get_tool_schema")!.description).not.toContain("<tool>");

    const list: any = await c.callTool({ name: "list_tools", arguments: {} });
    expect(list.content[0].text).toContain("<tool>greet</tool>");
  }, 15_000);

  it("--exclude-tools hides a backend tool from the catalog", async () => {
    const c = await startProxy(["--exclude-tools", "greet"]);
    const { tools } = await c.listTools();
    const catalog = tools.find((t) => t.name === "get_tool_schema")!.description!;
    expect(catalog).not.toContain("greet(name)");
    // A hidden tool cannot be fetched either.
    const res: any = await c.callTool({ name: "get_tool_schema", arguments: { name: "greet" } });
    expect(res.isError).toBe(true);
  }, 15_000);
});

describe("multiplexing proxy (B2)", () => {
  async function startMultiplex(extra: string[] = []): Promise<Client> {
    transport = new StdioClientTransport({
      command: "node",
      args: [
        CLI,
        "proxy",
        "-c",
        "medium",
        ...extra,
        "--multi-server",
        `alpha=${MOCK_SERVER_CMD} ${MOCK_SERVER_ARGS.join(" ")}`,
        `beta=${POISONED_SERVER_CMD} ${POISONED_SERVER_ARGS.join(" ")}`,
      ],
      stderr: "pipe",
    });
    client = new Client({ name: "mux-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    return client;
  }

  it("exposes the fixed DCL surface regardless of fleet size", async () => {
    const c = await startMultiplex();
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "find_tools",
      "get_tool_schema",
      "invoke_tool",
      "list_server_tools",
      "list_servers",
    ]);
  }, 20_000);

  it("list_servers embeds the Level-1 overview in its description", async () => {
    const c = await startMultiplex();
    const desc = (await c.listTools()).tools.find((t) => t.name === "list_servers")!.description!;
    expect(desc).toContain("<server>alpha:");
    expect(desc).toContain("<server>beta:");
  }, 20_000);

  it("find_tools returns namespaced, BM25-ranked results across servers", async () => {
    const c = await startMultiplex();
    const res: any = await c.callTool({
      name: "find_tools",
      arguments: { query: "greet someone by name" },
    });
    expect(res.content[0].text).toContain("alpha__greet");
  }, 20_000);

  it("invoke_tool routes a namespaced call to the owning backend", async () => {
    const c = await startMultiplex();
    const res: any = await c.callTool({
      name: "invoke_tool",
      arguments: { name: "alpha__greet", input: { name: "Ada" } },
    });
    expect(res.content[0].text).toBe("Hello, Ada!");
  }, 20_000);

  it("get_tool_schema returns the schema under the namespaced name", async () => {
    const c = await startMultiplex();
    const res: any = await c.callTool({
      name: "get_tool_schema",
      arguments: { name: "alpha__greet" },
    });
    expect(res.content[0].text).toContain("<tool>alpha__greet(name)");
  }, 20_000);

  it("list_server_tools lists one server's namespaced catalog", async () => {
    const c = await startMultiplex();
    const res: any = await c.callTool({ name: "list_server_tools", arguments: { server: "beta" } });
    expect(res.content[0].text).toContain("beta__lookup");
  }, 20_000);

  it("names an unknown server explicitly when routing fails", async () => {
    const c = await startMultiplex();
    const res: any = await c.callTool({
      name: "invoke_tool",
      arguments: { name: "ghost__echo", input: {} },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Server "ghost" not found');
  }, 20_000);

  it("reports a crashed backend as down and keeps healthy backends serving", async () => {
    transport = new StdioClientTransport({
      command: "node",
      args: [
        CLI,
        "proxy",
        "-c",
        "medium",
        "--multi-server",
        `alpha=${MOCK_SERVER_CMD} ${MOCK_SERVER_ARGS.join(" ")}`,
        `crashy=${CRASHY_SERVER_CMD} ${CRASHY_SERVER_ARGS.join(" ")}`,
      ],
      stderr: "pipe",
    });
    client = new Client({ name: "mux-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    const c = client;

    // The crashy backend serves before the crash.
    const before: any = await c.callTool({
      name: "invoke_tool",
      arguments: { name: "crashy__echo", input: { text: "up" } },
    });
    expect(before.content[0].text).toBe("up");

    // Crash it. (It dies within its min-uptime window, so auto-reconnect
    // classifies the crash as a startup bug and the backend stays down.)
    await c.callTool({ name: "invoke_tool", arguments: { name: "crashy__die", input: {} } });

    // Poll until the disconnect propagates: the proxy must say the BACKEND is
    // down — not "tool not found".
    const deadline = Date.now() + 10_000;
    let downRes: any;
    for (;;) {
      downRes = await c.callTool({
        name: "invoke_tool",
        arguments: { name: "crashy__echo", input: { text: "again" } },
      });
      const text = String(downRes.content?.[0]?.text ?? "");
      if (downRes.isError && text.includes("down")) break;
      if (Date.now() > deadline) {
        throw new Error(`backend never reported down; last response: ${text}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(downRes.content[0].text).toContain('Backend server "crashy" is down');

    // list_servers reflects the outage.
    const overview: any = await c.callTool({ name: "list_servers", arguments: {} });
    expect(overview.content[0].text).toContain("DOWN");

    // The healthy backend is unaffected.
    const alpha: any = await c.callTool({
      name: "invoke_tool",
      arguments: { name: "alpha__echo", input: { text: "alive" } },
    });
    expect(alpha.content[0].text).toBe("alive");
  }, 30_000);
});
