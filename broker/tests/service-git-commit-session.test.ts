import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config.ts";
import { buildGitCommitOp, type OpContext } from "../src/service.ts";
import { StateError } from "../src/state.ts";
import { ValidationError } from "../src/validation.ts";
import type { BrokerRequestEnvelope, SessionRecord } from "../src/types.ts";

const ORCHESTRATOR = "gentle-orchestrator";
const projectRoot = process.cwd();

function request(payload: Record<string, unknown>): BrokerRequestEnvelope {
  return {
    version: 1,
    id: "req-gitCommit",
    operation: "gitCommit",
    sessionID: "session-1",
    agent: ORCHESTRATOR,
    payload,
  };
}

/** The orchestrator's own session: authorised but with no applied result. */
const orchestratorRecord: SessionRecord = {
  sessionID: "session-1",
  state: "HOST_READ_ONLY",
  agent: ORCHESTRATOR,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/** A delegated worker session that already applied its B→C result. */
function appliedResultRecord(
  sessionID: string,
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    sessionID,
    state: "APPLIED",
    projectID: "test",
    baselineRef: `refs/opencode-sandbox/baseline/${sessionID}`,
    resultRef: `refs/opencode-sandbox/result/${sessionID}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeCtx(
  spawn: OpContext["git"]["spawn"],
  records: Record<string, SessionRecord>,
): OpContext {
  const config = defaultConfig({
    readOnlyAgents: [ORCHESTRATOR],
    projects: [{ id: "test", path: projectRoot }],
  });
  return {
    config,
    store: { get: (sessionID: string) => records[sessionID] },
    adapter: {},
    budget: {},
    resources: {},
    pool: { allocations: [] },
    hostRead: { has: () => false },
    logger: {},
    git: { runnerMode: "planned", spawn },
  } as unknown as OpContext;
}

function spawnStub(
  rules: Array<[RegExp, { status: number; stdout: string; stderr: string }]>,
) {
  const calls: string[][] = [];
  const spawn: OpContext["git"]["spawn"] = async (argv) => {
    calls.push(argv);
    for (const [pattern, result] of rules) {
      if (pattern.test(argv.join(" "))) return { ...result, timedOut: false };
    }
    return { status: 0, stdout: "", stderr: "", timedOut: false };
  };
  return { calls, spawn };
}

const NAME_ONLY = /diff --name-only/;

describe("gitCommit cross-session applied result", () => {
  test("commits exactly the explicit sandboxSessionID's applied result paths", async () => {
    const { calls, spawn } = spawnStub([[NAME_ONLY, { status: 0, stdout: "a.ts\u0000", stderr: "" }]]);
    const ctx = makeCtx(spawn, {
      "session-1": orchestratorRecord,
      "worker-7": appliedResultRecord("worker-7"),
    });
    const result = (await buildGitCommitOp(ctx)(
      request({
        projectDir: projectRoot,
        message: "fix: delegated",
        sandboxSessionID: "worker-7",
      }),
    )) as { committed?: boolean; paths?: string[] };
    expect(result.committed).toBe(true);
    expect(result.paths).toEqual(["a.ts"]);
    expect(calls).toContainEqual([
      "git",
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      "refs/opencode-sandbox/baseline/worker-7",
      "refs/opencode-sandbox/result/worker-7",
      "--",
      ".",
    ]);
    expect(calls).toContainEqual(["git", "add", "--", "a.ts"]);
    expect(calls).toContainEqual(["git", "commit", "-m", "fix: delegated", "--", "a.ts"]);
    expect(calls.flatMap((c) => c).join(" ")).not.toContain("-A");
  });

  test("refuses an unknown sandboxSessionID without committing", async () => {
    const { calls, spawn } = spawnStub([[NAME_ONLY, { status: 0, stdout: "a.ts\u0000", stderr: "" }]]);
    const ctx = makeCtx(spawn, { "session-1": orchestratorRecord });
    await expect(
      buildGitCommitOp(ctx)(
        request({ projectDir: projectRoot, message: "m", sandboxSessionID: "ghost" }),
      ),
    ).rejects.toThrow(StateError);
    expect(calls.some((c) => c[1] === "commit")).toBe(false);
  });

  test("refuses a sandboxSessionID that has no applied result", async () => {
    const { calls, spawn } = spawnStub([]);
    const ctx = makeCtx(spawn, {
      "session-1": orchestratorRecord,
      "worker-7": appliedResultRecord("worker-7", { state: "RESULT_READY" }),
    });
    await expect(
      buildGitCommitOp(ctx)(
        request({ projectDir: projectRoot, message: "m", sandboxSessionID: "worker-7" }),
      ),
    ).rejects.toThrow(StateError);
    expect(calls).toHaveLength(0);
  });

  test("refuses a sandboxSessionID bound to another project", async () => {
    const { calls, spawn } = spawnStub([]);
    const ctx = makeCtx(spawn, {
      "session-1": orchestratorRecord,
      "worker-7": appliedResultRecord("worker-7", { projectID: "other" }),
    });
    await expect(
      buildGitCommitOp(ctx)(
        request({ projectDir: projectRoot, message: "m", sandboxSessionID: "worker-7" }),
      ),
    ).rejects.toThrow(StateError);
    expect(calls).toHaveLength(0);
  });

  test("refuses a result ref outside the sandbox result namespace", async () => {
    const { calls, spawn } = spawnStub([]);
    const ctx = makeCtx(spawn, {
      "session-1": orchestratorRecord,
      "worker-7": appliedResultRecord("worker-7", { resultRef: "refs/heads/main" }),
    });
    await expect(
      buildGitCommitOp(ctx)(
        request({ projectDir: projectRoot, message: "m", sandboxSessionID: "worker-7" }),
      ),
    ).rejects.toThrow(StateError);
    expect(calls).toHaveLength(0);
  });

  test("refuses a malformed sandboxSessionID without any lookup", async () => {
    const { calls, spawn } = spawnStub([]);
    const ctx = makeCtx(spawn, { "session-1": orchestratorRecord });
    for (const sandboxSessionID of ["../escape", "a/b", "with space", ".hidden"]) {
      await expect(
        buildGitCommitOp(ctx)(
          request({ projectDir: projectRoot, message: "m", sandboxSessionID }),
        ),
      ).rejects.toThrow(ValidationError);
    }
    expect(calls).toHaveLength(0);
  });

  test("still rejects protected S17 paths from the resolved result", async () => {
    const { calls, spawn } = spawnStub([
      [NAME_ONLY, { status: 0, stdout: "broker/src/server.ts\u0000", stderr: "" }],
    ]);
    const ctx = makeCtx(spawn, {
      "session-1": orchestratorRecord,
      "worker-7": appliedResultRecord("worker-7"),
    });
    await expect(
      buildGitCommitOp(ctx)(
        request({ projectDir: projectRoot, message: "m", sandboxSessionID: "worker-7" }),
      ),
    ).rejects.toThrow(StateError);
    expect(calls.some((c) => c[1] === "commit")).toBe(false);
  });

  test("refuses an empty resolved result", async () => {
    const { calls, spawn } = spawnStub([[NAME_ONLY, { status: 0, stdout: "", stderr: "" }]]);
    const ctx = makeCtx(spawn, {
      "session-1": orchestratorRecord,
      "worker-7": appliedResultRecord("worker-7"),
    });
    await expect(
      buildGitCommitOp(ctx)(
        request({ projectDir: projectRoot, message: "m", sandboxSessionID: "worker-7" }),
      ),
    ).rejects.toThrow(StateError);
    expect(calls.some((c) => c[1] === "commit")).toBe(false);
  });
});

describe("gitCommit without an explicit identifier", () => {
  test("keeps the caller's own applied result", async () => {
    const { calls, spawn } = spawnStub([[NAME_ONLY, { status: 0, stdout: "a.ts\u0000", stderr: "" }]]);
    const ctx = makeCtx(spawn, {
      "session-1": appliedResultRecord("session-1", { agent: ORCHESTRATOR }),
    });
    const result = (await buildGitCommitOp(ctx)(
      request({ projectDir: projectRoot, message: "fix: own" }),
    )) as { committed?: boolean; paths?: string[] };
    expect(result.committed).toBe(true);
    expect(calls).toContainEqual([
      "git",
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      "refs/opencode-sandbox/baseline/session-1",
      "refs/opencode-sandbox/result/session-1",
      "--",
      ".",
    ]);
  });

  test("refuses a caller whose own applied result is bound to another project", async () => {
    const { calls, spawn } = spawnStub([
      [NAME_ONLY, { status: 0, stdout: "a.ts\u0000", stderr: "" }],
    ]);
    const ctx = makeCtx(spawn, {
      "session-1": appliedResultRecord("session-1", { agent: ORCHESTRATOR, projectID: "other" }),
    });
    await expect(
      buildGitCommitOp(ctx)(request({ projectDir: projectRoot, message: "m" })),
    ).rejects.toThrow(/not bound to this project/);
    expect(calls.some((c) => c[1] === "commit")).toBe(false);
  });

  test("still refuses a caller with no applied result", async () => {
    const { calls, spawn } = spawnStub([]);
    const ctx = makeCtx(spawn, { "session-1": orchestratorRecord });
    await expect(
      buildGitCommitOp(ctx)(request({ projectDir: projectRoot, message: "m" })),
    ).rejects.toThrow("cannot commit: no applied B→C result for this session");
    expect(calls).toHaveLength(0);
  });
});
