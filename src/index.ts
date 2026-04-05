#!/usr/bin/env node

import { program } from "commander";
import { startRepl } from "./repl.js";
import { startServer } from "./server.js";
import { pickDiscoveredServer } from "./config-scanner.js";

program
  .name("run-mcp")
  .description("A smart interactive REPL and live test harness for MCP servers")
  .version("1.4.0")
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
  .option("--mcp", "Force start Agent Server mode even if run interactively without arguments")
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
  resources/subscribe <uri>           Subscribe to resource changes
  resources/unsubscribe <uri>         Unsubscribe from resource changes
  prompts/list                        List all available prompts
  prompts/get <name> [json_args]      Get a prompt with arguments
  ping                                Verify connection, show round-trip time
  log-level <level>                   Set server logging verbosity
  history [count|clear]               Show request/response history
  notifications [count|clear]         Show server notifications
  roots/list                          Show configured client roots
  roots/add <uri> [name]              Add a root directory
  roots/remove <uri>                  Remove a root directory
  !! / last                           Re-run the last command
  reconnect                           Disconnect and reconnect
  timing                              Show tool call performance stats
  status                              Show target server status

Shortcuts: tl td tc ts rl rr rt rs ru pl pg (see help for details)`,
  )
  .action(
    async (
      targetCommand: string[],
      opts: { script?: string; outDir?: string; timeout?: string; maxText?: string; mcp?: boolean },
    ) => {
      // If we have a target command, start the REPL mode
      if (targetCommand && targetCommand.length > 0) {
        await startRepl(targetCommand, { script: opts.script, outDir: opts.outDir });
      } else {
        // No target command provided
        if (opts.mcp || !process.stdin.isTTY) {
          // Agent server mode
          await startServer({
            outDir: opts.outDir,
            timeoutMs: opts.timeout ? Number.parseInt(opts.timeout, 10) : undefined,
            maxTextLength: opts.maxText ? Number.parseInt(opts.maxText, 10) : undefined,
          });
        } else {
          // Human is running it in a terminal without arguments -> pick a config
          const selected = await pickDiscoveredServer();

          if (!selected) {
            // User aborted or no configs found
            console.log("Run 'run-mcp --help' to see manual usage instructions.");
            return;
          }

          // Environment variables from config
          if (selected.config.env) {
            Object.assign(process.env, selected.config.env);
          }

          await startRepl([selected.config.command, ...(selected.config.args || [])], {
            script: opts.script,
            outDir: opts.outDir,
          });
        }
      }
    },
  );

program.parse();
