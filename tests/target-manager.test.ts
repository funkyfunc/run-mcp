import { describe, it, expect, afterEach } from "vitest";
import { TargetManager } from "../src/target-manager.js";
import { resolve } from "node:path";

// Path to the compiled mock server
const MOCK_SERVER_PATH = resolve(import.meta.dirname, "fixtures/mock-server.js");

/**
 * Integration tests for TargetManager using the mock MCP server.
 *
 * These tests spawn a real child process and communicate over stdio,
 * validating the full MCP Client lifecycle.
 */

let target: TargetManager | null = null;

afterEach(async () => {
  if (target) {
    await target.close();
    target = null;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Connection lifecycle
// ═══════════════════════════════════════════════════════════════════════════

describe("connection lifecycle", () => {
  it("connects to a target MCP server", async () => {
    target = new TargetManager("node", [MOCK_SERVER_PATH]);
    await target.connect();

    expect(target.connected).toBe(true);
  }, 10_000);

  it("reports status after connecting", async () => {
    target = new TargetManager("node", [MOCK_SERVER_PATH]);
    await target.connect();

    const status = target.getStatus();
    expect(status.connected).toBe(true);
    expect(status.command).toBe("node");
    expect(status.args).toEqual([MOCK_SERVER_PATH]);
    expect(status.uptime).toBeGreaterThanOrEqual(0);
  }, 10_000);

  it("emits stderr from the child process", async () => {
    target = new TargetManager("node", [MOCK_SERVER_PATH]);

    const stderrLines: string[] = [];
    target.on("stderr", (text: string) => stderrLines.push(text));

    await target.connect();

    // The mock server writes to stderr on startup
    // Give it a moment to flush
    await new Promise((r) => setTimeout(r, 200));
    expect(stderrLines.some((l) => l.includes("Mock MCP server"))).toBe(true);
  }, 10_000);

  it("disconnects cleanly", async () => {
    target = new TargetManager("node", [MOCK_SERVER_PATH]);
    await target.connect();
    expect(target.connected).toBe(true);

    await target.close();
    expect(target.connected).toBe(false);

    const status = target.getStatus();
    expect(status.connected).toBe(false);
    expect(status.pid).toBeNull();
    target = null; // prevent double-close in afterEach
  }, 10_000);

  it("throws when calling listTools before connect", async () => {
    target = new TargetManager("node", [MOCK_SERVER_PATH]);

    await expect(target.listTools()).rejects.toThrow("Not connected");
  });

  it("throws when calling callTool before connect", async () => {
    target = new TargetManager("node", [MOCK_SERVER_PATH]);

    await expect(target.callTool("echo", { text: "hi" })).rejects.toThrow(
      "Not connected",
    );
  });

  it("fails to connect with an invalid command", async () => {
    target = new TargetManager("nonexistent-command-xyz", []);

    await expect(target.connect()).rejects.toThrow();
    target = null;
  }, 10_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// Tool listing
// ═══════════════════════════════════════════════════════════════════════════

describe("listTools", () => {
  it("lists all tools from the mock server", async () => {
    target = new TargetManager("node", [MOCK_SERVER_PATH]);
    await target.connect();

    const result = await target.listTools();
    const names = result.tools.map((t) => t.name);

    expect(names).toContain("echo");
    expect(names).toContain("greet");
    expect(names).toContain("slow");
    expect(names).toContain("screenshot");
    expect(names).toContain("big_response");
    expect(names).toContain("multi_content");
  }, 10_000);

  it("returns tool descriptions", async () => {
    target = new TargetManager("node", [MOCK_SERVER_PATH]);
    await target.connect();

    const result = await target.listTools();
    const echo = result.tools.find((t) => t.name === "echo");

    expect(echo).toBeDefined();
    expect(echo!.description).toBe("Echoes back the provided text");
  }, 10_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// Tool calling
// ═══════════════════════════════════════════════════════════════════════════

describe("callTool", () => {
  it("calls echo and gets the text back", async () => {
    target = new TargetManager("node", [MOCK_SERVER_PATH]);
    await target.connect();

    const result = await target.callTool("echo", { text: "hello from test" });
    const content = (result as any).content;

    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({ type: "text", text: "hello from test" });
  }, 10_000);

  it("calls greet with a name", async () => {
    target = new TargetManager("node", [MOCK_SERVER_PATH]);
    await target.connect();

    const result = await target.callTool("greet", { name: "Vitest" });
    const content = (result as any).content;

    expect(content[0].text).toBe("Hello, Vitest!");
  }, 10_000);

  it("calls screenshot and gets an image response", async () => {
    target = new TargetManager("node", [MOCK_SERVER_PATH]);
    await target.connect();

    const result = await target.callTool("screenshot", {});
    const content = (result as any).content;

    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("image");
    expect(content[0].data).toBeTruthy();
    expect(content[0].mimeType).toBe("image/png");
  }, 10_000);

  it("calls multi_content and gets multiple items", async () => {
    target = new TargetManager("node", [MOCK_SERVER_PATH]);
    await target.connect();

    const result = await target.callTool("multi_content", {});
    const content = (result as any).content;

    expect(content).toHaveLength(2);
    expect(content[0].text).toBe("First item");
    expect(content[1].text).toBe("Second item");
  }, 10_000);
});
