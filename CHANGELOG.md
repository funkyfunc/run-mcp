# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0] - 2026-09-04

Built on MCP TypeScript SDK **v2** and aware of protocol revision
**2026-07-28**. The point of the release: a server author on the new SDK can
now see which protocol era run-mcp is talking to their server, force the
modern one, and exercise the surfaces that only exist there. Also fixed on
the way: the most common stdio bug (logging to stdout) no longer goes
unreported.

### Breaking

- **SDK v2.** run-mcp now depends on `@modelcontextprotocol/client` and
  `@modelcontextprotocol/server` (2.x) instead of `@modelcontextprotocol/sdk`
  (1.x), and on zod 4. Nothing changes for servers built on SDK v1 — the
  default handshake is still the 2025 `initialize`, byte for byte.
- **An unknown tool name is a usage error (exit 64), not a tool error (exit 1),**
  in headless `call`, with the available tools and a "did you mean" suggestion.
  The SDK now rejects unknown tools at the protocol level instead of returning
  an `isError` result, so the old exit code would have meant "the server
  answered", which it did not.
- Node.js 20.11+ was already required; SDK v2 requires Node 20 as well.

### Added

- **`--protocol legacy|auto|<revision>`** on the REPL, every headless subcommand,
  `validate`, and sessions, plus a `protocol` parameter on `connect_to_mcp`,
  `reconnect_to_mcp`, `auto_connect`, and `validate_mcp_server`. `legacy`
  (default) is the 2025 handshake; `auto` probes with `server/discover` and
  falls back; a pin such as `2026-07-28` is modern-only and fails loudly
  otherwise — which is how you prove the modern path of a server that serves
  both eras. A session records its protocol and refuses an attach that asks
  for a different one. The SDK's guidance for spawn-per-invocation tools is
  followed: `auto` is never the default.
- **The negotiated era and revision are shown everywhere:** the REPL banner
  and `status`, headless `Connected` lines and the `--raw` envelope
  (`protocol`), `connect_to_mcp` / `reconnect_to_mcp` / `mcp_server_status`,
  and `validate` (`protocolEra`, `protocolVersion`, and a `protocol_era` check
  that tells a legacy-connected caller how to test the modern path).
- **Modern-era subscriptions.** On a 2026-07-28 connection nothing arrives
  unsolicited, so run-mcp opens a `subscriptions/listen` stream for every
  `listChanged` type the server advertises right after connect, and
  `subscribe_to_resource` / `resources/subscribe` open a per-URI stream instead
  of the removed `resources/subscribe` RPC. The server's `honoredFilter` is
  reported (status, validate's `list_changed_stream` check, the subscribe
  reply), so "the server took the stream but will never send updates for this
  URI" is visible instead of silent.
- **Client input is counted per call.** `input_required` rounds on 2026-07-28
  and server→client requests on 2025 both go through run-mcp's existing
  elicitation/sampling/roots handlers; each call now reports how many of each
  it needed: `input_requests` in `include_metadata` and in `call --raw`, and a
  line under the REPL result block. Headless mode answers deterministically
  (elicitation declined, sampling refused) instead of hanging.
- **stdout pollution is reported.** The SDK skips non-JSON stdout lines
  silently. run-mcp now watches the child's stdout and reports every such line:
  a yellow warning in the REPL, `stdout_noise` in `call --raw` plus a stderr
  warning in headless mode, a section in `mcp_server_status` /
  `get_mcp_server_stderr` / connect replies, and a **FAIL** in `validate`
  (`stdout_protocol_channel`). Transport-level errors the SDK only hands to an
  `onerror` callback (run-mcp never registered one) are captured the same way
  (`transport_errors`, a WARN in validate).
- `validate` on a modern connection also reports the `server/discover`
  advertisement and its cache hints (`discover_result`), and warns when a
  server stamps no identity.
- Coaching for the two new connect failures: a modern-only server refusing the
  2025 handshake says to retry with `--protocol auto`; a pin the server does
  not offer says so.

### Changed

- The mock fixture is served through `serveStdio` and answers both eras from
  one factory (`MOCK_LEGACY=reject` makes it modern-only); its client-input
  tools are written once in the `inputRequired` style and served to 2025
  clients by the SDK's shim. The stdio read buffer cap is raised from the
  SDK's 10 MB to 256 MB so an oversized tool result reaches the interceptor
  instead of closing the connection. List verbs bypass the SDK's response
  cache so the harness always shows the live server.
- The bundled JSON schema stays pinned to 2025-11-25 on purpose: the SDK hands
  back neutral result shapes on every era, and those are the 2025 definitions;
  modern-era specifics are checked through the SDK's accessors.
- run-mcp's own agent server still serves the 2025 era to its host. Every host
  speaks it today, and the host-facing forwarding paths (logging, notifications,
  sampling/elicitation relays) would each need a modern-era equivalent first.

## [2.2.0] - 2026-09-03

A fresh-eyes review of the whole repo, applied. One real gap closed (`--env`),
one file put back into shape (the session daemon), and the last feature with
no evidence of use removed.

### Added

- **`--env KEY=VALUE`** (repeatable, also `-e`) on the REPL, every headless
  subcommand, `validate`, and the session daemon. The target server never
  inherited the caller's environment — like every MCP client, `run-mcp` starts
  it with a `PATH`/`HOME`-style whitelist — and outside the agent server there
  was no way to add to it, so a server that reads an API key could not be
  started from a shell at all. The first `=` splits key from value. A session
  records the env it was started with: attach without repeating it, or pass the
  same values; a *different* `--env` is refused, naming the keys that differ
  (never the values). `sessions` lists `env_keys`.
- **`engines.node >= 20.11`** is declared. The session daemon already relied on
  `import.meta.dirname` (Node 20.11+) and `--watch` needs recursive `fs.watch`
  on Linux (20+), so Node 18 was only nominally supported; the bundle target now
  matches.

### Fixed

- **Servers added with `claude mcp add` were not discovered.** Claude Code's
  default ("local") scope stores them in `~/.claude.json` under
  `projects[<dir>].mcpServers`, and the scanner only read the file's top level,
  so `run-mcp` with no arguments (and `list_available_mcp_servers`) showed a
  developer's globally-added servers but not the one for the project they were
  working on. Every project's local-scope servers are now listed, labelled
  `Claude Code (Local: ~/path/to/project)`. `~/.claude/mcp.json` is read too,
  and a `url`-only entry (`type: "http"`) is offered as a remote target instead
  of being dropped. `list_available_mcp_servers` reports each entry's `env_keys`
  so an agent knows what to pass to `connect_to_mcp` (values are never shown).

### Changed

- **The session daemon lives in `src/session.ts`**, not inline in a commander
  action in the entrypoint. The session record, the pure mismatch check, the
  client side, and the daemon are separate functions, and the pure parts have
  unit tests.
- **The daemon listens on a Unix domain socket** inside the owner-only session
  directory (a named pipe on Windows) instead of a loopback TCP port. File
  permissions hid the port number but not the port: any local user could have
  found it by scanning and driven your server. Session names are now validated
  (letters, digits, `.`, `_`, `-`), since they become file names. A session
  daemon left running by 2.1.0 is not reachable this way; `close-session` it
  (or let it be pruned) and start it again.
- **The daemon is spawned on `process.execPath`**, not a bare `node` from
  `PATH`. Under nvm or volta those can be different Node versions.
- **Headless `list-tools`, `list-resources`, `list-prompts`, and `describe`
  follow pagination to exhaustion.** They fetched one page, so a paginating
  server yielded a silently partial catalog. `list_mcp_primitives` in the agent
  server does the same when called without a cursor; with a cursor it now
  requires exactly one `type`, because a cursor belongs to the list it came from
  (it used to be passed to all four lists).
- **The REPL's `resources/read` and `prompts/get` go through the interceptor**,
  like `tools/call` always did: timeouts apply, and a resource that returns a
  large blob is saved to disk rather than dumped. "Three interfaces, one
  pipeline" is now true of the REPL too.
- **`validate` reports structured fields** — `serverName`, `serverVersion`,
  `capabilities`, `toolCount` — in its JSON, instead of the quick summary
  regex-parsing the server name back out of a check message.
- **`--watch` follows the rebuild when the server runs from a build output.**
  With `node dist/index.js` and a separate compile step, a source save used to
  reconnect before the rebuild landed and spawn the stale code. If the target
  script lives under an ignored build directory, that directory is watched
  instead of the working directory.
- The README leads with `npx -y run-mcp` and the mcp.json snippet instead of
  clone-and-build.
- `TargetManager.waitForStderr()` replaces three copies of the same
  "give a dying server 250ms to explain itself" loop.

### Removed

- **Record & replay cassettes** (`--cassette`, `--record`, `--replay`). The one
  remaining feature with no evidence of use and no relationship to the scope
  test ("does this make the server under development more legible?"). It added
  three flags to every headless subcommand and a branch in every interceptor
  path. Recoverable from git history if a real need appears.
- Dead code and stale text left over from the August cuts: an unused raw-client
  accessor and completion method on `TargetManager`, comments referring to the
  deleted audit log and tool-poisoning scanner, a `find` command in the REPL
  help that no longer existed, and a REPL help line claiming a 60s default
  timeout (it is 5 minutes).

## [2.1.0] - 2026-08-29

Driven by feedback from an agent that used the headless CLI for its dev loop
and found it "reasonable for a smoke check, not a dev loop": every invocation
cold-started its server (a browser, in its case), and the output interleaved
with the server's stderr audit lines in its shell tool. `--session` already
solved the first problem, but it was invisible and incomplete — the session
daemon had no reconnect, no way to read stderr, ignored `--show-stderr` and the
other per-call options, and `validate` didn't accept it at all.

### Added

- **`reconnect --session <name>`** — restarts the server behind a session after
  a code edit and reports a diff of tools/resources/prompts, as JSON. The REPL,
  watch mode, and the agent server all had this; the headless loop did not, so
  an edit meant `close-session` plus a cold start. If the new code fails to
  start, the result carries the crash output inline (`{ reconnected: false,
  error, stderr: [...] }`) and the dead instance is kept so `stderr` still shows
  why; run `reconnect` again once it's fixed.
- **`stderr [count]`** — the target's captured stderr as a JSON array of lines.
  With `--session`: everything since the server started (or the last N). Without:
  what a fresh spawn writes at startup.
- **`validate [--deep] --session <name>`** — runs the compliance checks against
  the session's already-running server instead of spawning a second copy.
  Previously `--session` was swallowed as the server command (`spawn --session
  ENOENT`).
- **`call --raw` now carries a `stderr` field** — the lines the server wrote
  during the call — so stderr arrives as data in the JSON envelope rather than
  as a stream to grep out of a merged stdout/stderr.
- **Headless connect failures now print the server's stderr** under
  `--- Target server stderr ---`, matching the fix the agent server got in 2.0.0.
  This includes the first call of a session: the daemon's stdio is detached, so
  a server that died there used to surface only as "Failed to spawn background
  daemon" after a five-second wait. It now writes a failure record the client
  reads back, and the call exits 69 with the crash output.
- **`sessions`** — lists running sessions as JSON: name, pid, command, working
  directory, uptime, idle timeout. Until now the only way to know what was
  running was `ls $TMPDIR/run-mcp/sessions`.
- **`--idle-timeout <minutes>`** — with `--session`, the daemon closes itself
  after that long without a command. Off by default (a session vanishing
  mid-task is its own surprise), but a forgotten session otherwise keeps its
  server — and, say, its browser — alive until reboot. A later call can change
  the value; `sessions` shows the one in force.
- **Sessions refuse a mismatched command.** The session file used to hold only
  a port and a pid, so `--session dev -- node other.js` — or the same relative
  `node server.js` from a different project — silently reused whichever server
  was already running under that name. The file now records the command and
  working directory; passing a different one is an error that shows both and
  says how to proceed (omit the command, `close-session`, or another name).

### Fixed

- **`--show-stderr` was silently ignored on sessioned calls.** The daemon holds
  the pipe, so it now returns the lines written during the call and the CLI
  replays them on stderr.
- **`--out-dir`, `--timeout`, and `--media-threshold` were ignored on sessioned
  calls** (the daemon built one default interceptor at startup). They now apply
  per call. `--transport` is passed through when the session is created.
  `--media-threshold` was also parsed but never applied in one-shot mode.
- A call against a session whose server has exited now says so and points at
  `stderr`/`reconnect`, instead of `Error communicating with session daemon`.
- **`validate` respected neither `NO_COLOR` nor a piped stdout**: its
  human-readable output was hard-coded ANSI, so an agent reading it through a
  shell tool saw `[32mValidation Result: SUCCESS[0m`. It now goes through the
  same colour logic as the REPL (`--color`, `NO_COLOR`, `CLICOLOR`, isatty).

### Changed

- `--help` and the README now present sessions as the headless dev loop, with
  examples, rather than a footnote under CI usage.

## [2.0.0] - 2026-08-09

**Breaking.** This release removes a subcommand, eleven CLI flags, and two agent
tools. `run-mcp` is now scoped to one thing: a lightweight wrapper around an MCP
client that lets humans and agents run and use MCP servers — above all a server
being developed locally. See the migration note at the end of this entry.

### Fixed

- **A failed connect now carries the target server's stderr.** Previously `connect_to_mcp` reported only the transport's opaque `MCP error -32000: Connection closed`, told the caller to check `get_mcp_server_stderr`, and then discarded the target that held the output — so the follow-up call answered "No target server (current or previous). Nothing to show." A server that won't start is the most common event in the core loop, and its stderr is the only evidence of why; that evidence is now inlined in the failure message (zero extra round trips), retained for `get_mcp_server_stderr` after teardown, and given a brief settle window so it isn't lost to the close/stderr race. Applies to `connect_to_mcp`, `reconnect_to_mcp`, and `call_mcp_primitive`'s auto-connect.

- **`disconnect_after` no longer discards the target's stderr.** `call_mcp_primitive`'s teardown path closed the target directly instead of going through `retireTarget()`, so a tool call that misbehaved — exactly the call you'd set `disconnect_after` on — left nothing for `get_mcp_server_stderr` to show. Found by driving the official filesystem server rather than a fixture.

- **The agent can now answer `roots/list`.** `run-mcp` advertises the `roots` capability to every target server, but only the REPL could ever populate the list — so a server that asked an agent-driven session for roots always got `[]`. That is a wrong answer rather than a missing feature, and one a server author would reasonably misread as a bug in their own code. `connect_to_mcp` and `reconnect_to_mcp` now take a `roots` parameter, applied before the handshake and persisted across reconnects.

### Added

- **Client-role parity for the agent server.** The MCP client at the core of `run-mcp` has always supported roots, resource subscriptions, notification history, and log-level control; the REPL used all of it and the agent server exposed none of it, so an agent could not exercise those code paths in the server it was building. Now: `roots` and `log_level` parameters on `connect_to_mcp`/`reconnect_to_mcp`, plus two tools — **`get_server_notifications`** (inspect `tools/list_changed`, `resources/updated`, and log messages, which travel outside the request/response flow and are otherwise invisible) and **`subscribe_to_resource`**.

- **`reconnect_to_mcp`** — restarts the current target in one call, reusing the command it was started with, and diffs tools/resources/prompts against the previous run. This is the edit-test loop: it replaces `disconnect_from_mcp` + `connect_to_mcp` and always reports what your change did. The REPL and watch mode already had this; the agent did not.

### Removed

Scope cut: `run-mcp` protects the consuming agent's *context*, not the host. Guarding
against hostile MCP servers is a different product with a different user — the person
this tool serves is developing the server they are pointing it at. Everything below is
recoverable from git history if that ever changes.

- **Sandbox engine** — `--sandbox` (`auto`/`native`/`docker`/`audit`) and all
  `--allow-read|write|net` / `--deny-read|write|net` flags, the Seatbelt/bwrap/Docker/MXC
  enforcement matrix, the hierarchical sandbox settings loader (`.run-mcp.json` and the
  managed/user/project/local scopes), the automatic credential-directory deny list, and the
  outbound network audit proxy. The optional `@microsoft/mxc-sdk` dependency is no longer used.
- **Tool-poisoning scanner** — invisible/bidi Unicode stripping and prompt-injection phrase
  flagging over `tools/list`, plus `--no-scan-tools` and the "Tool Safety Findings" output blocks.
- **Secret/DLP redaction** — `--redact-secrets` and `--redact-emails`.
- **JSONL audit logging** — `--audit-log <file>`.
- **`search_all_local_mcp_servers` agent tool** — it spawned every MCP server configured on
  the machine to run a substring match. `list_available_mcp_servers` still lists them from
  config files without starting anything, and the CLI's interactive picker and `--scan` are
  unchanged.

Second cut — the compressing proxy and relevance search:

- **`run-mcp proxy`** — both the single-backend `get_tool_schema`/`invoke_tool` surface and
  the multi-backend multiplexer (`--config`/`--multi-server`, `list_servers`,
  `list_server_tools`, namespaced routing), with `src/proxy.ts`, `src/compression.ts`,
  `src/target-pool.ts`, `src/tool-cache.ts` and their four test suites.
- **`find_tools`** (agent server) and **`find`** (REPL), plus `src/ranking.ts` (BM25).

Rationale: every surface that earns its place makes the server under development *more*
legible to the agent — schemas, stderr, diffs, spec compliance. The proxy's job is the
opposite: show the model as little as possible. Its user is an agent *operator* fronting a
fleet, not someone building a server, and the work it would need to be good at that (OAuth,
remote transports, config management, stats) points away from this project. `find_tools`
was the same instinct one layer in: BM25 search over the catalog of a server the agent
wrote itself, where `list_mcp_primitives(summary: true)` already covers it.

Third cut — the interceptor plugin framework:

- **`src/plugins.ts`** and the plugin plumbing in `src/interceptor.ts`
  (`processToolList`, `_runResultHooks`, `metadata.findings`), plus
  **`--compress-output`** / **`--compress-aggressive`**.

The framework was justified by four consumers — tool-poisoning scanning, DLP redaction,
audit logging, and lazy schema loading — all since removed. It had become an extension
point with exactly one extension. Output minification is also a different kind of thing
from what the interceptor otherwise does: media extraction and truncation exist to stop a
response from *harming* the caller, while minifying JSON is a marginal token optimization.
That distinction is now the rule for what the interceptor is allowed to touch.

Final surface: the agent server exposes 12 tools (`find_tools` out; `reconnect_to_mcp`,
`get_server_notifications`, `subscribe_to_resource` in) and the root command 14 options
(was 25). Bundle: 424KB → 357KB. Suite: 390 tests/26 files → 285/15, ~100s → ~59s.

### Migration

| If you used | Do this instead |
| --- | --- |
| `run-mcp proxy …` | No replacement. Configure the backend server directly in your MCP client. The implementation is in git history at `d1bd392` if you need to vendor it. |
| `--sandbox` / `--allow-*` / `--deny-*` | No replacement. Run untrusted servers under your own isolation (container, VM); `run-mcp` no longer claims to provide any. |
| `--redact-secrets`, `--redact-emails`, `--audit-log`, `--no-scan-tools` | No replacement — all removed with the security layer (`ddf7ab3`). |
| `--compress-output`, `--compress-aggressive` | No replacement (`255f6ff`). |
| `find_tools` (agent tool) | `list_mcp_primitives({ type: ["tools"], summary: true })`. |
| `find <query>` (REPL) | `tools/list`. |
| `search_all_local_mcp_servers` (agent tool) | `list_available_mcp_servers` — it reads config files without spawning every server on the machine. |
| `disconnect_from_mcp` + `connect_to_mcp` after an edit | `reconnect_to_mcp` — one call, and it reports what changed. |

Nothing in the core loop was removed: connect, call, list, stderr, validate,
watch mode, the REPL, headless subcommands, sessions, and cassettes are all
unchanged.

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
