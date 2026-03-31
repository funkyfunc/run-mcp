# run-mcp

A smart proxy and interactive REPL for [Model Context Protocol](https://modelcontextprotocol.io) (MCP) servers.

`run-mcp` wraps any MCP server and operates in two modes:

| Mode | Audience | Purpose |
|------|----------|---------|
| **`repl`** | Humans / developers | Interactive CLI for testing and exploring MCP servers with shorthand commands |
| **`proxy`** | AI agents | Transparent MCP proxy that intercepts responses to save images to disk, enforce timeouts, and truncate massive payloads |

## Why?

MCP servers often return large base64-encoded images (screenshots, charts) or massive JSON payloads that can blow up an AI agent's context window. `run-mcp` sits between the agent and the server, transparently:

- **Saving images to disk** instead of passing multi-MB base64 strings through
- **Enforcing timeouts** so a hung tool call doesn't block forever
- **Truncating huge text** responses to protect context budgets

For humans, the REPL mode provides a quick way to test any MCP server without writing client code.

## Installation

```bash
npm install
npm run build
```

To install globally (makes `run-mcp` available system-wide):

```bash
npm install -g .
```

## Quick Start

### REPL Mode — Test an MCP server interactively

```bash
# Start a REPL session with any MCP server
run-mcp repl node path/to/my-mcp-server.js

# Or use npx without installing globally
npx . repl node path/to/my-mcp-server.js
```

You'll see an interactive prompt:

```
⟳ Connecting to target MCP server...
  Command: node path/to/my-mcp-server.js
✓ Connected (PID: 12345)
  5 tool(s) available. Type help for commands.

>
```

### Proxy Mode — Protect your agent's context

```bash
run-mcp proxy node path/to/my-mcp-server.js --out-dir ./captured-images
```

Then point your AI agent at `run-mcp` as the MCP server command. It transparently forwards all tools while sanitizing responses.

## Usage

```
run-mcp <command> [options]

Commands:
  repl <target_command...>    Start an interactive REPL session
  proxy <target_command...>   Start as a transparent MCP proxy

Options:
  -V, --version               Show version number
  -h, --help                  Show help
```

### REPL Command

```
run-mcp repl <target_command...> [options]

Options:
  -s, --script <file>    Read commands from a file instead of stdin
  -o, --out-dir <path>   Directory to save intercepted images (default: $TMPDIR/run-mcp)
```

### Proxy Command

```
run-mcp proxy <target_command...> [options]

Options:
  -o, --out-dir <path>   Directory to save intercepted images (default: $TMPDIR/run-mcp)
```

## REPL Commands

Once in the REPL, these commands are available:

| Command | Description |
|---------|-------------|
| `tools/list` | List all tools exposed by the target server |
| `tools/describe <name>` | Show a tool's full input schema |
| `tools/call <name> <json> [--timeout <ms>]` | Call a tool with JSON arguments |
| `status` | Show target server status (PID, uptime, connection) |
| `help` | Show available commands |
| `exit` / `quit` | Disconnect and exit |

### Examples

```bash
# List available tools
> tools/list

# Inspect a tool's schema
> tools/describe screenshot

# Call a tool with arguments
> tools/call screenshot {"target": "#loginBtn"}

# Call with a custom timeout (5 seconds)
> tools/call long_running_tool {} --timeout 5000

# Arguments with spaces work fine
> tools/call send_message {"text": "hello world", "channel": "general"}
```

### Script Mode

You can automate REPL commands by writing them to a file:

```bash
# commands.txt
tools/list
tools/call get_status {}
tools/call screenshot {"save_path": "/tmp/test.png"}
```

```bash
run-mcp repl node my-server.js --script commands.txt
```

- Lines starting with `#` are treated as comments
- Exits with code `0` on success, `1` on first error

## Proxy Mode — How It Works

In proxy mode, `run-mcp` acts as an MCP server itself. Configure it as the command your AI agent spawns:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "run-mcp",
      "args": ["proxy", "node", "path/to/actual-server.js", "--out-dir", "./images"]
    }
  }
}
```

### What the proxy intercepts

| Feature | Behavior |
|---------|----------|
| **Image extraction** | `type: "image"` responses with base64 data are saved to disk. The response is replaced with `[Image saved to /path/to/img.png (24KB)]` |
| **Base64 detection** | Text responses that are entirely base64-encoded (1000+ chars) are also saved as images |
| **Timeouts** | Tool calls are wrapped in a 60-second timeout (prevents hung calls from blocking the agent) |
| **Truncation** | Text responses exceeding 50,000 characters are truncated with a `... (truncated, N chars total)` message |

## Architecture

```
┌─────────────────────┐         ┌─────────────────────┐
│                     │  stdio  │                     │
│   AI Agent / REPL   │◄───────►│     run-mcp         │
│                     │         │                     │
└─────────────────────┘         │  ┌───────────────┐  │
                                │  │  Interceptor   │  │
                                │  │  • Timeouts    │  │
                                │  │  • Image Save  │  │
                                │  │  • Truncation  │  │
                                │  └───────┬───────┘  │
                                │          │          │
                                │  ┌───────▼───────┐  │
                                │  │ TargetManager  │  │
                                │  │ (MCP Client)   │  │
                                │  └───────┬───────┘  │
                                └──────────┼──────────┘
                                           │ stdio
                                ┌──────────▼──────────┐
                                │  Target MCP Server   │
                                │  (child process)     │
                                └─────────────────────┘
```

### Modules

| Module | File | Responsibility |
|--------|------|----------------|
| **TargetManager** | `src/target-manager.ts` | Spawns the target MCP server, manages the MCP Client connection, captures stderr, tracks lifecycle |
| **ResponseInterceptor** | `src/interceptor.ts` | Wraps tool calls with timeouts, extracts base64 images to disk, truncates oversized text |
| **REPLMode** | `src/repl.ts` | Interactive readline REPL with shorthand command parsing and script mode |
| **ProxyMode** | `src/proxy.ts` | MCP Server that bridges `tools/list` and `tools/call` through the interceptor to the target |

## Development

```bash
# Install dependencies
npm install

# Build (one-time)
npm run build

# Watch mode (rebuild on changes)
npm run dev

# Run directly
node dist/index.js repl <target_command...>
```

## License

ISC