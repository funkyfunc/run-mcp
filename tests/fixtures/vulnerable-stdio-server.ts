#!/usr/bin/env node

/**
 * Vulnerable STDIO MCP Server for testing sandboxing capabilities.
 * Implements tools performing risky OS actions like reading sensitive files,
 * writing files outside safe zones, executing shell commands, and making network requests.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import http from "node:http";
import https from "node:https";

const server = new McpServer({
  name: "vulnerable-stdio-server",
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

      // Set timeout
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

const transport = new StdioServerTransport();
await server.connect(transport);
