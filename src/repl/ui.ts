import { colors as pc } from "../colors.js";
import { activeCapabilities } from "./state.js";

// ─── Result Block ───────────────────────────────────────────────────────────

export interface ResultBlockOptions {
  label: string;
  labelColor: "green" | "red" | "cyan" | "blue";
  elapsed: number;
  toolName?: string;
  detail?: string;
}

/**
 * Print a consistent metadata header for MCP primitive results.
 * Shows the result type, elapsed time, and optional detail (tool name, URI, etc.)
 */
export function printResultBlock(opts: ResultBlockOptions): void {
  const colorFn = pc[opts.labelColor];
  const elapsedStr =
    opts.elapsed < 1000 ? `${opts.elapsed}ms` : `${(opts.elapsed / 1000).toFixed(1)}s`;
  const detail = opts.detail ?? opts.toolName ?? "";

  console.log(`  ${colorFn(opts.label)}  ${pc.dim(detail)}  ${pc.dim(`(${elapsedStr})`)}`);
  console.log(pc.dim(`  ${"─".repeat(60)}`));
}

// ─── Help ───────────────────────────────────────────────────────────────────

export function printShortHelp(): void {
  const hasTools = !!activeCapabilities?.tools;
  const hasResources = !!activeCapabilities?.resources;
  const hasPrompts = !!activeCapabilities?.prompts;

  const tC = hasTools ? pc.green : pc.dim;
  const rC = hasResources ? pc.green : pc.dim;
  const pC = hasPrompts ? pc.green : pc.dim;

  console.log(`
${pc.bold("Quick Reference:")}

  ${tC("tl")}  ${tC("tools/list")}        ${rC("rl")}  ${rC("resources/list")}     ${pC("pl")}  ${pC("prompts/list")}
  ${tC("td")}  ${tC("tools/describe")}    ${rC("rr")}  ${rC("resources/read")}     ${pC("pg")}  ${pC("prompts/get")}
  ${tC("tc")}  ${tC("tools/call")}        ${rC("rt")}  ${rC("resources/templates")}
  ${tC("ts")}  ${tC("tools/scaffold")}    ${rC("rs")}  ${rC("resources/subscribe")}
                          ${rC("ru")}  ${rC("resources/unsubscribe")}

  ${pc.green("ping")}  ${pc.green("status")}  ${pc.green("timing")}  ${pc.green("history")}  ${pc.green("!!")}  ${pc.green("explore")}  ${pc.green("reconnect")}

${pc.dim("Type 'help' for full command reference.")}
`);
}

export function printHelp(): void {
  const hasTools = !!activeCapabilities?.tools;
  const hasResources = !!activeCapabilities?.resources;
  const hasPrompts = !!activeCapabilities?.prompts;
  const hasLogging = !!activeCapabilities?.logging;

  const tC = hasTools ? pc.green : pc.dim;
  const rC = hasResources ? pc.green : pc.dim;
  const pC = hasPrompts ? pc.green : pc.dim;
  const lC = hasLogging ? pc.green : pc.dim;

  const tD = hasTools ? (s: string) => s : pc.dim;
  const rD = hasResources ? (s: string) => s : pc.dim;
  const pD = hasPrompts ? (s: string) => s : pc.dim;
  const lD = hasLogging ? (s: string) => s : pc.dim;

  const tH = hasTools
    ? pc.bold("Tool Commands:")
    : pc.dim(pc.bold("Tool Commands:")) + pc.dim("  (Unsupported)");
  const rH = hasResources
    ? pc.bold("Resource Commands:")
    : pc.dim(pc.bold("Resource Commands:")) + pc.dim("  (Unsupported)");
  const pH = hasPrompts
    ? pc.bold("Prompt Commands:")
    : pc.dim(pc.bold("Prompt Commands:")) + pc.dim("  (Unsupported)");

  console.log(`
${tH}

  ${tC("tools/list")}                         ${tD("List all available tools")}
  ${tC("tools/describe")} <name>              ${tD("Show a tool's input schema")}
  ${tC("tools/call")} <name> [json] [opts]    ${tD("Call a tool (interactive if no json)")}
    ${tD("Options:")} ${pc.dim("--timeout <ms>")}            ${tD("Override default timeout (60s)")}
             ${pc.dim("--clear")}                  ${tD("Ignore remembered argument defaults")}
  ${tC("tools/scaffold")} <name>              ${tD("Generate a template for a tool's arguments")}
  ${tC("tools/forget")} [name]                ${tD("Clear remembered interactive defaults")}
  ${tC("find")} <query>                       ${tD("Find tools by relevance to a query")}

${rH}

  ${rC("resources/list")}                     ${rD("List all available resources")}
  ${rC("resources/read")} <uri>               ${rD("Read a resource by URI")}
  ${rC("resources/templates")}                ${rD("List resource templates")}
  ${rC("resources/subscribe")} <uri>          ${rD("Subscribe to resource changes")}
  ${rC("resources/unsubscribe")} <uri>        ${rD("Unsubscribe from resource changes")}

${pH}

  ${pC("prompts/list")}                       ${pD("List all available prompts")}
  ${pC("prompts/get")} <name> [json_args]    ${pD("Get a prompt with arguments")}

${pc.bold("Protocol Commands:")}

  ${pc.green("ping")}                               Verify connection, show round-trip time
  ${lC("log-level")} <level>                  ${lD("Set server logging verbosity")}${hasLogging ? "" : pc.dim("  (Unsupported)")}
  ${pc.green("history")} [count|clear]              Show request/response history
  ${pc.green("notifications")} [count|clear]        Show server notifications

${pc.bold("Roots Management:")}

  ${pc.green("roots/list")}                         Show configured client roots
  ${pc.green("roots/add")} <uri> [name]             Add a root directory
  ${pc.green("roots/remove")} <uri>                 Remove a root directory

${pc.bold("Session Commands:")}

  ${pc.green("!!")} / ${pc.green("last")}                           Re-run the last command
  ${pc.green("reconnect")}                          Disconnect and reconnect to the server
  ${pc.green("timing")}                             Show tool call performance stats
  ${pc.green("status")}                             Show target server status
  ${pc.green("help")}                               Show this help
  ${pc.green("exit")} / ${pc.green("quit")}                         Disconnect and exit

${pc.bold("Shortcuts:")}

  ${tC("tl")}  ${tC("tools/list")}          ${rC("rl")}  ${rC("resources/list")}     ${pC("pl")}  ${pC("prompts/list")}
  ${tC("td")}  ${tC("tools/describe")}      ${rC("rr")}  ${rC("resources/read")}     ${pC("pg")}  ${pC("prompts/get")}
  ${tC("tc")}  ${tC("tools/call")}          ${rC("rt")}  ${rC("resources/templates")}
  ${tC("ts")}  ${tC("tools/scaffold")}      ${rC("rs")}  ${rC("resources/subscribe")}
                          ${rC("ru")}  ${rC("resources/unsubscribe")}

${pc.dim("Lines starting with # are treated as comments.")}
${pc.dim('JSON arguments can contain spaces: tools/call say {"message": "hello world"}')}
${pc.dim("Run tools/call <name> without JSON for interactive argument prompting.")}
${pc.dim("Use tools/call <name> --clear to ignore remembered defaults.")}
`);
}

/**
 * Advance past a terminal escape sequence that starts at index `i` (which points
 * at ESC 0x1B or the C1 CSI 0x9B). Returns the index of the sequence's final byte
 * so the caller can `continue` from `i + 1`. Handles CSI (`ESC [ … final`), OSC
 * (`ESC ] … BEL|ST`), and two-byte `ESC x` forms.
 */
function skipEscapeSequence(str: string, i: number): number {
  const code = str.charCodeAt(i);
  let j = i + 1;
  const isOSC = code === 0x1b && str.charCodeAt(j) === 0x5d; // ESC ]
  const isCSI = code === 0x9b || (code === 0x1b && str.charCodeAt(j) === 0x5b); // ESC [ or C1 CSI

  if (isOSC) {
    j += 1; // past ']'
    while (j < str.length) {
      const c = str.charCodeAt(j);
      if (c === 0x07) return j; // BEL terminates OSC
      if (c === 0x1b && str.charCodeAt(j + 1) === 0x5c) return j + 1; // ST = ESC '\'
      j += 1;
    }
    return str.length;
  }

  if (isCSI) {
    if (code === 0x1b) j += 1; // past '['
    while (j < str.length) {
      const c = str.charCodeAt(j);
      if (c >= 0x40 && c <= 0x7e) return j; // final byte
      j += 1;
    }
    return str.length;
  }

  // Other ESC x: drop the two bytes.
  return j < str.length ? j : i;
}

/**
 * Remove ANSI/terminal escape sequences from a string (used for display-width
 * math). Keeps all printable content and control chars intact.
 */
export function stripAnsi(str: string): string {
  let out = "";
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code === 0x1b || code === 0x9b) {
      i = skipEscapeSequence(str, i);
      continue;
    }
    out += str[i];
  }
  return out;
}

/**
 * Sanitize untrusted server-sourced text before printing it to the terminal.
 * Strips escape sequences AND stray control characters (keeping only tab and
 * newline), neutralizing ANSI/OSC injection — e.g. OSC 52 clipboard hijacking,
 * cursor/screen manipulation, hyperlink spoofing, or fake prompt lines from a
 * malicious MCP server whose tool names, descriptions, or results flow here.
 */
export function sanitizeServerText(str: string): string {
  if (typeof str !== "string") return str;
  let out = "";
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code === 0x1b || code === 0x9b) {
      i = skipEscapeSequence(str, i);
      continue;
    }
    if (code < 0x20) {
      if (code === 0x09 || code === 0x0a) out += str[i]; // keep tab / newline
      continue;
    }
    if (code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue; // DEL + C1
    out += str[i];
  }
  return out;
}

const BOX_WIDTH = 58;

export function padLine(content: string): string {
  const clean = stripAnsi(content);
  const padding = Math.max(0, BOX_WIDTH - clean.length);
  return `${pc.cyan("  │")}${content}${"".padEnd(padding)}${pc.cyan("│")}`;
}

export function printBanner(
  serverName: string,
  serverVersion: string | undefined,
  toolCount: number,
  resourceCount: number,
  promptCount: number,
  harnessMode: boolean,
): void {
  const parts: string[] = [];
  parts.push(`${pc.bold(toolCount.toString())} tools`);
  if (resourceCount > 0) parts.push(`${pc.bold(resourceCount.toString())} resources`);
  if (promptCount > 0) parts.push(`${pc.bold(promptCount.toString())} prompts`);

  // Server name/version are untrusted — sanitize before rendering into the box.
  const safeName = sanitizeServerText(serverName);
  const safeVersion = serverVersion ? sanitizeServerText(serverVersion) : undefined;
  const baseTitle = safeVersion ? `${safeName} ${pc.dim(`v${safeVersion}`)}` : safeName;
  const title = harnessMode ? `${baseTitle} ${pc.bgBlue(pc.white(" AGENT HARNESS "))}` : baseTitle;

  console.log(pc.cyan(`  ┌${"─".repeat(BOX_WIDTH)}┐`));
  console.log(padLine(`  Connected to ${title}`));
  console.log(padLine(`  Discovered ${parts.join(", ")}`));
  console.log(pc.cyan(`  ├${"─".repeat(BOX_WIDTH)}┤`));
  console.log(padLine(`    ${pc.green("tools/list")}                  See all tools`));
  console.log(padLine(`    ${pc.green("tools/call")} ${pc.dim("<name>")}           Call a tool`));
  console.log(padLine(`    ${pc.green("help")}                        All commands`));
  console.log(padLine(""));
  console.log(padLine(pc.dim("  Tab completion is active. Start typing to explore.")));
  console.log(pc.cyan(`  └${"─".repeat(BOX_WIDTH)}┘`));
}
