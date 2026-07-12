import { afterEach, describe, expect, it, vi } from "vitest";
import { TargetManager } from "../src/target-manager.js";
import { MOCK_SERVER_ARGS, MOCK_SERVER_CMD } from "./helpers.js";
import { SandboxPolicy } from "../src/settings.js";
import { join } from "node:path";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    execSync: (cmd: string, options?: any) => {
      if (typeof cmd === "string" && cmd.includes("bwrap")) {
        return Buffer.from("/usr/bin/bwrap");
      }
      return original.execSync(cmd, options);
    },
  };
});

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
});

// ═══════════════════════════════════════════════════════════════════════════
// Sandboxing
// ═══════════════════════════════════════════════════════════════════════════

describe("sandboxing", () => {
  it("runs the mock server without sandboxing and allows file write and network", async () => {
    target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS, { sandbox: "none" });
    await target.connect();

    const writeRes = await target.callTool("sandbox_write_test", {});
    expect((writeRes as any).content[0].text).toBe("success");

    const netRes = await target.callTool("sandbox_net_test", {});
    expect((netRes as any).content[0].text).toBe("success");
  }, 15_000);

  it("runs the mock server with native sandboxing and blocks write and network", async () => {
    let checkCmd = "";
    if (process.platform === "darwin") checkCmd = "sandbox-exec";
    else if (process.platform === "linux") checkCmd = "bwrap";

    // Skip if we can't test native sandboxing natively on this host
    if (checkCmd) {
      try {
        const checkCmdStr = `command -v ${checkCmd}`;
        const { execSync } = await import("node:child_process");
        execSync(checkCmdStr, { stdio: "ignore" });
      } catch {
        // Sandboxing tool not installed, skip test
        return;
      }
    } else {
      // Windows requires @microsoft/mxc-sdk, skip if not available
      try {
        const mxcModule = "@microsoft/mxc-sdk";
        await import(mxcModule);
      } catch {
        return;
      }
    }

    target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS, { sandbox: "native" });
    await target.connect();

    const writeRes = await target.callTool("sandbox_write_test", {});
    expect((writeRes as any).content[0].text).toContain("denied");

    const netRes = await target.callTool("sandbox_net_test", {});
    expect((netRes as any).content[0].text).toContain("denied");
  }, 20_000);

  it("runs the mock server with native sandboxing and whitelisted capabilities", async () => {
    let checkCmd = "";
    if (process.platform === "darwin") checkCmd = "sandbox-exec";
    else if (process.platform === "linux") checkCmd = "bwrap";

    // Skip if we can't test native sandboxing natively on this host
    if (checkCmd) {
      try {
        const checkCmdStr = `command -v ${checkCmd}`;
        const { execSync } = await import("node:child_process");
        execSync(checkCmdStr, { stdio: "ignore" });
      } catch {
        return;
      }
    } else {
      try {
        const mxcModule = "@microsoft/mxc-sdk";
        await import(mxcModule);
      } catch {
        return;
      }
    }

    // Spawn with cwd write whitelisted and example.com network whitelisted
    target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS, {
      sandbox: "native",
      allowWrite: [process.cwd()],
      allowNet: ["example.com"],
    });
    await target.connect();

    const writeRes = await target.callTool("sandbox_write_test", {});
    expect((writeRes as any).content[0].text).toBe("success");

    const netRes = await target.callTool("sandbox_net_test", {});
    expect((netRes as any).content[0].text).toBe("success");
  }, 20_000);

  it("runs the mock server with audit sandboxing and ignores whitelisted capability overrides", async () => {
    let checkCmd = "";
    if (process.platform === "darwin") checkCmd = "sandbox-exec";
    else if (process.platform === "linux") checkCmd = "bwrap";

    // Skip if we can't test native sandboxing natively on this host
    if (checkCmd) {
      try {
        const checkCmdStr = `command -v ${checkCmd}`;
        const { execSync } = await import("node:child_process");
        execSync(checkCmdStr, { stdio: "ignore" });
      } catch {
        return;
      }
    } else {
      try {
        const mxcModule = "@microsoft/mxc-sdk";
        await import(mxcModule);
      } catch {
        return;
      }
    }

    // Spawn with audit mode. Even with allowed exceptions, it should block everything!
    target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS, {
      sandbox: "audit",
      allowWrite: [process.cwd()],
      allowNet: ["example.com"],
    });
    await target.connect();

    const writeRes = await target.callTool("sandbox_write_test", {});
    expect((writeRes as any).content[0].text).toContain("denied");

    const netRes = await target.callTool("sandbox_net_test", {});
    expect((netRes as any).content[0].text).toContain("denied");
  }, 20_000);

  it("runs the mock server with native sandboxing and network allowed, proxying and logging network traffic", async () => {
    let checkCmd = "";
    if (process.platform === "darwin") checkCmd = "sandbox-exec";
    else if (process.platform === "linux") checkCmd = "bwrap";

    // Skip if we can't test native sandboxing natively on this host
    if (checkCmd) {
      try {
        const checkCmdStr = `command -v ${checkCmd}`;
        const { execSync } = await import("node:child_process");
        execSync(checkCmdStr, { stdio: "ignore" });
      } catch {
        return;
      }
    } else {
      try {
        const mxcModule = "@microsoft/mxc-sdk";
        await import(mxcModule);
      } catch {
        return;
      }
    }

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Spawn with native sandboxing and whitelisted network
    target = new TargetManager(MOCK_SERVER_CMD, MOCK_SERVER_ARGS, {
      sandbox: "native",
      allowNet: ["example.com"],
    });
    await target.connect();

    const netRes = await target.callTool("sandbox_net_test", {});
    expect((netRes as any).content[0].text).toBe("success");

    // Verify proxy logging intercepted the HTTP call to example.com
    const calls = consoleSpy.mock.calls.map((c: any) => c[0]);
    expect(calls.some((c: string) => c.includes("[NETWORK AUDIT] HTTP request to:"))).toBe(true);

    consoleSpy.mockRestore();
  }, 20_000);
});

describe("sandbox deny masking argument generation", () => {
  it("generates correct docker arguments for fileReadDeny / fileWriteDeny within workspace", async () => {
    const fs = await import("node:fs");
    const secretFile = join(process.cwd(), "test-canary-secret.txt");
    const secretDir = join(process.cwd(), "test-canary-secrets-dir");

    if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, "secret");
    if (!fs.existsSync(secretDir)) fs.mkdirSync(secretDir, { recursive: true });

    try {
      const policy = new SandboxPolicy();
      policy.fileReadDeny.add(secretFile);
      policy.fileReadDeny.add(secretDir);

      const tm = new TargetManager("node", ["server.js"], {
        sandbox: "docker",
      });

      const { command, args } = await (tm as any)._maybeWrapCommand(policy);

      expect(command).toBe("docker");
      expect(args).toContain("run");
      expect(args).toContain("-v");

      const expectedFilePart = ":/workspace/test-canary-secret.txt:ro";
      const expectedDirPart = ":/workspace/test-canary-secrets-dir:ro";

      expect(args.some((arg: string) => arg.endsWith(expectedFilePart))).toBe(true);
      expect(args.some((arg: string) => arg.endsWith(expectedDirPart))).toBe(true);

      await tm.close();
    } finally {
      if (fs.existsSync(secretFile)) fs.rmSync(secretFile);
      if (fs.existsSync(secretDir)) fs.rmSync(secretDir, { recursive: true });
    }
  });

  it("generates correct bwrap arguments for fileReadDeny / fileWriteDeny", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });

    try {
      const policy = new SandboxPolicy();
      const secretFile = join(process.cwd(), "test-canary-secret.txt");
      const fs = await import("node:fs");
      if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, "secret");

      policy.fileReadDeny.add(secretFile);

      const tm = new TargetManager("node", ["server.js"], {
        sandbox: "native",
      });

      const { command, args } = await (tm as any)._maybeWrapCommand(policy);

      expect(command).toBe("bwrap");
      let foundDevNullBind = false;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--ro-bind" && args[i + 1] === "/dev/null" && args[i + 2] === secretFile) {
          foundDevNullBind = true;
          break;
        }
      }
      expect(foundDevNullBind).toBe(true);

      if (fs.existsSync(secretFile)) fs.rmSync(secretFile);
      await tm.close();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
});
