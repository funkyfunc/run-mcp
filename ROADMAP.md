# run-mcp — Roadmap & Session Handoff

> **Read this first if you're a fresh session.** This file is the single source
> of truth for scope and direction. It supersedes the tiered roadmaps in
> `fable-recommendations.md` and `recommendations.md` (kept as historical
> records) after the **July 2026 refocus** — see §1 for the scope rule that
> now governs all new work.

---

## 1. What run-mcp is — and the scope rule

`run-mcp` exists so that **agents (and humans) can dynamically interact with
MCP servers — above all, servers being developed locally.** It was created so
an agent building an MCP server can spawn it, poke it, read its stderr, fix it,
and reconnect — without editing client config files. Everything else is
secondary.

Three interfaces, one pipeline (`TargetManager` → `ResponseInterceptor`):

1. **Agent MCP Server** (`run-mcp` / `--mcp`) — meta-tools (`connect_to_mcp`,
   `call_mcp_primitive`, `find_tools`, …) so an agent can test local servers.
2. **Interactive REPL** (`run-mcp -- node server.js`) — humans doing the same.
3. **Headless CLI** (`run-mcp call`, `list-tools`, …) — CI/scripts/jq.

**The scope rule (July 2026 refocus):** every new feature must make this dev
loop better for a user we can name, and the evidence bar is *actual use* — not
research reports, industry zeitgeist, or "strategic positioning." The project
drifted toward a second product (a production compression proxy) on zero user
evidence; that work is now frozen (§4). When in doubt, ask: *does the person
developing an MCP server locally touch this?* If not, it doesn't go in.

---

## 2. Current state

- **Branch:** `main`, clean. **Tests:** 381 across 24 files (`npm test` ≈ 100s;
  integration tests spawn real child processes; `fileParallelism: false` — do
  NOT change).
- Spec pinned to `2025-11-25`; SDK 1.29.x; pure ESM; single bundled
  `dist/index.js` (~424KB).
- Historical review docs at the repo root: `fable-analysis.md` (architecture
  deep-dive — still accurate and worth reading) and `fable-recommendations.md`
  (its roadmap tiers are superseded by this file), plus the older
  `analysis-report.md`/`recommendations.md` pass.

---

## 3. What stays — the product

Each of these is used directly in the local dev loop:

| Surface | Who touches it |
|---|---|
| **Agent MCP server** (11 tools: connect/call/list/find/read_result/status/stderr/validate/discover/search) | The agent developing a server |
| **REPL** (commands, explore menu, wizard, watch mode `-w` + reconnect diff) | The human developing a server. *Maintenance mode* — keep working, no structural investment |
| **Headless CLI** (`call`/`list-tools`/`describe`/…, sessions, script mode, `$LAST`, `@expect-error`) | CI and shell workflows |
| **Interceptor** (timeouts, media→disk, truncation, plugin hooks) | Protects the consuming agent's context on every call |
| **Validator** (`validate --deep`, schema-pinned) | "Is my server spec-compliant?" |
| **Cassettes** (record/replay, offline headless) | Deterministic CI tests of your server; offline agent dev |
| **Snapshot diffing** (reconnect/watch "what changed") | The edit-test loop |
| **Config scanner / picker** | Finding local servers to point at |
| **Streamable HTTP + SSE fallback** | Testing remote-transport servers |
| **`find_tools` (BM25) in the agent server** | Agents navigating a large server under test |
| **Security layer** (sandboxing, poisoning scanner, DLP, audit) | Handled; out of band of this roadmap |
| **`--compress-output`** (lossless minify plugin) | Marginal but tiny and harmless; keep |

---

## 4. Frozen: the compressing proxy (`run-mcp proxy`, B1/B2)

**What it is:** single-backend `get_tool_schema`/`invoke_tool` surface (B1) and
the multi-backend Dynamic-Context-Loading multiplexer (B2), with tool-list
caching, backend auto-reconnect, sampling/elicitation forwarding, and catalog
guards (`src/proxy.ts`, `src/compression.ts`, `src/target-pool.ts`,
`src/tool-cache.ts`).

**Status: frozen, not deleted.** It works, it's tested (proxy/target-pool/
tool-cache/compression suites), and it costs nothing sitting still. But its
user — an agent *operator* fronting a fleet of servers in daily use — is not
this package's user, and no such user has materialized. Meanwhile the platform
eats the thin version (model-side tool search) and Atlassian's mcp-compressor
owns the dedicated-proxy shape.

**Frozen means:** fix bugs, keep tests green, accept no new proxy features.
The follow-on plans that were queued behind it — full passthrough substrate,
OAuth, owned config file, stats, era bridging, task shims, Code Mode, skills
bridge, embeddings, every spin-off — are **out of the plan entirely** (the
sketches survive in `fable-recommendations.md` for the record).

**Unfreeze trigger (either):** (a) it earns a permanent place in the creator's
own agent configuration after real dogfooding, or (b) an external user shows up
asking for it. Demand reopens it; nothing else does.

---

## 5. The work list (short, mission-anchored)

Bug fixes and dev-loop polish always qualify. Beyond that, only three items
are scheduled:

1. **Result spill-to-disk + `read_result`.** Extend the interceptor's existing
   media pattern ("save to disk, return a handle") to oversized text/JSON
   results: write the full payload to `outDir`, return the head + item count +
   a handle; a `read_result(handle, range)` tool (agent server) / REPL command
   lets the consumer navigate instead of losing the tail to truncation. This is
   the original mission — protecting the agent's context while it tests verbose
   servers — and today's truncation is destructive where this is navigable.
2. **`outputSchema` conformance checking** in the validator (and surfaced in
   `validate_mcp_server --deep`): flag tools that declare an `outputSchema`
   whose `structuredContent` doesn't validate against it. Structured output is
   now mainstream spec surface; a server dev has no other local way to catch
   this.
3. **Extract the REPL sampling/elicitation approval logic** into a testable
   module (`repl/index.ts` inline closures today). It's protocol behavior with
   zero coverage — the one exception to REPL maintenance mode.

Candidate, unscheduled (build only if pulled): an **eval harness** ("does my
server actually work with a model" — scripted agent loop + cassettes, graded).
It fits the mission but is large; wait for the need to be felt in real use.

---

## 6. Build / test / run quickref

```bash
npm run build       # tsup → dist/index.js (also regenerates README help tables)
npm run typecheck   # tsc --noEmit
npm run lint        # eslint src tests
npm test            # pretest (build + fixtures) then vitest run (~100s)
npx vitest run tests/foo.test.ts        # single file, no rebuild
npx vitest run tests/foo.test.ts -t "x" # filter by name
# Drive the REPL manually against the mock server:
npm run start -- -- node --import tsx tests/fixtures/mock-server.ts
```

---

## 7. Non-obvious gotchas (READ before editing)

1. **`npx vitest run` does not rebuild `dist/`.** Tests that spawn the CLI
   (proxy, server, headless suites) run the stale bundle after `src/` edits —
   `npm run build` first, or use `npm test` (its pretest builds).
2. **The Edit tool mangles regex control-byte literals** (`/[\x00-\x1f]/`).
   Use imperative char-code scans or `String.fromCodePoint` — never paste raw
   escapes into edit strings.
3. **Pre-commit hook runs the FULL suite** (format+lint+typecheck+test, ~2min)
   on every commit. Don't `--no-verify`.
4. **README is auto-generated by `npm run build`** (root CLI options + agent
   tools list). `prepublishOnly` runs only tsup — run a full build before
   publishing or README ships stale.
5. **Cassette writes are debounced.** `record()` schedules a flush; call
   `flush()` in tests that reload the file, and know the process-exit hook
   covers real runs. Replay can't be a plugin (plugins run post-call; replay
   must skip the call) — it stays built into the interceptor.
6. **Interceptor findings surface only via `include_metadata`/`processToolList`** —
   plain `callTool` discards them.
7. **`tests/server.test.ts` asserts exact tool counts** (11 agent tools;
   mock server "Tools Count: 15"). Adding/removing tools means updating those
   assertions, the `--help` agent-tools list, and AGENTS.md.
8. **`@microsoft/mxc-sdk`** is a string-indirected dynamic import
   (optionalDependency, Windows sandbox only); absence is handled.
9. **Proxy tool-list caching:** backend catalogs are cached
   (`src/tool-cache.ts`) and invalidated by `tools/list_changed` + TTL; catalog
   descriptions update via `RegisteredTool.update` only on real change. Bug
   fixes here must preserve that prompt-cache stability.
10. **TargetManager cleanup is a static set** — instances remove themselves on
    `close()`; signal handlers are registered once with a bounded 500ms grace.
    Don't add per-instance process listeners.

---

## 8. How to verify changes

- `npm run typecheck && npm run lint` continuously; `npm test` before commit.
- For behavior changes, **drive the real flow**, don't just unit-test:
  - REPL: `npm run start -- -- node --import tsx tests/fixtures/mock-server.ts`
  - Agent server: connect a real MCP `Client` to `dist/index.js --mcp`
    (see `tests/server.test.ts` `startRunMcpServer`).
  - Headless: spawn `dist/index.js <subcommand> ... -- <target>`
    (see `tests/headless.test.ts` `runCli`).
- Follow AGENTS.md conventions: intent-based naming, aggressive early returns,
  extract pure logic for testability, coaching error messages, no new
  dependencies without authorization.
