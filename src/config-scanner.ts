import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { input, select } from "@inquirer/prompts";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Optional human description (used by the proxy's server overview). Superset of the standard shape. */
  description?: string;
  /** Optional remote (Streamable HTTP) backend URL; used as the command when set. */
  url?: string;
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
    {
      source: "VS Code (Global)",
      file: path.join(
        isMac
          ? path.join(home, "Library", "Application Support")
          : isWin
            ? appData
            : path.join(home, ".config"),
        "Code",
        "User",
        "settings.json",
      ),
    },
    { source: "Copilot CLI (Global)", file: path.join(home, ".copilot", "mcp-config.json") },
    { source: "Gemini CLI (Global)", file: path.join(home, ".gemini", "settings.json") },
    { source: "Gemini CLI (Project)", file: path.join(cwd, ".gemini", "settings.json") },
    { source: "Claude Code (Global)", file: path.join(home, ".claude.json") },
    { source: "Claude Code (Project)", file: path.join(cwd, ".mcp.json") },
    { source: "Antigravity", file: path.join(home, ".gemini", "antigravity", "mcp_config.json") },
    {
      source: "Gemini App (Global)",
      file: path.join(home, ".gemini", "config", "mcp_config.json"),
    },
  ];
}

/**
 * Load an explicit MCP config file (standard `mcpServers` shape) and return its
 * named servers. Used by the compressing proxy's `--config`. Throws on a missing
 * or malformed file so the caller can report it.
 */
export async function loadMcpServersFile(
  file: string,
): Promise<{ name: string; config: McpServerConfig }[]> {
  const content = await readFile(file, "utf8");
  const json = JSON.parse(content);
  const map: McpConfigMap | undefined =
    json.mcpServers ?? json.mcp?.servers ?? json.servers ?? undefined;
  if (!map || typeof map !== "object") {
    throw new Error(`No "mcpServers" object found in ${file}`);
  }
  const out: { name: string; config: McpServerConfig }[] = [];
  for (const [name, config] of Object.entries(map)) {
    if (config && (config.command || config.url)) out.push({ name, config });
  }
  return out;
}

/**
 * Parses JSON configs and extracts mcpServers.
 */
export async function discoverServers(options?: { scan?: boolean }): Promise<DiscoveredServer[]> {
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
      } else if (json.mcp?.servers && typeof json.mcp.servers === "object") {
        mcpServers = json.mcp.servers;
      } else if (json.servers && typeof json.servers === "object") {
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

  // Dynamic scanning: walk up from process.cwd() and search for any JSON files containing "mcpServers"
  if (options?.scan) {
    try {
      let currentDir = process.cwd();
      const visited = new Set<string>();
      while (currentDir && !visited.has(currentDir)) {
        visited.add(currentDir);

        if (existsSync(currentDir)) {
          const files = await readdir(currentDir, { withFileTypes: true });
          for (const file of files) {
            if (file.isFile() && file.name.endsWith(".json")) {
              // Ignore common heavy / unrelated configuration files to be fast and safe
              if (
                file.name === "package-lock.json" ||
                file.name === "package.json" ||
                file.name === "tsconfig.json"
              ) {
                continue;
              }

              const filePath = path.join(currentDir, file.name);
              try {
                const content = await readFile(filePath, "utf8");
                if (content.includes("mcpServers")) {
                  const json = JSON.parse(content);
                  if (json.mcpServers && typeof json.mcpServers === "object") {
                    for (const [name, config] of Object.entries(json.mcpServers)) {
                      if (config && typeof config === "object" && (config as any).command) {
                        servers.push({
                          name,
                          config: config as any,
                          source: `Local Workspace (${file.name})`,
                        });
                      }
                    }
                  }
                }
              } catch {
                // Ignore individual parsing/reading errors
              }
            }
          }
        }

        const parent = path.dirname(currentDir);
        if (parent === currentDir) break;
        currentDir = parent;
      }
    } catch {
      // Ignore overall readdir/path issues
    }
  }

  return servers;
}

/**
 * Shows an interactive picker using inquirer.
 */
export async function pickDiscoveredServer(options?: {
  scan?: boolean;
}): Promise<DiscoveredServer | null> {
  const servers = await discoverServers(options);

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
      // Favor Project/Local Workspace configs over global by overwriting if source includes 'Project' or 'Local Workspace'
      if (s.source.includes("Project") || s.source.includes("Local Workspace")) {
        uniqueServers.set(key, s);
      }
    }
  }

  const choices: any[] = Array.from(uniqueServers.values()).map((s) => {
    return {
      name: `${s.name} (from ${s.source})`,
      value: s,
      description: `${s.config.command} ${(s.config.args || []).join(" ")}`,
    };
  });

  choices.push({
    name: "Enter custom server command...",
    value: "CUSTOM",
    description: "Manually specify a command, e.g. 'npx foo' or 'python server.py'",
  });

  try {
    const answer = await select({
      message: "Select an MCP server to launch:",
      choices,
      pageSize: 15,
    });

    if (answer === "CUSTOM") {
      const customCommand = await input({ message: "Command to spawn target MCP server:" });
      if (!customCommand.trim()) return null;

      // Basic shell-like split (obviously real parsing would handle quotes, but this works for 90% of cases)
      const parts = customCommand
        .trim()
        .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
        ?.map((p) => p.replace(/^["']|["']$/g, ""));

      if (!parts || parts.length === 0) return null;

      return {
        name: "Custom",
        config: { command: parts[0], args: parts.slice(1) },
        source: "Manual",
      };
    }

    return answer;
  } catch {
    // User aborted
    return null;
  }
}
