/**
 * Worker-release failure injection (docs/TODO.md Tier 2 item 15).
 *
 * `releaseWorker` used to swallow a failed `msb remove` (and every caller then
 * cleared `workerName` / set `DESTROYED`), orphaning the VM from every release
 * path and the sweep. These tests make `adapter.remove` THROW and assert that a
 * failed release:
 *   - returns `{ released: false, reason: "remove-failed" }`,
 *   - stops once and retries `remove` at most twice,
 *   - keeps the session's pool allocation and does NOT drain the parked queue,
 *   - logs `release_worker_failed` (and a `logger: {}` context does not crash),
 *   - leaves `workerName` set and `workerState` not DESTROYED on the discard,
 *     keep, apply, destroy and sweep paths (including a PAUSED worker, which
 *     the pre-fix ACTIVE-only guard never even attempted to release).
 * They also cover the no-worker path, the double-release identity guard, the
 * discard state/ref guards, a transient failure that succeeds on retry, a
 * throwing `stop`/`removeConfigDir`, every `sweepIdle` branch and the
 * `sweepUnfinished` export branch on removal failure. Each fails if the typed
 * outcome or the identity-keyed allocation removal is reverted.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import {
  buildApplyResultOp,
  buildDestroyWorkerOp,
  buildDiscardResultOp,
  buildKeepResultOp,
  releaseWorker,
  type OpContext,
} from "../src/service.ts";
import { MsbError } from "../src/msb.ts";
import { sweepIdle, sweepUnfinished } from "../src/reaper.ts";
import { StateError } from "../src/state.ts";
import type { BrokerRequestEnvelope, SessionRecord } from "../src/types.ts";

const GiB = 1024 * 1024 * 1024;
const dirs: string[] = [];
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `broker-release-${tag}-`));
  dirs.push(d);
  return d;
}

function record(partial: Partial<SessionRecord> & { sessionID: string }): SessionRecord {
  const now = new Date().toISOString();
  return {
    sessionID: partial.sessionID,
    state: "RESULT_READY",
    projectID: "repo",
    resultRef: `refs/opencode-sandbox/result/${partial.sessionID}`,
    baselineRef: `refs/opencode-sandbox/baseline/${partial.sessionID}`,
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

interface QueuedEntryStub {
  sessionID: string;
}

interface Harness {
  ctx: OpContext;
  records: Record<string, SessionRecord>;
  stopped: string[];
  removed: string[];
  logs: Array<Record<string, unknown>>;
  headCalls: () => number;
}

/** The identity-keyed allocation this harness seeds for a session. */
const alloc = (sessionID: string) => ({ cpu: 2, memBytes: 2 * GiB, sessionID });

function makeHarness(opts: {
  initial: SessionRecord[];
  allocations?: Array<{ cpu: number; memBytes: number; sessionID: string }>;
  /** Every `remove` call throws. */
  removeThrows?: boolean;
  /** The first N `remove` calls throw, then removal succeeds. */
  removeFailures?: number;
  stopThrows?: boolean;
  removeConfigDirThrows?: boolean;
  logger?: unknown;
  runnerMode?: "planned" | "real";
  spawn?: OpContext["git"]["spawn"];
  exec?: OpContext["adapter"]["exec"];
  withQueue?: boolean;
}): Harness {
  const records: Record<string, SessionRecord> = {};
  for (const r of opts.initial) records[r.sessionID] = r;
  const stopped: string[] = [];
  const removed: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  let headCallCount = 0;

  const store = {
    list: () => Object.values(records),
    get: (id: string) => records[id],
    touch: (id: string, patch: Partial<SessionRecord> = {}) => {
      const current = records[id];
      if (!current) throw new Error(`no record ${id}`);
      const next = { ...current, ...patch };
      records[id] = next;
      return next;
    },
    transition: (
      id: string,
      from: SessionRecord["state"],
      to: SessionRecord["state"],
      patch: Partial<SessionRecord> = {},
    ) => {
      const current = records[id];
      if (!current) throw new Error(`no record ${id}`);
      if (current.state !== from) {
        throw new Error(`state mismatch ${current.state} != ${from}`);
      }
      const next = { ...current, ...patch, state: to };
      records[id] = next;
      return next;
    },
  };

  const adapter = {
    stop: async (name: string) => {
      stopped.push(name);
      if (opts.stopThrows) throw new Error("msb stop failed (status 1)");
    },
    remove: async (name: string) => {
      removed.push(name);
      const failures =
        opts.removeFailures ?? (opts.removeThrows ? Number.POSITIVE_INFINITY : 0);
      if (removed.length <= failures) {
        throw new Error("msb remove failed (status 1)");
      }
    },
    removeConfigDir: async () => {
      if (opts.removeConfigDirThrows) throw new Error("config dir removal failed");
    },
    exec:
      opts.exec ??
      (async () => ({ status: 0, stdout: "", stderr: "", timedOut: false })),
  };

  // A minimal queue whose only observable behavior is whether the release path
  // drained it: `head()` is consulted exactly once per drain attempt. It always
  // returns undefined so no worker is actually created.
  const queue = opts.withQueue
    ? {
        find: () => undefined,
        head: (): QueuedEntryStub | undefined => {
          headCallCount++;
          return undefined;
        },
        remove: () => undefined,
        inFlight: 0,
      }
    : undefined;

  const allocations = opts.allocations ?? opts.initial.map((r) => alloc(r.sessionID));

  const ctx = {
    config: defaultConfig({
      stateDir: tempDir("state"),
      projects: [{ id: "repo", path: tempDir("proj") }],
    }),
    store,
    adapter,
    budget: {
      perWorkerCpu: 2,
      perWorkerMemBytes: 2 * GiB,
      maxAggregateCpu: 16,
      maxAggregateMemBytes: 16 * GiB,
      maxWorkers: 8,
      hostReservedCpu: 2,
      hostReservedMemBytes: 2 * GiB,
    },
    resources: { cpuCount: 16, totalMemBytes: 32 * GiB },
    pool: { allocations },
    queue,
    activeLocks: new Map<string, number>(),
    hostRead: { has: () => false, execute: async () => ({}) },
    logger: opts.logger ?? {
      log: (entry: Record<string, unknown>) => logs.push(entry),
    },
    git: {
      runnerMode: opts.runnerMode ?? "planned",
      spawn:
        opts.spawn ??
        (async () => ({ status: 0, stdout: "", stderr: "", timedOut: false })),
    },
  } as unknown as OpContext;

  return {
    ctx,
    records,
    stopped,
    removed,
    logs,
    headCalls: () => headCallCount,
  };
}

function request(
  operation: BrokerRequestEnvelope["operation"],
  sessionID: string,
  payload: Record<string, unknown>,
): BrokerRequestEnvelope {
  return { version: 1, id: `req-${operation}`, operation, sessionID, payload };
}

function workerRecord(
  sessionID: string,
  extra: Partial<SessionRecord> = {},
): SessionRecord {
  return record({
    sessionID,
    workerName: `worker-${sessionID}`,
    workerState: "ACTIVE",
    resources: { cpu: 2, memBytes: 2 * GiB },
    ...extra,
  });
}

const RELEASE_FAILED_LOG = {
  operation: "releaseWorker",
  action: "release_worker_failed",
  result: "error",
  error: "msb remove failed (status 1)",
};

describe("releaseWorker typed outcome", () => {
  test("a throwing remove returns remove-failed, retries twice, logs, keeps the allocation and does not drain", async () => {
    const h = makeHarness({
      initial: [workerRecord("s1")],
      removeThrows: true,
      withQueue: true,
    });

    const outcome = await releaseWorker(h.ctx, h.records["s1"]!);

    expect(outcome).toEqual({
      released: false,
      reason: "remove-failed",
      error: "msb remove failed (status 1)",
    });
    expect(h.stopped).toEqual(["worker-s1"]);
    expect(h.removed).toHaveLength(2); // bounded 2-attempt retry, never more
    expect(h.ctx.pool.allocations).toEqual([alloc("s1")]);
    expect(h.headCalls()).toBe(0); // a failed release must not drain the queue
    expect(h.logs).toContainEqual({ sessionID: "s1", ...RELEASE_FAILED_LOG });
  });

  test("a logger-less context does not crash a failed release", async () => {
    const h = makeHarness({
      initial: [workerRecord("s1")],
      removeThrows: true,
      logger: {},
    });

    const outcome = await releaseWorker(h.ctx, h.records["s1"]!);
    expect(outcome.released).toBe(false);
    expect(outcome.reason).toBe("remove-failed");
  });

  test("a worker-less record returns no-worker and still frees its leaked allocation", async () => {
    const h = makeHarness({
      initial: [
        record({ sessionID: "leak", workerName: undefined, workerState: undefined }),
      ],
      allocations: [alloc("leak")],
      withQueue: true,
    });

    const outcome = await releaseWorker(h.ctx, h.records["leak"]!);
    expect(outcome).toEqual({ released: true, reason: "no-worker" });
    // The leaked allocation is identity-keyed and must be reconciled even
    // though there is no VM to remove.
    expect(h.ctx.pool.allocations).toEqual([]);
    expect(h.headCalls()).toBeGreaterThanOrEqual(1); // success path drains
  });

  test("a repeat release cannot debit another session's equal-sized allocation", async () => {
    const h = makeHarness({
      initial: [workerRecord("a"), workerRecord("b")],
      allocations: [alloc("a"), alloc("b")],
    });

    await releaseWorker(h.ctx, h.records["a"]!);
    await releaseWorker(h.ctx, h.records["a"]!);

    expect(h.ctx.pool.allocations).toEqual([alloc("b")]);
  });

  test("a transient remove failure retries and releases on the second attempt", async () => {
    const h = makeHarness({
      initial: [workerRecord("s2")],
      removeFailures: 1,
      withQueue: true,
    });

    const outcome = await releaseWorker(h.ctx, h.records["s2"]!);

    expect(outcome).toEqual({ released: true, reason: "removed" });
    expect(h.stopped).toEqual(["worker-s2"]); // stop exactly once
    expect(h.removed).toEqual(["worker-s2", "worker-s2"]); // retried once
    expect(h.ctx.pool.allocations).toEqual([]);
    expect(h.headCalls()).toBeGreaterThanOrEqual(1); // a freed slot drains
    expect(h.logs).toEqual([]); // an eventual success is not a failure
  });

  test("a throwing stop does not block a successful removal", async () => {
    const h = makeHarness({
      initial: [workerRecord("s3")],
      stopThrows: true,
      withQueue: true,
    });

    const outcome = await releaseWorker(h.ctx, h.records["s3"]!);

    expect(outcome).toEqual({ released: true, reason: "removed" });
    expect(h.stopped).toEqual(["worker-s3"]);
    expect(h.removed).toEqual(["worker-s3"]);
    expect(h.ctx.pool.allocations).toEqual([]);
    expect(h.headCalls()).toBeGreaterThanOrEqual(1);
  });

  test("a throwing removeConfigDir does not block the VM release", async () => {
    const h = makeHarness({
      initial: [workerRecord("s4")],
      removeConfigDirThrows: true,
    });

    const outcome = await releaseWorker(h.ctx, h.records["s4"]!);

    expect(outcome).toEqual({ released: true, reason: "removed" });
    expect(h.ctx.pool.allocations).toEqual([]);
    expect(h.logs).toEqual([]);
  });
});

describe("failed release retains ownership on every path", () => {
  test("discard from RESULT_READY completes but keeps the worker", async () => {
    const h = makeHarness({ initial: [workerRecord("d1")], removeThrows: true });

    const result = await buildDiscardResultOp(h.ctx)(
      request("discardResult", "d1", { confirm: "REJECT" }),
    );

    expect(result).toEqual({ state: "REJECTED" });
    const rec = h.records["d1"]!;
    expect(rec.state).toBe("REJECTED");
    expect(rec.workerName).toBe("worker-d1");
    expect(rec.workerState).toBe("ACTIVE");
    expect(h.ctx.pool.allocations).toEqual([alloc("d1")]);
    expect(h.logs).toContainEqual({ sessionID: "d1", ...RELEASE_FAILED_LOG });
  });

  test("discard from RETAINED fails before any mutation", async () => {
    const h = makeHarness({
      initial: [workerRecord("r1", { state: "RETAINED" })],
    });

    await expect(
      buildDiscardResultOp(h.ctx)(
        request("discardResult", "r1", { confirm: "REJECT" }),
      ),
    ).rejects.toThrow(StateError);

    expect(h.records["r1"]!.state).toBe("RETAINED");
    expect(h.records["r1"]!.resultRef).toBe("refs/opencode-sandbox/result/r1");
    expect(h.stopped).toEqual([]);
    expect(h.removed).toEqual([]);
    expect(h.ctx.pool.allocations).toEqual([alloc("r1")]);
  });

  test("discard fails closed when git update-ref -d fails", async () => {
    const spawn: OpContext["git"]["spawn"] = async (argv) => {
      if (argv.includes("update-ref")) {
        return { status: 1, stdout: "", stderr: "boom", timedOut: false };
      }
      return { status: 0, stdout: "", stderr: "", timedOut: false };
    };
    const h = makeHarness({
      initial: [workerRecord("u1")],
      runnerMode: "real",
      spawn,
    });

    await expect(
      buildDiscardResultOp(h.ctx)(
        request("discardResult", "u1", { confirm: "REJECT" }),
      ),
    ).rejects.toThrow(/result ref deletion failed/);

    expect(h.records["u1"]!.state).toBe("RESULT_READY");
    expect(h.records["u1"]!.resultRef).toBe("refs/opencode-sandbox/result/u1");
    expect(h.removed).toEqual([]);
    expect(h.ctx.pool.allocations).toEqual([alloc("u1")]);
  });

  test("keepResult retains the worker when remove fails", async () => {
    const h = makeHarness({ initial: [workerRecord("k1")], removeThrows: true });

    // Pre-existing gap outside this unit's surfaces: `keepResult` is absent
    // from ALLOWED_PAYLOAD_KEYS (broker/src/validation.ts), so a real
    // `keepResult` envelope is rejected before the handler body. Label the
    // envelope `applyResult` (also confirm-gated) purely to admit the payload
    // so the keep branch's release logic is exercised. Reported separately.
    const result = (await buildKeepResultOp(h.ctx)(
      request("applyResult", "k1", { confirm: "KEEP" }),
    )) as { retained?: boolean };

    expect(result.retained).toBe(true);
    const rec = h.records["k1"]!;
    expect(rec.state).toBe("RETAINED");
    expect(rec.workerName).toBe("worker-k1");
    expect(rec.workerState).toBe("ACTIVE");
    expect(h.ctx.pool.allocations).toEqual([alloc("k1")]);
  });

  test("keepResult releases a PAUSED worker, not only an ACTIVE one, and keeps it on failure", async () => {
    const h = makeHarness({
      initial: [workerRecord("p1", { workerState: "PAUSED" })],
      removeThrows: true,
    });

    const result = (await buildKeepResultOp(h.ctx)(
      request("applyResult", "p1", { confirm: "KEEP" }),
    )) as { retained?: boolean };

    expect(result.retained).toBe(true);
    const rec = h.records["p1"]!;
    expect(rec.state).toBe("RETAINED");
    // The pre-fix code skipped any non-ACTIVE worker entirely; the release must
    // be ATTEMPTED (stop + two remove calls) and ownership kept on failure.
    expect(h.stopped).toEqual(["worker-p1"]);
    expect(h.removed).toHaveLength(2);
    expect(rec.workerName).toBe("worker-p1");
    expect(rec.workerState).toBe("PAUSED");
    expect(h.ctx.pool.allocations).toEqual([alloc("p1")]);
  });

  test("destroyWorker throws and keeps the worker when remove fails", async () => {
    const h = makeHarness({ initial: [workerRecord("x1")], removeThrows: true });

    await expect(
      buildDestroyWorkerOp(h.ctx)(request("destroyWorker", "x1", {})),
    ).rejects.toThrow(MsbError);

    expect(h.records["x1"]!.workerName).toBe("worker-x1");
    expect(h.records["x1"]!.workerState).toBe("ACTIVE");
    expect(h.ctx.pool.allocations).toEqual([alloc("x1")]);
  });

  test("destroyWorker attempts a PAUSED worker and keeps it when remove fails", async () => {
    const h = makeHarness({
      initial: [workerRecord("p2", { workerState: "PAUSED" })],
      removeThrows: true,
    });

    await expect(
      buildDestroyWorkerOp(h.ctx)(request("destroyWorker", "p2", {})),
    ).rejects.toThrow(MsbError);

    expect(h.stopped).toEqual(["worker-p2"]);
    expect(h.removed).toHaveLength(2);
    expect(h.records["p2"]!.workerName).toBe("worker-p2");
    expect(h.records["p2"]!.workerState).toBe("PAUSED");
    expect(h.ctx.pool.allocations).toEqual([alloc("p2")]);
  });

  test("destroyWorker reconciles a stray allocation on an already-DESTROYED record", async () => {
    const h = makeHarness({
      initial: [workerRecord("dw1", { workerState: "DESTROYED" })],
      allocations: [alloc("dw1")],
    });

    const result = await buildDestroyWorkerOp(h.ctx)(
      request("destroyWorker", "dw1", {}),
    );

    expect(result).toEqual({ destroyed: true, worker: "worker-dw1" });
    // The VM is gone, but its leaked allocation must not escape identity-keyed
    // removal.
    expect(h.ctx.pool.allocations).toEqual([]);
    expect(h.stopped).toEqual([]);
    expect(h.removed).toEqual([]);
  });

  test("applyResult lands but keeps the worker when remove fails", async () => {
    const spawn: OpContext["git"]["spawn"] = async (argv) => {
      const ok = (stdout = "") => ({
        status: 0,
        stdout,
        stderr: "",
        timedOut: false,
      });
      if (argv.includes("ls-files")) return ok("100644 base 0\tf.txt\n");
      if (argv.includes("ls-tree")) return ok("100644 blob base\tf.txt\n");
      if (argv.includes("--name-only")) return ok("f.txt\u0000");
      if (argv.includes("--raw")) return ok("");
      if (argv.includes("diff")) return ok("+added\n");
      return ok();
    };
    const h = makeHarness({
      initial: [workerRecord("a1")],
      removeThrows: true,
      runnerMode: "real",
      spawn,
    });

    const result = (await buildApplyResultOp(h.ctx)(
      request("applyResult", "a1", { confirm: "APPLY" }),
    )) as { applied?: boolean };

    expect(result.applied).toBe(true);
    const rec = h.records["a1"]!;
    expect(rec.state).toBe("APPLIED");
    // A landed apply must never be undone by a failed release...
    expect(rec.workerName).toBe("worker-a1");
    expect(rec.workerState).toBe("ACTIVE");
    // ...and the failed release must retain the identity-keyed allocation and
    // leave the failure visible instead of silently orphaning the VM.
    expect(h.ctx.pool.allocations).toEqual([alloc("a1")]);
    expect(h.logs).toContainEqual({ sessionID: "a1", ...RELEASE_FAILED_LOG });
  });

  test("sweepIdle leaves a terminal record for the next sweep when remove fails", async () => {
    const h = makeHarness({
      initial: [workerRecord("sw1", { state: "REJECTED" })],
      removeThrows: true,
      withQueue: true,
    });

    const { reaped } = await sweepIdle(h.ctx, 3_600_000);

    expect(reaped).toBe(0);
    const rec = h.records["sw1"]!;
    expect(rec.workerName).toBe("worker-sw1");
    expect(rec.workerState).toBe("ACTIVE");
    expect(rec.reapedAt).toBeUndefined();
    expect(h.ctx.pool.allocations).toEqual([alloc("sw1")]);
    expect(h.headCalls()).toBe(0); // no drain on a failed release
  });

  test("sweepIdle keeps a stale RESULT_READY worker and allocation when remove fails", async () => {
    const h = makeHarness({
      initial: [
        workerRecord("sw2", { state: "RESULT_READY", updatedAt: iso(3_700_000) }),
      ],
      removeThrows: true,
      withQueue: true,
    });

    const { reaped } = await sweepIdle(h.ctx, 3_600_000);

    expect(reaped).toBe(0);
    const rec = h.records["sw2"]!;
    expect(rec.state).toBe("RESULT_READY");
    expect(rec.workerName).toBe("worker-sw2");
    expect(rec.workerState).toBe("ACTIVE");
    expect(rec.reapedAt).toBeUndefined();
    expect(h.ctx.pool.allocations).toEqual([alloc("sw2")]);
    expect(h.headCalls()).toBe(0);
  });

  test("sweepIdle keeps a stale SANDBOX_ACTIVE worker and allocation when remove fails", async () => {
    const h = makeHarness({
      initial: [
        workerRecord("sw3", { state: "SANDBOX_ACTIVE", updatedAt: iso(3_700_000) }),
      ],
      removeThrows: true,
      withQueue: true,
    });

    const { reaped } = await sweepIdle(h.ctx, 3_600_000);

    expect(reaped).toBe(0);
    const rec = h.records["sw3"]!;
    expect(rec.state).toBe("SANDBOX_ACTIVE");
    expect(rec.workerName).toBe("worker-sw3");
    expect(rec.workerState).toBe("ACTIVE");
    expect(rec.reapedAt).toBeUndefined();
    expect(h.ctx.pool.allocations).toEqual([alloc("sw3")]);
    expect(h.headCalls()).toBe(0);
  });

  test("sweepUnfinished exports edits but retains the worker when remove fails", async () => {
    const h = makeHarness({
      initial: [
        workerRecord("f1", {
          state: "SANDBOX_ACTIVE",
          resultRef: undefined,
          updatedAt: iso(70_000),
        }),
      ],
      removeThrows: true,
      exec: async () => ({
        status: 0,
        stdout: " M src/a.ts\n",
        stderr: "",
        timedOut: false,
      }),
      withQueue: true,
    });
    const entries: Array<{ sessionID: string; action: string; detail?: string }> = [];

    const { finished } = await sweepUnfinished(
      h.ctx,
      60_000,
      (entry) => entries.push(entry),
      undefined,
      async (_ctx, id) => `refs/opencode-sandbox/result/${id}`,
    );

    // The export landed, so the session was auto-finished...
    expect(finished).toBe(1);
    const rec = h.records["f1"]!;
    expect(rec.state).toBe("RESULT_READY");
    expect(rec.resultRef).toBe("refs/opencode-sandbox/result/f1");
    // ...but the worker could not be removed and must stay owned for the sweep.
    expect(rec.workerName).toBe("worker-f1");
    expect(rec.workerState).toBe("ACTIVE");
    expect(h.ctx.pool.allocations).toEqual([alloc("f1")]);
    // A distinct action marks "finished but still retained", never a plain
    // fully-released `auto_finished`.
    expect(entries).toEqual([
      {
        sessionID: "f1",
        action: "auto_finished_retained",
        detail: "refs/opencode-sandbox/result/f1 (worker retained for the next sweep)",
      },
    ]);
    expect(h.headCalls()).toBe(0);
  });

  test("sweepUnfinished does not count a clean worker whose release failed", async () => {
    const h = makeHarness({
      initial: [
        workerRecord("c1", {
          state: "SANDBOX_ACTIVE",
          resultRef: undefined,
          updatedAt: iso(70_000),
        }),
      ],
      removeThrows: true,
      withQueue: true,
    });
    const entries: Array<{ sessionID: string; action: string }> = [];

    // Default exec returns a clean worker, so no export happens and the release
    // failure is the only outcome.
    const { finished } = await sweepUnfinished(
      h.ctx,
      60_000,
      (entry) => entries.push(entry),
    );

    expect(finished).toBe(0);
    const rec = h.records["c1"]!;
    expect(rec.state).toBe("SANDBOX_ACTIVE");
    expect(rec.workerName).toBe("worker-c1");
    expect(rec.workerState).toBe("ACTIVE");
    expect(h.ctx.pool.allocations).toEqual([alloc("c1")]);
    expect(entries.map((entry) => entry.action)).toEqual(["error"]);
    expect(h.headCalls()).toBe(0);
  });
});
