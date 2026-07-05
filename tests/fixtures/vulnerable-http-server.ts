#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-deprecated, @typescript-eslint/no-unused-vars */

/**
 * Vulnerable HTTP/SSE MCP Server for testing sandboxing capabilities.
 * Exposes the same risky tools as vulnerable-stdio-server over HTTP/SSE.
 * Listening on port 3001.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createServer } from "node:http";
import { parse } from "node:url";
import http from "node:http";
import https from "node:https";

const getServer = () => {
  const server = new McpServer({
    name: "vulnerable-http-server",
    version: "1.0.0",
  });

  // Tool 1: Risky File Read
  server.registerTool(
    "exploit_file_read",
    {
      description: "Read a file from the host filesystem",
      inputSchema: {
        path: z.string().describe("The absolute path of the file to read"),
      },
    },
    async ({ path }) => {
      try {
        const data = readFileSync(path, "utf8");
        return {
          content: [{ type: "text", text: `SUCCESS:\n${data}` }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `FAILED: [${err.code}] ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // Tool 2: Risky File Write
  server.registerTool(
    "exploit_file_write",
    {
      description: "Write a file to the host filesystem",
      inputSchema: {
        path: z.string().describe("The path of the file to write"),
        content: z.string().describe("The content to write into the file"),
      },
    },
    async ({ path, content }) => {
      try {
        writeFileSync(path, content, "utf8");
        return {
          content: [{ type: "text", text: `SUCCESS: Wrote content to ${path}` }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `FAILED: [${err.code}] ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // Tool 3: Risky Network Request
  server.registerTool(
    "exploit_network",
    {
      description: "Make an outbound network request",
      inputSchema: {
        url: z.string().describe("The URL to fetch"),
      },
    },
    async ({ url }) => {
      return new Promise((resolve) => {
        const client = url.startsWith("https") ? https : http;
        const req = client.get(url, (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => {
            resolve({
              content: [
                {
                  type: "text",
                  text: `SUCCESS: Status Code ${res.statusCode}\nBody:\n${body.slice(0, 500)}`,
                },
              ],
            });
          });
        });

        req.on("error", (err: any) => {
          resolve({
            content: [{ type: "text", text: `FAILED: [${err.code}] ${err.message}` }],
            isError: true,
          });
        });

        req.setTimeout(3000, () => {
          req.destroy();
          resolve({
            content: [{ type: "text", text: "FAILED: Request timeout (3000ms)" }],
            isError: true,
          });
        });
      });
    },
  );

  // Tool 4: Shell Execution
  server.registerTool(
    "exploit_spawn",
    {
      description: "Spawn a shell command on the host",
      inputSchema: {
        command: z.string().describe("The shell command to execute"),
      },
    },
    async ({ command }) => {
      try {
        const output = execSync(command, { encoding: "utf8" });
        return {
          content: [{ type: "text", text: `SUCCESS:\n${output}` }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `FAILED: ${err.message}\nStderr: ${err.stderr || ""}` }],
          isError: true,
        };
      }
    },
  );

  return server;
};

const transports: Record<string, SSEServerTransport> = {};

const httpServer = createServer(async (req, res) => {
  const parsedUrl = parse(req.url || "", true);
  const pathname = parsedUrl.pathname;

  if (req.method === "GET" && pathname === "/mcp") {
    try {
      const transport = new SSEServerTransport("/messages", res);
      const sessionId = transport.sessionId;
      transports[sessionId] = transport;

      transport.onclose = () => {
        delete transports[sessionId];
      };

      const server = getServer();
      await server.connect(transport);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Error establishing SSE stream");
      }
    }
  } else if (req.method === "POST" && pathname === "/messages") {
    const sessionId = parsedUrl.query.sessionId as string;
    if (!sessionId || !transports[sessionId]) {
      res.writeHead(404);
      res.end("Session not found");
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });

    req.on("end", async () => {
      try {
        const json = JSON.parse(body);
        await transports[sessionId].handlePostMessage(req, res, json);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end("Error handling request");
        }
      }
    });
  } else {
    res.writeHead(404);
    res.end("Not Found");
  }
});

const PORT = 3001;
httpServer.listen(PORT, () => {
  console.log(`Vulnerable HTTP MCP Server listening on port ${PORT}`);
});

process.on("SIGINT", () => {
  console.log("Shutting down HTTP server...");
  httpServer.close(() => {
    process.exit(0);
  });
});
