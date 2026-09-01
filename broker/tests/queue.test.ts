/**
 * Graceful pool queue tests (Feature 2): pool-exhausted ensureWorker requests
 * park FIFO instead of dying, releaseWorker drains them, timeouts reject with
 * queued_timed_out, non-queueable refusals still throw immediately, the queue
 * is capped, double-parks share one entry, and socket close cancels parked
 * entries.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { PolicyError } from "../src/policy.ts";
import { PendingQueue } from "../src/queue.ts";
import {
  buildEnsureWorkerOp,
  releaseWorker,
  type OpContext,
} from "../src/service.ts";
import { SessionStore } from "../src/state.ts";
import { BrokerServer } from "../src/server.ts";
import type { BrokerRequestEnvelope, SessionRecord } from "../src/types.ts";

const GiB = 1024 * 1024 * 1024;
const tmpDirs: string[] = [];

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** Temp dir pair (stateDir + a git-looking project dir) registered for cleanup. */
function makeDirs(tag: string): { stateDir: string; projDir: string } {
  const stateDir = mkdtempSync(join(tmpdir(), `broker-${tag}-state-`));
  const projDir = mkdtempSync(join(tmpdir(), `broker-${tag}-proj-`));
  mkdirSync(join(projDir, ".git"));
  tmpDirs.push(stateDir, projDir);
  return { stateDir, projDir };
}

interface Harness {
  ctx: OpContext;
  created: string[];
  projDir: string;
  ensureWorker: (sessionID: string) => Promise<unknown>;
}

function makeHarness(
  overrides: { queueTimeoutMs?: number; queueMaxLength?: number } = {},
): Harness {
  const { stateDir, projDir } = makeDirs("queue");
  const created: string[] = [];
  const config = defaultConfig({
    stateDir,
    projects: [{ id: "repo", path: projDir }],
    queueTimeoutMs: overrides.queueTimeoutMs ?? 600_000,
    queueMaxLength: overrides.queueMaxLength ?? 32,
  });
  const store = new SessionStore(stateDir);
  const ok = (stdout = "") => ({
    status: 0,
    stdout,
    stderr: "",
    timedOut: false,
  });
  const ctx = {
    config,
    store,
    adapter: {
      workerNameFor: (id: string) => `worker-${id}`,
      createWorker: async (spec: { name: string }) => {
        created.push(spec.name);
      },
      copyIn: async () => undefined,
      exec: async () => ok(),
      stop: async () => undefined,
      remove: async () => undefined,
    },
    budget: {
      perWorkerCpu: 2,
      perWorkerMemBytes: 2 * GiB,
      maxAggregateCpu: 8,
      maxAggregateMemBytes: 8 * GiB,
      maxWorkers: 4,
      hostReservedCpu: 4,
      hostReservedMemBytes: 8 * GiB,
    },
    resources: { cpuCount: 16, totalMemBytes: 32 * GiB },
    pool: { allocations: [] },
    queue: new PendingQueue(),
    hostRead: { has: () => false, execute: async () => ({}) },
    logger: {},
    git: {
      runnerMode: "planned" as const,
      spawn: async (argv: string[]) => {
        if (argv.includes("rev-parse")) return ok("headhash\n");
        if (argv.includes("write-tree")) return ok("treehash\n");
        if (argv.includes("commit-tree")) return ok("commithash\n");
        if (argv.includes("bundle")) {
          // runSnapshot chmods the bundle after `git bundle create` — the
          // fake must actually materialize the file (argv: [... create, path, ref]).
          const target = argv[argv.length - 2] ?? "";
          writeFileSync(target, "fake bundle");
          return ok();
        }
        return ok();
      },
    },
  } as unknown as OpContext;

  // Fill the pool to maxWorkers so ensureWorker parks.
  ctx.pool.allocations = Array.from({ length: 4 }, () => ({
    cpu: 2,
    memBytes: 2 * GiB,
  }));

  const ensureWorker = (sessionID: string) =>
    buildEnsureWorkerOp(ctx)({
      version: 1,
      id: `req-${sessionID}`,
      operation: "ensureWorker",
      sessionID,
      agent: "test",
      payload: { projectDir: projDir },
    } as BrokerRequestEnvelope);

  return { ctx, created, projDir, ensureWorker };
}

function victimRecord(name: string): SessionRecord {
  return {
    sessionID: name,
    state: "SANDBOX_ACTIVE",
    workerName: `worker-${name}`,
    workerState: "ACTIVE",
    resources: { cpu: 2, memBytes: 2 * GiB },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// pool full → ensureWorker parks the request (pending) and resolves only after drain → real worker
test("pool full → ensureWorker parks; releaseWorker drains → worker created", async () => {
  const h = makeHarness();
  const parked = h.ensureWorker("s1");
  await new Promise((r) => setTimeout(r, 10));
  expect(h.ctx.queue.length).toBe(1);
  expect(h.ctx.queue.head()?.position).toBe(1);
  await releaseWorker(h.ctx, victimRecord("victim"));
  const result = (await parked) as any;
  expect(result.worker).toBe("worker-s1");
  expect(result.queued).toBe(true);
  expect(result.queuePosition).toBe(1);
  expect(h.created).toEqual(["worker-s1"]);
  expect(h.ctx.queue.length).toBe(0);
});

// FIFO: parked sessions are admitted in queue order
test("FIFO: parked sessions are admitted in queue order", async () => {
  const h = makeHarness();
  const pa = h.ensureWorker("a");
  const pb = h.ensureWorker("b");
  await new Promise((r) => setTimeout(r, 10));
  expect(h.ctx.queue.length).toBe(2);
  expect(h.ctx.queue.find("a")?.position).toBe(1);
  expect(h.ctx.queue.find("b")?.position).toBe(2);
  await releaseWorker(h.ctx, victimRecord("x"));
  const ra = (await pa) as any;
  expect(ra.worker).toBe("worker-a");
  expect(h.created).toEqual(["worker-a"]);
  await releaseWorker(h.ctx, victimRecord("y"));
  const rb = (await pb) as any;
  expect(rb.worker).toBe("worker-b");
  expect(h.created).toEqual(["worker-a", "worker-b"]);
});

// timeout — parked pending rejects with queued_timed_out after queueTimeoutMs
test("timeout rejects with queued_timed_out and removes the entry", async () => {
  const h = makeHarness({ queueTimeoutMs: 50 });
  const parked = h.ensureWorker("s1");
  await new Promise((r) => setTimeout(r, 10));
  expect(h.ctx.queue.length).toBe(1);
  await expect(parked).rejects.toThrow(/timed out/);
  expect(h.ctx.queue.length).toBe(0);
});

test("non-queueable refusals (invalid request) still throw immediately", async () => {
  const h = makeHarness();
  h.ctx.budget.perWorkerCpu = 0; // checkAdmission → "invalid resource request", queueable=false

  await expect(h.ensureWorker("s1")).rejects.toThrow(PolicyError);
  await expect(h.ensureWorker("s1")).rejects.toThrow(
    /invalid resource request/,
  );
  expect(h.ctx.queue.length).toBe(0);
});

// double-park — same session shares the SAME pending promise
test("same session double-park shares a single queue entry", async () => {
  const h = makeHarness();
  const p1 = h.ensureWorker("dup");
  await new Promise((r) => setTimeout(r, 5));
  const p2 = h.ensureWorker("dup");
  await new Promise((r) => setTimeout(r, 5));
  expect(h.ctx.queue.length).toBe(1);
  // Both calls share the same underlying pending promise (async wrapper creates distinct outer promises that resolve identically)
  const entry = h.ctx.queue.find("dup")!;
  expect(entry.pending).toBeDefined();
  await releaseWorker(h.ctx, victimRecord("x"));
  const [r1, r2] = await Promise.all([p1, p2]);
  expect(r1).toEqual(r2);
  expect((r1 as any).worker).toBe("worker-dup");
  expect(h.created).toEqual(["worker-dup"]);
  expect(h.ctx.queue.length).toBe(0);
});

test("queue cap: beyond queueMaxLength ensureWorker fails immediately", async () => {
  const h = makeHarness({ queueMaxLength: 2 });
  const p1 = h.ensureWorker("q1");
  const p2 = h.ensureWorker("q2");
  p1.catch(() => {});
  p2.catch(() => {});
  await new Promise((r) => setTimeout(r, 10));
  expect(h.ctx.queue.length).toBe(2);

  await expect(h.ensureWorker("q3")).rejects.toThrow(/queue full/);
  expect(h.ctx.queue.length).toBe(2);
  // cleanup parked entries to avoid leaking timers into other tests
  h.ctx.queue.cancel("q1", "test cleanup");
  h.ctx.queue.cancel("q2", "test cleanup");
});

// disconnect — cancel removes it and rejects pending
test("disconnect cleanup removes the parked entry and rejects it", async () => {
  const h = makeHarness();
  const parked = h.ensureWorker("d1");
  parked.catch(() => {});
  await new Promise((r) => setTimeout(r, 10));
  expect(h.ctx.queue.length).toBe(1);
  h.ctx.queue.cancel("d1", "client disconnected");
  expect(h.ctx.queue.length).toBe(0);
  await expect(parked).rejects.toThrow(/client disconnected/);
});

test("server socket close cancels queued entries for that socket's sessions", async () => {
  const { stateDir, projDir } = makeDirs("server");
  const config = defaultConfig({
    stateDir,
    projects: [{ id: "repo", path: projDir }],
  });
  const server = new BrokerServer(config);
  const inner = server as unknown as {
    ctx: OpContext;
    dispatchLine(socket: object, line: string): Promise<void>;
    onSocketClose(socket: object): void;
  };
  inner.ctx.pool.allocations = Array.from({ length: 4 }, () => ({
    cpu: 2,
    memBytes: 2 * GiB,
  }));
  const socket = { write: () => undefined, close: () => undefined };

  void inner.dispatchLine(
    socket,
    JSON.stringify({
      version: 1,
      id: "r1",
      operation: "ensureWorker",
      sessionID: "net1",
      payload: { projectDir: projDir },
    }),
  );
  await new Promise((r) => setTimeout(r, 10));
  expect(inner.ctx.queue.length).toBe(1);

  inner.onSocketClose(socket);
  expect(inner.ctx.queue.length).toBe(0);
});

test("a reaped RESULT_READY session can re-ensure a fresh worker", async () => {
  const h = makeHarness();
  h.ctx.pool.allocations = []; // free pool for the first ensure
  await h.ensureWorker("rr");
  expect(h.ctx.store.get("rr")!.state).toBe("SANDBOX_ACTIVE");

  h.ctx.store.transition("rr", "SANDBOX_ACTIVE", "RESULT_READY", {
    resultRef: "refs/opencode-sandbox/result/rr",
  });

  // Reap it via the idle sweeper. idleMs=0 means "stale as soon as the
  // record is older than 0ms", so give the clock a beat to advance past
  // the RESULT_READY transition timestamp (a same-ms age is not > 0).
  await new Promise((r) => setTimeout(r, 10));
  const { sweepIdle } = await import("../src/reaper.ts");
  const { reaped } = await sweepIdle(h.ctx, 0);
  expect(reaped).toBe(1);
  const reapedRec = h.ctx.store.get("rr")!;
  expect(reapedRec.state).toBe("RESULT_READY");
  expect(reapedRec.workerName).toBeUndefined();
  expect(h.ctx.pool.allocations.length).toBe(0);

  const result = (await h.ensureWorker("rr")) as Record<string, unknown>;
  expect(result.reused).toBe(false);
  expect(result.worker).toBe("worker-rr");
  expect(h.ctx.store.get("rr")!.state).toBe("SANDBOX_ACTIVE");
  expect(h.created).toEqual(["worker-rr", "worker-rr"]); // created, reaped, re-created
});
