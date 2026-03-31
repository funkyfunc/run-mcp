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
