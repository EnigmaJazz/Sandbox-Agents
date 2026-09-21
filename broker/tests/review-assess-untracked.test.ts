// Untracked-declaration coverage for `host_review_assess` (v6 §32 follow-up).
//
// A committed-only `review assess --base-ref <ref> --committed-only` is refused
// by the provider until the untracked population is declared explicitly:
//   --untracked-scope=exclude --expected-untracked-inventory=sha256:<digest>
//   --untracked-scope=select --intended-untracked=<path> --expected-untracked-inventory=sha256:<digest>
//
// Confirmed upstream (gentle-ai 3.1.0 clone):
//   internal/cli/review_assess.go:115-120 registers `untracked-scope`,
//   `intended-untracked` (repeated), and `expected-untracked-inventory` on the
//   standard `flag.FlagSet`, which accepts `--flag=value` and `--flag value`.
//   internal/cli/review_intended_untracked.go:86-89 owns the select/exclude
//   pairing rule, so the broker forwards the flags and lets upstream validate.
//
// These tests prove the three declaration flags reach the built argv with their
// exact provider argument forms only when supplied, stay byte-for-byte absent
// when omitted, and that the pairing rule stays upstream's.
import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { defaultConfig } from "../src/config.ts";
import type { SpawnFn } from "../src/msb.ts";
import { buildReviewAssessOp, type SddOpContext } from "../src/sdd-service.ts";
import { SddRuntimeExecutor, buildReviewAssessArgv } from "../src/sdd-runtime.ts";
import type { BrokerRequestEnvelope } from "../src/types.ts";
import { assertPayloadKeys, ValidationError } from "../src/validation.ts";

const projectRoot = realpathSync(resolve(import.meta.dir, "../.."));
const configuredProjectRoot = `${projectRoot}/broker/..`;
const digest = (char: string): string => `sha256:${char.repeat(64)}`;

describe("review assess untracked declaration argv", () => {
  test("omits the declaration byte-for-byte when not supplied", () => {
    expect(buildReviewAssessArgv({ binary: "gentle-ai", projectRoot })).toEqual([
      "gentle-ai",
      "review",
      "assess",
      "--cwd",
      projectRoot,
      "--json",
    ]);
  });

  test("emits --untracked-scope=exclude with its digest when supplied", () => {
    const inventory = digest("a");
    expect(
      buildReviewAssessArgv({
        binary: "gentle-ai",
        projectRoot,
        baseRef: "refs/heads/main",
        committedOnly: true,
        untrackedScope: "exclude",
        expectedUntrackedInventory: inventory,
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
      "--untracked-scope=exclude",
      `--expected-untracked-inventory=${inventory}`,
      "--json",
    ]);
  });

  test("repeats --intended-untracked for a select declaration", () => {
    const inventory = digest("b");
    expect(
      buildReviewAssessArgv({
        binary: "gentle-ai",
        projectRoot,
        untrackedScope: "select",
        expectedUntrackedInventory: inventory,
        intendedUntracked: ["AGENTS.md", "broker/src/validation.ts"],
      }),
    ).toEqual([
      "gentle-ai",
      "review",
      "assess",
      "--cwd",
      projectRoot,
      "--untracked-scope=select",
      `--expected-untracked-inventory=${inventory}`,
      "--intended-untracked=AGENTS.md",
      "--intended-untracked=broker/src/validation.ts",
      "--json",
    ]);
  });

  test("forwards lone declaration flags verbatim; the pairing rule stays upstream", () => {
    const inventory = digest("c");
    expect(
      buildReviewAssessArgv({
        binary: "gentle-ai",
        projectRoot,
        expectedUntrackedInventory: inventory,
      }),
    ).toEqual([
      "gentle-ai",
      "review",
      "assess",
      "--cwd",
      projectRoot,
      `--expected-untracked-inventory=${inventory}`,
      "--json",
    ]);
    expect(
      buildReviewAssessArgv({
        binary: "gentle-ai",
        projectRoot,
        untrackedScope: "select",
        expectedUntrackedInventory: inventory,
      }),
    ).toEqual([
      "gentle-ai",
      "review",
      "assess",
      "--cwd",
      projectRoot,
      "--untracked-scope=select",
      `--expected-untracked-inventory=${inventory}`,
      "--json",
    ]);
  });

  test("rejects malformed declaration values before spawn", () => {
    expect(() =>
      buildReviewAssessArgv({ binary: "gentle-ai", projectRoot, untrackedScope: "bogus" as never }),
    ).toThrow(ValidationError);
    expect(() =>
      buildReviewAssessArgv({
        binary: "gentle-ai",
        projectRoot,
        expectedUntrackedInventory: "sha256:nothex" as never,
      }),
    ).toThrow(ValidationError);
    expect(() =>
      buildReviewAssessArgv({
        binary: "gentle-ai",
        projectRoot,
        intendedUntracked: ["../escape"] as never,
      }),
    ).toThrow(ValidationError);
    expect(() =>
      buildReviewAssessArgv({ binary: "gentle-ai", projectRoot, intendedUntracked: "a.ts" as never }),
    ).toThrow(ValidationError);
  });
});

describe("review assess untracked declaration allowlist and forwarding", () => {
  test("reviewAssess accepts the declaration keys and rejects neighbours", () => {
    expect(() =>
      assertPayloadKeys("reviewAssess", {
        projectDir: "/repo",
        untrackedScope: "select",
        expectedUntrackedInventory: digest("d"),
        intendedUntracked: ["a.ts"],
      }),
    ).not.toThrow();
    expect(() =>
      assertPayloadKeys("reviewAssess", { projectDir: "/repo", untrackedScopeX: "select" }),
    ).toThrow(ValidationError);
  });

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

  function request(payload: Record<string, unknown>): BrokerRequestEnvelope {
    return {
      version: 1,
      id: "req-reviewAssess",
      operation: "reviewAssess",
      sessionID: "session-1",
      payload,
    };
  }

  test("buildReviewAssessOp forwards the declaration to the runtime", async () => {
    const { ctx, calls } = makeCtx();
    const inventory = digest("e");
    await buildReviewAssessOp(ctx)(
      request({
        projectDir: "/repo",
        baseRef: "refs/heads/main",
        committedOnly: true,
        untrackedScope: "exclude",
        expectedUntrackedInventory: inventory,
      }),
    );
    expect(calls).toEqual([
      {
        method: "reviewAssess",
        payload: {
          projectDir: "/repo",
          baseRef: "refs/heads/main",
          committedOnly: true,
          untrackedScope: "exclude",
          expectedUntrackedInventory: inventory,
        },
      },
    ]);
  });
});

describe("review assess untracked declaration runtime wiring", () => {
  function makeExecutor(spawn: SpawnFn): SddRuntimeExecutor {
    return new SddRuntimeExecutor({
      binary: "gentle-ai",
      projects: [{ id: "repo", path: configuredProjectRoot }],
      spawn,
    });
  }

  test("reviewAssess maps the declaration into the exact spawned argv", async () => {
    const calls: Array<{ argv: string[]; cwd: string | undefined }> = [];
    const spawn: SpawnFn = async (argv, options) => {
      calls.push({ argv: [...argv], cwd: options.cwd });
      return { status: 0, stdout: "{}", stderr: "", timedOut: false };
    };
    const executor = makeExecutor(spawn);
    const inventory = digest("f");

    await executor.reviewAssess({
      projectDir: configuredProjectRoot,
      baseRef: "origin/main",
      committedOnly: true,
      untrackedScope: "select",
      expectedUntrackedInventory: inventory,
      intendedUntracked: ["AGENTS.md"],
    });

    expect(calls).toEqual([
      {
        argv: [
          "gentle-ai",
          "review",
          "assess",
          "--cwd",
          projectRoot,
          "--base-ref",
          "origin/main",
          "--committed-only",
          "--untracked-scope=select",
          `--expected-untracked-inventory=${inventory}`,
          "--intended-untracked=AGENTS.md",
          "--json",
        ],
        cwd: projectRoot,
      },
    ]);
  });
});
