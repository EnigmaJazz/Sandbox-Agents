/**
 * Gate routing (multi-tier D22, S96/S97/S110): a pure label function. It records
 * nothing and calls nothing. NOT installed: S17 security component, the OWNER
 * reviews and installs it. Total and fail closed: any malformed input yields
 * SPEC_CHECK, never RECORD_PASS. RECORD_PASS needs every deterministic check
 * passed AND every expected criterion p > high; confidence alone cannot pass.
 * Boundaries: p > high passes, p < low fails, p in [low, high] is unsure.
 */
import type { DeterministicResult } from "./gate-checks.ts";

export type GateRoute = "RECORD_PASS" | "RETURN_TO_PLANNER" | "SPEC_CHECK";
export const CHECKPOINTS = ["plan-vs-spec", "implementation-vs-spec"] as const;
export type Checkpoint = (typeof CHECKPOINTS)[number];

/** Which of the two checkpoints a stage has not recorded (S96, S97). */
export const missingCheckpoints = (recorded: readonly string[]): Checkpoint[] =>
  CHECKPOINTS.filter((c) => !recorded.includes(c));

export interface RouteInput {
  checkpoint: Checkpoint;
  deterministic: DeterministicResult;
  /** Every criterion id the checkpoint requires; each needs exactly one entry. */
  expectedCriteria: readonly string[];
  /** p = Noul probability in [0,1]; undefined = missing/unsure (payload unsure). */
  criteria: readonly { id: string; p?: number }[];
  thresholds?: { low: number; high: number };
}

export function routeGate(input: RouteInput): GateRoute {
  try {
    const { low, high } = input.thresholds ?? { low: 0.3, high: 0.7 };
    if (!(low > 0 && low <= high && high < 1)) return "SPEC_CHECK";
    if (!CHECKPOINTS.includes(input.checkpoint)) return "SPEC_CHECK";
    const checks = input.deterministic.checks;
    if (!Array.isArray(checks) || checks.length === 0 || checks.some((c) => typeof c?.passed !== "boolean")) return "SPEC_CHECK";
    if (input.deterministic.deterministicPass !== checks.every((c) => c.passed)) return "SPEC_CHECK";
    const exp = input.expectedCriteria;
    if (!Array.isArray(exp) || exp.length === 0 || new Set(exp).size !== exp.length) return "SPEC_CHECK";
    const seen = new Set<string>();
    for (const c of input.criteria) {
      if (!exp.includes(c.id) || seen.has(c.id)) return "SPEC_CHECK";
      seen.add(c.id);
      if (c.p !== undefined && !(typeof c.p === "number" && c.p >= 0 && c.p <= 1)) return "SPEC_CHECK";
    }
    if (checks.some((c) => !c.passed && !c.missing)) return "RETURN_TO_PLANNER";
    if (!input.deterministic.deterministicPass) return "SPEC_CHECK";
    const ps = exp.map((id) => input.criteria.find((c) => c.id === id)?.p);
    if (ps.some((p) => p !== undefined && p < low)) return "RETURN_TO_PLANNER";
    return ps.every((p) => p !== undefined && p > high) ? "RECORD_PASS" : "SPEC_CHECK";
  } catch {
    return "SPEC_CHECK";
  }
}
