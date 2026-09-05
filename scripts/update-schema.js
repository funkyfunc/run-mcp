import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DEST = join(__dirname, "../src/schema/mcp-schema.json");

/**
 * The revision the validator's ajv checks are pinned to.
 *
 * Deliberately NOT "latest": the validator checks the neutral result shapes the
 * SDK client hands back (it strips 2026-07-28 wire bookkeeping such as
 * `resultType` and the `_meta` envelope before results reach us), and those
 * shapes are the 2025-11-25 definitions on every era. Modern-era specifics
 * (server/discover, identity stamp, cache hints, listen) are checked through
 * the SDK's accessors instead. Bump this only together with the validator.
 */
const SCHEMA_VERSION = "2025-11-25";
const SCHEMA_URL = `https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/${SCHEMA_VERSION}/schema.json`;

async function main() {
  console.log(`Fetching MCP schema ${SCHEMA_VERSION}...`);
  const res = await fetch(SCHEMA_URL);
  if (!res.ok) throw new Error(`Failed to fetch ${SCHEMA_URL}: ${res.status} ${res.statusText}`);
  const schema = await res.json();
  await mkdir(dirname(SCHEMA_DEST), { recursive: true });
  await writeFile(SCHEMA_DEST, JSON.stringify(schema, null, 2) + "\n", "utf8");
  console.log(`Wrote ${SCHEMA_DEST}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
