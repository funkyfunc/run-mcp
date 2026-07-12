# run-mcp — Roadmap & Session Handoff

> **Read this first if you're a fresh session.** This file is a self-contained
> handoff written to survive a total loss of conversational context. It records
> what run-mcp is, the strategic decisions already made, what has been built,
> how the code fits together, the non-obvious gotchas, and every remaining
> roadmap item with enough detail to execute. When in doubt, also read
> `analysis-report.md` (the independent deep-dive) and `recommendations.md` (the
> gap-mapping + tiered roadmap). The ecosystem research lives in
> `docs/research/` (the "MCP Critiques, Solutions, and Gaps" file is large —
> grep its headings rather than reading whole).

---

## 1. What run-mcp is (orientation)

`run-mcp` is a smart proxy / interactive REPL / live test harness for Model
Context Protocol (MCP) servers. **Three interfaces, one pipeline** — all three
feed a shared `TargetManager` → `ResponseInterceptor` core:

1. **Interactive REPL** — `run-mcp -- node server.js` (human dev testing, readline).
2. **Headless CLI** — `run-mcp call|list-tools|read|...` (clean JSON to stdout for CI/jq).
3. **Agent MCP Server** — `run-mcp` (no args) or `run-mcp --mcp`. run-mcp is
   *itself* an MCP server exposing meta-tools (`connect_to_mcp`,
   `call_mcp_primitive`, `find_tools`, …) so an AI agent can dynamically spawn
   and test local MCP servers without editing config files.

The differentiator (established during analysis): run-mcp's real asset is the
**interceptor pipeline + its man-in-the-middle position in the stdio pipe**, not
"another test tool." The ecosystem research names exactly this gap (the
"interceptor framework gap" / SEP-1763) and the "lightweight local sandbox" gap
as unfilled. The strategy is to make the interceptor the product, reached
deliberately.

### Strategic decisions already locked (do not re-litigate without the user)
From an interview with the creator (see `recommendations.md` §4):
1. **Identity → Both, staged.** Keep the test/dev tool sharp *and* evolve toward
   a runtime interceptor that sits in the live agent↔server path. Reach it in stages.
2. **Context bloat → run-mcp facade mode** (not a spin-off). The "Tools Tax"
   lazy-loading work belongs *in* run-mcp. (Tier 3 facade — already started, see §3.)
3. **Security → Fix then extend.** Land sandbox bug fixes first (done in Tier 1),
   then build interceptor-layer security (scanner/DLP/audit — done in Tier 2).
4. **Library form factor → Later, gated on the interceptor.** Do NOT ship an
   importable library as a standalone goal. Build the middleware plugin framework
   first (done); the library falls out as a thin `wrapClient(client, [plugins])`
   wrapper *only once there's a real external consumer*. Verified fact: the
   official `@modelcontextprotocol/sdk` (workspace copy under
   `.invisible/typescript-sdk`, v2.0.0-alpha at time of writing) has **no**
   interceptor/middleware/transform hook — the gap is real.

---

## 2. Current state (as of this handoff)

- **Branch:** `tier1-security-hardening` (despite the name, it now also contains
  all of Tier 2 + the Tier 3 facade). **Nothing has been pushed or PR'd.**
- **Commits on the branch (newest first):**
  - `3bb61a4` Tier 3: context-firewall facade — `find_tools` + relevance ranking
  - `3b872b0` Tier 2: record & replay cassettes ("VCR for MCP")
  - `f92276e` Tier 2: interceptor plugin framework, tool-poisoning scanner, DLP, audit log
  - `37c922b` Tier 1: security hardening, correctness fixes, and analysis docs
- **Tests:** 292 passing across 15 files. `npm test` runs `pretest` (tsup build +
  build:fixtures) then vitest. Full run is ~90s (integration tests spawn real
  child processes; `fileParallelism: false` — do NOT change).
- **Gate:** a `simple-git-hooks` pre-commit hook runs
  `npm run format && npm run lint && npm run typecheck && npm test` on every
  commit. Expect every commit to take ~90s+. All four must pass.

### Build / test / run quickref
```bash
npm run build       # tsup → dist/index.js  (also regenerates README help tables)
npm run typecheck   # tsc --noEmit
npm run lint        # eslint src tests
npm test            # pretest (build + fixtures) then vitest run  (~90s)
npx vitest run tests/foo.test.ts        # single file, no rebuild
npx vitest run tests/foo.test.ts -t "x" # filter by name
# Drive the REPL manually against the mock server:
npm run start -- -- node --import tsx tests/fixtures/mock-server.ts
```

---

## 3. What has been built (so you don't redo it)

### Tier 1 — security / correctness / test integrity (commit 37c922b)
- **SBPL (Seatbelt) profile injection fixed** — `src/settings.ts` now has
  `escapeSbplString()` / `hasControlChar()`; every config-supplied path
  interpolated into the macOS `.sb` profile is escaped, and unsafe Docker `-v`
  mount paths fail closed (`src/target-manager.ts`). Was a sandbox-escape via a
  crafted project-scoped `.run-mcp/settings.json`.
- **Network proxy now ENFORCES** — `src/proxy-audit.ts` `NetworkAuditProxy`
  takes an `isAllowed(host)` predicate (wired from `SandboxPolicy.isNetworkAllowed`
  in `target-manager.ts`) and returns 403 / refuses CONNECT for disallowed hosts.
  Previously it only logged (docs claimed enforcement that didn't exist).
- **ANSI/OSC terminal-injection sanitized** — `src/repl/ui.ts` `sanitizeServerText()`
  (+ `stripAnsi`, both imperative, no regex control-byte literals) applied to all
  server-sourced text printed by the REPL (tool names/descriptions/results,
  resource/prompt text, notifications, banner). Neutralizes OSC 52 clipboard
  hijack, prompt spoofing, etc.
- **`process.env` leak fixed** — custom env is now threaded into the child via a
  new `env` option on `TargetManager` (merged in `_getDefaultEnvironment`), not
  mutated onto the parent process. Applied in `server.ts`, `validator.ts`. This
  also fixed a latent bug: custom env never actually reached the child before.
- **Correctness bugs:** case-insensitive bare-tool-name dispatch (repl),
  `--clear` no longer corrupts JSON payloads, `splitArgs` preserves Windows
  backslashes, keypress-listener leak removed, `view`/`--open-media` use
  `execFile` (no shell).
- **Session daemon hardened** — forwards the full `--allow-*/--deny-*` policy (was
  dropping it) and writes session files at mode 0600 / dir 0700.
- **Test integrity** — `tests/sandbox-enforcement.test.ts` runs the real hostile
  fixture (`tests/fixtures/vulnerable-stdio-server.ts`) with a VISIBLE
  `describe.skipIf` (ends the silent "vacuous green" skips). NOTE: the *old*
  silent-`return` skips in `tests/target-manager.test.ts` still exist — they're
  now backstopped by the new file but could still be cleaned up (see §5 follow-ups).
- **Docs drift fixed** — AGENTS.md bundle-size claims, `scripts/update-schema.js`
  stale fallback (bumped to 2025-11-25 + renamed spec repo URL), and
  `@microsoft/mxc-sdk` declared as `optionalDependencies`.

### Tier 2 — interceptor as a product (commits f92276e, 3b872b0)
- **Plugin framework** — `src/plugins.ts`. `ResponseInterceptor` is now an ordered
  middleware pipeline. Key API:
  - `InterceptorOptions.plugins?: InterceptorPlugin[]` and `.cassette?`.
  - `interceptor.processToolList(tools) → { tools, findings }` runs `onToolsList`
    hooks (the tools/list transform point — used for tool-poisoning scanning).
  - Result hooks `onToolResult` / `onResourceResult` / `onPromptResult` run after
    the built-in media/truncation processing, threading `PluginFinding[]` into
    `InterceptionMetadata.findings`.
  - Backward-compatible: no plugins = passthrough.
- **Tool-poisoning scanner** (`toolPoisoningScanner()`) — strips invisible/bidi/
  Unicode-Tag chars from tools/list metadata and flags injection phrasing;
  findings surfaced to the agent as a "Tool Safety Findings" block. **Default ON
  in the agent server only** (opt out `--no-scan-tools`). Verified e2e with
  `tests/fixtures/poisoned-server.ts`.
- **DLP / secret redaction** (`secretRedactionPlugin({ redactEmails })`) — redacts
  recognizable secret formats from tool/resource/prompt result text. **Opt-in**
  (`--redact-secrets [--redact-emails]`) because it mutates content.
- **JSONL audit log** — `src/audit.ts` `AuditLogger`; `TargetManager` emits a
  `history` event on every request; wired in the agent server via `--audit-log <file>`.
- **Record & replay ("VCR for MCP")** — `src/cassette.ts` `Cassette`. Modes
  `record` / `replay` / `auto`; keyed by canonical `(primitive, name, args)` hash
  (`stableStringify`). **Replay short-circuits the target entirely** — which is
  WHY it's a first-class interceptor capability and NOT a plugin (plugins run
  after the call and can't skip it). Wired into headless: `--cassette <file>` /
  `--record` / `--replay`; in replay mode call/read/get-prompt run fully OFFLINE
  (no target command needed).

### Tier 3 — context-firewall facade (commit 3bb61a4)
- **`src/ranking.ts`** — pure lexical token-overlap ranking (`rankTools`,
  `tokenize`, `scoreTool`). Name weighted over description; whole-query substring
  bonus; stopword filter. **Deliberately NOT embeddings** (a zero-dep local CLI
  can't ship a model — documented tradeoff; the module is separable so an
  embedding backend can drop in later).
- **`find_tools` agent tool** (`src/server.ts`) — completes Dynamic Context
  Loading so agents avoid the "Tools Tax": Level 1 `list_available_mcp_servers`
  → Level 2 `find_tools` (ranked compact summaries, **no schemas by default**) →
  Level 3 `list_mcp_primitives(name=…)` (one full schema) → `call_mcp_primitive`.
  The agent server now exposes **10 tools**.

### Deliverable docs produced
- `analysis-report.md`, `recommendations.md` (root). If you regenerate/split
  these, keep them in sync with reality.

---

## 4. Architecture cheat-sheet (module map)

Source under `src/`. Prefer describing by module/function; line numbers drift.

| Module | Responsibility |
|---|---|
| `index.ts` | Commander CLI entry. Routes to REPL / headless subcommands / agent server. Registers headless subcommands via `registerHeadlessCommand()`. Pre-processes `--` into `activeTargetCommand`. Session daemon lives here. |
| `target-manager.ts` | Spawns target MCP server, MCP Client lifecycle (stdio/SSE), sandbox wrapping (`_maybeWrapCommand`), auto-reconnect, stderr capture, request history (emits `history`), env threading (`_getDefaultEnvironment`). |
| `interceptor.ts` | `ResponseInterceptor`: timeouts (Promise.race), media→disk, truncation, base64 detection, PLUS the plugin pipeline (`processToolList`, result hooks) and cassette record/replay. |
| `plugins.ts` | Plugin framework + `toolPoisoningScanner` + `secretRedactionPlugin`. |
| `cassette.ts` | Record/replay store. |
| `ranking.ts` | Lexical tool ranking for `find_tools`. |
| `audit.ts` | JSONL `AuditLogger`. |
| `settings.ts` | Hierarchical sandbox config + `SandboxPolicy` (deny-wins) + Seatbelt profile generation + SBPL escaping. |
| `proxy-audit.ts` | Local network proxy: audits AND enforces per-policy. |
| `server.ts` | Agent-mode MCP server (10 tools). Constructs the interceptor with plugins; wires audit logger; `find_tools`. |
| `headless.ts` | Single-shot executor. Builds cassette; offline replay. |
| `repl/*` | Interactive readline UI. `commands.ts` (dispatch), `index.ts` (loop/events), `completer.ts`, `wizard.ts`, `ui.ts` (incl. sanitizer), `state.ts` (module-singleton state), `history.ts`. |
| `snapshot.ts` | Reconnect diffing (tools/resources/prompts added/removed/modified). |
| `watcher.ts` | `--watch` file watcher (fs.watch recursive). |
| `config-scanner.ts` | Discovers MCP servers across 15 client config formats. |
| `parsing.ts` | Pure helpers (command parsing, HTTPie args, JSON colorize, Levenshtein, scaffolding). Well unit-tested; the pattern to follow. |
| `validator.ts` | Protocol-compliance validator (`run-mcp validate`), uses ajv + pinned schema. |
| `colors.ts` | Color precedence (`--color`>`CLICOLOR_FORCE`>`NO_COLOR`>`CLICOLOR`>isatty). |

**Where the security/interceptor features are (and AREN'T) wired — important:**
- Tool-poisoning scanner: **agent server only** (default on). NOT in REPL or headless.
- DLP redaction: **agent server only** (opt-in). NOT in REPL or headless.
- Audit log: **agent server only** (`--audit-log`).
- Cassette record/replay: **headless only** (`--cassette`). NOT in agent server or REPL.
- `find_tools`: **agent server only**.
- ANSI sanitization: **REPL only** (that's where a TTY is; agent/headless emit JSON).

---

## 5. Non-obvious gotchas (READ before editing — these will bite you)

1. **The Edit tool mangles regex control-byte literals.** Writing a regex like
   `/[\x00-\x1f]/` or `/[: \x00-\x1f]/` in an Edit `new_string` can insert LITERAL
   control bytes into the file (unreadable, unmaintainable, and the exact-match
   for future edits breaks). This happened repeatedly. **Fix pattern used
   everywhere:** imperative char-code scans (`hasControlChar`, the `ui.ts`
   sanitizer, `stripInvisible` via `codePointAt`) or `new RegExp` built from
   `String.fromCodePoint(...)`. In tests, build control chars with
   `String.fromCodePoint(0x1b)` etc. Do NOT paste raw escapes into Edit strings.
2. **Pre-commit hook runs the FULL ~90s suite.** Every `git commit` pays it. Don't
   be surprised; don't `--no-verify` (the user wants the gate).
3. **`fileParallelism: false`** in vitest — integration tests spawn stdio child
   processes; parallel runs collide. Leave it.
4. **README is auto-generated by `npm run build`** (`scripts/update-readme-help.js`
   scrapes `node dist/index.js --help` between HTML-comment markers). If you add a
   root CLI flag or an "Agent Mode Tools:" line in `index.ts`'s `addHelpText`,
   rebuild so README stays in sync. Headless-subcommand-specific options
   (`--cassette`, etc.) are NOT scraped into README (only root options are).
5. **`prepublishOnly` runs only `tsup`**, not the README refresh — a publish can
   ship stale README tables. Run `npm run build` before publishing.
6. **Replay can't be a plugin.** Plugins run *after* the target call; replay must
   skip it. That's why cassette is built into the interceptor's call methods.
7. **Interceptor findings surface only via `include_metadata`/`processToolList`.**
   `callTool` (no metadata) discards findings.
8. **Server test asserts an exact tool count** (`toHaveLength(10)` in
   `tests/server.test.ts`). If you add/remove an agent tool, update it and the
   name assertions and the `--help` "Agent Mode Tools" list and AGENTS.md.
9. **`@microsoft/mxc-sdk`** is loaded via string-indirected dynamic import in
   `target-manager.ts` so the bundler can't see it; it's an `optionalDependency`
   (Windows sandbox only). Absence is handled gracefully.
10. **MCP spec/SDK are current** — schema pinned to `2025-11-25`, SDK 1.29.x
    installed (floor `^1.12.1`). The pinned schema DOES include elicitation,
    structured output (`outputSchema`/`structuredContent`), and Tasks.

---

## 6. Remaining roadmap items (the actual work list)

Ordered roughly by value/fit. Each has enough context to start cold.

### 6.1 — Tier 2 leftover: Streamable HTTP transport  ✅ DONE (this session)
- Implemented in `target-manager.ts`: http(s) targets default to
  `StreamableHTTPClientTransport`; a `transport` constructor option / `--transport
  auto|http|sse` flag selects the mode. `auto` (default) tries Streamable HTTP and
  falls back to legacy SSE on failure (`_selectHttpTransportKind`, `_connect`
  fallback). Threaded through REPL/headless/agent-server.
- Tested in `tests/streamable-http.test.ts` with in-process stateless Streamable
  HTTP + SSE-only servers (ephemeral ports) — covers http connect/call, auto
  selection, and the auto→SSE fallback. (Note: `vulnerable-http-server.ts` remains
  unused/orphaned; the new tests use in-process servers instead.)

### 6.2 — Tier 2 leftover: test hardening  ◑ PARTIALLY DONE (this session)
Done this session:
- Mock server now simulates **sampling** and **elicitation** (`request_sampling`,
  `request_elicitation` tools) → `tests/target-manager.test.ts` covers the
  `sampling_request` / `elicitation_request` forwarding events.
- Added unit tests: `snapshot.ts` (diff add/modify/remove paths),
  `colors.ts` (full precedence hierarchy), `config-scanner.ts` (scan walk-up +
  malformed/skip handling), `watcher.ts` (relativePath, start/stop, debounced
  change with platform-unsupported fallback).
- Covered untested TargetManager surface: `ping`, `listResourceTemplates`,
  `getPrompt`, history buffer get/clear, roots add/list/remove.

Still open:
- Mock server STILL does NOT simulate: resource subscriptions, real pagination
  (ignores `cursor`, never returns `nextCursor`), progress notifications,
  cancellation, completion, list_changed, structured/`outputSchema` output.
- `repl/*` remains ZERO-coverage (entire interactive surface incl. sampling/
  elicitation approval prompts, watch mode). Hard to test due to the
  module-singleton state in `repl/state.ts` — refactor that for testability or
  extract more pure logic à la `parsing.ts`.
- Untested TargetManager: successful auto-reconnect (only no-reconnect paths),
  subscribe/unsubscribe, setLoggingLevel, complete, notification buffers.
- **Flakiness to clean:** sleep-based sync in `server.test.ts` /
  `target-manager.test.ts`; `settings.test.ts` uses a repo-root temp dir + touches
  the real `~/.ssh` resolution; fixed session name/port in headless session test.
- **Old silent sandbox skips:** the `return;` skips in the sandbox `describe` of
  `tests/target-manager.test.ts` are entangled with a module-level `vi.mock` of
  `node:child_process.execSync` that fakes bwrap presence — computing availability
  at import time would hit the mock and never skip honestly. Left as-is; the Tier 1
  `tests/sandbox-enforcement.test.ts` already provides honest visible-skip coverage
  against the real hostile server. Untangle only if you also de-mock that file.

### 6.3 — Consistency follow-ups discovered during Tier 1–3 (small, high-value)
- **Scanner/DLP not in REPL or headless.** The tool-poisoning scanner and DLP only
  run in the agent server. A human using the REPL against an untrusted server gets
  no scan. Consider wiring `processToolList` into `repl/commands.ts` `cmdToolsList`/
  `cmdToolsDescribe` and into headless `list-tools`/`describe`. (ANSI sanitization
  already protects the REPL terminal, but poisoned *phrasing* isn't flagged there.)
- **REPL custom-env still leaks/doesn't forward.** The no-arg REPL picker in
  `index.ts` does `Object.assign(process.env, selected.config.env)` and `startRepl`
  builds a `TargetManager` without threading `env`. Apply the same `env` option fix
  used for the agent server (Tier 1.4) to the REPL path.
- **`find` REPL command.** `find_tools` exists only in the agent server. A human
  `find <query>` REPL command over `rankTools` would be a cheap, nice parallel.
- **Reconnect temp-file leak.** `target-manager.ts` `_maybeReconnect` nulls
  transport/client without `close()`, and `connect()` overwrites `_tempSbPath`,
  leaking the prior `.sb` file. Minor; clean up on reconnect.

### 6.4 — Tier 3: MCP multiplexer / aggregator
- **Idea:** run-mcp connects to SEVERAL target servers and exposes a single
  unified, namespaced, searchable facade (`serverA.toolX`). Addresses the "too many
  endpoints" problem. Reuses `rankTools` (search across all) and the plugin
  pipeline (scan all). Natural extension of the context-firewall facade.
- **Scope call:** could be a run-mcp *mode* or edge toward a spin-off product;
  discuss with the user before committing — it changes run-mcp from single-target
  to multi-target, touching `TargetManager` ownership (probably a `TargetPool`).

### 6.5 — Tier 3: importable middleware library (GATED)
- Only once the plugin framework has ≥1 real external consumer. Would export
  `wrapClient(client, [injectionScan, redact, lazyLoad, audit])` over the SDK
  `Client`. Requires committing to a stable public API + semver + docs. Don't
  start speculatively (locked decision #4).

### 6.6 — Tier 3: eval / CI harness
- Run an agent loop against a target MCP server and grade tool selection / latency
  / errors ("does my server actually work with a model"). Fits the testing
  identity. Pairs well with record/replay (deterministic evals).

### 6.7 — Tier 4: NEW PROJECTS (spin-offs, not run-mcp scope)
- **Enterprise MCP gateway** — OAuth 2.1/PKCE, RBAC, JWT validation, remote
  topology. Different product/buyer; Kong/TrueFoundry already occupy this. Only if
  the user explicitly wants to pivot.
- **Cloud sandbox execution** (E2B/Modal-style) — contradicts run-mcp's local-first,
  zero-daemon identity.
- **Always-on "MCP context proxy"** — the maximal facade+scanner+DLP+audit product
  every agent points at. A rename/spin-off of the whole project, not a mode.

---

## 7. How to verify changes (this project's expectations)
- Run `npm run typecheck && npm run lint` continuously; `npm test` before commit.
- For behavior changes, **drive the real flow**, don't just unit-test:
  - REPL: `npm run start -- -- node --import tsx tests/fixtures/mock-server.ts`,
    then type commands and read the output.
  - Agent server e2e: connect a real MCP `Client` to `dist/index.js --mcp` (see
    `tests/server.test.ts` `startRunMcpServer`).
  - Headless: spawn `dist/index.js <subcommand> ... -- <target>` (see
    `tests/headless.test.ts` `runCli`).
- For security features, point tests at the hostile fixtures
  (`vulnerable-stdio-server.ts`, `poisoned-server.ts`) and assert denial/flagging.
- Follow the coding conventions in `AGENTS.md` (intent-based naming, aggressive
  early returns, extract pure logic for testability, coaching error messages,
  never add a dependency not already in the lockfile without authorization).

---

## 8. Suggested next step
The user has been working tier-by-tier and committing each chunk (each commit
passes the full gate). Good next moves, in order of recommendation:
1. **Open a PR** for the four branch commits (nothing is pushed yet) — this is a
   natural checkpoint after Tiers 1–3.
2. **Streamable HTTP transport** (§6.1) — the clearest remaining Tier 2 item.
3. **Test hardening** (§6.2) or the **consistency follow-ups** (§6.3).

Confirm direction with the user; don't assume a PR is wanted (they may keep
stacking commits on the branch).
