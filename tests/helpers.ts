/**
 * Shared test fixture configuration.
 *
 * Uses `tsx` to run the TypeScript mock server directly — no separate
 * compilation step needed.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Path to the mock MCP server TypeScript source. */
export const MOCK_SERVER_PATH_TS = resolve(import.meta.dirname, "fixtures/mock-server.ts");
export const MOCK_SERVER_PATH_JS = resolve(import.meta.dirname, "fixtures/dist/mock-server.js");

/** Command to spawn the mock server. */
export const MOCK_SERVER_CMD = "node";

/** Args to pass to spawn the mock server. */
export const MOCK_SERVER_ARGS = existsSync(MOCK_SERVER_PATH_JS)
  ? [MOCK_SERVER_PATH_JS]
  : ["--import", "tsx", MOCK_SERVER_PATH_TS];

/** Path to the deliberately-hostile stdio server used for sandbox enforcement tests. */
export const VULN_SERVER_PATH_TS = resolve(
  import.meta.dirname,
  "fixtures/vulnerable-stdio-server.ts",
);
export const VULN_SERVER_PATH_JS = resolve(
  import.meta.dirname,
  "fixtures/dist/vulnerable-stdio-server.js",
);

export const VULN_SERVER_CMD = "node";
export const VULN_SERVER_ARGS = existsSync(VULN_SERVER_PATH_JS)
  ? [VULN_SERVER_PATH_JS]
  : ["--import", "tsx", VULN_SERVER_PATH_TS];

/** Path to the tool-poisoned server fixture (invisible chars + injection phrase). */
export const POISONED_SERVER_PATH_TS = resolve(import.meta.dirname, "fixtures/poisoned-server.ts");
export const POISONED_SERVER_PATH_JS = resolve(
  import.meta.dirname,
  "fixtures/dist/poisoned-server.js",
);
export const POISONED_SERVER_CMD = "node";
export const POISONED_SERVER_ARGS = existsSync(POISONED_SERVER_PATH_JS)
  ? [POISONED_SERVER_PATH_JS]
  : ["--import", "tsx", POISONED_SERVER_PATH_TS];

/** Path to the crash-on-demand fixture (proxy dead-backend tests). Runs via tsx. */
export const CRASHY_SERVER_PATH_TS = resolve(import.meta.dirname, "fixtures/crashy-server.ts");
export const CRASHY_SERVER_CMD = "node";
export const CRASHY_SERVER_ARGS = ["--import", "tsx", CRASHY_SERVER_PATH_TS];

// ─── Shared unit-test helpers ────────────────────────────────────────────────

import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

/** Mock TargetManager exposing a canned callTool response (unit tests). */
export function mockTarget(response: Record<string, unknown>) {
  return { callTool: vi.fn().mockResolvedValue(response) } as any;
}

/** Unique temp path (collision-safe across tests entering the same ms). */
export function tmpPath(prefix: string, ext = ""): string {
  return join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
}

/** Poll until `condition` returns truthy, or fail after `timeoutMs`. */
export async function waitFor<T>(
  condition: () => T | undefined | false,
  timeoutMs = 10_000,
  label = "condition",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = condition();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
