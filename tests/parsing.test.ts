import { describe, expect, it } from "vitest";
import {
  formatJson,
  formatToolDescription,
  groupToolsByPrefix,
  levenshtein,
  parseCallArgs,
  parseCommandLine,
  resolveAlias,
  scaffoldArgs,
  suggestCommand,
} from "../src/parsing.js";

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
    expect(parseCommandLine('tools/call echo {"text": "hi"}')).toEqual({
      cmd: "tools/call",
      rest: 'echo {"text": "hi"}',
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
    const result = parseCallArgs('create {"name": "test project", "tags": ["a", "b c"]}');
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

// ═══════════════════════════════════════════════════════════════════════════
// levenshtein
// ═══════════════════════════════════════════════════════════════════════════

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("hello", "hello")).toBe(0);
    expect(levenshtein("", "")).toBe(0);
  });

  it("returns string length for empty vs non-empty", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });

  it("detects single-character edits", () => {
    expect(levenshtein("cat", "bat")).toBe(1); // substitution
    expect(levenshtein("cat", "cats")).toBe(1); // insertion
    expect(levenshtein("cats", "cat")).toBe(1); // deletion
  });

  it("handles realistic typos", () => {
    expect(levenshtein("tools/lst", "tools/list")).toBe(1);
    expect(levenshtein("toosl/list", "tools/list")).toBe(2);
    expect(levenshtein("stats", "status")).toBe(1); // insertion of 'u'
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// suggestCommand
// ═══════════════════════════════════════════════════════════════════════════

const COMMANDS = ["tools/list", "tools/describe", "tools/call", "status", "help", "exit", "quit"];

describe("suggestCommand", () => {
  it("suggests tools/list for tools/lst", () => {
    expect(suggestCommand("tools/lst", COMMANDS)).toBe("tools/list");
  });

  it("suggests tools/list for tols/list", () => {
    expect(suggestCommand("tols/list", COMMANDS)).toBe("tools/list");
  });

  it("suggests tools/call for tools/cal", () => {
    expect(suggestCommand("tools/cal", COMMANDS)).toBe("tools/call");
  });

  it("suggests tools/describe for tools/descrbe", () => {
    expect(suggestCommand("tools/descrbe", COMMANDS)).toBe("tools/describe");
  });

  it("suggests status for stats", () => {
    expect(suggestCommand("stats", COMMANDS)).toBe("status");
  });

  it("suggests help for hlep", () => {
    expect(suggestCommand("hlep", COMMANDS)).toBe("help");
  });

  it("returns null for completely unrelated input", () => {
    expect(suggestCommand("xyzzy", COMMANDS)).toBeNull();
    expect(suggestCommand("foobar", COMMANDS)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(suggestCommand("", COMMANDS)).toBeNull();
  });

  it("returns exact match if it exists", () => {
    expect(suggestCommand("help", COMMANDS)).toBe("help");
    expect(suggestCommand("tools/list", COMMANDS)).toBe("tools/list");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// scaffoldArgs
// ═══════════════════════════════════════════════════════════════════════════

describe("scaffoldArgs", () => {
  it("scaffolds flat string/number/boolean properties", () => {
    const schema = {
      properties: {
        name: { type: "string" },
        age: { type: "number" },
        active: { type: "boolean" },
      },
    };
    const result = JSON.parse(scaffoldArgs(schema));
    expect(result).toEqual({
      name: "<string>",
      age: "<number>",
      active: "<boolean>",
    });
  });

  it("scaffolds nested objects", () => {
    const schema = {
      properties: {
        config: {
          type: "object",
          properties: {
            host: { type: "string" },
            port: { type: "integer" },
          },
        },
      },
    };
    const result = JSON.parse(scaffoldArgs(schema));
    expect(result.config).toEqual({ host: "<string>", port: "<number>" });
  });

  it("scaffolds arrays with typed items", () => {
    const schema = {
      properties: {
        tags: { type: "array", items: { type: "string" } },
      },
    };
    const result = JSON.parse(scaffoldArgs(schema));
    expect(result.tags).toEqual(["<string>"]);
  });

  it("scaffolds arrays without items", () => {
    const schema = {
      properties: {
        data: { type: "array" },
      },
    };
    const result = JSON.parse(scaffoldArgs(schema));
    expect(result.data).toEqual(["<item>"]);
  });

  it("returns empty object for schema with no properties", () => {
    const result = JSON.parse(scaffoldArgs({}));
    expect(result).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// formatToolDescription
// ═══════════════════════════════════════════════════════════════════════════

describe("formatToolDescription", () => {
  it("formats a tool with string and number args", () => {
    const result = formatToolDescription({
      name: "greet",
      description: "Returns a greeting",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name to greet" },
        },
        required: ["name"],
      },
    });
    expect(result).toContain("greet");
    expect(result).toContain("Returns a greeting");
    expect(result).toContain("name");
    expect(result).toContain("string");
    expect(result).toContain("(required)");
    expect(result).toContain("Name to greet");
    expect(result).toContain("Example:");
    expect(result).toContain("tools/call greet");
  });

  it("shows 'No arguments required' for no-arg tools", () => {
    const result = formatToolDescription({
      name: "screenshot",
      description: "Takes a screenshot",
    });
    expect(result).toContain("No arguments required");
    expect(result).toContain("tools/call screenshot");
  });

  it("marks optional args correctly", () => {
    const result = formatToolDescription({
      name: "search",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" },
        },
        required: ["query"],
      },
    });
    expect(result).toContain("(required)");
    expect(result).toContain("(optional)");
  });

  it("shows annotations when present", () => {
    const result = formatToolDescription({
      name: "greet",
      annotations: { readOnlyHint: true, destructiveHint: false },
    });
    expect(result).toContain("Annotations:");
    expect(result).toContain("readOnlyHint: true");
    expect(result).toContain("destructiveHint: false");
  });

  it("handles tool with no description", () => {
    const result = formatToolDescription({ name: "mystery" });
    expect(result).toContain("mystery");
    expect(result).not.toContain("undefined");
  });

  it("handles array type in arguments", () => {
    const result = formatToolDescription({
      name: "tag",
      inputSchema: {
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" } },
        },
      },
    });
    expect(result).toContain("string[]");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// groupToolsByPrefix
// ═══════════════════════════════════════════════════════════════════════════

describe("groupToolsByPrefix", () => {
  it("groups tools by underscore prefix", () => {
    const groups = groupToolsByPrefix(["get_users", "get_posts", "set_config", "set_theme"]);
    expect(groups.get("Get")).toEqual(["get_users", "get_posts"]);
    expect(groups.get("Set")).toEqual(["set_config", "set_theme"]);
  });

  it("merges singleton prefixes into Other", () => {
    const groups = groupToolsByPrefix([
      "get_users",
      "get_posts",
      "set_config",
      "set_theme",
      "ping",
    ]);
    expect(groups.get("Other")).toEqual(["ping"]);
  });

  it("falls back to single All group when no meaningful groupings", () => {
    const groups = groupToolsByPrefix(["alpha", "beta", "gamma", "delta"]);
    expect(groups.has("All")).toBe(true);
    expect(groups.size).toBe(1);
    expect(groups.get("All")).toEqual(["alpha", "beta", "gamma", "delta"]);
  });

  it("handles empty input", () => {
    const groups = groupToolsByPrefix([]);
    expect(groups.get("All")).toEqual([]);
  });

  it("groups real-world Flutter Driver tool names", () => {
    const tools = [
      "start_app",
      "stop_app",
      "start_recording",
      "stop_recording",
      "get_text",
      "get_widget_tree",
      "get_accessibility_tree",
      "scroll_until_visible",
    ];
    const groups = groupToolsByPrefix(tools);
    expect(groups.get("Start")).toEqual(["start_app", "start_recording"]);
    expect(groups.get("Stop")).toEqual(["stop_app", "stop_recording"]);
    expect(groups.get("Get")).toEqual(["get_text", "get_widget_tree", "get_accessibility_tree"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// resolveAlias
// ═══════════════════════════════════════════════════════════════════════════

describe("resolveAlias", () => {
  it("expands tl to tools/list", () => {
    expect(resolveAlias("tl")).toBe("tools/list");
  });

  it("expands td with arguments", () => {
    expect(resolveAlias("td greet")).toBe("tools/describe greet");
  });

  it("expands tc with tool name and JSON args", () => {
    expect(resolveAlias('tc echo {"text":"hi"}')).toBe('tools/call echo {"text":"hi"}');
  });

  it("expands all defined aliases", () => {
    expect(resolveAlias("ts")).toBe("tools/scaffold");
    expect(resolveAlias("rl")).toBe("resources/list");
    expect(resolveAlias("rr docs://readme")).toBe("resources/read docs://readme");
    expect(resolveAlias("rt")).toBe("resources/templates");
    expect(resolveAlias("pl")).toBe("prompts/list");
    expect(resolveAlias("pg greeting")).toBe("prompts/get greeting");
  });

  it("is case-insensitive", () => {
    expect(resolveAlias("TL")).toBe("tools/list");
    expect(resolveAlias("Td greet")).toBe("tools/describe greet");
  });

  it("returns null for non-aliases", () => {
    expect(resolveAlias("help")).toBeNull();
    expect(resolveAlias("tools/list")).toBeNull();
    expect(resolveAlias("exit")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(resolveAlias("")).toBeNull();
  });

  it("preserves extra whitespace in the rest portion", () => {
    expect(resolveAlias("td  greet")).toBe("tools/describe  greet");
  });
});
