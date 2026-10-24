import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { buildApplyResultOp, type OpContext } from "../src/service.ts";
import type { BrokerRequestEnvelope, SessionRecord, SessionState } from "../src/types.ts";

const stateDirs: string[] = [];
const originalPlanRootProtection = process.env.BROKER_PLAN_ROOT_PROTECTION;
const applyRequest: BrokerRequestEnvelope = {
  version: 1,
  id: "apply-request",
  operation: "applyResult",
  sessionID: "apply-session",
  payload: { confirm: "APPLY" },
};

function makeApplyContext(changedPath: string, planRootProtection?: boolean): {
  ctx: OpContext;
  calls: string[][];
} {
  const stateDir = mkdtempSync(join(tmpdir(), "plan-root-protection-"));
  stateDirs.push(stateDir);
  let record: SessionRecord = {
    sessionID: "apply-session",
    projectID: "repo",
    state: "RESULT_READY",
    workerName: "worker-apply-session",
    workerState: "ACTIVE",
    baselineRef: "refs/opencode-sandbox/baseline/apply-session",
    resultRef: "refs/opencode-sandbox/result/apply-session",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const store = {
    get: () => record,
    touch: (_sessionID: string, patch: Partial<SessionRecord> = {}) => {
      record = { ...record, ...patch };
      return record;
    },
    transition: (_sessionID: string, from: SessionState, to: SessionState, patch: Partial<SessionRecord> = {}) => {
      if (record.state !== from) throw new Error(`unexpected state ${record.state}, expected ${from}`);
      record = { ...record, ...patch, state: to };
      return record;
    },
  };
  const ok = (stdout = "") => ({
    status: 0,
    stdout,
    stderr: "",
    timedOut: false,
    outputTruncated: false,
    stderrTruncated: false,
  });
  const calls: string[][] = [];
  const ctx = {
    config: defaultConfig({
      stateDir,
      projects: [{ id: "repo", path: "/repo" }],
      ...(planRootProtection === undefined ? {} : { planRootProtection }),
    }),
    store,
    adapter: { stop: async () => undefined, remove: async () => undefined },
    pool: { allocations: [] },
    hostRead: { has: () => false },
    logger: {},
    resources: {},
    budget: {},
    git: {
      runnerMode: "real",
      spawn: async (argv: string[]) => {
        calls.push(argv);
        if (argv.includes("ls-files")) return ok("100644 base 0\topenspec/link\n");
        if (argv.includes("ls-tree")) return ok("100644 blob base\topenspec/link\n");
        if (argv.includes("--name-only")) return ok(`${changedPath}\0`);
        return ok("");
      },
    },
  } as unknown as OpContext;
  return { ctx, calls };
}

afterEach(() => {
  for (const stateDir of stateDirs.splice(0)) rmSync(stateDir, { recursive: true, force: true });
  if (originalPlanRootProtection === undefined) delete process.env.BROKER_PLAN_ROOT_PROTECTION;
  else process.env.BROKER_PLAN_ROOT_PROTECTION = originalPlanRootProtection;
});

describe("apply-time plan-root protection", () => {
  test.each(["odd/tasks/some-task.md", "odd/mini/some-plan.md"])(
    "allows %s when plan-root protection is disabled",
    async (path) => {
      delete process.env.BROKER_PLAN_ROOT_PROTECTION;
      const { ctx, calls } = makeApplyContext(path);
      const result = await buildApplyResultOp(ctx)(applyRequest) as { applied?: boolean };
      expect(result.applied).toBe(true);
      expect(calls.some((argv) => argv.includes("apply"))).toBe(true);
    },
  );

  test.each(["odd/tasks/some-task.md", "odd/mini/some-plan.md"])(
    "refuses %s when plan-root protection is enabled and names the path",
    async (path) => {
      const { ctx, calls } = makeApplyContext(path, true);
      await expect(buildApplyResultOp(ctx)(applyRequest)).rejects.toThrow(
        `result touches protected paths (S7/S17): ${path}`,
      );
      expect(calls.some((argv) => argv.includes("apply"))).toBe(false);
    },
  );

  test("keeps the existing S17 protection when plan-root protection is enabled", async () => {
    const path = "broker/src/service.ts";
    const { ctx } = makeApplyContext(path, true);
    await expect(buildApplyResultOp(ctx)(applyRequest)).rejects.toThrow(
      `result touches protected paths (S7/S17): ${path}`,
    );
  });

  test("allows unrelated changes when plan-root protection is enabled", async () => {
    const { ctx, calls } = makeApplyContext("docs/README.md", true);
    const result = await buildApplyResultOp(ctx)(applyRequest) as { applied?: boolean };
    expect(result.applied).toBe(true);
    expect(calls.some((argv) => argv.includes("apply"))).toBe(true);
  });
});

describe("BROKER_PLAN_ROOT_PROTECTION parsing", () => {
  const originalValue = process.env.BROKER_PLAN_ROOT_PROTECTION;

  afterEach(() => {
    if (originalValue === undefined) delete process.env.BROKER_PLAN_ROOT_PROTECTION;
    else process.env.BROKER_PLAN_ROOT_PROTECTION = originalValue;
  });

  test.each([
    ["1", true],
    ["true", true],
    ["TRUE", true],
    [undefined, false],
    ["0", false],
    ["false", false],
  ] as const)("parses %s as %s", (value, expected) => {
    if (value === undefined) delete process.env.BROKER_PLAN_ROOT_PROTECTION;
    else process.env.BROKER_PLAN_ROOT_PROTECTION = value;
    expect(defaultConfig().planRootProtection).toBe(expected);
  });
});
