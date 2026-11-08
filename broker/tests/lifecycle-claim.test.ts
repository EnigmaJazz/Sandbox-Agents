/**
 * T10 / D2-D5: continuation, lifecycle exclusion, bounded pressure latency and
 * simultaneous capacity — against REAL Git repositories and an EMULATED VM
 * adapter (a local directory stands in for `/work`). No live broker or msb VM.
 *
 * The four required scenarios here are:
 *   2. continuation: edit A -> finish/release -> unrelated host drift ->
 *      edit B -> finish. The result holds A+B against the ORIGINAL baseline and
 *      every identity (baseline, result, snapshot) survives the rehydration.
 *   5. a write/exec starting AFTER the claim is refused before any adapter
 *      effect (through the real `BrokerServer.dispatch` claim wrapper), while a
 *      claim held past its deadline still owns the session.
 *   6. bounded pressure latency: a scan blocked beyond `queueTimeoutMs` cannot
 *      extend the requester's absolute deadline, and the later completion
 *      creates no worker for that requester.
 *   7. simultaneous capacity: two direct creations and a full pool + queue cap
 *      cannot oversubscribe, a duplicate shares the pending outcome and a
 *      distinct request is refused.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { defaultConfig } from "../src/config.ts";
import { BrokerServer } from "../src/server.ts";
import { SessionStore } from "../src/state.ts";
import {
  buildEnsureWorkerOp,
  buildPrepareResultOp,
  buildWorkerStatusOp,
  cancelQueuedEntry,
  releaseWorker,
  withLifecycleClaim,
} from "../src/service.ts";
import { sweepIdle } from "../src/reaper.ts";
import { QueuedTimedOutError, PendingQueue } from "../src/queue.ts";
import { PolicyError } from "../src/policy.ts";
import type { OpContext } from "../src/service.ts";
import type { BrokerRequestEnvelope } from "../src/types.ts";

const GiB = 1024 * 1024 * 1024;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const git = (cwd: string, argv: string[], env?: Record<string, string>) =>
  spawnSync("git", argv, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", ...(env ?? {}) },
  });

function tempRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `q114-${tag}-`));
  roots.push(root);
  return root;
}

interface Vm {
  ctx: OpContext;
  store: SessionStore;
  calls: { created: string[]; stopped: string[]; removed: string[] };
  hostRepo: string;
  work: string;
  stateDir: string;
  setStatus?: (worker: string) => "clean" | "dirty" | "unreadable";
}

/**
 * A real host repository plus an emulated guest at `<root>/work`. The adapter
 * translates guest `/work` paths to the local directory, so `runPrepare`,
 * `runSnapshot` and the removal proof run real Git.
 */
function makeVm(tag: string, options: { maxWorkers?: number; queueTimeoutMs?: number; queueMaxLength?: number } = {}): Vm {
  const root = tempRoot(tag);
  const hostRepo = join(root, "host");
  const stateDir = join(root, "state");
  const work = join(root, "work");
  mkdirSync(hostRepo, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(work, { recursive: true });
  git(hostRepo, ["init", "-q"]);
  git(hostRepo, ["config", "user.email", "t@local"]);
  git(hostRepo, ["config", "user.name", "t"]);
  writeFileSync(join(hostRepo, "a.txt"), "original\n");
  git(hostRepo, ["add", "-A"]);
  git(hostRepo, ["commit", "-q", "-m", "base"]);

  const config = defaultConfig({
    stateDir,
    projects: [{ id: "repo", path: hostRepo }],
    workerImage: "test-image",
    testRunners: [],
    queueTimeoutMs: options.queueTimeoutMs ?? 600_000,
    queueMaxLength: options.queueMaxLength ?? 32,
  });
  if (options.maxWorkers !== undefined) config.resource.maxWorkers = options.maxWorkers;
  const store = new SessionStore(stateDir);
  const calls = { created: [] as string[], stopped: [] as string[], removed: [] as string[] };
  const vm: Vm = {
    ctx: undefined as unknown as OpContext,
    store,
    calls,
    hostRepo,
    work,
    stateDir,
  };
  const inside = (p: string) => (p.startsWith("/work") ? join(work, p.slice("/work".length)) : p);
  const execIn = async (_name: string, argv: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) => {
    const cwd =
      opts.cwd && opts.cwd !== "/work" ? join(work, opts.cwd.replace(/^\/work\/?/, "")) : work;
    if (vm.setStatus) {
      const mode = vm.setStatus(_name);
      if (mode === "unreadable") throw new Error("worker unreachable");
      if (mode === "dirty" && argv.includes("status")) {
        return { status: 0, stdout: " M a.txt\n", stderr: "", timedOut: false };
      }
    }
    const guestArgv = argv.map((a) => (a === "/work" || a.startsWith("/work/") ? inside(a) : a));
    const res = spawnSync(guestArgv[0]!, guestArgv.slice(1), {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...(opts.env ?? {}) },
      timeout: 120_000,
    });
    return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "", timedOut: false };
  };

  const ctx = {
    config,
    store,
    adapter: {
      workerNameFor: (id: string) => `worker-${id}`,
      createWorker: async (spec: { name: string }) => {
        calls.created.push(spec.name);
        // A fresh VM has an empty /work: the emulation must reset it, exactly
        // as a new guest would start with nothing.
        rmSync(work, { recursive: true, force: true });
        mkdirSync(work, { recursive: true });
      },
      copyIn: async (_n: string, src: string, dst: string) => {
        mkdirSync(join(inside(dst), ".."), { recursive: true });
        writeFileSync(inside(dst), readFileSync(src));
      },
      copyOut: async (_n: string, src: string, dst: string) => {
        writeFileSync(dst, readFileSync(inside(src)));
      },
      exec: execIn,
      stop: async (n: string) => {
        calls.stopped.push(n);
      },
      remove: async (n: string) => {
        calls.removed.push(n);
      },
    },
    budget: {
      perWorkerCpu: 2,
      perWorkerMemBytes: 2 * GiB,
      maxAggregateCpu: 16,
      maxAggregateMemBytes: 32 * GiB,
      maxWorkers: options.maxWorkers ?? 8,
      hostReservedCpu: 2,
      hostReservedMemBytes: 4 * GiB,
    },
    resources: { cpuCount: 16, totalMemBytes: 32 * GiB },
    pool: { allocations: [] as { cpu: number; memBytes: number; sessionID?: string; reserved?: boolean }[] },
    queue: new PendingQueue(),
    sessionLocks: new Map(),
    activeLocks: new Map(),
    hostRead: { has: () => false },
    logger: { log: () => {} },
    git: {
      runnerMode: "real" as const,
      spawn: async (argv: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) => {
        const res = spawnSync(argv[0]!, argv.slice(1), {
          cwd: opts.cwd ?? hostRepo,
          encoding: "utf8",
          env: { ...process.env, ...(opts.env ?? {}) },
          timeout: 120_000,
        });
        return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "", timedOut: false };
      },
    },
  } as unknown as OpContext;
  vm.ctx = ctx;
  return vm;
}

const req = (
  operation: BrokerRequestEnvelope["operation"],
  sessionID: string,
  payload: Record<string, unknown> = {},
): BrokerRequestEnvelope =>
  ({ version: 1, id: `t-${operation}-${sessionID}`, operation, sessionID, payload }) as BrokerRequestEnvelope;

describe("continuation after a release (D2/F2)", () => {
  test("edit A -> finish/release -> host drift -> edit B -> finish keeps A+B against the original baseline", async () => {
    const vm = makeVm("continuation");
    const ensure = buildEnsureWorkerOp(vm.ctx);
    const prepare = buildPrepareResultOp(vm.ctx);

    await ensure(req("ensureWorker", "s1", { projectDir: vm.hostRepo }));
    const created = vm.store.get("s1")!;
    const baselineRef = created.baselineRef!;
    const baselineCommit = git(vm.hostRepo, ["rev-parse", `${baselineRef}^{commit}`]).stdout.trim();
    const snapshotIdentity = (created as unknown as { snapshotIdentity?: { commit: string; tree: string } })
      .snapshotIdentity;

    await vm.ctx.adapter.exec("worker-s1", ["sh", "-c", "printf 'A\\n' > b.txt"], { cwd: "/work" });
    const first = (await prepare(req("prepareResult", "s1"))) as { resultRef: string };
    expect(vm.store.get("s1")!.workerName).toBeUndefined();

    // An unrelated host-side change (a commit that is not part of the result).
    writeFileSync(join(vm.hostRepo, "unrelated.txt"), "x\n");
    git(vm.hostRepo, ["add", "unrelated.txt"]);
    git(vm.hostRepo, ["commit", "-q", "-m", "unrelated drift"]);

    // Rehydration must resume the SAME baseline and the SAME result identity.
    await ensure(req("ensureWorker", "s1", { projectDir: vm.hostRepo }));
    const resumed = vm.store.get("s1")!;
    expect(resumed.state).toBe("SANDBOX_ACTIVE");
    expect(resumed.baselineRef).toBe(baselineRef);
    expect(resumed.resultRef).toBe(first.resultRef);
    expect(git(vm.hostRepo, ["rev-parse", `${resumed.baselineRef}^{commit}`]).stdout.trim()).toBe(
      baselineCommit,
    );
    expect(
      (resumed as unknown as { snapshotIdentity?: { commit: string; tree: string } }).snapshotIdentity,
    ).toEqual(snapshotIdentity);

    // B is a continuation of A on the resumed worker.
    await vm.ctx.adapter.exec("worker-s1", ["sh", "-c", "printf 'B\\n' > c.txt"], { cwd: "/work" });
    const second = (await prepare(req("prepareResult", "s1"))) as { resultRef: string };
    expect(second.resultRef).toBe(first.resultRef);

    const diff = git(vm.hostRepo, ["diff", baselineRef, second.resultRef]).stdout;
    expect(diff).toContain("+A");
    expect(diff).toContain("+B");
    expect(diff).not.toContain("unrelated");
    // The baseline ref was never repointed by the rehydration.
    expect(git(vm.hostRepo, ["rev-parse", `${baselineRef}^{commit}`]).stdout.trim()).toBe(baselineCommit);
    // The published result is a descendant of the first one.
    const ancestor = git(vm.hostRepo, ["merge-base", "--is-ancestor", first.resultRef, second.resultRef]);
    expect(ancestor.status).toBe(0);
  }, 60_000);

  test("a rehydration whose identities do not resolve fails typed and keeps the prior result", async () => {
    const vm = makeVm("rehydrate-fail");
    await buildEnsureWorkerOp(vm.ctx)(req("ensureWorker", "s1", { projectDir: vm.hostRepo }));
    await vm.ctx.adapter.exec("worker-s1", ["sh", "-c", "printf 'A\\n' > b.txt"], { cwd: "/work" });
    const first = (await buildPrepareResultOp(vm.ctx)(req("prepareResult", "s1"))) as { resultRef: string };

    // The durable result identity disappears (e.g. the host ref was pruned).
    git(vm.hostRepo, ["update-ref", "-d", first.resultRef]);
    const before = vm.store.get("s1")!;

    await expect(
      buildEnsureWorkerOp(vm.ctx)(req("ensureWorker", "s1", { projectDir: vm.hostRepo })),
    ).rejects.toThrow(/retained result identity does not resolve/);

    const after = vm.store.get("s1")!;
    expect(after.state).toBe("RESULT_READY");
    expect(after.resultRef).toBe(first.resultRef);
    expect(after.baselineRef).toBe(before.baselineRef);
    expect(vm.calls.created).toHaveLength(1); // no second worker was created
  }, 60_000);
});

describe("lifecycle exclusion on the public dispatch path (D4)", () => {
  test("a write that starts after the claim is refused before any adapter effect", async () => {
    const vm = makeVm("claim-exclusion");
    await buildEnsureWorkerOp(vm.ctx)(req("ensureWorker", "s1", { projectDir: vm.hostRepo }));
    const server = new BrokerServer(
      defaultConfig({
        stateDir: vm.stateDir,
        socketPath: join(vm.stateDir, "broker.sock"),
        projects: [{ id: "repo", path: vm.hostRepo }],
      }),
    );
    const internals = server as unknown as {
      ctx: OpContext;
      dispatch: (req: BrokerRequestEnvelope) => Promise<unknown>;
    };
    internals.ctx.adapter = vm.ctx.adapter;
    internals.ctx.git = vm.ctx.git;

    let release!: () => void;
    const held = withLifecycleClaim(internals.ctx, "s1", "release", () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await new Promise((r) => setTimeout(r, 10));

    const before = readFileSync(join(vm.work, "a.txt"), "utf8");
    await expect(
      internals.dispatch(
        req("writeFile", "s1", { path: "a.txt", content: "should not land\n" }),
      ),
    ).rejects.toThrow(/already in flight/);
    // No adapter effect: the worker file is unchanged.
    expect(readFileSync(join(vm.work, "a.txt"), "utf8")).toBe(before);

    release();
    await held;
    // Positive control: the same write is accepted once the claim is released.
    await internals.dispatch(req("writeFile", "s1", { path: "a.txt", content: "lands\n" }));
    expect(readFileSync(join(vm.work, "a.txt"), "utf8")).toBe("lands\n");
  }, 60_000);

  test("a claimed finish keeps ownership past its deadline (a late settle does not free it early)", async () => {
    const vm = makeVm("claim-deadline");
    (vm.ctx.config as { finishGuardGraceMs?: number }).finishGuardGraceMs = 20;
    let settle!: () => void;
    const timedOut = withLifecycleClaim(
      vm.ctx,
      "s1",
      "finish",
      () => new Promise<void>((resolve) => { settle = resolve; }),
      { deadlineMs: 20 },
    ).then(() => "ok", (e: Error) => e.message);
    await new Promise((r) => setTimeout(r, 10));
    expect(await timedOut).toMatch(/deadline/);
    // Still owned: the callback has not settled.
    await expect(
      withLifecycleClaim(vm.ctx, "s1", "mutation", async () => "second"),
    ).rejects.toThrow(/already in flight/);
    settle();
    await new Promise((r) => setTimeout(r, 10));
    await expect(withLifecycleClaim(vm.ctx, "s1", "mutation", async () => "ok")).resolves.toBe("ok");
  }, 30_000);
});

describe("bounded pressure latency (D5)", () => {
  test("a scan blocked past queueTimeoutMs cannot extend the deadline and creates no worker later", async () => {
    const vm = makeVm("pressure-latency", { maxWorkers: 1, queueTimeoutMs: 40, queueMaxLength: 4 });
    // The pool is full. One holder answers the status probe only after the
    // requester's deadline, so the pressure scan is blocked past it.
    await buildEnsureWorkerOp(vm.ctx)(req("ensureWorker", "held", { projectDir: vm.hostRepo }));
    await vm.ctx.adapter.exec("worker-held", ["sh", "-c", "printf 'x\\n' > x.txt"], { cwd: "/work" });
    await buildPrepareResultOp(vm.ctx)(req("prepareResult", "held"));
    vm.store.touch("held", {
      state: "RESULT_READY",
      workerName: "worker-held",
      workerState: "ACTIVE",
      resultRef: "refs/opencode-sandbox/result/held",
      projectID: "repo",
    });
    vm.ctx.pool.allocations.push({ cpu: 2, memBytes: 2 * GiB, sessionID: "held" });

    const realExec = vm.ctx.adapter.exec.bind(vm.ctx.adapter);
    let scanStarted!: () => void;
    const started = new Promise<void>((r) => { scanStarted = r; });
    let releaseScan!: () => void;
    const scanGate = new Promise<void>((r) => { releaseScan = r; });
    vm.ctx.adapter.exec = (async (name: string, argv: string[], opts?: Record<string, unknown>) => {
      if (name === "worker-held" && argv.includes("status")) {
        scanStarted();
        // The scan blocks until the watchdog or the finally below releases it.
        await scanGate;
        return { status: 0, stdout: "", stderr: "", timedOut: false };
      }
      return realExec(name, argv, opts as never);
    }) as typeof vm.ctx.adapter.exec;

    const createdBefore = vm.calls.created.length;
    const startedAt = Date.now();
    const parked = buildEnsureWorkerOp(vm.ctx)(req("ensureWorker", "late", { projectDir: vm.hostRepo }));
    const outcome = parked.then(() => "resolved", (e: Error) => e);
    await started;
    // Bounded watchdog: if the absolute deadline did not fire independently of
    // the scan, release the scan so the old behaviour FAILS the elapsed
    // assertion instead of hanging the suite.
    const watchdog = setTimeout(() => releaseScan(), 1_500);
    let result: unknown;
    try {
      result = await outcome;
    } finally {
      clearTimeout(watchdog);
      releaseScan();
    }
    const elapsed = Date.now() - startedAt;
    expect(result).toBeInstanceOf(QueuedTimedOutError);
    // The caller waited for its ABSOLUTE deadline, not for the blocked scan.
    expect(elapsed).toBeGreaterThanOrEqual(30); // a deadline was actually applied
    expect(elapsed).toBeLessThan(250); // and not the 400ms+ scan latency
    // The timed-out entry was removed, not left for a late admission.
    expect(vm.ctx.queue!.find("late")).toBeUndefined();
    // The blocked scan completing later must not create a worker for "late".
    await new Promise((r) => setTimeout(r, 150));
    expect(vm.calls.created.length).toBe(createdBefore);
    expect(vm.store.get("late")?.workerName).toBeUndefined();
  }, 60_000);

  test("a timely pressure scan frees the slot and the parked request is admitted FIFO", async () => {
    const vm = makeVm("pressure-timely", { maxWorkers: 1, queueTimeoutMs: 5_000, queueMaxLength: 4 });
    await buildEnsureWorkerOp(vm.ctx)(req("ensureWorker", "held", { projectDir: vm.hostRepo }));
    await vm.ctx.adapter.exec("worker-held", ["sh", "-c", "printf 'x\\n' > x.txt"], { cwd: "/work" });
    await buildPrepareResultOp(vm.ctx)(req("prepareResult", "held"));
    // Restore the released holder's live identity: the pressure pass releases it
    // through the export proof (HEAD already equals the durable result tip).
    vm.store.touch("held", {
      state: "RESULT_READY",
      workerName: "worker-held",
      workerState: "ACTIVE",
      resultRef: "refs/opencode-sandbox/result/held",
      projectID: "repo",
    });
    vm.ctx.pool.allocations.push({ cpu: 2, memBytes: 2 * GiB, sessionID: "held" });

    const parked = buildEnsureWorkerOp(vm.ctx)(req("ensureWorker", "fast", { projectDir: vm.hostRepo }));
    // Parked synchronously with its own absolute deadline before the scan.
    expect(vm.ctx.queue!.find("fast")).toBeDefined();
    const result = (await parked) as { worker?: string; queued?: boolean };
    expect(result.queued).toBe(true);
    expect(result.worker).toBe("worker-fast");
    // Exactly one held slot remains: the requester's.
    expect(vm.ctx.pool.allocations.map((a) => a.sessionID)).toEqual(["fast"]);
    expect(vm.calls.created).toContain("worker-fast");
  }, 60_000);

  test("a cancelled entry is rejected and never drains a replacement parked under the same id", async () => {
    const vm = makeVm("pressure-cancel", { maxWorkers: 1, queueTimeoutMs: 120, queueMaxLength: 4 });
    await buildEnsureWorkerOp(vm.ctx)(req("ensureWorker", "holder", { projectDir: vm.hostRepo }));
    // The holder has an operation in flight, so the pressure pass cannot free
    // its slot and neither entry can be admitted.
    vm.ctx.activeLocks!.set("holder", 1);
    const createdBefore = vm.calls.created.length;

    const first = buildEnsureWorkerOp(vm.ctx)(req("ensureWorker", "late", { projectDir: vm.hostRepo }));
    const firstOutcome = first.then(() => "resolved", (e: Error) => e.message);
    expect(vm.ctx.queue!.find("late")).toBeDefined();
    // Cancel synchronously: the entry is marked BEFORE any drain can admit it.
    expect(cancelQueuedEntry(vm.ctx, "late", "client disconnected")?.sessionID).toBe("late");
    expect(String(await firstOutcome)).toMatch(/client disconnected/);
    await new Promise((r) => setTimeout(r, 20));
    expect(vm.ctx.queue!.find("late")).toBeUndefined();

    // A replacement for the same session id is a NEW entry with its own
    // deadline; the old detached continuation must never drain it.
    const replacement = buildEnsureWorkerOp(vm.ctx)(req("ensureWorker", "late", { projectDir: vm.hostRepo }));
    expect(vm.ctx.queue!.find("late")).toBeDefined();
    const replaced = await replacement.then(() => "resolved", (e: Error) => e);
    expect(replaced).toBeInstanceOf(QueuedTimedOutError);
    expect(vm.calls.created.length).toBe(createdBefore);
    expect(vm.store.get("late")?.workerName).toBeUndefined();
    expect(vm.ctx.queue!.find("late")).toBeUndefined();
  }, 60_000);
});

describe("simultaneous capacity (D5)", () => {
  test("a duplicate shares the pending outcome and a distinct request is refused by the queue cap", async () => {
    const vm = makeVm("capacity-dup", { maxWorkers: 1, queueMaxLength: 1, queueTimeoutMs: 60 });
    await buildEnsureWorkerOp(vm.ctx)(req("ensureWorker", "holder", { projectDir: vm.hostRepo }));
    // The holder has an operation in flight, so the pressure pass cannot free
    // its slot: the queued requests stay parked until their deadline.
    vm.ctx.activeLocks!.set("holder", 1);

    const a = buildEnsureWorkerOp(vm.ctx)(req("ensureWorker", "dup", { projectDir: vm.hostRepo }));
    const b = buildEnsureWorkerOp(vm.ctx)(req("ensureWorker", "dup", { projectDir: vm.hostRepo }));
    expect(vm.ctx.queue!.length).toBe(1); // visible reservation, deduplicated
    await expect(
      buildEnsureWorkerOp(vm.ctx)(req("ensureWorker", "other", { projectDir: vm.hostRepo })),
    ).rejects.toThrow(PolicyError);
    expect(String(await b.then(() => "ok", (e: Error) => e.message))).toMatch(/timed out|queued/);
    expect(String(await a.then(() => "ok", (e: Error) => e.message))).toMatch(/timed out|queued/);
  }, 60_000);

  test("two concurrent direct creations with one free slot never oversubscribe", async () => {
    const vm = makeVm("capacity-direct", { maxWorkers: 1, queueTimeoutMs: 50 });
    const realCreate = vm.ctx.adapter.createWorker.bind(vm.ctx.adapter);
    let creates = 0;
    vm.ctx.adapter.createWorker = (async (spec: { name: string }) => {
      creates++;
      await new Promise((r) => setTimeout(r, 150));
      return realCreate(spec);
    }) as typeof vm.ctx.adapter.createWorker;

    const first = buildEnsureWorkerOp(vm.ctx)(req("ensureWorker", "one", { projectDir: vm.hostRepo }));
    await new Promise((r) => setTimeout(r, 10));
    const second = buildEnsureWorkerOp(vm.ctx)(req("ensureWorker", "two", { projectDir: vm.hostRepo }));
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes[0]!.status).toBe("fulfilled");
    expect(outcomes[1]!.status).toBe("rejected");
    expect(vm.ctx.pool.allocations.filter((a) => !a.reserved)).toHaveLength(1);
    expect(creates).toBe(1);
  }, 60_000);
});

// Keep the import list honest: the worker-status builder is used by the plugin
// path tests; referencing it here pins that it stays exported for them.
test("workerStatus exposes only the session and worker identity", () => {
  const vm = makeVm("status-shape");
  vm.store.touch("s", { projectID: "repo", state: "RESULT_READY" });
  const handler = buildWorkerStatusOp(vm.ctx);
  return handler(req("workerStatus", "s")).then((result) => {
    expect(Object.keys(result as object).sort()).toEqual(["sessionID", "state", "worker", "workerState"]);
  });
});

/**
 * T11 / C3: a rehydration whose bootstrap fails must roll back to RESULT_READY
 * with every identity, and — until the adapter removal is CONFIRMED — keep the
 * worker name, a FAILED state and exactly one counted held allocation. The
 * direct catch and the queued `finally` must never release that slot.
 */
describe("failed rehydration cleanup (T11/C3)", () => {
  async function releasedSession(vm: Vm) {
    await buildEnsureWorkerOp(vm.ctx)(req("ensureWorker", "s1", { projectDir: vm.hostRepo }));
    await vm.ctx.adapter.exec("worker-s1", ["sh", "-c", "printf 'A\\n' > b.txt"], { cwd: "/work" });
    await buildPrepareResultOp(vm.ctx)(req("prepareResult", "s1"));
    const rec = vm.store.get("s1")!;
    return {
      resultRef: rec.resultRef!,
      baselineRef: rec.baselineRef!,
      snapshot: (rec as unknown as { snapshotIdentity?: unknown }).snapshotIdentity,
    };
  }

  test("confirmed cleanup frees a held allocation when the active-state persistence fails", async () => {
    const vm = makeVm("rehydrate-transition-fail", { maxWorkers: 1 });
    const before = await releasedSession(vm);
    const transition = vm.store.transition.bind(vm.store);
    let injected = false;
    vm.store.transition = ((sessionID, from, to, patch) => {
      if (!injected && from === "CREATING_SANDBOX" && to === "SANDBOX_ACTIVE") {
        injected = true;
        throw new Error("injected active-state persistence failure");
      }
      return transition(sessionID, from, to, patch);
    }) as typeof vm.store.transition;

    await expect(
      buildEnsureWorkerOp(vm.ctx)(req("ensureWorker", "s1", { projectDir: vm.hostRepo })),
    ).rejects.toThrow("injected active-state persistence failure");

    expect(injected).toBe(true);
    const rec = vm.store.get("s1")!;
    expect(rec.state).toBe("RESULT_READY");
    expect(rec.workerName).toBeUndefined();
    expect(rec.resultRef).toBe(before.resultRef);
    expect(rec.baselineRef).toBe(before.baselineRef);
    expect((rec as unknown as { snapshotIdentity?: unknown }).snapshotIdentity).toEqual(before.snapshot);
    expect(vm.ctx.pool.allocations.some((allocation) => allocation.sessionID === "s1")).toBe(false);

    // The confirmed rollback returned the sole slot to admission.
    await buildEnsureWorkerOp(vm.ctx)(req("ensureWorker", "admitted", { projectDir: vm.hostRepo }));
    expect(vm.store.get("admitted")!.state).toBe("SANDBOX_ACTIVE");
    expect(vm.ctx.pool.allocations.map((allocation) => allocation.sessionID)).toEqual(["admitted"]);

    // Positive control: without the one-shot persistence failure, rehydration
    // succeeds and retains exactly one held allocation.
    const control = makeVm("rehydrate-transition-control");
    await releasedSession(control);
    await buildEnsureWorkerOp(control.ctx)(req("ensureWorker", "s1", { projectDir: control.hostRepo }));
    expect(control.store.get("s1")!.state).toBe("SANDBOX_ACTIVE");
    expect(control.ctx.pool.allocations).toHaveLength(1);
    expect(control.ctx.pool.allocations[0]!.reserved).toBeFalsy();
  }, 60_000);

  test("a failed rollback write logs its error while confirmed removal frees the allocation", async () => {
    const vm = makeVm("rehydrate-rollback-write-fail", { maxWorkers: 1 });
    const before = await releasedSession(vm);
    const removalsAfterSetup = vm.calls.removed.length;
    const originalError = new Error("bootstrap copy failed");
    const persistenceError = new Error("rollback persistence failed");
    const logEntries: Record<string, unknown>[] = [];
    vm.ctx.logger = { log: (entry: Record<string, unknown>) => logEntries.push(entry) } as never;
    vm.ctx.adapter.copyIn = async () => {
      throw originalError;
    };
    const transition = vm.store.transition.bind(vm.store);
    let rollbackAttempted = false;
    vm.store.transition = ((sessionID, from, to, patch) => {
      if (!rollbackAttempted && from === "CREATING_SANDBOX" && to === "RESULT_READY") {
        rollbackAttempted = true;
        throw persistenceError;
      }
      return transition(sessionID, from, to, patch);
    }) as typeof vm.store.transition;

    let caught: unknown;
    try {
      await buildEnsureWorkerOp(vm.ctx)(req("ensureWorker", "s1", { projectDir: vm.hostRepo }));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(originalError);
    expect(rollbackAttempted).toBe(true);
    expect(vm.calls.removed.slice(removalsAfterSetup).filter((name) => name === "worker-s1")).toHaveLength(1);
    expect(vm.ctx.pool.allocations.some((allocation) => allocation.sessionID === "s1")).toBe(false);
    expect(vm.store.get("s1")!.workerName).toBeUndefined();
    const rollbackLogs = logEntries.filter((entry) => entry.action === "release_rehydration_rollback_failed");
    expect(rollbackLogs).toHaveLength(1);
    expect(rollbackLogs[0]).toMatchObject({
      sessionID: "s1",
      operation: "ensureWorker",
      result: "error",
      error: persistenceError.message,
    });
    expect(vm.store.get("s1")!.resultRef).toBe(before.resultRef);
    expect(vm.store.get("s1")!.baselineRef).toBe(before.baselineRef);

    // Positive control: a successful rollback preserves the original error and emits no rollback-failure log.
    const control = makeVm("rehydrate-rollback-control");
    await releasedSession(control);
    const controlLogs: Record<string, unknown>[] = [];
    control.ctx.logger = { log: (entry: Record<string, unknown>) => controlLogs.push(entry) } as never;
    control.ctx.adapter.copyIn = async () => {
      throw originalError;
    };
    let controlError: unknown;
    try {
      await buildEnsureWorkerOp(control.ctx)(req("ensureWorker", "s1", { projectDir: control.hostRepo }));
    } catch (err) {
      controlError = err;
    }
    expect(controlError).toBe(originalError);
    expect(control.store.get("s1")!.state).toBe("RESULT_READY");
    expect(control.store.get("s1")!.workerName).toBeUndefined();
    expect(control.ctx.pool.allocations.some((allocation) => allocation.sessionID === "s1")).toBe(false);
    expect(controlLogs.some((entry) => entry.action === "release_rehydration_rollback_failed")).toBe(false);
  }, 60_000);

  test("an unconfirmed cleanup keeps refs, name, FAILED and one held allocation; a later sweep clears it", async () => {
    const vm = makeVm("rehydrate-cleanup");
    const before = await releasedSession(vm);
    // Positive control: the export released its worker and its slot.
    expect(vm.ctx.pool.allocations).toEqual([]);
    expect(vm.store.get("s1")!.workerName).toBeUndefined();

    vm.ctx.adapter.copyIn = async () => {
      throw new Error("copyIn exploded");
    };
    vm.ctx.adapter.remove = async (name: string) => {
      vm.calls.removed.push(name);
      throw new Error("msb remove failed");
    };

    await expect(
      buildEnsureWorkerOp(vm.ctx)(req("ensureWorker", "s1", { projectDir: vm.hostRepo })),
    ).rejects.toThrow("copyIn exploded");

    const rec = vm.store.get("s1")!;
    expect(rec.state).toBe("RESULT_READY");
    expect(rec.resultRef).toBe(before.resultRef);
    expect(rec.baselineRef).toBe(before.baselineRef);
    expect((rec as unknown as { snapshotIdentity?: unknown }).snapshotIdentity).toEqual(before.snapshot);
    expect(rec.workerName).toBe("worker-s1");
    expect(rec.workerState).toBe("FAILED");
    // The direct catch must not release a slot whose VM may still exist.
    expect(vm.ctx.pool.allocations).toHaveLength(1);
    expect(vm.ctx.pool.allocations[0]!.sessionID).toBe("s1");
    expect(vm.ctx.pool.allocations[0]!.reserved).toBeFalsy();

    // Reuse and re-creation are refused while the cleanup is unconfirmed.
    await expect(
      buildEnsureWorkerOp(vm.ctx)(req("ensureWorker", "s1", { projectDir: vm.hostRepo })),
    ).rejects.toThrow(/awaiting a confirmed cleanup/);

    // A sweep retries under the claim and keeps everything while removal fails.
    const first = await sweepIdle(vm.ctx, 0);
    expect(first.reaped).toBe(0);
    expect(vm.store.get("s1")!.workerName).toBe("worker-s1");
    expect(vm.store.get("s1")!.workerState).toBe("FAILED");
    expect(vm.ctx.pool.allocations).toHaveLength(1);

    // A CONFIRMED removal later clears identity once, frees the slot and drains.
    vm.ctx.adapter.remove = async (name: string) => {
      vm.calls.removed.push(name);
    };
    const second = await sweepIdle(vm.ctx, 0);
    expect(second.reaped).toBe(1);
    const cleared = vm.store.get("s1")!;
    expect(cleared.state).toBe("RESULT_READY");
    expect(cleared.workerName).toBeUndefined();
    expect(cleared.workerState).toBe("DESTROYED");
    expect(cleared.resultRef).toBe(before.resultRef);
    expect(vm.ctx.pool.allocations).toEqual([]);
  }, 60_000);

  test("a throwing stop never hides a successful removal: the rollback clears identity and frees the slot", async () => {
    const vm = makeVm("rehydrate-stop-fail");
    const before = await releasedSession(vm);
    vm.ctx.adapter.copyIn = async () => {
      throw new Error("copyIn exploded");
    };
    vm.ctx.adapter.stop = async () => {
      throw new Error("msb stop failed");
    };

    await expect(
      buildEnsureWorkerOp(vm.ctx)(req("ensureWorker", "s1", { projectDir: vm.hostRepo })),
    ).rejects.toThrow("copyIn exploded");

    const rec = vm.store.get("s1")!;
    expect(rec.state).toBe("RESULT_READY");
    expect(rec.resultRef).toBe(before.resultRef);
    expect(rec.workerName).toBeUndefined();
    expect(rec.workerState).toBe("DESTROYED");
    expect(vm.ctx.pool.allocations).toEqual([]);
    expect(vm.calls.removed).toContain("worker-s1");
  }, 60_000);

  test("a rejected createWorker with an unconfirmed remove keeps ownership and capacity", async () => {
    const vm = makeVm("rehydrate-create-reject");
    const before = await releasedSession(vm);
    vm.ctx.adapter.createWorker = async () => {
      throw new Error("createWorker exploded");
    };
    vm.ctx.adapter.remove = async (name: string) => {
      vm.calls.removed.push(name);
      throw new Error("msb remove failed");
    };

    await expect(
      buildEnsureWorkerOp(vm.ctx)(req("ensureWorker", "s1", { projectDir: vm.hostRepo })),
    ).rejects.toThrow("createWorker exploded");

    const rec = vm.store.get("s1")!;
    expect(rec.state).toBe("RESULT_READY");
    expect(rec.resultRef).toBe(before.resultRef);
    expect(rec.workerName).toBe("worker-s1");
    expect(rec.workerState).toBe("FAILED");
    expect(vm.ctx.pool.allocations).toHaveLength(1);
    expect(vm.ctx.pool.allocations[0]!.reserved).toBeFalsy();
  }, 60_000);

  test("a queued creation that fails its bootstrap keeps the held allocation past the queued finally", async () => {
    const vm = makeVm("rehydrate-queued", { maxWorkers: 1, queueTimeoutMs: 5_000, queueMaxLength: 4 });
    const before = await releasedSession(vm);
    // Another holder keeps the pool full, so the rehydration request parks.
    await buildEnsureWorkerOp(vm.ctx)(req("ensureWorker", "holder", { projectDir: vm.hostRepo }));
    expect(vm.ctx.pool.allocations.map((a) => a.sessionID)).toEqual(["holder"]);

    vm.ctx.adapter.copyIn = async () => {
      throw new Error("copyIn exploded");
    };
    vm.ctx.adapter.remove = async (name: string) => {
      vm.calls.removed.push(name);
      if (name === "worker-s1") throw new Error("msb remove failed");
    };

    const parked = buildEnsureWorkerOp(vm.ctx)(req("ensureWorker", "s1", { projectDir: vm.hostRepo }));
    const outcome = parked.then(() => "resolved", (e: Error) => e.message);
    expect(vm.ctx.queue!.find("s1")).toBeDefined();
    // Free the slot: the drain admits "s1", whose bootstrap then fails.
    await releaseWorker(vm.ctx, vm.store.get("holder")!);
    expect(String(await outcome)).toMatch(/copyIn exploded/);

    const rec = vm.store.get("s1")!;
    expect(rec.state).toBe("RESULT_READY");
    expect(rec.resultRef).toBe(before.resultRef);
    expect(rec.workerName).toBe("worker-s1");
    expect(rec.workerState).toBe("FAILED");
    // The queued finally must not drop the slot the rehydration kept.
    expect(vm.ctx.pool.allocations.map((a) => a.sessionID)).toEqual(["s1"]);
    expect(vm.ctx.pool.allocations[0]!.reserved).toBeFalsy();
  }, 60_000);
});
