/**
 * Orca report bridge (S1–S6): tests for the fixed-binary, fixed-argv host
 * operation. No test runs the real `orca` CLI: the spawn is injected and every
 * argv is asserted exactly. The binary is `process.execPath` (an existing
 * absolute file) with a fake spawn, so the availability gate is exercised
 * without executing anything.
 */
import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config.ts";
import type { SpawnFn, SpawnResult } from "../src/msb.ts";
import {
  buildOrcaDispatchProbeArgv,
  buildOrcaReportArgv,
  ORCA_ASK_TIMEOUT_MS,
  parseOrcaDispatchProbe,
} from "../src/orca.ts";
import { PolicyError } from "../src/policy.ts";
import { buildToolAdmissionOp, authorizeHostDispatch, buildOrcaReportOp } from "../src/service.ts";
import { StateError } from "../src/state.ts";
import { OPERATIONS, SANDBOX_GUARD_CLASS, type BrokerRequestEnvelope } from "../src/types.ts";
import {
  HOST_MUTATION_OPERATIONS,
  HOST_READ_OPERATIONS,
  ValidationError,
  hostToolAccess,
} from "../src/validation.ts";

const BINARY = process.execPath;
const TERMINAL = `term_${"a".repeat(36)}`;
const OTHER_TERMINAL = `term_${"b".repeat(36)}`;
const TASK = "task_0123456789ab";
const DISPATCH = "ctx_0123456789ab";

interface SpawnCall {
  argv: string[];
  opts: unknown;
}

function scriptedSpawn(responses: Array<Partial<SpawnResult>>): {
  spawn: SpawnFn;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const spawn: SpawnFn = async (argv, opts) => {
    calls.push({ argv, opts });
    const next = responses.shift();
    if (next === undefined) throw new Error(`unexpected spawn: ${argv.join(" ")}`);
    return { status: 0, stdout: "", stderr: "", timedOut: false, ...next };
  };
  return { spawn, calls };
}

/** The verified `orchestration worker-show --json` dispatch record for a live dispatch. */
function liveDispatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: DISPATCH,
    taskId: TASK,
    assigneeHandle: TERMINAL,
    status: "dispatched",
    completedAt: null,
    terminationReason: null,
    capabilityRevokedAt: null,
    worker: `wrk_${"c".repeat(36)}`,
    terminal: TERMINAL,
    ...overrides,
  };
}

function probeReply(dispatch: unknown, ok: unknown = true): string {
  return JSON.stringify({ ok, result: { dispatch } });
}

function liveProbe(overrides: Record<string, unknown> = {}): string {
  return probeReply(liveDispatch(overrides));
}

function without(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

function makeCtx(spawn: SpawnFn, agent: string | undefined = "worker") {
  const record = {
    sessionID: "session-1",
    state: "SANDBOX_ACTIVE",
    ...(agent === undefined ? {} : { agent }),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  return {
    config: defaultConfig({ readOnlyAgents: ["gentle-orchestrator"] }),
    store: { get: () => record },
    git: { runnerMode: "real" as const, spawn },
    logger: {},
  } as never;
}

function request(payload: Record<string, unknown>): BrokerRequestEnvelope {
  return { version: 1, id: "req-orca", operation: "orcaReport", sessionID: "session-1", payload };
}

const workerDone = {
  terminal: TERMINAL,
  taskId: TASK,
  dispatchId: DISPATCH,
  type: "worker_done",
  subject: "done",
  body: "Wrote the module and ran the suite.",
  outcome: "succeeded",
} as const;

describe("S1: one fixed binary and one fixed argv per message type", () => {
  test("worker_done argv is exact", () => {
    expect(buildOrcaReportArgv(BINARY, { ...workerDone })).toEqual([
      BINARY,
      "orchestration",
      "send",
      "--from",
      TERMINAL,
      "--type",
      "worker_done",
      "--subject",
      "done",
      "--body",
      "Wrote the module and ran the suite.",
      "--outcome",
      "succeeded",
      "--task-id",
      TASK,
      "--dispatch-id",
      DISPATCH,
    ]);
  });

  test("heartbeat argv is exact and carries no body", () => {
    expect(
      buildOrcaReportArgv(BINARY, {
        terminal: TERMINAL,
        taskId: TASK,
        dispatchId: DISPATCH,
        type: "heartbeat",
        subject: "alive",
        phase: "implementing",
      }),
    ).toEqual([
      BINARY,
      "orchestration",
      "send",
      "--from",
      TERMINAL,
      "--type",
      "heartbeat",
      "--subject",
      "alive",
      "--phase",
      "implementing",
      "--task-id",
      TASK,
      "--dispatch-id",
      DISPATCH,
    ]);
  });

  test("ask argv is exact and the broker fixes the blocking wait", () => {
    expect(
      buildOrcaReportArgv(BINARY, {
        terminal: TERMINAL,
        taskId: TASK,
        dispatchId: DISPATCH,
        type: "ask",
        body: "Which target should I use?",
        options: ["staging", "production"],
      }),
    ).toEqual([
      BINARY,
      "orchestration",
      "ask",
      "--from",
      TERMINAL,
      "--question",
      "Which target should I use?",
      "--timeout-ms",
      String(ORCA_ASK_TIMEOUT_MS),
      "--options",
      "staging,production",
    ]);
  });

  test("an ask without options omits the flag entirely", () => {
    const argv = buildOrcaReportArgv(BINARY, {
      terminal: TERMINAL,
      taskId: TASK,
      dispatchId: DISPATCH,
      type: "ask",
      body: "Status?",
    });
    expect(argv).not.toContain("--options");
  });

  test("the liveness probe is the fixed read-only worker-show argv and never acks", () => {
    const argv = buildOrcaDispatchProbeArgv(BINARY, DISPATCH);
    expect(argv).toEqual([BINARY, "orchestration", "worker-show", "--dispatch", DISPATCH, "--json"]);
    expect(argv).not.toContain("--ack");
    expect(argv).not.toContain("check");
    expect(argv).not.toContain("--terminal");
  });

  test("the operation refuses when the fixed binary does not exist", async () => {
    const { spawn, calls } = scriptedSpawn([]);
    const op = buildOrcaReportOp(makeCtx(spawn), { binary: "/nonexistent/orca-cli" });
    await expect(op(request({ ...workerDone }))).rejects.toThrow(StateError);
    await expect(op(request({ ...workerDone }))).rejects.toThrow(/unavailable/);
    expect(calls).toEqual([]);
  });
});

describe("S2: allowlisted types, no recipient choice, no extra flags", () => {
  test("only worker_done, ask and heartbeat are accepted", () => {
    for (const type of ["message", "worker-failed", "complete", ""]) {
      expect(() => buildOrcaReportArgv(BINARY, { ...workerDone, type: type as never })).toThrow(
        ValidationError,
      );
    }
  });

  test("a worker_done cannot carry a phase or options", () => {
    expect(() => buildOrcaReportArgv(BINARY, { ...workerDone, phase: "implementing" })).toThrow(
      /does not accept 'phase'/,
    );
    expect(() => buildOrcaReportArgv(BINARY, { ...workerDone, options: ["a"] })).toThrow(
      /does not accept 'options'/,
    );
  });

  test("a heartbeat cannot carry a body, outcome or options", () => {
    const base = {
      terminal: TERMINAL,
      taskId: TASK,
      dispatchId: DISPATCH,
      type: "heartbeat" as const,
      subject: "alive",
      phase: "waiting",
    };
    expect(() => buildOrcaReportArgv(BINARY, { ...base, body: "text" })).toThrow(/does not accept 'body'/);
    expect(() => buildOrcaReportArgv(BINARY, { ...base, outcome: "succeeded" })).toThrow(
      /does not accept 'outcome'/,
    );
    expect(() => buildOrcaReportArgv(BINARY, { ...base, options: ["a"] })).toThrow(
      /does not accept 'options'/,
    );
  });

  test("an ask cannot carry a subject, outcome or phase", () => {
    const base = { terminal: TERMINAL, taskId: TASK, dispatchId: DISPATCH, type: "ask" as const, body: "Q?" };
    expect(() => buildOrcaReportArgv(BINARY, { ...base, subject: "s" })).toThrow(/does not accept 'subject'/);
    expect(() => buildOrcaReportArgv(BINARY, { ...base, outcome: "succeeded" })).toThrow(
      /does not accept 'outcome'/,
    );
    expect(() => buildOrcaReportArgv(BINARY, { ...base, phase: "waiting" })).toThrow(
      /does not accept 'phase'/,
    );
  });

  test("the caller cannot choose a recipient or reach another flag", async () => {
    const { spawn, calls } = scriptedSpawn([]);
    const op = buildOrcaReportOp(makeCtx(spawn), { binary: BINARY });
    for (const extra of [{ to: "term_other" }, { from: OTHER_TERMINAL }, { argv: ["rm", "-rf", "/"] }]) {
      await expect(op(request({ ...workerDone, ...extra }))).rejects.toThrow(ValidationError);
      await expect(op(request({ ...workerDone, ...extra }))).rejects.toThrow(/unexpected field/);
    }
    expect(calls).toEqual([]);
  });
});

describe("S3: every field is validated broker-side", () => {
  const reject = (patch: Record<string, unknown>, pattern: RegExp) => {
    expect(() => buildOrcaReportArgv(BINARY, { ...workerDone, ...patch })).toThrow(pattern);
  };

  test("terminal, task id and dispatch id must match their exact patterns", () => {
    reject({ terminal: "term_xyz" }, /terminal handle/);
    reject({ terminal: `term_${"a".repeat(35)}` }, /terminal handle/);
    reject({ terminal: `term_${"A".repeat(36)}` }, /terminal handle/);
    reject({ terminal: `task_${"a".repeat(36)}` }, /terminal handle/);
    reject({ taskId: "task_xyz" }, /task id/);
    reject({ taskId: `task_${"a".repeat(11)}` }, /task id/);
    reject({ dispatchId: "ctx_xyz" }, /dispatch id/);
    reject({ dispatchId: `ctx_${"a".repeat(13)}` }, /dispatch id/);
  });

  test("outcome is one of succeeded, failed, blocked", () => {
    for (const outcome of ["done", "SUCCEEDED", "ok", ""]) reject({ outcome }, /outcome/);
  });

  test("subject is required, at most 120 characters, and one line", () => {
    reject({ subject: "" }, /subject is required/);
    reject({ subject: "x".repeat(121) }, /exceeds 120/);
    reject({ subject: "line\nbreak" }, /control characters/);
    reject({ subject: "-dash" }, /must not start with '-'/);
    expect(() =>
      buildOrcaReportArgv(BINARY, { ...workerDone, subject: "x".repeat(120) }),
    ).not.toThrow();
  });

  test("body is required, at most 4096 UTF-8 bytes, and one line", () => {
    reject({ body: "" }, /body is required/);
    reject({ body: "x".repeat(4097) }, /exceeds 4096 bytes/);
    reject({ body: "line\r\nbreak" }, /control characters/);
    reject({ body: "-dash" }, /must not start with '-'/);
  });

  test("ask options are bounded labels and cannot carry the join character", () => {
    const ask = { terminal: TERMINAL, taskId: TASK, dispatchId: DISPATCH, type: "ask" as const, body: "Q?" };
    expect(() => buildOrcaReportArgv(BINARY, { ...ask, options: "not-an-array" })).toThrow(/array/);
    expect(() => buildOrcaReportArgv(BINARY, { ...ask, options: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] })).toThrow(
      /exceed 8/,
    );
    expect(() => buildOrcaReportArgv(BINARY, { ...ask, options: ["a,b"] })).toThrow(/must not contain/);
    expect(() => buildOrcaReportArgv(BINARY, { ...ask, options: ["-x"] })).toThrow(/must not start with '-'/);
    expect(() => buildOrcaReportArgv(BINARY, { ...ask, options: [""] })).toThrow(/non-empty/);
  });

  test("a heartbeat phase is a short label", () => {
    const beat = {
      terminal: TERMINAL,
      taskId: TASK,
      dispatchId: DISPATCH,
      type: "heartbeat" as const,
      subject: "alive",
    };
    expect(() => buildOrcaReportArgv(BINARY, { ...beat })).toThrow(/phase is required/);
    expect(() => buildOrcaReportArgv(BINARY, { ...beat, phase: "x".repeat(41) })).toThrow(/invalid Orca heartbeat phase/);
    expect(() => buildOrcaReportArgv(BINARY, { ...beat, phase: "-x" })).toThrow(/invalid Orca heartbeat phase/);
  });
});

describe("S4: the liveness probe gates every send", () => {
  /** The exact `orchestration worker-show --json` vector the probe must use. */
  const PROBE_ARGV = [BINARY, "orchestration", "worker-show", "--dispatch", DISPATCH, "--json"];

  /**
   * Run one report against a single scripted probe reply and return the
   * refusal. Every refusal case proves the probe ran exactly once, with the
   * fixed argv, and that the send never ran.
   */
  async function refusal(response: Partial<SpawnResult>): Promise<Error> {
    const { spawn, calls } = scriptedSpawn([response]);
    const op = buildOrcaReportOp(makeCtx(spawn), { binary: BINARY });
    let error: unknown;
    try {
      await op(request({ ...workerDone }));
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(StateError);
    const message = (error as Error).message;
    expect(message.startsWith("orcaReport refused: ")).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]!.argv).toEqual(PROBE_ARGV);
    return error as Error;
  }

  test("a live dispatch sends exactly once after the probe", async () => {
    const { spawn, calls } = scriptedSpawn([{ stdout: liveProbe() }, { status: 0 }]);
    const op = buildOrcaReportOp(makeCtx(spawn), { binary: BINARY });
    const result = (await op(request({ ...workerDone }))) as Record<string, unknown>;
    expect(calls.length).toBe(2);
    expect(calls[0]!.argv).toEqual(PROBE_ARGV);
    expect(calls[1]!.argv).toEqual(buildOrcaReportArgv(BINARY, { ...workerDone }));
    expect(result.delivered).toBe(true);
    expect(result.dispatchState).toBe("dispatched");
    expect(result.type).toBe("worker_done");
  });

  test("the probe argv is exactly the worker-show vector", () => {
    const argv = buildOrcaDispatchProbeArgv(BINARY, DISPATCH);
    expect(argv).toEqual(PROBE_ARGV);
    expect(argv).not.toContain("--ack");
    expect(argv).not.toContain("check");
    expect(argv).not.toContain("--terminal");
  });

  test("a live dispatch is accepted by the parser directly", () => {
    expect(
      parseOrcaDispatchProbe(liveProbe(), { terminal: TERMINAL, taskId: TASK, dispatchId: DISPATCH }),
    ).toEqual({ status: "dispatched" });
  });

  test("an ask reports answered only when the CLI exited cleanly", async () => {
    const ask = { terminal: TERMINAL, taskId: TASK, dispatchId: DISPATCH, type: "ask", body: "Proceed?" };
    const { spawn } = scriptedSpawn([{ stdout: liveProbe() }, { status: 0 }]);
    const op = buildOrcaReportOp(makeCtx(spawn), { binary: BINARY });
    expect(await op(request(ask))).toMatchObject({ answered: true, delivered: true });

    const failed = scriptedSpawn([{ stdout: liveProbe() }, { status: 1 }]);
    const failedOp = buildOrcaReportOp(makeCtx(failed.spawn), { binary: BINARY });
    expect(await failedOp(request(ask))).toMatchObject({ answered: false, delivered: false });
  });

  test("a dispatch bound to another terminal is refused", async () => {
    const error = await refusal({ status: 0, stdout: liveProbe({ assigneeHandle: OTHER_TERMINAL }) });
    expect(error.message).toMatch(/reported assignee/);
  });

  test("a dispatch for another task is refused", async () => {
    const error = await refusal({ status: 0, stdout: liveProbe({ taskId: "task_ffffffffffff" }) });
    expect(error.message).toMatch(/reported task/);
  });

  test("a dispatch for another dispatch id is refused", async () => {
    const error = await refusal({ status: 0, stdout: liveProbe({ id: "ctx_ffffffffffff" }) });
    expect(error.message).toMatch(/reported dispatch/);
  });

  test("a dispatch with any other status is refused", async () => {
    const error = await refusal({ status: 0, stdout: liveProbe({ status: "completed" }) });
    expect(error.message).toMatch(/not live \(status completed\)/);
  });

  test("a dispatch without a status is refused", async () => {
    const error = await refusal({ status: 0, stdout: probeReply(without(liveDispatch(), "status")) });
    expect(error.message).toMatch(/did not report a status/);
  });

  test("a settlement field that is not null is refused", async () => {
    for (const field of ["completedAt", "terminationReason", "capabilityRevokedAt"] as const) {
      const error = await refusal({ status: 0, stdout: liveProbe({ [field]: "2026-01-01T00:00:00.000Z" }) });
      expect(error.message).toMatch(new RegExp(`not live \\(${field} is`));
    }
  });

  test("a settlement field that is missing is refused", async () => {
    for (const field of ["completedAt", "terminationReason", "capabilityRevokedAt"] as const) {
      const error = await refusal({ status: 0, stdout: probeReply(without(liveDispatch(), field)) });
      expect(error.message).toMatch(new RegExp(`did not report ${field}`));
    }
  });

  test("a reply that is not ok is refused", async () => {
    const error = await refusal({ status: 0, stdout: probeReply(liveDispatch(), false) });
    expect(error.message).toMatch(/ok is not true/);
  });

  test("a reply that is not JSON is refused", async () => {
    const error = await refusal({ status: 0, stdout: "not json" });
    expect(error.message).toMatch(/did not return JSON/);
  });

  test("a reply that is not a JSON object is refused", async () => {
    const error = await refusal({ status: 0, stdout: JSON.stringify([1, 2]) });
    expect(error.message).toMatch(/did not return a JSON object/);
  });

  test("a reply without result is refused", async () => {
    const error = await refusal({ status: 0, stdout: JSON.stringify({ ok: true }) });
    expect(error.message).toMatch(/no result object/);
  });

  test("a reply without result.dispatch is refused", async () => {
    const error = await refusal({ status: 0, stdout: JSON.stringify({ ok: true, result: { worker: {} } }) });
    expect(error.message).toMatch(/no dispatch object/);
  });

  test("the old check reply is refused", async () => {
    const checkReply = {
      acknowledged: true,
      cancelled: false,
      connectionLost: false,
      count: 0,
      deliveryId: null,
      dispatchId: null,
      messages: [],
      mutation: null,
      replayed: false,
      runId: null,
      timedOut: false,
    };
    const flat = await refusal({ status: 0, stdout: JSON.stringify(checkReply) });
    expect(flat.message).toMatch(/ok is not true/);
    const wrapped = await refusal({ status: 0, stdout: JSON.stringify({ ok: true, result: checkReply }) });
    expect(wrapped.message).toMatch(/no dispatch object/);
  });

  test("a probe that times out is refused", async () => {
    const error = await refusal({ timedOut: true });
    expect(error.message).toMatch(/timed out/);
  });

  test("a probe that exits non-zero is refused", async () => {
    const error = await refusal({ status: 1, stderr: "no such dispatch" });
    expect(error.message).toMatch(/failed \(status 1\)/);
  });
});

describe("S5: authorization is the shared host-dispatch path, with no approval", () => {
  test("the operation is an open read-access host tool", () => {
    expect(hostToolAccess("orcaReport")).toBe("read");
    expect(HOST_READ_OPERATIONS).toContain("orcaReport");
    expect(HOST_MUTATION_OPERATIONS).not.toContain("orcaReport");
    const ctx = makeCtx(async () => ({ status: 0, stdout: "", stderr: "", timedOut: false }));
    expect(authorizeHostDispatch(ctx, "orcaReport", "session-1", "worker")).toBe("read");
    expect(authorizeHostDispatch(ctx, "orcaReport", "unknown-session", undefined)).toBe("read");
  });

  test("existing host operations are unchanged", () => {
    const ctx = makeCtx(async () => ({ status: 0, stdout: "", stderr: "", timedOut: false }));
    expect(authorizeHostDispatch(ctx, "sandboxResult", "session-1", "worker")).toBe("read");
    expect(() => authorizeHostDispatch(ctx, "gitCommit", "session-1", "worker")).toThrow(PolicyError);
    expect(hostToolAccess("registerProject")).toBe("mutation");
  });
});

describe("S6: registration and admission", () => {
  test("the operation is registered and exempt from the sandbox guard", () => {
    expect(OPERATIONS).toContain("orcaReport");
    expect(SANDBOX_GUARD_CLASS.orcaReport).toBe("exempt-from-sandbox-guard");
  });

  test("V2 admission classifies host_orca_report as CONSULT and allows a worker", async () => {
    const admission = buildToolAdmissionOp({
      store: { get: () => ({ agent: "worker", state: "SANDBOX_ACTIVE", projectID: "repo" }) },
      config: { readOnlyAgents: [] },
    } as never);
    expect(
      await admission({
        version: 1,
        id: "req-admission",
        operation: "toolAdmission",
        sessionID: "session-1",
        payload: { tool: "host_orca_report" },
      } as never),
    ).toMatchObject({ classification: "CONSULT", decision: "allow" });
  });

  test("the isolated evaluation roles cannot report", async () => {
    for (const agent of ["solver", "challenger", "judge", "fresh_eyes"]) {
      const admission = buildToolAdmissionOp({
        store: { get: () => ({ agent, state: "SANDBOX_ACTIVE", projectID: "repo" }) },
        config: { readOnlyAgents: [] },
      } as never);
      expect(
        await admission({
          version: 1,
          id: "req-admission",
          operation: "toolAdmission",
          sessionID: "session-1",
          payload: { tool: "host_orca_report" },
        } as never),
        agent,
      ).toMatchObject({ decision: "deny" });
    }
  });
});
