// T2 (v6 §32): scoped native assessment + STATUS.
//
// Confirmed upstream flags (gentle-ai 3.1.0 clone):
//   internal/cli/review_assess.go:112  baseRef := flags.String("base-ref", ...)
//   internal/cli/review_assess.go:113  committedOnly := flags.Bool("committed-only", ...)
//   internal/cli/review_facade.go:784  baseRef := flags.String("base-ref", ...)
//   internal/cli/review_facade.go:786  committedOnly := flags.Bool("committed-only", ...)
//
// These tests prove the flags reach the built argv exactly when supplied, stay
// byte-for-byte absent when omitted, and that invalid/undeclared input is
// refused by the existing payload/argv validation.
import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { buildReviewAssessOp, buildReviewStatusOp, type SddOpContext } from "../src/sdd-service.ts";
import { buildReviewAssessArgv, buildReviewStatusArgv } from "../src/sdd-runtime.ts";
import type { BrokerRequestEnvelope } from "../src/types.ts";
import { assertPayloadKeys, ValidationError } from "../src/validation.ts";

const projectRoot = realpathSync(resolve(import.meta.dir, "../.."));

const statusPrefix = [
  "gentle-ai",
  "review",
  "status",
  "--cwd",
  projectRoot,
  "--contract",
  "gentle-ai.review-integration/v2",
  "--agent",
  "opencode",
];

describe("T2 scoped review assess argv", () => {
  test("is byte-for-byte unchanged when both scoped flags are omitted", () => {
    expect(buildReviewAssessArgv({ binary: "gentle-ai", projectRoot })).toEqual([
      "gentle-ai",
      "review",
      "assess",
      "--cwd",
      projectRoot,
      "--json",
    ]);
  });

  test("carries --base-ref <ref> --committed-only exactly when supplied", () => {
    expect(
      buildReviewAssessArgv({
        binary: "gentle-ai",
        projectRoot,
        baseRef: "refs/heads/main",
        committedOnly: true,
      }),
    ).toEqual([
      "gentle-ai",
      "review",
      "assess",
      "--cwd",
      projectRoot,
      "--base-ref",
      "refs/heads/main",
      "--committed-only",
      "--json",
    ]);
  });

  test("forwards --base-ref alone verbatim (upstream owns the pairing rule)", () => {
    expect(
      buildReviewAssessArgv({ binary: "gentle-ai", projectRoot, baseRef: "origin/main" }),
    ).toEqual([
      "gentle-ai",
      "review",
      "assess",
      "--cwd",
      projectRoot,
      "--base-ref",
      "origin/main",
      "--json",
    ]);
  });

  test("omits --committed-only when explicitly false", () => {
    expect(
      buildReviewAssessArgv({ binary: "gentle-ai", projectRoot, committedOnly: false }),
    ).toEqual(["gentle-ai", "review", "assess", "--cwd", projectRoot, "--json"]);
  });

  test("rejects invalid or undeclared scoped input", () => {
    for (const bad of ["", "-flag", "main..dev", "main~1", "main@{upstream}", "a".repeat(1025), 1]) {
      expect(() =>
        buildReviewAssessArgv({ binary: "gentle-ai", projectRoot, baseRef: bad as never }),
      ).toThrow(ValidationError);
    }
    expect(() =>
      buildReviewAssessArgv({ binary: "gentle-ai", projectRoot, committedOnly: "true" as never }),
    ).toThrow(ValidationError);
    expect(() =>
      buildReviewAssessArgv({ binary: "gentle-ai", projectRoot, extra: true } as never),
    ).toThrow(ValidationError);
  });
});

describe("T2 scoped review status argv", () => {
  test("is byte-for-byte unchanged when both scoped flags are omitted", () => {
    expect(buildReviewStatusArgv({ binary: "gentle-ai", projectRoot })).toEqual([
      ...statusPrefix,
      "--next-transition",
    ]);
  });

  test("carries --base-ref <ref> --committed-only exactly when supplied", () => {
    expect(
      buildReviewStatusArgv({
        binary: "gentle-ai",
        projectRoot,
        baseRef: "refs/heads/main",
        committedOnly: true,
      }),
    ).toEqual([
      ...statusPrefix,
      "--base-ref",
      "refs/heads/main",
      "--committed-only",
      "--next-transition",
    ]);
  });

  test("places the scoped selector after the other selectors, before --next-transition", () => {
    expect(
      buildReviewStatusArgv({
        binary: "gentle-ai",
        projectRoot,
        lineage: "Lineage-TOKEN",
        projection: "staged",
        baseRef: "origin/main",
        committedOnly: true,
      }),
    ).toEqual([
      "gentle-ai",
      "review",
      "status",
      "--cwd",
      projectRoot,
      "--contract",
      "gentle-ai.review-integration/v2",
      "--agent",
      "opencode",
      "--lineage",
      "Lineage-TOKEN",
      "--projection",
      "staged",
      "--base-ref",
      "origin/main",
      "--committed-only",
      "--next-transition",
    ]);
  });

  test("rejects invalid or undeclared scoped input", () => {
    for (const bad of ["", "-flag", "main..dev", "main~1", "main@{upstream}", "a".repeat(1025), 1]) {
      expect(() =>
        buildReviewStatusArgv({ binary: "gentle-ai", projectRoot, baseRef: bad as never }),
      ).toThrow(ValidationError);
    }
    expect(() =>
      buildReviewStatusArgv({ binary: "gentle-ai", projectRoot, committedOnly: "true" as never }),
    ).toThrow(ValidationError);
    expect(() =>
      buildReviewStatusArgv({ binary: "gentle-ai", projectRoot, extra: true } as never),
    ).toThrow(ValidationError);
  });
});

describe("T2 scoped payload allowlists", () => {
  test("reviewAssess and reviewStatus accept the scoped keys", () => {
    expect(() =>
      assertPayloadKeys("reviewAssess", {
        projectDir: "/repo",
        baseRef: "refs/heads/main",
        committedOnly: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertPayloadKeys("reviewStatus", {
        projectDir: "/repo",
        baseRef: "refs/heads/main",
        committedOnly: false,
      }),
    ).not.toThrow();
  });

  test("undeclared scoped neighbours stay rejected", () => {
    expect(() =>
      assertPayloadKeys("reviewAssess", { projectDir: "/repo", baseRefX: "x" }),
    ).toThrow(ValidationError);
    expect(() =>
      assertPayloadKeys("reviewStatus", { projectDir: "/repo", committedOnlyX: true }),
    ).toThrow(ValidationError);
  });
});

describe("T2 scoped forwarding through the broker handlers", () => {
  function makeCtx(): { ctx: SddOpContext; calls: Array<{ method: string; payload: unknown }> } {
    const calls: Array<{ method: string; payload: unknown }> = [];
    const ctx = {
      config: defaultConfig({ readOnlyAgents: ["gentle-orchestrator"] }),
      store: { get: () => undefined },
      sddRuntime: {
        reviewAssess: (payload: unknown) => {
          calls.push({ method: "reviewAssess", payload });
          return Promise.resolve({ status: 0, json: {}, stderr: "" });
        },
        reviewStatus: (payload: unknown) => {
          calls.push({ method: "reviewStatus", payload });
          return Promise.resolve({ status: 0, json: {}, stderr: "" });
        },
      },
      logger: {},
      resources: {},
      budget: {},
      pool: { allocations: [] },
      adapter: {},
      hostRead: { has: () => false },
      git: {
        runnerMode: "planned",
        spawn: async () => ({ status: 0, stdout: "", stderr: "", timedOut: false }),
      },
    } as unknown as SddOpContext;
    return { ctx, calls };
  }

  function request(
    operation: BrokerRequestEnvelope["operation"],
    payload: Record<string, unknown>,
  ): BrokerRequestEnvelope {
    return { version: 1, id: `req-${operation}`, operation, sessionID: "session-1", payload };
  }

  test("review assess forwards baseRef/committedOnly to the runtime", async () => {
    const { ctx, calls } = makeCtx();
    await buildReviewAssessOp(ctx)(
      request("reviewAssess", {
        projectDir: "/repo",
        baseRef: "refs/heads/main",
        committedOnly: true,
      }),
    );
    expect(calls).toEqual([
      {
        method: "reviewAssess",
        payload: { projectDir: "/repo", baseRef: "refs/heads/main", committedOnly: true },
      },
    ]);
  });

  test("review status forwards baseRef/committedOnly to the runtime", async () => {
    const { ctx, calls } = makeCtx();
    await buildReviewStatusOp(ctx)(
      request("reviewStatus", {
        projectDir: "/repo",
        baseRef: "refs/heads/main",
        committedOnly: true,
      }),
    );
    expect(calls[0]!.method).toBe("reviewStatus");
    expect(calls[0]!.payload).toMatchObject({
      projectDir: "/repo",
      baseRef: "refs/heads/main",
      committedOnly: true,
    });
  });

  test("undeclared scoped payloads are refused before any runtime call", async () => {
    const { ctx, calls } = makeCtx();
    await expect(
      buildReviewAssessOp(ctx)(request("reviewAssess", { projectDir: "/repo", baseRefX: "x" })),
    ).rejects.toThrow(ValidationError);
    await expect(
      buildReviewStatusOp(ctx)(
        request("reviewStatus", { projectDir: "/repo", committedOnlyX: true }),
      ),
    ).rejects.toThrow(ValidationError);
    expect(calls).toEqual([]);
  });
});
