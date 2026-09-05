#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  inputRequired,
  inputResponse,
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/server";
import { z } from "zod";

/**
 * Served through `serveStdio`, so one factory answers both protocol eras: a
 * client that opens with `initialize` gets a 2025-era instance, a client that
 * probes with `server/discover` gets a 2026-07-28 one. `MOCK_LEGACY=reject`
 * makes it modern-only (to test run-mcp's coaching when a server refuses the
 * legacy handshake).
 *
 * The client-input tools (`request_sampling`, `request_elicitation`,
 * `what_roots`) are written once in the `inputRequired` style: on the modern
 * era the client fulfils the embedded request and retries; on the legacy era
 * the SDK's shim issues the equivalent server→client request.
 */
function buildServer(): McpServer {
  const server = new McpServer(
    { name: "mock-mcp-server", version: "1.0.0" },
    // Declared explicitly so the resource-subscription path is exercisable.
    { capabilities: { resources: { subscribe: true, listChanged: true }, logging: {} } },
  );

  // The SDK requires a subscribe handler once the capability is declared.
  server.server.setRequestHandler("resources/subscribe", async () => ({}));
  server.server.setRequestHandler("resources/unsubscribe", async () => ({}));

  // ─── Tool: echo ────────────────────────────────────────────────────────────

  server.registerTool(
    "echo",
    {
      description: "Echoes back the provided text",
      inputSchema: z.object({ text: z.string().describe("Text to echo back") }),
    },
    async ({ text }) => ({
      content: [{ type: "text", text }],
    }),
  );

  // ─── Tool: log_stderr (writes a line to stderr, then answers) ─────────────

  server.registerTool(
    "log_stderr",
    {
      description: "Writes the given line to the server's stderr and echoes it back",
      inputSchema: z.object({ line: z.string().describe("Line to write to stderr") }),
    },
    async ({ line }) => {
      process.stderr.write(`${line}\n`);
      return { content: [{ type: "text", text: `logged: ${line}` }] };
    },
  );

  // ─── Tool: greet (with annotations) ───────────────────────────────────────

  server.registerTool(
    "greet",
    {
      title: "Greeting Tool",
      description: "Returns a greeting",
      inputSchema: z.object({ name: z.string().describe("Name to greet") }),
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
      inputSchema: z.object({ ms: z.number().describe("Milliseconds to wait") }),
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
      inputSchema: z.object({ size: z.number().describe("Size of the response in characters") }),
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

  server.registerResource(
    "readme",
    "docs://readme",
    { description: "README file" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          text: "# Mock Server\n\nThis is a test resource.",
          mimeType: "text/markdown",
        },
      ],
    }),
  );

  // ─── Resource: docs://config ───────────────────────────────────────────────

  server.registerResource(
    "config",
    "docs://config",
    { description: "Config file" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          text: '{"debug": true, "timeout": 5000}',
          mimeType: "application/json",
        },
      ],
    }),
  );

  // ─── Resource Template: docs://pages/{page} ────────────────────────────────

  server.registerResource(
    "page",
    new ResourceTemplate("docs://pages/{page}", { list: undefined }),
    { description: "Dynamic pages" },
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

  server.registerPrompt(
    "greeting",
    {
      description: "Warm greeting",
      argsSchema: z.object({ name: z.string() }),
    },
    ({ name }) => ({
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: `Please greet ${name} warmly.` },
        },
      ],
    }),
  );

  // ─── Tool: json_data (pretty-printed JSON with a declared outputSchema) ────────

  server.registerTool(
    "json_data",
    {
      description: "Returns a pretty-printed JSON object (for output-compression testing)",
      // Declares structured output so tests exercise the outputSchema path
      // (validator static checks + SDK client-side conformance validation).
      outputSchema: z.object({
        status: z.string(),
        items: z.array(z.number()),
        nested: z.object({ a: z.boolean(), b: z.string() }),
      }),
    },
    async () => {
      const data = { status: "ok", items: [1, 2, 3], nested: { a: true, b: "value" } };
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        structuredContent: data,
      };
    },
  );

  // ─── Tool: env_echo (reports an environment variable as the server sees it) ─

  server.registerTool(
    "env_echo",
    {
      description: "Returns the value of an environment variable in the server process",
      inputSchema: z.object({ name: z.string().describe("Variable name") }),
    },
    async ({ name }) => ({
      content: [{ type: "text", text: process.env[name] ?? "<unset>" }],
    }),
  );

  // ─── Tool: request_sampling (server → client sampling round-trip) ──────────

  server.registerTool(
    "request_sampling",
    {
      description: "Asks the client to sample an LLM completion (tests sampling forwarding)",
      inputSchema: z.object({ prompt: z.string().describe("Prompt to sample") }),
    },
    async ({ prompt }, ctx) => {
      const view = inputResponse(ctx.mcpReq.inputResponses, "sample");
      if (view.kind !== "sampling") {
        return inputRequired({
          inputRequests: {
            sample: inputRequired.createMessage({
              messages: [{ role: "user", content: { type: "text", text: prompt } }],
              maxTokens: 100,
            }),
          },
        });
      }
      const content = view.result.content as any;
      const text = content?.text ?? JSON.stringify(content ?? view.result);
      return { content: [{ type: "text", text: `sampled: ${text}` }] };
    },
  );

  // ─── Tool: request_elicitation (server → client elicitation round-trip) ────

  server.registerTool(
    "request_elicitation",
    {
      description: "Asks the client to elicit input (tests elicitation forwarding)",
    },
    async (ctx) => {
      const view = inputResponse(ctx.mcpReq.inputResponses, "name");
      if (view.kind === "missing") {
        return inputRequired({
          inputRequests: {
            name: inputRequired.elicit({
              message: "Please provide your name",
              requestedSchema: {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"],
              },
            }),
          },
        });
      }
      // Report exactly what the client answered, whatever the action was.
      const result = view.kind === "elicit" ? { action: view.action, content: view.content } : view;
      return { content: [{ type: "text", text: `elicited: ${JSON.stringify(result)}` }] };
    },
  );

  // ─── Tool: what_roots (reports the roots the CLIENT advertises) ────────────

  server.registerTool(
    "what_roots",
    {
      description: "Asks the connected client for its roots and reports what came back",
    },
    async (ctx) => {
      const view = inputResponse(ctx.mcpReq.inputResponses, "roots");
      if (view.kind !== "roots") {
        return inputRequired({ inputRequests: { roots: inputRequired.listRoots() } });
      }
      return { content: [{ type: "text", text: JSON.stringify(view.roots ?? []) }] };
    },
  );

  // ─── Tool: touch_resource (emits notifications/resources/updated) ──────────

  server.registerTool(
    "touch_resource",
    {
      description: "Emits a resources/updated notification for a URI, to test subscriptions",
      inputSchema: z.object({ uri: z.string().describe("Resource URI to mark as updated") }),
    },
    async ({ uri }) => {
      await server.server.sendResourceUpdated({ uri });
      return { content: [{ type: "text", text: `notified update for ${uri}` }] };
    },
  );

  return server;
}

// ─── Start ─────────────────────────────────────────────────────────────────

process.stderr.write("Mock MCP server running on stdio\n");

serveStdio(buildServer, {
  legacy: process.env.MOCK_LEGACY === "reject" ? "reject" : "serve",
});
