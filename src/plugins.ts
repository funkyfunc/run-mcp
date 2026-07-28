/**
 * Interceptor plugin framework.
 *
 * The `ResponseInterceptor` runs an ordered list of plugins over the messages
 * flowing between an MCP client and the target server. This is the substrate for
 * cross-cutting transformations of tool metadata and results that the MCP
 * protocol has no native hook for.
 *
 * A plugin implements any subset of the hooks. Each hook receives a `report`
 * callback for surfacing findings and returns the (possibly transformed) value.
 * Hooks may be async. Plugins run in registration order; each sees the output of
 * the previous one.
 */

export interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  [key: string]: unknown;
}

export type FindingSeverity = "info" | "warning" | "critical";

export interface PluginFinding {
  /** Name of the plugin that produced the finding. */
  plugin: string;
  severity: FindingSeverity;
  /** Human-readable description of what was detected. */
  message: string;
  /** Where it was found — a tool name, resource URI, "result", etc. */
  location?: string;
}

export type ReportFn = (finding: PluginFinding) => void;

/** A single content item in a tool/resource/prompt result. */
export interface PluginContentContext {
  primitive: "tool" | "resource" | "prompt";
  /** Tool name, resource URI, or prompt name. */
  name?: string;
  report: ReportFn;
}

export interface InterceptorPlugin {
  name: string;
  /**
   * Inspect/transform a `tools/list` response before it reaches the consumer.
   * The canonical hook for tool-poisoning defense.
   */
  onToolsList?(tools: ToolDef[], report: ReportFn): ToolDef[] | Promise<ToolDef[]>;
  /** Inspect/transform a tool call result (post media/truncation handling). */
  onToolResult?(
    result: Record<string, unknown>,
    ctx: PluginContentContext,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Inspect/transform a resource read result. */
  onResourceResult?(
    result: Record<string, unknown>,
    ctx: PluginContentContext,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Inspect/transform a prompt get result. */
  onPromptResult?(
    result: Record<string, unknown>,
    ctx: PluginContentContext,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
}

// ─── Output compression plugin ──────────────────────────────────────────────

export interface CompressionOptions {
  /**
   * Also collapse blank-line runs and trailing line whitespace in non-JSON text.
   * Off by default: it can be lossy for whitespace-significant content (code,
   * markdown, fixed-width data), so it is opt-in.
   */
  aggressive?: boolean;
}

/**
 * Compress a single text payload deterministically. Returns the original string
 * unchanged unless a strictly shorter, safe representation is found.
 *
 *  - **Lossless (always):** if the text is a JSON object/array, re-serialize it
 *    minified. The parsed value is identical; only insignificant whitespace is
 *    removed — a large win on pretty-printed API/tool output.
 *  - **Aggressive (opt-in):** collapse runs of blank lines and strip trailing
 *    line whitespace on non-JSON text.
 *  - **Inflation guard (always):** never return something longer than the input.
 *    Character length is used as a dependency-free proxy for token count.
 */
export function compressText(
  input: string,
  options: CompressionOptions = {},
): { text: string; savedChars: number } {
  let best = input;

  const trimmed = input.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        const minified = JSON.stringify(parsed);
        if (minified.length < best.length) best = minified;
      }
    } catch {
      // Not valid JSON — leave it to the aggressive pass (if enabled).
    }
  }

  if (options.aggressive) {
    const collapsed = input
      .split("\n")
      .map((line) => line.replace(/[ \t]+$/, ""))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");
    if (collapsed.length < best.length) best = collapsed;
  }

  // Inflation guard: only accept a strictly shorter result.
  if (best.length >= input.length) return { text: input, savedChars: 0 };
  return { text: best, savedChars: input.length - best.length };
}

/**
 * Shrinks verbose tool/resource/prompt *output* text before it reaches the
 * consumer's context — the "Tools Tax" output side. Opt-in because it changes the
 * exact bytes the consumer sees (though not the parsed JSON value in the default
 * lossless mode).
 */
export function outputCompressionPlugin(options: CompressionOptions = {}): InterceptorPlugin {
  const compressItems = (items: unknown, report: ReportFn, location: string): void => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (item && typeof item === "object" && typeof (item as any).text === "string") {
        const original = (item as any).text as string;
        const { text, savedChars } = compressText(original, options);
        if (savedChars > 0) {
          (item as any).text = text;
          const pct = Math.round((savedChars / original.length) * 100);
          report({
            plugin: "output-compression",
            severity: "info",
            message: `Compressed output ${original.length}→${text.length} chars (${pct}% saved)`,
            location,
          });
        }
      }
    }
  };

  return {
    name: "output-compression",
    onToolResult(result, ctx) {
      compressItems((result as any).content, ctx.report, ctx.name ?? "tool");
      return result;
    },
    onResourceResult(result, ctx) {
      compressItems((result as any).contents, ctx.report, ctx.name ?? "resource");
      return result;
    },
    onPromptResult(result, ctx) {
      const messages = (result as any).messages;
      if (Array.isArray(messages)) {
        for (const msg of messages) {
          const content = msg?.content;
          if (Array.isArray(content)) compressItems(content, ctx.report, ctx.name ?? "prompt");
          else if (content && typeof content === "object") {
            compressItems([content], ctx.report, ctx.name ?? "prompt");
          }
        }
      }
      return result;
    },
  };
}
