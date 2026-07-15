import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import type { TargetManager } from "./target-manager.js";
import type { InterceptorPlugin, PluginFinding, ToolDef } from "./plugins.js";
import type { Cassette } from "./cassette.js";

/** Matches a large base64 blob in text content (1000+ chars of base64 alphabet). */
const BASE64_PATTERN = /^[A-Za-z0-9+/]{1000,}={0,2}$/;

/** Default timeout for tool calls in milliseconds (5 minutes). */
const DEFAULT_TIMEOUT_MS = 300_000;

/** Default maximum text length before truncation. */
const DEFAULT_MAX_TEXT_LENGTH = 50_000;

export interface InterceptorOptions {
  outDir?: string;
  defaultTimeoutMs?: number;
  maxTextLength?: number;
  mediaThresholdKb?: number;
  openMedia?: boolean;
  /** Ordered middleware plugins run over tools/list and call/read/prompt results. */
  plugins?: InterceptorPlugin[];
  /** Record/replay cassette. When set, call/read/getPrompt consult and record it. */
  cassette?: Cassette;
}

/**
 * Metadata about what interception actions were taken during a tool call.
 * Returned by `callToolWithMetadata()` for agent consumers that want
 * structured insight into what happened.
 */
export interface InterceptionMetadata {
  truncated: boolean;
  imagesSaved: number;
  audioSaved: number;
  /** Oversized text results spilled to disk (navigable via read_result). */
  resultsSaved: number;
  originalSizeBytes: number;
  /** Findings surfaced by interceptor plugins while processing this result. */
  findings: PluginFinding[];
}

interface ContentItem {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
}

/**
 * Middleware that wraps callTool, readResource, and getPrompt with:
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
  private readonly mediaThresholdKb: number;
  private readonly openMedia: boolean;
  private readonly plugins: InterceptorPlugin[];
  private readonly cassette?: Cassette;
  private fileCounter = 0;

  constructor(opts: InterceptorOptions = {}) {
    this.outDir = opts.outDir ?? join(tmpdir(), "run-mcp");
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxTextLength = opts.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
    this.mediaThresholdKb = opts.mediaThresholdKb ?? 0;
    this.openMedia = opts.openMedia ?? false;
    this.plugins = opts.plugins ?? [];
    this.cassette = opts.cassette;
  }

  /** Empty interception metadata (used for replayed results). */
  private _emptyMetadata(): InterceptionMetadata {
    return {
      truncated: false,
      imagesSaved: 0,
      audioSaved: 0,
      resultsSaved: 0,
      originalSizeBytes: 0,
      findings: [],
    };
  }

  /**
   * Consult the cassette for a recorded result. Returns it on a hit; in replay
   * mode a miss throws (the cassette is stale for this request).
   */
  private _replay(
    primitive: "tool" | "resource" | "prompt",
    name: string,
    args: unknown,
  ): Record<string, unknown> | undefined {
    if (!this.cassette) return undefined;
    const hit = this.cassette.match(primitive, name, args);
    if (hit) return hit.result as Record<string, unknown>;
    if (this.cassette.mode === "replay") {
      throw new Error(
        `No cassette recording for ${primitive} "${name}" with the given arguments (replay mode). ` +
          `Re-record with --record, or check the arguments match.`,
      );
    }
    return undefined;
  }

  /**
   * Run the `onToolsList` hook of every plugin over a tools array, in order.
   * Returns the (possibly transformed) tools and any findings the plugins
   * surfaced (e.g. tool-poisoning warnings). Tools are mutated in place by
   * plugins that strip content, so callers should use the returned array.
   */
  async processToolList(
    tools: ToolDef[],
  ): Promise<{ tools: ToolDef[]; findings: PluginFinding[] }> {
    const findings: PluginFinding[] = [];
    const report = (f: PluginFinding) => findings.push(f);
    let current = tools;
    for (const plugin of this.plugins) {
      if (plugin.onToolsList) {
        current = await plugin.onToolsList(current, report);
      }
    }
    return { tools: current, findings };
  }

  /**
   * Run a result-transform hook (onToolResult/onResourceResult/onPromptResult)
   * for every plugin, threading findings into `metadata.findings`.
   */
  private async _runResultHooks(
    hook: "onToolResult" | "onResourceResult" | "onPromptResult",
    result: Record<string, unknown>,
    primitive: "tool" | "resource" | "prompt",
    name: string | undefined,
    metadata: InterceptionMetadata,
  ): Promise<Record<string, unknown>> {
    if (this.plugins.length === 0) return result;
    const report = (f: PluginFinding) => metadata.findings.push(f);
    let current = result;
    for (const plugin of this.plugins) {
      const fn = plugin[hook];
      if (fn) {
        current = await fn.call(plugin, current, { primitive, name, report });
      }
    }
    return current;
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
    maxTextLength?: number,
  ): Promise<Record<string, unknown>> {
    const { result } = await this._callToolInternal(target, name, args, timeoutMs, maxTextLength);
    return result;
  }

  /**
   * Call a tool and return both the result and metadata about interception actions.
   * Used by the agent server when `include_metadata` is requested.
   */
  async callToolWithMetadata(
    target: TargetManager,
    name: string,
    args: Record<string, unknown> = {},
    timeoutMs?: number,
    maxTextLength?: number,
  ): Promise<{ result: Record<string, unknown>; metadata: InterceptionMetadata }> {
    return this._callToolInternal(target, name, args, timeoutMs, maxTextLength);
  }

  /**
   * Read a resource on the target, applying timeout, media extraction, and truncation.
   */
  async readResource(
    target: TargetManager,
    params: { uri: string; [key: string]: unknown },
    timeoutMs?: number,
    maxTextLength?: number,
  ): Promise<Record<string, unknown>> {
    const timeout = timeoutMs ?? this.defaultTimeoutMs;
    const metadata: InterceptionMetadata = {
      truncated: false,
      imagesSaved: 0,
      audioSaved: 0,
      resultsSaved: 0,
      originalSizeBytes: 0,
      findings: [],
    };

    const replayed = this._replay("resource", params.uri, params);
    if (replayed !== undefined) return replayed;

    const targetCall = target.readResource(params);
    targetCall.catch(() => {});

    const result = await this._raceWithTimeout(targetCall, timeout, `resource:${params.uri}`);

    const contents = (result as any).contents;
    if (Array.isArray(contents)) {
      for (const item of contents) {
        if (item.text) {
          metadata.originalSizeBytes += Buffer.byteLength(item.text, "utf8");
        } else if (item.blob) {
          metadata.originalSizeBytes += Buffer.byteLength(item.blob, "base64");
        }
      }

      for (let i = 0; i < contents.length; i++) {
        contents[i] = await this._processResourceItem(contents[i], metadata, maxTextLength);
      }
    }

    const finalResult = await this._runResultHooks(
      "onResourceResult",
      result as Record<string, unknown>,
      "resource",
      params.uri,
      metadata,
    );
    this.cassette?.record("resource", params.uri, params, finalResult, new Date().toISOString());
    return finalResult;
  }

  /**
   * Get a prompt on the target, applying timeout, media extraction, and truncation.
   */
  async getPrompt(
    target: TargetManager,
    params: { name: string; arguments?: Record<string, string> },
    timeoutMs?: number,
    maxTextLength?: number,
  ): Promise<Record<string, unknown>> {
    const timeout = timeoutMs ?? this.defaultTimeoutMs;
    const metadata: InterceptionMetadata = {
      truncated: false,
      imagesSaved: 0,
      audioSaved: 0,
      resultsSaved: 0,
      originalSizeBytes: 0,
      findings: [],
    };

    const replayed = this._replay("prompt", params.name, params.arguments);
    if (replayed !== undefined) return replayed;

    const targetCall = target.getPrompt(params);
    targetCall.catch(() => {});

    const result = await this._raceWithTimeout(targetCall, timeout, `prompt:${params.name}`);

    const messages = (result as any).messages;
    if (Array.isArray(messages)) {
      for (const msg of messages) {
        const content = msg.content;
        if (content) {
          if (Array.isArray(content)) {
            for (const item of content) {
              if (item.type === "text" && item.text) {
                metadata.originalSizeBytes += Buffer.byteLength(item.text, "utf8");
              } else if ((item.type === "image" || item.type === "audio") && item.data) {
                metadata.originalSizeBytes += Buffer.byteLength(item.data, "base64");
              }
            }
            for (let i = 0; i < content.length; i++) {
              content[i] = await this._processItem(content[i], metadata, maxTextLength);
            }
          } else if (typeof content === "object") {
            if ((content as any).type === "text" && (content as any).text) {
              metadata.originalSizeBytes += Buffer.byteLength((content as any).text, "utf8");
            } else if (
              ((content as any).type === "image" || (content as any).type === "audio") &&
              (content as any).data
            ) {
              metadata.originalSizeBytes += Buffer.byteLength((content as any).data, "base64");
            }
            msg.content = await this._processItem(content as any, metadata, maxTextLength);
          }
        }
      }
    }

    const finalResult = await this._runResultHooks(
      "onPromptResult",
      result as Record<string, unknown>,
      "prompt",
      params.name,
      metadata,
    );
    this.cassette?.record(
      "prompt",
      params.name,
      params.arguments,
      finalResult,
      new Date().toISOString(),
    );
    return finalResult;
  }

  /**
   * Internal implementation shared by callTool and callToolWithMetadata.
   */
  private async _callToolInternal(
    target: TargetManager,
    name: string,
    args: Record<string, unknown> = {},
    timeoutMs?: number,
    maxTextLength?: number,
  ): Promise<{ result: Record<string, unknown>; metadata: InterceptionMetadata }> {
    const timeout = timeoutMs ?? this.defaultTimeoutMs;
    const metadata: InterceptionMetadata = {
      truncated: false,
      imagesSaved: 0,
      audioSaved: 0,
      resultsSaved: 0,
      originalSizeBytes: 0,
      findings: [],
    };

    // Replay from cassette if we have a recording (skips the target entirely).
    const replayed = this._replay("tool", name, args);
    if (replayed !== undefined) {
      return { result: replayed, metadata: this._emptyMetadata() };
    }

    // Start the target call. We attach a dummy .catch to prevent unhandled
    // promise rejections if the real call fails AFTER our Promise.race times out.
    // By the time it resolves/rejects later, the outer Promise.race is already done.
    const targetCall = target.callTool(name, args);
    targetCall.catch(() => {});

    // Race the actual call against a timeout
    const result = await this._raceWithTimeout(targetCall, timeout, name);

    // Process content array if present — modifies items in-place
    const content = (result as any).content;
    if (Array.isArray(content)) {
      // Track original size before any interception
      for (const item of content) {
        if (item.type === "text" && item.text) {
          metadata.originalSizeBytes += Buffer.byteLength(item.text, "utf8");
        } else if ((item.type === "image" || item.type === "audio") && item.data) {
          metadata.originalSizeBytes += Buffer.byteLength(item.data, "base64");
        }
      }

      for (let i = 0; i < content.length; i++) {
        content[i] = await this._processItem(content[i], metadata, maxTextLength);
      }
    }

    const finalResult = await this._runResultHooks(
      "onToolResult",
      result as Record<string, unknown>,
      "tool",
      name,
      metadata,
    );

    this.cassette?.record("tool", name, args, finalResult, new Date().toISOString());

    return { result: finalResult, metadata };
  }

  /**
   * Process a single content item — extract media, truncate text.
   * Preserves all item properties not related to the intercepted data
   * (e.g., annotations, _meta).
   */
  private async _processItem(
    item: ContentItem,
    metadata: InterceptionMetadata,
    maxTextLength?: number,
  ): Promise<ContentItem> {
    // Case 1: Explicit image type with base64 data
    if (item.type === "image" && item.data) {
      const sizeKB = Buffer.byteLength(item.data, "base64") / 1024;
      if (
        this.mediaThresholdKb === -1 ||
        (this.mediaThresholdKb > 0 && sizeKB <= this.mediaThresholdKb)
      ) {
        return item;
      }
      metadata.imagesSaved++;
      return this._saveMedia(item.data, item.mimeType ?? "image/png", "image");
    }

    // Case 2: Audio type with base64 data
    if (item.type === "audio" && item.data) {
      const sizeKB = Buffer.byteLength(item.data, "base64") / 1024;
      if (
        this.mediaThresholdKb === -1 ||
        (this.mediaThresholdKb > 0 && sizeKB <= this.mediaThresholdKb)
      ) {
        return item;
      }
      metadata.audioSaved++;
      return this._saveMedia(item.data, item.mimeType ?? "audio/wav", "audio");
    }

    // Case 3: Text item that looks like a raw base64 blob
    if (item.type === "text" && item.text && BASE64_PATTERN.test(item.text.trim())) {
      const sizeKB = Buffer.byteLength(item.text.trim(), "base64") / 1024;
      if (
        this.mediaThresholdKb === -1 ||
        (this.mediaThresholdKb > 0 && sizeKB <= this.mediaThresholdKb)
      ) {
        return item;
      }
      metadata.imagesSaved++;
      return this._saveMedia(item.text.trim(), "image/png", "image");
    }

    // Case 4: Oversized text — spill the full payload to disk and return a
    // navigable head instead of destroying the tail.
    const limit = maxTextLength ?? this.maxTextLength;
    if (item.type === "text" && item.text && limit !== -1 && item.text.length > limit) {
      return { ...item, text: await this._spillOversizedText(item.text, metadata, limit) };
    }

    // Default: pass through unchanged (resource, resource_link, etc.)
    return item;
  }

  /**
   * Process a single resource content item.
   */
  private async _processResourceItem(
    item: any,
    metadata: InterceptionMetadata,
    maxTextLength?: number,
  ): Promise<any> {
    if (item.blob) {
      const mime = item.mimeType ?? "image/png";
      const isAudio = mime.startsWith("audio/");
      const sizeKB = Buffer.byteLength(item.blob, "base64") / 1024;
      if (
        this.mediaThresholdKb === -1 ||
        (this.mediaThresholdKb > 0 && sizeKB <= this.mediaThresholdKb)
      ) {
        return item;
      }

      if (isAudio) metadata.audioSaved++;
      else metadata.imagesSaved++;

      const saved = await this._saveMedia(item.blob, mime, isAudio ? "audio" : "image");
      return {
        uri: item.uri,
        mimeType: "text/plain",
        text: saved.text,
      };
    }

    const limit = maxTextLength ?? this.maxTextLength;
    if (item.text && limit !== -1 && item.text.length > limit) {
      return { ...item, text: await this._spillOversizedText(item.text, metadata, limit) };
    }

    return item;
  }

  // ─── Oversized-result spill ("save to disk, return a handle") ─────────────

  /** Spilled results by id, so read_result can navigate them without exposing arbitrary paths. */
  private readonly _spilledResults = new Map<string, { filepath: string; totalChars: number }>();
  private spillCounter = 0;

  /**
   * Write the full oversized text to outDir (the same move the interceptor
   * already makes for media) and return the head plus a note carrying a result
   * id and the file path. Truncation becomes navigation: the consumer fetches
   * more via `read_result` (agent mode) or by reading the file directly.
   * Falls back to plain truncation if the write fails — never breaks the call.
   */
  private async _spillOversizedText(
    text: string,
    metadata: InterceptionMetadata,
    limit: number,
  ): Promise<string> {
    metadata.truncated = true;
    const head = text.slice(0, limit);
    const totalChars = text.length;

    try {
      await mkdir(this.outDir, { recursive: true });
      const trimmed = text.trimStart();
      const ext = trimmed.startsWith("{") || trimmed.startsWith("[") ? ".json" : ".txt";
      const filename = `result_${Date.now()}_${this.fileCounter++}${ext}`;
      const filepath = join(this.outDir, filename);
      await writeFile(filepath, text, "utf8");

      const id = `r${++this.spillCounter}`;
      this._spilledResults.set(id, { filepath, totalChars });
      metadata.resultsSaved++;

      return (
        head +
        `\n... [truncated at ${limit.toLocaleString()} of ${totalChars.toLocaleString()} chars — ` +
        `full result saved to ${filepath} (result id: ${id}). ` +
        `Use read_result with this id, or read the file, to fetch the rest.]`
      );
    } catch {
      // Disk unavailable — degrade to the old destructive truncation.
      return head + `\n... (truncated, ${totalChars.toLocaleString()} chars total)`;
    }
  }

  /**
   * Read a slice of a previously spilled result by id. Returns undefined for
   * unknown ids (they are per-session). Only files this interceptor wrote are
   * reachable — ids, not paths, so this is not an arbitrary-file-read.
   */
  async readSpilledResult(
    id: string,
    offsetChars = 0,
    maxChars = DEFAULT_MAX_TEXT_LENGTH,
  ): Promise<{ text: string; totalChars: number; offset: number; filepath: string } | undefined> {
    const entry = this._spilledResults.get(id);
    if (!entry) return undefined;
    const { readFile } = await import("node:fs/promises");
    const full = await readFile(entry.filepath, "utf8");
    const offset = Math.max(0, Math.floor(offsetChars));
    const length = Math.max(1, Math.floor(maxChars));
    return {
      text: full.slice(offset, offset + length),
      totalChars: full.length,
      offset,
      filepath: entry.filepath,
    };
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

    if (this.openMedia) {
      // execFile (no shell) so a crafted outDir can't inject shell commands.
      const isMac = process.platform === "darwin";
      const isWin = process.platform === "win32";
      const [opener, openerArgs] = isMac
        ? ["open", [filepath]]
        : isWin
          ? ["cmd", ["/c", "start", "", filepath]]
          : ["xdg-open", [filepath]];
      execFile(opener, openerArgs, () => {});
    }

    const sizeKB = (buffer.length / 1024).toFixed(1);
    const label = mediaType === "audio" ? "Audio" : "Image";

    return {
      type: "text",
      text: `[${label} saved to ${filepath} (${sizeKB}KB)]`,
    };
  }

  /**
   * Race a target call against a timeout, clearing the timer once either side
   * settles. Without the cleanup every intercepted call would leave a live
   * timer for the full timeout window (5 minutes by default) — retaining
   * memory and keeping the event loop alive in busy agent/proxy sessions.
   */
  private async _raceWithTimeout<T>(targetCall: Promise<T>, ms: number, targetName: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const humanMs = ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
        const typeLabel = targetName.includes(":") ? "Request" : "Tool";
        reject(
          new Error(
            `${typeLabel} "${targetName}" timed out after ${ms}ms (${humanMs}). ` +
              `Use --timeout <ms> to increase the limit.`,
          ),
        );
      }, ms);
    });
    try {
      return await Promise.race([targetCall, timeout]);
    } finally {
      clearTimeout(timer);
    }
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
