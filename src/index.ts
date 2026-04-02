#!/usr/bin/env node

import { program } from "commander";
import { startProxy } from "./proxy.js";
import { startRepl } from "./repl.js";
import { startServer } from "./server.js";

program
  .name("run-mcp")
  .enablePositionalOptions()
  .description(
    "A smart proxy, interactive REPL, and live test harness for MCP servers.\n\n" +
      "Operates in three modes:\n" +
      "  repl    - Human-friendly CLI for testing MCP servers interactively\n" +
      "  proxy   - Transparent MCP proxy that intercepts images, enforces timeouts,\n" +
      "            and truncates large payloads to protect an AI agent's context window\n" +
      "  server  - MCP server that lets AI agents dynamically test local MCP servers",
  )
  .version("1.3.1")
  .addHelpText(
    "after",
    `
Examples:
  $ run-mcp repl node my-server.js               # Interactive testing (human)
  $ run-mcp repl node my-server.js -s test.txt    # Run a script
  $ run-mcp proxy node my-server.js               # Transparent proxy (agent)
  $ run-mcp server                                # Test harness (agent)
  $ run-mcp repl npx -y some-mcp-server           # Test an npx server

Run 'run-mcp <command> --help' for detailed options.`,
  );

// Show help with examples when run with no arguments
if (process.argv.length <= 2) {
  program.outputHelp();
  process.exit(0);
}

// ─── REPL Mode ──────────────────────────────────────────────────────────────

program
  .command("repl")
  .description("Start an interactive REPL session with a target MCP server")
  .passThroughOptions()
  .allowUnknownOption()
  .argument("<target_command...>", "Command to spawn the target MCP server")
  .option("-s, --script <file>", "Read commands from a file instead of stdin")
  .option("-o, --out-dir <path>", "Directory to save intercepted images")
  .addHelpText(
    "after",
    `
Examples:
  $ run-mcp repl node my-server.js
  $ run-mcp repl node my-server.js --script verify.txt
  $ run-mcp repl node my-server.js --out-dir ./screenshots

REPL Commands (once connected):
  tools/list                          List all available tools
  tools/describe <name>               Show a tool's input schema
  tools/call <name> <json> [opts]     Call a tool with JSON arguments
  status                              Show target server status
  help                                Show all commands`,
  )
  .action(async (targetCommand: string[], opts: { script?: string; outDir?: string }) => {
    await startRepl(targetCommand, opts);
  });

// ─── Proxy Mode ─────────────────────────────────────────────────────────────

program
  .command("proxy")
  .description("Start as a transparent MCP proxy between an AI agent and a target server")
  .passThroughOptions()
  .allowUnknownOption()
  .argument("<target_command...>", "Command to spawn the target MCP server")
  .option("-o, --out-dir <path>", "Directory to save intercepted images and audio")
  .option("-t, --timeout <ms>", "Default tool call timeout in milliseconds (default: 60000)")
  .option("--max-text <chars>", "Max text response length before truncation (default: 50000)")
  .addHelpText(
    "after",
    `
Examples:
  $ run-mcp proxy node my-server.js
  $ run-mcp proxy node my-server.js --out-dir ./images
  $ run-mcp proxy node my-server.js --timeout 120000
  $ run-mcp proxy node my-server.js --max-text 100000

Use this in your MCP client configuration to wrap any MCP server:
  {
    "mcpServers": {
      "my-server": {
        "command": "run-mcp",
        "args": ["proxy", "node", "my-server.js"]
      }
    }
  }`,
  )
  .action(
    async (
      targetCommand: string[],
      opts: { outDir?: string; timeout?: string; maxText?: string },
    ) => {
      await startProxy(targetCommand, {
        outDir: opts.outDir,
        timeoutMs: opts.timeout ? Number.parseInt(opts.timeout, 10) : undefined,
        maxTextLength: opts.maxText ? Number.parseInt(opts.maxText, 10) : undefined,
      });
    },
  );

// ─── Server Mode ────────────────────────────────────────────────────────────

program
  .command("server")
  .description("Start as an MCP server that lets AI agents dynamically test local MCP servers")
  .option("-o, --out-dir <path>", "Directory to save intercepted images and audio")
  .option("-t, --timeout <ms>", "Default tool call timeout in milliseconds (default: 300000)")
  .option("--max-text <chars>", "Max text response length before truncation (default: 50000)")
  .addHelpText(
    "after",
    `
Examples:
  $ run-mcp server
  $ run-mcp server --out-dir ./test-output
  $ run-mcp server --timeout 120000

Add to your MCP client configuration:
  {
    "mcpServers": {
      "run-mcp": {
        "command": "npx",
        "args": ["-y", "run-mcp", "server"]
      }
    }
  }

Then use these tools from your agent:
  connect_to_mcp      → Spawn and connect to a local MCP server
  list_mcp_tools      → List tools on the connected server
  call_mcp_tool       → Call a tool (with interception)
  disconnect_from_mcp → Tear down and reconnect after changes`,
  )
  .action(async (opts: { outDir?: string; timeout?: string; maxText?: string }) => {
    await startServer({
      outDir: opts.outDir,
      timeoutMs: opts.timeout ? Number.parseInt(opts.timeout, 10) : undefined,
      maxTextLength: opts.maxText ? Number.parseInt(opts.maxText, 10) : undefined,
    });
  });

program.parse();
