import { describe, expect, test } from "bun:test";
import { MAX_QUESTION_TOKENS, MAX_REQUEST_TOKENS, buildGatePayload, estimateTokens } from "../src/gate-payload.ts";

const crit = (id: string) => ({ id, text: `criterion ${id}` });
const ev = (id: string, criteria: string[], text = "x") => ({ id, text, criteria });

describe("gate payload", () => {
  test("estimator over-estimates: ceil(chars/3)", () => {
    expect(estimateTokens("abcd")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
  test("one question per criterion keyed by id (S102)", () => {
    const p = buildGatePayload({ criteria: [crit("S1"), crit("S2")], evidence: [ev("e1", ["S1"]), ev("e2", ["S2"])], decided: [] });
    expect(p.requests.flat().map((q) => q.criterionId)).toEqual(["S1", "S2"]);
  });
  test("each question carries only its tagged evidence (S103)", () => {
    const p = buildGatePayload({ criteria: [crit("S1"), crit("S2")], evidence: [ev("e1", ["S1"]), ev("e2", ["S2"]), ev("e3", ["S1", "S2"]), ev("e4", ["S9"])], decided: [] });
    const [q1, q2] = p.requests.flat();
    expect(q1!.evidence.map((e) => e.id)).toEqual(["e1", "e3"]);
    expect(q2!.evidence.map((e) => e.id)).toEqual(["e2", "e3"]);
  });
  test("criteria decided deterministically are excluded (S101)", () => {
    const p = buildGatePayload({ criteria: [crit("S1"), crit("S2")], evidence: [ev("e1", ["S1", "S2"])], decided: ["S1"] });
    expect(p.requests.flat().map((q) => q.criterionId)).toEqual(["S2"]);
    expect(p.unsure).toEqual([]);
  });
  test("a criterion with no tagged evidence is unsure, never guessed", () => {
    const p = buildGatePayload({ criteria: [crit("S1")], evidence: [ev("e1", ["S2"])], decided: [] });
    expect(p.requests).toEqual([]);
    expect(p.unsure[0]!.criterionId).toBe("S1");
  });
  test("over the per-question limit is unsure with a reason, never truncated (S104)", () => {
    const big = "x".repeat(MAX_QUESTION_TOKENS * 3 + 10);
    const p = buildGatePayload({ criteria: [crit("S1"), crit("S2")], evidence: [ev("e1", ["S1"], big), ev("e2", ["S2"])], decided: [] });
    expect(p.unsure[0]!.criterionId).toBe("S1");
    expect(p.unsure[0]!.reason).toContain("not chunkable");
    expect(p.requests.flat().map((q) => q.criterionId)).toEqual(["S2"]);
  });
  test("a question just under the limit is sent whole", () => {
    const p = buildGatePayload({ criteria: [crit("S1")], evidence: [ev("e1", ["S1"], "x".repeat(MAX_QUESTION_TOKENS * 3 - 200))], decided: [] });
    expect(p.unsure).toEqual([]);
    expect(p.requests[0]![0]!.tokens).toBeLessThanOrEqual(MAX_QUESTION_TOKENS);
  });
  test("requests are split so none exceeds the per-request limit", () => {
    const text = "x".repeat(30_000 * 3);
    const ids = ["S1", "S2", "S3", "S4", "S5"];
    const p = buildGatePayload({ criteria: ids.map(crit), evidence: [ev("e", ids, text)], decided: [] });
    expect(p.requests.length).toBeGreaterThan(1);
    for (const r of p.requests) expect(r.reduce((n, q) => n + q.tokens, 0)).toBeLessThanOrEqual(MAX_REQUEST_TOKENS);
    expect(p.requests.flat().length).toBe(5);
  });
  test("duplicate criterion ids are rejected", () => {
    expect(() => buildGatePayload({ criteria: [crit("S1"), crit("S1")], evidence: [], decided: [] })).toThrow();
  });
});
