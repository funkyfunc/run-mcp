/**
 * Shared test fixture configuration.
 *
 * Uses `tsx` to run the TypeScript mock server directly — no separate
 * compilation step needed.
 */
import { resolve } from "node:path";

/** Path to the mock MCP server TypeScript source. */
export const MOCK_SERVER_PATH = resolve(import.meta.dirname, "fixtures/mock-server.ts");

/** Command to spawn the mock server (uses tsx for TypeScript execution). */
export const MOCK_SERVER_CMD = "node";

/** Args to pass to spawn the mock server. */
export const MOCK_SERVER_ARGS = ["--import", "tsx", MOCK_SERVER_PATH];
