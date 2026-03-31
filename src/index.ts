#!/usr/bin/env node

import { program } from "commander";
import { startProxy } from "./proxy.js";
import { startRepl } from "./repl.js";

program
  .name("run-mcp")
  .enablePositionalOptions()
  .description(
    "A smart proxy and interactive REPL for Model Context Protocol (MCP) servers.\n\n" +
      "Operates in two modes:\n" +
      "  repl   - Human-friendly CLI for testing MCP servers interactively\n" +
      "  proxy  - Transparent MCP proxy that intercepts images, enforces timeouts,\n" +
      "           and truncates large payloads to protect an AI agent's context window",
  )
  .version("1.0.0")
  .addHelpText(
    "after",
    `
Examples:
  $ run-mcp repl node my-server.js               # Interactive testing
  $ run-mcp repl node my-server.js -s test.txt    # Run a script
  $ run-mcp proxy node my-server.js               # Proxy for AI agents
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
  .option("-o, --out-dir <path>", "Directory to save intercepted images")
  .addHelpText(
    "after",
    `
Examples:
  $ run-mcp proxy node my-server.js
  $ run-mcp proxy node my-server.js --out-dir ./images

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
  .action(async (targetCommand: string[], opts: { outDir?: string }) => {
    await startProxy(targetCommand, opts);
  });

program.parse();
