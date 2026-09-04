import { afterEach, describe, expect, it } from "vitest";
import { TargetManager } from "../src/target-manager.js";
import { MOCK_SERVER_ARGS, MOCK_SERVER_CMD, waitFor } from "./helpers.js";

process.env.TSX_DISABLE_CACHE = "1";

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
    target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS);
    await target.connect();

    expect(target.connected).toBe(true);
  }, 10_000);

  it("does not leak the target env onto the parent process.env", async () => {
    const key = "RUN_MCP_ENV_LEAK_CANARY";
    delete process.env[key];

    target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS, {
      env: { [key]: "secret-value" },
    });
    await target.connect();

    // The custom env is threaded into the child, never written to the parent —
    // critical for the long-lived agent server where one target's secrets must
    // not bleed into the next.
    expect(process.env[key]).toBeUndefined();
  }, 10_000);

  it("threads the caller's env into the child while inheriting almost nothing else", async () => {
    const key = "RUN_MCP_ENV_REACHES_CHILD";
    process.env[key] = "from-parent";
    try {
      target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS, { env: { [key]: "explicit" } });
      await target.connect();
      const explicit = await target.callTool("env_echo", { name: key });
      expect((explicit.content as any[])[0].text).toBe("explicit");
      await target.close();

      // Same variable, no explicit env: the parent's value does not leak through.
      target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS);
      await target.connect();
      const inherited = await target.callTool("env_echo", { name: key });
      expect((inherited.content as any[])[0].text).toBe("<unset>");
    } finally {
      delete process.env[key];
    }
  }, 15_000);

  it("reports status after connecting", async () => {
    target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS);
    await target.connect();

    const status = target.getStatus();
    expect(status.connected).toBe(true);
    expect(status.command).toBe(MOCK_SERVER_CMD);
    expect(status.args).toEqual(MOCK_SERVER_ARGS);
    expect(status.uptime).toBeGreaterThanOrEqual(0);
  }, 10_000);

  it("emits stderr from the child process", async () => {
    target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS);

    const stderrLines: string[] = [];
    target.on("stderr", (text: string) => stderrLines.push(text));

    await target.connect();

    // The mock server writes to stderr on startup
    // Give it a moment to flush
    await new Promise((r) => setTimeout(r, 200));
    expect(stderrLines.some((l) => l.includes("Mock MCP server"))).toBe(true);
  }, 10_000);

  it("disconnects cleanly", async () => {
    target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS);
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
    target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS);

    await expect(target.listTools()).rejects.toThrow("Not connected");
  });

  it("throws when calling callTool before connect", async () => {
    target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS);

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
    target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS);
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
    target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS);
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
    target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS);
    await target.connect();

    const result = await target.callTool("echo", { text: "hello from test" });
    const content = (result as any).content;

    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({ type: "text", text: "hello from test" });
  }, 10_000);

  it("calls greet with a name", async () => {
    target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS);
    await target.connect();

    const result = await target.callTool("greet", { name: "Vitest" });
    const content = (result as any).content;

    expect(content[0].text).toBe("Hello, Vitest!");
  }, 10_000);

  it("calls screenshot and gets an image response", async () => {
    target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS);
    await target.connect();

    const result = await target.callTool("screenshot", {});
    const content = (result as any).content;

    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("image");
    expect(content[0].data).toBeTruthy();
    expect(content[0].mimeType).toBe("image/png");
  }, 10_000);

  it("calls multi_content and gets multiple items", async () => {
    target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS);
    await target.connect();

    const result = await target.callTool("multi_content", {});
    const content = (result as any).content;

    expect(content).toHaveLength(2);
    expect(content[0].text).toBe("First item");
    expect(content[1].text).toBe("Second item");
  }, 10_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// Additional MCP client-role surface
// ═══════════════════════════════════════════════════════════════════════════

describe("MCP client-role methods", () => {
  it("ping returns a round-trip time", async () => {
    target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS);
    await target.connect();
    const rtt = await target.ping();
    expect(rtt).toBeGreaterThanOrEqual(0);
  }, 10_000);

  it("lists resource templates", async () => {
    target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS);
    await target.connect();
    const { resourceTemplates } = await target.listResourceTemplates();
    expect(resourceTemplates.map((t: any) => t.uriTemplate)).toContain("docs://pages/{page}");
  }, 10_000);

  it("gets a prompt with arguments", async () => {
    target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS);
    await target.connect();
    const result = await target.getPrompt({ name: "greeting", arguments: { name: "Ada" } });
    expect(JSON.stringify(result.messages)).toContain("Ada");
  }, 10_000);

  it("tracks and clears request history", async () => {
    target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS);
    await target.connect();
    await target.listTools();
    await target.callTool("echo", { text: "hi" });
    expect(target.getHistory().length).toBeGreaterThanOrEqual(2);
    expect(target.getHistory(1)).toHaveLength(1);
    target.clearHistory();
    expect(target.getHistory()).toHaveLength(0);
  }, 10_000);

  it("manages roots (add, list, remove) without error", async () => {
    target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS);
    await target.connect();
    await target.addRoot({ uri: "file:///tmp/x", name: "x" });
    expect(target.getRoots().map((r) => r.uri)).toContain("file:///tmp/x");
    // Adding a duplicate is a no-op.
    await target.addRoot({ uri: "file:///tmp/x" });
    expect(target.getRoots()).toHaveLength(1);
    const removed = await target.removeRoot("file:///tmp/x");
    expect(removed).toBe(true);
    expect(target.getRoots()).toHaveLength(0);
  }, 10_000);
});

describe("sampling & elicitation forwarding", () => {
  it("emits a sampling_request event and returns the responder's result", async () => {
    target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS);
    await target.connect();

    target.on("sampling_request", ({ respond }: any) => {
      respond({
        model: "test-model",
        role: "assistant",
        content: { type: "text", text: "sampled reply" },
      });
    });

    const res: any = await target.callTool("request_sampling", { prompt: "hello" });
    expect(res.content[0].text).toContain("sampled reply");
  }, 10_000);

  it("emits an elicitation_request event and returns the responder's content", async () => {
    target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS);
    await target.connect();

    target.on("elicitation_request", ({ respond }: any) => {
      respond({ action: "accept", content: { name: "Ada" } });
    });

    const res: any = await target.callTool("request_elicitation", {});
    expect(res.content[0].text).toContain("Ada");
  }, 10_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// Enhanced status fields
// ═══════════════════════════════════════════════════════════════════════════

describe("enhanced status", () => {
  it("tracks lastResponseTime after listTools", async () => {
    target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS);
    await target.connect();

    const beforeCall = target.getStatus();
    expect(beforeCall.lastResponseTime).toBeNull();

    await target.listTools();

    const afterCall = target.getStatus();
    expect(afterCall.lastResponseTime).not.toBeNull();
    expect(afterCall.lastResponseTime!).toBeGreaterThan(0);
  }, 10_000);

  it("tracks lastResponseTime after callTool", async () => {
    target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS);
    await target.connect();

    await target.callTool("echo", { text: "ping" });

    const status = target.getStatus();
    expect(status.lastResponseTime).not.toBeNull();
  }, 10_000);

  it("counts stderr lines", async () => {
    target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS);
    await target.connect();

    // Give stderr time to arrive
    await new Promise((r) => setTimeout(r, 200));

    const status = target.getStatus();
    expect(status.stderrLineCount).toBeGreaterThan(0);
  }, 10_000);

  it("reports reconnect attempts and max", async () => {
    target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS);
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
    target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS);
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

  it("reconnects after a stable-uptime crash and serves calls again (success path)", async () => {
    target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS);
    target.enableAutoReconnect();

    const events: string[] = [];
    target.on("reconnecting", () => events.push("reconnecting"));
    target.on("reconnected", () => events.push("reconnected"));
    target.on("reconnect_failed", () => events.push("reconnect_failed"));

    await target.connect();
    const firstPid = target.getStatus().pid!;

    // Survive past the 5s min-uptime guard so the crash counts as transient
    // (not a startup bug) and qualifies for a reconnect attempt.
    await new Promise((resolve) => setTimeout(resolve, 5_200));
    process.kill(firstPid, "SIGKILL");

    await waitFor(() => events.includes("reconnected"), 15_000, "reconnected event");
    expect(events[0]).toBe("reconnecting");
    expect(events).not.toContain("reconnect_failed");

    const status = target.getStatus();
    expect(status.connected).toBe(true);
    expect(status.pid).not.toBe(firstPid);
    expect(status.reconnectAttempts).toBe(1);

    // The revived connection actually serves requests.
    const res = await target.callTool("echo", { text: "back from the dead" });
    expect((res as any).content[0].text).toBe("back from the dead");
  }, 30_000);
});
