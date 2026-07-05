# run-mcp

A smart proxy, interactive REPL, and live test harness for [Model Context Protocol](https://modelcontextprotocol.io) (MCP) servers.

`run-mcp` operates in two modes:

1. **Agent MCP Server** (`run-mcp`) — An MCP server that exposes tools (`connect_to_mcp`, `call_mcp_tool`) so AI agents can dynamically connect to and test local MCP projects without hardcoding them in configuration files. This is the **default mode** when you run `npx -y run-mcp`.
2. **Interactive REPL** (Interactive mode) — A headless CLI for human developers to manually test and explore MCP servers using short, memorable commands (`tools/call`, `status`, etc.).

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
run-mcp -- node path/to/my-mcp-server.js

# Or use npx without installing globally
npx . -- node path/to/my-mcp-server.js

# Or start it without arguments to run the Agent Server mode!
run-mcp
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

<!-- OPTIONS_START -->
| Option | Description |
| :--- | :--- |
| `-V, --version` | output the version number |
| `-o, --out-dir <path>` | Directory to save intercepted images and audio |
| `-t, --timeout <ms>` | Default tool call timeout in milliseconds (default: 300000) (Agent Mode only) |
| `--max-text <chars>` | Max text response length before truncation (default: 50000) (Agent Mode only) |
| `-m, --media-threshold <kb>` | Media size threshold in KB to save to disk (0 to always save, -1 to keep inline) |
| `--mcp` | Force start Agent Server mode even if run interactively without arguments |
| `-s, --script <file>` | Read commands from a file instead of stdin (REPL Mode only) |
| `--color <mode>` | Color output mode: always, never, auto (default: auto) |
| `--open-media` | Automatically open intercepted images and audio files using the host OS viewer |
| `--sandbox <mode>` | Sandbox execution mode: auto, docker, native, audit, none (default: "none") |
| `--scan` | Scan the current workspace and parent directories for any JSON files containing mcpServers |
| `--allow-read <paths...>` | Paths to allow reading under the sandbox |
| `--allow-write <paths...>` | Paths to allow writing under the sandbox |
| `--allow-net <domains...>` | Network domains to allow connecting to under the sandbox |
| `--deny-read <paths...>` | Paths to deny reading under the sandbox |
| `--deny-write <paths...>` | Paths to deny writing under the sandbox |
| `--deny-net <domains...>` | Network domains to deny connecting to under the sandbox |
| `-h, --help` | display help for command |
<!-- OPTIONS_END -->

Examples:
  $ run-mcp                                       # Test harness (agent mode)
  $ run-mcp -- node my-server.js                  # Interactive testing (human REPL mode)
  $ run-mcp -s test.txt -- node my-server.js      # Run a script in REPL mode
  $ run-mcp -- npx -y some-mcp-server             # Test an npx server
  $ run-mcp --out-dir ./test-output               # Agent mode with options
  $ run-mcp --out-dir ./screenshots -- node srv.js # REPL mode with options

## Headless Mode (Single-Shot CI/CD)

For CI/CD pipelines, shell scripts, or parsing via `jq`, `run-mcp` exposes a suite of headless subcommands that pipe clean JSON to stdout and isolate standard errors and progress updates to stderr.

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

### 🔄 Stateful/Persistent CLI Sessions

Normally, every headless command spawns a fresh process of the target server, which is slow and discards connection state. By passing `--session <name>`, `run-mcp` will spawn a persistent background daemon on the first call. Subsequent commands will dynamically attach to the same running session:

```bash
# Spawns a background session daemon & launches a browser
run-mcp call browser_launch headless:=true --session main -- node browser-server.js

# Navigates the browser on the active running session (no target command needed!)
run-mcp call browser_navigate url=https://google.com --session main

# Closes the session and stops the background target server
run-mcp close-session main
```

### Available Headless Subcommands

<!-- SUBCOMMANDS_START -->
- `call [options] <tool> [json_args] [target_command...]`
- `list-tools [options] [target_command...]`
- `list-resources [options] [target_command...]`
- `list-prompts [options] [target_command...]`
- `read [options] <uri> [target_command...]`
- `describe [options] <tool> [target_command...]`
- `get-prompt [options] <name> [json_args] [target_command...]`
- `daemon [options] <session_name> [target_command...]`
- `close-session <session_name>`
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
| `disconnect_from_mcp` | Tear down and reconnect after changes |
| `mcp_server_status` | Check connection status |
| `get_mcp_server_stderr` | View target server stderr output |
| `validate_mcp_server` | Validate an MCP server command and collect diagnostics |
| `search_all_local_mcp_servers` | Scan and search all local MCP servers for a query |
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

## Proxy Mode — How It Works

In proxy mode, `run-mcp` acts as an MCP server itself. Configure it as the command your AI agent spawns:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "run-mcp",
      "args": ["--mcp", "--out-dir", "./images", "--", "node", "path/to/actual-server.js"]
    }
  }
}
```

### What the proxy forwards

The proxy dynamically mirrors the target server's capabilities. All MCP primitives that the target supports are forwarded transparently:

| Primitive                                                                      | Forwarded?                        |
| ------------------------------------------------------------------------------ | --------------------------------- |
| **Tools** (`tools/list`, `tools/call`)                                         | ✅ Always (with interception)     |
| **Resources** (`resources/list`, `resources/read`, `resources/templates/list`) | ✅ If target supports             |
| **Prompts** (`prompts/list`, `prompts/get`)                                    | ✅ If target supports             |
| **Logging** (`logging/setLevel`)                                               | ✅ If target supports             |
| **Completion** (`completion/complete`)                                         | ✅ If target supports             |
| **Notifications** (list changes, logging)                                      | ✅ Forwarded from target to agent |
| **Tool annotations** (`readOnlyHint`, `destructiveHint`, etc.)                 | ✅ Preserved as-is                |
| **Pagination** (`nextCursor` / `cursor`)                                       | ✅ Passed through                 |

### What the proxy intercepts

Tool call responses are processed through the interceptor pipeline. All other primitives pass through untouched.

| Feature              | Behavior                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Image extraction** | `type: "image"` responses with base64 data are saved to disk. Replaced with `[Image saved to /path/to/img.png (24KB)]`   |
| **Audio extraction** | `type: "audio"` responses with base64 data are saved to disk. Replaced with `[Audio saved to /path/to/audio.wav (12KB)]` |
| **Base64 detection** | Text responses that are entirely base64-encoded (1000+ chars) are also saved as images                                   |
| **Timeouts**         | Tool calls are wrapped in a configurable timeout (default 60s, use `--timeout` to change)                                |
| **Truncation**       | Text responses exceeding the limit (default 50K chars, use `--max-text` to change) are truncated                         |

## Sandboxing & Outbound Data Exfiltration Protection

`run-mcp` features a comprehensive multi-layered sandboxing engine designed to protect local systems and credentials from malicious or buggy MCP servers.

### 🛡️ Sandboxing Modes

You can restrict a target server's execution footprint using the `--sandbox` flag:

- **`none`** (Default): No sandboxing. The target server runs with full user privileges.
- **`auto`**: Automatically selects the most restrictive sandboxing system available on the host OS.
- **`native`**: Uses OS-level native isolation:
  - **macOS**: Utilizes the Seatbelt (App Sandbox) framework (`sandbox-exec`).
  - **Linux**: Utilizes `bubblewrap` (`bwrap`) containerization.
  - **Windows**: Utilizes `@microsoft/mxc-sdk` App Container sandboxing (requires the package to be present).
- **`docker`**: Spawns the target command inside a fresh, network-disabled ephemeral Docker container (`node:20` or `python:3` depending on the command).
- **`audit`**: Runs the server under a special non-enforcing native sandbox mode that permits operations but logs all network activity to the console.

### 🌐 Outbound Network Proxy Auditing

When a sandboxed server is granted outbound network access (e.g., using `--allow-net`), `run-mcp` automatically spawns a zero-dependency local **Network Audit Proxy**.
- All outbound HTTP/HTTPS traffic is forced through the proxy using environment variables.
- Target endpoints and protocols (including HTTPS `CONNECT` tunnels) are transparently logged to stderr in distinct cyan color:
  ```
  🌐 [NETWORK AUDIT] HTTP request to: http://example.com/api/v1/data
  🌐 [NETWORK AUDIT] HTTPS connection established to: github.com
  ```
- Permits outbound traffic while providing complete visibility into where the server is sending data.

### 🔑 Automatic Credential Protection (Deny-Wins)

When outbound network capability is enabled, `run-mcp` automatically safeguards your local configuration files and private keys from exfiltration. 
By default, the sandbox denies access to the following directories:
- `~/.ssh` (SSH private keys and configs)
- `~/.aws` (AWS credentials)
- `~/.kube` (Kubernetes configurations)
- `~/.config/gcloud` (Google Cloud SDK credentials)
- `~/.netrc` and `~/.npmrc` (Authentication files)

Access is strictly blocked using **Deny-Wins** precedence unless a folder is explicitly whitelisted.

### ⚙️ Capabilities & Configuration

You can configure sandbox rules on the command line or using structured JSON settings files.

#### CLI Overrides

Pass these flags after `run-mcp` and before the target command:
- `--sandbox <mode>`: Set sandbox execution mode (`auto`, `native`, `docker`, `audit`, `none`).
- `--allow-read <paths...>`: Allow reading specific host directories.
- `--allow-write <paths...>`: Allow writing to specific host directories.
- `--allow-net <domains...>`: Allow outbound network access to specific domains.
- `--deny-read <paths...>`: Deny reading specific host directories.
- `--deny-write <paths...>`: Deny writing to specific host directories.
- `--deny-net <domains...>`: Deny outbound network access to specific domains.

#### Configuration Scopes

`run-mcp` resolves settings hierarchically, allowing both administrator enforcement and developer configuration:
1. **Managed (Enterprise)**: System-wide read-only overrides (`/Library/Application Support/run-mcp/settings.json`, `C:\Program Files\run-mcp\settings.json`, `/etc/run-mcp/settings.json`).
2. **User (Global)**: Personal defaults (`~/.gemini/antigravity-ide/settings.json` or equivalent).
3. **Project**: Shared settings within a repository (`<workspace>/.run-mcp.json`).
4. **Local**: Developer-specific project settings (`<workspace>/.run-mcp.local.json`).

*Example Settings File (`.run-mcp.json`):*
```json
{
  "sandbox": {
    "mode": "native",
    "allowRead": ["/usr/local/bin"],
    "allowNet": ["*.api.github.com"],
    "denyRead": ["~/.ssh"]
  }
}
```

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

| Module                  | File                    | Responsibility                                                                                                                                                       |
| ----------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TargetManager**       | `src/target-manager.ts` | Spawns the target MCP server, manages the MCP Client connection, forwards all MCP primitives (tools, resources, prompts, logging), captures stderr, tracks lifecycle |
| **ResponseInterceptor** | `src/interceptor.ts`    | Wraps tool calls with timeouts, extracts base64 images and audio to disk, truncates oversized text                                                                   |
| **REPLMode**            | `src/repl.ts`           | Interactive readline REPL with shorthand command parsing and script mode                                                                                             |
| **AgentServer**         | `src/server.ts`         | MCP Server that dynamically exposes primitives to agents and proxies target servers                                                  |

## Development

```bash
# Install dependencies
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
