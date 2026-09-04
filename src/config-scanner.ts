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
  /** Optional human description. Superset of the standard shape. */
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

export interface DiscoverOptions {
  /** Also walk up from cwd looking for any JSON file with an `mcpServers` block. */
  scan?: boolean;
  /** Override the home directory (tests plant configs in a temp home). */
  home?: string;
  /** Override the working directory. */
  cwd?: string;
}

/**
 * Returns possible paths for common MCP environments.
 */
function getConfigPaths(home: string, cwd: string): { source: string; file: string }[] {
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
    // Claude Code "user" scope lives at the top level of ~/.claude.json; its
    // "local" scope is nested per project in the same file (see
    // collectClaudeCodeLocalScope). "project" scope is .mcp.json in the repo.
    { source: "Claude Code (Global)", file: path.join(home, ".claude.json") },
    { source: "Claude Code (~/.claude/mcp.json)", file: path.join(home, ".claude", "mcp.json") },
    { source: "Claude Code (Project)", file: path.join(cwd, ".mcp.json") },
    { source: "Antigravity", file: path.join(home, ".gemini", "antigravity", "mcp_config.json") },
    {
      source: "Gemini App (Global)",
      file: path.join(home, ".gemini", "config", "mcp_config.json"),
    },
  ];
}

/** Pull the `mcpServers`-style map out of a parsed config, whatever it's wrapped in. */
function extractServerMap(json: any): McpConfigMap | undefined {
  if (!json || typeof json !== "object") return undefined;
  if (json.mcpServers && typeof json.mcpServers === "object") return json.mcpServers;
  if (json.mcp?.servers && typeof json.mcp.servers === "object") return json.mcp.servers;
  if (json.servers && typeof json.servers === "object") return json.servers;
  return undefined;
}

/**
 * Normalize one config entry into something TargetManager can spawn, or null
 * if it can't be launched. A remote (`url`) entry becomes a command of its URL,
 * which TargetManager connects to over Streamable HTTP / SSE.
 */
function normalizeConfig(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const config = raw as McpServerConfig;
  if (typeof config.command === "string" && config.command) return config;
  if (typeof config.url === "string" && config.url) {
    return { ...config, command: config.url, args: [] };
  }
  return null;
}

/** Append every launchable entry of a server map, tagged with its source. */
function collectServers(map: McpConfigMap | undefined, source: string, out: DiscoveredServer[]) {
  if (!map) return;
  for (const [name, raw] of Object.entries(map)) {
    const config = normalizeConfig(raw);
    if (config) out.push({ name, config, source });
  }
}

/** Shorten a project path for display: `~/Development/fearch`. */
function displayPath(dir: string, home: string): string {
  return dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir;
}

/**
 * Claude Code's `claude mcp add` defaults to "local" scope: the server is
 * stored in ~/.claude.json under `projects[<project dir>].mcpServers`, not at
 * the top level. Those are the servers a developer is most likely to be
 * working on, so every project's local-scope servers are listed, each labelled
 * with the project it belongs to.
 */
function collectClaudeCodeLocalScope(json: any, home: string, out: DiscoveredServer[]) {
  const projects = json?.projects;
  if (!projects || typeof projects !== "object") return;
  for (const [dir, project] of Object.entries(projects)) {
    const map = (project as any)?.mcpServers;
    if (!map || typeof map !== "object") continue;
    collectServers(map, `Claude Code (Local: ${displayPath(dir, home)})`, out);
  }
}

/**
 * Load an explicit MCP config file (standard `mcpServers` shape) and return its
 * named servers. Throws on a missing or malformed file so the caller can
 * report it.
 */
export async function loadMcpServersFile(
  file: string,
): Promise<{ name: string; config: McpServerConfig }[]> {
  const content = await readFile(file, "utf8");
  const map = extractServerMap(JSON.parse(content));
  if (!map) {
    throw new Error(`No "mcpServers" object found in ${file}`);
  }
  const out: DiscoveredServer[] = [];
  collectServers(map, file, out);
  return out.map(({ name, config }) => ({ name, config }));
}

/**
 * Parses JSON configs and extracts mcpServers.
 */
export async function discoverServers(options?: DiscoverOptions): Promise<DiscoveredServer[]> {
  const home = options?.home ?? homedir();
  const cwd = options?.cwd ?? process.cwd();
  const servers: DiscoveredServer[] = [];

  for (const { source, file } of getConfigPaths(home, cwd)) {
    if (!existsSync(file)) continue;

    try {
      const json = JSON.parse(await readFile(file, "utf8"));
      collectServers(extractServerMap(json), source, servers);
      if (source === "Claude Code (Global)") collectClaudeCodeLocalScope(json, home, servers);
    } catch {
      // Ignore parsing errors for individual files
    }
  }

  // Dynamic scanning: walk up from cwd and search for any JSON files containing "mcpServers"
  if (options?.scan) {
    try {
      let currentDir = cwd;
      const visited = new Set<string>();
      while (currentDir && !visited.has(currentDir)) {
        visited.add(currentDir);

        if (existsSync(currentDir)) {
          const files = await readdir(currentDir, { withFileTypes: true });
          for (const file of files) {
            if (!file.isFile() || !file.name.endsWith(".json")) continue;
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
              if (!content.includes("mcpServers")) continue;
              const json = JSON.parse(content);
              if (json.mcpServers && typeof json.mcpServers === "object") {
                collectServers(json.mcpServers, `Local Workspace (${file.name})`, servers);
              }
            } catch {
              // Ignore individual parsing/reading errors
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
 * Collapse duplicates (the same name + command + args from several files),
 * preferring the more specific source: a project/local/workspace entry wins
 * over a global one.
 */
export function dedupeServers(servers: DiscoveredServer[]): DiscoveredServer[] {
  const unique = new Map<string, DiscoveredServer>();
  const isSpecific = (s: DiscoveredServer) =>
    /Project|Local/.test(s.source) || s.source.includes("Local Workspace");
  for (const s of servers) {
    const key = `${s.name}::${s.config.command}::${(s.config.args || []).join(" ")}`;
    if (!unique.has(key) || isSpecific(s)) unique.set(key, s);
  }
  return Array.from(unique.values());
}

/**
 * Shows an interactive picker using inquirer.
 */
export async function pickDiscoveredServer(options?: {
  scan?: boolean;
}): Promise<DiscoveredServer | null> {
  const servers = dedupeServers(await discoverServers(options));

  if (servers.length === 0) {
    return null;
  }

  const choices: any[] = servers.map((s) => {
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
