import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TargetManager } from "./target-manager.js";

/** Matches a large base64 blob in text content (1000+ chars of base64 alphabet). */
const BASE64_PATTERN = /^[A-Za-z0-9+/]{1000,}={0,2}$/;

/** Default timeout for tool calls in milliseconds. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Maximum text length before truncation. */
const MAX_TEXT_LENGTH = 50_000;

interface InterceptorOptions {
  outDir?: string;
  defaultTimeoutMs?: number;
}

interface ContentItem {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
}

/**
 * Middleware that wraps callTool with:
 *  1. Configurable timeouts (Promise.race)
 *  2. Base64 image extraction → save to disk
 *  3. Large text truncation
 */
export class ResponseInterceptor {
  private readonly outDir: string;
  private readonly defaultTimeoutMs: number;
  private fileCounter = 0;

  constructor(opts: InterceptorOptions = {}) {
    this.outDir = opts.outDir ?? join(tmpdir(), "run-mcp");
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Call a tool on the target, applying timeout, image extraction, and truncation.
   */
  async callTool(
    target: TargetManager,
    name: string,
    args: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    const timeout = timeoutMs ?? this.defaultTimeoutMs;

    // Race the actual call against a timeout
    const result = await Promise.race([target.callTool(name, args), this._timeout(timeout, name)]);

    // Process content array if present
    const content = (result as any).content;
    if (Array.isArray(content)) {
      for (let i = 0; i < content.length; i++) {
        content[i] = await this._processItem(content[i]);
      }
    }

    return result as Record<string, unknown>;
  }

  /**
   * Process a single content item — extract images, truncate text.
   */
  private async _processItem(item: ContentItem): Promise<ContentItem> {
    // Case 1: Explicit image type with base64 data
    if (item.type === "image" && item.data) {
      return this._saveImage(item.data, item.mimeType ?? "image/png");
    }

    // Case 2: Text item that looks like a raw base64 blob
    if (item.type === "text" && item.text && BASE64_PATTERN.test(item.text.trim())) {
      return this._saveImage(item.text.trim(), "image/png");
    }

    // Case 3: Truncate oversized text
    if (item.type === "text" && item.text && item.text.length > MAX_TEXT_LENGTH) {
      const totalLength = item.text.length;
      return {
        type: "text",
        text:
          item.text.slice(0, MAX_TEXT_LENGTH) +
          `\n... (truncated, ${totalLength.toLocaleString()} chars total)`,
      };
    }

    return item;
  }

  /**
   * Decode base64, write to disk, return a text item with the file path.
   */
  private async _saveImage(base64Data: string, mimeType: string): Promise<ContentItem> {
    await mkdir(this.outDir, { recursive: true });

    const ext = this._extensionFromMime(mimeType);
    const timestamp = Date.now();
    const counter = this.fileCounter++;
    const filename = `img_${timestamp}_${counter}${ext}`;
    const filepath = join(this.outDir, filename);

    const buffer = Buffer.from(base64Data, "base64");
    await writeFile(filepath, buffer);

    const sizeKB = (buffer.length / 1024).toFixed(1);

    return {
      type: "text",
      text: `[Image saved to ${filepath} (${sizeKB}KB)]`,
    };
  }

  /**
   * Returns a promise that rejects after the given timeout.
   */
  private _timeout(ms: number, toolName: string): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        const humanMs = ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
        reject(
          new Error(
            `Tool "${toolName}" timed out after ${ms}ms (${humanMs}). ` +
              `Use --timeout <ms> to increase the limit.`,
          ),
        );
      }, ms);
    });
  }

  /**
   * Map MIME type to file extension.
   */
  private _extensionFromMime(mimeType: string): string {
    const map: Record<string, string> = {
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "image/svg+xml": ".svg",
      "image/bmp": ".bmp",
    };
    return map[mimeType] ?? ".png";
  }
}
