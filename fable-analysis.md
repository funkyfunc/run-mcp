# run-mcp — Independent Architectural & Strategic Analysis

*Fresh-eyes review, July 2026. Written **before** reading `.invisible/ideas.md` or the research docs, per the review protocol — this is my independent view. The security/sandboxing layer is out of scope and not assessed here.*

---

## 0. Executive summary

run-mcp is a genuinely good codebase wearing three hats, and two of them fit. The **dev-tool identity** (REPL + headless CLI + agent test harness) is coherent, differentiated, and nearly feature-complete. The **interceptor-plugin substrate** is the real strategic asset — small, well-shaped, and sitting in a position (the client↔server pipe) that neither the SDK nor the platform vendors occupy. The **compressing proxy** is directionally right but is currently a *tools-only façade*, not the "production-grade transparent proxy" of the pitch: it drops resources, prompts, sampling, elicitation, notifications, structured output, and pagination, has no caching, no backend reconnect, and re-fetches the tool list from every backend on every call. That gap between pitch and artifact is the single most important thing to fix or re-scope.

My headline judgments:

1. **You are not two products in a trenchcoat — yet.** Dev tool and proxy share ~80% of their load-bearing code (`TargetManager`, interceptor, ranking, compression helpers). But they diverge in *fidelity requirements*: a test harness may legitimately flatten and truncate; a production proxy must be transparent. The moment you honor the proxy's fidelity bar, the shared pipeline needs a "passthrough-faithful" mode it doesn't have today. That's an architecture decision, not a packaging one — make it now, cheaply, rather than after users depend on lossy behavior.
2. **The token-bloat bet is correct but the moat is thin.** Progressive disclosure + BM25 is exactly where the industry landed (Anthropic ships it model-side; Atlassian ships it as a proxy). run-mcp's durable edge is not the compression algorithm — it's being the *local, zero-config, client-agnostic* place where compression composes with scanning, audit, record/replay, and multiplexing. Sell the composition, not the compression.
3. **The most valuable unexploited asset is the result side, not the catalog side.** The interceptor already does "save media to disk, return a handle." Extending that same move to large text/JSON results (spill to disk, return summary + handle + a `read_result` tool) attacks the *other* half of context bloat, and nobody in the ecosystem does it well.
4. **Reliability debt is small but real and cheap to fix:** a timer leak per intercepted call, an O(n²) cassette writer, an instance set that never shrinks, a proxy that never reconnects backends, and a validator that makes every CLI startup pay for ajv compilation.

---

## 1. Architecture & code quality (non-security)

### 1.1 What's strong — preserve these

- **Pure-function extraction discipline.** `parsing.ts`, `compression.ts`, `ranking.ts`, `snapshot.ts`, `cassette.stableStringify` are dependency-free, deterministic, and carry the densest test coverage in the repo. This is the house style at its best and it's why the proxy could be built quickly. Keep enforcing it.
- **The plugin framework is the right size.** Four hooks, a `report()` channel, findings threaded into metadata, ordered execution, passthrough-by-default. It resisted the temptation to become a generic middleware bus with priorities/DI/lifecycle events. The one structural insight already encoded — *replay can't be a plugin because plugins run post-call* — shows the abstraction boundary was actually thought through.
- **`TargetManager` as the single client-side seam.** Everything (REPL, headless, agent server, proxy, validator, pool) talks to targets through one class that emits `history`, `stderr`, `notification`, `sampling_request`, `elicitation_request`. This event surface is what makes audit logging, REPL approval prompts, and (in the future) full proxy forwarding cheap. It's the most valuable class in the repo.
- **Errors that coach** is consistently applied, and it matters more for agent consumers than human ones (a blind error burns a model retry loop). This is a real differentiator versus the official Inspector.
- **Operational discipline:** single bundled ESM file, four runtime deps external, README auto-generated from `--help`, pre-commit gate running the full suite. Docs drift is being actively fought, which is rare.

### 1.2 Anti-patterns and debt — ranked by how much they'll hurt

**(a) The MCP-server wiring is now duplicated three ways — yes, your suspicion is right.**
`server.ts` (agent harness), `proxy.ts` single-backend, and `proxy.ts` multi-backend each hand-roll: `new McpServer(...)` + `StdioServerTransport` + `onclose → close targets → process.exit(0)` + per-tool `registerTool` with locally re-implemented "not found → isError text + available list" responses. `notFound()` exists in proxy.ts but server.ts re-implements the same shape inline several times. Meanwhile the option plumbing (`sandbox/allow*/deny*/env/transport`) is re-declared in **four** option interfaces (`ServerOptions`, `ProxyOptions`, `HeadlessOptions`, `ReplOptions`) and threaded by hand at six call sites. Extract: (1) a shared `TargetSpawnOptions` type, (2) a `bootstrapMcpServer(name, tools, onClose)` helper, (3) a tiny `errorResult(text)` / `textResult(text)` pair. This is a half-day refactor that removes the main source of copy-paste drift before B2 grows further.

**(b) `server.ts` is a 1,550-line closure and `repl/commands.ts` is a 1,711-line switchboard.**
Neither is *wrong*, but both are past the size where the pattern pays for itself. `startServer` holds `target`/`previousSnapshot`/`cachedSpawnConfig` as closure state with ten tools defined inline — untestable except through a full e2e spawn (which is exactly what `server.test.ts` does, at ~55 slow tests). Moving tool definitions to a module that takes a small context object (`{ getTarget, setTarget, interceptor, opts }`) would let half of `server.test.ts` become fast unit tests. Same story for `commands.ts`: the `cmd*` functions are fine, but dispatch + interactive flows + formatting in one file guarantees merge friction.

**(c) The REPL module-singleton state is the direct cause of its zero test coverage.**
`repl/state.ts` exports mutable bindings with `set*` functions — a hand-rolled global store. The cost isn't "two REPLs can't coexist" (irrelevant); it's that no REPL logic can be constructed in a test without touching process-global state, so the entire interactive surface (1,700+ lines, including the sampling/elicitation approval flows — protocol behavior, not just UI) is untested. A mechanical `ReplSession` class holding `rl`, caches, history, and flags, passed to `handleCommand`, would fix this without changing behavior. The `withSuspendedReadline` dance (destroy readline → run inquirer → rebuild readline, coordinated through the `globalPauseReadlineClose` flag) is the most fragile code in the repo; it works, but every new interactive flow must remember the incantation.

**(d) Three structurally identical tool types.** `ToolDef` (plugins), `BackendTool` (compression), `RankableTool` (ranking) are the same `{ name, description?, inputSchema?, [k: string]: unknown }`. Unify in one place; the `as any` casts at each seam (`processToolList(tools as any)`) exist because of this.

**(e) Duplicated discovery/dedup logic.** The `name::command::args` dedup-with-project-preference block appears in `server.ts` twice (in `list_available_mcp_servers` and `search_all_local_mcp_servers`) and again in `config-scanner.pickDiscoveredServer`. It belongs in `config-scanner.ts`.

**(f) Under-engineered in one spot that matters: `firstSentence`.** Splitting on the first `.` truncates "e.g." / "v1.2" / URLs. Every `medium`-level catalog entry flows through it, so this single 4-line function quietly degrades the primary product surface (the compressed catalog an agent reads). Worth a slightly smarter sentence split and a unit-test file of adversarial descriptions.

**(g) Over-engineered:** nothing egregious. The `build:fixtures` precompile-to-`tests/fixtures/dist` optimization is the closest — it buys tsx startup time but adds a stale-artifact hazard when running `vitest` directly (a stale compiled fixture silently shadows the .ts source).

### 1.3 Test coverage — the honest map

The suite (~367 tests) is strong on pure modules and the agent-server surface, and weak exactly where run-mcp's *reliability story* lives:

- **`repl/` is ~0% covered** except `ui.ts`. Includes the sampling/elicitation approval logic — protocol correctness, not cosmetics.
- **Auto-reconnect's success path is never exercised.** Tests cover "disabled by default" and "startup crash → no retry"; nobody kills a healthy child and asserts `reconnecting → reconnected`, attempt-counter reset after the 60s stability window, or `max_retries` exhaustion. This is the feature the README leads with for watch mode.
- **Notification plumbing** (`tools/list_changed`, `resources/updated`, the ring buffer, `getNotifications`) is untested at the TargetManager layer.
- **Proxy failure modes:** no test for a dead backend in a live multiplexer (`invoke_tool` to a crashed backend), unknown-prefix routing, or partial-fleet startup at the *proxy* layer (only at the pool layer).
- **Client-role surface:** `subscribeResource`/`unsubscribe`/`complete`/`setLoggingLevel`/`requestRaw` untested.
- **Non-hermetic tests:** one in-scope test issues a **real HTTP request to example.com** (via the mock server's `sandbox_net_test`), and `config-scanner.test.ts` reads the developer's real machine configs with correspondingly loose assertions. Both will bite in CI.
- **Brittleness by design:** exact-count assertions (`toHaveLength(10)` tools, "Tools Count: 15") make every surface change a two-file edit. Fine if intentional (it *is* a change-detector), but consider asserting supersets.
- **Infra duplication:** `mockTarget()` re-declared in three test files; the tmp-dir pattern copy-pasted in five; the sandbox-availability guard duplicated four times in `target-manager.test.ts`. A 30-line addition to `helpers.ts` removes all of it.
- **Sleep-based synchronization** (200–500ms `setTimeout` before asserting events arrived) in `server.test.ts`/`target-manager.test.ts` is the suite's main flake reservoir.

---

## 2. The compressing proxy & token bloat — deep dive

### 2.1 My independent view of the right mitigation strategy

Before critiquing the implementation: if I were designing run-mcp's context-bloat answer from scratch, it would be a **three-front strategy**, because the bloat has three distinct sources:

1. **Catalog bloat** (the "Tools Tax"): tool schemas eagerly loaded. Answer: progressive disclosure — overview → search → one schema → invoke. run-mcp has built exactly this. Correct.
2. **Result bloat**: a single `list_issues` call returning 80KB of pretty-printed JSON. Answer today is truncation (lossy, destroys the tail) and JSON minify (lossless but marginal — typically 5–15%). The high-value move is the one the interceptor *already makes for media*: **spill to disk, return a handle**. Write the full result to `outDir`, return the first N chars + item count + a `read_result(handle, query/jq-path/range)` tool. That converts truncation from destructive to navigable. Nobody in the MCP ecosystem does this well, it's ~200 lines on top of existing machinery, and it works for every backend with zero configuration. This is, in my view, the single highest-leverage unbuilt feature in the repo.
3. **Repetition bloat**: agents re-listing and re-fetching identical content across turns. Answer: content-addressed caching — and the cassette is 80% of this machinery already (canonical keying by `(primitive, name, args)`). A within-session "you already saw this exact result; unchanged since seq #41" response is cheap and novel.

The compressing proxy addresses front 1 well and front 2 weakly (`--compress-output` minify). Front 3 is unaddressed. I'd expect any serious research on this topic to converge on the same three fronts; the differentiator is that run-mcp can do all three *in one hop*.

### 2.2 Is the Dynamic-Context-Loading design sound?

The **shape** is sound and independently validated (Anthropic's model-side tool search defaults to regex/BM25; Atlassian's mcp-compressor is the same discovery-on-demand move). Specific design calls, assessed:

- **Catalog embedded in `get_tool_schema`'s description** — clever and correct: it makes Level-1 discovery free (no tool call) while keeping the tool count at 2. But it's computed **once at startup** (`initialTools`, `const overview`) and never refreshed, while every *handler* re-fetches live. So a backend that adds tools post-startup serves a stale catalog with fresh handlers — the worst combination (the agent can't discover the new tool but could invoke it). Neither `tools/list_changed` from backends (already captured by `TargetManager`!) is consumed, nor is a `list_changed` notification emitted downstream. This is the clearest correctness gap in the proxy.
- **BM25 is the right call.** Deterministic, zero-dep, matches the platform default, and the name-boost + args-in-document choices mirror Anthropic's indexing fields. Its real weakness is vocabulary mismatch ("upload a file" vs `put_object`) and no stemming ("issues" won't match "issue"). Before reaching for embeddings: add cheap suffix-stripping stemming and index the server description/instructions into each tool's document. Embeddings-as-opt-in remains the correct posture — don't build it until a real corpus shows BM25 failing.
- **Single vs multi backend split:** defensible but currently costs you a duplicated surface. B1 exposes `get_tool_schema`/`invoke_tool`; B2 exposes those plus `list_servers`/`find_tools`/`list_server_tools`, with namespacing only in B2. An agent moving from one config to the other meets a different API. I'd unify: single-backend = multiplexer with one entry and prefixing disabled. One code path, one surface, `find_tools` available even for one backend (useful for 100-tool single servers — arguably the *primary* case for compression).

### 2.3 Where it breaks at scale

- **No tool-list caching, anywhere.** `loadTools()`/`serverTools()` hit the backend on *every* `get_tool_schema`, `invoke_tool`, `find_tools`, and `list_server_tools` call. `find_tools` does it **sequentially across all N backends** (`for...await` in a loop); `invoke_tool` pays an extra full `tools/list` round trip before every actual call (via `resolve()`). For local stdio backends this is milliseconds; for HTTP backends it's user-visible latency and rate-limit burn, multiplied by fleet size. Notably, the Atlassian reference you cloned **does** have this: its `ToolCache` is a lazily-populated, explicitly-refreshable per-backend schema store — run-mcp is behind its own reference implementation here. Fix: per-backend cache invalidated by `tools/list_changed` (fall back to TTL for servers that don't emit it), and `Promise.all` the fan-out. This also fixes 2.2's staleness once the description/catalog reads from the same cache.
- **Eager spawn of every backend at startup.** 20 configured servers = 20 child processes running for the whole session, whether or not the agent ever touches them. This contradicts the tool's own thesis (pay for what you use). Lazy spawn-on-first-use fits the DCL surface naturally — `list_servers` can describe a backend from config without connecting; connect on first `find_tools`/`invoke_tool` touch. (Tension to manage: lazy spawn moves failure discovery to first use; mitigate by reporting connect state in `list_servers`.)
- **No backend reconnect.** `enableAutoReconnect()` exists on `TargetManager` but the proxy never calls it, and `TargetPool` has no health/reconnect notion. A backend that crashes mid-session silently vanishes from `serverByPrefix` (it filters on `connected`) — tools disappear from search with no signal to the agent. A long-lived production proxy needs: auto-reconnect per backend, a `list_servers` status column, and an explicit "backend X is down" error on invoke rather than "tool not found."
- **Catalog size has no guard.** At `low`/`medium`, the whole catalog lives in one tool description. A 300-tool backend at `medium` can produce a description bigger than the problem you're solving. Auto-escalate the level (or switch to the `max`/list_tools shape) past a size threshold, and log what happened.
- **Pagination is ignored.** `listTools()` takes one page. A backend that paginates gets a silently partial catalog — worse than an error. Loop the cursor.
- **Namespacing edge:** `normalizeServerName` can emit prefixes containing `__` (config name `my__server` survives as `my__server`), and `parseNamespacedName` splits on the *first* `__` → `my` + `server__tool` → "not found". Collapse underscore runs in normalization, or make the separator configurable/robust. Also relevant the moment someone chains proxies (proxy-of-proxy), which the multiplexer design actively invites.

### 2.4 The fidelity gap — the strategic bug

The proxy today is **tools-only**. As a run-mcp *mode* for context compression, fine. As "a production-grade proxy," not yet:

- **Resources and prompts don't exist** downstream, even though `TargetManager` speaks both fluently. (mcp-compressor, for comparison, passes both through — this is table stakes even in the reference you benchmarked against.)
- **Sampling/elicitation from a backend hangs.** `TargetManager` emits `sampling_request`/`elicitation_request`; the agent server forwards them upstream; **the proxy has no listener**, so a backend that requests sampling waits 5 minutes and gets a timeout rejection. The wiring exists 20 lines away in `server.ts` — this is an omission, not a design choice, and it will present as "my server hangs behind run-mcp proxy."
- **`invoke_tool` flattens results to a single text blob**: `structuredContent` is dropped (just as `outputSchema`-typed tools are becoming the norm), non-text content beyond the interceptor's media-handles is discarded, and `_meta` vanishes. A compressing proxy may *choose* lossy defaults, but it must have a faithful mode.
- **Notifications, progress, cancellation, logging** are not forwarded.

The pattern across all four: *the information already flows into `TargetManager`; the proxy just doesn't pass it on.* A "transparent passthrough + selective interception" core — where everything is forwarded by default and the compression surface is a transformation applied on top — is the architecture the pitch describes. What's built is the inverse: a new, narrower server that consults backends. Closing this is the difference between "dev-time façade" and "runtime interceptor," i.e., it *is* the staged strategy you committed to. It should be the explicit next stage, and honestly it's prerequisite to calling anything "production-grade."

---

## 3. Performance & reliability

Ranked by (likelihood × blast radius):

1. **Interceptor timeout timers are never cleared** (`_timeout` in `interceptor.ts`). Every intercepted call leaves a live `setTimeout` for the full timeout window (default 5 min; the SDK-level timeout behind it is 10 h). A busy agent/proxy session accumulates thousands of pending timers; they retain memory, keep the event loop alive, and skew shutdown. Fix: `clearTimeout` when the race settles (or at minimum `.unref()`).
2. **`Cassette.save()` rewrites the entire file synchronously on every record.** O(n²) total I/O and an event-loop stall on the hot request path (`writeFileSync` mid-tool-call). Fine for 20-entry test fixtures; pathological for "record a long agent session." Buffer + debounced flush, or append JSONL with compaction on close.
3. **`TargetManager._instances` only grows.** `close()` never removes the instance from the static cleanup set. The agent server and `search_all_local_mcp_servers` create a TargetManager per connect/scan; each dead instance retains its history buffer (up to 100 **full results** — multi-MB payloads included) and stderr ring. Long-lived agent-server sessions leak monotonically. Also: `_history` keeping full result objects is itself a memory hazard independent of the leak — consider storing sizes/hashes beyond a small window.
4. **Signal-handler shutdown doesn't await.** `SIGINT` → `cleanupAll()` (fires async `close()`s, including `treeKill`) → immediate `process.exit(130)`. The kills race the exit; grandchildren can survive. `process.on("exit")` can't run async work at all. Deliberate best-effort is fine, but a short grace (`await Promise.race([Promise.allSettled(closes), 500ms])`) would make "never leave orphaned server processes" (AGENTS.md §5) actually true.
5. **Every CLI startup pays for ajv.** `index.ts` statically imports `validator.ts`, which compiles five ajv validators at module load and drags `ajv`+formats+the pinned JSON schema into the hot path of *every* invocation — including `run-mcp call` in CI loops where startup latency is the product. Lazy-import the validator in the two places it's used.
6. **`call_mcp_primitive` does `tools/list` before every tool call** (best-effort validation), and the proxy's `resolve()` does the same — doubling per-call round trips systemwide. With the tool-list cache from §2.3 both become free.
7. **Daemon sessions have no idle reaper and no crash handling.** A forgotten `--session` daemon lives until reboot; a crashed target inside a daemon leaves a session that fails every request until manually closed (no auto-reconnect, no self-termination on disconnect). Add idle-timeout self-exit and a `disconnected → cleanup + exit` handler.
8. **`--scan` walks to filesystem root reading every `.json` en route** with no size cap or depth limit; a stray 200MB `.json` in `$HOME` gets slurped into memory for an `includes("mcpServers")` check. Cheap guards: stat-based size cap, skip >1MB.
9. **Watch-mode reconnect races in-flight commands.** The watcher `close()`s the target while a queued REPL command may be mid-call; there's no coordination with the command queue. Low severity (interactive), but it's the kind of thing that erodes trust in watch mode.
10. **`search_all_local_mcp_servers` spawns every configured server on the machine, sequentially** (3s cap each). Ten configured servers ≈ up to 30s and ten side-effectful process launches for one query. Should parallelize, and arguably should be opt-in per server (spawning arbitrary configured servers is a surprising side effect for a "search").

*(Noted but accepted: `Promise.race` timeout without protocol cancellation is a documented, deliberate choice — long builds finish in the background. With MCP now specifying cancellation and tasks, offering opt-in cancel-on-timeout would modernize this without breaking the default.)*

---

## 4. Strategic position

### 4.1 Where the value survives platform encroachment

Anthropic shipping model-side tool search, and clients (Claude Code, Cursor) shipping their own MCP management, eats the *thin* versions of run-mcp:

- "Tool search to reduce catalog tokens" → **platform feature now.** Anyone using Claude with tool-search gets BM25 discovery for free, model-side, with no extra hop. Other model vendors will follow.
- "List/call tools from the terminal" → contested by the official Inspector (GUI) and a growing pile of one-shot CLIs.

What the platform *cannot* easily eat:

1. **Client-agnostic, local, in-the-pipe position.** Model-side tool search only works for that vendor's models and only for tool *catalogs*. A local proxy works for every client (Claude, Cursor, Copilot, local models), every direction (results, not just catalogs), and composes multiple servers. Atlassian's mcp-compressor validates the shape — and, read closely, it's further along than "point solution": it has per-backend tool caching, resources/prompts passthrough, OAuth for remote backends, multi-server namespacing, and a whole second strategy (generated CLI/Python/TS clients — Code Mode) run-mcp has deferred. What it does **not** have: any tool ranking/search (the model reads the whole compact listing), SSE backends, notification/sampling/elicitation handling, or anything resembling run-mcp's test-harness/REPL/cassette/scanner surface. So the honest comparison: mcp-compressor is a better *proxy core* today; run-mcp is a better *platform around the pipe*. run-mcp's edge is that compression is *one plugin among several* in an interception pipeline — but only if the proxy core reaches parity (cache, passthrough, auth).
2. **The dev loop.** Watch mode + reconnect diffing + validator + REPL + record/replay is a *workflow*, not a feature. Nobody building an MCP server wants to restart Claude Desktop to test a change. This identity is safe and still under-marketed.
3. **Record/replay.** Cassettes make MCP servers testable in CI and agents developable offline. This is quietly the most defensible artifact in the repo — VCR took years to be displaced in the HTTP world, and there is no MCP-native equivalent with mindshare yet.
4. **The interceptor framework gap is real.** The official SDK (checked against the workspace copy) still has no middleware/transform hook on the client path. Until it does, run-mcp is the reference implementation of "MCP middleware." If the SDK *does* grow hooks, run-mcp's plugins should be portable onto them — which argues for keeping plugin signatures SDK-shaped (they already are, roughly).

### 4.2 Is "dev-tool + production-proxy" coherent?

**Coherent, on one condition.** The unifying identity is not "we run MCP servers" (too generic) nor "we compress tokens" (platform-vulnerable). It is: **run-mcp is the programmable middle of the MCP pipe** — the place where you *observe* (REPL, audit, history), *test* (harness, validator, cassettes, watch), and *transform* (compress, redact, gate, multiplex) traffic between any client and any server. Dev-tool and runtime-proxy are then the same product at two points in the software lifecycle, exactly like nginx on a laptop vs nginx in prod.

The condition: **transparent-by-default must become literally true at the protocol level** (§2.4). Today the proxy is a façade that re-serves a subset of the backend. If a "production" user points a real workload at it and their elicitation flow hangs or their structured output vanishes, the identity collapses into "test tool that pretends." Ship full passthrough (tools, resources, prompts, sampling, elicitation, notifications, pagination, `_meta`) with interception as *transformation on top*, and the two identities genuinely fuse.

The honest counter-position you should consider: the *proxy* could be the product and the REPL the on-ramp — i.e., you're not adding a proxy to a dev tool; you're discovering that the dev tool was always a proxy with a terminal UI attached. That framing changes what you build next (fidelity, uptime, config story) more than what you've built so far.

### 4.3 What I'd worry about that you didn't ask about (blind spots)

- **No OAuth story for remote servers.** `TargetManager` constructs HTTP transports with no `authProvider`. The ecosystem is moving hard toward remote, OAuth-protected servers (the SDK client ships full OAuth 2.1: PKCE, RFC 9728 protected-resource discovery off `WWW-Authenticate`, RFC 8707 resource indicators, dynamic client registration), and even mcp-compressor does browser-flow OAuth for HTTP backends. A proxy/test-tool that can't connect to authenticated remote servers is cut off from the growth segment. This is a bigger strategic hole than anything in the compression layer — and it's mostly SDK plumbing, not new invention.
- **Config is CLI-flags-only.** A production proxy wants a declarative config file (backends, levels, plugins, per-server policy) — you already parse `mcpServers` files; you don't yet *own* a `run-mcp.config.json`. Whoever owns the config file owns the deployment.
- **No programmatic/library surface — correctly deferred, but the plugin API is silently becoming public.** Third parties will write plugins before you declare the interface stable. Decide *when* `InterceptorPlugin` freezes, or version it.
- **The proxy has no metrics.** For a "production" pipe: tokens-saved counters exist as findings, but there's no aggregate (per-session savings report, per-backend latency, error rates). Cheap to add on the `history` event; big demo value ("run-mcp saved 214k tokens this session").
- **Windows is quietly second-class** in the dev loop (watch mode uses `fs.watch` recursive — OK on Win, but the REPL/TTY dance and `cmd /c start` paths are untested). If agents are your users, they're on all three OSes.
- **You are one `npm publish` away from name-squatting risk on the plugin ecosystem** you're implicitly creating (`run-mcp-plugin-*`). Cheap to reserve the pattern early.

---

## 5. Paradigm shifts to get ahead of

*(Assessed against the pinned 2025-11-25 spec and the SDK's current surface — including the v2.0.0-alpha monorepo rewrite in the workspace clone.)*

0. **The protocol "era split" — the biggest one, and it's hiding in the SDK alpha.** The v2 SDK encodes two wire eras: the **legacy era** (2024-10-07 through 2025-11-25, `initialize`-handshake-based) and a gated **modern era** (`2026-07-28`): **no `initialize`** (replaced by `server/discover`), every request carrying a `_meta` envelope with reserved lift-and-restamp keys (protocol version, client info/capabilities, log level), `tasks/*` and `logging/setLevel` and `resources/subscribe` *deleted* as methods and reworked as `_meta`/extension capabilities (`io.modelcontextprotocol/*`), and `subscriptions/listen` replacing resource subscriptions. Three consequences for run-mcp: (a) a spec-faithful proxy must treat reserved `_meta` keys as connection-scoped — *never* blindly forward them across the boundary — while preserving user `_meta`; (b) **era bridging is a killer man-in-the-middle feature**: a modern client talking to the world's installed base of legacy servers (or vice versa) needs exactly a translation proxy, and nobody is positioned better; (c) the validator gains a new axis ("which era(s) does your server actually speak?"). This will land inside the next few spec cycles; the passthrough core (§2.4) should be built with a version-aware codec seam from day one rather than assuming one wire vocabulary.

1. **Structured output (`outputSchema`/`structuredContent`) — immediate.** Tools increasingly return typed results. Every lossy path in run-mcp (proxy flatten, truncation, compression) currently treats results as text-first. Interception should become schema-aware: truncate *fields*, not characters; preserve `structuredContent` through the proxy; validate outputs against `outputSchema` in the validator and harness (a genuinely new test-tool feature: "your server declares an outputSchema it doesn't honor").
2. **MCP Tasks / async operations — near-term, and a gift to a proxy.** In the pinned spec, requests can be task-augmented (`tasks/get|list|cancel|result`, TTL metadata, per-request-type capability advertisement). Two implications: (a) the interceptor's Promise.race timeout model becomes obsolete for task-capable servers — the proxy should *offer* task semantics; (b) a proxy can **upgrade legacy servers**: wrap a slow synchronous backend tool in task semantics for task-capable clients (accept → poll → result), which is a feature no individual server can build for itself. That's a man-in-the-middle exclusive. One caution before building big: the 2026 era *reworks* tasks into an extension capability — implement behind an adapter, not woven through the core.
3. **Elicitation & sampling going mainstream** — the REPL already has approval UX, the agent server forwards; the proxy must (§2.4). Beyond parity: run-mcp is positioned to be the *policy point* for these flows (auto-approve rules, logging every elicitation for review) — "what did my server ask the user this week?"
4. **Code Mode / imperative execution.** The industry is converging on "give the model a code API, not 50 tool schemas" (Cloudflare's Code Mode, skills-as-code — and mcp-compressor already ships generated Python/TypeScript/CLI clients plus a "just bash" mode as an alternative compression strategy). Deferring the V8 sandbox is right; what's *not* deferrable is the shape of the surface: a `run_script` tool that executes a short JS snippet against the proxied tool set (`await tools.github.create_issue(...)`) collapses N round trips into one and is the natural terminal point of the compression staircase (catalog → search → schema → invoke → *compose*). Keep it opt-in and sandboxed when it comes, but design the multiplexer's namespacing/typing so tool identities map cleanly to a generated API (they already almost do: `server__tool` ↔ `tools.server.tool`).
5. **Agent Skills.** Skills bundle instructions + scripts and increasingly *replace* eager tool catalogs. A cute inversion for run-mcp: generate a skill from a backend (catalog summary + invocation recipes) — "compile" an MCP server into a skill file. Watch this space; don't build yet.
6. **Transport evolution: Streamable HTTP + stateless servers + resumability.** Done on the client side (with SSE fallback — good). The missing halves: serving the *proxy itself* over Streamable HTTP (today stdio-only — a run-mcp proxy you can point N clients at, run in a container, or host for a team is the actual "production proxy" deployment shape), and OAuth on outbound (§4.3).
7. **Registry & discovery.** The MCP registry ecosystem ( `.well-known`, marketplaces) will eventually eat config-file scanning. `config-scanner`'s 15 hand-maintained client paths are a treadmill; a registry-aware discovery source is the exit.

---

## 6. Feature brainstorm (conservative → wild)

Each tagged **feasibility / impact / scope**.

1. **Tool-list cache + `list_changed` propagation** (the §2.3 fix). *High feas / high impact / in-scope.* Prerequisite for everything else in the proxy.
2. **Result spill-to-disk with `read_result` handle tool** (§2.1 front 2). *High / very high / in-scope.* Truncation becomes navigation. Who uses it: every agent hitting verbose servers (GitHub, Jira, DB tools) — daily pain, zero config.
3. **Session token-savings report** (`--stats`): aggregate findings + history into "this session: 214k chars saved, 41 calls, p95 latency by backend." *High / medium / in-scope.* It's also your marketing screenshot.
4. **Full-fidelity passthrough mode** (`run-mcp proxy --passthrough` graduating to default substrate): resources/prompts/sampling/elicitation/notifications/pagination forwarded; compression becomes a layer. *Medium / very high / in-scope — this IS the strategy.*
5. **Schema-aware result pruning plugin**: given `outputSchema` (or learned shape), drop/summarize low-information fields (`avatar_url`, `node_id`, 40 timestamps per item) with a per-tool field allowlist learned from what the agent actually referenced. *Medium / high / in-scope.* Nobody has this; it's the "interceptor pipeline idea nobody's tried" and it beats minification by 10×.
6. **Interceptor idea nobody's tried #2 — response diffing**: for repeated identical calls (agents re-list constantly), return "unchanged since call #41" or a JSON-patch delta instead of the full body. Cassette keying makes this ~150 lines. *High / medium-high / in-scope.*
7. **`run-mcp eval`**: drive a target server with a scripted agent loop (or replayed cassette), grade tool-selection/latency/schema-compliance; CI-friendly JSON verdicts. Makes run-mcp indispensable to *agent developers*, not just server developers. *Medium / high / in-scope (natural extension of validate + cassettes).*
8. **Proxy-served-over-HTTP** (multi-client, containerizable, team-shared run-mcp). *Medium / high / in-scope for the production identity; the deployment unit changes from "CLI" to "sidecar."*
9. **Task-semantics upgrade shim** (§5.2): wrap slow sync backends in MCP Tasks for task-capable clients. *Medium / medium-high (rising fast) / in-scope.* Man-in-the-middle exclusive.
10. **Protocol era/version bridge**: translate between protocol revisions in the pipe (modern client ↔ legacy server and vice versa: handshake style, method vocabulary, `_meta` envelope semantics) as the 2026 era lands. *Low feasibility today (spec still gated) / very high impact when it lands / in-scope — and only a proxy can do it.* Design the passthrough core with a codec seam now so this becomes an adapter, not a rewrite.
11. **Policy engine for the pipe**: declarative per-server/per-tool rules (allow/deny/require-approval/rate-limit/log) evaluated in the interceptor; elicitation/sampling auto-policies included. *Medium / high / borderline — the moment it grows RBAC/tenancy it's the enterprise-gateway spin-off; keep the local single-user core in-scope.*
12. **MCP server composition ("mcpfile")**: declare a *virtual server* assembled from backends — pick 12 tools from 4 servers, rename them, pin arg defaults, prepend instructions — served as one clean MCP server. Docker-compose for MCP. *Medium / high / in-scope-ish; this is the multiplexer growing intent.* Who uses it: anyone whose agent needs 12 tools but whose config drags in 200.
13. **Cassette-first server mocking**: `run-mcp mock --cassette x.json` serves a recorded server *without* the backend — instant fake MCP server for tests/demos/offline dev. *High / medium / in-scope (cassette + McpServer glue).*
14. **Wild — the pipe becomes the product: "MCP flight recorder + time travel."** Always-on ring-buffer recording (bounded cassette + history) of every session run-mcp touches; `run-mcp replay <session>` reconstructs any agent↔server interaction after the fact — step through it in the REPL, diff two runs, export a failing interaction as a shareable repro (cassette + config + transcript). Debugging agents is today's unsolved misery; the man-in-the-middle is the only place a client-agnostic recorder can live. This reframes run-mcp from "proxy with a REPL" to "observability substrate for the agent era" — and every feature above (audit, cassettes, history, snapshot diffing) turns out to be a component of it. *Medium feasibility (the pieces exist!) / potentially defining impact / in-scope as trajectory, spin-off as SaaS.*

---

## 7. Bottom line

- The codebase is healthy; the debt list is short and cheap (§1.2a–f, §3.1–5 are collectively ~2 weeks).
- The strategy is right in direction and validated by the market — but the proxy must earn the word "transparent" before it can earn the word "production." Fidelity first, then scale (cache/lazy/reconnect), then the result-side compression that nobody else has.
- The durable identity is the **programmable middle of the pipe** (observe / test / transform), with the flight-recorder trajectory as the wild-but-plausible north star.
- Biggest unasked-question risks: no OAuth for remote servers, no owned config format, stdio-only proxy deployment.
