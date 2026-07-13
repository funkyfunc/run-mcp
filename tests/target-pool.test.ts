import { afterEach, describe, expect, it } from "vitest";
import { TargetPool } from "../src/target-pool.js";
import { MOCK_SERVER_ARGS, MOCK_SERVER_CMD } from "./helpers.js";

let pool: TargetPool | null = null;

afterEach(async () => {
  await pool?.close();
  pool = null;
});

describe("TargetPool", () => {
  it("assigns unique, normalized prefixes (collision-safe)", () => {
    pool = new TargetPool([
      { name: "Best Browser!", command: "node", args: [] },
      { name: "best-browser", command: "node", args: [] }, // normalizes to the same value
    ]);
    const prefixes = pool.servers.map((s) => s.prefix);
    expect(prefixes[0]).toBe("best_browser");
    expect(prefixes[1]).toBe("best_browser_2"); // de-duplicated
    expect(new Set(prefixes).size).toBe(2);
  });

  it("connects backends and isolates a failing one", async () => {
    pool = new TargetPool([
      { name: "good", command: MOCK_SERVER_CMD, args: MOCK_SERVER_ARGS },
      { name: "bad", command: "node", args: ["-e", "process.exit(1)"] },
    ]);
    await pool.connectAll();

    const connected = pool.connectedServers();
    expect(connected.map((s) => s.name)).toEqual(["good"]);
    // The bad backend is recorded with an error, not thrown.
    const bad = pool.servers.find((s) => s.name === "bad")!;
    expect(bad.connected).toBe(false);
    expect(bad.error).toBeTruthy();
  }, 15_000);

  it("resolves a server by prefix", async () => {
    pool = new TargetPool([{ name: "alpha", command: MOCK_SERVER_CMD, args: MOCK_SERVER_ARGS }]);
    await pool.connectAll();
    expect(pool.serverByPrefix("alpha")?.name).toBe("alpha");
    expect(pool.serverByPrefix("nope")).toBeUndefined();
  }, 15_000);
});
