/**
 * gentle-ai 4 pre-upgrade step 1: the five SDD operations are dormant unless
 * the broker resolved legacy SDD as enabled. Review operations share the SDD
 * runtime files and must never be gated. Plan: docs/upgrades/gentle-ai-4.md.
 */
import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config.ts";
import {
  LEGACY_SDD_OPERATIONS,
  detectGentleAiMajor,
  parseGentleAiMajor,
  parseLegacySddMode,
  resolveLegacySdd,
} from "../src/legacy-sdd.ts";
import { PolicyError } from "../src/policy.ts";
import {
  buildReviewAssessOp,
  buildReviewModeStatusOp,
  buildReviewStatusOp,
  buildSddArchiveComposeOp,
  buildSddAttemptGrantOp,
  buildSddContinueOp,
  buildSddStatusOp,
  buildSddTaskResultOp,
  type SddOpContext,
} from "../src/sdd-service.ts";
import type { BrokerRequestEnvelope } from "../src/types.ts";
import { ValidationError } from "../src/validation.ts";

const ORCHESTRATOR = "gentle-orchestrator";

function makeCtx(legacySddEnabled: boolean): { ctx: SddOpContext; calls: string[] } {
  const calls: string[] = [];
  const config = defaultConfig({
    readOnlyAgents: [ORCHESTRATOR],
    sddRuntime: { legacySddEnabled },
  });
  const runtime = new Proxy(
    {},
    {
      get: (_target, name) => async () => {
        calls.push(String(name));
        return { status: 0, json: {}, stderr: "", text: "" };
      },
    },
  );
  const ctx = {
    config,
    store: {
      get: () => ({
        sessionID: "session-1",
        state: "HOST_READ_ONLY",
        agent: ORCHESTRATOR,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    },
    sddRuntime: runtime,
  } as unknown as SddOpContext;
  return { ctx, calls };
}

function request(operation: string, payload: Record<string, unknown>): BrokerRequestEnvelope {
  return {
    version: 1,
    id: `req-${operation}`,
    operation,
    sessionID: "session-1",
    agent: ORCHESTRATOR,
    payload,
  } as BrokerRequestEnvelope;
}

const SDD_CASES: Array<[string, (ctx: SddOpContext) => (req: BrokerRequestEnvelope) => Promise<unknown>, Record<string, unknown>]> = [
  ["sddStatus", buildSddStatusOp, { projectDir: "/repo" }],
  ["sddContinue", buildSddContinueOp, { projectDir: "/repo" }],
  ["sddTaskResult", buildSddTaskResultOp, { projectDir: "/repo", phase: "apply", input: "task.json" }],
  ["sddArchiveCompose", buildSddArchiveComposeOp, { projectDir: "/repo", canonical: "a.md", delta: "b.md", output: "c.md" }],
  [
    "sddAttemptGrant",
    buildSddAttemptGrantOp,
    {
      projectDir: "/repo",
      change: "agent-host-tools",
      roots: ["/home/james/a"],
      changeInstance: "instance-token",
      requestId: "grant-request",
      actor: ORCHESTRATOR,
      reason: "widen",
    },
  ],
];

describe("legacy SDD mode parsing", () => {
  test("unset or empty means auto; on/off/auto are accepted", () => {
    expect(parseLegacySddMode(undefined)).toBe("auto");
    expect(parseLegacySddMode("")).toBe("auto");
    expect(parseLegacySddMode("auto")).toBe("auto");
    expect(parseLegacySddMode("on")).toBe("on");
    expect(parseLegacySddMode("off")).toBe("off");
  });

  test("any other value is refused rather than guessed", () => {
    expect(() => parseLegacySddMode("yes")).toThrow(ValidationError);
    expect(() => parseLegacySddMode("ON")).toThrow(ValidationError);
  });

  test("the gentle-ai major version is read from --version output", () => {
    expect(parseGentleAiMajor("gentle-ai 3.7.0\n")).toBe(3);
    expect(parseGentleAiMajor("gentle-ai 4.0.0")).toBe(4);
    expect(parseGentleAiMajor("gentle-ai v4.1.2")).toBe(4);
    expect(parseGentleAiMajor("something else")).toBeNull();
    expect(parseGentleAiMajor("")).toBeNull();
  });
});

describe("legacy SDD resolution", () => {
  test("auto enables SDD only below major 4", () => {
    expect(resolveLegacySdd("auto", 3)).toEqual({ enabled: true });
    expect(resolveLegacySdd("auto", 4)).toEqual({ enabled: false });
    expect(resolveLegacySdd("auto", 5)).toEqual({ enabled: false });
  });

  test("auto fails closed when the version cannot be read", () => {
    const r = resolveLegacySdd("auto", null);
    expect(r.enabled).toBe(false);
    expect(r.warning).toContain("could not be determined");
  });

  test("explicit settings win, with a warning when they disagree with the version", () => {
    expect(resolveLegacySdd("on", 3)).toEqual({ enabled: true });
    expect(resolveLegacySdd("off", 4)).toEqual({ enabled: false });
    expect(resolveLegacySdd("on", 4).enabled).toBe(true);
    expect(resolveLegacySdd("on", 4).warning).toContain("gentle-ai 4");
    expect(resolveLegacySdd("off", 3).enabled).toBe(false);
    expect(resolveLegacySdd("off", 3).warning).toContain("gentle-ai 3");
  });

  test("version detection runs '<binary> --version' and tolerates failure", async () => {
    const seen: string[][] = [];
    const ok = await detectGentleAiMajor("gentle-ai", async (argv) => {
      seen.push([...argv]);
      return { status: 0, stdout: "gentle-ai 3.7.0\n", stderr: "", timedOut: false };
    });
    expect(ok).toBe(3);
    expect(seen).toEqual([["gentle-ai", "--version"]]);
    const failed = await detectGentleAiMajor("gentle-ai", async () => ({
      status: 1,
      stdout: "",
      stderr: "not found",
      timedOut: false,
    }));
    expect(failed).toBeNull();
    const thrown = await detectGentleAiMajor("gentle-ai", async () => {
      throw new Error("spawn failed");
    });
    expect(thrown).toBeNull();
  });
});

describe("SDD operation gate", () => {
  test("the default configuration fails closed", () => {
    expect(defaultConfig().sddRuntime.legacySddEnabled).toBe(false);
  });

  test("the gated set is exactly the five SDD operations", () => {
    expect([...LEGACY_SDD_OPERATIONS].sort()).toEqual(
      ["sddArchiveCompose", "sddAttemptGrant", "sddContinue", "sddStatus", "sddTaskResult"],
    );
  });

  for (const [operation, build, payload] of SDD_CASES) {
    test(`${operation} refuses with the dormancy message when disabled, before reaching gentle-ai`, async () => {
      const { ctx, calls } = makeCtx(false);
      const run = build(ctx)(request(operation, payload));
      await expect(run).rejects.toBeInstanceOf(PolicyError);
      await expect(build(ctx)(request(operation, payload))).rejects.toThrow("SDD retired in gentle-ai 4");
      expect(calls).toEqual([]);
    });
  }

  test("an enabled SDD operation reaches the runtime", async () => {
    const { ctx, calls } = makeCtx(true);
    await buildSddStatusOp(ctx)(request("sddStatus", { projectDir: "/repo" }));
    expect(calls.length).toBe(1);
  });

  test("review operations are never gated", async () => {
    const { ctx, calls } = makeCtx(false);
    await buildReviewAssessOp(ctx)(request("reviewAssess", { projectDir: "/repo" }));
    await buildReviewModeStatusOp(ctx)(request("reviewModeStatus", { projectDir: "/repo" }));
    await buildReviewStatusOp(ctx)(request("reviewStatus", { projectDir: "/repo" }));
    expect(calls.length).toBe(3);
  });
});
