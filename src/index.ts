#!/usr/bin/env node

import { program } from "commander";
import { startRepl } from "./repl.js";
import { startServer } from "./server.js";

program
  .name("run-mcp")
  .description("A smart interactive REPL and live test harness for MCP servers")
  .version("1.3.4")
  .passThroughOptions()
  .allowUnknownOption()
  .argument(
    "[target_command...]",
    "Command to spawn the target MCP server (starts REPL if provided, Agent server otherwise)",
  )
  .option("-o, --out-dir <path>", "Directory to save intercepted images and audio")
  .option(
    "-t, --timeout <ms>",
    "Default tool call timeout in milliseconds (default: 300000) (Agent Mode only)",
  )
  .option(
    "--max-text <chars>",
    "Max text response length before truncation (default: 50000) (Agent Mode only)",
  )
  .option("-s, --script <file>", "Read commands from a file instead of stdin (REPL Mode only)")
  .addHelpText(
    "after",
    `
Examples:
  $ run-mcp                                       # Test harness (agent mode)
  $ run-mcp node my-server.js                     # Interactive testing (human REPL mode)
  $ run-mcp node my-server.js -s test.txt         # Run a script in REPL mode
  $ run-mcp npx -y some-mcp-server                # Test an npx server
  $ run-mcp --out-dir ./test-output               # Agent mode with options
  $ run-mcp --out-dir ./screenshots node srv.js   # REPL mode with options

Agent Mode Configuration (mcp.json):
  {
    "mcpServers": {
      "run-mcp": {
        "command": "npx",
        "args": ["-y", "run-mcp"]
      }
    }
  }

Agent Mode Tools:
  connect_to_mcp       → Spawn and connect (use include to get tools/resources/prompts)
  call_mcp_primitive   → Call a tool, read a resource, or get a prompt (auto-connects)
  list_mcp_primitives  → List tools, resources, and/or prompts
  disconnect_from_mcp  → Tear down and reconnect after changes
  mcp_server_status    → Check connection status
  get_mcp_server_stderr → View target server stderr output

REPL Mode Commands (once connected):
  tools/list                          List all available tools
  tools/describe <name>               Show a tool's input schema
  tools/call <name> [json] [opts]     Call a tool (interactive if no json)
  tools/scaffold <name>               Generate argument template for a tool
  resources/list                      List all available resources
  resources/read <uri>                Read a resource by URI
  resources/templates                 List resource templates
  prompts/list                        List all available prompts
  prompts/get <name> [json_args]      Get a prompt with arguments
  !! / last                           Re-run the last command
  reconnect                           Disconnect and reconnect
  timing                              Show tool call performance stats
  status                              Show target server status

Shortcuts: tl td tc ts rl rr rt pl pg (see help for details)`,
  )
  .action(
    async (
      targetCommand: string[],
      opts: { script?: string; outDir?: string; timeout?: string; maxText?: string },
    ) => {
      // If we have a target command, start the REPL mode
      if (targetCommand && targetCommand.length > 0) {
        await startRepl(targetCommand, { script: opts.script, outDir: opts.outDir });
      } else {
        // Agent server mode
        await startServer({
          outDir: opts.outDir,
          timeoutMs: opts.timeout ? Number.parseInt(opts.timeout, 10) : undefined,
          maxTextLength: opts.maxText ? Number.parseInt(opts.maxText, 10) : undefined,
        });
      }
    },
  );

program.parse();
