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
