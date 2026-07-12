import { describe, it, expect } from "vitest";
import {
  hashDefinition,
  computeDiff,
  computeResourceDiff,
  computeResourceTemplateDiff,
  formatDiffLine,
  computeSnapshotDiff,
  type Snapshot,
} from "../src/snapshot.js";

describe("hashDefinition", () => {
  it("is stable for equal objects and differs for changed ones", () => {
    const a = hashDefinition({ description: "x", inputSchema: { type: "object" } });
    const b = hashDefinition({ description: "x", inputSchema: { type: "object" } });
    const c = hashDefinition({ description: "y", inputSchema: { type: "object" } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("computeDiff", () => {
  it("detects added, removed, and modified by hash", () => {
    const prev = [
      { name: "a", hash: "1" },
      { name: "b", hash: "1" },
      { name: "c", hash: "1" },
    ];
    const curr = [
      { name: "a", hash: "1" }, // unchanged
      { name: "b", hash: "2" }, // modified
      { name: "d", hash: "1" }, // added
    ];
    const diff = computeDiff(prev, curr);
    expect(diff.added).toEqual(["d"]);
    expect(diff.modified).toEqual(["b"]);
    expect(diff.removed).toEqual(["c"]);
  });
});

describe("computeResourceDiff / computeResourceTemplateDiff", () => {
  it("diffs resources by uri (presence only)", () => {
    const diff = computeResourceDiff(
      [{ uri: "a", name: "" }],
      [
        { uri: "a", name: "" },
        { uri: "b", name: "" },
      ],
    );
    expect(diff.added).toEqual(["b"]);
    expect(diff.removed).toEqual([]);
  });

  it("diffs templates by uriTemplate", () => {
    const diff = computeResourceTemplateDiff(
      [{ uriTemplate: "x/{a}", name: "" }],
      [{ uriTemplate: "y/{b}", name: "" }],
    );
    expect(diff.added).toEqual(["y/{b}"]);
    expect(diff.removed).toEqual(["x/{a}"]);
  });
});

describe("formatDiffLine", () => {
  it('reports "unchanged" when nothing changed', () => {
    expect(formatDiffLine("Tools", { added: [], removed: [], modified: [] })).toContain(
      "unchanged",
    );
  });

  it("summarizes counts and names when changed", () => {
    const line = formatDiffLine("Tools", { added: ["a"], removed: ["b"], modified: ["c"] });
    expect(line).toContain("+1 added");
    expect(line).toContain("~1 modified");
    expect(line).toContain("-1 removed");
    expect(line).toContain("a");
  });
});

describe("computeSnapshotDiff", () => {
  it("returns a none summary when nothing changed", () => {
    const snap: Snapshot = { tools: [{ name: "a", hash: "1" }] };
    const lines = computeSnapshotDiff(snap, snap);
    expect(lines.join("\n")).toContain("none");
  });

  it("lists tool changes across connections", () => {
    const prev: Snapshot = { tools: [{ name: "a", hash: "1" }] };
    const curr: Snapshot = {
      tools: [
        { name: "a", hash: "2" },
        { name: "b", hash: "1" },
      ],
    };
    const text = computeSnapshotDiff(prev, curr).join("\n");
    expect(text).toContain("Changes since last connection");
    expect(text).toContain("a"); // modified
    expect(text).toContain("b"); // added
  });
});
