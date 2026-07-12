import type { Interface as ReadlineInterface } from "node:readline";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";

export interface CallRecord {
  toolName: string;
  durationMs: number;
  timestamp: number;
}

export interface TabCycleState {
  matches: string[];
  index: number;
  original: string;
}

export const KNOWN_COMMANDS = [
  "menu",
  "explore",
  "interactive",
  "view",
  "tools/list",
  "tools/describe",
  "tools/call",
  "tools/scaffold",
  "tools/forget",
  "find",
  "resources/list",
  "resources/read",
  "resources/templates",
  "resources/subscribe",
  "resources/unsubscribe",
  "prompts/list",
  "prompts/get",
  "ping",
  "log-level",
  "history",
  "notifications",
  "roots/list",
  "roots/add",
  "roots/remove",
  "timing",
  "status",
  "reconnect",
  "!!",
  "last",
  "help",
  "?",
  "exit",
  "quit",
  // Short aliases
  "tl",
  "td",
  "tc",
  "ts",
  "rl",
  "rr",
  "rt",
  "rs",
  "ru",
  "pl",
  "pg",
];

// Readline / Mode state
export let activeRl: ReadlineInterface | null = null;
export function setActiveRl(rl: ReadlineInterface | null) {
  activeRl = rl;
}

export let closed = false;
export function setClosed(val: boolean) {
  closed = val;
}

export let isScriptMode = false;
export function setIsScriptMode(val: boolean) {
  isScriptMode = val;
}

export let globalPauseReadlineClose = false;
export function setGlobalPauseReadlineClose(val: boolean) {
  globalPauseReadlineClose = val;
}

export let deferNextPrompt = false;
export function setDeferNextPrompt(val: boolean) {
  deferNextPrompt = val;
}

// Tab completion caches
export let cachedToolNames: string[] = [];
export function setCachedToolNames(names: string[]) {
  cachedToolNames = names;
}

export let cachedResourceUris: string[] = [];
export function setCachedResourceUris(uris: string[]) {
  cachedResourceUris = uris;
}

export let cachedPromptNames: string[] = [];
export function setCachedPromptNames(names: string[]) {
  cachedPromptNames = names;
}

export let activeCapabilities: ServerCapabilities | null = null;
export function setActiveCapabilities(caps: ServerCapabilities | null) {
  activeCapabilities = caps;
}

// Tab cycling state
export let tabCycleState: TabCycleState | null = null;
export function setTabCycleState(state: TabCycleState | null) {
  tabCycleState = state;
}

// Call history & Memory
export const callHistory: CallRecord[] = [];
export const lastToolArgsMap = new Map<string, Record<string, unknown>>();

// History file state
export let historyList: string[] = [];
export function setHistoryList(list: string[]) {
  historyList = list;
}
