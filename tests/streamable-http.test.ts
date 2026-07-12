import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { TargetManager } from "../src/target-manager.js";

/**
 * Integration tests for the Streamable HTTP client transport.
 *
 * Spins up an in-process stateless Streamable HTTP MCP server (fresh server +
 * transport per request, the SDK's stateless pattern) and points a real
 * TargetManager at it over http://.
 */

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "streamable-fixture", version: "1.0.0" });
  server.registerTool(
    "echo",
    { description: "Echo text back", inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: "text", text }] }),
  );
  return server;
}

let httpServer: Server;
let baseUrl: string;
let target: TargetManager | null = null;

beforeEach(async () => {
  httpServer = createServer((req, res) => {
    void (async () => {
      // Stateless: a fresh McpServer + transport per request.
      const mcp = buildMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        mcp.close();
      });
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res);
      } catch {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end();
        }
      }
    })();
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}/mcp`;
});

afterEach(async () => {
  if (target) {
    await target.close();
    target = null;
  }
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe("Streamable HTTP transport", () => {
  it("connects and lists tools over http (explicit --transport http)", async () => {
    target = new TargetManager(baseUrl, [], { transport: "http" });
    await target.connect();

    expect(target.connected).toBe(true);
    const { tools } = await target.listTools();
    expect(tools.map((t) => t.name)).toContain("echo");
  }, 15_000);

  it("calls a tool over http", async () => {
    target = new TargetManager(baseUrl, [], { transport: "http" });
    await target.connect();

    const result: any = await target.callTool("echo", { text: "over http" });
    expect(result.content[0].text).toBe("over http");
  }, 15_000);

  it("auto mode selects Streamable HTTP for an http(s) target", async () => {
    target = new TargetManager(baseUrl, [], { transport: "auto" });
    await target.connect();
    expect(target.connected).toBe(true);
    // A Streamable HTTP server target has no child process.
    expect(target.getStatus().pid).toBeNull();
  }, 15_000);
});

describe("auto transport SSE fallback", () => {
  let sseServer: Server;
  let sseUrl: string;
  let sseTarget: TargetManager | null = null;

  beforeEach(async () => {
    // An SSE-ONLY server: GET /sse opens the event stream, POST /messages carries
    // client messages. It has no POST /sse handler, so a Streamable HTTP client's
    // initialize POST fails — exactly the case auto-fallback must handle.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const transports: Record<string, SSEServerTransport> = {};
    sseServer = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url || "/", "http://localhost");
        if (req.method === "GET" && url.pathname === "/sse") {
          // eslint-disable-next-line @typescript-eslint/no-deprecated
          const transport = new SSEServerTransport("/messages", res);
          transports[transport.sessionId] = transport;
          res.on("close", () => delete transports[transport.sessionId]);
          const mcp = buildMcpServer();
          await mcp.connect(transport);
        } else if (req.method === "POST" && url.pathname === "/messages") {
          const sid = url.searchParams.get("sessionId") ?? "";
          const t = transports[sid];
          if (!t) {
            res.writeHead(404);
            res.end("no session");
            return;
          }
          await t.handlePostMessage(req, res);
        } else {
          res.writeHead(404);
          res.end("not found");
        }
      })();
    });
    await new Promise<void>((resolve) => sseServer.listen(0, "127.0.0.1", () => resolve()));
    const addr = sseServer.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    sseUrl = `http://127.0.0.1:${port}/sse`;
  });

  afterEach(async () => {
    if (sseTarget) {
      await sseTarget.close();
      sseTarget = null;
    }
    await new Promise<void>((resolve) => sseServer.close(() => resolve()));
  });

  it("falls back to SSE when Streamable HTTP fails in auto mode", async () => {
    sseTarget = new TargetManager(sseUrl, [], { transport: "auto" });
    await sseTarget.connect();

    expect(sseTarget.connected).toBe(true);
    const { tools } = await sseTarget.listTools();
    expect(tools.map((t) => t.name)).toContain("echo");
  }, 15_000);
});
