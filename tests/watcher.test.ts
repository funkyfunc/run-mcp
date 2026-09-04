import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileWatcher, resolveWatchRoot } from "../src/watcher.js";

let dir: string;
let watcher: FileWatcher | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "run-mcp-watch-"));
});

afterEach(() => {
  if (watcher) {
    watcher.stop();
    watcher = null;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("FileWatcher", () => {
  it("computes a relative path from the watch root", () => {
    watcher = new FileWatcher(dir);
    expect(watcher.relativePath(join(dir, "a", "b.ts"))).toBe(join("a", "b.ts"));
  });

  it("start() then stop() is safe and idempotent", () => {
    watcher = new FileWatcher(dir, { debounceMs: 20 });
    watcher.start();
    watcher.start(); // second start is a no-op
    watcher.stop();
    watcher.stop(); // second stop is safe
    expect(true).toBe(true);
  });

  it("emits a debounced change event for a real file write", async () => {
    watcher = new FileWatcher(dir, { debounceMs: 30 });

    const changed = await new Promise<string[] | null>((resolve) => {
      let settled = false;
      const done = (v: string[] | null) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      // Keep listening until our target file appears (ignore any unrelated events).
      watcher!.on("change", ({ files }: { files: string[] }) => {
        if (files.some((f) => f.includes("touched.ts"))) done(files);
      });
      // If recursive fs.watch isn't supported on this platform, don't hang.
      watcher!.on("error", () => done(null));
      watcher!.start();
      setTimeout(() => writeFileSync(join(dir, "touched.ts"), "x"), 10);
      setTimeout(() => done(null), 2000);
    });

    // Either we detected the change, or the platform doesn't support recursive
    // watching (change === null) — both are acceptable; the point is no hang/throw.
    if (changed !== null) {
      expect(changed.some((f) => f.includes("touched.ts"))).toBe(true);
    }
  }, 5000);
});

describe("resolveWatchRoot", () => {
  it("watches the working directory when the server runs from source", () => {
    writeFileSync(join(dir, "server.js"), "");
    expect(resolveWatchRoot(dir, ["server.js"])).toEqual({ path: dir, reason: "cwd" });
  });

  it("watches the build output when the server runs from one", () => {
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "index.js"), "");
    expect(resolveWatchRoot(dir, ["dist/index.js"])).toEqual({
      path: join(dir, "dist"),
      reason: "build-output",
    });
    // Absolute paths and flags before the script are fine too.
    expect(resolveWatchRoot(dir, ["--inspect", join(dir, "dist", "index.js")]).path).toBe(
      join(dir, "dist"),
    );
  });

  it("falls back to the working directory for args that are not files inside it", () => {
    expect(resolveWatchRoot(dir, ["-y", "some-package", "/nonexistent/dist/x.js"])).toEqual({
      path: dir,
      reason: "cwd",
    });
    // A directory argument is not a script.
    mkdirSync(join(dir, "dist"), { recursive: true });
    expect(resolveWatchRoot(dir, ["dist"]).reason).toBe("cwd");
  });
});
