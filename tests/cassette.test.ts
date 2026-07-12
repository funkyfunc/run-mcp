import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cassette, stableStringify } from "../src/cassette.js";
import { ResponseInterceptor } from "../src/interceptor.js";

let cassettePath: string | null = null;
function tmpCassette(): string {
  cassettePath = join(
    tmpdir(),
    `run-mcp-cassette-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  return cassettePath;
}

afterEach(() => {
  if (cassettePath && existsSync(cassettePath)) rmSync(cassettePath, { force: true });
  cassettePath = null;
});

function mockTarget(response: Record<string, unknown>) {
  return { callTool: vi.fn().mockResolvedValue(response) } as any;
}

describe("stableStringify", () => {
  it("is independent of object key order", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(stableStringify({ a: { y: 1, x: 2 } })).toBe(stableStringify({ a: { x: 2, y: 1 } }));
  });
});

describe("Cassette", () => {
  it("records and matches by (primitive, name, args), order-independent", () => {
    const c = new Cassette(tmpCassette(), "auto");
    c.record("tool", "echo", { a: 1, b: 2 }, { content: [{ type: "text", text: "hi" }] }, "t0");

    expect(c.match("tool", "echo", { b: 2, a: 1 })?.result).toEqual({
      content: [{ type: "text", text: "hi" }],
    });
    expect(c.match("tool", "echo", { a: 9 })).toBeUndefined();
  });

  it("persists to disk and reloads", () => {
    const path = tmpCassette();
    const c1 = new Cassette(path, "auto");
    c1.record("tool", "greet", { name: "Ada" }, { content: [] }, "t0");
    expect(existsSync(path)).toBe(true);

    const c2 = new Cassette(path, "replay");
    expect(c2.match("tool", "greet", { name: "Ada" })).toBeDefined();
    expect(c2.size).toBe(1);
  });

  it("record mode always misses (forces re-record); replay mode never records", () => {
    const path = tmpCassette();
    const rec = new Cassette(path, "record");
    rec.record("tool", "x", {}, { content: [{ type: "text", text: "v1" }] }, "t0");
    // record mode: match returns undefined even though an entry exists
    expect(rec.match("tool", "x", {})).toBeUndefined();

    const rep = new Cassette(path, "replay");
    rep.record("tool", "x", {}, { content: [{ type: "text", text: "v2" }] }, "t1");
    // replay mode did not overwrite the recorded value
    expect(rep.match("tool", "x", {})?.result).toEqual({
      content: [{ type: "text", text: "v1" }],
    });
  });
});

describe("interceptor with cassette", () => {
  it("records on first call and replays on the second without hitting the target", async () => {
    const path = tmpCassette();
    const response = { content: [{ type: "text", text: "live" }] };
    const target = mockTarget(response);

    const rec = new ResponseInterceptor({ cassette: new Cassette(path, "auto") });
    const first = await rec.callTool(target, "echo", { text: "hi" });
    expect(first).toEqual(response);
    expect(target.callTool).toHaveBeenCalledTimes(1);

    // A fresh interceptor in replay mode should serve from disk, no target call.
    const replayTarget = mockTarget({ content: [{ type: "text", text: "SHOULD NOT APPEAR" }] });
    const rep = new ResponseInterceptor({ cassette: new Cassette(path, "replay") });
    const second = await rep.callTool(replayTarget, "echo", { text: "hi" });
    expect(second).toEqual(response);
    expect(replayTarget.callTool).not.toHaveBeenCalled();
  });

  it("throws a helpful error on a replay miss", async () => {
    const rep = new ResponseInterceptor({ cassette: new Cassette(tmpCassette(), "replay") });
    const target = mockTarget({ content: [] });
    await expect(rep.callTool(target, "missing", {})).rejects.toThrow(/No cassette recording/);
    expect(target.callTool).not.toHaveBeenCalled();
  });
});
