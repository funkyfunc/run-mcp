import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../src/audit.js";

let logPath: string | null = null;

afterEach(() => {
  if (logPath && existsSync(logPath)) rmSync(logPath, { force: true });
  logPath = null;
});

describe("AuditLogger", () => {
  it("appends one JSON object per line with ts, seq, and type", () => {
    logPath = join(
      tmpdir(),
      `run-mcp-audit-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
    );
    const logger = new AuditLogger(logPath);

    logger.log("request", { method: "tools/list", durationMs: 5 });
    logger.log("request", { method: "tools/call echo", durationMs: 12, isError: false });

    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    expect(first.type).toBe("request");
    expect(first.seq).toBe(0);
    expect(first.method).toBe("tools/list");
    expect(typeof first.ts).toBe("string");

    const second = JSON.parse(lines[1]);
    expect(second.seq).toBe(1);
    expect(second.method).toBe("tools/call echo");
  });

  it("creates the parent directory if it does not exist", () => {
    const dir = join(
      tmpdir(),
      `run-mcp-audit-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    logPath = join(dir, "nested", "audit.jsonl");
    const logger = new AuditLogger(logPath);
    logger.log("request", { method: "ping" });
    expect(existsSync(logPath)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
