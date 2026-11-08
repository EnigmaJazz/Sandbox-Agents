/**
 * Idle reaper tests (Feature 1): stale RESULT_READY / SANDBOX_ACTIVE workers
 * are released (VM destroyed, allocation removed) without breaking the
 * host-side result flow; fresh and workerless records are untouched; one bad
 * record never kills the sweep.
 */
import { describe, expect, jest, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reapOnDisconnect, releaseUnderPressure, runReaperSweeps, startReaper, sweepIdle, sweepUnfinished, toReaperLogEntry } from "../src/reaper.ts";
import { buildEnsureWorkerOp, withFinishGuard } from "../src/service.ts";
import { Logger } from "../src/logging.ts";
import type { OpContext } from "../src/service.ts";
import type { SessionRecord } from "../src/types.ts";

const GiB = 1024 * 1024 * 1024;
const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
/** Flush pending microtasks and one macrotask (used by the concurrency tests). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
type ExecResult = Awaited<ReturnType<OpContext["adapter"]["exec"]>>;
const cleanStatus = (): ExecResult => ({ status: 0, stdout: "", stderr: "", timedOut: false });
const dirtyStatus = (): ExecResult => ({ status: 0, stdout: " M src/a.ts\n", stderr: "", timedOut: false });

interface Harness {
  ctx: OpContext;
  records: Map<string, SessionRecord>;
  stopped: string[];
  removed: string[];
  logs: { sessionID: string; action: string; detail?: string }[];
  /** Structured entries the pressure pass writes through ctx.logger. */
  pressureLogs: Record<string, unknown>[];
  /** The worker HEAD this harness reports for each seeded session. */
  heads: Map<string, string>;
  /** The HOST-side exported commit this harness reports for each session. */
  exported: Map<string, string>;
  /** Replace the worker status while keeping the rev-parse proof truthful. */
  execStatus(statusFor: (worker: string) => ExecResult): OpContext["adapter"]["exec"];
  /** A stable identity for a session (worker HEAD == exported commit). */
  shaFor(sessionID: string): string;
}

function makeHarness(initial: SessionRecord[], opts: { throwOnTouch?: string } = {}): Harness {
  const records = new Map(initial.map((r) => [r.sessionID, r]));
  const stopped: string[] = [];
  const removed: string[] = [];
  const logs: { sessionID: string; action: string; detail?: string }[] = [];
  const pressureLogs: Record<string, unknown>[] = [];
  // The removal proof is MODELED, never bypassed: every seeded session has a
  // worker HEAD and a host-side exported commit, both this deterministic id.
  // Tests that need a failed proof change `heads`/`exported`, or make the
  // status unreadable; they never get an implicit production shortcut.
  const shaFor = (sessionID: string) =>
    createHash("sha256").update(`export:${sessionID}`).digest("hex").slice(0, 40);
  const heads = new Map<string, string>();
  const exported = new Map<string, string>();
  for (const r of initial) {
    heads.set(r.sessionID, shaFor(r.sessionID));
    exported.set(r.sessionID, shaFor(r.sessionID));
  }
  const idForWorker = (worker: string): string | undefined => {
    if (worker.startsWith("worker-")) return worker.slice("worker-".length);
    return undefined;
  };
  const exportedShaForRef = (ref: string): string | undefined => {
    const name = ref
      .replace(/^refs\/opencode-sandbox\/result\//, "")
      .replace(/\^\{commit\}$/, "");
    for (const id of exported.keys()) {
      if (name === id || name.startsWith(`${id}-`)) return exported.get(id);
    }
    return undefined;
  };
  const workerHead = (worker: string): ExecResult => {
    const id = idForWorker(worker);
    const sha = id ? heads.get(id) : undefined;
    return sha
      ? { status: 0, stdout: `${sha}\n`, stderr: "", timedOut: false }
      : { status: 1, stdout: "", stderr: "", timedOut: false };
  };

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

  const cleanExec = (): ExecResult => ({ status: 0, stdout: "", stderr: "", timedOut: false });
  const adapter = {
    stop: async (name: string) => {
      stopped.push(name);
    },
    remove: async (name: string) => {
      removed.push(name);
    },
    exec: async (worker: string, argv: string[] = []) => {
      // `git rev-parse --verify HEAD` is the worker identity the proof reads.
      if (argv[0] === "git" && argv[1] === "rev-parse") return workerHead(worker);
      return cleanExec();
    },
  };

  // The host side of the proof: a result ref resolves to the exported commit.
  const git = {
    runnerMode: "real" as const,
    spawn: async (argv: string[]) => {
      const refArg = argv[argv.length - 1] ?? "";
      if (argv.includes("rev-parse") && argv.includes("--verify")) {
        const sha = exportedShaForRef(refArg);
        return sha
          ? { status: 0, stdout: `${sha}\n`, stderr: "", timedOut: false }
          : { status: 1, stdout: "", stderr: "", timedOut: false };
      }
      if (argv.includes("ls-remote")) {
        const sha = exportedShaForRef(refArg);
        return sha
          ? { status: 0, stdout: `${sha}\t${refArg}\n`, stderr: "", timedOut: false }
          : { status: 0, stdout: "", stderr: "", timedOut: false };
      }
      return { status: 0, stdout: "", stderr: "", timedOut: false };
    },
  };

  const ctx = {
    store,
    adapter,
    git,
    // Minimal config: the project allowlist the removal proof resolves the
    // exported commit through, and the state dir it looks for a durable bundle.
    config: {
      stateDir: "/tmp/reaper-harness-state",
      projects: [{ id: "repo", path: "/tmp/reaper-harness-repo" }],
      queueMaxLength: 16,
      queueTimeoutMs: 600_000,
      testRunners: [],
    },
    // Identity-keyed allocations (Tier 2 item 15): one per seeded record, so a
    // release frees exactly that session's slot.
    pool: {
      allocations: initial.map((r) => ({
        cpu: 2,
        memBytes: 2 * GiB,
        sessionID: r.sessionID,
      })),
    },
    budget: { perWorkerCpu: 2, perWorkerMemBytes: 2 * GiB, maxWorkers: 4 },
    logger: { log: (entry: Record<string, unknown>) => pressureLogs.push(entry) },
  } as unknown as OpContext;

  // Replace only the STATUS answer: the rev-parse identity stays truthful, so a
  // test can model "dirty" or "unreadable" without faking the proof.
  const execStatus = (statusFor: (worker: string) => ExecResult): OpContext["adapter"]["exec"] =>
    (async (worker: string, argv: string[] = []) => {
      if (argv[0] === "git" && argv[1] === "rev-parse") return workerHead(worker);
      return statusFor(worker);
    }) as OpContext["adapter"]["exec"];

  return { ctx, records, stopped, removed, logs, pressureLogs, heads, exported, execStatus, shaFor };
}

function record(partial: Partial<SessionRecord> & { sessionID: string }): SessionRecord {
  return {
    state: "RESULT_READY",
    projectID: "repo",
    workerName: `worker-${partial.sessionID}`,
    workerState: "ACTIVE",
    resources: { cpu: 2, memBytes: 2 * GiB },
    // A finished session always has a durable result identity; an ACTIVE one
    // has none until it exports (the proof then forces the export).
    ...(partial.state === "SANDBOX_ACTIVE"
      ? {}
      : { resultRef: `refs/opencode-sandbox/result/${partial.sessionID}` }),
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

    // The single telemetry event still threw, and the release still happened:
    // a throwing logger can never stop a later sweep phase.
    expect(logAttempts).toBeGreaterThanOrEqual(1);
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

  test("RESULT_READY is released at age 0 on the first sweep; mid-flight states are untouched", async () => {
    const h = makeHarness([
      // Just exported: no idle wait is allowed, the result is host-side.
      record({ sessionID: "ready-now", updatedAt: new Date().toISOString() }),
      record({
        sessionID: "creating",
        state: "CREATING_SANDBOX",
        workerState: "CREATING",
        updatedAt: new Date().toISOString(),
      }),
      record({
        sessionID: "approving",
        state: "APPLY_PENDING",
        updatedAt: new Date().toISOString(),
      }),
    ]);

    const { reaped } = await sweepIdle(h.ctx, 3_600_000, (e) => h.logs.push(e));

    expect(reaped).toBe(1);
    expect(h.stopped).toEqual(["worker-ready-now"]);
    expect(h.removed).toEqual(["worker-ready-now"]);
    expect(h.ctx.pool.allocations.map((a) => a.sessionID)).toEqual([
      "creating",
      "approving",
    ]);
    const ready = h.records.get("ready-now")!;
    expect(ready.state).toBe("RESULT_READY"); // apply/preview/retain still work
    expect(ready.workerName).toBeUndefined();
    expect(ready.workerState).toBe("DESTROYED");
    expect(ready.reapedAt).toBeDefined();
    expect(h.logs.map((e) => e.action)).toEqual(["reaped_result_ready"]);
    // Positive controls: neither mid-flight record was touched.
    expect(h.records.get("creating")!.workerName).toBe("worker-creating");
    expect(h.records.get("approving")!.workerName).toBe("worker-approving");
  });

  test("a dirty live RESULT_READY is re-exported before release; a clean one is released without an export", async () => {
    const h = makeHarness([
      record({ sessionID: "dirty-ready", resultRef: "refs/opencode-sandbox/result/dirty-ready-old" }),
      record({ sessionID: "clean-ready", resultRef: "refs/opencode-sandbox/result/clean-ready" }),
    ]);
    let dirtyCleared = false;
    h.ctx.adapter.exec = h.execStatus((worker) =>
      worker === "worker-dirty-ready" && !dirtyCleared ? dirtyStatus() : cleanStatus(),
    );
    const prepared: string[] = [];

    const { reaped } = await sweepIdle(
      h.ctx,
      3_600_000,
      (e) => h.logs.push(e),
      undefined,
      async (_ctx, id) => {
        prepared.push(id);
        // The export commits the worker tree: it is clean AFTER the export,
        // which is what makes the re-proof (HEAD == exported tip) pass.
        dirtyCleared = true;
        return `refs/opencode-sandbox/result/${id}-new`;
      },
    );

    expect(reaped).toBe(2);
    // Only the dirty worker needed an export: the clean direction is the
    // positive control that a clean RESULT_READY is released WITHOUT one.
    expect(prepared).toEqual(["dirty-ready"]);
    expect([...h.removed].sort()).toEqual(["worker-clean-ready", "worker-dirty-ready"]);
    const dirty = h.records.get("dirty-ready")!;
    expect(dirty.state).toBe("RESULT_READY"); // apply/preview/retain still work
    expect(dirty.resultRef).toBe("refs/opencode-sandbox/result/dirty-ready-new");
    expect(dirty.resultRef).not.toBe("refs/opencode-sandbox/result/dirty-ready-old");
    expect(dirty.workerName).toBeUndefined();
    expect(dirty.workerState).toBe("DESTROYED");
    const clean = h.records.get("clean-ready")!;
    expect(clean.resultRef).toBe("refs/opencode-sandbox/result/clean-ready");
    expect(clean.workerName).toBeUndefined();
    expect(h.logs.map((e) => e.action).sort()).toEqual(["auto_finished", "reaped_result_ready"]);
  });

  test("an unreadable git status on a live RESULT_READY keeps the worker and logs release_skipped_dirty", async () => {
    const h = makeHarness([
      record({
        sessionID: "unreadable-ready",
        resultRef: "refs/opencode-sandbox/result/unreadable-ready",
      }),
    ]);
    h.ctx.adapter.exec = async () => {
      throw new Error("worker unreachable");
    };
    const prepared: string[] = [];

    const first = await sweepIdle(
      h.ctx,
      3_600_000,
      (e) => h.logs.push(e),
      undefined,
      async (_ctx, id) => {
        prepared.push(id);
        return "refs/opencode-sandbox/result/never";
      },
    );

    expect(first.reaped).toBe(0);
    // An unreadable status is never exported blind and never released.
    expect(prepared).toEqual([]);
    expect(h.stopped).toEqual([]);
    expect(h.removed).toEqual([]);
    const held = h.records.get("unreadable-ready")!;
    expect(held.state).toBe("RESULT_READY");
    expect(held.workerName).toBe("worker-unreadable-ready");
    expect(h.logs.find((e) => e.action === "release_skipped_dirty")).toMatchObject({
      sessionID: "unreadable-ready",
    });

    // Positive control: the SAME record with a readable clean status is released.
    h.ctx.adapter.exec = h.execStatus(() => cleanStatus());
    const second = await sweepIdle(h.ctx, 3_600_000);

    expect(second.reaped).toBe(1);
    expect(h.removed).toEqual(["worker-unreadable-ready"]);
  });

  test("concurrent release attempts stop/remove a worker exactly once; the loser never probes", async () => {
    const h = makeHarness([record({ sessionID: "racy" })]);
    // F3/D4: the status probe runs INSIDE the lifecycle claim, so only the
    // claim owner probes the worker; the losing path skips without touching it.
    const probes: Array<() => void> = [];
    const baseExec = h.execStatus(() => cleanStatus());
    h.ctx.adapter.exec = async (worker: string, argv: string[] = []) => {
      if (argv[0] === "git" && argv[1] === "rev-parse") return baseExec(worker, argv);
      return new Promise<ExecResult>((resolve) => {
        probes.push(() => resolve(cleanStatus()));
      });
    };
    let unblockRemove!: () => void;
    const removeGate = new Promise<void>((resolve) => {
      unblockRemove = resolve;
    });
    h.ctx.adapter.remove = async (name: string) => {
      h.removed.push(name);
      await removeGate;
    };

    const sweep = sweepIdle(h.ctx, 3_600_000, (e) => h.logs.push(e));
    await tick();
    // Only the claim owner probes; the pressure pass has not probed at all.
    expect(probes).toHaveLength(1);
    const pressure = await releaseUnderPressure(h.ctx, "waiting");
    expect(pressure.released).toBe(0);
    expect(probes).toHaveLength(1); // still just the owner's probe

    probes[0]!();
    await tick(); // the sweep is now inside releaseWorker (remove blocked)
    expect(h.removed).toHaveLength(1);

    unblockRemove();
    const sweepResult = await sweep;

    expect(sweepResult.reaped).toBe(1);
    expect(h.stopped).toEqual(["worker-racy"]); // stop exactly once
    expect(h.removed).toEqual(["worker-racy"]); // remove exactly once
    expect(h.pressureLogs.find((e) => e.action === "pressure_skipped")).toMatchObject({
      sessionID: "racy",
    });
  });

  test("a failed removal keeps ownership and allocation, logs, and the next sweep retries", async () => {
    const h = makeHarness([
      record({ sessionID: "retry", updatedAt: new Date().toISOString() }),
    ]);
    const occupancyLogs: Array<Record<string, unknown>> = [];
    Object.assign(h.ctx, {
      logger: {
        log: (entry: Record<string, unknown>) => occupancyLogs.push(entry),
      },
    });
    let removeCalls = 0;
    h.ctx.adapter.remove = async () => {
      removeCalls++;
      // Both attempts of the first release fail; the next sweep succeeds.
      if (removeCalls <= 2) throw new Error("msb remove failed (status 1)");
    };

    const first = await sweepIdle(h.ctx, 3_600_000);

    expect(first.reaped).toBe(0);
    const held = h.records.get("retry")!;
    expect(held.state).toBe("RESULT_READY");
    expect(held.workerName).toBe("worker-retry");
    expect(held.workerState).toBe("ACTIVE");
    expect(h.ctx.pool.allocations).toHaveLength(1);
    expect(occupancyLogs).toContainEqual(
      expect.objectContaining({
        sessionID: "retry",
        action: "release_worker_failed",
        result: "error",
      }),
    );

    const second = await sweepIdle(h.ctx, 3_600_000);

    expect(second.reaped).toBe(1);
    const released = h.records.get("retry")!;
    expect(released.workerName).toBeUndefined();
    expect(released.workerState).toBe("DESTROYED");
    expect(h.ctx.pool.allocations).toEqual([]);
  });

  test("stale clean SANDBOX_ACTIVE is exported, then released and remains resumable", async () => {
    const h = makeHarness([
      record({ sessionID: "a1", state: "SANDBOX_ACTIVE", updatedAt: iso(3_700_000) }),
    ]);
    // Invariant 1: an ACTIVE worker has no durable result yet, so the export
    // runs BEFORE the removal even when the tree is clean.
    const prepared: string[] = [];
    const { reaped } = await sweepIdle(
      h.ctx,
      3_600_000,
      (e) => h.logs.push(e),
      undefined,
      async (_ctx, id) => {
        prepared.push(id);
        return `refs/opencode-sandbox/result/${id}`;
      },
    );

    expect(reaped).toBe(1);
    expect(prepared).toEqual(["a1"]);
    expect(h.stopped).toEqual(["worker-a1"]);
    expect(h.removed).toEqual(["worker-a1"]);
    expect(h.ctx.pool.allocations).toEqual([]);
    const rec = h.records.get("a1")!;
    expect(rec.state).toBe("RESULT_READY");
    expect(rec.resultRef).toBe("refs/opencode-sandbox/result/a1");
    expect(rec.workerName).toBeUndefined();
    expect(rec.workerState).toBe("DESTROYED");
    expect(rec.reapedAt).toBeDefined();
    expect(rec.error).toBeUndefined();
    expect(h.logs[0]?.action).toBe("auto_finished");
  });

  test("idle dirty SANDBOX_ACTIVE is exported before its worker is released", async () => {
    const h = makeHarness([
      record({ sessionID: "dirty-idle", state: "SANDBOX_ACTIVE", updatedAt: iso(3_700_000) }),
    ]);
    let dirtyCleared = false;
    h.ctx.adapter.exec = h.execStatus((worker) =>
      worker === "worker-dirty-idle" && !dirtyCleared ? dirtyStatus() : cleanStatus(),
    );
    const prepared: string[] = [];

    const { reaped } = await sweepIdle(
      h.ctx,
      3_600_000,
      (e) => h.logs.push(e),
      undefined,
      async (_ctx, id) => {
        prepared.push(id);
        dirtyCleared = true; // the export commits the tree clean
        return `refs/opencode-sandbox/result/${id}`;
      },
    );

    expect(reaped).toBe(1);
    // The edits are exported, not discarded, before the worker goes away.
    expect(prepared).toEqual(["dirty-idle"]);
    expect(h.removed).toEqual(["worker-dirty-idle"]);
    const rec = h.records.get("dirty-idle")!;
    expect(rec.state).toBe("RESULT_READY");
    expect(rec.resultRef).toBe("refs/opencode-sandbox/result/dirty-idle");
    expect(rec.workerName).toBeUndefined();
    expect(rec.workerState).toBe("DESTROYED");
    expect(h.logs.map((e) => e.action)).toEqual(["auto_finished"]);
  });

  test("a reaped SANDBOX_ACTIVE session rehydrates on ensureWorker without repointing the baseline", async () => {
    const h = makeHarness([
      record({
        sessionID: "rebuild",
        state: "SANDBOX_ACTIVE",
        baselineRef: "refs/opencode-sandbox/baseline/rebuild",
        updatedAt: iso(3_700_000),
      }),
    ]);
    // The sweep exports (the stub models the worker tree going clean) and gives
    // the worker back: the session is a durable RESULT_READY record afterwards.
    await sweepIdle(h.ctx, 3_600_000, undefined, undefined, async (_ctx, id) => {
      return `refs/opencode-sandbox/result/${id}`;
    });
    expect(h.records.get("rebuild")!.state).toBe("RESULT_READY");
    expect(h.records.get("rebuild")!.workerName).toBeUndefined();

    const root = mkdtempSync(join(tmpdir(), "broker-reaper-rebuild-"));
    const stateDir = join(root, "state");
    const projectDir = join(root, "project");
    mkdirSync(join(stateDir, "bundles"), { recursive: true });
    mkdirSync(join(projectDir, ".git"), { recursive: true });
    writeFileSync(join(stateDir, "bundles", "rebuild.bundle"), "bundle");
    const BASE = "1".repeat(40);
    const TIP = "2".repeat(40);
    Object.assign(h.ctx, {
      config: {
        stateDir,
        projects: [{ id: "repo", path: projectDir }],
        workerImage: "test-image",
      },
      budget: { perWorkerCpu: 2, perWorkerMemBytes: 2 * GiB },
      git: {
        runnerMode: "real",
        spawn: async (argv: string[]) => {
          if (argv.includes("merge-base")) {
            return { status: 0, stdout: "", stderr: "", timedOut: false };
          }
          if (argv[1] === "rev-parse") {
            const ref = argv[argv.length - 1] ?? "";
            const sha = ref.includes("baseline/rebuild") ? BASE : ref.includes("result/rebuild") ? TIP : undefined;
            return sha
              ? { status: 0, stdout: `${sha}\n`, stderr: "", timedOut: false }
              : { status: 1, stdout: "", stderr: "", timedOut: false };
          }
          return { status: 0, stdout: "", stderr: "", timedOut: false };
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

      // D2/F2: the SAME result identity is resumed from the result tip; the
      // baseline is mirrored at the original commit and never repointed.
      expect(result).toMatchObject({ worker: "worker-rebuild", state: "SANDBOX_ACTIVE", reused: false, rehydrated: true });
      const rec = h.records.get("rebuild")!;
      expect(rec.resultRef).toBe("refs/opencode-sandbox/result/rebuild");
      expect(rec.baselineRef).toBe("refs/opencode-sandbox/baseline/rebuild");
      expect(rec.workerState).toBe("ACTIVE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("idle clean SANDBOX_ACTIVE is exported, then released without closing the session", async () => {
    const h = makeHarness([
      record({ sessionID: "clean", state: "SANDBOX_ACTIVE", updatedAt: iso(70_000) }),
    ]);
    const prepared: string[] = [];

    const { finished } = await sweepUnfinished(
      h.ctx,
      60_000,
      (e) => h.logs.push(e),
      undefined,
      async (_ctx, id) => {
        prepared.push(id);
        return `refs/opencode-sandbox/result/${id}`;
      },
    );

    expect(prepared).toEqual(["clean"]);
    expect(finished).toBe(1);
    expect(h.stopped).toEqual(["worker-clean"]);
    expect(h.removed).toEqual(["worker-clean"]);
    expect(h.records.get("clean")!.state).toBe("RESULT_READY");
    expect(h.records.get("clean")!.workerName).toBeUndefined();
    expect(h.records.get("clean")!.workerState).toBe("DESTROYED");
    expect(h.records.get("clean")!.reapedAt).toBeDefined();
  });

  test("socket-close idle SANDBOX_ACTIVE is exported, then released without closing the session", async () => {
    const h = makeHarness([
      record({ sessionID: "disconnected", state: "SANDBOX_ACTIVE", updatedAt: iso(70_000) }),
    ]);
    const prepared: string[] = [];

    const reaped = await reapOnDisconnect(
      h.ctx,
      "disconnected",
      60_000,
      (e) => h.logs.push(e),
      undefined,
      async (_ctx, id) => {
        prepared.push(id);
        return `refs/opencode-sandbox/result/${id}`;
      },
    );

    expect(prepared).toEqual(["disconnected"]);
    expect(reaped).toBe(true);
    expect(h.stopped).toEqual(["worker-disconnected"]);
    expect(h.removed).toEqual(["worker-disconnected"]);
    expect(h.records.get("disconnected")!.state).toBe("RESULT_READY");
    expect(h.records.get("disconnected")!.workerName).toBeUndefined();
    expect(h.records.get("disconnected")!.workerState).toBe("DESTROYED");
    expect(h.records.get("disconnected")!.reapedAt).toBeDefined();
  });

  test("socket-close with unexported edits exports them before releasing the worker", async () => {
    const h = makeHarness([
      record({ sessionID: "dirty", state: "SANDBOX_ACTIVE", updatedAt: iso(40_000) }),
    ]);
    let dirtyCleared = false;
    h.ctx.adapter.exec = h.execStatus((worker) =>
      worker === "worker-dirty" && !dirtyCleared ? dirtyStatus() : cleanStatus(),
    );
    const prepared: string[] = [];

    const reaped = await reapOnDisconnect(h.ctx, "dirty", 30_000, (e) => h.logs.push(e), undefined, async (_ctx, id) => {
      prepared.push(id);
      dirtyCleared = true;
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
    h.ctx.adapter.exec = h.execStatus(() => dirtyStatus());

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
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ sessionID: "stuck", action: "error" });
    expect(h.logs[0]!.detail).toMatch(/bundle export failed/);
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
    let dirtyCleared = false;
    h.ctx.adapter.exec = h.execStatus((worker) =>
      worker === "worker-swept" && !dirtyCleared ? dirtyStatus() : cleanStatus(),
    );

    const { finished } = await sweepUnfinished(h.ctx, 60_000, (e) => h.logs.push(e), undefined, async (_ctx, id) => {
      dirtyCleared = true;
      return `refs/opencode-sandbox/result/${id}`;
    });

    expect(finished).toBe(1);
    expect(h.records.get("swept")!.state).toBe("RESULT_READY");
    expect(h.records.get("swept")!.workerState).toBe("DESTROYED");
    expect(h.logs).toEqual([{ sessionID: "swept", action: "auto_finished", detail: "refs/opencode-sandbox/result/swept" }]);
  });

  test("a clean worker whose HEAD is ahead of the durable result is exported before removal", async () => {
    const h = makeHarness([record({ sessionID: "ahead", state: "SANDBOX_ACTIVE", updatedAt: iso(3_700_000) })]);
    // Clean tree, but the worker committed past the exported tip: cleanliness
    // alone is NOT proof, so the export must run first (invariant 1/D3).
    h.heads.set("ahead", "f".repeat(40));
    const prepared: string[] = [];

    const { reaped } = await sweepIdle(
      h.ctx,
      3_600_000,
      (e) => h.logs.push(e),
      undefined,
      async (_ctx, id) => {
        prepared.push(id);
        // The export commits the worker tree: HEAD becomes the exported tip.
        h.heads.set(id, h.exported.get(id)!);
        return `refs/opencode-sandbox/result/${id}`;
      },
    );

    expect(prepared).toEqual(["ahead"]);
    expect(reaped).toBe(1);
    expect(h.removed).toEqual(["worker-ahead"]);
    expect(h.records.get("ahead")!.workerName).toBeUndefined();
    expect(h.logs[0]?.action).toBe("auto_finished");
  });

  test("an unprovable export keeps the worker, its allocation and its prior result", async () => {
    const h = makeHarness([
      record({
        sessionID: "mismatch",
        state: "SANDBOX_ACTIVE",
        resultRef: "refs/opencode-sandbox/result/mismatch-old",
        updatedAt: iso(3_700_000),
      }),
    ]);
    h.heads.set("mismatch", "f".repeat(40)); // never becomes the exported tip
    const prepared: string[] = [];

    const { reaped } = await sweepIdle(
      h.ctx,
      3_600_000,
      (e) => h.logs.push(e),
      undefined,
      async (_ctx, id) => {
        prepared.push(id);
        throw new Error("bundle export failed");
      },
    );

    expect(reaped).toBe(0);
    expect(prepared).toEqual(["mismatch"]); // the export was attempted
    expect(h.stopped).toEqual([]);
    expect(h.removed).toEqual([]);
    const held = h.records.get("mismatch")!;
    expect(held.workerName).toBe("worker-mismatch");
    expect(held.workerState).toBe("ACTIVE");
    // A failed export publishes nothing: the PRIOR result identity is intact.
    expect(held.resultRef).toBe("refs/opencode-sandbox/result/mismatch-old");
    expect(h.ctx.pool.allocations).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ action: "error" });
    expect(h.logs[0]!.detail).toMatch(/bundle export failed/);
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

  test("fresh SANDBOX_ACTIVE is untouched; fresh RESULT_READY is already host-side and released", async () => {
    const h = makeHarness([
      record({ sessionID: "fresh-active", state: "SANDBOX_ACTIVE", updatedAt: iso(1_000) }),
      record({ sessionID: "fresh-ready", updatedAt: iso(1_000) }),
    ]);

    const { reaped } = await sweepIdle(h.ctx, 3_600_000);

    // RESULT_READY has no idle period to wait out (T5): its result is already
    // on the host, so the worker is released on the first sweep.
    expect(reaped).toBe(1);
    expect(h.stopped).toEqual(["worker-fresh-ready"]);
    expect(h.removed).toEqual(["worker-fresh-ready"]);
    expect(h.records.get("fresh-active")!.state).toBe("SANDBOX_ACTIVE");
    expect(h.records.get("fresh-active")!.workerName).toBe("worker-fresh-active");
    expect(h.records.get("fresh-ready")!.state).toBe("RESULT_READY");
    expect(h.records.get("fresh-ready")!.workerName).toBeUndefined();
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

describe("pressure release (T7)", () => {
  test("releases a RESULT_READY worker with no age gate, keeping state and resultRef", async () => {
    const h = makeHarness([
      record({
        sessionID: "ready",
        updatedAt: new Date().toISOString(),
        resultRef: "refs/opencode-sandbox/result/ready",
      }),
    ]);

    const { released, skipped } = await releaseUnderPressure(h.ctx, "waiting");

    expect(released).toBe(1);
    expect(skipped).toBe(0);
    expect(h.stopped).toEqual(["worker-ready"]);
    expect(h.removed).toEqual(["worker-ready"]);
    expect(h.ctx.pool.allocations).toEqual([]);
    const rec = h.records.get("ready")!;
    expect(rec.state).toBe("RESULT_READY"); // apply/preview/retain still work
    expect(rec.resultRef).toBe("refs/opencode-sandbox/result/ready");
    expect(rec.workerName).toBeUndefined();
    expect(rec.workerState).toBe("DESTROYED");
    expect(rec.reapedAt).toBeDefined();

    // The occupancy snapshot is logged before AND after the pass.
    const occupancy = h.pressureLogs.filter((e) => e.action === "pressure_occupancy");
    expect(occupancy.map((e) => e.phase)).toEqual(["before", "after"]);
    expect(occupancy[0]).toMatchObject({ allocations: 1, cap: 4, queueDepth: 0 });
    expect(occupancy[1]).toMatchObject({ allocations: 0, cap: 4, queueDepth: 0 });
    expect(h.pressureLogs.find((e) => e.action === "pressure_release")).toMatchObject({
      sessionID: "ready",
      state: "RESULT_READY",
      detail: "result already host-side",
    });
  });

  test("skips a dirty SANDBOX_ACTIVE (edits survive) and releases a clean one", async () => {
    const h = makeHarness([
      record({ sessionID: "dirty", state: "SANDBOX_ACTIVE" }),
      // The clean one already has a durable result (a resumed session), so its
      // clean tree is provably exported and can be given back without an export.
      record({
        sessionID: "clean",
        state: "SANDBOX_ACTIVE",
        resultRef: "refs/opencode-sandbox/result/clean",
      }),
    ]);
    h.ctx.adapter.exec = h.execStatus((worker) => {
      const dirty = worker === "worker-dirty" ? dirtyStatus() : undefined;
      return dirty ?? cleanStatus();
    });

    const { released, skipped } = await releaseUnderPressure(h.ctx);

    expect(released).toBe(1);
    expect(skipped).toBe(1);
    expect(h.removed).toEqual(["worker-clean"]);
    const dirty = h.records.get("dirty")!;
    expect(dirty.state).toBe("SANDBOX_ACTIVE");
    expect(dirty.workerName).toBe("worker-dirty"); // the edits survive
    expect(dirty.workerState).toBe("ACTIVE");
    expect(h.ctx.pool.allocations.map((a) => a.sessionID)).toEqual(["dirty"]);
    expect(
      h.pressureLogs.find((e) => e.action === "pressure_skipped_dirty"),
    ).toMatchObject({ sessionID: "dirty", state: "SANDBOX_ACTIVE" });
    expect(h.pressureLogs.find((e) => e.action === "pressure_release")).toMatchObject({
      sessionID: "clean",
      detail: "clean worktree",
    });
  });

  test("pressure exports a dirty idle ACTIVE before release, keeps a failed export, and keeps an unreadable status", async () => {
    const h = makeHarness([
      record({ sessionID: "pressure-dirty", state: "SANDBOX_ACTIVE" }),
      record({ sessionID: "pressure-export-fails", state: "SANDBOX_ACTIVE" }),
      record({ sessionID: "pressure-unreadable", state: "SANDBOX_ACTIVE" }),
    ]);
    const dirtyWorkers = new Set([
      "worker-pressure-dirty",
      "worker-pressure-export-fails",
    ]);
    h.ctx.adapter.exec = h.execStatus((worker) => {
      if (worker === "worker-pressure-unreadable") {
        throw new Error("worker unreachable");
      }
      return dirtyWorkers.has(worker) ? dirtyStatus() : cleanStatus();
    });
    const prepared: string[] = [];

    const { released, skipped } = await releaseUnderPressure(
      h.ctx,
      "waiting",
      async (_ctx, id) => {
        prepared.push(id);
        if (id === "pressure-export-fails") throw new Error("bundle export failed");
        // The export commits the worker tree, so the re-proof sees a clean tree.
        dirtyWorkers.clear();
        return `refs/opencode-sandbox/result/${id}-new`;
      },
    );

    // Released direction: a dirty idle unclaimed ACTIVE is exported (its
    // resultRef moves to the new tip) and only then released.
    expect(released).toBe(1);
    expect(skipped).toBe(2);
    expect(prepared).toEqual(["pressure-dirty", "pressure-export-fails"]);
    expect(h.removed).toEqual(["worker-pressure-dirty"]);
    const exportedRec = h.records.get("pressure-dirty")!;
    expect(exportedRec.state).toBe("RESULT_READY");
    expect(exportedRec.resultRef).toBe("refs/opencode-sandbox/result/pressure-dirty-new");
    expect(exportedRec.workerName).toBeUndefined();
    expect(exportedRec.workerState).toBe("DESTROYED");
    expect(
      h.pressureLogs.find(
        (e) => e.sessionID === "pressure-dirty" && e.action === "pressure_release",
      ),
    ).toMatchObject({ detail: "exported before release" });

    // Positive control the other way: a failed export keeps the worker, its
    // edits and its allocation, and publishes no result identity.
    const failed = h.records.get("pressure-export-fails")!;
    expect(failed.state).toBe("SANDBOX_ACTIVE");
    expect(failed.workerName).toBe("worker-pressure-export-fails");
    expect(failed.workerState).toBe("ACTIVE");
    expect(failed.resultRef).toBeUndefined();
    expect(h.ctx.pool.allocations.map((a) => a.sessionID).sort()).toEqual([
      "pressure-export-fails",
      "pressure-unreadable",
    ]);

    // An unreadable status is never exported blind and never released.
    const unreadable = h.records.get("pressure-unreadable")!;
    expect(unreadable.workerName).toBe("worker-pressure-unreadable");
    expect(
      h.pressureLogs
        .filter((e) => e.action === "pressure_skipped_dirty")
        .map((e) => e.sessionID)
        .sort(),
    ).toEqual(["pressure-export-fails", "pressure-unreadable"]);
  });

  test("an unreadable status is skipped, never treated as clean", async () => {
    const h = makeHarness([record({ sessionID: "unreadable", state: "SANDBOX_ACTIVE" })]);
    h.ctx.adapter.exec = async () => {
      throw new Error("worker unreachable");
    };

    const { released, skipped } = await releaseUnderPressure(h.ctx);

    expect(released).toBe(0);
    expect(skipped).toBe(1);
    expect(h.removed).toEqual([]);
    expect(h.records.get("unreadable")!.workerName).toBe("worker-unreadable");
    expect(
      h.pressureLogs.find((e) => e.action === "pressure_skipped_dirty"),
    ).toMatchObject({ sessionID: "unreadable" });
  });

  test("never touches the requester, a locked, a queued or a mid-flight session", async () => {
    const h = makeHarness([
      record({ sessionID: "requester", resultRef: "refs/opencode-sandbox/result/requester" }),
      record({ sessionID: "locked", resultRef: "refs/opencode-sandbox/result/locked" }),
      record({ sessionID: "queued", resultRef: "refs/opencode-sandbox/result/queued" }),
      record({ sessionID: "approving", state: "APPLY_PENDING" }),
      record({ sessionID: "creating", state: "CREATING_SANDBOX", workerState: "CREATING" }),
    ]);
    Object.assign(h.ctx, {
      activeLocks: new Map([["locked", 1]]),
      queue: { find: (id: string) => (id === "queued" ? { sessionID: id } : undefined) },
    });

    const { released } = await releaseUnderPressure(h.ctx, "requester");

    expect(released).toBe(0);
    expect(h.removed).toEqual([]);
    for (const id of ["requester", "locked", "queued", "approving", "creating"]) {
      expect(h.records.get(id)!.workerName).toBe(`worker-${id}`);
    }
    expect(
      h.pressureLogs
        .filter((e) => e.action === "pressure_skipped")
        .map((e) => e.sessionID)
        .sort(),
    ).toEqual(["approving", "creating", "locked", "queued", "requester"]);
  });

  test("a dirty RESULT_READY is re-exported before a pressure release", async () => {
    const h = makeHarness([
      record({
        sessionID: "dirty-ready",
        resultRef: "refs/opencode-sandbox/result/dirty-ready-old",
      }),
    ]);
    let dirtyCleared = false;
    h.ctx.adapter.exec = h.execStatus((worker) =>
      worker === "worker-dirty-ready" && !dirtyCleared ? dirtyStatus() : cleanStatus(),
    );
    const prepared: string[] = [];

    const { released, skipped } = await releaseUnderPressure(
      h.ctx,
      "waiting",
      async (_ctx, id) => {
        prepared.push(id);
        dirtyCleared = true;
        return `refs/opencode-sandbox/result/${id}-new`;
      },
    );

    expect(released).toBe(1);
    expect(skipped).toBe(0);
    expect(prepared).toEqual(["dirty-ready"]);
    expect(h.removed).toEqual(["worker-dirty-ready"]);
    const rec = h.records.get("dirty-ready")!;
    expect(rec.state).toBe("RESULT_READY");
    expect(rec.resultRef).toBe("refs/opencode-sandbox/result/dirty-ready-new");
    expect(rec.workerName).toBeUndefined();
    expect(h.pressureLogs.find((e) => e.action === "pressure_release")).toMatchObject({
      sessionID: "dirty-ready",
      detail: "refs/opencode-sandbox/result/dirty-ready-new",
    });
  });

  test("a pressure release loses to a concurrent client finish and never removes the worker mid-export", async () => {
    const h = makeHarness([
      record({
        sessionID: "mid-export",
        resultRef: "refs/opencode-sandbox/result/mid-export-old",
      }),
    ]);
    let unblockProbe!: () => void;
    const baseExec = h.execStatus(() => cleanStatus());
    h.ctx.adapter.exec = async (worker: string, argv: string[] = []) => {
      if (argv[0] === "git" && argv[1] === "rev-parse") return baseExec(worker, argv);
      return new Promise<ExecResult>((resolve) => {
        unblockProbe = () => resolve(dirtyStatus());
      });
    };

    // The pressure pass acquires the lifecycle claim BEFORE its status probe.
    const pressure = releaseUnderPressure(h.ctx, "waiting", async () => {
      throw new Error("export unavailable in this test");
    });
    await tick();
    // A client finish that arrives now loses the claim and is refused, so the
    // worker can never be torn down under a running export.
    await expect(withFinishGuard(h.ctx, "mid-export", async () => {})).rejects.toThrow(
      /already in flight/,
    );
    // The probe resolves while the pressure pass still owns the claim.
    unblockProbe();
    const { released } = await pressure;

    expect(released).toBe(0);
    expect(h.stopped).toEqual([]);
    expect(h.removed).toEqual([]);
    const rec = h.records.get("mid-export")!;
    // The dirty worker could not be exported, so it is KEPT (never destroyed
    // mid-export) and the record keeps its previous result identity.
    expect(rec.resultRef).toBe("refs/opencode-sandbox/result/mid-export-old");
    expect(rec.workerName).toBe("worker-mid-export");
    expect(
      h.pressureLogs.find((e) => e.action === "pressure_skipped" || e.action === "pressure_skipped_dirty"),
    ).toMatchObject({ sessionID: "mid-export" });
  });

  test("skips a session whose finish is in flight", async () => {
    const h = makeHarness([record({ sessionID: "finishing", resultRef: "refs/opencode-sandbox/result/finishing" })]);

    const { released } = await withFinishGuard(h.ctx, "finishing", () =>
      releaseUnderPressure(h.ctx),
    );

    expect(released).toBe(0);
    expect(h.records.get("finishing")!.workerName).toBe("worker-finishing");
    expect(h.pressureLogs.find((e) => e.action === "pressure_skipped")).toMatchObject({
      sessionID: "finishing",
      detail: "a finish is in flight",
    });
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
