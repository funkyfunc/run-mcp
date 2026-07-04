import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { RUN_MCP_DIR, ensureRunMcpDir } from "./history.js";
import { lastToolArgsMap } from "./state.js";

export const WIZARD_DEFAULTS_FILE = join(RUN_MCP_DIR, "wizard_defaults.json");

export async function loadWizardDefaults(): Promise<void> {
  await ensureRunMcpDir();
  if (existsSync(WIZARD_DEFAULTS_FILE)) {
    try {
      const content = await readFile(WIZARD_DEFAULTS_FILE, "utf8");
      const parsed = JSON.parse(content);
      lastToolArgsMap.clear();
      for (const [key, val] of Object.entries(parsed)) {
        lastToolArgsMap.set(key, val as Record<string, unknown>);
      }
    } catch {
      // Ignore
    }
  }
}

export async function saveWizardDefaults(): Promise<void> {
  await ensureRunMcpDir();
  try {
    const obj = Object.fromEntries(lastToolArgsMap.entries());
    await writeFile(WIZARD_DEFAULTS_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch {
    // Ignore
  }
}
