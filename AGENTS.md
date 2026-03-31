# AGENTS.md

Welcome! If you are an AI agent (or a human new to the codebase) looking to contribute to `run-mcp`, this guide provides the architectural context, conventions, and workflows you need to be effective.

## 🧭 Design Philosophy

These principles define the soul of the project. Every feature, error message, and code change should reinforce them. If a change conflicts with any of these, rethink the approach.

### 1. Two Audiences, One Pipeline

`run-mcp` serves **two distinct users** through the same interception pipeline:

- **Humans** (REPL mode) — developers who want to quickly test and explore an MCP server without writing client code.
- **AI agents** (Proxy mode) — LLMs that need a protective layer between them and a target server.

Both modes share the same `TargetManager` → `ResponseInterceptor` pipeline. The only difference is the input interface (readline vs. MCP Server). When designing a feature, ask: *"Does this benefit the REPL user, the agent, or both?"* and scope it accordingly.

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

- **Proxy mode**: stdout is the MCP JSON-RPC channel. ALL diagnostic output goes to stderr.
- **REPL mode**: stdout is for tool results. Server logs are dimmed on stderr.
- **Script mode**: `run-mcp repl ... --script commands.txt` exits `0` on success, `1` on first error. Composable with CI pipelines.
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
| **CLI Entry** | `src/index.ts` | Commander-based CLI with `repl` and `proxy` subcommands. Bare invocation shows help with examples. Uses `passThroughOptions()` so target server flags aren't consumed. |
| **TargetManager** | `src/target-manager.ts` | Spawns the target MCP server as a child process, wraps it in an MCP `Client`, captures stderr, tracks process lifecycle. Handles auto-reconnect with loop protection (5s min-uptime guard, 3-retry cap, 60s stability reset). |
| **ResponseInterceptor** | `src/interceptor.ts` | Middleware layer that wraps `callTool` with `Promise.race` timeouts, extracts base64 images to disk, detects raw base64 text blobs via regex heuristic, and truncates oversized text responses. |
| **REPL** | `src/repl.ts` | Interactive readline interface. Parses shorthand commands (`tools/list`, `tools/call <name> <json>`), supports script mode (`--script`), streams server stderr in dim text, and suggests corrections for typos. |
| **Proxy** | `src/proxy.ts` | MCP Server that bridges the parent agent to the target server. Uses `McpServer` from the SDK but registers handlers on the underlying `.server` property for transparent passthrough (see [Proxy Architecture](#proxy-architecture) below). |
| **Parsing** | `src/parsing.ts` | Pure functions extracted for testability: command line splitting, `tools/call` argument parsing, JSON formatting, Levenshtein distance, and typo suggestion. |

### Proxy Architecture

The proxy uses `McpServer` (non-deprecated) but bypasses its `registerTool()` method for tool forwarding. This is intentional:

```typescript
const mcpServer = new McpServer({ name: "run-mcp-proxy", version: "1.0.0" }, { capabilities: { tools: {} } });
const server = mcpServer.server; // Access the low-level Server

server.setRequestHandler(ListToolsRequestSchema, async () => { /* forward */ });
server.setRequestHandler(CallToolRequestSchema, async (req) => { /* forward via interceptor */ });
```

**Why not `registerTool()`?** Because `McpServer.registerTool()` validates incoming arguments against a Zod schema before calling your handler. A transparent proxy doesn't know the schemas at compile time — they come from the target server at runtime as JSON Schema objects. Using `setRequestHandler` on the underlying server lets us forward arguments as-is without re-validation.

### Auto-Reconnect Logic (TargetManager)

The REPL enables auto-reconnect for robustness during interactive sessions. The rules are designed to prevent retry loops on buggy servers:

1. **Min-uptime guard (5s)**: If the server crashes within 5 seconds of starting, it's treated as a startup bug — no retry. This prevents infinite loops when the server has a fatal error in its initialization.
2. **Retry cap (3)**: Maximum 3 consecutive reconnect attempts before giving up.
3. **Stability reset (60s)**: After 60 seconds of stable connection, the retry counter resets. A server that crashes once after 10 minutes of stability gets a fresh set of retries.
4. **Proxy mode does not auto-reconnect** — it exits on disconnect so the parent agent can decide what to do.

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
3. **Use `passThroughOptions()`** — already configured, so your flag won't conflict with target server flags.

---

## 🧪 Testing

### Test Structure

| File | Tests | What it covers |
|------|-------|----------------|
| `tests/parsing.test.ts` | 30 | Pure parsing functions, JSON formatting, Levenshtein distance, typo suggestions |
| `tests/interceptor.test.ts` | 18 | Image extraction, base64 detection, truncation, timeout behavior (mocked, no child processes) |
| `tests/target-manager.test.ts` | 19 | Full integration: spawns the mock server, tests connect/disconnect/listTools/callTool/auto-reconnect |
| `tests/e2e.test.ts` | 6 | End-to-end: TargetManager + ResponseInterceptor against the mock server |
| `tests/proxy.test.ts` | 5 | Proxy mode: spawns `run-mcp proxy` pointing at the mock server, connects an MCP Client to it |
| **Total** | **78** | |

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

### Important: Sequential Execution

Tests run **sequentially** (`fileParallelism: false` in vitest.config.ts) because integration tests spawn child processes on stdio. Parallel execution causes port/stdin conflicts. Don't change this.

### Mock Server

`tests/fixtures/mock-server.ts` is a real MCP server that exposes predictable tools for testing:

| Tool | Behavior |
|------|----------|
| `echo` | Returns the input text unchanged |
| `greet` | Returns `"Hello, {name}!"` |
| `slow` | Waits N ms before responding (timeout testing) |
| `screenshot` | Returns a fake base64 PNG (image interception testing) |
| `big_base64` | Returns a large base64 text blob (heuristic detection testing) |
| `big_response` | Returns N characters of text (truncation testing) |
| `multi_content` | Returns multiple content items |

The mock server uses the **non-deprecated** `McpServer.registerTool()` API. Tests run it via `tsx` (no compilation step) — see `tests/helpers.ts` for the shared spawn configuration.

### Adding Tests

- **Pure logic** → add to `tests/parsing.test.ts` (fast, no I/O)
- **Interception** → add to `tests/interceptor.test.ts` (mocked, no child processes)
- **Integration** → add to `tests/target-manager.test.ts` or `tests/e2e.test.ts` (spawns mock server)
- **If you add a new tool to the mock server**, add test coverage in at least `target-manager.test.ts`

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
2. `npm test` — ensure all 78 tests pass
3. `npm run typecheck` — catch type errors not covered by tsup

### npx Compatibility

The package is designed to work with `npx run-mcp`:

- `"bin": { "run-mcp": "dist/index.js" }` — the shebang (`#!/usr/bin/env node`) is preserved by tsup.
- `"files": ["dist"]` — only `dist/index.js` is published (no source, no tests, no source maps).
- `"prepublishOnly": "tsup"` — auto-builds before `npm publish`.
- Package size: ~11KB compressed.

### MCP SDK Usage

- **Client** (`@modelcontextprotocol/sdk/client/index.js`) — used by `TargetManager` to connect to the target server. Not deprecated.
- **McpServer** (`@modelcontextprotocol/sdk/server/mcp.js`) — used by proxy mode. Non-deprecated. Use `registerTool()` for standard tool registration.
- **`server.tool()`** — **DEPRECATED**. Use `server.registerTool()` instead.
- **`Server`** (`@modelcontextprotocol/sdk/server/index.js`) — **DEPRECATED**. Use `McpServer` instead. The proxy accesses `mcpServer.server` for low-level request handlers, but imports `McpServer`.

---

## 🚫 Common Pitfalls

1. **Don't import from deprecated SDK paths.** Biome's `noDeprecatedImports` rule will catch some, but not all. Check the SDK's `@deprecated` JSDoc annotations when using new APIs.

2. **Don't use `registerTool()` in the proxy.** It re-validates tool schemas against Zod, which breaks transparent forwarding. Use `mcpServer.server.setRequestHandler()` for passthrough.

3. **Don't add per-instance process listeners.** Use the static `TargetManager._instances` pattern to avoid `MaxListenersExceeded` warnings during testing.

4. **Don't forget `passThroughOptions()` on commander subcommands.** Without it, flags in the target command (e.g., `node --import tsx server.ts`) are consumed by commander and never reach the target.

5. **Don't run tests in parallel.** Integration tests spawn child processes on stdio. Parallel execution causes conflicts.

6. **Don't compile test fixtures separately.** Tests use `tsx` to run `tests/fixtures/mock-server.ts` directly. There is no `tests/tsconfig.json`.
