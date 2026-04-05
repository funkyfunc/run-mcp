import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { select } from "@inquirer/prompts";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpConfigMap {
  [serverName: string]: McpServerConfig;
}

export interface DiscoveredServer {
  name: string;
  config: McpServerConfig;
  source: string;
}

/**
 * Returns possible paths for common MCP environments.
 */
function getConfigPaths(): { source: string; file: string }[] {
  const home = homedir();
  const cwd = process.cwd();
  const isWin = process.platform === "win32";
  const isMac = process.platform === "darwin";

  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");

  let claudeDesktopGlob: string;
  if (isWin) {
    claudeDesktopGlob = path.join(appData, "Claude", "claude_desktop_config.json");
  } else if (isMac) {
    claudeDesktopGlob = path.join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
  } else {
    claudeDesktopGlob = path.join(home, ".config", "Claude", "claude_desktop_config.json");
  }

  return [
    { source: "Cursor (Global)", file: path.join(home, ".cursor", "mcp.json") },
    { source: "Cursor (Project)", file: path.join(cwd, ".cursor", "mcp.json") },
    { source: "Windsurf", file: path.join(home, ".codeium", "windsurf", "mcp_config.json") },
    { source: "Claude Desktop", file: claudeDesktopGlob },
    { source: "Cline", file: path.join(home, "Documents", "Cline", "MCP", "mcp.json") },
    { source: "VS Code (Project)", file: path.join(cwd, ".vscode", "mcp.json") },
    { source: "Gemini CLI (Global)", file: path.join(home, ".gemini", "settings.json") },
    { source: "Gemini CLI (Project)", file: path.join(cwd, ".gemini", "settings.json") },
    { source: "Claude Code (Global)", file: path.join(home, ".claude.json") },
    { source: "Claude Code (Project)", file: path.join(cwd, ".mcp.json") },
    { source: "Antigravity", file: path.join(home, ".gemini", "antigravity", "mcp_config.json") },
  ];
}

/**
 * Parses JSON configs and extracts mcpServers.
 */
export async function discoverServers(): Promise<DiscoveredServer[]> {
  const servers: DiscoveredServer[] = [];
  const paths = getConfigPaths();

  for (const { source, file } of paths) {
    if (!existsSync(file)) continue;

    try {
      const content = await readFile(file, "utf8");
      const json = JSON.parse(content);

      let mcpServers: McpConfigMap | undefined;

      // Some configs wrap in mcpServers, some might be direct
      if (json.mcpServers && typeof json.mcpServers === "object") {
        mcpServers = json.mcpServers;
      } else if (source.startsWith("Claude Code") && json.servers) {
        // Handle variations if any
        mcpServers = json.servers;
      }

      if (mcpServers) {
        for (const [name, config] of Object.entries(mcpServers)) {
          if (config.command) {
            servers.push({ name, config, source });
          }
        }
      }
    } catch {
      // Ignore parsing errors for individual files
    }
  }

  return servers;
}

/**
 * Shows an interactive picker using inquirer.
 */
export async function pickDiscoveredServer(): Promise<DiscoveredServer | null> {
  const servers = await discoverServers();

  if (servers.length === 0) {
    return null;
  }

  // Deduplicate by name + command (to prevent project & global showing twice if identical)
  const uniqueServers = new Map<string, DiscoveredServer>();
  for (const s of servers) {
    const key = `${s.name}::${s.config.command}::${(s.config.args || []).join(" ")}`;
    if (!uniqueServers.has(key)) {
      uniqueServers.set(key, s);
    } else {
      // Favor Project configs over global by overwriting if source includes 'Project'
      if (s.source.includes("Project")) {
        uniqueServers.set(key, s);
      }
    }
  }

  const choices = Array.from(uniqueServers.values()).map((s) => {
    return {
      name: `${s.name} (from ${s.source})`,
      value: s,
      description: `${s.config.command} ${(s.config.args || []).join(" ")}`,
    };
  });

  try {
    const answer = await select({
      message: "Select an MCP server to launch:",
      choices,
      pageSize: 15,
    });
    return answer;
  } catch {
    // User aborted
    return null;
  }
}
