/**
 * Gate payload builder (multi-tier S101-S104): one question per acceptance
 * criterion, carrying only the evidence the CALLER tagged for it, and only for
 * criteria not already settled deterministically. Pure; NOT installed: S17
 * security component, the OWNER reviews and installs it. Never truncates:
 * a question over the per-question limit is returned as `unsure` (D22 routes it).
 */
export const MAX_QUESTION_TOKENS = 32_000;
export const MAX_REQUEST_TOKENS = 64_000;

/** Conservative over-estimate: ceil(chars / 3) of the serialized question. */
export const estimateTokens = (s: string): number => Math.ceil(s.length / 3);

export interface GateEvidence {
  id: string;
  text: string;
  /** Criterion ids this evidence is relevant to (explicit; never inferred). */
  criteria: readonly string[];
}
export interface GateQuestion {
  criterionId: string;
  text: string;
  evidence: { id: string; text: string }[];
  tokens: number;
}
export interface GatePayload {
  /** Requests, each within MAX_REQUEST_TOKENS in total. */
  requests: GateQuestion[][];
  unsure: { criterionId: string; reason: string }[];
}

export function buildGatePayload(i: {
  criteria: readonly { id: string; text: string }[];
  evidence: readonly GateEvidence[];
  decided: readonly string[];
}): GatePayload {
  const ids = new Set(i.criteria.map((c) => c.id));
  if (ids.size !== i.criteria.length) throw new Error("duplicate criterion id");
  const questions: GateQuestion[] = [];
  const unsure: GatePayload["unsure"] = [];
  for (const c of i.criteria) {
    if (i.decided.includes(c.id)) continue;
    const evidence = i.evidence.filter((e) => e.criteria.includes(c.id)).map((e) => ({ id: e.id, text: e.text }));
    if (evidence.length === 0) {
      unsure.push({ criterionId: c.id, reason: "no evidence tagged for this criterion" });
      continue;
    }
    const q = { criterionId: c.id, text: c.text, evidence };
    const tokens = estimateTokens(JSON.stringify(q));
    if (tokens > MAX_QUESTION_TOKENS) unsure.push({ criterionId: c.id, reason: `question ${tokens} tokens > ${MAX_QUESTION_TOKENS}; not chunkable` });
    else questions.push({ ...q, tokens });
  }
  const requests: GateQuestion[][] = [];
  let used = 0;
  for (const q of questions) {
    if (requests.length === 0 || used + q.tokens > MAX_REQUEST_TOKENS) {
      requests.push([]);
      used = 0;
    }
    requests[requests.length - 1]!.push(q);
    used += q.tokens;
  }
  return { requests, unsure };
}
