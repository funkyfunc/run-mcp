import { describe, it, expect } from "vitest";
import {
  toolSignature,
  firstSentence,
  formatCatalogEntry,
  buildCatalog,
  getToolSchemaDescription,
  formatSchemaResponse,
  flattenToolResult,
  coerceStructuredArgs,
  normalizeServerName,
  applyToolFilters,
  type BackendTool,
} from "../src/compression.js";

const echo: BackendTool = {
  name: "echo",
  description: "Echo a message. Returns it unchanged.",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
};
const add: BackendTool = {
  name: "add",
  description: "Add two integers",
  inputSchema: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } } },
};

describe("toolSignature / firstSentence", () => {
  it("builds name(args) from schema property keys", () => {
    expect(toolSignature(echo)).toBe("echo(message)");
    expect(toolSignature(add)).toBe("add(a, b)");
    expect(toolSignature({ name: "noargs" })).toBe("noargs()");
  });
  it("takes the first sentence up to the first period", () => {
    expect(firstSentence("Echo a message. Returns it unchanged.")).toBe("Echo a message");
    expect(firstSentence("No period here")).toBe("No period here");
  });
});

describe("formatCatalogEntry by level", () => {
  it("low: full description", () => {
    expect(formatCatalogEntry(echo, "low")).toBe(
      "<tool>echo(message): Echo a message. Returns it unchanged.</tool>",
    );
  });
  it("medium: first sentence", () => {
    expect(formatCatalogEntry(echo, "medium")).toBe("<tool>echo(message): Echo a message</tool>");
  });
  it("high: signature only", () => {
    expect(formatCatalogEntry(echo, "high")).toBe("<tool>echo(message)</tool>");
  });
  it("max: name only", () => {
    expect(formatCatalogEntry(echo, "max")).toBe("<tool>echo</tool>");
  });
});

describe("getToolSchemaDescription", () => {
  it("embeds the catalog at low/medium/high", () => {
    const d = getToolSchemaDescription([echo, add], "medium");
    expect(d).toContain("Available tools:");
    expect(d).toContain("<tool>echo(message): Echo a message</tool>");
    expect(d).toContain("<tool>add(a, b): Add two integers</tool>");
  });
  it("withholds the catalog at max (defers to list_tools)", () => {
    const d = getToolSchemaDescription([echo, add], "max");
    expect(d).toContain("list_tools");
    expect(d).not.toContain("<tool>");
  });
});

describe("formatSchemaResponse", () => {
  it("returns the tool header + full JSON schema", () => {
    const out = formatSchemaResponse(echo);
    expect(out).toContain("<tool>echo(message): Echo a message. Returns it unchanged.</tool>");
    expect(JSON.parse(out.slice(out.indexOf("{")))).toEqual(echo.inputSchema);
  });
});

describe("flattenToolResult", () => {
  it("joins MCP text content parts", () => {
    expect(
      flattenToolResult({
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("a\nb");
  });
  it("unwraps a lone { result }", () => {
    expect(flattenToolResult({ result: "hi" })).toBe("hi");
  });
  it("passes through strings and JSON-stringifies other objects", () => {
    expect(flattenToolResult("plain")).toBe("plain");
    expect(flattenToolResult({ a: 1 })).toBe('{"a":1}');
  });
});

describe("coerceStructuredArgs", () => {
  it("parses JSON strings for object/array-typed args", () => {
    const schema = {
      type: "object",
      properties: { items: { type: "array" }, name: { type: "string" } },
    };
    const out = coerceStructuredArgs(schema, { items: "[1,2]", name: "keep" });
    expect(out.items).toEqual([1, 2]);
    expect(out.name).toBe("keep"); // strings left alone
  });
  it("leaves invalid JSON strings untouched", () => {
    const schema = { type: "object", properties: { items: { type: "array" } } };
    expect(coerceStructuredArgs(schema, { items: "[not json" }).items).toBe("[not json");
  });
});

describe("normalizeServerName / applyToolFilters", () => {
  it("normalizes names to a safe prefix", () => {
    expect(normalizeServerName("My Server!")).toBe("my_server");
    expect(normalizeServerName(undefined)).toBe("tools");
  });
  it("applies include then exclude filters", () => {
    const tools = [echo, add, { name: "danger" }];
    expect(applyToolFilters(tools, { include: ["echo", "add"] }).map((t) => t.name)).toEqual([
      "echo",
      "add",
    ]);
    expect(applyToolFilters(tools, { exclude: ["danger"] }).map((t) => t.name)).toEqual([
      "echo",
      "add",
    ]);
  });
});

describe("buildCatalog", () => {
  it("newline-joins entries", () => {
    expect(buildCatalog([echo, add], "high")).toBe(
      "<tool>echo(message)</tool>\n<tool>add(a, b)</tool>",
    );
  });
});
