# AGENTS.md

Welcome! If you are an AI agent (or a human new to the codebase) looking to contribute to `run-mcp`, this guide provides the architectural context, conventions, and workflows you need to be effective.

## 🧭 Design Philosophy

These principles define the soul of the project. Every feature, error message, and code change should reinforce them. If a change conflicts with any of these, rethink the approach.

### 1. Three Interfaces, One Pipeline

`run-mcp` exposes **three distinct interfaces** through the same `TargetManager` → `ResponseInterceptor` pipeline:

- **Interactive REPL** (`run-mcp -- node server.js`) — Human developers exploring and testing an MCP server with shorthand commands.
- **Headless CLI** (`run-mcp call`, `run-mcp list-tools`, etc.) — Single-shot subcommands for CI/CD pipelines, shell scripts, and `jq` workflows. Outputs clean JSON to stdout.
- **Agent MCP Server** (`run-mcp` with no args, or `--mcp`) — An MCP server itself, exposing tools like `connect_to_mcp` and `call_mcp_primitive` so AI agents can dynamically test local MCP servers without config changes.

All three share the same interception pipeline. The differences are in the input interface (readline vs. CLI args vs. MCP tools) and output format (human-readable vs. JSON vs. MCP responses).

### 2. Transparent by Default, Protective When Needed

The proxy should be **invisible** to well-behaved tools. If a tool returns a normal text response under 50KB, the proxy passes it through untouched — no extra latency, no transformation. The interceptor only activates when a response would **harm** the consumer:

- A 4MB base64 screenshot that would blow up the agent's context window → saved to disk.
- A tool call that hangs forever → timed out with an actionable message.
- A 200KB JSON dump → truncated with a size annotation.

If you're adding interception logic, make sure it's **opt-out by nature** — the default is passthrough.

### 3. Errors That Coach

A blind error like `"Connection failed"` wastes a retry cycle. Every error in this project should answer **three questions**: What went wrong? Why? What should the user try instead? Examples of this in practice:

- `Failed to start server: command "foo" not found. Check that "foo" is installed and in your PATH.`
- `Tool "slow" timed out after 60000ms (60.0s). Use --timeout <ms> to increase the limit.`
- `Unknown command: tols/list. Did you mean tools/list?`

When adding new error paths, **always include an actionable suggestion.** Never throw raw exceptions without context.

### 4. Zero Configuration

A user should be able to wrap any MCP server with `run-mcp -- node my-server.js` and have it work immediately. No config files, no environment variables required, no initialization step. Sensible defaults (5-minute timeout, 50KB truncation, `/tmp/run-mcp` for images) cover 90% of use cases. Flags exist for the other 10%.

### 5. Composable CLI

Follow the Unix philosophy: `run-mcp` reads from stdin, writes to stdout, logs to stderr, and returns meaningful exit codes. This means:

- **Script mode**: `run-mcp node foo.js --script commands.txt` exits `0` on success, `1` on first error. Composable with CI pipelines.
- **Process cleanup**: Always kill child processes on exit (SIGINT, SIGTERM, process.exit). Never leave orphaned server processes.

### 6. Typo Tolerance

Users (especially agents) mistype things. The REPL uses Levenshtein distance matching to suggest corrections for unknown commands (`tols/list` → `Did you mean tools/list?`). When adding new user-facing inputs, consider whether a fuzzy match would reduce friction.

---

## 🏗️ Architecture

All three interfaces feed into the same interception pipeline. See `README.md` for the full architecture diagram.

```
  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
  │  REPL (human)│  │ Headless CLI │  │ Agent MCP Srv│
  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
         │                 │                 │
         └────────┬────────┴────────┬────────┘
                  │                 │
           ┌──────▼──────┐  ┌──────▼──────┐
           │ Interceptor │  │ TargetManager│
           │ (timeouts,  │──│ (MCP Client, │
           │  media save,│  │  sandbox,    │
           │  truncation)│  │  reconnect)  │
           └─────────────┘  └──────┬──────┘
                                   │ stdio / SSE
                            ┌──────▼──────┐
                            │ Target MCP  │
                            │   Server    │
                            └─────────────┘
```

### Source Modules

| Module                  | File(s)                 | Responsibility |
| ----------------------- | ----------------------- | -------------- |
| **CLI Entry**           | `src/index.ts`          | Commander-based CLI. Routes to REPL (target command provided), headless subcommands (`call`, `list-tools`, etc.), or Agent Server (no args / `--mcp`). Registers headless subcommands via `registerHeadlessCommand()`. |
| **TargetManager**       | `src/target-manager.ts` | Spawns the target MCP server, manages MCP Client connection (stdio/SSE), sandbox enforcement (Seatbelt, bwrap, Docker, MXC), auto-reconnect with loop protection, captures stderr, tracks process lifecycle. |
| **ResponseInterceptor** | `src/interceptor.ts`    | Wraps `callTool` with `Promise.race` timeouts, extracts base64 images/audio to disk, detects raw base64 text blobs, truncates oversized responses. Configurable via `InterceptorOptions`. |
| **REPL**                | `src/repl/`             | Interactive readline interface across 7 files: `commands.ts` (command routing), `completer.ts` (tab completion), `history.ts` (persistent history), `index.ts` (entry point), `state.ts` (shared state + `KNOWN_COMMANDS`), `ui.ts` (formatting/output), `wizard.ts` (interactive arg scaffolding). `src/repl.ts` is a re-export barrel. |
| **Agent Server**        | `src/server.ts`         | MCP Server exposing 9 tools (`connect_to_mcp`, `call_mcp_primitive`, `list_mcp_primitives`, `disconnect_from_mcp`, `mcp_server_status`, `get_mcp_server_stderr`, `list_available_mcp_servers`, `validate_mcp_server`, `search_all_local_mcp_servers`) for dynamic MCP server testing. Uses `registerTool()` with Zod schemas. |
| **Headless**            | `src/headless.ts`       | Single-shot executor for CLI subcommands. Connect → execute one operation → output JSON to stdout → exit. All status/progress to stderr for pipe-clean output. |
| **Settings**            | `src/settings.ts`       | Hierarchical sandbox policy loader (managed → user → project → local scopes). `SandboxPolicy` class for file/network permission evaluation, path resolution (`~`, `$HOME`), and Seatbelt profile generation. |
| **Validator**           | `src/validator.ts`      | Protocol compliance validator (`run-mcp validate`). Validates handshake, capabilities, tool schemas, resources, and prompts against the MCP JSON Schema. |
| **Snapshot**            | `src/snapshot.ts`       | Reconnect diffing: takes snapshots of tools/resources/prompts and computes what was added/removed/modified between connections. |
| **Watcher**             | `src/watcher.ts`        | File watcher for `--watch` mode. Debounced `fs.watch` with automatic ignore patterns (node_modules, .git, dist, etc.). |
| **Parsing**             | `src/parsing.ts`        | Pure functions: command line splitting, argument parsing, JSON formatting, HTTPie-style args (`key=val`, `key:=json`), Levenshtein distance, typo suggestions. |
| **Config Scanner**      | `src/config-scanner.ts` | Discovers MCP server configurations across VS Code, Cursor, Claude Desktop, Windsurf, Copilot, Gemini CLI, and local workspace files. Powers `list_available_mcp_servers` and the interactive picker. |
| **Proxy Audit**         | `src/proxy-audit.ts`    | HTTP/HTTPS proxy for `--sandbox audit` mode. Logs outbound network connections from sandboxed server processes to stderr. |
| **Colors**              | `src/colors.ts`         | Color constants and helpers using `picocolors` for consistent terminal styling across REPL and headless output. |
| **Plugins**             | `src/plugins.ts`        | Interceptor plugin framework (ordered middleware hooks: `onToolsList`, `onToolResult`, `onResourceResult`, `onPromptResult`) plus bundled plugins: `toolPoisoningScanner` (strips invisible/bidi Unicode + flags injection phrasing in tools/list) and `secretRedactionPlugin` (DLP redaction of secrets in results). |
| **Audit**               | `src/audit.ts`          | Append-only JSONL audit logger (`--audit-log`) recording every MCP request/response from `TargetManager`'s `history` event. |
| **Cassette**            | `src/cassette.ts`       | Record/replay ("VCR for MCP", `--cassette`/`--record`/`--replay`): captures tool/resource/prompt responses keyed by a canonical (primitive, name, args) hash and replays them deterministically. The interceptor short-circuits the target on a replay hit (offline in headless mode). |

### Auto-Reconnect Logic (TargetManager)

The REPL enables auto-reconnect for robustness during interactive sessions. The rules are designed to prevent retry loops on buggy servers:

1. **Min-uptime guard (5s)**: If the server crashes within 5 seconds of starting, it's treated as a startup bug — no retry. This prevents infinite loops when the server has a fatal error in its initialization.
2. **Retry cap (3)**: Maximum 3 consecutive reconnect attempts before giving up.
3. **Stability reset (60s)**: After 60 seconds of stable connection, the retry counter resets. A server that crashes once after 10 minutes of stability gets a fresh set of retries.
4. **MCP mode** exits on disconnect so the parent agent can decide what to do.

### Agent Usability Gotchas: `call_mcp_primitive`

A major pattern in `run-mcp` is multiplexing tasks (triggering a tool AND auto-connecting). Because the word "arguments" is heavily overloaded, `call_mcp_primitive` uses strict compartmentalization:

- **`arguments`**: A JSON object mapping to the _target MCP tool's input properties_.
- **`auto_connect.args`**: A string array used specifically for the OS spawn process (e.g. `["src/index.js", "--verbose"]`).

If an AI Agent is trying to provide parameters to a mock tool and accidentally lumps them under `args: {"foo": "bar"}`, Zod will intercept this and properly complain about a string-array requirement mismatch. The correct top-level key for tool payloads is **always** `arguments`.

---

## 🧠 Codebase Conventions

### TypeScript & ESM

- **Pure ESM** — `"type": "module"` in package.json. All imports use `.js` extensions (TypeScript resolves them to `.ts` at compile time).
- **tsup for bundling** — Produces a single `dist/index.js` (~360KB; ajv, ajv-formats, and @inquirer/prompts are bundled in, while `@modelcontextprotocol/sdk`, `commander`, `picocolors`, and `zod` stay external). No source maps in dist.
- **tsc for type-checking only** — `tsconfig.json` has `noEmit: true`. Run `npm run typecheck`.
- **Strict mode** — `strict: true` in tsconfig. No implicit any.

### Linting & Formatting (ESLint & Prettier)

- **ESLint** handles static analysis and code quality checks.
- **Prettier** handles formatting.
- **`@typescript-eslint/no-deprecated: "error"`** — type-aware linting rule that catches usage of deprecated properties, methods, classes, and imports.
- **`@typescript-eslint/no-explicit-any: "off"`** — relaxed because the MCP SDK returns loosely-typed results.
- **Style**: 2-space indent, double quotes, trailing commas, 100-char line width (defined in `.prettierrc`).
- Run `npm run lint` to check, `npm run lint:fix` to auto-fix, and `npm run format` to format.
- **Always run `npm run lint:fix` and `npm run format` before committing.**

### Intent-Based Naming

Name variables, functions, and classes to describe their business intent, not their data types. Examples:

- ✅ `_maybeReconnect()` — clearly describes when/why it runs
- ✅ `suggestCommand()` — you know what it does without reading the body
- ✅ `MIN_UPTIME_FOR_RESTART_MS` — self-documenting constant
- ❌ `processData()`, `handleStuff()`, `temp`

### Aggressive Early Returns

Flatten control flow with guard clauses. The happy path should be at the outermost indentation level:

```typescript
// ✅ Good
private async _maybeReconnect(): Promise<void> {
  if (!this._autoReconnect || this._reconnecting) return;
  if (uptimeMs < MIN_UPTIME_FOR_RESTART_MS) { this.emit("reconnect_failed", ...); return; }
  if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) { this.emit("reconnect_failed", ...); return; }
  // Happy path: attempt reconnect
}

// ❌ Bad
private async _maybeReconnect(): Promise<void> {
  if (this._autoReconnect && !this._reconnecting) {
    if (uptimeMs >= MIN_UPTIME_FOR_RESTART_MS) {
      if (this._reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        // deeply nested happy path
      }
    }
  }
}
```

### Extract for Testability

Pure logic should be in standalone functions that can be unit tested without spawning processes. The `src/parsing.ts` module is the pattern to follow:

- `parseCommandLine()`, `parseCallArgs()`, `suggestCommand()`, `levenshtein()` are all pure functions.
- They have **30 unit tests** that run in 4ms.
- The REPL imports them but doesn't own the logic.

When adding new logic, ask: _"Can I test this without a network connection or child process?"_ If yes, extract it.

### Static Cleanup Registration

`TargetManager` uses a **static set pattern** to manage process cleanup:

```typescript
private static _cleanupRegistered = false;
private static _instances = new Set<TargetManager>();
```

This prevents `MaxListenersExceeded` warnings when tests create many instances — signal handlers (`SIGINT`, `SIGTERM`) are registered **once**, and each instance adds itself to the static set. If you add new global state, follow this pattern rather than registering per-instance listeners.

---

## 🛠️ How to Add Features

### Adding a New REPL Command

1. **Add the command name** to `KNOWN_COMMANDS` in `src/repl/state.ts` (so typo suggestion and tab completion work).
2. **Add a `case` branch** in `handleCommand()` in `src/repl/commands.ts`, routing to a new `cmdFoo()` function.
3. **Implement `cmdFoo()`** following the existing pattern (validate input, call target, format output).
4. **Update `printHelp()`** in `src/repl/ui.ts` with the new command.
5. **Add the command** to the `--help` examples in `src/index.ts`.

### Adding a New Headless Subcommand

Headless subcommands use the `registerHeadlessCommand()` pattern in `src/index.ts`:

1. **Call `registerHeadlessCommand()`** with a config object specifying `name`, `description`, `args`, and a `buildOperation` function that returns the operation type.
2. **Add the operation type** to `HeadlessOperation` in `src/headless.ts` and handle it in `executeOperation()`.
3. **Add tests** in `tests/headless.test.ts`.

All headless subcommands automatically get shared options (`--out-dir`, `--timeout`, `--session`, `--sandbox`) and the `[target_command...]` variadic argument.

### Adding a New Interceptor Behavior

1. **Add a new `_processItem()` branch** in `src/interceptor.ts` (or a new method if complex).
2. **Add tests** in `tests/interceptor.test.ts`.
3. **Make it configurable** via `InterceptorOptions` if the behavior should be tunable.

### Adding a New CLI Flag

1. **Add the option** to the relevant commander subcommand in `src/index.ts`.
2. **Thread the value** through to the module that needs it (`repl/`, `server.ts`, `headless.ts`, or `interceptor.ts`).
3. Be mindful of argument parsing: the default REPL mode uses `passThroughOptions()`, but headless subcommands use the POSIX `--` separator to cleanly split CLI flags from the target command.

---

## 🧪 Testing

### Test Structure

| File                           | What it covers                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/parsing.test.ts`        | Pure parsing functions, JSON formatting, HTTPie-style args, Levenshtein distance, typo suggestions                                    |
| `tests/interceptor.test.ts`    | Image extraction, audio extraction, base64 detection, truncation, timeout behavior (mocked, no child processes)                       |
| `tests/target-manager.test.ts` | Full integration: spawns the mock server, tests connect/disconnect/listTools/callTool/auto-reconnect/sandbox                          |
| `tests/e2e.test.ts`            | End-to-end: TargetManager + ResponseInterceptor against the mock server                                                               |
| `tests/server.test.ts`         | Agent MCP Server: tool surface (call_mcp_primitive, list_mcp_primitives), auto-connect, disconnect_after, reconnect diff, diagnostics |
| `tests/headless.test.ts`       | Headless CLI subcommands: call, list-tools, list-resources, describe, sessions                                                        |
| `tests/settings.test.ts`       | Hierarchical settings loading, sandbox policy merging, path resolution                                                                |
| `tests/proxy-audit.test.ts`    | Network audit proxy HTTP/HTTPS logging                                                                                                |
| `tests/validator.test.ts`      | Protocol compliance validation against mock server                                                                                    |

### Running Tests

```bash
# Full suite (builds first via pretest hook)
npm test

# Just the tests (skip build)
npx vitest run

# Watch mode
npx vitest

# Single file
npx vitest run tests/parsing.test.ts
```

### Progressive / Dynamic Testing (For AI Agents)

While unit tests are great for verifying logic, `run-mcp` is a highly interactive tool. When making UX changes, prompt flow updates, or adding features to the REPL, **AI Agents should dynamically test their changes** just like a human developer would.

Instead of writing code blindly and relying solely on `vitest`, agents should spawn the app in the background and interact with it using their command input tools.

**How to dynamically test the REPL:**
Spawning the REPL with the built-in mock server gives you a safe sandbox to test commands, view UI elements (like separators and prompts), and ensure everything behaves correctly.

```bash
# Start the REPL interactively hooked up to the mock server
npm run start -- -- node --import tsx tests/fixtures/mock-server.ts
```

Once it's running in your background terminal, use your text/action input tools to simulate a user typing (`explore`, `tools/call echo {"text": "hello"}`, `exit`) and read the stream output to verify the UX formatting exactly as a human would see it!

**How to dynamically test the Agent Server (MCP Mode):**
Since `run-mcp` is _itself_ an MCP server when run in Agent Mode, you can test it recursively by using the human REPL to connect to its own server mode! If you are modifying tools inside `src/server.ts`:

```bash
# Build your changes first
npm run build

# Start the REPL connected to the built run-mcp Agent Server
npm run start -- -- node dist/index.js --mcp
```

Once connected, you can use `tools/list` or `explore` to invoke `call_mcp_primitive`, `list_available_mcp_servers`, or any other tool you just added directly from the terminal!

### Important: Sequential Execution

Tests run **sequentially** (`fileParallelism: false` in vitest.config.ts) because integration tests spawn child processes on stdio. Parallel execution causes port/stdin conflicts. Don't change this.

### Mock Server

`tests/fixtures/mock-server.ts` is a real MCP server that exposes predictable primitives for testing:

**Tools:**

| Tool            | Behavior                                                                        |
| --------------- | ------------------------------------------------------------------------------- |
| `echo`          | Returns the input text unchanged                                                |
| `greet`         | Returns `"Hello, {name}!"` (has tool annotations: readOnlyHint, idempotentHint) |
| `slow`          | Waits N ms before responding (timeout testing)                                  |
| `screenshot`    | Returns a fake base64 PNG (image interception testing)                          |
| `big_base64`    | Returns a large base64 text blob (heuristic detection testing)                  |
| `big_response`  | Returns N characters of text (truncation testing)                               |
| `multi_content` | Returns multiple content items                                                  |
| `audio_tool`    | Returns a fake base64 WAV clip (audio interception testing)                     |
| `error_tool`    | Returns `isError: true` (error passthrough testing)                             |

**Resources:**

| Resource              | Description                           |
| --------------------- | ------------------------------------- |
| `docs://readme`       | Markdown text resource                |
| `docs://config`       | JSON text resource                    |
| `docs://pages/{page}` | Resource template with path parameter |

**Prompts:**

| Prompt     | Description                                     |
| ---------- | ----------------------------------------------- |
| `greeting` | Takes a `name` argument, returns a user message |

The mock server uses the **non-deprecated** `McpServer.registerTool()` API. Tests run it via `tsx` (no compilation step) — see `tests/helpers.ts` for the shared spawn configuration.

### Adding Tests

- **Pure logic** → add to `tests/parsing.test.ts` (fast, no I/O)
- **Interception** → add to `tests/interceptor.test.ts` (mocked, no child processes)
- **Integration** → add to `tests/target-manager.test.ts` or `tests/e2e.test.ts` (spawns mock server)
- **Agent Server protocol** → add to `tests/server.test.ts` (spawns full MCP mode pipeline)
- **Headless CLI subcommands** → add to `tests/headless.test.ts`
- **Sandbox / settings** → add to `tests/settings.test.ts`
- **Protocol validation** → add to `tests/validator.test.ts`
- **If you add a new tool/resource/prompt to the mock server**, add test coverage in the appropriate test file

---

## 📦 Build & Release

### Scripts

```bash
npm run build        # tsup → dist/index.js (single bundled ESM file)
npm run dev          # tsup --watch (rebuild on save)
npm run typecheck    # tsc --noEmit (type-check without emitting)
npm run lint         # eslint src tests (lint check)
npm run lint:fix     # eslint src tests --fix (lint auto-fix)
npm run format       # prettier formatting
npm test             # pretest (build) + vitest run
```

### Before Committing

1. `npm run lint:fix` — fix formatting and lint issues
2. `npm test` — ensure all tests pass
3. `npm run typecheck` — catch type errors not covered by tsup

### npx Compatibility

The package is designed to work with `npx run-mcp`:

- `"bin": { "run-mcp": "dist/index.js" }` — the shebang (`#!/usr/bin/env node`) is preserved by tsup.
- `"files": ["dist"]` — only `dist/index.js` is published (no source, no tests, no source maps).
- `"prepublishOnly": "tsup"` — auto-builds before `npm publish`. (Note: unlike `build`, this does not refresh the README help tables — run `npm run build` before publishing if CLI help changed.)
- Bundled `dist/index.js` is ~360KB (ajv + @inquirer/prompts bundled); compressed tarball is a few tens of KB.

### MCP SDK Usage

- **Client** (`@modelcontextprotocol/sdk/client/index.js`) — used by `TargetManager` to connect to the target server. Not deprecated.
- **McpServer** (`@modelcontextprotocol/sdk/server/mcp.js`) — used by MCP mode. Non-deprecated. Use `registerTool()` for standard tool registration.
- **`server.tool()`** — **DEPRECATED**. Use `server.registerTool()` instead.
- **`Server`** (`@modelcontextprotocol/sdk/server/index.js`) — **DEPRECATED**. Use `McpServer` instead. The proxy accesses `mcpServer.server` for low-level request handlers, but imports `McpServer`.

---

## 🚫 Common Pitfalls

1. **Don't import from deprecated SDK paths.** ESLint's `@typescript-eslint/no-deprecated` rule will catch these by inspecting TypeScript type definitions, but check SDK deprecation warnings when coding.

2. **Don't add per-instance process listeners.** Use the static `TargetManager._instances` pattern to avoid `MaxListenersExceeded` warnings during testing.

3. **Don't use `passThroughOptions()` on subcommands.** Because of how Commander resolves variadic positional arguments with options, subcommands (like `call`, `read`) use a variadic `[target_command...]` argument. They require a `--` separator on the CLI if the target command itself contains flags or options (to prevent Commander from parsing them as options for `run-mcp`), but the separator is optional if the target command has no options. The default REPL command uses `passThroughOptions()`.

4. **Don't run tests in parallel.** Integration tests spawn child processes on stdio. Parallel execution causes conflicts.

5. **Test fixtures use `tsx` in integration tests but also have a `build:fixtures` script.** Unit and integration tests run `tests/fixtures/mock-server.ts` via `tsx` directly (no compilation step). The `npm run build:fixtures` script exists for the `pretest` hook to compile fixtures needed by specific test files (e.g., `vulnerable-stdio-server.ts`). Don't remove either approach.
