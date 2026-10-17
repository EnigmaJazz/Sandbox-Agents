import { describe, expect, test } from "bun:test";
import { toBrokerError } from "../src/server.ts";
import { MsbError } from "../src/msb.ts";
import { ReviewMaterializeError } from "../src/review-materialize.ts";
import { ReviewRunError } from "../src/review-run.ts";
import { StateError } from "../src/state.ts";
import { ValidationError } from "../src/validation.ts";

// The end-to-end dispatch round trip is deliberately deferred to U2-2, where
// the review-materialize operation exists. This suite exercises the mapper.
describe("broker error code mapping", () => {
  test.each([
    ["review_range_ref_unresolvable", "missing ref"],
    ["review_range_diff_failed", "diff failed"],
  ])("preserves materialize code %s", (code, message) => {
    expect(toBrokerError(new ReviewMaterializeError(code, message)).code).toBe(code);
  });

  test.each([
    ["review_run_not_owned", "not owned"],
    ["review_run_byte_cap", "too large"],
  ])("preserves store code %s", (code, message) => {
    expect(toBrokerError(new ReviewRunError(code, message)).code).toBe(code);
  });

  test("keeps established mappings ahead of typed-code propagation", () => {
    const validation = new ValidationError("invalid") as ValidationError & { code: string };
    const state = new StateError("bad state") as StateError & { code: string };
    const worker = new MsbError("worker failed") as MsbError & { code: string };
    Object.defineProperty(validation, "code", { value: "custom_validation" });
    Object.defineProperty(state, "code", { value: "custom_state" });
    Object.defineProperty(worker, "code", { value: "custom_worker" });
    expect(toBrokerError(validation).code).toBe("validation");
    expect(toBrokerError(state).code).toBe("state");
    expect(toBrokerError(worker).code).toBe("worker");
  });

  test("maps an inherited typed code to internal", () => {
    // Keep the pollution local to this test; never mutate Error.prototype or Object.prototype.
    const prototype = Object.assign(new Error("boom"), { code: "review_range_ref_unresolvable" });
    const error = Object.create(prototype) as Error;
    expect(Object.hasOwn(error, "code")).toBe(false);
    expect(toBrokerError(error).code).toBe("internal");
  });

  test("propagates an own typed code", () => {
    const error = Object.assign(new Error("typed error"), { code: "review_range_ref_unresolvable" });
    expect(Object.hasOwn(error, "code")).toBe(true);
    expect(toBrokerError(error).code).toBe("review_range_ref_unresolvable");
  });

  test("maps an ordinary Error without a typed code to internal", () => {
    expect(toBrokerError(new Error("unexpected"))).toEqual({ code: "internal", message: "unexpected" });
  });

  test.each([
    ["non-string", 42],
    ["empty", ""],
    ["uppercase", "Review_Error"],
    ["space", "review error"],
    ["path separator", "review/error"],
  ])("fails closed for %s codes", (_label, code) => {
    const error = new Error("untrusted code") as Error & { code: unknown };
    error.code = code;
    expect(toBrokerError(error).code).toBe("internal");
  });
});
