#!/usr/bin/env node

/**
 * A minimal second MCP server, used as the non-mock backend in the
 * multiplexing-proxy tests so routing across two distinct fleets is exercised.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "second-server", version: "1.0.0" });

server.registerTool(
  "lookup",
  {
    description: "Look up a record by id.",
    inputSchema: { id: z.string().describe("Record id") },
  },
  async ({ id }) => ({ content: [{ type: "text", text: `record ${id}` }] }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
