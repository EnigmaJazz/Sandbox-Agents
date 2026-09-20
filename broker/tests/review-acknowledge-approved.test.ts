// T1: host_review_acknowledge_approved required-flag parity.
//
// The installed gentle-ai 3.4 CLI refuses a flag-less argv:
//   Error: review acknowledge-approved requires --lineage, --target,
//   --expected-revision, and --token
// These tests pin the exact fixed argv, the broker-side refusal of a missing or
// empty value (before any spawn, naming the flag), and the exact payload-key
// allowlist. Provider-issued values are forwarded verbatim.
import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { SpawnFn } from "../src/msb.ts";
import { SddRuntimeExecutor, buildReviewAcknowledgeApprovedArgv } from "../src/sdd-runtime.ts";
import { assertPayloadKeys, ValidationError } from "../src/validation.ts";

const projectRoot = realpathSync(resolve(import.meta.dir, "../.."));

const values = {
  lineage: "Lineage-TOKEN",
  target: "Target-TOKEN",
  expectedRevision: `sha256:${"a".repeat(64)}`,
  token: "Approved-ACK-TOKEN",
} as const;

const expectedFlags: Record<keyof typeof values, string> = {
  lineage: "--lineage",
  target: "--target",
  expectedRevision: "--expected-revision",
  token: "--token",
};

describe("reviewAcknowledgeApproved flag parity", () => {
  test("emits exactly the four provider-issued flags in order", () => {
    expect(buildReviewAcknowledgeApprovedArgv({ binary: "gentle-ai", ...values })).toEqual([
      "gentle-ai",
      "review",
      "acknowledge-approved",
      "--lineage",
      values.lineage,
      "--target",
      values.target,
      "--expected-revision",
      values.expectedRevision,
      "--token",
      values.token,
    ]);
  });

  test("forwards every value byte-for-byte", () => {
    const argv = buildReviewAcknowledgeApprovedArgv({ binary: "gentle-ai", ...values });
    expect(argv[argv.indexOf("--lineage") + 1]).toBe(values.lineage);
    expect(argv[argv.indexOf("--target") + 1]).toBe(values.target);
    expect(argv[argv.indexOf("--expected-revision") + 1]).toBe(values.expectedRevision);
    expect(argv[argv.indexOf("--token") + 1]).toBe(values.token);
  });

  test("refuses a missing value before any spawn, naming the flag", () => {
    for (const key of Object.keys(values) as Array<keyof typeof values>) {
      const input: Record<string, unknown> = { binary: "gentle-ai", ...values };
      delete input[key];
      expect(() => buildReviewAcknowledgeApprovedArgv(input)).toThrow(
        new RegExp(`${expectedFlags[key]} is required`),
      );
    }
  });

  test("refuses an empty value before any spawn, naming the flag", () => {
    for (const key of Object.keys(values) as Array<keyof typeof values>) {
      expect(() =>
        buildReviewAcknowledgeApprovedArgv({ binary: "gentle-ai", ...values, [key]: "" }),
      ).toThrow(new RegExp(`${expectedFlags[key]} is required`));
    }
  });

  test("still rejects an undeclared argv key", () => {
    expect(() =>
      buildReviewAcknowledgeApprovedArgv({ binary: "gentle-ai", ...values, extra: "x" }),
    ).toThrow(ValidationError);
  });

  test("never spawns when a required value is missing", async () => {
    let spawned = false;
    const spawn: SpawnFn = async () => {
      spawned = true;
      return { status: 0, stdout: "{}", stderr: "", timedOut: false };
    };
    const executor = new SddRuntimeExecutor({
      binary: "gentle-ai",
      projects: [{ id: "repo", path: projectRoot }],
      spawn,
    });
    await expect(
      executor.reviewAcknowledgeApproved({
        projectDir: projectRoot,
        lineage: values.lineage,
        target: values.target,
        expectedRevision: values.expectedRevision,
      }),
    ).rejects.toThrow(/--token is required/);
    expect(spawned).toBe(false);
  });
});

describe("reviewAcknowledgeApproved payload allowlist", () => {
  test("accepts exactly the four forwarded keys", () => {
    expect(() =>
      assertPayloadKeys("reviewAcknowledgeApproved", { projectDir: "/repo", ...values }),
    ).not.toThrow();
  });

  test("rejects an undeclared extra key", () => {
    expect(() =>
      assertPayloadKeys("reviewAcknowledgeApproved", { projectDir: "/repo", bogus: "x" }),
    ).toThrow(ValidationError);
  });
});
