# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.8.0] - 2026-07-14

### Added

- **Result spill-to-disk + `read_result`**: oversized text responses are saved in full to the output directory (like images/audio); the truncated reply keeps the head plus a per-session result id and file path, and the new `read_result` agent tool pages through the full payload by id — truncation is now navigable instead of destructive
- **Interceptor plugin framework**: ordered middleware hooks (`onToolsList`, `onToolResult`, `onResourceResult`, `onPromptResult`) with bundled plugins — tool-poisoning scanner (default on, `--no-scan-tools` to disable), secret/DLP redaction (`--redact-secrets`, `--redact-emails`), and lossless output compression (`--compress-output`, `--compress-aggressive`)
- **Record & replay cassettes** ("VCR for MCP"): `--cassette <file>` / `--record` / `--replay` on headless subcommands; replay mode runs fully offline without spawning the target
- **`find_tools` agent tool and `find` REPL command**: BM25 relevance-ranked, compact tool discovery that avoids loading full catalogs into context
- **Streamable HTTP transport** for `http(s)` targets with automatic legacy-SSE fallback (`--transport auto|http|sse`)
- **Compressing proxy mode** (`run-mcp proxy`): fronts one backend with a schema-on-demand surface (`get_tool_schema` + `invoke_tool`, compression levels `-c low|medium|high|max`) or a whole fleet (`--config` / `--multi-server`) with a discovery surface (`list_servers`, cross-server `find_tools`, namespaced invocation) — including per-backend tool-list caching, pagination-complete catalogs, backend auto-reconnect with honest "backend down" errors, and sampling/elicitation forwarding
- **JSONL audit logging** (`--audit-log <file>`): append-only trail of every MCP request/response
- **Validator: static `outputSchema` audits** — flags tools whose declared output schema isn't compilable JSON Schema or requires properties it never defines
- `validate` headless subcommand with `--deep` protocol/schema compliance checks and `--json` output

### Changed

- Faster CLI startup: schema validators compile lazily instead of on every invocation
- `call_mcp_primitive` pre-call validation uses a cached tools list (invalidated by `tools/list_changed`), removing an extra round trip per tool call
- Cassette writes are debounced with an exit-time flush instead of rewriting the file per recording
- SIGINT/SIGTERM shutdown waits (bounded) for child-process tree-kills to land

### Fixed

- Interceptor timeout timers are cleared when calls settle (previously leaked one live timer per call)
- `TargetManager` instances are released from the cleanup registry on close; in-memory history caps oversized results
- Server-name prefixes can no longer contain the `__` namespace separator (proxy routing)
- Catalog summaries no longer truncate at abbreviations ("e.g."), version numbers, or URLs
- Custom environment variables are threaded into the child process instead of mutating the parent environment

### Security

- Sandbox profile paths are escaped before interpolation into Seatbelt profiles; unsafe Docker mount paths fail closed
- The network audit proxy now enforces the network policy (403 / refused CONNECT) instead of only logging
- Server-sourced text printed by the REPL is sanitized against terminal escape injection (OSC/ANSI)

## [1.7.5] - 2026-07-08

### Fixed

- Updated `README.md` to document platform support and limitations for sandbox deny rules.

## [1.7.4] - 2026-07-08

### Fixed

- **Security Patch**: Resolved file deny-read/write bypass (`RUNMCP-SANDBOX-DENY-BYPASS-001`) in Docker and Linux Bubblewrap sandboxes. Applied volume mount masking (`-v emptyFile:target:ro`) for Docker and overlay mounts (`--tmpfs` / `--ro-bind /dev/null`) for Bubblewrap.
- Added warnings to process stderr when deny rules are used in the Windows MXC sandbox backend (since exclusions are not supported by the underlying SDK).

## [1.7.3] - 2026-07-07

### Added

- **Deep Protocol Compliance Validator**: Validate third-party MCP servers against protocol conformance using `--validate` command.

## [1.7.2] - 2026-07-05

### Added

- **REPL Watch Mode**: Added `--watch` flag to restart target MCP server when source files change.
- Refactored CLI subcommands and extracted `snapshot.ts` utility.

## [1.7.1] - 2026-07-04

### Added

- `--scan` flag to dynamically scan workspace JSON configs for MCP server definitions

### Fixed

- README now fully matches CLI help output for all REPL commands and options

## [1.7.0] - 2026-07-04

### Added

- **Native sandboxing** for macOS (Seatbelt/`sandbox-exec`), Linux (`bwrap`), and Windows (`@microsoft/mxc-sdk`)
- **Docker sandboxing** mode (`--sandbox docker`) with automatic image selection
- **Network proxy auditing** (`--sandbox audit`) to monitor outbound connections
- **Credential harvesting protection**: automatic deny-list for `~/.ssh`, `~/.aws`, `~/.kube`, etc. when outbound network is allowed
- **Hierarchical settings** files: managed, user, project, and local scopes (`settings.json`)
- `--sandbox`, `--allow-read`, `--allow-write`, `--allow-net`, `--deny-read`, `--deny-write`, `--deny-net` CLI flags
- Git pre-commit hook via `simple-git-hooks` (format, lint, typecheck, test)

### Changed

- Modularized REPL into `src/repl/` directory (state, UI, commands, completer, history, wizard)
- Standardized exit codes across all CLI modes
- Implemented colors hierarchy with `picocolors` for consistent styling

## [1.6.3] - 2026-07-03

### Added

- Interactive menu loop for REPL (`explore` / `menu` command)

## [1.6.2] - 2026-07-03

### Fixed

- Removed remaining references to legacy `repl` subcommand in docs

## [1.6.1] - 2026-07-02

### Added

- **Persistent sessions** with background daemon (`--session <name>`) for stateful multi-call workflows
- **HTTPie-style shorthand arguments** (e.g., `key=value`, `flag:=true`)
- **Inline REPL tool calls**: type a tool name directly without `tools/call` prefix
- **Headless single-shot subcommands**: `call`, `list-tools`, `list-resources`, `list-prompts`, `read`, `describe`, `get-prompt`
- Script variable extraction via `$LAST` for chaining commands in script mode
- `@expect-error` directive for script-mode error handling
- Dynamic REPL autocomplete and help menu filtered by server capabilities
- Greyed-out unsupported commands in help menu (instead of hiding them)
- Build-time version injection via `tsup` define

### Changed

- Migrated from Biome to ESLint + Prettier with type-aware `@typescript-eslint/no-deprecated` rule
- Enhanced proxy interception and improved protocol compliance
- Stopped appending inline timing to text responses (corrupted JSON outputs for LLMs)

### Fixed

- Resolved proxy event blackhole, tree-killing orphans, and context window bloat
- Isolated `auto_connect` schema inside `call_mcp_primitive` to prevent Zod validation conflicts
- Fixed friendlier error messages when server lacks capability (`-32601`)
- Improved error handling and validation for missing tools and prompts

## [1.5.0] - 2026-07-01

### Added

- **Interactive config discovery**: run `run-mcp` with no arguments to pick from configured servers
- **SSE transport support**: connect to HTTP-based MCP servers via `http://` URLs
- **Explorer mode** (`explore` command) with interactive tool/resource/prompt browsing
- `list_available_mcp_servers` agent tool for discovering configured servers
- Custom command input option in server picker
- Copilot CLI config path scanning
- Interactive history, result separators, and command replay (`!!` / `last`)
- Escape key to cleanly abort interactive sub-flows

### Changed

- Consolidated 11 agent tools into 6 unified primitives
- Simplified CLI to a unified root command (removed separate `repl`/`mcp` subcommands)
- Renamed `--agent` flag to `--mcp`
- Overhauled REPL UX with rich banner, interactive tool calling, aliases, and tab cycling

### Fixed

- Terminal scrolling glitch from redundant cursor movement
- UI glitch during optional args selection
- Typography spacing and typo interaction issues

## [1.3.2] - 2026-06-28

### Changed

- Removed proxy mode in favor of direct MCP client approach
- Added `describe_mcp_tool` to server mode

### Fixed

- Massive timeout passed to SDK to prevent premature server cancellation
- Default interceptor timeout raised to 5 minutes

## [1.3.0] - 2026-06-27

### Added

- **Server mode** (`--mcp`): live MCP test harness for AI agents
- Full MCP protocol passthrough for proxy mode

## [1.1.0] - 2026-06-25

### Added

- AGENTS.md for AI agent and contributor onboarding
- Actionable error messages with typo suggestions (Levenshtein distance)
- Enhanced status command and auto-reconnect with loop protection

### Changed

- Migrated from deprecated `Server` to `McpServer` SDK import
- Switched to `tsup` for bundling and Biome for linting/formatting

## [1.0.0] - 2026-06-24

### Added

- Initial release: dual-mode MCP proxy & REPL with full test suite
- Response interception: image/audio extraction, base64 detection, truncation, timeouts
- Target process management with auto-reconnect
- Script mode for automated testing
