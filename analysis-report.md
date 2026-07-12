# run-mcp — Independent Analysis Report

A full-codebase read (every `src/` module, all tests, the fixtures, the docs) plus
a blindspot pass. Written before reviewing the creator's ideas or the ecosystem
research (those inform `recommendations.md`).

**Headline conclusion:** The testing-tool framing undersells the asset. The real,
defensible thing run-mcp owns is the **interceptor pipeline + its MITM position in
the stdio pipe** — the exact capability the ecosystem research names as the unfilled
"interceptor framework gap" and the unfilled "lightweight local sandbox" gap. But
before chasing that: there are **security bugs in the current sandbox that make it
partly theater**, and the interceptor pipeline — the crown jewel — is doing the
least interesting possible work (save images, truncate text). Fix the foundation,
then make the interceptor the product.

---

## 1. Architecture & Code Quality

### Strengths worth preserving
- **"Three interfaces, one pipeline"** is real and clean. `TargetManager` (lifecycle/transport) and `ResponseInterceptor` (content transformation) are genuinely reused by REPL, headless, and agent-server. This is the load-bearing abstraction and it holds.
- **`parsing.ts` is exemplary** — pure, exhaustively unit-tested, the "extract for testability" rule actually followed. The character-level JSON colorizer, Levenshtein suggestions, and schema scaffolding are all independently testable.
- **`colors.ts`** correctly implements the full color-enable precedence (`--color` > `CLICOLOR_FORCE` > `NO_COLOR` > `CLICOLOR` > isatty).
- **Static cleanup registration** in `TargetManager` (`_instances` set, single signal handler) is the right pattern and avoids `MaxListenersExceeded`.
- **Capability-aware UX** — completions and help dim/hide commands the server doesn't advertise.
- **Auto-reconnect state machine** (min-uptime guard, retry cap, stability reset) is thoughtfully designed.

### Anti-patterns / dead code / leaky abstractions
- **`handleCommand` does too much** (`repl/commands.ts:85`, ~190 lines): dispatch + inline `view` shell-out + typo UX in one switch.
- **Heavy duplication in the REPL**: the "tool not found + suggestion" block is copy-pasted 4× (`commands.ts:335,426,572,837`); JSON-vs-HTTPie arg parsing 2×; "parse text / try JSON / print yellow" rendering 3×; the `-32601` mapping is duplicated between the readline loop and the script loop (`index.ts:93` & `:500`).
- **Dead code**: `historyList`/`setHistoryList` (`state.ts:121`) exported, never imported. Two vulnerable fixtures never referenced (see §4).
- **Leaky abstraction into readline internals**: completer and history poke undocumented private fields (`activeRl.line`, `_refreshLine`, `.history`) — fragile across Node versions.
- **Module-singleton state** (`repl/state.ts`, 11 getter/setter pairs) makes the REPL impossible to instantiate twice and awkward to test; it's why `repl/*` has **zero** unit tests.
- **`cmdToolsCall` reprints non-text content with `formatJson`** (`commands.ts:518`) — dumps full base64 to the terminal even though the interceptor already saved the media.

### Over- vs under-engineered
- **Over-engineered:** the interactive wizard/menu/fuzzy-picker layer is large and elaborate for what is fundamentally a dev tool; the config-scanner supports 15 client formats (maintenance tax that drifts).
- **Under-engineered:** the **interceptor** — the architecturally most interesting module — only saves media and truncates. No transformation, no redaction, no policy, no injection scanning. This is the biggest missed opportunity in the codebase (see §6).

---

## 2. Security Audit (most important section)

Ranked by severity. Items marked ⚠️ are exploitable, not hypothetical.

1. **⚠️ Seatbelt/SBPL profile injection (sandbox escape).** In `settings.ts:276–341`, config-supplied paths are interpolated straight into the `.sb` profile string as `(subpath "${p}")` with no escaping. A malicious project-scoped `.run-mcp/settings.json` (which travels inside a cloned repo, and is loaded automatically — `settings.ts:382`) can set a `denyRead`/`allowRead` path containing `"` and `)` to inject arbitrary SBPL directives (e.g. close the subpath, add `(allow default)` or `(allow network*)`). The same untrusted-path-into-command-construction pattern exists for the Docker `-v` mount translation (`target-manager.ts:1004–1041`). This turns the headline security feature into a bypass vector.

2. **⚠️ The network "sandbox" doesn't enforce — it only audits.** `NetworkAuditProxy` (`proxy-audit.ts`) forwards *everything* and never consults `SandboxPolicy.isNetworkAllowed`/`matchDomain`. So `--allow-net github.com` in practice grants **all** outbound network (the proxy just logs destinations), and `--deny-net evil.com` is unenforced at the proxy layer. On macOS the generated profile uses a blanket `(allow network-outbound)` with only IP-literal denies (the code comment even concedes domains get resolved); on Linux bwrap it's all-or-nothing (`--unshare-net`). Net effect: documented per-domain allow/deny is largely not real. A correctness+security gap between docs and behavior.

3. **⚠️ Terminal escape (ANSI/OSC) injection — "run-mcp as the attack vector."** Untrusted server-controlled strings (tool names, descriptions, result text, resource/prompt text, notification data, **and the server name/version rendered into the REPL banner box**) are printed to the terminal with zero sanitization (`commands.ts:294,504,511,931,1086`; `index.ts:229,253,427`). A hostile server can emit OSC 52 (clipboard hijack), cursor/screen manipulation, hyperlink spoofing, or fake prompt lines to phish the user. `stripAnsi` exists (`ui.ts:141`) but is used only for width math and only matches trivial SGR. This is the cleanest example of run-mcp's MITM position being a liability instead of an asset.

4. **⚠️ `process.env` global mutation leaks across connections.** `connect_to_mcp`/`ensureConnected` (`server.ts:355,173`) write `process.env[key]=value` and **never restore** them. In the long-lived agent-server, env (including secrets passed to one target) persists into every subsequently spawned target. `validate`/`search` restore correctly; connect does not.

5. **Session daemon has no authN and drops sandbox flags.** The daemon listens on a TCP port on 127.0.0.1 (`index.ts:365`); the port+pid live in a world-readable file under `tmpdir` (`index.ts:34`). Any local process can connect and drive `execute` against the target. Separately, `handleHeadlessSession` forwards only `--sandbox` to the daemon, **not** the `--allow-*/--deny-*` rules (`index.ts:120–124`) — so credential protections silently vanish in session mode.

6. **Default posture is `none`, and credential protection only engages when network is granted.** `applyCredentialProtections` (`settings.ts:147`) only denies `~/.ssh` etc. when `networkAllow.size > 0`. With the default `--sandbox none`, there is no protection at all. Most users running `run-mcp -- node server.js` get zero isolation. This matches the research's "semantic confusion / illusion of sandboxing" warning almost exactly.

7. **Secrets persisted in cleartext.** `~/.run-mcp/wizard_defaults.json` stores whatever was typed into interactive prompts (API keys, tokens) keyed by tool name; `~/.run-mcp/history` stores full command lines including inline JSON. No redaction, no opt-out.

8. **`view` command shell injection** (`commands.ts:120`): `exec(\`${cmd} "${filepath}"\`)` — self-inflicted (user's own path input) but should be `execFile` with no shell. Same pattern in `interceptor.ts:385` `--open-media` (filepath is generated there, so lower risk).

9. **Supply chain:** `@microsoft/mxc-sdk` is an **undeclared** dependency loaded via string-indirected dynamic import (`target-manager.ts:957`) specifically so the bundler can't see it — invisible to `npm audit`/lockfile tooling. `--scan` walks up **every parent directory** reading arbitrary JSON files (`config-scanner.ts:121`), which can traverse above the repo into unrelated trees.

---

## 3. Performance & Reliability
- **Interception pipeline is fine** but the base64 heuristic runs a regex over full text bodies and `Buffer.byteLength(..., "base64")` twice per media item; negligible at current scale.
- **Reconnect leaks temp files:** `_maybeReconnect` nulls `transport`/`client` without `close()`, and `connect()` overwrites `_tempSbPath` — the prior `.sb` file is never `rmSync`'d. Minor disk leak over many reconnects.
- **Orphaned tool calls by design:** the 10-hour SDK timeout + `Promise.race` means a timed-out call keeps running in the child (intentional for long builds, but worth documenting as a resource consideration).
- **`--scan` config walk** does `readdir`+`readFile` up the whole tree on the hot path of the no-arg launch and `search_all_local_mcp_servers`.
- **Watcher** uses `fs.watch({recursive:true})` (needs Node 20 on Linux) with no fallback; a single debounce timer.

---

## 4. Test Coverage Gaps
- **Sandbox enforcement is effectively untested on CI.** Every real enforcement test `return`s early (silent skip, not `it.skip`) when `bwrap`/`sandbox-exec` is absent (`target-manager.test.ts:299–451`) → **vacuous green** on stock CI.
- **The two purpose-built hostile fixtures (`vulnerable-stdio-server.ts`, `vulnerable-http-server.ts`) are referenced by no test.** The project ships an attack server for sandbox testing and never points a sandbox test at it. This is the single biggest structural test gap.
- **macOS non-audit Seatbelt profile** (the primary enforcement path) — never generated in a test.
- **Zero tests** for: `repl/*` (entire interactive surface, incl. sampling/elicitation approval prompts), `config-scanner.ts`, `watcher.ts`, `snapshot.ts` (diff add/modify/remove paths never triggered — only "unchanged" asserted), `colors.ts`.
- **Untested TargetManager surface:** successful auto-reconnect, ping, resource templates, subscribe/unsubscribe, getPrompt, setLoggingLevel, complete, roots, history/notification buffers.
- **Mock server simulates none of:** sampling, elicitation, subscriptions, real pagination, progress, cancellation, completion, roots, list-changed, structured/`outputSchema` output. So all those code paths are unreachable in tests.
- **Flakiness:** sleep-based sync (`server.test.ts:701`, `target-manager.test.ts:71`), repo-root temp dirs (`settings.test.ts:97`, canary files in cwd), tests mutating the developer's real `~/.ssh` resolution, fixed session name/port. UI-substring assertions couple tests to copy.

---

## 5. Strategic Position
- **True differentiator (my view):** Not "a nicer way to test MCP servers." It's **the only lightweight, local, transparent interceptor that already sits inside the stdio pipe** and can read/transform every message bilaterally, plus spawn OS-native sandboxes with ~0ms overhead. The research doc literally describes run-mcp as the tool positioned to fill both the interceptor-middleware gap and the lightweight-local-sandbox gap.
- **Why choose it over a quick test script:** interception (media/large payloads that break your terminal), sandboxing untrusted servers, protocol-compliance validation, reconnect diffing, and the agent-facing dynamic-test tools. A script gives you none of these.
- **Biggest missed opportunity:** the interceptor does janitorial work when it could be a **programmable middleware layer** (redaction, injection scanning, policy, lazy schema loading, record/replay). Everything hard (the MITM plumbing) is already built.

---

## 6. Feature Brainstorm (conservative → wild)

Each: **feasibility / impact / scope** (in = fits today's identity; spin = new project).

1. **Tool-poisoning / prompt-injection scanner on `tools/list`** — intercept description/schema metadata and flag or strip hidden instructions before they reach the agent's context. *High feasibility (MITM already there), high impact, IN.* Uses the pipeline nobody else can.
2. **Redaction / DLP interceptor** — strip secrets/PII (API keys, `~/.aws` patterns, emails) from tool responses before they hit context. *High / high / IN.*
3. **Record & replay ("VCR for MCP")** — capture real tool responses to a cassette, replay deterministically for snapshot tests and offline agent dev. *High / high / IN — best fit for the testing identity.*
4. **Real network enforcement** — make the audit proxy actually block per-`SandboxPolicy`, close the seatbelt-injection and enforce/audit gap. *Medium / high / IN (also a fix).*
5. **Context-firewall / lazy-schema facade** — present a facade MCP server exposing compact one-line tool summaries + a `load_tool(name)` drill-down (Dynamic Context Loading, the research's 95% token reduction). *Medium / very high / IN-ish → borderline spin.* Directly attacks the "Tools Tax."
6. **MCP multiplexer / aggregator** — compose several target servers behind one namespaced facade ("too many endpoints"). *Medium / high / borderline (in as a mode, spin as a product).*
7. **Structured audit log (JSONL) + policy gateway** — every request/response/decision to a signed, append-only log; deny-by-default policy file. Enterprise adoption lever. *Medium / high / IN (extends settings) → spin at gateway scale.*
8. **Eval/CI harness** — run an agent loop against your server and grade tool selection/latency/errors; "does my MCP server actually work with a model." *Medium / high / IN.*
9. **Importable library form factor** — export the interceptor as composable middleware over the SDK `Client`. *Medium / medium / gated on the interceptor becoming the product (see `recommendations.md`).*
10. **Wild — "MCP context proxy" as a standing product:** a persistent, always-on local proxy every agent points at, doing lazy loading + injection scanning + DLP + audit for *all* your MCP servers at once. The maximal version of #1/#2/#5/#7 combined; a **spin-off / rename** of the whole project. *Lower feasibility, paradigm-shifting, SPIN.*
