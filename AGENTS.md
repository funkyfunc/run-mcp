# AGENTS.md

Welcome! If you are an AI agent (or a human new to the codebase) looking to contribute to `run-mcp`, this guide provides the architectural context, conventions, and workflows you need to be effective.

## 🧭 Design Philosophy

These principles define the soul of the project. Every feature, error message, and code change should reinforce them. If a change conflicts with any of these, rethink the approach.

### 1. Two Audiences, One Pipeline

`run-mcp` serves **two distinct users** through the same interception pipeline:

- **Humans** (REPL mode) — developers who want to quickly test and explore an MCP server without writing client code.
- **AI agents** (MCP mode) — LLMs building MCP servers that need to dynamically test them without config changes.

Both modes share the same `TargetManager` → `ResponseInterceptor` pipeline. The differences are in the input interface (readline vs. MCP tools).

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

A user should be able to wrap any MCP server with `run-mcp proxy node my-server.js` and have it work immediately. No config files, no environment variables required, no initialization step. Sensible defaults (60s timeout, 50KB truncation, `/tmp/run-mcp` for images) cover 90% of use cases. Flags exist for the other 10%.

### 5. Composable CLI

Follow the Unix philosophy: `run-mcp` reads from stdin, writes to stdout, logs to stderr, and returns meaningful exit codes. This means:

- **Script mode**: `run-mcp node foo.js --script commands.txt` exits `0` on success, `1` on first error. Composable with CI pipelines.
- **Process cleanup**: Always kill child processes on exit (SIGINT, SIGTERM, process.exit). Never leave orphaned server processes.

### 6. Typo Tolerance

Users (especially agents) mistype things. The REPL uses Levenshtein distance matching to suggest corrections for unknown commands (`tols/list` → `Did you mean tools/list?`). When adding new user-facing inputs, consider whether a fuzzy match would reduce friction.

---

## 🏗️ Architecture

The system has a simple layered architecture where every tool call flows through the same pipeline:

```
┌─────────────────────┐         ┌─────────────────────┐
│                     │  stdio  │                     │
│   AI Agent / REPL   │◄───────►│     run-mcp         │
│                     │         │                     │
└─────────────────────┘         │  ┌───────────────┐  │
                                │  │  Interceptor   │  │
                                │  │  • Timeouts    │  │
                                │  │  • Image Save  │  │
                                │  │  • Audio Save  │  │
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

### Source Modules

| Module | File | Responsibility |
|--------|------|----------------|
| **CLI Entry** | `src/index.ts` | Commander-based CLI with a unified root command. Parses options and delegates to `server.ts` (0 positional args) or `repl.ts` (1+ positional args). |
| **TargetManager** | `src/target-manager.ts` | Spawns the target MCP server as a child process, wraps it in an MCP `Client`, exposes the full MCP protocol surface (tools, resources, prompts, logging, completion), captures stderr, tracks process lifecycle. Handles auto-reconnect with loop protection (5s min-uptime guard, 3-retry cap, 60s stability reset). |
| **ResponseInterceptor** | `src/interceptor.ts` | Middleware layer that wraps `callTool` with `Promise.race` timeouts, extracts base64 images and audio to disk, detects raw base64 text blobs via regex heuristic, and truncates oversized text responses. Configurable via `InterceptorOptions` (timeout, max text length, output directory). |
| **REPL** | `src/repl.ts` | Interactive readline interface. Parses shorthand commands (`tools/list`, `tools/call <name> <json>`), supports script mode (`--script`), streams server stderr in dim text, supports interactive wizard scaffolding + arg memory, and suggests corrections for typos. |
| **Server** | `src/server.ts` | MCP Server exposing 7 consolidated tools (`connect_to_mcp`, `call_mcp_primitive`, `list_available_mcp_servers`, etc.) so agents can dynamically connect to, inspect, and test local MCP servers without config changes. `call_mcp_primitive` auto-connects if needed and supports tools, resources, and prompts in a single tool. Uses `registerTool()` with Zod schemas. |
| **Parsing** | `src/parsing.ts` | Pure functions extracted for testability: command line splitting, `tools/call` argument parsing, JSON formatting, Levenshtein distance, and typo suggestion. |
| **Config Scanner** | `src/config-scanner.ts` | Hunts for configured MCP server JSONs across global and project paths (VS Code, Copilot, Cursor, Gemini, Claude Desktop, etc.). Powers the `list_available_mcp_servers` agent tool and the headless `<run-mcp>` auto-discovery menu. |


### Auto-Reconnect Logic (TargetManager)

The REPL enables auto-reconnect for robustness during interactive sessions. The rules are designed to prevent retry loops on buggy servers:

1. **Min-uptime guard (5s)**: If the server crashes within 5 seconds of starting, it's treated as a startup bug — no retry. This prevents infinite loops when the server has a fatal error in its initialization.
2. **Retry cap (3)**: Maximum 3 consecutive reconnect attempts before giving up.
3. **Stability reset (60s)**: After 60 seconds of stable connection, the retry counter resets. A server that crashes once after 10 minutes of stability gets a fresh set of retries.
4. **MCP mode** exits on disconnect so the parent agent can decide what to do.

### Agent Usability Gotchas: `call_mcp_primitive`

A major pattern in `run-mcp` is multiplexing tasks (triggering a tool AND auto-connecting). Because the word "arguments" is heavily overloaded, `call_mcp_primitive` uses strict compartmentalization:
- **`arguments`**: A JSON object mapping to the *target MCP tool's input properties*.
- **`auto_connect.args`**: A string array used specifically for the OS spawn process (e.g. `["src/index.js", "--verbose"]`).

If an AI Agent is trying to provide parameters to a mock tool and accidentally lumps them under `args: {"foo": "bar"}`, Zod will intercept this and properly complain about a string-array requirement mismatch. The correct top-level key for tool payloads is **always** `arguments`. 

---

## 🧠 Codebase Conventions

### TypeScript & ESM

- **Pure ESM** — `"type": "module"` in package.json. All imports use `.js` extensions (TypeScript resolves them to `.ts` at compile time).
- **tsup for bundling** — Produces a single `dist/index.js` (≈25KB). No source maps in dist.
- **tsc for type-checking only** — `tsconfig.json` has `noEmit: true`. Run `npm run typecheck`.
- **Strict mode** — `strict: true` in tsconfig. No implicit any.

### Linting & Formatting (Biome)

- **Biome** handles both linting and formatting (no ESLint/Prettier).
- **`noDeprecatedImports: "error"`** — proactively catches deprecated SDK usage.
- **`noExplicitAny: "off"`** — relaxed because the MCP SDK returns loosely-typed results.
- **Style**: 2-space indent, double quotes, trailing commas, 100-char line width.
- Run `npm run lint` to check, `npm run lint:fix` to auto-fix.
- **Always run `npx biome check --write` before committing.**

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

When adding new logic, ask: *"Can I test this without a network connection or child process?"* If yes, extract it.

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

1. **Add the command name** to `KNOWN_COMMANDS` in `src/repl.ts` (so typo suggestion works).
2. **Add a `case` branch** in `handleCommand()` routing to a new `cmdFoo()` function.
3. **Implement `cmdFoo()`** following the existing pattern (validate input, call target, format output).
4. **Update `printHelp()`** with the new command.
5. **Add the command** to the `--help` examples in `src/index.ts`.

### Adding a New Interceptor Behavior

1. **Add a new `_processItem()` branch** in `src/interceptor.ts` (or a new method if complex).
2. **Add tests** in `tests/interceptor.test.ts` — this file has 18 tests covering all interception paths.
3. **Make it configurable** via `InterceptorOptions` if the behavior should be tunable.

### Adding a New CLI Flag

1. **Add the option** to the relevant commander subcommand in `src/index.ts`.
2. **Thread the value** through to the module that needs it (repl.ts, proxy.ts, or interceptor.ts).
3. Be mindful of argument parsing: the default REPL mode uses `passThroughOptions()`, but headless subcommands use the POSIX `--` separator to cleanly split CLI flags from the target command.

---

## 🧪 Testing

### Test Structure

| File | Tests | What it covers |
|------|-------|----------------|
| `tests/parsing.test.ts` | 30 | Pure parsing functions, JSON formatting, Levenshtein distance, typo suggestions |
| `tests/interceptor.test.ts` | 18 | Image extraction, audio extraction, base64 detection, truncation, timeout behavior (mocked, no child processes) |
| `tests/target-manager.test.ts` | 19 | Full integration: spawns the mock server, tests connect/disconnect/listTools/callTool/auto-reconnect |
| `tests/e2e.test.ts` | 6 | End-to-end: TargetManager + ResponseInterceptor against the mock server |
| `tests/server.test.ts` | 29 | MCP mode: consolidated tool surface (call_mcp_primitive, list_mcp_primitives), auto-connect, disconnect_after, include flags, reconnect diff, diagnostics |
| **Total** | **102** | |

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
npm run start -- node --import tsx tests/fixtures/mock-server.ts
```
Once it's running in your background terminal, use your text/action input tools to simulate a user typing (`explore`, `tools/call echo {"text": "hello"}`, `exit`) and read the stream output to verify the UX formatting exactly as a human would see it!

**How to dynamically test the Agent Server (MCP Mode):**
Since `run-mcp` is *itself* an MCP server when run in Agent Mode, you can test it recursively by using the human REPL to connect to its own server mode! If you are modifying tools inside `src/server.ts`:
```bash
# Build your changes first
npm run build

# Start the REPL connected to the built run-mcp Agent Server
npm run start -- node dist/index.js --mcp
```
Once connected, you can use `tools/list` or `explore` to invoke `call_mcp_primitive`, `list_available_mcp_servers`, or any other tool you just added directly from the terminal!

### Important: Sequential Execution

Tests run **sequentially** (`fileParallelism: false` in vitest.config.ts) because integration tests spawn child processes on stdio. Parallel execution causes port/stdin conflicts. Don't change this.

### Mock Server

`tests/fixtures/mock-server.ts` is a real MCP server that exposes predictable primitives for testing:

**Tools:**

| Tool | Behavior |
|------|----------|
| `echo` | Returns the input text unchanged |
| `greet` | Returns `"Hello, {name}!"` (has tool annotations: readOnlyHint, idempotentHint) |
| `slow` | Waits N ms before responding (timeout testing) |
| `screenshot` | Returns a fake base64 PNG (image interception testing) |
| `big_base64` | Returns a large base64 text blob (heuristic detection testing) |
| `big_response` | Returns N characters of text (truncation testing) |
| `multi_content` | Returns multiple content items |
| `audio_tool` | Returns a fake base64 WAV clip (audio interception testing) |
| `error_tool` | Returns `isError: true` (error passthrough testing) |

**Resources:**

| Resource | Description |
|----------|-------------|
| `docs://readme` | Markdown text resource |
| `docs://config` | JSON text resource |
| `docs://pages/{page}` | Resource template with path parameter |

**Prompts:**

| Prompt | Description |
|--------|-------------|
| `greeting` | Takes a `name` argument, returns a user message |

The mock server uses the **non-deprecated** `McpServer.registerTool()` API. Tests run it via `tsx` (no compilation step) — see `tests/helpers.ts` for the shared spawn configuration.

### Adding Tests

- **Pure logic** → add to `tests/parsing.test.ts` (fast, no I/O)
- **Interception** → add to `tests/interceptor.test.ts` (mocked, no child processes)
- **Integration** → add to `tests/target-manager.test.ts` or `tests/e2e.test.ts` (spawns mock server)
- **MCP mode protocol coverage** → add to `tests/server.test.ts` (spawns full MCP mode pipeline)
- **If you add a new tool/resource/prompt to the mock server**, add test coverage in the appropriate test file

---

## 📦 Build & Release

### Scripts

```bash
npm run build        # tsup → dist/index.js (single bundled ESM file)
npm run dev          # tsup --watch (rebuild on save)
npm run typecheck    # tsc --noEmit (type-check without emitting)
npm run lint         # biome check (lint + format check)
npm run lint:fix     # biome check --write (auto-fix)
npm run format       # biome format --write
npm test             # pretest (build) + vitest run
```

### Before Committing

1. `npm run lint:fix` — fix formatting and lint issues
2. `npm test` — ensure all 102 tests pass
3. `npm run typecheck` — catch type errors not covered by tsup

### npx Compatibility

The package is designed to work with `npx run-mcp`:

- `"bin": { "run-mcp": "dist/index.js" }` — the shebang (`#!/usr/bin/env node`) is preserved by tsup.
- `"files": ["dist"]` — only `dist/index.js` is published (no source, no tests, no source maps).
- `"prepublishOnly": "tsup"` — auto-builds before `npm publish`.
- Package size: ~11KB compressed.

### MCP SDK Usage

- **Client** (`@modelcontextprotocol/sdk/client/index.js`) — used by `TargetManager` to connect to the target server. Not deprecated.
- **McpServer** (`@modelcontextprotocol/sdk/server/mcp.js`) — used by MCP mode. Non-deprecated. Use `registerTool()` for standard tool registration.
- **`server.tool()`** — **DEPRECATED**. Use `server.registerTool()` instead.
- **`Server`** (`@modelcontextprotocol/sdk/server/index.js`) — **DEPRECATED**. Use `McpServer` instead. The proxy accesses `mcpServer.server` for low-level request handlers, but imports `McpServer`.

---

## 🚫 Common Pitfalls

1. **Don't import from deprecated SDK paths.** Biome's `noDeprecatedImports` rule will catch some, but not all. Check the SDK's `@deprecated` JSDoc annotations when using new APIs.

3. **Don't add per-instance process listeners.** Use the static `TargetManager._instances` pattern to avoid `MaxListenersExceeded` warnings during testing.

3. **Don't use `passThroughOptions()` on subcommands.** Because of how Commander resolves variadic positional arguments with options, subcommands (like `call`, `read`) use a variadic `[target_command...]` argument and require a `--` separator on the CLI. The default REPL command uses `passThroughOptions()`.

5. **Don't run tests in parallel.** Integration tests spawn child processes on stdio. Parallel execution causes conflicts.

6. **Don't compile test fixtures separately.** Tests use `tsx` to run `tests/fixtures/mock-server.ts` directly. There is no `tests/tsconfig.json`.
