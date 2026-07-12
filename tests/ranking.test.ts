import { describe, it, expect } from "vitest";
import { tokenize, rankTools } from "../src/ranking.js";

const TOOLS = [
  { name: "echo", description: "Return the input text unchanged" },
  { name: "screenshot", description: "Capture an image of the current screen" },
  { name: "greet", description: "Say hello to a person by name" },
  { name: "list_files", description: "List files in a directory" },
];

describe("tokenize", () => {
  it("lowercases, splits, drops stopwords and short tokens", () => {
    expect(tokenize("Take a Screenshot of the screen")).toEqual(["take", "screenshot", "screen"]);
  });
});

describe("rankTools", () => {
  it("ranks the most relevant tool first", () => {
    const ranked = rankTools("take a screenshot of the screen", TOOLS);
    expect(ranked[0].tool.name).toBe("screenshot");
  });

  it("matches on description keywords", () => {
    const ranked = rankTools("say hello", TOOLS);
    expect(ranked[0].tool.name).toBe("greet");
  });

  it("returns only positive-scoring tools for a specific query", () => {
    const ranked = rankTools("screenshot", TOOLS);
    expect(ranked.every((r) => r.score > 0)).toBe(true);
    expect(ranked.map((r) => r.tool.name)).toContain("screenshot");
    expect(ranked.map((r) => r.tool.name)).not.toContain("echo");
  });

  it("respects the limit", () => {
    const ranked = rankTools("list files directory", TOOLS, 1);
    expect(ranked).toHaveLength(1);
  });

  it("returns the first N unranked when the query is empty", () => {
    const ranked = rankTools("   ", TOOLS, 2);
    expect(ranked).toHaveLength(2);
    expect(ranked.every((r) => r.score === 0)).toBe(true);
  });
});
