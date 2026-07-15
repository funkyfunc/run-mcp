import { describe, expect, it } from "vitest";
import { elicitationDecisionFor, samplingDecisionFor } from "../src/repl/approval.js";

describe("samplingDecisionFor", () => {
  it("approves on y/yes (case-insensitive, trimmed) with the fixed approval shape", () => {
    for (const answer of ["y", "Y", "yes", "YES", "  yes  "]) {
      const decision = samplingDecisionFor(answer);
      expect(decision).toEqual({
        kind: "respond",
        result: {
          model: "user-approved",
          role: "assistant",
          content: { type: "text", text: "Approved by user." },
        },
      });
    }
  });

  it("rejects on n/no/empty", () => {
    for (const answer of ["n", "N", "no", "NO", "", "   "]) {
      const decision = samplingDecisionFor(answer);
      expect(decision).toEqual({
        kind: "reject",
        reason: "Sampling request rejected by user",
      });
    }
  });

  it("treats any other text as a user-provided assistant response", () => {
    const decision = samplingDecisionFor("  The answer is 42.  ");
    expect(decision).toEqual({
      kind: "respond",
      result: {
        model: "user-provided",
        role: "assistant",
        content: { type: "text", text: "The answer is 42." },
      },
    });
  });
});

describe("elicitationDecisionFor", () => {
  it("declines on empty input", () => {
    expect(elicitationDecisionFor("")).toEqual({ action: "decline" });
    expect(elicitationDecisionFor("   ")).toEqual({ action: "decline" });
  });

  it("accepts valid JSON as structured content", () => {
    expect(elicitationDecisionFor('{"name": "Ada", "age": 36}')).toEqual({
      action: "accept",
      content: { name: "Ada", age: 36 },
    });
  });

  it("wraps plain text as { value } content", () => {
    expect(elicitationDecisionFor("  hello there ")).toEqual({
      action: "accept",
      content: { value: "hello there" },
    });
    // Almost-JSON falls back to plain text, not an error.
    expect(elicitationDecisionFor("{broken json")).toEqual({
      action: "accept",
      content: { value: "{broken json" },
    });
  });
});
