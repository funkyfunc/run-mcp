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
  fitCatalogLevel,
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
  it("does not truncate at versions, URLs, or abbreviations", () => {
    expect(firstSentence("Query the v1.2 API for records")).toBe("Query the v1.2 API for records");
    expect(firstSentence("Fetch https://example.com/x.json and parse it")).toBe(
      "Fetch https://example.com/x.json and parse it",
    );
    expect(firstSentence("Search items (e.g. issues, PRs) by keyword. Slow.")).toBe(
      "Search items (e.g. issues, PRs) by keyword",
    );
    expect(firstSentence("Lists files, dirs, etc. from the root. Recursive.")).toBe(
      "Lists files, dirs, etc. from the root",
    );
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
  it("collapses underscore runs so prefixes never contain the __ separator", () => {
    expect(normalizeServerName("my__server")).toBe("my_server");
    expect(normalizeServerName("a - b")).toBe("a_b");
    expect(normalizeServerName("___")).toBe("tools");
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

describe("fitCatalogLevel", () => {
  const bigTools: BackendTool[] = Array.from({ length: 40 }, (_, i) => ({
    name: `tool_${i}`,
    description: "x".repeat(200) + ". More detail follows here.",
    inputSchema: { type: "object", properties: { a: { type: "string" } } },
  }));

  it("keeps the requested level when the catalog fits", () => {
    const { level, escalated } = fitCatalogLevel(bigTools.slice(0, 2), "medium");
    expect(level).toBe("medium");
    expect(escalated).toBe(false);
  });

  it("escalates until the catalog fits under the ceiling", () => {
    const { level, escalated } = fitCatalogLevel(bigTools, "low", 500);
    expect(escalated).toBe(true);
    expect(level).toBe("max");
  });

  it("stops escalating once a level fits", () => {
    // High (names+args only) fits in 4KB for 40 small tools; max not needed.
    const { level } = fitCatalogLevel(bigTools, "low", 4000);
    expect(level).toBe("high");
  });
});
