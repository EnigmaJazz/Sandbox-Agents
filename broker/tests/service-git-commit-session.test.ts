import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config.ts";
import { buildGitClearCommitIntentOp, buildGitCommitOp, type OpContext } from "../src/service.ts";
import { ADVISOR_ALLOWED_OPERATIONS } from "../src/advisor-socket.ts";
import { StateError } from "../src/state.ts";
import { ALLOWED_PAYLOAD_KEYS, HOST_MUTATION_OPERATIONS, HostToolPolicy, ValidationError } from "../src/validation.ts";
import { OPERATIONS, type BrokerRequestEnvelope, type SessionRecord } from "../src/types.ts";

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
    store: {
      get: (sessionID: string) => records[sessionID],
      touch: (sessionID: string, patch: Partial<SessionRecord>) => {
        const next = { ...records[sessionID]!, ...patch };
        records[sessionID] = next;
        return next;
      },
      transition: (
        sessionID: string,
        from: SessionRecord["state"],
        to: SessionRecord["state"],
        patch: Partial<SessionRecord> = {},
      ) => {
        const current = records[sessionID]!;
        if (current.state !== from) throw new Error(`expected ${from}, got ${current.state}`);
        const next = { ...current, ...patch, state: to };
        records[sessionID] = next;
        return next;
      },
    },
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
    if (argv.join(" ") === "git rev-parse HEAD") {
      return { status: 0, stdout: "abcdef0123456789abcdef0123456789abcdef01\n", stderr: "", timedOut: false };
    }
    if (argv[1] === "rev-parse" && argv[2] === "--verify") {
      return { status: 0, stdout: "0123456789abcdef0123456789abcdef01234567\n", stderr: "", timedOut: false };
    }
    return { status: 0, stdout: "", stderr: "", timedOut: false };
  };
  return { calls, spawn };
}

const NAME_ONLY = /diff --name-only/;

describe("gitClearCommitIntent", () => {
  test("clears and reports only the pending intent fields", async () => {
    const intent = {
      resultCommit: "0123456789abcdef0123456789abcdef01234567",
      parentCommit: "abcdef0123456789abcdef0123456789abcdef01",
    };
    const original = appliedResultRecord("session-1", {
      agent: ORCHESTRATOR,
      pendingCommit: intent,
      installedCommit: "1111111111111111111111111111111111111111",
      committedCommit: "2222222222222222222222222222222222222222",
    });
    const records = { "session-1": original };
    const ctx = makeCtx(async () => ({ status: 0, stdout: "", stderr: "", timedOut: false }), records);
    const result = await buildGitClearCommitIntentOp(ctx)({
      ...request({}), operation: "gitClearCommitIntent",
    }) as { cleared: boolean; resultCommit: string; parentCommit: string };

    expect(result).toEqual({ cleared: true, ...intent });
    expect(records["session-1"]).toEqual({ ...original, pendingCommit: undefined });
  });

  test("refuses when the session has no pending intent", async () => {
    const ctx = makeCtx(async () => ({ status: 0, stdout: "", stderr: "", timedOut: false }), {
      "session-1": appliedResultRecord("session-1", { agent: ORCHESTRATOR }),
    });
    await expect(buildGitClearCommitIntentOp(ctx)({
      ...request({}), operation: "gitClearCommitIntent",
    })).rejects.toThrow("no pending commit intent");
  });

  test("rejects caller-supplied path or state fields", async () => {
    const ctx = makeCtx(async () => ({ status: 0, stdout: "", stderr: "", timedOut: false }), {
      "session-1": appliedResultRecord("session-1", {
        agent: ORCHESTRATOR,
        pendingCommit: {
          resultCommit: "0123456789abcdef0123456789abcdef01234567",
          parentCommit: "abcdef0123456789abcdef0123456789abcdef01",
        },
      }),
    });
    await expect(buildGitClearCommitIntentOp(ctx)({
      ...request({ path: "/tmp/state.json" }), operation: "gitClearCommitIntent",
    })).rejects.toThrow("unexpected field 'path'");
    expect(ctx.store.get("session-1")?.pendingCommit).toBeDefined();
  });

  test("authorizes only orchestrators and classifies the operation as a mutation", async () => {
    const intent = {
      resultCommit: "0123456789abcdef0123456789abcdef01234567",
      parentCommit: "abcdef0123456789abcdef0123456789abcdef01",
    };
    expect(OPERATIONS).toContain("gitClearCommitIntent");
    expect(ALLOWED_PAYLOAD_KEYS.gitClearCommitIntent).toEqual([]);
    expect(HOST_MUTATION_OPERATIONS).toContain("gitClearCommitIntent");
    expect(ADVISOR_ALLOWED_OPERATIONS.has("gitClearCommitIntent")).toBe(false);
    expect(new HostToolPolicy([ORCHESTRATOR]).decide("gitClearCommitIntent", "worker-agent").allowed).toBe(false);
    expect(new HostToolPolicy([ORCHESTRATOR]).decide("gitClearCommitIntent", ORCHESTRATOR).allowed).toBe(true);
    const ctx = makeCtx(async () => ({ status: 0, stdout: "", stderr: "", timedOut: false }), {
      "session-1": appliedResultRecord("session-1", { agent: "worker-agent", pendingCommit: intent }),
    });
    await expect(buildGitClearCommitIntentOp(ctx)({
      ...request({}), operation: "gitClearCommitIntent",
    })).rejects.toThrow("orchestrator-only");
    expect(ctx.store.get("session-1")?.pendingCommit).toEqual(intent);
  });

  test("clearing an ambiguous intent lets the next commit attempt proceed", async () => {
    const intent = {
      resultCommit: "0123456789abcdef0123456789abcdef01234567",
      parentCommit: "abcdef0123456789abcdef0123456789abcdef01",
    };
    const { calls, spawn } = spawnStub([
      [NAME_ONLY, { status: 0, stdout: "a.ts\u0000", stderr: "" }],
      [/git rev-parse HEAD\^$/, { status: 0, stdout: "3333333333333333333333333333333333333333\n", stderr: "" }],
      [/git rev-parse HEAD$/, { status: 0, stdout: "4444444444444444444444444444444444444444\n", stderr: "" }],
    ]);
    const ctx = makeCtx(spawn, {
      "session-1": appliedResultRecord("session-1", { agent: ORCHESTRATOR, pendingCommit: intent }),
    });
    await expect(buildGitCommitOp(ctx)(request({ projectDir: projectRoot, message: "fix: recover" })))
      .rejects.toThrow("pending commit state is ambiguous");
    await buildGitClearCommitIntentOp(ctx)({ ...request({}), operation: "gitClearCommitIntent" });
    const result = await buildGitCommitOp(ctx)(request({ projectDir: projectRoot, message: "fix: recover" }));
    expect(result).toMatchObject({ committed: true, alreadyCommitted: false });
    expect(calls.some((argv) => argv[1] === "commit")).toBe(true);
  });
});

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
    ).rejects.toThrow("cannot commit: sandbox session worker-7 has no applied B→C result");
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

  test("commits an installed RESULT_READY result and returns alreadyCommitted on retry", async () => {
    const installedCommit = "0123456789abcdef0123456789abcdef01234567";
    const committedCommit = "abcdef0123456789abcdef0123456789abcdef01";
    const { calls, spawn } = spawnStub([
      [NAME_ONLY, { status: 0, stdout: "a.ts\u0000", stderr: "" }],
      [/rev-parse --verify.*result/, { status: 0, stdout: `${installedCommit}\n`, stderr: "" }],
      [/rev-parse HEAD/, { status: 0, stdout: `${committedCommit}\n`, stderr: "" }],
    ]);
    const records: Record<string, SessionRecord> = {
      "session-1": orchestratorRecord,
      "worker-7": appliedResultRecord("worker-7", {
        state: "RESULT_READY",
        installedCommit,
      }),
    };
    const ctx = makeCtx(spawn, records);
    const op = buildGitCommitOp(ctx);
    const result = (await op(request({
      projectDir: projectRoot,
      message: "fix: delegated",
      sandboxSessionID: "worker-7",
    }))) as { committed?: boolean; alreadyCommitted?: boolean };
    expect(result.committed).toBe(true);
    expect(result.alreadyCommitted).toBe(false);
    expect(records["worker-7"]?.state).toBe("RETAINED");
    expect(records["worker-7"]?.installedCommit).toBe(installedCommit);
    expect(records["worker-7"]?.committedCommit).toBe(committedCommit);
    expect(records["worker-7"]?.pendingCommit).toBeUndefined();

    const retry = (await op(request({
      projectDir: projectRoot,
      message: "fix: delegated",
      sandboxSessionID: "worker-7",
    }))) as { committed?: boolean; alreadyCommitted?: boolean };
    expect(retry.alreadyCommitted).toBe(true);
    expect(calls.filter((call) => call[1] === "commit")).toHaveLength(1);
  });

  test("retries a failed commit when HEAD remains at the recorded parent", async () => {
    const installedCommit = "0123456789abcdef0123456789abcdef01234567";
    const parentCommit = "1111111111111111111111111111111111111111";
    const committedCommit = "abcdef0123456789abcdef0123456789abcdef01";
    let commitAttempts = 0;
    let commitSucceeded = false;
    const calls: string[][] = [];
    const spawn: OpContext["git"]["spawn"] = async (argv) => {
      calls.push(argv);
      let stdout = "";
      let status = 0;
      if (argv.includes("--name-only")) stdout = "a.ts\0";
      else if (argv[1] === "rev-parse" && argv[3]?.includes("result/") && argv[3]?.endsWith("^{commit}")) stdout = `${installedCommit}\n`;
      else if (argv[1] === "rev-parse" && argv[2] === "HEAD") stdout = `${commitSucceeded ? committedCommit : parentCommit}\n`;
      else if (argv[1] === "commit") {
        commitAttempts += 1;
        if (commitAttempts === 1) status = 1;
        else commitSucceeded = true;
      }
      return { status, stdout, stderr: status ? "temporary hook failure" : "", timedOut: false };
    };
    const records: Record<string, SessionRecord> = {
      "session-1": orchestratorRecord,
      "worker-7": appliedResultRecord("worker-7", { state: "RESULT_READY", installedCommit }),
    };
    const op = buildGitCommitOp(makeCtx(spawn, records));
    const req = request({ projectDir: projectRoot, message: "fix: delegated", sandboxSessionID: "worker-7" });
    await expect(op(req)).rejects.toThrow("temporary hook failure");
    expect(records["worker-7"]?.pendingCommit).toEqual({ resultCommit: installedCommit, parentCommit });
    const retry = (await op(req)) as { committed?: boolean; committedCommit?: string };
    expect(retry.committed).toBe(true);
    expect(retry.committedCommit).toBe(committedCommit);
    expect(commitAttempts).toBe(2);
    expect(records["worker-7"]?.pendingCommit).toBeUndefined();
  });

  test("does not create a second commit when the first RETAINED transition is lost", async () => {
    const installedCommit = "0123456789abcdef0123456789abcdef01234567";
    const committedCommit = "abcdef0123456789abcdef0123456789abcdef01";
    const baseCommit = "1111111111111111111111111111111111111111";
    const calls: string[][] = [];
    let commitRan = false;
    const spawn: OpContext["git"]["spawn"] = async (argv) => {
      calls.push(argv);
      let stdout = "";
      if (argv.includes("--name-only")) stdout = "a.ts\0";
      else if (argv[1] === "rev-parse" && argv[3]?.includes("result/") && argv[3]?.endsWith("^{commit}")) stdout = `${installedCommit}\n`;
      else if (argv[1] === "rev-parse" && argv[2] === "HEAD^") stdout = `${baseCommit}\n`;
      else if (argv[1] === "commit") commitRan = true;
      else if (argv[1] === "rev-parse" && argv[2] === "HEAD") stdout = `${commitRan ? committedCommit : baseCommit}\n`;
      else if (argv[1] === "diff" && argv[2] === "--quiet") return { status: 0, stdout: "", stderr: "", timedOut: false };
      return { status: 0, stdout, stderr: "", timedOut: false };
    };
    const records: Record<string, SessionRecord> = {
      "session-1": orchestratorRecord,
      "worker-7": appliedResultRecord("worker-7", { state: "RESULT_READY", installedCommit }),
    };
    const ctx = makeCtx(spawn, records);
    const originalTransition = ctx.store.transition.bind(ctx.store);
    let loseFirstTransition = true;
    ctx.store.transition = (...args) => {
      if (loseFirstTransition) {
        loseFirstTransition = false;
        throw new Error("simulated crash before RETAINED persistence");
      }
      return originalTransition(...args);
    };
    const op = buildGitCommitOp(ctx);
    const req = request({ projectDir: projectRoot, message: "fix: delegated", sandboxSessionID: "worker-7" });
    await expect(op(req)).rejects.toThrow("simulated crash");
    const retry = (await op(req)) as { alreadyCommitted?: boolean; committedCommit?: string };
    expect(retry.alreadyCommitted).toBe(true);
    expect(retry.committedCommit).toBe(committedCommit);
    expect(calls.filter((call) => call[1] === "commit")).toHaveLength(1);
    expect(records["worker-7"]?.pendingCommit).toBeUndefined();
  });

  test("fails closed when HEAD advanced without the pending result proof", async () => {
    const installedCommit = "0123456789abcdef0123456789abcdef01234567";
    const parentCommit = "1111111111111111111111111111111111111111";
    const advancedHead = "abcdef0123456789abcdef0123456789abcdef01";
    const { calls, spawn } = spawnStub([
      [NAME_ONLY, { status: 0, stdout: "a.ts\0", stderr: "" }],
      [/rev-parse --verify.*result/, { status: 0, stdout: `${installedCommit}\n`, stderr: "" }],
      [/rev-parse HEAD\^/, { status: 0, stdout: `${parentCommit}\n`, stderr: "" }],
      [/rev-parse HEAD$/, { status: 0, stdout: `${advancedHead}\n`, stderr: "" }],
      [/diff --quiet/, { status: 1, stdout: "", stderr: "" }],
    ]);
    const records: Record<string, SessionRecord> = {
      "session-1": orchestratorRecord,
      "worker-7": appliedResultRecord("worker-7", {
        state: "RESULT_READY",
        installedCommit,
        pendingCommit: { resultCommit: installedCommit, parentCommit },
      }),
    };
    await expect(buildGitCommitOp(makeCtx(spawn, records))(
      request({ projectDir: projectRoot, message: "fix: delegated", sandboxSessionID: "worker-7" }),
    )).rejects.toThrow(/ambiguous|does not carry/);
    expect(calls.some((call) => call[1] === "commit")).toBe(false);
    expect(records["worker-7"]?.pendingCommit).toBeDefined();
  });

  test("refuses an installed result whose result ref no longer matches installedCommit", async () => {
    const { calls, spawn } = spawnStub([
      [/rev-parse --verify.*result/, { status: 0, stdout: "ffffffffffffffffffffffffffffffffffffffff\n", stderr: "" }],
    ]);
    const ctx = makeCtx(spawn, {
      "session-1": orchestratorRecord,
      "worker-7": appliedResultRecord("worker-7", {
        state: "RESULT_READY",
        installedCommit: "0123456789abcdef0123456789abcdef01234567",
      }),
    });
    await expect(
      buildGitCommitOp(ctx)(request({
        projectDir: projectRoot,
        message: "m",
        sandboxSessionID: "worker-7",
      })),
    ).rejects.toThrow(StateError);
    expect(calls.some((call) => call[1] === "commit")).toBe(false);
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
