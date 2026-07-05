import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const readmePath = resolve(import.meta.dirname, "../README.md");

// 1. Run the built CLI with --help to collect the source-of-truth text
let helpOutput;
try {
  helpOutput = execSync("node dist/index.js --help", { encoding: "utf8" });
} catch (err) {
  console.error("Error executing CLI help:", err);
  process.exit(1);
}

// 2. Helper to extract sections from the commander help output
function extractSection(text, header) {
  const index = text.indexOf(header);
  if (index === -1) return "";
  const start = index + header.length;
  const remaining = text.slice(start);
  
  // Find the next header starting with a capital letter and ending with a colon
  const nextHeaderMatch = remaining.match(/\n\n([A-Z][a-zA-Z\s\-()]+:)/);
  if (nextHeaderMatch) {
    return remaining.slice(0, nextHeaderMatch.index).trim();
  }
  return remaining.trim();
}

// 3. Formatters to convert plain text help into Markdown elements
function formatOptionsTable(rawOptions) {
  const lines = rawOptions.split("\n");
  const rows = [
    "| Option | Description |",
    "| :--- | :--- |"
  ];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s{2,}/);
    if (parts.length >= 2) {
      const opt = parts[0].trim();
      const desc = parts.slice(1).join(" ").trim();
      rows.push(`| \`${opt}\` | ${desc} |`);
    } else {
      rows.push(`| \`${trimmed}\` | |`);
    }
  }
  return rows.join("\n");
}

function formatSubcommandsList(rawCommands) {
  const lines = rawCommands.split("\n");
  const list = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s{2,}/);
    const cmdSignature = parts[0].trim();
    list.push(`- \`${cmdSignature}\``);
  }
  return list.join("\n");
}

function formatAgentToolsTable(rawTools) {
  const lines = rawTools.split("\n");
  const rows = [
    "| Tool | Description |",
    "| :--- | :--- |"
  ];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.includes("→") ? trimmed.split("→") : trimmed.split(/\s{2,}/);
    if (parts.length >= 2) {
      const tool = parts[0].trim();
      const desc = parts.slice(1).join(" ").trim();
      rows.push(`| \`${tool}\` | ${desc} |`);
    } else {
      rows.push(`| \`${trimmed}\` | |`);
    }
  }
  return rows.join("\n");
}

function formatReplCommandsTable(rawCommands) {
  const lines = rawCommands.split("\n");
  const rows = [
    "| Command | Description |",
    "| :--- | :--- |"
  ];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s{2,}/);
    if (parts.length >= 2) {
      const cmd = parts[0].trim();
      const desc = parts.slice(1).join(" ").trim();
      rows.push(`| \`${cmd}\` | ${desc} |`);
    } else {
      rows.push(`| \`${trimmed}\` | |`);
    }
  }
  return rows.join("\n");
}

// 4. Extract options, subcommands, tools, and commands
const rawOptions = extractSection(helpOutput, "Options:");
const rawCommands = extractSection(helpOutput, "Commands:");
const rawAgentTools = extractSection(helpOutput, "Agent Mode Tools:");
const rawReplCommands = extractSection(helpOutput, "REPL Mode Commands (once connected):");

// 5. Generate Markdown
const optionsMarkdown = formatOptionsTable(rawOptions);
const subcommandsMarkdown = formatSubcommandsList(rawCommands);
const agentToolsMarkdown = formatAgentToolsTable(rawAgentTools);
const replCommandsMarkdown = formatReplCommandsTable(rawReplCommands);

// 6. Read and update README.md
let readmeContent = readFileSync(readmePath, "utf8");

function replacePlaceholder(content, startTag, endTag, replacement) {
  const startIndex = content.indexOf(startTag);
  const endIndex = content.indexOf(endTag);
  if (startIndex === -1 || endIndex === -1) {
    console.warn(`Warning: Could not find placeholders ${startTag} / ${endTag} in README.md`);
    return content;
  }
  return (
    content.slice(0, startIndex + startTag.length) +
    "\n" +
    replacement +
    "\n" +
    content.slice(endIndex)
  );
}

readmeContent = replacePlaceholder(readmeContent, "<!-- OPTIONS_START -->", "<!-- OPTIONS_END -->", optionsMarkdown);
readmeContent = replacePlaceholder(readmeContent, "<!-- SUBCOMMANDS_START -->", "<!-- SUBCOMMANDS_END -->", subcommandsMarkdown);
readmeContent = replacePlaceholder(readmeContent, "<!-- AGENT_TOOLS_START -->", "<!-- AGENT_TOOLS_END -->", agentToolsMarkdown);
readmeContent = replacePlaceholder(readmeContent, "<!-- REPL_COMMANDS_START -->", "<!-- REPL_COMMANDS_END -->", replCommandsMarkdown);

writeFileSync(readmePath, readmeContent, "utf8");
console.log("README.md has been automatically updated with the latest CLI help options and tables.");
