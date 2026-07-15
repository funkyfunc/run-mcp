/**
 * Pure decision logic for the REPL's sampling/elicitation approval prompts.
 *
 * Maps the raw text a user types at the approval prompt to the exact MCP
 * response payload (or rejection). Extracted from the readline handlers so the
 * protocol behavior — the shapes servers actually receive — is unit-testable
 * without a TTY. The REPL owns presentation; this module owns the contract.
 */

export type SamplingDecision =
  | {
      kind: "respond";
      result: {
        model: string;
        role: "assistant";
        content: { type: "text"; text: string };
      };
    }
  | { kind: "reject"; reason: string };

/**
 * Decide the `sampling/createMessage` outcome from the user's answer:
 *  - "y"/"yes"            → a fixed approval message
 *  - "n"/"no"/empty       → rejection
 *  - anything else        → the user's text becomes the assistant response
 */
export function samplingDecisionFor(answer: string): SamplingDecision {
  const trimmed = answer.trim();
  const lower = trimmed.toLowerCase();

  if (lower === "y" || lower === "yes") {
    return {
      kind: "respond",
      result: {
        model: "user-approved",
        role: "assistant",
        content: { type: "text", text: "Approved by user." },
      },
    };
  }
  if (lower === "n" || lower === "no" || lower === "") {
    return { kind: "reject", reason: "Sampling request rejected by user" };
  }
  return {
    kind: "respond",
    result: {
      model: "user-provided",
      role: "assistant",
      content: { type: "text", text: trimmed },
    },
  };
}

export type ElicitationDecision =
  { action: "decline" } | { action: "accept"; content: Record<string, unknown> };

/**
 * Decide the `elicitation/create` outcome from the user's answer:
 *  - empty                → decline
 *  - valid JSON object    → accept with the parsed content
 *  - anything else        → accept with `{ value: <text> }`
 */
export function elicitationDecisionFor(answer: string): ElicitationDecision {
  const trimmed = answer.trim();
  if (trimmed === "") return { action: "decline" };
  try {
    return { action: "accept", content: JSON.parse(trimmed) };
  } catch {
    return { action: "accept", content: { value: trimmed } };
  }
}
