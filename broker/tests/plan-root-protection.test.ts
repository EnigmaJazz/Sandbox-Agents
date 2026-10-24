import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { buildApplyOp, buildApplyResultOp, buildSandboxResultInstallOp, buildWriteFileOp, type OpContext } from "../src/service.ts";
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

function makeWorkerContext(planRootProtection: boolean): {
  ctx: OpContext;
  calls: string[][];
} {
  const stateDir = mkdtempSync(join(tmpdir(), "plan-root-worker-"));
  mkdirSync(join(stateDir, "tmp"), { recursive: true });
  stateDirs.push(stateDir);
  const calls: string[][] = [];
  const ctx = {
    config: defaultConfig({ stateDir, projects: [{ id: "repo", path: "/repo" }], planRootProtection }),
    store: { get: () => ({
      sessionID: "worker-session",
      state: "SANDBOX_ACTIVE",
      workerName: "worker",
      workerState: "ACTIVE",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }) },
    adapter: {
      exec: async (_worker: string, argv: string[]) => {
        calls.push(argv);
        const isMissingPathCheck = argv[0] === "stat" || argv[0] === "test";
        return { status: isMissingPathCheck ? 1 : 0, stdout: "", stderr: "", timedOut: false };
      },
      copyIn: async () => undefined,
    },
  } as unknown as OpContext;
  return { ctx, calls };
}

const workerRequest = (operation: "writeFile" | "applyPatch", payload: Record<string, unknown>): BrokerRequestEnvelope => ({
  version: 1,
  id: `worker-${operation}`,
  operation,
  sessionID: "worker-session",
  payload,
});

function makeInstallContext(planRootProtection: boolean): OpContext {
  const stateDir = mkdtempSync(join(tmpdir(), "plan-root-install-"));
  stateDirs.push(stateDir);
  const root = process.cwd();
  const records: Record<string, SessionRecord> = {
    "install-session": {
      sessionID: "install-session", state: "HOST_READ_ONLY", agent: "gentle-orchestrator",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    },
    "result-session": {
      sessionID: "result-session", projectID: "repo", state: "RESULT_READY",
      baselineRef: "refs/opencode-sandbox/baseline/result-session",
      resultRef: "refs/opencode-sandbox/result/result-session",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    },
  };
  return {
    config: defaultConfig({
      stateDir,
      readOnlyAgents: ["gentle-orchestrator"],
      projects: [{ id: "repo", path: root }],
      planRootProtection,
    }),
    store: {
      get: (id: string) => records[id],
      touch: (id: string, patch: Partial<SessionRecord>) => (records[id] = { ...records[id]!, ...patch }),
    },
    adapter: {}, budget: {}, resources: {}, pool: { allocations: [] }, hostRead: { has: () => false }, logger: {},
    git: {
      runnerMode: "planned",
      spawn: async (argv: string[]) => {
        if (argv[1] === "rev-parse") return { status: 0, stdout: `${"a".repeat(40)}\n`, stderr: "", timedOut: false };
        if (argv.includes("--name-only")) return { status: 0, stdout: "odd/tasks/x.md\0", stderr: "", timedOut: false };
        if (argv.includes("--raw")) return { status: 0, stdout: ":000000 100644 0000000 1111111 A\todd/tasks/x.md\n", stderr: "", timedOut: false };
        return { status: 0, stdout: "", stderr: "", timedOut: false };
      },
    },
  } as unknown as OpContext;
}

const installRequestForPlanRoot: BrokerRequestEnvelope = {
  version: 1, id: "install-plan-root", operation: "sandboxResultInstall", sessionID: "install-session",
  agent: "gentle-orchestrator",
  payload: { projectDir: process.cwd(), sandboxSessionID: "result-session", expectedResultCommit: "a".repeat(40) },
};

describe("early plan-root protection", () => {
  test.each(["odd/tasks/x.md", "odd/mini/y.md"])("refuses sandbox_write to %s before worker access", async (path) => {
    const { ctx, calls } = makeWorkerContext(true);
    await expect(buildWriteFileOp(ctx)(workerRequest("writeFile", { path, content: "x" })))
      .rejects.toThrow(`PLAN_ROOT_PROTECTED: ${path} is a plan-root path; workers may not modify it (BROKER_PLAN_ROOT_PROTECTION)`);
    expect(calls).toHaveLength(0);
  });

  test.each(["odd/tasks/x.md", "odd/mini/y.md"])("refuses edit-op target %s before worker access", async (path) => {
    const { ctx, calls } = makeWorkerContext(true);
    await expect(buildWriteFileOp(ctx)(workerRequest("writeFile", { path, content: "x" })))
      .rejects.toThrow("PLAN_ROOT_PROTECTED");
    expect(calls).toHaveLength(0);
  });

  test("refuses apply-patch paths named in the payload before worker access", async () => {
    const { ctx, calls } = makeWorkerContext(true);
    await expect(buildApplyOp(ctx)(workerRequest("applyPatch", { patch: "", paths: ["odd/tasks/x.md"] })))
      .rejects.toThrow("PLAN_ROOT_PROTECTED");
    expect(calls).toHaveLength(0);
  });

  test("allows unrelated worker mutation and all plan-root mutations when disabled", async () => {
    const enabled = makeWorkerContext(true);
    await buildWriteFileOp(enabled.ctx)(workerRequest("writeFile", { path: "docs/a.md", content: "x" }));
    expect(enabled.calls.length).toBeGreaterThan(0);

    for (const path of ["odd/tasks/x.md", "odd/mini/y.md"]) {
      const disabled = makeWorkerContext(false);
      await buildWriteFileOp(disabled.ctx)(workerRequest("writeFile", { path, content: "x" }));
      expect(disabled.calls.length).toBeGreaterThan(0);
      const patch = makeWorkerContext(false);
      await buildApplyOp(patch.ctx)(workerRequest("applyPatch", { patch: "" }));
      expect(patch.calls.length).toBeGreaterThan(0);
    }
  });
});

describe("sandboxResultInstall plan-root protection", () => {
  test("refuses plan-root results when protection is enabled", async () => {
    await expect(buildSandboxResultInstallOp(makeInstallContext(true))(installRequestForPlanRoot))
      .rejects.toThrow("odd/tasks/x.md");
  });

  test("installs plan-root results when protection is disabled", async () => {
    const result = await buildSandboxResultInstallOp(makeInstallContext(false))(installRequestForPlanRoot) as { installed: boolean };
    expect(result.installed).toBe(true);
  });
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
