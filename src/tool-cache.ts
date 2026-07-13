/**
 * Cached backend tool list for the compressing proxy.
 *
 * Without a cache the proxy re-fetches `tools/list` from the backend on every
 * `get_tool_schema` / `invoke_tool` / `find_tools` call — doubling per-call
 * round trips and, for HTTP backends, burning user-visible latency and rate
 * limits. The cache is invalidated by the backend's `tools/list_changed`
 * notification (the honest signal) with a TTL fallback for servers that never
 * emit it. Concurrent fetches are coalesced; a failed refresh serves the last
 * known catalog rather than erroring the request path.
 */

const DEFAULT_TTL_MS = 30_000;

export class ToolListCache<T = unknown> {
  private cached: T[] | null = null;
  private fetchedAt = 0;
  private pending: Promise<T[]> | null = null;

  constructor(
    private readonly fetchTools: () => Promise<T[]>,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  /** Drop the cached list; the next get() fetches fresh. */
  invalidate(): void {
    this.cached = null;
  }

  /** Invalidate and fetch fresh immediately. */
  async refresh(): Promise<T[]> {
    this.invalidate();
    return this.get();
  }

  /** The cached tool list, fetching (once) if missing or past its TTL. */
  async get(): Promise<T[]> {
    if (this.cached && Date.now() - this.fetchedAt < this.ttlMs) return this.cached;
    if (this.pending) return this.pending;
    const stale = this.cached;
    this.pending = this.fetchTools()
      .then((tools) => {
        this.cached = tools;
        this.fetchedAt = Date.now();
        return tools;
      })
      .catch((err) => {
        // A transient backend hiccup shouldn't fail discovery when we still
        // have a catalog from moments ago.
        if (stale) return stale;
        throw err;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
}
