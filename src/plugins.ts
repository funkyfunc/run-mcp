/**
 * Interceptor plugin framework.
 *
 * The `ResponseInterceptor` runs an ordered list of plugins over the messages
 * flowing between an MCP client and the target server. This is the substrate for
 * cross-cutting concerns that the MCP protocol has no native hook for
 * (the "interceptor framework gap"): tool-poisoning detection, DLP/redaction,
 * audit logging, and lazy schema loading.
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

// ─── Invisible / dangerous Unicode ──────────────────────────────────────────

/**
 * Code points that are invisible or can hide/rewrite text, and therefore make
 * excellent carriers for hidden prompt-injection instructions in tool metadata.
 * Includes zero-width chars, the BOM/word-joiner, soft hyphen, bidi overrides,
 * and the Unicode Tag block (U+E0000–U+E007F) which encodes invisible ASCII.
 */
function isDangerousInvisible(code: number): boolean {
  return (
    code === 0x00ad || // soft hyphen
    code === 0x061c || // arabic letter mark
    code === 0x180e || // mongolian vowel separator
    code === 0x200b || // zero-width space
    code === 0x200c || // zero-width non-joiner
    code === 0x200d || // zero-width joiner
    code === 0x2060 || // word joiner
    code === 0xfeff || // BOM / zero-width no-break space
    (code >= 0x202a && code <= 0x202e) || // bidi embeddings/overrides
    (code >= 0x2066 && code <= 0x2069) || // bidi isolates
    (code >= 0xe0000 && code <= 0xe007f) // Unicode Tag block (invisible ASCII smuggling)
  );
}

/** Strip dangerous invisible code points from a string; report how many were removed. */
export function stripInvisible(input: string): { clean: string; removed: number } {
  let clean = "";
  let removed = 0;
  for (const ch of input) {
    const code = ch.codePointAt(0)!;
    if (isDangerousInvisible(code)) {
      removed++;
      continue;
    }
    clean += ch;
  }
  return { clean, removed };
}

// ─── Prompt-injection phrase heuristics ─────────────────────────────────────

/**
 * Phrases commonly used in tool-poisoning / prompt-injection payloads embedded
 * in tool descriptions. Matches are surfaced as findings (report-only by
 * default) rather than deleted, to avoid corrupting legitimately-worded tools.
 */
const INJECTION_PATTERNS: { pattern: RegExp; label: string }[] = [
  {
    pattern: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions/i,
    label: "ignore-previous-instructions",
  },
  {
    pattern: /disregard\s+(?:the\s+)?(?:above|previous|prior|system)/i,
    label: "disregard-directive",
  },
  {
    pattern: /(?:do not|don't|never)\s+(?:tell|mention|inform|reveal to)\s+the\s+user/i,
    label: "conceal-from-user",
  },
  {
    pattern: /<\s*(?:important|system|secret|instructions?)\s*>/i,
    label: "hidden-instruction-tag",
  },
  { pattern: /you\s+must\s+(?:always|first|immediately)/i, label: "imperative-override" },
  { pattern: /system\s+prompt/i, label: "system-prompt-reference" },
  { pattern: /\b(?:exfiltrate|exfiltration)\b/i, label: "exfiltration-keyword" },
  {
    pattern:
      /read\s+(?:the\s+)?(?:file|contents?)\s+.{0,40}(?:\.ssh|\.aws|\.env|id_rsa|credentials)/i,
    label: "credential-access-instruction",
  },
];

/** Scan text for injection phrases, returning matched labels. */
export function findInjectionPhrases(text: string): string[] {
  const hits: string[] = [];
  for (const { pattern, label } of INJECTION_PATTERNS) {
    if (pattern.test(text)) hits.push(label);
  }
  return hits;
}

// ─── Tool-poisoning scanner plugin ──────────────────────────────────────────

/**
 * Scans `tools/list` metadata (names, descriptions, and nested inputSchema
 * descriptions) for tool-poisoning vectors:
 *   - invisible/bidi/tag Unicode → stripped (high confidence, safe), and
 *   - known prompt-injection phrases → flagged as findings (text preserved).
 *
 * The stripping mutates the tool definitions the consumer sees; the phrase
 * flags are reported so callers can warn the agent/user or log them.
 */
export function toolPoisoningScanner(): InterceptorPlugin {
  const scanString = (value: string, location: string, report: ReportFn): string => {
    const { clean, removed } = stripInvisible(value);
    if (removed > 0) {
      report({
        plugin: "tool-poisoning-scanner",
        severity: "critical",
        message: `Removed ${removed} invisible/bidi character(s) — a common vector for hiding injected instructions`,
        location,
      });
    }
    const phrases = findInjectionPhrases(clean);
    if (phrases.length > 0) {
      report({
        plugin: "tool-poisoning-scanner",
        severity: "warning",
        message: `Possible prompt-injection phrasing (${phrases.join(", ")})`,
        location,
      });
    }
    return clean;
  };

  const scanSchema = (schema: unknown, location: string, report: ReportFn): void => {
    if (!schema || typeof schema !== "object") return;
    const obj = schema as Record<string, unknown>;
    if (typeof obj.description === "string") {
      obj.description = scanString(obj.description, `${location}.description`, report);
    }
    const props = obj.properties as Record<string, unknown> | undefined;
    if (props && typeof props === "object") {
      for (const [key, val] of Object.entries(props)) {
        scanSchema(val, `${location}.${key}`, report);
      }
    }
    // Recurse into common nested schema keywords.
    for (const keyword of ["items", "additionalProperties"]) {
      if (obj[keyword] && typeof obj[keyword] === "object") {
        scanSchema(obj[keyword], `${location}.${keyword}`, report);
      }
    }
  };

  return {
    name: "tool-poisoning-scanner",
    onToolsList(tools, report) {
      for (const tool of tools) {
        const loc = tool.name || "(unnamed tool)";
        if (typeof tool.name === "string") {
          tool.name = scanString(tool.name, `${loc}.name`, report);
        }
        if (typeof tool.description === "string") {
          tool.description = scanString(tool.description, `${loc}.description`, report);
        }
        if (tool.inputSchema) {
          scanSchema(tool.inputSchema, `${loc}.inputSchema`, report);
        }
      }
      return tools;
    },
  };
}

// ─── DLP / secret redaction plugin ──────────────────────────────────────────

/**
 * High-confidence secret patterns. Deliberately conservative (recognizable
 * prefixes / structured formats) to keep false positives low — the cost of a
 * missed generic secret is lower than corrupting legitimate tool output.
 */
const SECRET_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "aws-access-key-id", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { label: "github-fine-grained-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { label: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { label: "openai-key", pattern: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { label: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: "stripe-secret-key", pattern: /\b[rs]k_live_[0-9a-zA-Z]{24,}\b/g },
  { label: "jwt", pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  {
    label: "private-key-block",
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
];

const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

export interface RedactionOptions {
  /** Also redact email addresses (PII). Off by default — higher false-positive risk. */
  redactEmails?: boolean;
}

/** Redact secrets in a string; returns the cleaned text and a per-label hit count. */
export function redactSecrets(
  input: string,
  options: RedactionOptions = {},
): { clean: string; hits: Record<string, number> } {
  const hits: Record<string, number> = {};
  let clean = input;
  const all = options.redactEmails
    ? [...SECRET_PATTERNS, { label: "email", pattern: EMAIL_PATTERN }]
    : SECRET_PATTERNS;
  for (const { label, pattern } of all) {
    clean = clean.replace(pattern, () => {
      hits[label] = (hits[label] ?? 0) + 1;
      return `[REDACTED:${label}]`;
    });
  }
  return { clean, hits };
}

/**
 * Redacts secrets/PII from tool, resource, and prompt result text before it
 * reaches the consumer's context — the "output transformation" gap. Opt-in
 * because it mutates result content (a legitimate secrets-manager MCP would not
 * want this).
 */
export function secretRedactionPlugin(options: RedactionOptions = {}): InterceptorPlugin {
  const redactItems = (items: unknown, report: ReportFn, location: string): void => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (item && typeof item === "object" && typeof (item as any).text === "string") {
        const { clean, hits } = redactSecrets((item as any).text, options);
        if (Object.keys(hits).length > 0) {
          (item as any).text = clean;
          const summary = Object.entries(hits)
            .map(([k, n]) => `${k}×${n}`)
            .join(", ");
          report({
            plugin: "secret-redaction",
            severity: "warning",
            message: `Redacted secrets from output (${summary})`,
            location,
          });
        }
      }
    }
  };

  return {
    name: "secret-redaction",
    onToolResult(result, ctx) {
      redactItems((result as any).content, ctx.report, ctx.name ?? "tool");
      return result;
    },
    onResourceResult(result, ctx) {
      redactItems((result as any).contents, ctx.report, ctx.name ?? "resource");
      return result;
    },
    onPromptResult(result, ctx) {
      const messages = (result as any).messages;
      if (Array.isArray(messages)) {
        for (const msg of messages) {
          const content = msg?.content;
          if (Array.isArray(content)) redactItems(content, ctx.report, ctx.name ?? "prompt");
          else if (content && typeof content === "object") {
            redactItems([content], ctx.report, ctx.name ?? "prompt");
          }
        }
      }
      return result;
    },
  };
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
