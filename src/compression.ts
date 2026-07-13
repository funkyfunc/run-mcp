/**
 * Pure helpers for the compressing proxy (Stage B).
 *
 * Implements the Atlassian `mcp-compressor` "discovery on demand" surface in
 * dependency-free TypeScript: a backend's full tool catalog is replaced with two
 * wrapper tools (`get_tool_schema` + `invoke_tool`, plus `list_tools` at `max`),
 * and the compact catalog is embedded in `get_tool_schema`'s description as
 * `<tool>name(args): summary</tool>` lines. The model reads that, fetches one
 * full schema on demand, then invokes. See docs/research + the cloned reference
 * repo at `.invisible/mcp-compressor`.
 */

export type CompressionLevel = "low" | "medium" | "high" | "max";

export const COMPRESSION_LEVELS: CompressionLevel[] = ["low", "medium", "high", "max"];
export const DEFAULT_COMPRESSION_LEVEL: CompressionLevel = "medium";

export interface BackendTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  [key: string]: unknown;
}

/** `name(arg1, arg2)` from the input schema's property keys (in declared order). */
export function toolSignature(tool: BackendTool): string {
  const props = (tool.inputSchema?.properties ?? {}) as Record<string, unknown>;
  const args = Object.keys(props);
  return `${tool.name}(${args.join(", ")})`;
}

/** Abbreviations whose trailing period does not end a sentence. */
const NON_SENTENCE_ENDERS = new Set(["e.g", "i.e", "etc", "vs", "cf", "al", "approx", "incl"]);

/**
 * First sentence of a description (up to and excluding its ending period).
 * A period only ends a sentence when followed by whitespace (or end of text) —
 * so "v1.2", URLs, and filenames don't truncate — and not when it terminates a
 * common abbreviation ("e.g.", "etc."). Every medium-level catalog entry flows
 * through this, so a naive first-`.` split quietly degrades the primary
 * surface agents read.
 */
export function firstSentence(description: string): string {
  const trimmed = description.trim();
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] !== ".") continue;
    const next = trimmed[i + 1];
    if (next !== undefined && next !== " " && next !== "\t" && next !== "\n") continue;
    const wordStart = Math.max(
      trimmed.lastIndexOf(" ", i - 1),
      trimmed.lastIndexOf("\t", i - 1),
      trimmed.lastIndexOf("\n", i - 1),
      trimmed.lastIndexOf("(", i - 1),
    );
    const word = trimmed.slice(wordStart + 1, i).toLowerCase();
    if (NON_SENTENCE_ENDERS.has(word)) continue;
    return trimmed.slice(0, i);
  }
  return trimmed;
}

/** A single `<tool>…</tool>` catalog entry at the given compression level. */
export function formatCatalogEntry(tool: BackendTool, level: CompressionLevel): string {
  const desc = tool.description ?? "";
  switch (level) {
    case "low":
      return `<tool>${toolSignature(tool)}${desc ? `: ${desc.trim()}` : ""}</tool>`;
    case "medium": {
      const s = firstSentence(desc);
      return `<tool>${toolSignature(tool)}${s ? `: ${s}` : ""}</tool>`;
    }
    case "high":
      return `<tool>${toolSignature(tool)}</tool>`;
    case "max":
      return `<tool>${tool.name}</tool>`;
  }
}

/** Newline-joined catalog of all tools at the given level. */
export function buildCatalog(tools: BackendTool[], level: CompressionLevel): string {
  return tools.map((t) => formatCatalogEntry(t, level)).join("\n");
}

/**
 * Description for the `get_tool_schema` wrapper tool. At low/medium/high the
 * compact catalog is embedded here (so the model sees it up front). At `max` the
 * catalog is withheld — the model must call `list_tools` first.
 */
export function getToolSchemaDescription(tools: BackendTool[], level: CompressionLevel): string {
  const base = "Get the complete schema and description for one tool by name.";
  if (level === "max") {
    return `${base} Call list_tools first to enumerate available tool names.`;
  }
  return `${base} Available tools:\n${buildCatalog(tools, level)}`;
}

/** The `get_tool_schema` response for one tool: full description + full JSON Schema. */
export function formatSchemaResponse(tool: BackendTool): string {
  const desc = tool.description ? `: ${tool.description.trim()}` : "";
  const schema = JSON.stringify(tool.inputSchema ?? { type: "object" }, null, 2);
  return `<tool>${toolSignature(tool)}${desc}</tool>\n\n${schema}`;
}

/**
 * Flatten a backend tool-call result into a single string for the proxy response.
 * Prefers MCP `content` text parts; unwraps a lone `{ result }`; else JSON.
 */
export function flattenToolResult(value: unknown): string {
  if (typeof value === "string") return value;
  const unwrapped = unwrapSingleResult(value);
  if (typeof unwrapped === "string") return unwrapped;
  const text = mcpTextContent(unwrapped);
  if (text !== undefined) return text;
  return JSON.stringify(unwrapped);
}

function unwrapSingleResult(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length === 1 && entries[0][0] === "result" ? entries[0][1] : value;
}

function mcpTextContent(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const c = item as { type?: unknown; text?: unknown };
    return c.type === "text" && typeof c.text === "string" ? [c.text] : [];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * When the model passes a JSON string for an argument whose schema expects an
 * object/array, parse it. Leaves anything else untouched.
 */
export function coerceStructuredArgs(
  schema: Record<string, unknown> | undefined,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const props = schema?.properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) return input;
  const out: Record<string, unknown> = { ...input };
  for (const [key, propSchema] of Object.entries(props as Record<string, unknown>)) {
    const value = out[key];
    if (typeof value !== "string" || !expectsStructured(propSchema)) continue;
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
    try {
      out[key] = JSON.parse(trimmed);
    } catch {
      // Leave the original string for downstream validation to report.
    }
  }
  return out;
}

function expectsStructured(schema: unknown): boolean {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  const type = (schema as { type?: unknown }).type;
  if (type === "object" || type === "array") return true;
  return Array.isArray(type) && (type.includes("object") || type.includes("array"));
}

/** Separator between a backend prefix and a tool name (`best_browser__navigate`). */
export const NAMESPACE_SEP = "__";

/** Build a namespaced tool name for a backend. */
export function namespaceToolName(prefix: string, toolName: string): string {
  return `${prefix}${NAMESPACE_SEP}${toolName}`;
}

/** Split a namespaced tool name into `{ prefix, tool }` (on the first separator). */
export function parseNamespacedName(name: string): { prefix: string; tool: string } | undefined {
  const idx = name.indexOf(NAMESPACE_SEP);
  if (idx <= 0) return undefined;
  return { prefix: name.slice(0, idx), tool: name.slice(idx + NAMESPACE_SEP.length) };
}

/**
 * Normalize a server name for use as a tool-name prefix. Underscore runs are
 * collapsed so a prefix can never contain the `__` namespace separator — a
 * config name like "my__server" would otherwise produce namespaced names that
 * `parseNamespacedName` splits at the wrong boundary.
 */
export function normalizeServerName(name: string | undefined): string {
  const value = name ?? "tools";
  const normalized = value
    .replace(/[^A-Za-z0-9_]+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();
  return normalized || "tools";
}

/**
 * Ceiling for a catalog embedded in a tool description (~4k tokens). Past it,
 * the catalog would consume more context than the compression saves.
 */
export const MAX_CATALOG_CHARS = 16_000;

/**
 * Pick the compression level that actually fits: starting from the requested
 * level, escalate (medium → high → max) until the catalog is under `maxChars`.
 * A 300-tool backend at `medium` can otherwise produce a `get_tool_schema`
 * description bigger than the problem being solved. Callers should log when
 * `escalated` is true so the level change isn't silent.
 */
export function fitCatalogLevel(
  tools: BackendTool[],
  requested: CompressionLevel,
  maxChars: number = MAX_CATALOG_CHARS,
): { level: CompressionLevel; escalated: boolean } {
  let idx = COMPRESSION_LEVELS.indexOf(requested);
  let level = requested;
  while (idx < COMPRESSION_LEVELS.length - 1 && buildCatalog(tools, level).length > maxChars) {
    idx++;
    level = COMPRESSION_LEVELS[idx];
  }
  return { level, escalated: level !== requested };
}

/** Apply include/exclude filters to the tool set before compression. */
export function applyToolFilters(
  tools: BackendTool[],
  filters: { include?: string[]; exclude?: string[] } = {},
): BackendTool[] {
  let out = tools;
  if (filters.include && filters.include.length > 0) {
    const set = new Set(filters.include);
    out = out.filter((t) => set.has(t.name));
  }
  if (filters.exclude && filters.exclude.length > 0) {
    const set = new Set(filters.exclude);
    out = out.filter((t) => !set.has(t.name));
  }
  return out;
}
