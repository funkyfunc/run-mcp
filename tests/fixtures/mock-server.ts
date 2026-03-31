#!/usr/bin/env node

/**
 * Mock MCP server for testing.
 *
 * Exposes a small set of tools with predictable behavior:
 *  - echo: returns whatever text you send
 *  - greet: returns a greeting with the given name
 *  - slow: waits for N ms before responding (for timeout testing)
 *  - screenshot: returns a fake base64 image (for interception testing)
 *  - big_response: returns a massive text payload (for truncation testing)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "mock-mcp-server",
  version: "1.0.0",
});

// ─── Tool: echo ────────────────────────────────────────────────────────────

server.tool(
  "echo",
  "Echoes back the provided text",
  { text: z.string().describe("Text to echo back") },
  async ({ text }) => ({
    content: [{ type: "text", text }],
  }),
);

// ─── Tool: greet ───────────────────────────────────────────────────────────

server.tool(
  "greet",
  "Returns a greeting",
  { name: z.string().describe("Name to greet") },
  async ({ name }) => ({
    content: [{ type: "text", text: `Hello, ${name}!` }],
  }),
);

// ─── Tool: slow ────────────────────────────────────────────────────────────

server.tool(
  "slow",
  "Waits for the specified duration before responding",
  { ms: z.number().describe("Milliseconds to wait") },
  async ({ ms }) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return {
      content: [{ type: "text", text: `Waited ${ms}ms` }],
    };
  },
);

// ─── Tool: screenshot ──────────────────────────────────────────────────────

server.tool(
  "screenshot",
  "Returns a fake base64 PNG image",
  {},
  async () => {
    // Create a minimal 1x1 pixel PNG (base64 encoded)
    // This is a real, valid PNG — 67 bytes
    const TINY_PNG_B64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    return {
      content: [
        {
          type: "image" as const,
          data: TINY_PNG_B64,
          mimeType: "image/png",
        },
      ],
    };
  },
);

// ─── Tool: big_base64 ──────────────────────────────────────────────────────

server.tool(
  "big_base64",
  "Returns a large base64 blob as text (for heuristic detection testing)",
  {},
  async () => {
    // Generate a large base64 string (> 1000 chars)
    const bigBuffer = Buffer.alloc(2000, 0x42); // 2000 bytes of 'B'
    const b64 = bigBuffer.toString("base64");
    return {
      content: [{ type: "text", text: b64 }],
    };
  },
);

// ─── Tool: big_response ────────────────────────────────────────────────────

server.tool(
  "big_response",
  "Returns a very large text response for truncation testing",
  { size: z.number().describe("Size of the response in characters") },
  async ({ size }) => {
    // Use text with spaces/punctuation so it doesn't trigger base64 heuristic
    const filler = "The quick brown fox jumped. ";
    const repeated = filler.repeat(Math.ceil(size / filler.length));
    return {
      content: [{ type: "text", text: repeated.slice(0, size) }],
    };
  },
);

// ─── Tool: multi_content ───────────────────────────────────────────────────

server.tool(
  "multi_content",
  "Returns multiple content items of different types",
  {},
  async () => ({
    content: [
      { type: "text", text: "First item" },
      { type: "text", text: "Second item" },
    ],
  }),
);

// ─── Start ─────────────────────────────────────────────────────────────────

process.stderr.write("Mock MCP server running on stdio\n");

const transport = new StdioServerTransport();
await server.connect(transport);
