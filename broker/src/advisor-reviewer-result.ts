/**
 * Structural pre-check of an external advisor's reviewer result
 * (odd/tasks/external-advisors.md A3b), mirroring the gentle-ai reviewer
 * schema (`gentle-ai review schema reviewer`, verified 2026-10-01/02).
 *
 * This is a pre-check so an advisor learns of a malformed result while it
 * can still fix it. It is NOT admission: gentle-ai's own preflight and
 * capture at relay time (A4) remain authoritative. The stored result is
 * relayed exactly as submitted.
 */
import { ValidationError } from "./validation.ts";

const SEVERITIES = ["BLOCKER", "CRITICAL", "WARNING", "SUGGESTION"];
const EVIDENCE_CLASSES = ["deterministic", "inferential", "insufficient"];
const CAUSAL_DISPOSITIONS = ["introduced", "behavior-activated", "worsened", "pre-existing", "base-only", "unknown"];
const LOCATION_RE = /^.+:[1-9][0-9]*(?:-[1-9][0-9]*)?$/;
const FINDING_ID_RE = /^R[1-4]-[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** The schema's own placeholder pattern for evidence and proof references. */
const PLACEHOLDER_RE = /^\s*(?:n\/a|na|none|todo|tbd|pass|passed|success|placeholder)\s*$/i;
const FINDING_KEYS = ["id", "lens", "severity", "location", "claim", "evidence_class", "causal_disposition", "proof_refs"];
/** Finding-id prefix bound to each lens (not to selection order). */
const LENS_ID_PREFIX: Record<string, string> = {
  "review-risk": "R1-",
  "review-readability": "R2-",
  "review-reliability": "R3-",
  "review-resilience": "R4-",
};

function fail(message: string): never {
  throw new ValidationError(`reviewerResult: ${message}`);
}

function object(value: unknown, what: string, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${what} must be an object`);
  const o = value as Record<string, unknown>;
  for (const key of Object.keys(o)) if (!allowed.includes(key)) fail(`${what} has unexpected field '${key}'`);
  for (const key of required) if (o[key] === undefined) fail(`${what} is missing '${key}'`);
  return o;
}

function concreteStrings(value: unknown, what: string): void {
  if (!Array.isArray(value) || value.length === 0) fail(`${what} must be a non-empty array`);
  for (const item of value) {
    if (typeof item !== "string" || !/\S/.test(item) || PLACEHOLDER_RE.test(item)) {
      fail(`${what} entries must be concrete, not placeholders`);
    }
  }
}

export function validateReviewerResult(value: unknown, expected: { subjectHash: string; lens: string }): void {
  const r = object(value, "result", ["subject_hash", "inspection", "findings", "evidence"], ["subject_hash", "inspection", "findings", "evidence"]);
  if (r.subject_hash !== expected.subjectHash) fail("subject_hash does not match the requested artifact subject");
  concreteStrings(r.evidence, "evidence");

  const inspection = object(r.inspection, "inspection", ["status", "paths", "reason"], ["status"]);
  if (inspection.status === "completed") {
    const paths = inspection.paths;
    if (!Array.isArray(paths) || paths.length === 0) fail("a completed inspection must list every inspected path");
    if (paths.some((p) => typeof p !== "string" || p.length === 0)) fail("inspection paths must be non-empty strings");
    if (new Set(paths).size !== paths.length) fail("inspection paths must be unique");
    if (inspection.reason !== undefined) fail("a completed inspection carries no reason");
  } else if (inspection.status === "unavailable") {
    if (typeof inspection.reason !== "string" || !/\S/.test(inspection.reason)) fail("an unavailable inspection needs a reason");
    if (inspection.paths !== undefined && (!Array.isArray(inspection.paths) || inspection.paths.length !== 0)) {
      fail("an unavailable inspection lists no paths");
    }
  } else {
    fail("inspection.status must be completed or unavailable");
  }

  if (!Array.isArray(r.findings)) fail("findings must be an array");
  const shortLens = expected.lens.replace(/^review-/, "");
  for (const [i, raw] of (r.findings as unknown[]).entries()) {
    const f = object(raw, `findings[${i}]`, FINDING_KEYS, ["location", "severity", "claim", "proof_refs"]);
    if (!SEVERITIES.includes(f.severity as string)) fail(`findings[${i}].severity must be one of ${SEVERITIES.join(", ")}`);
    if (typeof f.claim !== "string" || !/\S/.test(f.claim)) fail(`findings[${i}].claim must be non-empty`);
    if (typeof f.location !== "string" || !LOCATION_RE.test(f.location)) fail(`findings[${i}].location must be path:line or path:start-end`);
    concreteStrings(f.proof_refs, `findings[${i}].proof_refs`);
    if (f.evidence_class !== undefined && !EVIDENCE_CLASSES.includes(f.evidence_class as string)) fail(`findings[${i}].evidence_class is invalid`);
    if (f.causal_disposition !== undefined && !CAUSAL_DISPOSITIONS.includes(f.causal_disposition as string)) {
      fail(`findings[${i}].causal_disposition is invalid`);
    }
    if ((f.severity === "BLOCKER" || f.severity === "CRITICAL") && (f.evidence_class === undefined || f.causal_disposition === undefined)) {
      fail(`findings[${i}] is ${f.severity as string} and needs evidence_class and causal_disposition`);
    }
    if (f.lens !== undefined && f.lens !== expected.lens && f.lens !== shortLens) fail(`findings[${i}].lens must be the requested lens`);
    if (f.id !== undefined) {
      if (typeof f.id !== "string" || !FINDING_ID_RE.test(f.id)) fail(`findings[${i}].id is malformed`);
      const prefix = LENS_ID_PREFIX[expected.lens];
      if (prefix && !(f.id as string).startsWith(prefix)) fail(`findings[${i}].id must start with ${prefix} for ${expected.lens}`);
    }
  }
}
