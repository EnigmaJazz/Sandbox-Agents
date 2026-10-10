/**
 * Idle reaper tests (Feature 1): stale RESULT_READY / SANDBOX_ACTIVE workers
 * are released (VM destroyed, allocation removed) without breaking the
 * host-side result flow; fresh and workerless records are untouched; one bad
 * record never kills the sweep.
 */
import { describe, expect, jest, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reapOnDisconnect, runReaperSweeps, startReaper, sweepIdle, sweepUnfinished, toReaperLogEntry } from "../src/reaper.ts";
import { buildEnsureWorkerOp } from "../src/service.ts";
import { Logger } from "../src/logging.ts";
import type { OpContext } from "../src/service.ts";
import type { SessionRecord } from "../src/types.ts";

const GiB = 1024 * 1024 * 1024;
const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

interface Harness {
  ctx: OpContext;
  records: Map<string, SessionRecord>;
  stopped: string[];
  removed: string[];
  logs: { sessionID: string; action: string; detail?: string }[];
}

function makeHarness(initial: SessionRecord[], opts: { throwOnTouch?: string } = {}): Harness {
  const records = new Map(initial.map((r) => [r.sessionID, r]));
  const stopped: string[] = [];
  const removed: string[] = [];
  const logs: { sessionID: string; action: string; detail?: string }[] = [];

  const store = {
    list: () => [...records.values()],
    get: (id: string) => records.get(id),
    transition: (id: string, from: string, to: string, patch: Partial<SessionRecord> = {}) => {
      if (id === opts.throwOnTouch) throw new Error(`boom on transition ${id}`);
      const rec = records.get(id);
      if (!rec) throw new Error(`no record ${id}`);
      if (rec.state !== from) throw new Error(`state mismatch: ${rec.state} != ${from}`);
      const next = { ...rec, ...patch, state: to, updatedAt: new Date().toISOString() };
      records.set(id, next);
      return next;
    },
    touch: (id: string, patch: Partial<SessionRecord> = {}) => {
      if (id === opts.throwOnTouch) throw new Error(`boom on touch ${id}`);
      const rec = records.get(id);
      const next: SessionRecord = rec
        ? { ...rec, ...patch, updatedAt: new Date().toISOString() }
        : {
            sessionID: id,
            state: "HOST_READ_ONLY",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            ...patch,
          };
      records.set(id, next);
      return next;
    },
  };

  const adapter = {
    stop: async (name: string) => {
      stopped.push(name);
    },
    remove: async (name: string) => {
      removed.push(name);
    },
    exec: async () => ({ status: 0, stdout: "", stderr: "", timedOut: false }),
  };

  const ctx = {
    store,
    adapter,
    pool: { allocations: [{ cpu: 2, memBytes: 2 * GiB }] },
  } as unknown as OpContext;

  return { ctx, records, stopped, removed, logs };
}

function record(partial: Partial<SessionRecord> & { sessionID: string }): SessionRecord {
  return {
    state: "RESULT_READY",
    projectID: "repo",
    workerName: `worker-${partial.sessionID}`,
    workerState: "ACTIVE",
    resources: { cpu: 2, memBytes: 2 * GiB },
    createdAt: iso(10_000),
    updatedAt: iso(10_000),
    ...partial,
  };
}

describe("idle reaper sweep", () => {
  test("Logger.log contains a throw from dropped-line handling", () => {
    const logger = new Logger({ toConsole: false });
    const internals = logger as unknown as { markDropped: () => void };
    const markDropped = internals.markDropped.bind(logger);
    internals.markDropped = () => {
      markDropped();
      throw new Error("fallback observer failed");
    };

    const resources: { cpu?: number; memBytes?: number; self?: unknown } = {};
    resources.self = resources;
    expect(() => logger.log({ operation: "test", result: "ok", resources })).not.toThrow();
    expect(logger.droppedLogLines).toBe(1);
    logger.close();
  });

  test("a swallowed reaper log throw increments only reaper telemetry drops", async () => {
    const h = makeHarness([
      record({ sessionID: "telemetry-drop", updatedAt: iso(3_700_000) }),
    ]);
    const logger = new Logger({ toConsole: false });

    await sweepIdle(
      h.ctx,
      3_600_000,
      () => { throw new Error("consumer failed"); },
      () => logger.noteReaperTelemetryDrop(),
    );

    expect(logger.droppedReaperTelemetryEvents).toBe(1);
    expect(logger.droppedLogLines).toBe(0);
    logger.close();
  });

  test("a throwing logger does not stop later sweep phases", async () => {
    const h = makeHarness([
      record({ sessionID: "log-throws", updatedAt: iso(3_700_000) }),
    ]);
    let logAttempts = 0;

    await expect(runReaperSweeps(h.ctx, {
      intervalMs: 10,
      idleMs: 3_600_000,
      onLog: () => {
        logAttempts++;
        throw new Error("logger failed");
      },
      onDrop: () => { throw new Error("accounting failed"); },
    })).resolves.toBeUndefined();

    expect(logAttempts).toBeGreaterThanOrEqual(2);
    expect(h.stopped).toEqual(["worker-log-throws"]);
  });

  test("a throwing logger cannot escape the reaper interval callback", async () => {
    const h = makeHarness([
      record({ sessionID: "timer-log-throws", updatedAt: iso(3_700_000) }),
    ]);
    jest.useFakeTimers();
    try {
      const reaper = startReaper(h.ctx, {
        intervalMs: 10,
        idleMs: 3_600_000,
        onLog: () => { throw new Error("logger failed"); },
      });

      expect(() => jest.advanceTimersByTime(10)).not.toThrow();
      let polls = 0;
      while (h.stopped.length === 0 && polls < 20) {
        polls++;
        await Promise.resolve();
      }
      expect(polls, "worker-stop marker poll exhausted after 20 iterations").toBeLessThan(20);
      expect(h.stopped).toEqual(["worker-timer-log-throws"]);
      reaper.stop();
    } finally {
      jest.useRealTimers();
    }
  });
  test("stale RESULT_READY: worker destroyed, allocation removed, record stays RESULT_READY", async () => {
    const h = makeHarness([record({ sessionID: "r1", updatedAt: iso(3_700_000) })]);
    const { reaped } = await sweepIdle(h.ctx, 3_600_000, (e) => h.logs.push(e));

    expect(reaped).toBe(1);
    expect(h.stopped).toEqual(["worker-r1"]);
    expect(h.removed).toEqual(["worker-r1"]);
    expect(h.ctx.pool.allocations).toEqual([]);
    const rec = h.records.get("r1")!;
    expect(rec.state).toBe("RESULT_READY"); // host-side apply flow stays intact
    expect(rec.workerName).toBeUndefined(); // worker cleared from the record
    expect(rec.reapedAt).toBeDefined(); // observability marker
    expect(h.logs[0]?.action).toBe("reaped_result_ready");
  });

  test("stale SANDBOX_ACTIVE releases its worker and remains resumable", async () => {
    const h = makeHarness([
      record({ sessionID: "a1", state: "SANDBOX_ACTIVE", updatedAt: iso(3_700_000) }),
    ]);
    const { reaped } = await sweepIdle(h.ctx, 3_600_000, (e) => h.logs.push(e));

    expect(reaped).toBe(1);
    expect(h.stopped).toEqual(["worker-a1"]);
    expect(h.removed).toEqual(["worker-a1"]);
    expect(h.ctx.pool.allocations).toEqual([]);
    const rec = h.records.get("a1")!;
    expect(rec.state).toBe("SANDBOX_ACTIVE");
    expect(rec.workerName).toBeUndefined();
    expect(rec.workerState).toBe("DESTROYED");
    expect(rec.reapedAt).toBeDefined();
    expect(rec.error).toBeUndefined();
    // Released without an export: the log must say so, not look routine.
    expect(h.logs[0]?.action).toBe("reaped_active_unsaved");
  });

  test("a reaped SANDBOX_ACTIVE session rebuilds on ensureWorker", async () => {
    const h = makeHarness([
      record({ sessionID: "rebuild", state: "SANDBOX_ACTIVE", updatedAt: iso(3_700_000) }),
    ]);
    await sweepIdle(h.ctx, 3_600_000);
    const root = mkdtempSync(join(tmpdir(), "broker-reaper-rebuild-"));
    const stateDir = join(root, "state");
    const projectDir = join(root, "project");
    mkdirSync(stateDir);
    mkdirSync(join(projectDir, ".git"), { recursive: true });
    Object.assign(h.ctx, {
      config: {
        stateDir,
        projects: [{ id: "repo", path: projectDir }],
        workerImage: "test-image",
      },
      budget: { perWorkerCpu: 2, perWorkerMemBytes: 2 * GiB },
      git: {
        runnerMode: "planned",
        spawn: async (argv: string[]) => {
          if (argv[1] === "bundle" && argv[2] === "create") {
            writeFileSync(argv[3]!, "bundle");
          }
          const stdout = argv[1] === "rev-parse" ? "head\n"
            : argv[1] === "write-tree" ? "tree\n"
            : argv[1] === "commit-tree" ? "commit\n"
            : "";
          return { status: 0, stdout, stderr: "", timedOut: false };
        },
      },
    });
    Object.assign(h.ctx.adapter, {
      workerNameFor: (sessionID: string) => `worker-${sessionID}`,
      createWorker: async () => undefined,
      copyIn: async () => undefined,
    });
    try {
      const result = await buildEnsureWorkerOp(h.ctx)({
        version: 1,
        id: "rebuild",
        operation: "ensureWorker",
        sessionID: "rebuild",
        payload: { projectDir },
      });

      expect(result).toEqual({ worker: "worker-rebuild", state: "SANDBOX_ACTIVE", reused: false, snapshot: { commit: "commit", tree: "tree", source: "worktree", headSha: "head" } });
      expect(h.records.get("rebuild")!.workerState).toBe("ACTIVE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("idle clean SANDBOX_ACTIVE releases its worker without closing the session", async () => {
    const h = makeHarness([
      record({ sessionID: "clean", state: "SANDBOX_ACTIVE", updatedAt: iso(70_000) }),
    ]);

    const { finished } = await sweepUnfinished(h.ctx, 60_000, (e) => h.logs.push(e));

    expect(finished).toBe(1);
    expect(h.stopped).toEqual(["worker-clean"]);
    expect(h.removed).toEqual(["worker-clean"]);
    expect(h.records.get("clean")!.state).toBe("SANDBOX_ACTIVE");
    expect(h.records.get("clean")!.workerName).toBeUndefined();
    expect(h.records.get("clean")!.workerState).toBe("DESTROYED");
    expect(h.records.get("clean")!.reapedAt).toBeDefined();
  });

  test("socket-close idle SANDBOX_ACTIVE releases its worker without closing the session", async () => {
    const h = makeHarness([
      record({ sessionID: "disconnected", state: "SANDBOX_ACTIVE", updatedAt: iso(70_000) }),
    ]);

    const reaped = await reapOnDisconnect(h.ctx, "disconnected", 60_000, (e) => h.logs.push(e));

    expect(reaped).toBe(true);
    expect(h.stopped).toEqual(["worker-disconnected"]);
    expect(h.removed).toEqual(["worker-disconnected"]);
    expect(h.records.get("disconnected")!.state).toBe("SANDBOX_ACTIVE");
    expect(h.records.get("disconnected")!.workerName).toBeUndefined();
    expect(h.records.get("disconnected")!.workerState).toBe("DESTROYED");
    expect(h.records.get("disconnected")!.reapedAt).toBeDefined();
  });

  test("socket-close with unexported edits exports them before releasing the worker", async () => {
    const h = makeHarness([
      record({ sessionID: "dirty", state: "SANDBOX_ACTIVE", updatedAt: iso(40_000) }),
    ]);
    Object.assign(h.ctx.adapter, {
      exec: async () => ({ status: 0, stdout: " M src/a.ts\n", stderr: "", timedOut: false }),
    });
    const prepared: string[] = [];

    const reaped = await reapOnDisconnect(h.ctx, "dirty", 30_000, (e) => h.logs.push(e), undefined, async (_ctx, id) => {
      prepared.push(id);
      return `refs/opencode-sandbox/result/${id}`;
    });

    expect(reaped).toBe(true);
    expect(prepared).toEqual(["dirty"]);
    expect(h.removed).toEqual(["worker-dirty"]);
    const rec = h.records.get("dirty")!;
    expect(rec.state).toBe("RESULT_READY");
    expect(rec.resultRef).toBe("refs/opencode-sandbox/result/dirty");
    expect(rec.workerName).toBeUndefined();
    expect(h.logs.map((e) => e.action)).toEqual(["auto_finished"]);
  });

  test("socket-close keeps the worker when the export fails", async () => {
    const h = makeHarness([
      record({ sessionID: "stuck", state: "SANDBOX_ACTIVE", updatedAt: iso(40_000) }),
    ]);
    Object.assign(h.ctx.adapter, {
      exec: async () => { throw new Error("worker unreachable"); },
    });

    const reaped = await reapOnDisconnect(h.ctx, "stuck", 30_000, (e) => h.logs.push(e), undefined, async () => {
      throw new Error("bundle export failed");
    });

    expect(reaped).toBe(false);
    expect(h.stopped).toEqual([]);
    expect(h.removed).toEqual([]);
    expect(h.ctx.pool.allocations).toHaveLength(1);
    const rec = h.records.get("stuck")!;
    expect(rec.state).toBe("SANDBOX_ACTIVE");
    expect(rec.workerName).toBe("worker-stuck");
    expect(h.logs).toEqual([{ sessionID: "stuck", action: "error", detail: "bundle export failed" }]);
  });

  test("socket-close skips a session with an operation in flight or parked in the queue", async () => {
    const h = makeHarness([
      record({ sessionID: "locked", state: "SANDBOX_ACTIVE", updatedAt: iso(40_000) }),
      record({ sessionID: "queued", state: "SANDBOX_ACTIVE", updatedAt: iso(40_000) }),
    ]);
    Object.assign(h.ctx, {
      activeLocks: new Map([["locked", 1]]),
      queue: { find: (id: string) => (id === "queued" ? { sessionID: id } : undefined) },
    });

    expect(await reapOnDisconnect(h.ctx, "locked", 30_000)).toBe(false);
    expect(await reapOnDisconnect(h.ctx, "queued", 30_000)).toBe(false);
    expect(h.stopped).toEqual([]);
    expect(h.records.get("locked")!.workerName).toBe("worker-locked");
    expect(h.records.get("queued")!.workerName).toBe("worker-queued");
  });

  test("the periodic sweep exports unexported edits through the same policy", async () => {
    const h = makeHarness([
      record({ sessionID: "swept", state: "SANDBOX_ACTIVE", updatedAt: iso(70_000) }),
    ]);
    Object.assign(h.ctx.adapter, {
      exec: async () => ({ status: 0, stdout: "?? new.ts\n", stderr: "", timedOut: false }),
    });

    const { finished } = await sweepUnfinished(h.ctx, 60_000, (e) => h.logs.push(e), undefined, async (_ctx, id) => `refs/opencode-sandbox/result/${id}`);

    expect(finished).toBe(1);
    expect(h.records.get("swept")!.state).toBe("RESULT_READY");
    expect(h.records.get("swept")!.workerState).toBe("DESTROYED");
    expect(h.logs).toEqual([{ sessionID: "swept", action: "auto_finished", detail: "refs/opencode-sandbox/result/swept" }]);
  });

  for (const state of ["RETAINED", "APPLIED", "REJECTED", "FAILED_CLOSED"] as const) {
    test(`a session in ${state} that still holds a worker is released on the next sweep`, async () => {
      const h = makeHarness([record({ sessionID: "leak", state, updatedAt: iso(1_000) })]);

      const { reaped } = await sweepIdle(h.ctx, 3_600_000, (e) => h.logs.push(e));

      expect(reaped).toBe(1);
      expect(h.stopped).toEqual(["worker-leak"]);
      expect(h.removed).toEqual(["worker-leak"]);
      expect(h.ctx.pool.allocations).toEqual([]);
      const rec = h.records.get("leak")!;
      expect(rec.state).toBe(state);
      expect(rec.workerName).toBeUndefined();
      expect(rec.workerState).toBe("DESTROYED");
      expect(rec.reapedAt).toBeDefined();
      expect(h.logs).toEqual([{ sessionID: "leak", action: "reaped_terminal" }]);
    });
  }

  test("sessions that are mid-creation or awaiting approval keep their worker", async () => {
    const h = makeHarness([
      record({ sessionID: "creating", state: "CREATING_SANDBOX", workerState: "CREATING", updatedAt: iso(10_000_000) }),
      record({ sessionID: "approving", state: "APPLY_PENDING", updatedAt: iso(10_000_000) }),
    ]);

    const { reaped } = await sweepIdle(h.ctx, 3_600_000);

    expect(reaped).toBe(0);
    expect(h.stopped).toEqual([]);
    expect(h.records.get("creating")!.workerName).toBe("worker-creating");
    expect(h.records.get("approving")!.workerName).toBe("worker-approving");
  });

  test("fresh records are untouched", async () => {
    const h = makeHarness([
      record({ sessionID: "fresh-active", state: "SANDBOX_ACTIVE", updatedAt: iso(1_000) }),
      record({ sessionID: "fresh-ready", updatedAt: iso(1_000) }),
    ]);

    const { reaped } = await sweepIdle(h.ctx, 3_600_000);

    expect(reaped).toBe(0);
    expect(h.stopped).toEqual([]);
    expect(h.removed).toEqual([]);
    expect(h.records.get("fresh-active")!.state).toBe("SANDBOX_ACTIVE");
    expect(h.records.get("fresh-ready")!.state).toBe("RESULT_READY");
  });

  test("workerless records (parked queue sessions, already-destroyed) are never reaped", async () => {
    const h = makeHarness([
      // A session parked in the pool queue has a record but NO worker yet.
      record({
        sessionID: "parked",
        state: "HOST_READ_ONLY",
        workerName: undefined,
        workerState: undefined,
        updatedAt: iso(10_000_000),
      }),
      // Already released worker must not be touched again.
      record({ sessionID: "gone", workerName: "worker-gone", workerState: "DESTROYED", updatedAt: iso(10_000_000) }),
    ]);

    const { reaped } = await sweepIdle(h.ctx, 3_600_000);

    expect(reaped).toBe(0);
    expect(h.stopped).toEqual([]);
    expect(h.removed).toEqual([]);
    expect(h.records.get("parked")!.state).toBe("HOST_READ_ONLY");
    expect(h.records.get("gone")!.state).toBe("RESULT_READY");
  });

  test("a bad record does not kill the sweep", async () => {
    const h = makeHarness(
      [
        record({ sessionID: "bad", updatedAt: iso(10_000_000) }),
        record({ sessionID: "good", updatedAt: iso(10_000_000) }),
      ],
      { throwOnTouch: "bad" },
    );

    const { reaped } = await sweepIdle(h.ctx, 3_600_000, (e) => h.logs.push(e));

    expect(reaped).toBe(1);
    expect(h.stopped).toContain("worker-good");
    expect(h.records.get("good")!.reapedAt).toBeDefined();
    const bad = h.logs.find((e) => e.sessionID === "bad");
    expect(bad?.action).toBe("error");
  });
});

describe("toReaperLogEntry", () => {
  test("auto_finished keeps the result ref as detail", () => {
    const entry = toReaperLogEntry({
      sessionID: "s-ref",
      action: "auto_finished",
      detail: "refs/sandbox/s-ref",
    });

    expect(entry.operation).toBe("reaper");
    expect(entry.sessionID).toBe("s-ref");
    expect(entry.action).toBe("auto_finished");
    expect(entry.result).toBe("ok");
    expect(entry.detail).toBe("refs/sandbox/s-ref");
    expect(entry.error).toBeUndefined();
  });

  test("reaped_active with a detail is distinguishable from auto_finished", () => {
    const released = toReaperLogEntry({
      sessionID: "s-active",
      action: "reaped_active",
      detail: "idle clean worker released",
    });
    const exported = toReaperLogEntry({
      sessionID: "s-active",
      action: "auto_finished",
      detail: "refs/sandbox/s-active",
    });

    expect(released.action).toBe("reaped_active");
    expect(exported.action).toBe("auto_finished");
    expect(released.action).not.toBe(exported.action);
    expect(released.result).toBe("ok");
    expect(released.detail).toBe("idle clean worker released");
    expect(released.error).toBeUndefined();
  });

  test("reaped_active without a detail leaves detail undefined", () => {
    const entry = toReaperLogEntry({ sessionID: "s-no-detail", action: "reaped_active" });

    expect(entry.action).toBe("reaped_active");
    expect(entry.result).toBe("ok");
    expect(entry.detail).toBeUndefined();
    expect(entry.error).toBeUndefined();
  });

  test("error moves the detail into error and leaves detail undefined", () => {
    const entry = toReaperLogEntry({
      sessionID: "s-error",
      action: "error",
      detail: "release failed: adapter unavailable",
    });

    expect(entry.result).toBe("error");
    expect(entry.error).toBe("release failed: adapter unavailable");
    expect(entry.detail).toBeUndefined();
  });

  test("swept_artifact keeps its detail", () => {
    const entry = toReaperLogEntry({
      sessionID: "s-swept",
      action: "swept_artifact",
      detail: "bundle 12 bytes /state/s-swept.bundle",
    });

    expect(entry.result).toBe("ok");
    expect(entry.detail).toBe("bundle 12 bytes /state/s-swept.bundle");
    expect(entry.error).toBeUndefined();
  });
});
