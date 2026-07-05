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
