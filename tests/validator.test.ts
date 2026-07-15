import { describe, expect, it } from "vitest";
import { validateProtocol } from "../src/validator.js";
import { MOCK_SERVER_ARGS, MOCK_SERVER_CMD } from "./helpers.js";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Protocol Validator", () => {
  it("passes validation on a compliant server (mock-server)", async () => {
    const report = await validateProtocol(MOCK_SERVER_CMD, MOCK_SERVER_ARGS);
    console.log("MOCK REPORT:", JSON.stringify(report, null, 2));

    expect(report.success).toBe(true);
    expect(report.status).toBe("PASS");

    const handshake = report.checks.find((c) => c.name === "handshake_connection");
    expect(handshake?.status).toBe("PASS");

    const tools = report.checks.find((c) => c.name === "tools_capability");
    expect(tools?.status).toBe("PASS");
    expect(tools?.message).toContain("valid tool(s)");

    // json_data declares structured output — the static audit should pass it.
    const outputSchemas = report.checks.find((c) => c.name === "tool_output_schema_validation");
    expect(outputSchemas?.status).toBe("PASS");
    expect(outputSchemas?.message).toContain("declare structured output");
  }, 15_000);

  it("flags broken outputSchemas (invalid schema, required prop not in properties)", async () => {
    const scriptPath = join(tmpdir(), `bad-output-schema-server-${Date.now()}.mjs`);
    const code = `
      import readline from "readline";
      const rl = readline.createInterface({ input: process.stdin, terminal: false });
      rl.on("line", (line) => {
        const req = JSON.parse(line);
        if (req.method === "initialize") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id: req.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "bad-output-schema", version: "1.0.0" }
            }
          }) + "\\n");
        } else if (req.method === "tools/list") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id: req.id,
            result: {
              tools: [
                {
                  name: "broken_schema",
                  description: "outputSchema is not valid JSON Schema",
                  inputSchema: { type: "object", properties: {} },
                  outputSchema: { type: "object", properties: { a: { type: "bananas" } } }
                },
                {
                  name: "missing_required",
                  description: "outputSchema requires a property it never defines",
                  inputSchema: { type: "object", properties: {} },
                  outputSchema: { type: "object", properties: { a: { type: "string" } }, required: ["a", "ghost"] }
                }
              ]
            }
          }) + "\\n");
        }
      });
    `;
    writeFileSync(scriptPath, code, "utf8");

    try {
      const report = await validateProtocol("node", [scriptPath]);
      expect(report.success).toBe(false);

      const outputChecks = report.checks.filter(
        (c) => c.name === "tool_output_schema_validation" && c.status === "FAIL",
      );
      expect(
        outputChecks.some((c) => c.message?.includes('"broken_schema" outputSchema is not a valid')),
      ).toBe(true);
      expect(
        outputChecks.some(
          (c) => c.message?.includes('"missing_required"') && c.message?.includes('"ghost"'),
        ),
      ).toBe(true);
    } finally {
      rmSync(scriptPath, { force: true });
    }
  }, 15_000);

  it("fails validation gracefully for a non-existent command", async () => {
    const report = await validateProtocol("nonexistent-command-xyz", []);

    expect(report.success).toBe(false);
    expect(report.status).toBe("FAIL");

    const handshake = report.checks.find((c) => c.name === "handshake_connection");
    expect(handshake?.status).toBe("FAIL");
    expect(handshake?.message).toContain("Failed to connect");
  }, 10_000);

  it("detects schema violations on a non-compliant server", async () => {
    // Write an ephemeral non-compliant server script to disk
    const scriptPath = join(tmpdir(), `invalid-server-${Date.now()}.mjs`);
    const code = `
      import readline from "readline";

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false
      });

      process.stderr.write("INVALID SERVER STARTED\\n");

      rl.on("line", (line) => {
        process.stderr.write("LINE RECEIVED: " + line + "\\n");
        try {
          const req = JSON.parse(line);
          process.stderr.write("PARSED REQ: " + req.method + " ID: " + req.id + "\\n");
          if (req.method === "initialize") {
            const resp = JSON.stringify({
              jsonrpc: "2.0",
              id: req.id,
              result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} }, // Advertises tools
                serverInfo: { name: "invalid-server", version: "1.0.0" }
              }
            });
            process.stderr.write("WRITING INITIALIZE RESP: " + resp + "\\n");
            process.stdout.write(resp + "\\n");
          } else if (req.method === "notifications/initialized") {
            process.stderr.write("INITIALIZED NOTIFICATION RECEIVED\\n");
          } else if (req.method === "tools/list") {
            const resp = JSON.stringify({
              jsonrpc: "2.0",
              id: req.id,
              result: {
                notTools: []
              }
            });
            process.stderr.write("WRITING TOOLS RESP: " + resp + "\\n");
            process.stdout.write(resp + "\\n");
          }
        } catch (err) {
          process.stderr.write("ERROR PARSING: " + err.message + "\\n");
        }
      });
    `;

    writeFileSync(scriptPath, code, "utf8");

    try {
      const report = await validateProtocol("node", [scriptPath]);
      expect(report.success).toBe(false);
      expect(report.status).toBe("FAIL");

      const toolsCheck = report.checks.find((c) => c.name === "tools_capability");
      expect(toolsCheck?.status).toBe("FAIL");
      expect(toolsCheck?.message).toContain("violated the schema");
    } finally {
      try {
        rmSync(scriptPath, { force: true });
      } catch {
        // ignore
      }
    }
  }, 15_000);
});
