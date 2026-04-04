/**
 * Parsing utilities for the REPL command interface.
 *
 * Extracted into a separate module for testability.
 */

/**
 * Split input into a command name and the rest of the arguments.
 * Command names are case-insensitive.
 */
export function parseCommandLine(input: string): { cmd: string; rest: string } {
  const spaceIdx = input.indexOf(" ");
  if (spaceIdx === -1) {
    return { cmd: input.toLowerCase(), rest: "" };
  }
  return {
    cmd: input.slice(0, spaceIdx).toLowerCase(),
    rest: input.slice(spaceIdx + 1),
  };
}

/**
 * Parse `tools/call` arguments:
 *   <name> <json_args> [--timeout <ms>]
 *
 * Handles JSON that contains spaces by treating everything between the
 * tool name and an optional `--timeout` flag as the JSON body.
 */
export function parseCallArgs(rest: string): {
  toolName: string;
  jsonArgs: string;
  timeoutMs?: number;
} {
  const trimmed = rest.trim();
  if (!trimmed) return { toolName: "", jsonArgs: "" };

  // Extract tool name (first token)
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    return { toolName: trimmed, jsonArgs: "" };
  }

  const toolName = trimmed.slice(0, spaceIdx);
  let remainder = trimmed.slice(spaceIdx + 1).trim();

  // Extract --timeout if present at the end
  let timeoutMs: number | undefined;
  const timeoutMatch = remainder.match(/\s--timeout\s+(\d+)\s*$/);
  if (timeoutMatch) {
    timeoutMs = parseInt(timeoutMatch[1], 10);
    remainder = remainder.slice(0, timeoutMatch.index!).trim();
  }

  return { toolName, jsonArgs: remainder, timeoutMs };
}

/**
 * Pretty-print an object as indented JSON.
 */
export function formatJson(obj: unknown, indent: number = 2): string {
  const json = JSON.stringify(obj, null, indent);
  return json
    .split("\n")
    .map((line) => " ".repeat(indent) + line)
    .join("\n");
}

// ─── Typo Suggestion ────────────────────────────────────────────────────────

/**
 * Simple Levenshtein distance for short strings.
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }

  return dp[m][n];
}

/**
 * Suggest the closest command from a list if the distance is small enough.
 * Returns null if no good match is found.
 *
 * @param input - The unknown command the user typed
 * @param commands - List of known valid commands
 * @param threshold - Max edit distance as a fraction of input length (default 0.4 = 40%)
 */
export function suggestCommand(
  input: string,
  commands: string[],
  threshold: number = 0.4,
): string | null {
  let best: string | null = null;
  let bestDist = Infinity;

  for (const cmd of commands) {
    const dist = levenshtein(input, cmd);
    if (dist < bestDist) {
      bestDist = dist;
      best = cmd;
    }
  }

  if (best && bestDist <= Math.ceil(input.length * threshold)) {
    return best;
  }
  return null;
}

// ─── Argument Scaffolding ───────────────────────────────────────────────────

/**
 * Generate a JSON template from a tool's input schema.
 * Produces placeholder values for each property so the user
 * can fill in the blanks.
 */
export function scaffoldArgs(schema: Record<string, unknown>): string {
  return JSON.stringify(scaffoldObject(schema), null, 2);
}

function scaffoldValue(prop: Record<string, unknown>): unknown {
  switch (prop.type as string) {
    case "string":
      return "<string>";
    case "number":
    case "integer":
      return "<number>";
    case "boolean":
      return "<boolean>";
    case "array": {
      const items = prop.items as Record<string, unknown> | undefined;
      return items ? [scaffoldValue(items)] : ["<item>"];
    }
    case "object":
      return scaffoldObject(prop);
    default:
      return `<${prop.type ?? "unknown"}>`;
  }
}

function scaffoldObject(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return {};
  const result: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(properties)) {
    result[key] = scaffoldValue(prop);
  }
  return result;
}

// ─── Tool Description Formatting ────────────────────────────────────────────

interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/**
 * Format a tool's schema as a human-readable description with:
 * - Tool name + description header
 * - Argument table (name, type, required/optional, description)
 * - Auto-generated example command
 * - Annotations section if present
 */
export function formatToolDescription(tool: ToolInfo): string {
  const lines: string[] = [];

  // Header
  lines.push(`  ${tool.name}`);
  if (tool.description) {
    lines.push(`  ${tool.description}`);
  }

  // Arguments table
  const schema = tool.inputSchema ?? {};
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const required = (schema.required as string[]) ?? [];

  if (properties && Object.keys(properties).length > 0) {
    lines.push("");
    lines.push("  Arguments:");

    const nameWidth = Math.max(6, ...Object.keys(properties).map((n) => n.length));
    const typeWidth = Math.max(4, ...Object.values(properties).map((p) => typeLabel(p).length));

    for (const [name, prop] of Object.entries(properties)) {
      const type = typeLabel(prop);
      const req = required.includes(name) ? "(required)" : "(optional)";
      const desc = (prop.description as string) ?? "";
      lines.push(
        `    ${name.padEnd(nameWidth)}  ${type.padEnd(typeWidth)}  ${req.padEnd(10)}  ${desc}`,
      );
    }
  } else {
    lines.push("");
    lines.push("  No arguments required.");
  }

  // Example command
  lines.push("");
  lines.push("  Example:");

  if (properties && Object.keys(properties).length > 0) {
    const example = scaffoldObject(schema);
    lines.push(`    tools/call ${tool.name} ${JSON.stringify(example)}`);
  } else {
    lines.push(`    tools/call ${tool.name}`);
  }

  // Annotations
  if (tool.annotations && Object.keys(tool.annotations).length > 0) {
    lines.push("");
    lines.push("  Annotations:");
    const annotationParts: string[] = [];
    for (const [key, value] of Object.entries(tool.annotations)) {
      annotationParts.push(`${key}: ${value}`);
    }
    lines.push(`    ${annotationParts.join(", ")}`);
  }

  return lines.join("\n");
}

function typeLabel(prop: Record<string, unknown>): string {
  const type = prop.type as string | undefined;
  if (!type) return "any";
  if (type === "array") {
    const items = prop.items as Record<string, unknown> | undefined;
    return items ? `${typeLabel(items)}[]` : "array";
  }
  return type;
}

// ─── Tool Grouping ──────────────────────────────────────────────────────────

/**
 * Group tool names by common word prefix (splitting on `_`).
 *
 * Returns a Map of group label → tool names. Falls back to a
 * single "All" group if no meaningful groupings emerge
 * (fewer than 2 groups with ≥2 members each).
 */
export function groupToolsByPrefix(toolNames: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();

  for (const name of toolNames) {
    const underscoreIdx = name.indexOf("_");
    const prefix = underscoreIdx > 0 ? name.slice(0, underscoreIdx) : name;
    const list = groups.get(prefix) ?? [];
    list.push(name);
    groups.set(prefix, list);
  }

  // Check if groupings are meaningful (≥2 groups with ≥2 members)
  const meaningfulGroups = [...groups.entries()].filter(([, members]) => members.length >= 2);

  if (meaningfulGroups.length < 2) {
    // No meaningful grouping — return single flat group
    const all = new Map<string, string[]>();
    all.set("All", [...toolNames]);
    return all;
  }

  // Merge singleton groups into "Other"
  const result = new Map<string, string[]>();
  const other: string[] = [];

  for (const [prefix, members] of groups) {
    if (members.length >= 2) {
      // Capitalize the group label
      const label = prefix.charAt(0).toUpperCase() + prefix.slice(1);
      result.set(label, members);
    } else {
      other.push(...members);
    }
  }

  if (other.length > 0) {
    result.set("Other", other);
  }

  return result;
}

// ─── Logging Levels ─────────────────────────────────────────────────────────

/** Valid MCP logging levels (ordered by severity). */
export const LOG_LEVELS = [
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

// ─── Command Aliases ────────────────────────────────────────────────────────

const ALIASES: Record<string, string> = {
  tl: "tools/list",
  td: "tools/describe",
  tc: "tools/call",
  ts: "tools/scaffold",
  rl: "resources/list",
  rr: "resources/read",
  rt: "resources/templates",
  rs: "resources/subscribe",
  ru: "resources/unsubscribe",
  pl: "prompts/list",
  pg: "prompts/get",
};

/**
 * Expand a short alias to its full command.
 * Returns the expanded command string, or null if the input is not an alias.
 *
 * Examples:
 *   "tl"        → "tools/list"
 *   "td greet"  → "tools/describe greet"
 *   "tc echo {}" → "tools/call echo {}"
 *   "help"      → null (not an alias)
 */
export function resolveAlias(input: string): string | null {
  const spaceIdx = input.indexOf(" ");
  const token = spaceIdx === -1 ? input : input.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? "" : input.slice(spaceIdx);

  const expanded = ALIASES[token.toLowerCase()];
  if (!expanded) return null;

  return expanded + rest;
}
