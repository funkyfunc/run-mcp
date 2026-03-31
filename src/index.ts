#!/usr/bin/env node

import { program } from "commander";
import { startRepl } from "./repl.js";
import { startProxy } from "./proxy.js";

program
  .name("run-mcp")
  .description(
    "A smart proxy and interactive REPL for Model Context Protocol (MCP) servers.\n\n" +
    "Operates in two modes:\n" +
    "  repl   - Human-friendly CLI for testing MCP servers interactively\n" +
    "  proxy  - Transparent MCP proxy that intercepts images, enforces timeouts,\n" +
    "           and truncates large payloads to protect an AI agent's context window",
  )
  .version("1.0.0");

// ─── REPL Mode ──────────────────────────────────────────────────────────────

program
  .command("repl")
  .description("Start an interactive REPL session with a target MCP server")
  .argument("<target_command...>", "Command to spawn the target MCP server")
  .option("-s, --script <file>", "Read commands from a file instead of stdin")
  .option("-o, --out-dir <path>", "Directory to save intercepted images")
  .action(async (targetCommand: string[], opts: { script?: string; outDir?: string }) => {
    await startRepl(targetCommand, opts);
  });

// ─── Proxy Mode ─────────────────────────────────────────────────────────────

program
  .command("proxy")
  .description("Start as a transparent MCP proxy between an AI agent and a target server")
  .argument("<target_command...>", "Command to spawn the target MCP server")
  .option("-o, --out-dir <path>", "Directory to save intercepted images")
  .action(async (targetCommand: string[], opts: { outDir?: string }) => {
    await startProxy(targetCommand, opts);
  });

program.parse();
