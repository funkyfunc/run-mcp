import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ResponseInterceptor } from "../src/interceptor.js";
import { TargetManager } from "../src/target-manager.js";

const MOCK_SERVER_PATH = resolve(import.meta.dirname, "fixtures/mock-server.js");

/**
 * End-to-end integration tests using the real TargetManager + ResponseInterceptor
 * against the mock MCP server. Tests the full pipeline: spawn → call → intercept.
 */

let target: TargetManager | null = null;
let testOutDir: string;

afterEach(async () => {
  if (target) {
    await target.close();
    target = null;
  }
  if (existsSync(testOutDir)) {
    await rm(testOutDir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Full pipeline: TargetManager + Interceptor
// ═══════════════════════════════════════════════════════════════════════════

describe("end-to-end: interceptor with real target", () => {
  it("passes through echo call unchanged", async () => {
    testOutDir = join(tmpdir(), `run-mcp-e2e-${Date.now()}`);
    target = new TargetManager("node", [MOCK_SERVER_PATH]);
    await target.connect();

    const interceptor = new ResponseInterceptor({ outDir: testOutDir });
    const result = await interceptor.callTool(target, "echo", { text: "e2e test" });
    const content = (result as any).content;

    expect(content[0].text).toBe("e2e test");
  }, 15_000);

  it("intercepts screenshot and saves to disk", async () => {
    testOutDir = join(tmpdir(), `run-mcp-e2e-${Date.now()}`);
    target = new TargetManager("node", [MOCK_SERVER_PATH]);
    await target.connect();

    const interceptor = new ResponseInterceptor({ outDir: testOutDir });
    const result = await interceptor.callTool(target, "screenshot", {});
    const content = (result as any).content;

    // Should have replaced image with text pointer
    expect(content[0].type).toBe("text");
    expect(content[0].text).toMatch(/\[Image saved to .+\.png/);

    // Verify file exists on disk
    const files = await readdir(testOutDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/\.png$/);
  }, 15_000);

  it("intercepts big_base64 text blobs", async () => {
    testOutDir = join(tmpdir(), `run-mcp-e2e-${Date.now()}`);
    target = new TargetManager("node", [MOCK_SERVER_PATH]);
    await target.connect();

    const interceptor = new ResponseInterceptor({ outDir: testOutDir });
    const result = await interceptor.callTool(target, "big_base64", {});
    const content = (result as any).content;

    expect(content[0].type).toBe("text");
    expect(content[0].text).toMatch(/\[Image saved to/);
  }, 15_000);

  it("truncates big_response text", async () => {
    testOutDir = join(tmpdir(), `run-mcp-e2e-${Date.now()}`);
    target = new TargetManager("node", [MOCK_SERVER_PATH]);
    await target.connect();

    const interceptor = new ResponseInterceptor({ outDir: testOutDir });
    const result = await interceptor.callTool(target, "big_response", { size: 80_000 });
    const content = (result as any).content;

    const text = content[0].text;
    expect(text.length).toBeLessThan(80_000);
    expect(text).toContain("... (truncated, 80,000 chars total)");
  }, 15_000);

  it("enforces timeout on slow tool call", async () => {
    testOutDir = join(tmpdir(), `run-mcp-e2e-${Date.now()}`);
    target = new TargetManager("node", [MOCK_SERVER_PATH]);
    await target.connect();

    const interceptor = new ResponseInterceptor({
      outDir: testOutDir,
      defaultTimeoutMs: 200,
    });

    await expect(interceptor.callTool(target, "slow", { ms: 5000 })).rejects.toThrow(
      'Tool "slow" timed out after 200ms',
    );
  }, 15_000);

  it("succeeds when slow tool responds within timeout", async () => {
    testOutDir = join(tmpdir(), `run-mcp-e2e-${Date.now()}`);
    target = new TargetManager("node", [MOCK_SERVER_PATH]);
    await target.connect();

    const interceptor = new ResponseInterceptor({
      outDir: testOutDir,
      defaultTimeoutMs: 5000,
    });

    const result = await interceptor.callTool(target, "slow", { ms: 100 });
    expect((result as any).content[0].text).toBe("Waited 100ms");
  }, 15_000);
});
