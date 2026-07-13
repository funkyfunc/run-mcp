/**
 * A backend that can be crashed on demand: `die` schedules a process exit
 * shortly after responding. Used to test dead-backend handling (honest
 * "backend down" errors, list_servers status) in the multiplexing proxy.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "crashy-server", version: "1.0.0" });

server.registerTool(
  "echo",
  {
    description: "Returns the input text unchanged",
    inputSchema: { text: z.string().describe("Text to echo") },
  },
  async ({ text }) => ({ content: [{ type: "text" as const, text }] }),
);

server.registerTool(
  "die",
  { description: "Crashes this server shortly after responding" },
  async () => {
    setTimeout(() => process.exit(1), 100);
    return { content: [{ type: "text" as const, text: "dying" }] };
  },
);

await server.connect(new StdioServerTransport());
