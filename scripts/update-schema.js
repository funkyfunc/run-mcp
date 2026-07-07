import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DEST = join(__dirname, "../src/schema/mcp-schema.json");

// Known stable fallback URL in case GitHub REST API rate-limits us
const FALLBACK_VERSION = "2024-11-05";
const FALLBACK_URL = `https://raw.githubusercontent.com/modelcontextprotocol/specification/main/schema/${FALLBACK_VERSION}/schema.json`;

async function fetchLatestSchema() {
  console.log("Fetching latest schema directory from GitHub...");
  try {
    const res = await fetch("https://api.github.com/repos/modelcontextprotocol/specification/contents/schema", {
      headers: {
        "User-Agent": "run-mcp-schema-updater (https://github.com/funkyfunc/run-mcp)",
      },
    });

    if (!res.ok) {
      throw new Error(`GitHub API returned status ${res.status}: ${res.statusText}`);
    }

    const items = await res.json();
    if (!Array.isArray(items)) {
      throw new Error("Invalid response format from GitHub contents API");
    }

    // Filter for directory items and sort alphabetically (prioritizing date-based YYYY-MM-DD versions)
    const dirs = items
      .filter((item) => item.type === "dir" && /^\d{4}-\d{2}-\d{2}$/.test(item.name))
      .map((item) => item.name)
      .sort();

    if (dirs.length === 0) {
      throw new Error("No schema folders found in the specification repository");
    }

    const latestDir = dirs[dirs.length - 1];
    console.log(`Latest schema version found: ${latestDir}`);

    const schemaUrl = `https://raw.githubusercontent.com/modelcontextprotocol/specification/main/schema/${latestDir}/schema.json`;
    console.log(`Downloading schema from: ${schemaUrl}`);

    const schemaRes = await fetch(schemaUrl);
    if (!schemaRes.ok) {
      throw new Error(`Failed to download schema: ${schemaRes.status} ${schemaRes.statusText}`);
    }

    const schemaJson = await schemaRes.json();
    return { version: latestDir, schema: schemaJson };
  } catch (err) {
    console.warn(`\n⚠️  Warning: Failed to fetch dynamically via GitHub API (${err.message}).`);
    console.log(`Attempting fallback direct download from: ${FALLBACK_URL}`);

    const schemaRes = await fetch(FALLBACK_URL);
    if (!schemaRes.ok) {
      throw new Error(`Failed to download fallback schema: ${schemaRes.status} ${schemaRes.statusText}`);
    }

    const schemaJson = await schemaRes.json();
    return { version: FALLBACK_VERSION, schema: schemaJson };
  }
}

async function main() {
  try {
    const { version, schema } = await fetchLatestSchema();
    const newContent = JSON.stringify(schema, null, 2);

    // Ensure output directory exists
    await mkdir(dirname(SCHEMA_DEST), { recursive: true });

    let isNew = false;
    let oldContent = "";

    try {
      oldContent = await readFile(SCHEMA_DEST, "utf8");
    } catch {
      isNew = true;
    }

    if (!isNew && oldContent === newContent) {
      console.log(`\n✓ Local schema is already up to date with version ${version}.`);
      return;
    }

    await writeFile(SCHEMA_DEST, newContent, "utf8");

    if (isNew) {
      console.log(`\n✓ Successfully vended new MCP schema (version ${version}) to: ${SCHEMA_DEST}`);
    } else {
      const oldSize = Buffer.byteLength(oldContent, "utf8");
      const newSize = Buffer.byteLength(newContent, "utf8");
      console.log(`\n✓ Successfully updated MCP schema (version ${version})!`);
      console.log(`  Size changed: ${oldSize} bytes -> ${newSize} bytes`);
    }
  } catch (err) {
    console.error(`\n✗ Error updating schema: ${err.message}`);
    process.exit(1);
  }
}

main();
