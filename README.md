# run-mcp

### A thin MCP client for humans and agents — test the server you're building without touching a config file.

[![CI](https://github.com/funkyfunc/run-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/funkyfunc/run-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/run-mcp)](https://www.npmjs.com/package/run-mcp)
[![license](https://img.shields.io/npm/l/run-mcp)](./LICENSE)

Change your [Model Context Protocol](https://modelcontextprotocol.io) server's code and test it
immediately — no editing `mcp.json`, no restarting your agent, no publishing to npm first.
`run-mcp` spawns the server, calls its tools, shows you its stderr when it crashes, and
restarts it on demand.

`run-mcp` provides three interfaces for interacting with MCP servers:

1. **Agent MCP Server** (`run-mcp`) — An MCP server that exposes tools (`connect_to_mcp`, `call_mcp_primitive`, `reconnect_to_mcp`) so AI agents can dynamically connect to and test local MCP projects without hardcoding them in configuration files. This is the **default mode** when you run `npx -y run-mcp`.
2. **Interactive REPL** (`run-mcp -- node server.js`) — A human-friendly CLI for developers to manually test and explore MCP servers using short, memorable commands (`tools/call`, `status`, etc.).
3. **Headless CLI** (`run-mcp call`, `run-mcp list-tools`, etc.) — Subcommands that print clean JSON to stdout. This is the loop an agent uses from a shell when it can't (or doesn't want to) add run-mcp to its own MCP config: add `--session <name>` and the server stays up between commands, with `reconnect`, `stderr`, and `validate` available against the running instance. Also works one-shot for CI, shell scripts, and `jq`.

### Interception Rules (Agent Server & REPL)

To protect the CLI and parent agents from large payloads, `run-mcp` automatically applies the following rules:

- **Saving images to disk** instead of passing multi-MB base64 strings through
- **Enforcing timeouts** so a hung tool call doesn't block forever
- **Spilling huge text to disk**: oversized responses are saved in full, and the truncated reply carries a result id — page through the rest with the `read_result` tool (or just open the file)

For humans, the REPL mode provides a quick way to test any MCP server without writing client code.

## Installation

Nothing to install for a one-off — `npx` fetches it:

```bash
npx -y run-mcp -- node path/to/my-mcp-server.js
```

To give your agent the tools, add it to your MCP config (`mcp.json`, `.mcp.json`, `claude_desktop_config.json`, …):

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

Or install it globally so `run-mcp` is on your PATH:

```bash
npm install -g run-mcp
```

Requires Node.js 20.11 or newer. To work on `run-mcp` itself, see [Development](#development).

## Quick Start

### REPL Mode — Test an MCP server interactively

```bash
# Start a REPL session with any MCP server
run-mcp -- node path/to/my-mcp-server.js

# Pass the environment your server needs (see "Environment variables" below)
run-mcp --env API_KEY=sk-123 -- node path/to/my-mcp-server.js

# Or start it without arguments to pick a server from your existing MCP configs
run-mcp
```

The picker reads the configs of Claude Code (all three scopes: user, project `.mcp.json`, and the per-project "local" scope that `claude mcp add` uses by default), Claude Desktop, Cursor, Windsurf, Cline, VS Code, Copilot CLI, and Gemini CLI. Each entry is labelled with where it came from, and a config's `env` block is applied when you pick it.

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

<!-- OPTIONS_START -->
| Option | Description |
| :--- | :--- |
| `-V, --version` | output the version number |
| `-o, --out-dir <path>` | Directory to save intercepted images and audio |
| `-t, --timeout <ms>` | Default tool call timeout in milliseconds (default: 300000) (Agent Mode only) |
| `--max-text <chars>` | Max text response length before truncation (default: 50000) (Agent Mode only) |
| `-m, --media-threshold <kb>` | Media size threshold in KB to save to disk (0 to always save, -1 to keep inline) |
| `-e, --env <KEY=VALUE>` | Environment variable for the target server (repeatable). Only PATH/HOME and a few basics are inherited; anything else your server reads must be passed here. |
| `--mcp` | Force start Agent Server mode even if run interactively without arguments |
| `-s, --script <file>` | Read commands from a file instead of stdin (REPL Mode only) |
| `--color <mode>` | Color output mode: always, never, auto (default: auto) |
| `--open-media` | Automatically open intercepted images and audio files using the host OS viewer |
| `--scan` | Scan the current workspace and parent directories for any JSON files containing mcpServers |
| `--transport <mode>` | Transport for http(s) targets: auto (default), http (Streamable HTTP), sse |
| `--protocol <mode>` | Handshake to open with: legacy (default, the 2025 initialize), auto (probe for 2026-07-28, fall back to legacy), or a revision to pin such as 2026-07-28 (no fallback) |
| `-w, --watch` | Watch the current directory for file changes and auto-reconnect (REPL Mode only) |
| `-h, --help` | display help for command |
<!-- OPTIONS_END -->

Examples:
  $ run-mcp                                       # Test harness (agent mode)
  $ run-mcp -- node my-server.js                  # Interactive testing (human REPL mode)
  $ run-mcp -s test.txt -- node my-server.js      # Run a script in REPL mode
  $ run-mcp -- npx -y some-mcp-server             # Test an npx server
  $ run-mcp --out-dir ./test-output               # Agent mode with options
  $ run-mcp --out-dir ./screenshots -- node srv.js # REPL mode with options

## Environment variables

The target server does **not** inherit your shell's environment. Like every MCP client, `run-mcp` starts it with only a small whitelist (`PATH`, `HOME`, `SHELL`, `USER`, and their Windows equivalents), so `API_KEY=… run-mcp …` does not reach it. Pass what your server reads explicitly:

```bash
# REPL and headless: repeat --env (or -e) per variable; the first "=" splits key from value
run-mcp --env API_KEY=sk-123 --env LOG_LEVEL=debug -- node my-server.js
run-mcp call search q=hello --env API_KEY=sk-123 -- node my-server.js

# Sessions remember the env they were started with; attach without repeating it
run-mcp list-tools --session dev --env API_KEY=sk-123 -- node my-server.js
run-mcp call search q=hello --session dev
```

From the agent server, pass `env` to `connect_to_mcp` (or `auto_connect.env`); it is kept across `reconnect_to_mcp`. When you pick a server from a discovered config in the REPL, that config's `env` block is applied, with `--env` values on top.

## Protocol revisions: 2025 vs 2026-07-28

MCP has two **eras**. Every revision through 2025-11-25 opens with an `initialize` handshake, pushes notifications unsolicited, and lets a server send `elicitation/create` / `sampling/createMessage` / `roots/list` requests to the client. Revision **2026-07-28** starts the modern era: a `server/discover` probe instead of `initialize`, change notifications only over a `subscriptions/listen` stream the client opens, and client input requested **in-band** by returning `input_required` from a tool. A server built on SDK v2 with `serveStdio` serves both from one factory, and a client that connects the old way gets the old behaviour — including the SDK's legacy shim for `input_required` — without any sign that the modern path was never exercised.

`run-mcp` makes the era explicit and lets you choose it:

```bash
run-mcp -- node my-server.js                          # legacy handshake (default) — the banner says so
run-mcp --protocol auto -- node my-server.js          # probe; modern if the server offers it, else legacy
run-mcp --protocol 2026-07-28 -- node my-server.js    # modern only; fails loudly if the server can't
run-mcp validate --deep --protocol 2026-07-28 -- node my-server.js
```

- **The era shows up everywhere:** the REPL banner and `status`, headless `Connected` lines and the `--raw` envelope's `protocol` field, `connect_to_mcp` / `mcp_server_status`, and `validate` (`protocolEra`, `protocolVersion`).
- **Sessions remember it:** `--protocol` is fixed when the session is created; a later call asking for a different one is refused, like a different command or `--env`.
- **Subscriptions follow the era.** On a modern connection `run-mcp` opens a `listen` stream for every `listChanged` type your server advertises, and `resources/subscribe` / `subscribe_to_resource` open a per-URI stream. What the server *honored* is reported, so a filter it accepted but will never deliver on is visible.
- **Client input is counted.** `input_required` rounds (modern) and server→client requests (legacy) both go through the same elicitation/sampling/roots handlers; every call reports how many it needed (`input_requests` in `include_metadata` and `call --raw`, a line under the REPL result). Headless mode answers deterministically — elicitation declined, sampling refused — instead of hanging.
- **The default stays legacy** on purpose: a spawn-per-invocation tool must not pay a probe on every connect, and a probe would change what a legacy server sees. Pass `auto` or a pin when you mean it.

Sampling, roots, and the `logging` capability are deprecated as of 2026-07-28 but stay in the spec for at least twelve months; `run-mcp` keeps exercising them.

## Watch Mode

When developing an MCP server, use `--watch` (or `-w`) to automatically reconnect whenever your source files change. This eliminates the manual `reconnect` step from your edit-test loop:

```bash
run-mcp -w -- node my-server.js
```

On each file change, `run-mcp` will:
1. Detect the changed files (debounced to 500ms to batch rapid saves)
2. Disconnect from the current server process
3. Reconnect to a fresh instance
4. Show a diff of what primitives changed (tools added/removed/modified, resources, prompts)

Common directories like `node_modules`, `.git`, `dist`, and `build` are automatically ignored. If the server runs *from* one of those (`node dist/index.js` with a separate compile step), `run-mcp` watches that directory instead of your sources, so the reconnect follows the rebuild rather than the save and never spawns stale code.

## Headless Mode (from a shell, one command at a time)

`run-mcp` exposes a suite of headless subcommands that print clean JSON to stdout and keep status messages on stderr. Without `--session` each command spawns the server fresh — fine for CI and `jq` one-liners. **For a dev loop, use [sessions](#-persistent-sessions-the-dev-loop-from-a-shell)**: the server stays up, and `reconnect`/`stderr`/`validate` work against the running instance.

> **If you're an agent driving run-mcp through a shell tool** that merges stdout and stderr: use `--session`. A sessioned call prints nothing but the JSON result, and the server's stderr is reachable as data (`run-mcp stderr --session <name>`, or the `stderr` field of `call --raw`) instead of interleaving with your output.

### ⚠️ Double-Dash `--` Separator

To prevent argument parsing conflicts between `run-mcp` and the target server, you should separate the target command with a double-dash `--` when the target command itself contains flags or options.

* **Required when the target command has options/flags:**
  ```bash
  run-mcp list-tools -- node my-server.js --verbose
  ```
  *(Must use `--` so `--verbose` is passed to your server, not parsed as an option for `run-mcp`.)*
* **Optional when the target command has no options/flags:**
  ```bash
  run-mcp list-tools node my-server.js
  ```
  *(Runs successfully without `--`.)*

### ⚡ HTTPie-Style Shorthand Arguments

Instead of escaping complex JSON strings on the command line, you can provide arguments using simple key-value shorthand notation:

- `key=value` -> evaluated as a string
- `key:=json_val` -> parsed as a JSON primitive (boolean, number, array, object, null)

_Example:_

```bash
# Call a tool using shorthand arguments
run-mcp call greet name=Alice count:=5 -- node my-server.js
```

### 🔄 Persistent Sessions (the dev loop from a shell)

Without a session, every headless command spawns a fresh process of the target server — slow (a server that launches a browser pays that cost on every call) and stateless. Pass `--session <name>` and the first call spawns a background daemon that keeps the server running; every later command with the same name attaches to it, needs no target command, and prints nothing but the result:

```bash
# First call spawns the session (and, say, launches the browser)
run-mcp call browser_launch headless:=true --session main -- node browser-server.js

# Later calls reuse the running server — no cold start, no progress lines
run-mcp call browser_navigate url=https://google.com --session main
run-mcp list-tools --session main

# The server's stderr, as a JSON array of lines (everything since it started, or the last N)
run-mcp stderr --session main
run-mcp stderr 20 --session main

# Edit your server's code, then restart it and see what your edit changed
run-mcp reconnect --session main
#   { "reconnected": true, "pid": 4242, "command": "node browser-server.js",
#     "changes": ["Changes since last connection:", "  Tools: +1 added (browser_pdf)"] }
# If the new code fails to start, the result carries the crash output inline
# ({ "reconnected": false, "error": ..., "stderr": [...] }); the old process is
# gone, `stderr --session` still shows why, and `reconnect` again once it's fixed.

# Spec-compliance checks against the running instance
run-mcp validate --deep --session main

# Stop the server and the daemon
run-mcp close-session main
```

`--show-stderr` on a sessioned call replays the stderr the server wrote *during that call* (the daemon holds the pipe, so it can't stream live). `--out-dir`, `--timeout`, and `--media-threshold` apply per call, exactly as without a session. `--transport` and `--env` are fixed when the session is created.

**Keeping track of sessions.** `run-mcp sessions` lists what's running — name, pid, command, working directory, env keys, uptime, idle timeout — as JSON. A session remembers the command, directory, and env it was started with: if you pass a *different* command (or the same relative command from a different directory, or a different `--env`) with an existing session name, the call is refused with the difference shown, rather than quietly answered by the wrong server. Omit the command to attach, `close-session` to replace.

**Nothing leaks.** A session lives until you `close-session` it — which means a forgotten one keeps its server (and whatever the server holds, like a browser) alive until reboot. Pass `--idle-timeout <minutes>` on any sessioned call to have it close itself after that long without a command; the value shows up in `sessions`. If the server fails to start on the first sessioned call, the call exits 69 with the server's stderr, and no session is left behind. The daemon listens on a Unix socket (a named pipe on Windows) inside an owner-only directory under your temp dir, so no other user on the machine can reach your server through it.

### 🔎 Stderr as data

The server's stderr is the main evidence when something goes wrong, so headless mode makes it available without you having to untangle it from stdout:

- `run-mcp call <tool> --raw` includes a `stderr` array in the result envelope: the lines written during that call (in one-shot mode: everything since the server was spawned, startup output included).
- `run-mcp stderr -- node server.js` prints what a fresh spawn writes at startup.
- A server that dies during connect has its stderr printed under `--- Target server stderr ---`, instead of just `Connection closed`.

### 🚨 stdout is the protocol channel

The single most common stdio bug is a `console.log` in the server: stdout carries JSON-RPC, so any other line corrupts the channel. The SDK's transport skips such lines silently, which means the server "works" under `run-mcp` and breaks under a stricter client. `run-mcp` watches the child's stdout itself and reports every non-JSON line: a yellow warning in the REPL, `stdout_noise` in `call --raw` plus a `Warning:` on stderr in headless mode, a section in `mcp_server_status` and `get_mcp_server_stderr`, and a **FAIL** in `validate` (`stdout_protocol_channel`). Transport-level errors the SDK only reports through a callback (a message that parsed as JSON but isn't valid JSON-RPC, a buffer overflow) are captured the same way (`transport_errors`).

### Available Headless Subcommands

<!-- SUBCOMMANDS_START -->
- `call [options] <tool> [json_args] [target_command...]`
- `list-tools [options] [target_command...]`
- `list-resources [options] [target_command...]`
- `list-prompts [options] [target_command...]`
- `read [options] <uri> [target_command...]`
- `describe [options] <tool> [target_command...]`
- `get-prompt [options] <name> [json_args] [target_command...]`
- `stderr [options] [count] [target_command...]`
- `reconnect [options] [target_command...]`
- `sessions`
- `close-session <session_name>`
- `validate [options] [target_command...]`
<!-- SUBCOMMANDS_END -->

Use `run-mcp <subcommand> --help` for specific command options.

## Agent Use Cases

### Dynamic Testing

When an AI agent is actively _developing_ an MCP server, it needs to test it. Standard MCP clients require updating a configuration file (`mcp.json`) and restarting the agent session entirely.

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

<!-- AGENT_TOOLS_START -->
| Tool | Description |
| :--- | :--- |
| `connect_to_mcp` | Spawn and connect (use include to get tools/resources/prompts) |
| `call_mcp_primitive` | Call a tool, read a resource, or get a prompt (auto-connects) |
| `list_mcp_primitives` | List tools, resources, and/or prompts |
| `get_server_notifications` | Inspect notifications the target emitted (list_changed, updates, logs) |
| `subscribe_to_resource` | Exercise a server's resource-subscription support |
| `reconnect_to_mcp` | Restart the target after a code edit and diff what changed |
| `read_result` | Page through an oversized result spilled to disk |
| `disconnect_from_mcp` | Tear down and reconnect after changes |
| `mcp_server_status` | Check connection status |
| `get_mcp_server_stderr` | View target server stderr output |
| `validate_mcp_server` | Validate an MCP server command and collect diagnostics |
| `list_available_mcp_servers` | List local MCP servers found in config files |
<!-- AGENT_TOOLS_END -->

## REPL Mode Commands

Once connected via `run-mcp <command>`, the following shorthand commands are available:

<!-- REPL_COMMANDS_START -->
| Command | Description |
| :--- | :--- |
| `tools/list` | List all available tools |
| `tools/describe <name>` | Show a tool's input schema |
| `tools/call <name> [json] [opts]` | Call a tool (interactive if no json) |
| `tools/scaffold <name>` | Generate argument template for a tool |
| `resources/list` | List all available resources |
| `resources/read <uri>` | Read a resource by URI |
| `resources/templates` | List resource templates |
| `resources/subscribe <uri>` | Subscribe to resource changes |
| `resources/unsubscribe <uri>` | Unsubscribe from resource changes |
| `prompts/list` | List all available prompts |
| `prompts/get <name> [json_args]` | Get a prompt with arguments |
| `ping` | Verify connection, show round-trip time |
| `log-level <level>` | Set server logging verbosity |
| `history [count|clear]` | Show request/response history |
| `notifications [count|clear]` | Show server notifications |
| `roots/list` | Show configured client roots |
| `roots/add <uri> [name]` | Add a root directory |
| `roots/remove <uri>` | Remove a root directory |
| `!! / last` | Re-run the last command |
| `reconnect` | Disconnect and reconnect |
| `timing` | Show tool call performance stats |
| `status` | Show target server status |
<!-- REPL_COMMANDS_END -->

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

### Direct Inline Tool Calls & Shorthand Arguments

Instead of prefixing every tool call with `tools/call`, you can invoke any target server tool directly by name, and provide arguments in shorthand key-value form:

```bash
# Direct inline tool execution with HTTPie shorthand parameters
> greet name=Bob count:=3
```

### Interactive Wizard & Argument Memory

If you invoke a tool without JSON arguments, `run-mcp` will guide you through an interactive scaffolding wizard:

```bash
> tools/call send_message
✔ text (string) Message text to send: Hello World!
✔ Select optional arguments to provide: channel
✔ channel (string) The Slack channel: general
✔ Execute? Yes
  Calling send_message...
```

`run-mcp` actively **remembers** your inputs across identical interactive calls, scaffolding defaults based on your last execution! Use `tools/forget` or `--clear` if you need a clean slate.

### Script Mode

You can automate REPL commands by writing them to a file:

```bash
# commands.txt
tools/list
tools/call get_status {}
tools/call screenshot {"save_path": "/tmp/test.png"}
```

```bash
run-mcp -s commands.txt -- node my-server.js
```

- Lines starting with `#` are treated as comments
- Exits with code `0` on success, `1` on first error

### Testing your server's client-facing behavior

Some MCP features depend on what the *client* provides. `run-mcp` exposes these so
an agent can exercise them:

- **Roots** — pass `roots` to `connect_to_mcp` (or `reconnect_to_mcp`) and your
  server's `roots/list` calls get a real answer. `run-mcp` advertises the roots
  capability, so without this your server correctly sees an empty list. Roots
  persist across reconnects.
- **Log level** — pass `log_level` to raise your server's logging verbosity.
- **Notifications** — `get_server_notifications` shows what your server emitted
  (`tools/list_changed`, `resources/updated`, log messages). These travel outside
  the request/response flow, so a tool result will never reveal them.
- **Subscriptions** — `subscribe_to_resource`, then trigger a change and confirm
  with `get_server_notifications(method='resources/updated')`. On a 2026-07-28
  connection this opens a `subscriptions/listen` stream and reports what the
  server honored.
- **Protocol era** — pass `protocol: "2026-07-28"` to `connect_to_mcp` to test
  the modern path of a server that serves both eras; the reply names the era it
  got. See [Protocol revisions](#protocol-revisions-2025-vs-2026-07-28).

## Agent Server Mode — How It Works

Run with no target command (or `--mcp`), `run-mcp` is itself an MCP server that
exposes tools (`connect_to_mcp`, `call_mcp_primitive`, `reconnect_to_mcp`, …) so an
agent can dynamically spawn and test local MCP servers. Tool-call responses are
processed through the interceptor pipeline:

| Feature              | Behavior                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Image extraction** | `type: "image"` responses with base64 data are saved to disk. Replaced with `[Image saved to /path/to/img.png (24KB)]`   |
| **Audio extraction** | `type: "audio"` responses with base64 data are saved to disk. Replaced with `[Audio saved to /path/to/audio.wav (12KB)]` |
| **Base64 detection** | Text responses that are entirely base64-encoded (1000+ chars) are also saved as images                                   |
| **Timeouts**         | Tool calls are wrapped in a configurable timeout (default 5 minutes, use `--timeout` to change)                          |
| **Truncation**       | Text exceeding the limit (default 50K chars, `--max-text` to change) is saved in full to disk; the reply keeps the head plus a result id, navigable via the `read_result` tool |

## Architecture

For the detailed system architecture diagram and source module directory map, please refer to [AGENTS.md](file:///Users/stompinggrounds/Development/run-mcp/AGENTS.md).

## Development

```bash
# Install dependencies (Node.js 20.11+)
npm install

# Build (one-time)
npm run build

# Watch mode (rebuild on changes)
npm run dev

# Run directly
node dist/index.js -- <target_command...>
```

## License

MIT
