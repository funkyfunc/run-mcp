import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { TargetManager } from "../src/target-manager.js";
import { VULN_SERVER_ARGS, VULN_SERVER_CMD } from "./helpers.js";

/**
 * Real sandbox ENFORCEMENT tests, pointed at the deliberately-hostile
 * `vulnerable-stdio-server` fixture (arbitrary file read/write, network, exec).
 *
 * Unlike the mock-server sandbox tests in target-manager.test.ts (which carry an
 * execSync mock and skip silently), this file:
 *   - detects the real OS sandbox tool without any mock, and
 *   - uses `describe.skipIf` so an unavailable sandbox is reported as SKIPPED,
 *     never as a vacuous pass.
 */

function hasBinary(bin: string): boolean {
  return spawnSync(`command -v ${bin}`, { shell: true, stdio: "ignore" }).status === 0;
}

function detectNativeSandbox(): { available: boolean; reason: string } {
  if (process.platform === "darwin") {
    return { available: hasBinary("sandbox-exec"), reason: "sandbox-exec not found" };
  }
  if (process.platform === "linux") {
    return { available: hasBinary("bwrap"), reason: "bwrap not found" };
  }
  return { available: false, reason: `native sandbox unsupported on ${process.platform}` };
}

const { available, reason } = detectNativeSandbox();
if (!available) {
  // Make the skip loud so nobody mistakes a missing sandbox for a passing suite.
  console.warn(`[sandbox-enforcement] SKIPPING native enforcement tests: ${reason}`);
}

let target: TargetManager | null = null;
afterEach(async () => {
  if (target) {
    await target.close();
    target = null;
  }
});

describe.skipIf(!available)("native sandbox blocks a hostile server", () => {
  it("denies outbound network when no --allow-net is granted", async () => {
    target = new TargetManager(VULN_SERVER_CMD, VULN_SERVER_ARGS, { sandbox: "native" });
    await target.connect();

    const res: any = await target.callTool("exploit_network", { url: "http://example.com" });
    const text = JSON.stringify(res.content);
    // The tool reports FAILED on a blocked connection; either an explicit error
    // flag or a non-SUCCESS body proves the network was denied.
    expect(res.isError === true || !text.includes("SUCCESS")).toBe(true);
  }, 20_000);

  it("denies writing a file outside the workspace/tmp sandbox", async () => {
    target = new TargetManager(VULN_SERVER_CMD, VULN_SERVER_ARGS, { sandbox: "native" });
    await target.connect();

    const forbidden = join(homedir(), "run-mcp-sandbox-canary-should-not-exist.txt");
    const res: any = await target.callTool("exploit_file_write", {
      path: forbidden,
      content: "escaped",
    });
    const text = JSON.stringify(res.content);
    expect(res.isError === true || !text.includes("SUCCESS")).toBe(true);
  }, 20_000);
});
