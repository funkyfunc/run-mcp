# run-mcp — Recommendations & Prioritized Roadmap

Synthesizes the independent findings (`analysis-report.md`), the creator's ideas
(`.invisible/ideas.md`), and the ecosystem research (`docs/research/`), plus the
strategic decisions locked during the interview.

---

## 1. Reaction to the creator's ideas (`.invisible/ideas.md`)

**Idea 1 — "SDK for code you could import; is there value beyond the TS SDK?"**
Yes, but conditionally — and I verified the gap against the SDK source (the
workspace copy is `@modelcontextprotocol/sdk@2.0.0-alpha.0`): its `Client` has
**no** interceptor/middleware/transform/hook concept, and nothing for sandboxing,
redaction, or truncation. So run-mcp's interception pipeline, OS-native sandbox
spawner, audit proxy, reconnect diffing, and protocol validation are genuinely
absent from the SDK. **However**, most of those modules are CLI-shaped, not
library-shaped; a wholesale export would be a grab-bag with a tiny audience. The
one genuinely library-shaped, differentiated piece is the **interceptor reframed
as composable middleware over `Client`**: `wrapClient(client, [injectionScan,
redact, lazyLoad, audit])`. That has a plausible audience (agent-harness/host
authors) and clearly beats roll-your-own. **Recommendation: don't ship a library
as a standalone goal.** Build the middleware plugin framework first; the library
falls out as a thin, honest wrapper. Revisit once the framework exists and has ≥1
real external consumer.

**Idea 2 — "Context bloat from how harnesses implement MCP — in scope?"**
This is the strongest thread, and the research backs it hard (the "Tools Tax":
15k–55k tokens/turn, reasoning collapse past ~70% context, ~95% reduction with
lazy loading). Nuance: eager loading is a *client/harness* decision and a proxy
can't force a harness to lazy-load — **but** run-mcp's MITM position lets it do
lazy loading *transparently* (present compact summaries, let the model drill down
via a `load_tool` tool). That is exactly Dynamic Context Loading. **Verdict: not a
distraction — arguably the highest-impact direction.** It is in scope as a
**run-mcp facade mode**, with the deliberate understanding that it moves run-mcp
from a dev/test tool onto the production agent↔server path.

**Golden-hammer check:** The instinct to worry is correct. The trap is the
gateway/aggregator/always-on-proxy ideas turning run-mcp into "an everything
gateway." Discipline: each interceptor feature must have a clear "who uses this and
why." Injection-scan, DLP, record/replay, and the lazy-schema facade pass that
test cleanly. The enterprise gateway and always-on proxy are spin-offs.

---

## 2. Ecosystem gaps → run-mcp moves

| Research gap | run-mcp response | In-scope? |
|---|---|---|
| Tools Tax / context bloat | Lazy-schema facade | **Mode (chosen strategic bet)** |
| Tool poisoning (TP-001..008) | `tools/list` injection scanner | **In** |
| No native interceptor/middleware (SEP-1763) | Programmable interceptor pipeline | **In — this is the moat** |
| Data exfiltration / SSRF | Real network enforcement + DLP | **In** |
| Illusion of sandboxing / ACE | Fix sandbox + default-deny posture | **In** |
| Binary payload / no tool-to-tool composition | Extend media-to-disk to a content-store handle passed between tools | In (extension) |
| Debugging friction / observability | Structured audit log + record/replay | **In** |
| Stateful/transport, SSE deprecation | Add Streamable HTTP transport (SSE is deprecated in SDK) | **In (fix)** |
| OAuth 2.1 / gateway / confused deputy | Enterprise gateway | **Spin-off** |
| Cloud sandboxes (E2B/Modal) | Contradicts local-first identity | **Spin-off** |
| MOQT / UI resources | Watch, don't build | Out |

---

## 3. Prioritized Roadmap

### Tier 1 — Fix Now (security, correctness, test integrity)
1. **Escape all config-supplied values interpolated into Seatbelt profiles and Docker mount args** (`settings.ts`, `target-manager.ts`). Reject or quote `"`/`)`/newlines in paths. *Sandbox-escape class.*
2. **Make the network proxy enforce policy** (or rename the feature honestly). Consult `isNetworkAllowed` in `proxy-audit.ts`; block/deny per domain; return a clean error. Close the docs-vs-behavior gap.
3. **Sanitize all server-sourced text before printing** — a real control-sequence stripper applied to tool names/descriptions/results/notifications and the banner (`repl/*`, `ui.ts`).
4. **Restore `process.env` after connect** in `server.ts` (snapshot/restore like `validate` does).
5. **Fix sandbox test integrity:** convert silent early-returns to `it.skip` with a visible reason; **wire the vulnerable fixtures into real enforcement tests** (read/write/net/exec denial). Otherwise CI is green theater.
6. **Bug fixes:** lowercased bare-tool-name dispatch (`parsing.ts:19` vs `commands.ts:247`); `--clear` stripping before JSON parse (`commands.ts:369`); `splitArgs` dropping backslashes (breaks Windows paths); keypress-listener leak (`index.ts:65`); `view` shell `exec` → `execFile`.
7. **Session daemon:** forward `--allow-*/--deny-*` to the daemon; add a per-session token or restrict socket; document the local-trust boundary.
8. **Docs drift:** AGENTS.md bundle-size claim (~25KB/11KB) is actually ~361KB; `update-schema.js` fallback pinned to a stale 2024-11-05 spec and a renamed repo URL; declare `@microsoft/mxc-sdk` as an `optionalDependency`.

### Tier 2 — Build Next (high-impact, fits today's architecture)
1. **Record & replay** — cassettes + snapshot assertions. Cleanest fit for the test identity; unlocks deterministic agent tests.
2. **Programmable interceptor plugins** *(the linchpin)* — turn the pipeline into ordered middleware with a small hook API (on-tools-list, on-tool-result, on-resource). Substrate for the security extension, the facade mode, and the eventual library. Prioritize early.
3. **Tool-poisoning scanner** as the first bundled plugin.
4. **DLP/redaction interceptor** as the second plugin.
5. **Structured JSONL audit log** — every request/response/interception decision.
6. **Streamable HTTP transport** — replace/augment the deprecated SSE path.
7. **Test hardening** — mock server gains sampling/elicitation/pagination/subscriptions; add `repl/`, `snapshot.ts`, `config-scanner.ts`, `watcher.ts` unit tests.

### Tier 3 — Strategic Bets (could redefine run-mcp)
1. **Context-firewall / lazy-schema facade** *(chosen bet — greenlit to prototype/validate)* — the Tools Tax play. Biggest impact; consciously moves run-mcp onto the production path. Gate full commitment on measured token reduction + no correctness regressions against real servers.
2. **MCP multiplexer/aggregator** — compose many servers behind one namespaced facade.
3. **Importable middleware library** — waits behind Tier 2 #2; ship only once the plugin framework has a real external consumer.
4. **Eval/CI harness.**

### Tier 4 — New Projects (valuable but scope creep)
1. **Enterprise MCP gateway** — OAuth 2.1/PKCE, RBAC, JWT validation, remote topology. Different product, different buyer; Kong/TrueFoundry already here.
2. **Cloud sandbox execution** (E2B/Modal-style) — contradicts run-mcp's local-first, zero-daemon identity.
3. **"Always-on MCP context proxy"** — the maximal facade+scanner+DLP+audit product; a rename/spin-off, not a run-mcp mode.

---

## 4. Strategic decisions (locked via interview)
1. **Identity → Both, staged.** Ship test-tool improvements now (Tier 1+2); treat the runtime-interceptor direction as an explicit Tier 3 bet to validate before fully committing. Interceptor-as-product is the destination, reached deliberately.
2. **Context bloat → run-mcp facade mode.** Build the lazy-schema facade as a run-mcp mode. Chosen Tier 3 strategic bet. The always-on spin-off is deferred, not chosen.
3. **Security → Fix then extend.** Land the Tier 1 sandbox fixes (bugs regardless of direction), then build interceptor-layer security (injection-scan + DLP + audit) on top.
4. **Library → Later, gated on the interceptor.** Build the middleware plugin framework first; the library is a thin wrapper that falls out of it.

---

## 5. Verification (for whatever we build first)
- **Tier 1 security fixes:** point real sandbox enforcement tests at `vulnerable-stdio-server.ts` — assert `exploit_file_read ~/.ssh/id_rsa`, `exploit_network`, `exploit_spawn`, and `exploit_file_write` are all denied under `native`/`docker`; assert profile injection via a crafted `.run-mcp/settings.json` path does not escape. Add a test that a hostile tool name/description with OSC 52 bytes is stripped before print.
- **Network enforcement:** with `--allow-net example.com`, assert a request to `evil.com` through the proxy is blocked and logged.
- **env restore:** connect with `env:{SECRET:x}`, disconnect, connect a second server, assert `SECRET` is not present.
- **Manual REPL drive** (per AGENTS.md): `npm run start -- -- node --import tsx tests/fixtures/mock-server.ts`, exercise touched flows.
- Run `npm test`, `npm run typecheck`, `npm run lint` before commit (pre-commit hook enforces).
