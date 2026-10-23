export type ReviewOperatorGuidance = {
  condition: "correction_required_unreachable";
  upstream: "https://github.com/Gentleman-Programming/gentle-ai/issues/4571";
  observed_on: typeof REVIEW_GUIDANCE_OBSERVED_BUILD;
  workaround: string;
  why: string;
};

export const REVIEW_GUIDANCE_OBSERVED_BUILD = "gentle-ai 4.2.0";

const REVIEW_OPERATOR_GUIDANCE: ReviewOperatorGuidance = {
  condition: "correction_required_unreachable",
  upstream: "https://github.com/Gentleman-Programming/gentle-ai/issues/4571",
  observed_on: REVIEW_GUIDANCE_OBSERVED_BUILD,
  workaround:
    "Do not run review recover without a maintainer authorization value issued by gentle-ai. If the corroborated finding is real, fix it, commit, and start a new lineage on the new target. If the finding is false, this lineage has no sanctioned exit; leave it as history.",
  why:
    "The state records fix_delta_hash as the SHA-256 of empty input at capture_phase_epoch 1, and no operation offered in this state can supply a correction delta.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// These two guidance variants carry the observed build so they can be retired when upstream fixes the defect. Status guidance requires a terminal stop with corrupted authority; closure guidance is weaker because correction_required may still lead to a healthy correction phase.
export function addOperatorGuidance(json: unknown): unknown {
  if (!isRecord(json)) return json;

  const nextTransition = json.next_transition;
  const authority = json.authority;
  if (
    typeof json.schema !== "string" ||
    !json.schema.startsWith("gentle-ai.review-integration.status/") ||
    !isRecord(nextTransition) ||
    nextTransition.kind !== "stop" ||
    nextTransition.reason_code !== "corrupted_or_unverifiable_authority" ||
    !isRecord(authority) ||
    authority.state !== "correction_required"
  ) {
    return json;
  }

  return { ...json, operator_guidance: { ...REVIEW_OPERATOR_GUIDANCE } };
}

const REVIEW_CLOSURE_GUIDANCE = {
  condition: "correction_required_reached",
  upstream: "https://github.com/Gentleman-Programming/gentle-ai/issues/4571",
  observed_on: REVIEW_GUIDANCE_OBSERVED_BUILD,
  next_step:
    "Run the returned status_continuation verbatim, with its tokens unchanged. If that status reports reason_code corrupted_or_unverifiable_authority, this lineage is unreachable: do not run review recover without a maintainer authorization value; fix the corroborated finding if it is real, commit, and start a new lineage on the new target.",
} as const;

export function addClosureGuidance(json: unknown): unknown {
  if (
    !isRecord(json) ||
    typeof json.schema !== "string" ||
    !json.schema.startsWith("gentle-ai.review-last-event-closure/") ||
    json.state !== "correction_required"
  ) {
    return json;
  }

  return { ...json, operator_guidance: { ...REVIEW_CLOSURE_GUIDANCE } };
}
