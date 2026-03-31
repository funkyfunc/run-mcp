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
