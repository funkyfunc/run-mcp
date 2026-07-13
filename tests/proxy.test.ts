import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MOCK_SERVER_ARGS, MOCK_SERVER_CMD } from "./helpers.js";

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
    expect(tools.map((t) => t.name).sort()).toEqual(["get_tool_schema", "invoke_tool", "list_tools"]);
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
