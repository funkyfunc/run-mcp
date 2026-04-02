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
  connect_to_mcp      → Spawn and connect to a local MCP server
  list_mcp_tools      → List tools on the connected server
  describe_mcp_tool   → Show a tool's input schema
  call_mcp_tool       → Call a tool (with interception)
  disconnect_from_mcp → Tear down and reconnect after changes

REPL Mode Commands (once connected):
  tools/list                          List all available tools
  tools/describe <name>               Show a tool's input schema
  tools/call <name> <json> [opts]     Call a tool with JSON arguments
  status                              Show target server status
  help                                Show all commands`,
  )
  .action(
    async (
      targetCommand: string[],
      opts: { script?: string; outDir?: string; timeout?: string; maxText?: string },
    ) => {
      // If we have a target command, start the REPL mode
      if (targetCommand && targetCommand.length > 0) {
        // Intercept common typo: user ran `run-mcp repl` or `run-mcp mcp` out of habit
        const firstArg = targetCommand[0];
        if (firstArg === "repl" || firstArg === "mcp" || firstArg === "server") {
          targetCommand.shift();
          if (targetCommand.length === 0) {
            if (firstArg === "repl") {
              console.error(
                "Error: REPL mode requires a target command (e.g. run-mcp node server.js)",
              );
              process.exit(1);
            }
            // fallback to agent mode for 'run-mcp mcp' or 'run-mcp server'
            await startServer({
              outDir: opts.outDir,
              timeoutMs: opts.timeout ? Number.parseInt(opts.timeout, 10) : undefined,
              maxTextLength: opts.maxText ? Number.parseInt(opts.maxText, 10) : undefined,
            });
            return;
          }
        }
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
