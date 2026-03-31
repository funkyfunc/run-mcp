import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TargetManager } from "../src/target-manager.js";

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

    await expect(target.callTool("echo", { text: "hi" })).rejects.toThrow("Not connected");
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

// ═══════════════════════════════════════════════════════════════════════════
// Enhanced status fields
// ═══════════════════════════════════════════════════════════════════════════

describe("enhanced status", () => {
  it("tracks lastResponseTime after listTools", async () => {
    target = new TargetManager("node", [MOCK_SERVER_PATH]);
    await target.connect();

    const beforeCall = target.getStatus();
    expect(beforeCall.lastResponseTime).toBeNull();

    await target.listTools();

    const afterCall = target.getStatus();
    expect(afterCall.lastResponseTime).not.toBeNull();
    expect(afterCall.lastResponseTime!).toBeGreaterThan(0);
  }, 10_000);

  it("tracks lastResponseTime after callTool", async () => {
    target = new TargetManager("node", [MOCK_SERVER_PATH]);
    await target.connect();

    await target.callTool("echo", { text: "ping" });

    const status = target.getStatus();
    expect(status.lastResponseTime).not.toBeNull();
  }, 10_000);

  it("counts stderr lines", async () => {
    target = new TargetManager("node", [MOCK_SERVER_PATH]);
    await target.connect();

    // Give stderr time to arrive
    await new Promise((r) => setTimeout(r, 200));

    const status = target.getStatus();
    expect(status.stderrLineCount).toBeGreaterThan(0);
  }, 10_000);

  it("reports reconnect attempts and max", async () => {
    target = new TargetManager("node", [MOCK_SERVER_PATH]);
    await target.connect();

    const status = target.getStatus();
    expect(status.reconnectAttempts).toBe(0);
    expect(status.maxReconnectAttempts).toBe(3);
  }, 10_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// Auto-reconnect behavior
// ═══════════════════════════════════════════════════════════════════════════

describe("auto-reconnect", () => {
  it("does NOT reconnect when auto-reconnect is disabled (default)", async () => {
    target = new TargetManager("node", [MOCK_SERVER_PATH]);
    await target.connect();

    const events: string[] = [];
    target.on("reconnecting", () => events.push("reconnecting"));
    target.on("reconnect_failed", () => events.push("reconnect_failed"));

    // Close intentionally — should not trigger reconnect
    await target.close();

    await new Promise((r) => setTimeout(r, 200));
    expect(events).toEqual([]);
    target = null;
  }, 10_000);

  it("does NOT reconnect a startup crash (uptime < 5s)", async () => {
    // Use an invalid server that will crash immediately
    target = new TargetManager("node", ["-e", "process.exit(1)"]);
    target.enableAutoReconnect();

    const events: { reason?: string; message?: string }[] = [];
    target.on("reconnect_failed", (e: any) => events.push(e));

    // This will fail to connect since the process exits immediately
    await expect(target.connect()).rejects.toThrow();
    target = null;

    // Even with auto-reconnect enabled, it should NOT retry
    // because the process didn't survive the initial connect
    // (connect itself throws, so _maybeReconnect never fires)
    expect(events).toEqual([]);
  }, 10_000);
});
