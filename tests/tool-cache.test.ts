import { describe, expect, it, vi } from "vitest";
import { ToolListCache } from "../src/tool-cache.js";

const tool = (name: string) => ({ name });

describe("ToolListCache", () => {
  it("fetches once and serves subsequent gets from cache", async () => {
    const fetch = vi.fn().mockResolvedValue([tool("a")]);
    const cache = new ToolListCache(fetch);

    expect(await cache.get()).toEqual([tool("a")]);
    expect(await cache.get()).toEqual([tool("a")]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent gets into a single fetch", async () => {
    let resolveFetch!: (v: { name: string }[]) => void;
    const fetch = vi.fn().mockReturnValue(new Promise((resolve) => (resolveFetch = resolve)));
    const cache = new ToolListCache(fetch);

    const [first, second] = [cache.get(), cache.get()];
    resolveFetch([tool("a")]);
    expect(await first).toEqual([tool("a")]);
    expect(await second).toEqual([tool("a")]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("invalidate() forces the next get to fetch fresh", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce([tool("old")])
      .mockResolvedValueOnce([tool("new")]);
    const cache = new ToolListCache(fetch);

    expect(await cache.get()).toEqual([tool("old")]);
    cache.invalidate();
    expect(await cache.get()).toEqual([tool("new")]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refetches after the TTL expires", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce([tool("old")])
      .mockResolvedValueOnce([tool("new")]);
    const cache = new ToolListCache(fetch, 20);

    expect(await cache.get()).toEqual([tool("old")]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await cache.get()).toEqual([tool("new")]);
  });

  it("serves the last known catalog when a refresh fails", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce([tool("a")])
      .mockRejectedValueOnce(new Error("backend hiccup"));
    const cache = new ToolListCache(fetch, 1);

    expect(await cache.get()).toEqual([tool("a")]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    // TTL expired → refetch fails → stale catalog served, not an error.
    expect(await cache.get()).toEqual([tool("a")]);
  });

  it("propagates a failure when there is no catalog to fall back to", async () => {
    const cache = new ToolListCache(vi.fn().mockRejectedValue(new Error("no backend")));
    await expect(cache.get()).rejects.toThrow("no backend");
  });
});
