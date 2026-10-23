import { describe, expect, test } from "bun:test";
import { addOperatorGuidance, REVIEW_GUIDANCE_OBSERVED_BUILD } from "../src/review-guidance.ts";

const guidance = {
  condition: "correction_required_unreachable",
  upstream: "https://github.com/Gentleman-Programming/gentle-ai/issues/4571",
  observed_on: REVIEW_GUIDANCE_OBSERVED_BUILD,
  workaround:
    "Do not run review recover without a maintainer authorization value issued by gentle-ai. If the corroborated finding is real, fix it, commit, and start a new lineage on the new target. If the finding is false, this lineage has no sanctioned exit; leave it as history.",
  why:
    "The state records fix_delta_hash as the SHA-256 of empty input at capture_phase_epoch 1, and no operation offered in this state can supply a correction delta.",
};

function statusDocument(overrides: Record<string, unknown> = {}) {
  return {
    schema: "gentle-ai.review-integration.status/v2",
    target_identity: { target: "target-token" },
    next_transition: {
      kind: "stop",
      reason_code: "corrupted_or_unverifiable_authority",
    },
    authority: { state: "correction_required" },
    projection: { value: "workspace" },
    repair: { value: "repair" },
    candidates: [{ id: "candidate" }],
    repository_context: { value: "context" },
    eligible_untracked_inventory: { value: "inventory" },
    ...overrides,
  };
}

describe("review operator guidance", () => {
  test("adds exact guidance only for the terminal correction-required status", () => {
    const input = statusDocument();
    const original = structuredClone(input);

    const result = addOperatorGuidance(input) as Record<string, unknown>;

    expect(result).not.toBe(input);
    expect(result.operator_guidance).toEqual(guidance);
    expect(input).toEqual(original);
    expect(input).not.toHaveProperty("operator_guidance");
    const { operator_guidance: _guidance, ...providerFields } = result;
    expect(providerFields).toEqual(original);
  });

  test("returns healthy correction-required status by identity", () => {
    const input = statusDocument({ next_transition: { kind: "collect" } });
    expect(addOperatorGuidance(input)).toBe(input);
    expect(input).not.toHaveProperty("operator_guidance");
  });

  test("does not add guidance for another stop reason", () => {
    const input = statusDocument({
      next_transition: { kind: "stop", reason_code: "candidate_superseded" },
    });
    expect(addOperatorGuidance(input)).toBe(input);
  });

  test("does not add guidance for approved authority", () => {
    const input = statusDocument({ authority: { state: "approved" } });
    expect(addOperatorGuidance(input)).toBe(input);
  });

  test("returns non-object inputs by identity", () => {
    for (const input of [null, "text", []]) {
      expect(addOperatorGuidance(input)).toBe(input);
    }
  });
});
