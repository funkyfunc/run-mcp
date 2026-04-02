# run-mcp

A smart proxy, interactive REPL, and live test harness for [Model Context Protocol](https://modelcontextprotocol.io) (MCP) servers.

`run-mcp` operates in two modes:

1. **Agent MCP Server** (`run-mcp`) — An MCP server that exposes tools (`connect_to_mcp`, `call_mcp_tool`) so AI agents can dynamically connect to and test local MCP projects without hardcoding them in configuration files. This is the **default mode** when you run `npx -y run-mcp`.
2. **Interactive REPL** (`run-mcp repl`) — A headless CLI for human developers to manually test and explore MCP servers using short, memorable commands (`tools/call`, `status`, etc.).

### Interception Rules (Agent Server & REPL)

To protect the CLI and parent agents from large payloads, `run-mcp` automatically applies the following rules:

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

## Usage

run-mcp [options] [target_command...]

Options:
  -V, --version               Show version number
  -o, --out-dir <path>        Directory to save intercepted images and audio
  -t, --timeout <ms>          Default tool call timeout in milliseconds (default: 300000) (Agent Mode only)
      --max-text <chars>      Max text response length before truncation (default: 50000) (Agent Mode only)
  -s, --script <file>         Read commands from a file instead of stdin (REPL Mode only)
  -h, --help                  Display help for command

Examples:
  $ run-mcp                                       # Test harness (agent mode)
  $ run-mcp node my-server.js                     # Interactive testing (human REPL mode)
  $ run-mcp node my-server.js -s test.txt         # Run a script in REPL mode
  $ run-mcp npx -y some-mcp-server                # Test an npx server
  $ run-mcp --out-dir ./test-output               # Agent mode with options
  $ run-mcp --out-dir ./screenshots node srv.js   # REPL mode with options



## Agent Use Cases

### Dynamic Testing

When an AI agent is actively *developing* an MCP server, it needs to test it. Standard MCP clients require updating a configuration file (`mcp.json`) and restarting the agent session entirely.

`run-mcp` solves this by giving the agent a suite of tools to dynamically spawn, inspect, and test local MCP servers on the fly.

**How to use:**
Add `run-mcp` to your agent's MCP configuration using `npx`:
```json
{
  "mcpServers": {
    "run-mcp": {
      "command": "npx",
      "args": ["-y", "run-mcp"]
    }
  }
}
```

Then use these tools from your agent:

| Tool | Description |
|------|-------------|
| `connect_to_mcp` | Spawn and connect to a local MCP server |
| `disconnect_from_mcp` | Tear down the connection |
| `mcp_server_status` | Check connection status |
| `list_mcp_tools` | List tools on the connected server |
| `call_mcp_tool` | Call a tool (with interception) |
| `list_mcp_resources` | List resources |
| `read_mcp_resource` | Read a resource by URI |
| `list_mcp_prompts` | List prompts |
| `get_mcp_prompt` | Get a prompt by name |
| `get_mcp_server_stderr` | View target server stderr output |

## REPL Mode Commands

Once connected via `run-mcp <command>`, the following shorthand commands are available:

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

### What the proxy forwards

The proxy dynamically mirrors the target server's capabilities. All MCP primitives that the target supports are forwarded transparently:

| Primitive | Forwarded? |
|-----------|------------|
| **Tools** (`tools/list`, `tools/call`) | ✅ Always (with interception) |
| **Resources** (`resources/list`, `resources/read`, `resources/templates/list`) | ✅ If target supports |
| **Prompts** (`prompts/list`, `prompts/get`) | ✅ If target supports |
| **Logging** (`logging/setLevel`) | ✅ If target supports |
| **Completion** (`completion/complete`) | ✅ If target supports |
| **Notifications** (list changes, logging) | ✅ Forwarded from target to agent |
| **Tool annotations** (`readOnlyHint`, `destructiveHint`, etc.) | ✅ Preserved as-is |
| **Pagination** (`nextCursor` / `cursor`) | ✅ Passed through |

### What the proxy intercepts

Tool call responses are processed through the interceptor pipeline. All other primitives pass through untouched.

| Feature | Behavior |
|---------|----------|
| **Image extraction** | `type: "image"` responses with base64 data are saved to disk. Replaced with `[Image saved to /path/to/img.png (24KB)]` |
| **Audio extraction** | `type: "audio"` responses with base64 data are saved to disk. Replaced with `[Audio saved to /path/to/audio.wav (12KB)]` |
| **Base64 detection** | Text responses that are entirely base64-encoded (1000+ chars) are also saved as images |
| **Timeouts** | Tool calls are wrapped in a configurable timeout (default 60s, use `--timeout` to change) |
| **Truncation** | Text responses exceeding the limit (default 50K chars, use `--max-text` to change) are truncated |

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
| **TargetManager** | `src/target-manager.ts` | Spawns the target MCP server, manages the MCP Client connection, forwards all MCP primitives (tools, resources, prompts, logging), captures stderr, tracks lifecycle |
| **ResponseInterceptor** | `src/interceptor.ts` | Wraps tool calls with timeouts, extracts base64 images and audio to disk, truncates oversized text |
| **REPLMode** | `src/repl.ts` | Interactive readline REPL with shorthand command parsing and script mode |
| **ProxyMode** | `src/proxy.ts` | MCP Server that transparently forwards all MCP primitives to the target, with tool responses running through the interceptor |

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