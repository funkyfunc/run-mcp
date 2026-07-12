import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shouldEnableColor } from "../src/colors.js";

/**
 * Verifies the color-enable precedence hierarchy:
 *   --color flag > CLICOLOR_FORCE > NO_COLOR > CLICOLOR=0 > isatty.
 */

const savedArgv = process.argv;
const COLOR_ENVS = ["CLICOLOR_FORCE", "NO_COLOR", "CLICOLOR"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of COLOR_ENVS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.argv = ["node", "run-mcp"];
});

afterEach(() => {
  process.argv = savedArgv;
  for (const k of COLOR_ENVS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("shouldEnableColor", () => {
  it("--color=always forces on, even with NO_COLOR set", () => {
    process.env.NO_COLOR = "1";
    process.argv = ["node", "run-mcp", "--color=always"];
    expect(shouldEnableColor()).toBe(true);
  });

  it("--color=never forces off, even with CLICOLOR_FORCE set", () => {
    process.env.CLICOLOR_FORCE = "1";
    process.argv = ["node", "run-mcp", "--color", "never"];
    expect(shouldEnableColor()).toBe(false);
  });

  it("ignores a --color flag that appears after the -- terminator", () => {
    process.env.NO_COLOR = "1";
    process.argv = ["node", "run-mcp", "--", "node", "--color=always"];
    expect(shouldEnableColor()).toBe(false); // NO_COLOR wins; the flag is the target's
  });

  it("CLICOLOR_FORCE (non-zero) beats NO_COLOR", () => {
    process.env.CLICOLOR_FORCE = "1";
    process.env.NO_COLOR = "1";
    expect(shouldEnableColor()).toBe(true);
  });

  it("NO_COLOR disables when no flag/force present", () => {
    process.env.NO_COLOR = "1";
    expect(shouldEnableColor()).toBe(false);
  });

  it("CLICOLOR=0 disables", () => {
    process.env.CLICOLOR = "0";
    expect(shouldEnableColor()).toBe(false);
  });
});
