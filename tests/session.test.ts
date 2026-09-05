import { describe, expect, it } from "vitest";
import {
  assertValidSessionName,
  describeSessionMismatch,
  formatUptime,
  getSocketPath,
  SESSION_DIR,
  SessionError,
} from "../src/session.js";

/**
 * Unit tests for the pure parts of the session module. The daemon itself is
 * exercised end to end in tests/headless.test.ts.
 */

const running = {
  command: ["node", "server.js"],
  cwd: "/proj/a",
  env: { API_KEY: "one" },
};

describe("describeSessionMismatch", () => {
  it("accepts attaching with no command and no env", () => {
    expect(describeSessionMismatch("dev", running, { cwd: "/elsewhere" })).toBeNull();
  });

  it("accepts the same command from the same directory with the same env", () => {
    expect(
      describeSessionMismatch("dev", running, {
        command: ["node", "server.js"],
        cwd: "/proj/a",
        env: { API_KEY: "one" },
      }),
    ).toBeNull();
  });

  it("refuses a different command, showing both", () => {
    const msg = describeSessionMismatch("dev", running, {
      command: ["node", "other.js"],
      cwd: "/proj/a",
    });
    expect(msg).toContain('Session "dev" is already running a different server.');
    expect(msg).toContain("running: node server.js  (in /proj/a)");
    expect(msg).toContain("asked:   node other.js  (in /proj/a)");
    expect(msg).toContain("close-session dev");
  });

  it("refuses the same relative command from a different directory", () => {
    const msg = describeSessionMismatch("dev", running, {
      command: ["node", "server.js"],
      cwd: "/proj/b",
    });
    expect(msg).toContain("(in /proj/b)");
  });

  it("refuses a different env, naming the keys but never the values", () => {
    const msg = describeSessionMismatch("dev", running, {
      cwd: "/proj/a",
      env: { API_KEY: "two", EXTRA: "x" },
    });
    expect(msg).toContain("env differs for: API_KEY, EXTRA");
    expect(msg).not.toContain("one");
    expect(msg).not.toContain("two");
  });

  it("treats a session recorded without env as empty env", () => {
    const legacy = { command: ["node", "s.js"], cwd: "/p", env: undefined as any };
    expect(describeSessionMismatch("dev", legacy, { cwd: "/p", env: {} })).toBeNull();
    expect(describeSessionMismatch("dev", legacy, { cwd: "/p", env: { A: "1" } })).toContain(
      "env differs for: A",
    );
  });
});

describe("assertValidSessionName", () => {
  it("accepts ordinary names", () => {
    for (const name of ["dev", "main-2", "proj.v1_x", "A1"]) {
      expect(() => assertValidSessionName(name)).not.toThrow();
    }
  });

  it("rejects names that could escape the session directory or are empty", () => {
    for (const name of ["../x", "a/b", "", ".hidden", "-dash", "with space"]) {
      expect(() => assertValidSessionName(name)).toThrow(SessionError);
    }
    try {
      assertValidSessionName("../x");
    } catch (err: any) {
      expect(err.exitCode).toBe(64);
    }
  });
});

describe("describeSessionMismatch (protocol)", () => {
  it("accepts an attach with no protocol, or the same one, and refuses a different one", () => {
    const modern = { ...running, protocol: "2026-07-28" as const };
    expect(describeSessionMismatch("dev", modern, { cwd: "/proj/a" })).toBeNull();
    expect(
      describeSessionMismatch("dev", modern, { cwd: "/proj/a", protocol: "2026-07-28" }),
    ).toBeNull();
    const msg = describeSessionMismatch("dev", modern, { cwd: "/proj/a", protocol: "legacy" });
    expect(msg).toContain("running protocol: 2026-07-28");
    expect(msg).toContain("asked protocol:   legacy");
    // A session recorded before protocols existed is a legacy session.
    expect(
      describeSessionMismatch("dev", running, { cwd: "/proj/a", protocol: "legacy" }),
    ).toBeNull();
    expect(describeSessionMismatch("dev", running, { cwd: "/proj/a", protocol: "auto" })).toContain(
      "running protocol: legacy",
    );
  });
});

describe("getSocketPath", () => {
  it("lives inside the owner-only session directory (or a named pipe on Windows)", () => {
    const path = getSocketPath("dev");
    if (process.platform === "win32") {
      expect(path).toBe("\\\\.\\pipe\\run-mcp-dev");
    } else {
      expect(path.startsWith(SESSION_DIR)).toBe(true);
      expect(path.endsWith("dev.sock")).toBe(true);
    }
  });

  it("keeps Unix socket paths under the platform limit for long names", () => {
    const path = getSocketPath("x".repeat(200));
    if (process.platform !== "win32") {
      expect(path.length).toBeLessThanOrEqual(96);
      expect(path.startsWith(SESSION_DIR)).toBe(true);
    }
    // Deterministic: the daemon and its clients must agree.
    expect(getSocketPath("x".repeat(200))).toBe(path);
  });
});

describe("formatUptime", () => {
  it("picks the coarsest useful unit", () => {
    expect(formatUptime(3_000)).toBe("3s");
    expect(formatUptime(180_000)).toBe("3m");
    expect(formatUptime(3_600_000)).toBe("1h");
    expect(formatUptime(5_400_000)).toBe("1h 30m");
  });
});
