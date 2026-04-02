#!/usr/bin/env node

/**
 * Mock MCP server for testing.
 *
 * Exposes a full set of MCP primitives with predictable behavior:
 *
 * Tools:
 *  - echo: returns whatever text you send
 *  - greet: returns a greeting with the given name (has annotations)
 *  - slow: waits for N ms before responding (for timeout testing)
 *  - screenshot: returns a fake base64 image (for interception testing)
 *  - big_base64: returns a large base64 text blob (heuristic detection testing)
 *  - big_response: returns a massive text payload (for truncation testing)
 *  - multi_content: returns multiple content items of different types
 *  - audio_tool: returns a fake base64 audio clip (for audio interception testing)
 *  - error_tool: returns isError: true (for error passthrough testing)
 *
 * Resources:
 *  - docs://readme: a text resource
 *  - docs://config: a text resource with annotations
 *
 * Prompts:
 *  - greeting: a simple prompt with a 'name' argument
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "mock-mcp-server",
  version: "1.0.0",
});

// ─── Tool: echo ────────────────────────────────────────────────────────────

server.registerTool(
  "echo",
  {
    description: "Echoes back the provided text",
    inputSchema: { text: z.string().describe("Text to echo back") },
  },
  async ({ text }) => ({
    content: [{ type: "text", text }],
  }),
);

// ─── Tool: greet (with annotations) ───────────────────────────────────────

server.registerTool(
  "greet",
  {
    title: "Greeting Tool",
    description: "Returns a greeting",
    inputSchema: { name: z.string().describe("Name to greet") },
    annotations: {
      title: "Greeting Tool",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ name }) => ({
    content: [{ type: "text", text: `Hello, ${name}!` }],
  }),
);

// ─── Tool: slow ────────────────────────────────────────────────────────────

server.registerTool(
  "slow",
  {
    description: "Waits for the specified duration before responding",
    inputSchema: { ms: z.number().describe("Milliseconds to wait") },
  },
  async ({ ms }) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return {
      content: [{ type: "text", text: `Waited ${ms}ms` }],
    };
  },
);

// ─── Tool: screenshot ──────────────────────────────────────────────────────

server.registerTool(
  "screenshot",
  {
    description: "Returns a fake base64 PNG image",
  },
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

server.registerTool(
  "big_base64",
  {
    description: "Returns a large base64 blob as text (for heuristic detection testing)",
  },
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

server.registerTool(
  "big_response",
  {
    description: "Returns a very large text response for truncation testing",
    inputSchema: { size: z.number().describe("Size of the response in characters") },
  },
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

server.registerTool(
  "multi_content",
  {
    description: "Returns multiple content items of different types",
  },
  async () => ({
    content: [
      { type: "text", text: "First item" },
      { type: "text", text: "Second item" },
    ],
  }),
);

// ─── Tool: audio_tool ──────────────────────────────────────────────────────

server.registerTool(
  "audio_tool",
  {
    description: "Returns a fake base64 audio clip for interception testing",
  },
  async () => {
    // Fake audio data — just enough to test the pipeline
    const fakeAudio = Buffer.alloc(100, 0x41).toString("base64");
    return {
      content: [
        {
          type: "audio" as const,
          data: fakeAudio,
          mimeType: "audio/wav",
        },
      ],
    };
  },
);

// ─── Tool: error_tool ──────────────────────────────────────────────────────

server.registerTool(
  "error_tool",
  {
    description: "Returns a result with isError: true (for error passthrough testing)",
  },
  async () => ({
    content: [{ type: "text", text: "Something went wrong in the tool" }],
    isError: true,
  }),
);

// ─── Resource: docs://readme ───────────────────────────────────────────────

server.resource("readme", "docs://readme", async (uri) => ({
  contents: [
    {
      uri: uri.href,
      text: "# Mock Server\n\nThis is a test resource.",
      mimeType: "text/markdown",
    },
  ],
}));

// ─── Resource: docs://config ───────────────────────────────────────────────

server.resource("config", "docs://config", async (uri) => ({
  contents: [
    {
      uri: uri.href,
      text: '{"debug": true, "timeout": 5000}',
      mimeType: "application/json",
    },
  ],
}));

// ─── Resource Template: docs://pages/{page} ────────────────────────────────

server.resource(
  "page",
  new ResourceTemplate("docs://pages/{page}", { list: undefined }),
  async (uri, { page }) => ({
    contents: [
      {
        uri: uri.href,
        text: `Page content for: ${page}`,
        mimeType: "text/plain",
      },
    ],
  }),
);

// ─── Prompt: greeting ──────────────────────────────────────────────────────

server.prompt("greeting", { name: z.string() }, ({ name }) => ({
  messages: [
    {
      role: "user" as const,
      content: { type: "text" as const, text: `Please greet ${name} warmly.` },
    },
  ],
}));

// ─── Start ─────────────────────────────────────────────────────────────────

process.stderr.write("Mock MCP server running on stdio\n");

const transport = new StdioServerTransport();
await server.connect(transport);
