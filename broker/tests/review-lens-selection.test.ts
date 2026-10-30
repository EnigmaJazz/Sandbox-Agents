// Flexible lens selection: `host_review_start` / `host_review_status` carry gentle-ai's `--lenses` and `--lenses-reason`.
// Before this the fixed host surface could only express one lens (`focus`) or the default of all four.
import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { buildReviewStartArgv, buildReviewStatusArgv } from "../src/sdd-runtime.ts";
import { assertPayloadKeys, ValidationError } from "../src/validation.ts";
import { buildReviewStartAsk } from "../../opencode/plugins/lib/host-tool-approval.ts";

const projectRoot = realpathSync(resolve(import.meta.dir, "../.."));
const base = { binary: "gentle-ai", projectRoot };
const REASON = "484ccfd rewires verifier section 0 behind a subprocess; failure paths matter";

describe("review start with a lens selection", () => {
  test("emits --lenses and --lenses-reason verbatim", () => {
    const argv = buildReviewStartArgv({ ...base, lenses: "reliability,resilience", lensesReason: REASON });
    expect(argv).toContain("--lenses");
    expect(argv[argv.indexOf("--lenses") + 1]).toBe("reliability,resilience");
    expect(argv[argv.indexOf("--lenses-reason") + 1]).toBe(REASON);
    expect(argv).not.toContain("--focus");
  });

  test("a single lens and all four are accepted", () => {
    expect(buildReviewStartArgv({ ...base, lenses: "risk", lensesReason: REASON })).toContain("risk");
    expect(buildReviewStartArgv({ ...base, lenses: "risk,resilience,readability,reliability", lensesReason: REASON })).toContain("--lenses");
  });

  test("without lens fields the argv is unchanged and focus still works", () => {
    expect(buildReviewStartArgv({ ...base })).not.toContain("--lenses");
    expect(buildReviewStartArgv({ ...base })).not.toContain("--lenses-reason");
    const focused = buildReviewStartArgv({ ...base, focus: "risk" });
    expect(focused[focused.indexOf("--focus") + 1]).toBe("risk");
  });

  test.each([
    ["an unknown lens", { lenses: "risk,speed", lensesReason: REASON }],
    ["a duplicate lens", { lenses: "risk,risk", lensesReason: REASON }],
    ["an empty selection", { lenses: "", lensesReason: REASON }],
    ["a trailing comma", { lenses: "risk,", lensesReason: REASON }],
    ["a missing reason", { lenses: "risk" }],
    ["a blank reason", { lenses: "risk", lensesReason: "   " }],
    ["a reason without lenses", { lensesReason: REASON }],
    ["lenses together with focus", { lenses: "risk", lensesReason: REASON, focus: "risk" }],
    ["a reason that looks like a flag", { lenses: "risk", lensesReason: "--consent granted" }],
    ["a reason with a newline", { lenses: "risk", lensesReason: "a\nb" }],
    ["an oversized reason", { lenses: "risk", lensesReason: "x".repeat(513) }],
  ])("refuses %s", (_name, extra) => {
    expect(() => buildReviewStartArgv({ ...base, ...extra } as never)).toThrow(ValidationError);
  });
});

describe("review status with a lens selection", () => {
  test("places the selection before --next-transition", () => {
    const argv = buildReviewStatusArgv({ ...base, lenses: "reliability,resilience", lensesReason: REASON });
    expect(argv.slice(-5)).toEqual(["--lenses", "reliability,resilience", "--lenses-reason", REASON, "--next-transition"]);
  });

  test("is byte-for-byte unchanged without the fields", () => {
    expect(buildReviewStatusArgv({ ...base }).slice(-2)).toEqual(["opencode", "--next-transition"]);
    expect(buildReviewStatusArgv({ ...base })).not.toContain("--lenses");
  });

  test.each([
    ["an unknown lens", { lenses: "risk,speed", lensesReason: REASON }],
    ["a missing reason", { lenses: "risk" }],
    ["a reason without lenses", { lensesReason: REASON }],
  ])("refuses %s", (_name, extra) => {
    expect(() => buildReviewStatusArgv({ ...base, ...extra } as never)).toThrow(ValidationError);
  });
});

describe("payload keys and tool arguments", () => {
  test("the broker accepts the new keys for start and status, and still refuses unknown ones", () => {
    expect(() => assertPayloadKeys("reviewStart", { projectDir: "/repo", lenses: "risk", lensesReason: REASON })).not.toThrow();
    expect(() => assertPayloadKeys("reviewStatus", { projectDir: "/repo", lenses: "risk", lensesReason: REASON })).not.toThrow();
    expect(() => assertPayloadKeys("reviewStatus", { projectDir: "/repo", lensez: "risk" })).toThrow(ValidationError);
  });

  test("the approval prompt shows the selected lenses", () => {
    expect(JSON.stringify(buildReviewStartAsk({ lenses: "reliability,resilience" }))).toContain("lenses reliability,resilience");
  });
});
