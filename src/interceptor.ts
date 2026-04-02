import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TargetManager } from "./target-manager.js";

/** Matches a large base64 blob in text content (1000+ chars of base64 alphabet). */
const BASE64_PATTERN = /^[A-Za-z0-9+/]{1000,}={0,2}$/;

/** Default timeout for tool calls in milliseconds. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Default maximum text length before truncation. */
const DEFAULT_MAX_TEXT_LENGTH = 50_000;

export interface InterceptorOptions {
  outDir?: string;
  defaultTimeoutMs?: number;
  maxTextLength?: number;
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
 *  2. Base64 image/audio extraction → save to disk
 *  3. Large text truncation
 *
 * Processes content items in-place, preserving all other properties
 * (annotations, _meta, structuredContent, isError, etc.) for transparent passthrough.
 */
export class ResponseInterceptor {
  private readonly outDir: string;
  private readonly defaultTimeoutMs: number;
  private readonly maxTextLength: number;
  private fileCounter = 0;

  constructor(opts: InterceptorOptions = {}) {
    this.outDir = opts.outDir ?? join(tmpdir(), "run-mcp");
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxTextLength = opts.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
  }

  /**
   * Call a tool on the target, applying timeout, media extraction, and truncation.
   *
   * Returns the full result object as-is (including structuredContent, isError, _meta)
   * with only the content array items modified when interception is needed.
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

    // Process content array if present — modifies items in-place
    const content = (result as any).content;
    if (Array.isArray(content)) {
      for (let i = 0; i < content.length; i++) {
        content[i] = await this._processItem(content[i]);
      }
    }

    return result as Record<string, unknown>;
  }

  /**
   * Process a single content item — extract media, truncate text.
   * Preserves all item properties not related to the intercepted data
   * (e.g., annotations, _meta).
   */
  private async _processItem(item: ContentItem): Promise<ContentItem> {
    // Case 1: Explicit image type with base64 data
    if (item.type === "image" && item.data) {
      return this._saveMedia(item.data, item.mimeType ?? "image/png", "image");
    }

    // Case 2: Audio type with base64 data
    if (item.type === "audio" && item.data) {
      return this._saveMedia(item.data, item.mimeType ?? "audio/wav", "audio");
    }

    // Case 3: Text item that looks like a raw base64 blob
    if (item.type === "text" && item.text && BASE64_PATTERN.test(item.text.trim())) {
      return this._saveMedia(item.text.trim(), "image/png", "image");
    }

    // Case 4: Truncate oversized text
    if (item.type === "text" && item.text && item.text.length > this.maxTextLength) {
      const totalLength = item.text.length;
      return {
        ...item,
        text:
          item.text.slice(0, this.maxTextLength) +
          `\n... (truncated, ${totalLength.toLocaleString()} chars total)`,
      };
    }

    // Default: pass through unchanged (resource, resource_link, etc.)
    return item;
  }

  /**
   * Decode base64, write to disk, return a text item with the file path.
   * Works for both images and audio.
   */
  private async _saveMedia(
    base64Data: string,
    mimeType: string,
    mediaType: "image" | "audio",
  ): Promise<ContentItem> {
    await mkdir(this.outDir, { recursive: true });

    const ext = this._extensionFromMime(mimeType);
    const timestamp = Date.now();
    const counter = this.fileCounter++;
    const prefix = mediaType === "audio" ? "audio" : "img";
    const filename = `${prefix}_${timestamp}_${counter}${ext}`;
    const filepath = join(this.outDir, filename);

    const buffer = Buffer.from(base64Data, "base64");
    await writeFile(filepath, buffer);

    const sizeKB = (buffer.length / 1024).toFixed(1);
    const label = mediaType === "audio" ? "Audio" : "Image";

    return {
      type: "text",
      text: `[${label} saved to ${filepath} (${sizeKB}KB)]`,
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
   * Covers image and audio types.
   */
  private _extensionFromMime(mimeType: string): string {
    const map: Record<string, string> = {
      // Images
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "image/svg+xml": ".svg",
      "image/bmp": ".bmp",
      // Audio
      "audio/wav": ".wav",
      "audio/mpeg": ".mp3",
      "audio/mp3": ".mp3",
      "audio/ogg": ".ogg",
      "audio/flac": ".flac",
      "audio/aac": ".aac",
      "audio/webm": ".webm",
      "audio/mp4": ".m4a",
    };
    return map[mimeType] ?? (mimeType.startsWith("audio/") ? ".wav" : ".png");
  }
}
