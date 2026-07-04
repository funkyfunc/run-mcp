import { resolveAlias } from "../parsing.js";
import type { TargetManager } from "../target-manager.js";
import {
  activeCapabilities,
  activeRl,
  cachedPromptNames,
  cachedResourceUris,
  cachedToolNames,
  KNOWN_COMMANDS,
  tabCycleState,
  setTabCycleState,
  setCachedToolNames,
  setCachedResourceUris,
  setCachedPromptNames,
  setActiveCapabilities,
} from "./state.js";

export function resetTabCycle(): void {
  setTabCycleState(null);
}

export function getActiveCommands(): string[] {
  let commands = [...KNOWN_COMMANDS];
  if (!activeCapabilities?.resources) {
    commands = commands.filter(
      (c) => !c.startsWith("resources/") && !["rl", "rr", "rt", "rs", "ru"].includes(c),
    );
  }
  if (!activeCapabilities?.prompts) {
    commands = commands.filter((c) => !c.startsWith("prompts/") && !["pl", "pg"].includes(c));
  }
  return commands;
}

/**
 * Compute raw completion matches for a given line.
 * Extracted so the completer can call it without side effects.
 */
export function computeMatches(line: string): [string[], string] {
  // Expand alias before attempting completion
  const expanded = resolveAlias(line);
  const effective = expanded ?? line;

  // Tool-name completion for tools/call, tools/describe, tools/scaffold
  for (const prefix of ["tools/call ", "tools/describe ", "tools/scaffold "]) {
    if (effective.startsWith(prefix)) {
      const partial = effective.slice(prefix.length).split(" ")[0];
      const matches = cachedToolNames.filter((n) => n.startsWith(partial));
      return [matches.map((m) => `${prefix}${m}`), effective];
    }
  }

  // Resource URI completion for resources/read
  if (effective.startsWith("resources/read ")) {
    const partial = effective.slice("resources/read ".length);
    const matches = cachedResourceUris.filter((u) => u.startsWith(partial));
    return [matches.map((m) => `resources/read ${m}`), effective];
  }

  // Prompt name completion for prompts/get
  if (effective.startsWith("prompts/get ")) {
    const partial = effective.slice("prompts/get ".length).split(" ")[0];
    const matches = cachedPromptNames.filter((n) => n.startsWith(partial));
    return [matches.map((m) => `prompts/get ${m}`), effective];
  }

  // Command-level completion
  const matches = getActiveCommands().filter((c) => c.startsWith(line));
  return [matches, line];
}

/**
 * Readline completer with menu-complete style tab cycling.
 *
 * First tab: shows all matches (default readline behavior).
 * Subsequent tabs: cycles through matches one by one, replacing the line.
 */
export const completer = (line: string): [string[], string] => {
  // If we're in a tab-cycling session, cycle to the next match
  if (tabCycleState) {
    const inCycle = line === tabCycleState.original || tabCycleState.matches.includes(line);

    if (inCycle) {
      const nextIndex = (tabCycleState.index + 1) % tabCycleState.matches.length;
      setTabCycleState({
        ...tabCycleState,
        index: nextIndex,
      });
      const next = tabCycleState.matches[nextIndex];

      // Replace the line content after readline finishes processing
      setImmediate(() => {
        if (activeRl) {
          (activeRl as any).line = next;
          (activeRl as any).cursor = next.length;
          (activeRl as any)._refreshLine();
        }
      });

      // Return empty so readline doesn't print the matches again
      return [[], ""];
    }

    // Line changed to something unexpected — reset and do fresh completion
    setTabCycleState(null);
  }

  // Normal completion
  const [matches, matchLine] = computeMatches(line);

  // Multiple matches → initialize cycling for the next tab press
  if (matches.length > 1) {
    setTabCycleState({ matches, index: -1, original: line });
  }

  return [matches, matchLine];
};

export async function refreshCaches(target: TargetManager): Promise<void> {
  const caps = target.getServerCapabilities() ?? {};
  setActiveCapabilities(caps);

  try {
    const { tools } = await target.listTools();
    setCachedToolNames(tools.map((t) => t.name));
  } catch {
    /* ignore */
  }

  if (caps.resources) {
    try {
      const { resources } = await target.listResources();
      setCachedResourceUris(resources.map((r: any) => r.uri));
    } catch {
      /* ignore */
    }
  }

  if (caps.prompts) {
    try {
      const { prompts } = await target.listPrompts();
      setCachedPromptNames(prompts.map((p) => p.name));
    } catch {
      /* ignore */
    }
  }
}
