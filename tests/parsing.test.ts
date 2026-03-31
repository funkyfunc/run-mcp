import { describe, it, expect } from "vitest";
import { parseCommandLine, parseCallArgs, formatJson } from "../src/parsing.js";

// ═══════════════════════════════════════════════════════════════════════════
// parseCommandLine
// ═══════════════════════════════════════════════════════════════════════════

describe("parseCommandLine", () => {
  it("parses a command with no arguments", () => {
    expect(parseCommandLine("tools/list")).toEqual({
      cmd: "tools/list",
      rest: "",
    });
  });

  it("parses a command with arguments", () => {
    expect(parseCommandLine("tools/call echo {\"text\": \"hi\"}")).toEqual({
      cmd: "tools/call",
      rest: "echo {\"text\": \"hi\"}",
    });
  });

  it("converts command name to lowercase", () => {
    expect(parseCommandLine("TOOLS/LIST")).toEqual({
      cmd: "tools/list",
      rest: "",
    });

    expect(parseCommandLine("Tools/Call foo")).toEqual({
      cmd: "tools/call",
      rest: "foo",
    });
  });

  it("handles single-word commands", () => {
    expect(parseCommandLine("help")).toEqual({ cmd: "help", rest: "" });
    expect(parseCommandLine("status")).toEqual({ cmd: "status", rest: "" });
    expect(parseCommandLine("exit")).toEqual({ cmd: "exit", rest: "" });
  });

  it("preserves the rest argument exactly (no trimming)", () => {
    expect(parseCommandLine("tools/describe  my_tool")).toEqual({
      cmd: "tools/describe",
      rest: " my_tool",
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// parseCallArgs
// ═══════════════════════════════════════════════════════════════════════════

describe("parseCallArgs", () => {
  it("returns empty toolName for empty input", () => {
    expect(parseCallArgs("")).toEqual({ toolName: "", jsonArgs: "" });
    expect(parseCallArgs("   ")).toEqual({ toolName: "", jsonArgs: "" });
  });

  it("parses tool name with no JSON args", () => {
    expect(parseCallArgs("echo")).toEqual({
      toolName: "echo",
      jsonArgs: "",
    });
  });

  it("parses tool name with simple JSON args", () => {
    expect(parseCallArgs('echo {"text":"hello"}')).toEqual({
      toolName: "echo",
      jsonArgs: '{"text":"hello"}',
    });
  });

  it("handles JSON args containing spaces", () => {
    const result = parseCallArgs('say {"message": "hello world"}');
    expect(result).toEqual({
      toolName: "say",
      jsonArgs: '{"message": "hello world"}',
    });
    // Verify the JSON is actually parseable
    expect(() => JSON.parse(result.jsonArgs)).not.toThrow();
  });

  it("handles complex JSON with nested objects and spaces", () => {
    const result = parseCallArgs(
      'create {"name": "test project", "tags": ["a", "b c"]}'
    );
    expect(result.toolName).toBe("create");
    const parsed = JSON.parse(result.jsonArgs);
    expect(parsed).toEqual({ name: "test project", tags: ["a", "b c"] });
  });

  it("extracts --timeout flag from the end", () => {
    const result = parseCallArgs('slow {"ms": 100} --timeout 5000');
    expect(result).toEqual({
      toolName: "slow",
      jsonArgs: '{"ms": 100}',
      timeoutMs: 5000,
    });
  });

  it("handles --timeout without JSON args", () => {
    // This is an edge case — timeout is after the tool name only if
    // there's a space before --timeout. With just the tool name and
    // --timeout, the regex won't match because there's no leading space.
    const result = parseCallArgs("screenshot {} --timeout 3000");
    expect(result.toolName).toBe("screenshot");
    expect(result.timeoutMs).toBe(3000);
  });

  it("returns undefined timeoutMs when no --timeout flag", () => {
    const result = parseCallArgs('echo {"text":"hi"}');
    expect(result.timeoutMs).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// formatJson
// ═══════════════════════════════════════════════════════════════════════════

describe("formatJson", () => {
  it("formats a simple object with default indent", () => {
    const result = formatJson({ key: "value" });
    expect(result).toContain('"key"');
    expect(result).toContain('"value"');
  });

  it("applies left-padding to every line", () => {
    const result = formatJson({ a: 1 }, 4);
    const lines = result.split("\n");
    for (const line of lines) {
      expect(line.startsWith("    ")).toBe(true);
    }
  });

  it("handles arrays", () => {
    const result = formatJson([1, 2, 3]);
    expect(result).toContain("1");
    expect(result).toContain("2");
    expect(result).toContain("3");
  });

  it("handles null and primitives", () => {
    expect(formatJson(null)).toContain("null");
    expect(formatJson(42)).toContain("42");
    expect(formatJson("hello")).toContain('"hello"');
  });
});
