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
