import { describe, expect, test } from "bun:test";
import { runDeterministicChecks, type DeterministicResult } from "../src/gate-checks.ts";
import { missingCheckpoints, routeGate, type RouteInput } from "../src/gate-route.ts";

const pass: DeterministicResult = { checks: [{ check: "scope", passed: true, detail: "" }], deterministicPass: true };
const failed: DeterministicResult = { checks: [{ check: "tests", passed: false, detail: "" }], deterministicPass: false };
const missing: DeterministicResult = { checks: [{ check: "tests", passed: false, missing: true, detail: "" }], deterministicPass: false };
const base = (ps: (number | undefined)[], det = pass, extra: Partial<RouteInput> = {}): RouteInput => ({
  checkpoint: "plan-vs-spec",
  deterministic: det,
  expectedCriteria: ps.map((_, i) => `S${i}`),
  criteria: ps.map((p, i) => ({ id: `S${i}`, p })),
  ...extra,
});

describe("gate route (D22, S110)", () => {
  test("RECORD_PASS: deterministic pass and every p > 0.7", () => {
    expect(routeGate(base([0.71, 1]))).toBe("RECORD_PASS");
    expect(routeGate({ ...base([0.9]), checkpoint: "implementation-vs-spec" })).toBe("RECORD_PASS");
  });
  test("RETURN_TO_PLANNER: a criterion p < 0.3, or a clear deterministic failure", () => {
    expect(routeGate(base([0.9, 0.29]))).toBe("RETURN_TO_PLANNER");
    expect(routeGate(base([0, 0.9]))).toBe("RETURN_TO_PLANNER");
    expect(routeGate(base([0.9, 0.9], failed))).toBe("RETURN_TO_PLANNER");
  });
  test("SPEC_CHECK: unsure band, missing p, missing deterministic evidence", () => {
    expect(routeGate(base([0.5]))).toBe("SPEC_CHECK");
    expect(routeGate(base([0.9, undefined]))).toBe("SPEC_CHECK");
    expect(routeGate(base([0.9], missing))).toBe("SPEC_CHECK");
  });
  test("boundaries: exactly 0.7 and exactly 0.3 are both unsure", () => {
    expect(routeGate(base([0.7]))).toBe("SPEC_CHECK");
    expect(routeGate(base([0.3]))).toBe("SPEC_CHECK");
    expect(routeGate(base([0.7000001]))).toBe("RECORD_PASS");
    expect(routeGate(base([0.2999999]))).toBe("RETURN_TO_PLANNER");
  });
  test("a clear failure beats a missing p", () => {
    expect(routeGate(base([0.1, undefined]))).toBe("RETURN_TO_PLANNER");
  });
  test("malformed p fails closed: NaN, negative, > 1, wrong type", () => {
    for (const p of [NaN, -0.1, 1.01, Infinity, "0.9" as unknown as number])
      expect(routeGate(base([0.9, p]))).toBe("SPEC_CHECK");
  });
  test("duplicate, unknown, and absent criterion ids fail closed", () => {
    const dup = base([0.9, 0.9]);
    expect(routeGate({ ...dup, criteria: [{ id: "S0", p: 0.9 }, { id: "S0", p: 0.9 }] })).toBe("SPEC_CHECK");
    expect(routeGate({ ...dup, criteria: [{ id: "S0", p: 0.9 }, { id: "ZZ", p: 0.9 }] })).toBe("SPEC_CHECK");
    expect(routeGate({ ...dup, criteria: [{ id: "S0", p: 0.9 }] })).toBe("SPEC_CHECK");
  });
  test("empty criteria or expected list fails closed", () => {
    expect(routeGate({ ...base([]), criteria: [] })).toBe("SPEC_CHECK");
    expect(routeGate({ ...base([0.9]), expectedCriteria: [] })).toBe("SPEC_CHECK");
  });
  test("malformed deterministic result or checkpoint fails closed, never throws", () => {
    expect(routeGate(base([0.9], { checks: [], deterministicPass: true }))).toBe("SPEC_CHECK");
    expect(routeGate(base([0.9], { checks: [{ check: "scope", passed: false, detail: "" }], deterministicPass: true }))).toBe("SPEC_CHECK");
    expect(routeGate({ ...base([0.9]), checkpoint: "x" as never })).toBe("SPEC_CHECK");
    expect(routeGate(null as never)).toBe("SPEC_CHECK");
    expect(routeGate({} as never)).toBe("SPEC_CHECK");
  });
  test("thresholds are overridable and validated 0 < low <= high < 1", () => {
    expect(routeGate(base([0.85], pass, { thresholds: { low: 0.3, high: 0.9 } }))).toBe("SPEC_CHECK");
    expect(routeGate(base([0.95], pass, { thresholds: { low: 0.3, high: 0.9 } }))).toBe("RECORD_PASS");
    expect(routeGate(base([0.45], pass, { thresholds: { low: 0.5, high: 0.5 } }))).toBe("RETURN_TO_PLANNER");
    for (const t of [{ low: 0, high: 0.5 }, { low: 0.6, high: 0.5 }, { low: 0.2, high: 1 }, { low: NaN, high: 0.5 }])
      expect(routeGate(base([0.9], pass, { thresholds: t }))).toBe("SPEC_CHECK");
  });
  test("S110: all-high confidence with failed or missing deterministic evidence never passes", () => {
    expect(routeGate(base([1, 1, 1], failed))).not.toBe("RECORD_PASS");
    expect(routeGate(base([1, 1, 1], missing))).not.toBe("RECORD_PASS");
    const real = runDeterministicChecks({ maxApplyDiffLines: 200 });
    expect(routeGate(base([1], real))).toBe("SPEC_CHECK");
  });
  test("property: RECORD_PASS implies deterministicPass and every p > high (and low/high honoured)", () => {
    const vals = [undefined, NaN, -1, 0, 0.1, 0.29, 0.3, 0.5, 0.7, 0.71, 0.99, 1, 2];
    const dets = [pass, failed, missing];
    let passes = 0;
    for (const det of dets)
      for (const a of vals)
        for (const b of vals)
          for (const high of [0.7, 0.9]) {
            const r = routeGate(base([a, b], det, { thresholds: { low: 0.3, high } }));
            if (r === "RECORD_PASS") {
              passes++;
              expect(det.deterministicPass).toBe(true);
              expect(a! > high && b! > high).toBe(true);
            }
          }
    expect(passes).toBeGreaterThan(0); // positive control: the loop can see a pass
  });
});

describe("gate checkpoints (S96, S97)", () => {
  test("reports which of the two checkpoints a stage lacks", () => {
    expect(missingCheckpoints([])).toEqual(["plan-vs-spec", "implementation-vs-spec"]);
    expect(missingCheckpoints(["plan-vs-spec"])).toEqual(["implementation-vs-spec"]);
    expect(missingCheckpoints(["implementation-vs-spec"])).toEqual(["plan-vs-spec"]);
    expect(missingCheckpoints(["plan-vs-spec", "implementation-vs-spec"])).toEqual([]);
  });
});
