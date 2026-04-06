import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResponseInterceptor } from "../src/interceptor.js";

// Helper: create a mock TargetManager with a configurable callTool response
function mockTarget(response: Record<string, unknown>) {
  return {
    callTool: vi.fn().mockResolvedValue(response),
  } as any;
}

// Helper: create a slow mock target that takes N ms to respond
function slowMockTarget(ms: number, response: Record<string, unknown>) {
  return {
    callTool: vi
      .fn()
      .mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(response), ms))),
  } as any;
}

// Use a unique temp dir for each test run to avoid collisions
let testOutDir: string;

beforeEach(() => {
  testOutDir = join(tmpdir(), `run-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
});

afterEach(async () => {
  // Clean up test output directory
  if (existsSync(testOutDir)) {
    await rm(testOutDir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Pass-through behavior
// ═══════════════════════════════════════════════════════════════════════════

describe("pass-through behavior", () => {
  it("passes through a normal text response unchanged", async () => {
    const interceptor = new ResponseInterceptor({ outDir: testOutDir });
    const target = mockTarget({
      content: [{ type: "text", text: "Hello, world!" }],
    });

    const result = await interceptor.callTool(target, "echo", { text: "Hello, world!" });

    expect(target.callTool).toHaveBeenCalledWith("echo", { text: "Hello, world!" });
    expect(result).toEqual({
      content: [{ type: "text", text: "Hello, world!" }],
    });
  });

  it("passes through multiple content items", async () => {
    const interceptor = new ResponseInterceptor({ outDir: testOutDir });
    const target = mockTarget({
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    });

    const result = await interceptor.callTool(target, "multi", {});
    const content = (result as any).content;
    expect(content).toHaveLength(2);
    expect(content[0].text).toBe("first");
    expect(content[1].text).toBe("second");
  });

  it("passes through responses with no content array", async () => {
    const interceptor = new ResponseInterceptor({ outDir: testOutDir });
    const target = mockTarget({ result: "ok" });

    const result = await interceptor.callTool(target, "custom", {});
    expect(result).toEqual({ result: "ok" });
  });

  it("passes through short text without truncation", async () => {
    const interceptor = new ResponseInterceptor({ outDir: testOutDir });
    // Use text with spaces/punctuation so it doesn't match the base64 heuristic
    const shortText = "Hello world! ".repeat(3846); // ~49,998 chars
    const target = mockTarget({
      content: [{ type: "text", text: shortText }],
    });

    const result = await interceptor.callTool(target, "test", {});
    expect((result as any).content[0].text).toBe(shortText);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Timeout enforcement
// ═══════════════════════════════════════════════════════════════════════════

describe("timeout enforcement", () => {
  it("rejects when tool call exceeds timeout", async () => {
    const interceptor = new ResponseInterceptor({
      outDir: testOutDir,
      defaultTimeoutMs: 100,
    });
    const target = slowMockTarget(500, {
      content: [{ type: "text", text: "too slow" }],
    });

    await expect(interceptor.callTool(target, "slow", {})).rejects.toThrow(
      'Tool "slow" timed out after 100ms',
    );
  });

  it("allows per-call timeout override", async () => {
    const interceptor = new ResponseInterceptor({
      outDir: testOutDir,
      defaultTimeoutMs: 60_000,
    });
    const target = slowMockTarget(500, {
      content: [{ type: "text", text: "too slow" }],
    });

    await expect(interceptor.callTool(target, "slow", {}, 50)).rejects.toThrow(
      'Tool "slow" timed out after 50ms',
    );
  });

  it("succeeds when response arrives before timeout", async () => {
    const interceptor = new ResponseInterceptor({
      outDir: testOutDir,
      defaultTimeoutMs: 2000,
    });
    const target = slowMockTarget(50, {
      content: [{ type: "text", text: "fast enough" }],
    });

    const result = await interceptor.callTool(target, "quick", {});
    expect((result as any).content[0].text).toBe("fast enough");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Image extraction — explicit type: "image"
// ═══════════════════════════════════════════════════════════════════════════

describe("image extraction — explicit type:image", () => {
  it("saves a base64 PNG to disk and replaces content", async () => {
    const interceptor = new ResponseInterceptor({ outDir: testOutDir });
    // Minimal valid 1x1 PNG
    const pngB64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    const target = mockTarget({
      content: [{ type: "image", data: pngB64, mimeType: "image/png" }],
    });

    const result = await interceptor.callTool(target, "screenshot", {});
    const content = (result as any).content;

    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toMatch(/\[Image saved to .+\.png \(\d+\.\d+KB\)\]/);

    // Verify the file was actually written
    const filepath = content[0].text.match(/\[Image saved to (.+\.png)/)?.[1];
    expect(filepath).toBeTruthy();
    const fileContents = await readFile(filepath!, null);
    expect(fileContents.length).toBeGreaterThan(0);
  });

  it("uses correct extension for JPEG", async () => {
    const interceptor = new ResponseInterceptor({ outDir: testOutDir });
    const fakejpg = Buffer.from("fake-jpeg-data").toString("base64");

    const target = mockTarget({
      content: [{ type: "image", data: fakejpg, mimeType: "image/jpeg" }],
    });

    const result = await interceptor.callTool(target, "screenshot", {});
    expect((result as any).content[0].text).toMatch(/\.jpg/);
  });

  it("defaults to .png for unknown mime types", async () => {
    const interceptor = new ResponseInterceptor({ outDir: testOutDir });
    const data = Buffer.from("some-data").toString("base64");

    const target = mockTarget({
      content: [{ type: "image", data, mimeType: "image/unknown" }],
    });

    const result = await interceptor.callTool(target, "screenshot", {});
    expect((result as any).content[0].text).toMatch(/\.png/);
  });

  it("generates unique filenames for multiple images", async () => {
    const interceptor = new ResponseInterceptor({ outDir: testOutDir });
    const data = Buffer.from("img").toString("base64");

    const target1 = mockTarget({
      content: [{ type: "image", data, mimeType: "image/png" }],
    });
    const target2 = mockTarget({
      content: [{ type: "image", data, mimeType: "image/png" }],
    });

    const r1 = await interceptor.callTool(target1, "shot1", {});
    const r2 = await interceptor.callTool(target2, "shot2", {});

    const path1 = (r1 as any).content[0].text;
    const path2 = (r2 as any).content[0].text;
    expect(path1).not.toBe(path2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Image extraction — heuristic base64 detection in text
// ═══════════════════════════════════════════════════════════════════════════

describe("image extraction — heuristic base64 detection", () => {
  it("detects and saves large base64 text blobs", async () => {
    const interceptor = new ResponseInterceptor({ outDir: testOutDir });
    // Generate a string of 2000 base64-safe characters
    const bigB64 = Buffer.alloc(1600, 0x42).toString("base64"); // > 1000 chars

    const target = mockTarget({
      content: [{ type: "text", text: bigB64 }],
    });

    const result = await interceptor.callTool(target, "blob", {});
    const content = (result as any).content;

    expect(content[0].type).toBe("text");
    expect(content[0].text).toMatch(/\[Image saved to/);
  });

  it("does NOT treat short base64 strings as images", async () => {
    const interceptor = new ResponseInterceptor({ outDir: testOutDir });
    const shortB64 = Buffer.from("hello").toString("base64"); // ~8 chars

    const target = mockTarget({
      content: [{ type: "text", text: shortB64 }],
    });

    const result = await interceptor.callTool(target, "test", {});
    // Should pass through unchanged
    expect((result as any).content[0].text).toBe(shortB64);
  });

  it("does NOT treat normal long text as base64", async () => {
    const interceptor = new ResponseInterceptor({ outDir: testOutDir });
    // Normal text with spaces and punctuation — not base64
    const normalText = "This is a normal sentence. ".repeat(100);

    const target = mockTarget({
      content: [{ type: "text", text: normalText }],
    });

    const result = await interceptor.callTool(target, "test", {});
    // Should NOT be saved as an image
    expect((result as any).content[0].text).not.toMatch(/\[Image saved to/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Text truncation
// ═══════════════════════════════════════════════════════════════════════════

describe("text truncation", () => {
  // Use text with non-base64 chars so the heuristic doesn't trigger
  const FILLER = "The quick brown fox. ";

  it("truncates text exceeding 50,000 characters", async () => {
    const interceptor = new ResponseInterceptor({ outDir: testOutDir });
    const bigText = FILLER.repeat(3000); // ~63,000 chars

    const target = mockTarget({
      content: [{ type: "text", text: bigText }],
    });

    const result = await interceptor.callTool(target, "big", {});
    const text = (result as any).content[0].text;

    expect(text.length).toBeLessThan(bigText.length);
    expect(text).toContain("... (truncated,");
    expect(text).toContain("chars total)");
    expect(text.startsWith("The quick brown fox.")).toBe(true);
  });

  it("preserves text exactly at limit (50,000 chars)", async () => {
    const interceptor = new ResponseInterceptor({ outDir: testOutDir });
    // Build exactly 50,000 chars of non-base64 text
    const base = FILLER.repeat(2381); // 2381 * 21 = 50,001
    const exactText = base.slice(0, 50_000);

    const target = mockTarget({
      content: [{ type: "text", text: exactText }],
    });

    const result = await interceptor.callTool(target, "test", {});
    expect((result as any).content[0].text).toBe(exactText);
  });

  it("includes total character count in truncation message", async () => {
    const interceptor = new ResponseInterceptor({ outDir: testOutDir });
    // 120,340 chars of non-base64 text
    const bigText = FILLER.repeat(5731); // 5731 * 21 = 120,351
    const sized = bigText.slice(0, 120_340);
    const target = mockTarget({
      content: [{ type: "text", text: sized }],
    });

    const result = await interceptor.callTool(target, "test", {});
    expect((result as any).content[0].text).toContain("120,340 chars total");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Mixed content processing
// ═══════════════════════════════════════════════════════════════════════════

describe("mixed content processing", () => {
  it("processes images and text in the same response", async () => {
    const interceptor = new ResponseInterceptor({ outDir: testOutDir });
    const imgData = Buffer.from("fake-img").toString("base64");

    const target = mockTarget({
      content: [
        { type: "text", text: "Some context" },
        { type: "image", data: imgData, mimeType: "image/png" },
        { type: "text", text: "More context" },
      ],
    });

    const result = await interceptor.callTool(target, "mixed", {});
    const content = (result as any).content;

    expect(content).toHaveLength(3);
    expect(content[0].text).toBe("Some context");
    expect(content[1].text).toMatch(/\[Image saved to/);
    expect(content[2].text).toBe("More context");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// callToolWithMetadata
// ═══════════════════════════════════════════════════════════════════════════

describe("callToolWithMetadata", () => {
  it("returns metadata with zero interceptions for normal text", async () => {
    const interceptor = new ResponseInterceptor({ outDir: testOutDir });
    const target = mockTarget({
      content: [{ type: "text", text: "hello" }],
    });

    const { result, metadata } = await interceptor.callToolWithMetadata(target, "echo", {});

    expect((result as any).content[0].text).toBe("hello");
    expect(metadata.truncated).toBe(false);
    expect(metadata.imagesSaved).toBe(0);
    expect(metadata.audioSaved).toBe(0);
    expect(metadata.originalSizeBytes).toBe(5);
  });

  it("tracks images_saved for image interception", async () => {
    const interceptor = new ResponseInterceptor({ outDir: testOutDir });
    const imgData = Buffer.from("fake-image-data").toString("base64");

    const target = mockTarget({
      content: [{ type: "image", data: imgData, mimeType: "image/png" }],
    });

    const { metadata } = await interceptor.callToolWithMetadata(target, "screenshot", {});
    expect(metadata.imagesSaved).toBe(1);
    expect(metadata.audioSaved).toBe(0);
    expect(metadata.originalSizeBytes).toBeGreaterThan(0);
  });

  it("tracks audio_saved for audio interception", async () => {
    const interceptor = new ResponseInterceptor({ outDir: testOutDir });
    const audioData = Buffer.from("fake-audio").toString("base64");

    const target = mockTarget({
      content: [{ type: "audio", data: audioData, mimeType: "audio/wav" }],
    });

    const { metadata } = await interceptor.callToolWithMetadata(target, "audio_tool", {});
    expect(metadata.audioSaved).toBe(1);
    expect(metadata.imagesSaved).toBe(0);
  });

  it("tracks truncation in metadata", async () => {
    const interceptor = new ResponseInterceptor({ outDir: testOutDir, maxTextLength: 100 });
    const bigText = "Hello world. ".repeat(50); // ~650 chars

    const target = mockTarget({
      content: [{ type: "text", text: bigText }],
    });

    const { metadata } = await interceptor.callToolWithMetadata(target, "big", {});
    expect(metadata.truncated).toBe(true);
    expect(metadata.originalSizeBytes).toBeGreaterThan(100);
  });
});
