import { readFile, mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const RUN_MCP_DIR = join(homedir(), ".run-mcp");
export const HISTORY_FILE = join(RUN_MCP_DIR, "history");

export const replHistory: string[] = [];

export async function ensureRunMcpDir(): Promise<void> {
  try {
    await mkdir(RUN_MCP_DIR, { recursive: true });
  } catch {
    // Ignore
  }
}

export async function loadHistory(): Promise<void> {
  await ensureRunMcpDir();
  if (existsSync(HISTORY_FILE)) {
    try {
      const content = await readFile(HISTORY_FILE, "utf8");
      const lines = content
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      replHistory.length = 0;
      replHistory.push(...lines);
    } catch {
      // Ignore
    }
  }
}

export async function appendToHistoryFile(line: string): Promise<void> {
  await ensureRunMcpDir();
  try {
    await appendFile(HISTORY_FILE, line + "\n", "utf8");
  } catch {
    // Ignore
  }
}
