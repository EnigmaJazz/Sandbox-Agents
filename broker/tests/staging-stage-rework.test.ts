/**
 * Staging chains, reduced P4 + reconcile (docs/staging/plan.md, U3): reject marks
 * later stages STALE, the work is re-run from the last approved tip as a new
 * attempt (no replay), a leaked stage claim is released, and stageReconcile
 * records APPLIED only for content already on the host.
 *
 * A real git repository (mkdtemp under the OS tmpdir, never in the worktree) plays
 * the host. The rework tests drive real ensureWorker -> prepareResult plans through
 * a directory-backed fake adapter (no real backend is ever started); the reconcile
 * tests seed stage refs and session records directly. Every refusal is followed by
 * a host fingerprint check, which has a positive control.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { spawnArgv } from "../src/msb.ts";
import { classifyOperation, decideStageReview } from "../src/role-policy.ts";
import { BrokerServer } from "../src/server.ts";
import { buildEnsureWorkerOp, buildPrepareResultOp, buildToolAdmissionOp, type OpContext } from "../src/service.ts";
import { chainAttach, chainCreate, chainStatus } from "../src/staging-chain.ts";
import { OPERATIONS, SANDBOX_GUARD_CLASS, type BrokerRequestEnvelope } from "../src/types.ts";
import { ALLOWED_PAYLOAD_KEYS, HOST_MUTATION_IDENTITY_OPERATIONS, HOST_MUTATION_OPERATIONS, hostToolAccess } from "../src/validation.ts";

const GiB = 1024 ** 3;
const ORCH = "gentle-orchestrator";
const REVIEWER = "stage-review";
const ZERO = "0".repeat(40);
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();
const REF = (id: string) => `refs/opencode-sandbox/chain/${id}`;

interface Env {
  ctx: OpContext & { store: { touch(id: string, patch: Record<string, unknown>): unknown } };
  repo: string;
  stateDir: string;
  dispatch(operation: string, sessionID: string, payload?: unknown): Promise<any>;
  workerDir(sessionID: string): string;
}

/** A broker over a real host repo (a.txt, d.txt) whose adapter is a directory-backed fake, installed before anything can start a worker. */
function env(): Env {
  const root = mkdtempSync(join(tmpdir(), "staging-stage-rework-"));
  roots.push(root);
  const repo = join(root, "repo");
  const stateDir = join(root, "state");
  const workers = join(root, "workers");
  for (const d of [repo, stateDir, workers]) mkdirSync(d, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@local");
  writeFileSync(join(repo, "a.txt"), "a\n");
  writeFileSync(join(repo, "d.txt"), "d\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");

  const server = new BrokerServer(defaultConfig({ stateDir, projects: [{ id: "repo", path: repo }], readOnlyAgents: [ORCH], stageReviewAgents: [REVIEWER] }));
  const internals = server as unknown as { ctx: Env["ctx"]; dispatch(req: BrokerRequestEnvelope): Promise<unknown> };
  const ctx = internals.ctx;
  const dirOf = (name: string) => join(workers, name);
  const map = (name: string) => (a: string) => (a.startsWith("/work") ? join(dirOf(name), a.slice("/work".length)) : a);
  Object.assign(ctx, {
    git: { runnerMode: "real", spawn: spawnArgv },
    adapter: {
      workerNameFor: (id: string) => `worker-${id}`,
      createWorker: async (spec: { name: string }) => void mkdirSync(dirOf(spec.name), { recursive: true }),
      copyIn: async (name: string, src: string, dest: string) => void copyFileSync(src, map(name)(dest)),
      copyOut: async (name: string, src: string, dest: string) => void copyFileSync(map(name)(src), dest),
      exec: async (name: string, argv: string[], opts?: { env?: Record<string, string>; timeoutMs?: number }) =>
        spawnArgv(argv.map(map(name)), { cwd: dirOf(name), env: opts?.env, timeoutMs: opts?.timeoutMs }),
      stop: async () => undefined,
      remove: async () => undefined,
    },
    budget: { perWorkerCpu: 2, perWorkerMemBytes: 2 * GiB, maxAggregateCpu: 32, maxAggregateMemBytes: 32 * GiB, maxWorkers: 16, hostReservedCpu: 4, hostReservedMemBytes: 8 * GiB },
    resources: { cpuCount: 16, totalMemBytes: 64 * GiB },
  });
  ctx.store.touch("orch", { agent: ORCH });
  ctx.store.touch("rev", { agent: REVIEWER });
  ctx.store.touch("plain", {});
  ctx.store.touch("wrk", { agent: "worker" });
  const dispatch = (operation: string, sessionID: string, payload?: unknown) =>
    internals.dispatch({ version: 1, id: `t-${operation}`, operation, sessionID, payload } as BrokerRequestEnvelope) as Promise<any>;
  return { ctx, repo, stateDir, dispatch, workerDir: (id) => dirOf(`worker-${id}`) };
}

const req = (operation: string, sessionID: string, payload: Record<string, unknown>): BrokerRequestEnvelope =>
  ({ version: 1, id: `${operation}-${sessionID}`, operation, sessionID, payload }) as BrokerRequestEnvelope;

/** Start a worker from the chain's offered snapshot and bind it to the next stage; optionally finish it with one file. */
async function stage(e: Env, chainID: string, sessionID: string, file?: string, text = `${file}\n`): Promise<void> {
  const { nextSnapshot } = await chainStatus(e.ctx, chainID);
  expect(nextSnapshot, `a snapshot is offered for ${sessionID}`).not.toBeNull();
  await buildEnsureWorkerOp(e.ctx)(req("ensureWorker", sessionID, { projectDir: e.repo, snapshot: nextSnapshot }));
  await chainAttach(e.ctx, chainID, sessionID);
  if (file) {
    writeFileSync(join(e.workerDir(sessionID), file), text);
    await buildPrepareResultOp(e.ctx)(req("prepareResult", sessionID, {}));
  }
}

const states = async (e: Env, chainID: string) => (await chainStatus(e.ctx, chainID)).stages.map((s) => s.state);
const show = async (e: Env, chainID: string, n: number) => (await e.dispatch("stageShow", "rev", { chainID, n })).stage;
const decide = (e: Env, op: string, chainID: string, n: number, result: string, extra: Record<string, unknown> = {}, session = "rev") =>
  e.dispatch(op, session, { chainID, n, result, ...(op === "stageApply" ? { confirm: "APPLY" } : {}), ...(op === "stageReject" ? { note: "rework this" } : {}), ...extra });

/** HEAD, refs, status, index bytes and the bytes of every non-.git file. */
function hostFingerprint(repo: string): string {
  const h = createHash("sha256")
    .update(git(repo, "rev-parse", "HEAD"))
    .update(git(repo, "for-each-ref", "refs/heads", "refs/tags"))
    .update(git(repo, "status", "--porcelain=v1", "--untracked-files=all"))
    .update(readFileSync(join(repo, ".git", "index")));
  const walk = (dir: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (d.name === ".git") continue;
      const p = join(dir, d.name);
      h.update(p);
      if (d.isDirectory()) walk(p);
      else h.update(readFileSync(p));
    }
  };
  walk(repo);
  return h.digest("hex");
}

async function refusedLeavesHost(e: Env, fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  const before = hostFingerprint(e.repo);
  await expect(fn()).rejects.toThrow(pattern);
  expect(hostFingerprint(e.repo)).toBe(before);
}

describe("reject, STALE and rebuild from the tip (S82-S85)", () => {
  test("reject marks later stages STALE, they cannot be decided, and a rebuilt attempt flows through approve and apply", async () => {
    const e = env();
    const chain = chainCreate(e.ctx, { projectID: "repo", lane: "feature" }).id;
    await stage(e, chain, "s1", "b.txt");
    await stage(e, chain, "s2", "c.txt");
    await stage(e, chain, "s3", "e.txt");
    const [r1, r2, r3] = (await chainStatus(e.ctx, chain)).stages.map((s) => s.result!);
    expect(await states(e, chain)).toEqual(["READY", "READY", "READY"]);

    await decide(e, "stageApprove", chain, 1, r1);
    const rejected = await decide(e, "stageReject", chain, 2, r2);
    expect(rejected).toMatchObject({ n: 2, state: "REJECTED", result: r2, stale: [3] });
    expect(await states(e, chain)).toEqual(["APPROVED", "REJECTED", "STALE"]);
    const stale = (await show(e, chain, 3)).history;
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ n: 3, event: "STALE", result: r3, by: { sessionID: "rev", agent: REVIEWER }, reason: "stage 2 was rejected" });
    expect(Number.isNaN(Date.parse(stale[0].at))).toBe(false);

    // S83: a STALE or REJECTED stage can never be approved, applied or rejected again; the host is untouched.
    for (const [n, r, word] of [[2, r2, /REJECTED/], [3, r3, /STALE/]] as const) {
      await refusedLeavesHost(e, () => decide(e, "stageApprove", chain, n, r), word);
      await refusedLeavesHost(e, () => decide(e, "stageApply", chain, n, r), word);
      await refusedLeavesHost(e, () => decide(e, "stageReject", chain, n, r), word);
    }
    expect((await show(e, chain, 3)).history).toHaveLength(1); // the refusals recorded nothing

    // S84: the tip is the last good stage's pinned result, offered as a commit (the session result ref is not needed).
    expect((await chainStatus(e.ctx, chain)).nextSnapshot).toEqual({ commit: r1 });
    const oldRef = git(e.repo, "rev-parse", `${REF(chain)}/stage/2`);
    expect(oldRef).toBe(r2);
    await stage(e, chain, "s2b", "c2.txt", "c two\n");
    const rebuilt = (await chainStatus(e.ctx, chain)).stages;
    expect(rebuilt.map((s) => [s.n, s.state, s.attempt, s.sessionID])).toEqual([[1, "APPROVED", undefined, "s1"], [2, "READY", 2, "s2b"], [3, "STALE", undefined, "s3"]]);
    expect(rebuilt[1]!.baseline).toBe(r1); // started from stage 1's pinned result, not from the rejected stage 2
    expect(rebuilt[1]!.changedPaths).toEqual(["c2.txt"]); // no cherry-picked content of the old attempt
    const r2b = rebuilt[1]!.result!;
    expect(git(e.repo, "rev-parse", `${REF(chain)}/stage/2.2`)).toBe(r2b);
    expect(git(e.repo, "rev-parse", `${REF(chain)}/stage/2`)).toBe(r2); // the old attempt's ref never moved
    expect(r2b).not.toBe(r2);
    // the history of stage 2 keeps the rejected attempt
    expect((await show(e, chain, 2)).history.map((h: any) => [h.event, h.attempt])).toEqual([["REJECTED", undefined]]);
    // stage 3 waits: its predecessor is not yet APPROVED
    expect((await chainStatus(e.ctx, chain)).nextSnapshot).toBeNull();

    // the old attempt's result can no longer be decided; the new one can (S85)
    await expect(decide(e, "stageApprove", chain, 2, r2)).rejects.toThrow(/pinned result commit/);
    await decide(e, "stageApprove", chain, 2, r2b);
    expect((await chainStatus(e.ctx, chain)).nextSnapshot).toEqual({ commit: r2b });
    await stage(e, chain, "s3b", "e2.txt", "e two\n");
    const r3b = (await chainStatus(e.ctx, chain)).stages[2]!.result!;
    expect(git(e.repo, "rev-parse", `${REF(chain)}/stage/3.2`)).toBe(r3b);
    expect(git(e.repo, "rev-parse", `${REF(chain)}/stage/3`)).toBe(r3);
    await decide(e, "stageApprove", chain, 3, r3b);

    // apply in order; the B1 binding holds for the new attempt
    await decide(e, "stageApply", chain, 1, r1);
    git(e.repo, "update-ref", `${REF(chain)}/stage/2.2`, r1); // a host-side ref rewrite after approval
    const before = hostFingerprint(e.repo);
    await expect(decide(e, "stageApply", chain, 2, r1)).rejects.toThrow(/moved since approval/);
    expect(hostFingerprint(e.repo)).toBe(before);
    expect((await show(e, chain, 2)).state).toBe("APPROVED");
    git(e.repo, "update-ref", `${REF(chain)}/stage/2.2`, r2b, r1);
    expect(existsSync(join(e.repo, "c2.txt"))).toBe(false); // positive control: the new attempt's file is observable once applied
    await decide(e, "stageApply", chain, 2, r2b);
    await decide(e, "stageApply", chain, 3, r3b);
    expect(readFileSync(join(e.repo, "c2.txt"), "utf8")).toBe("c two\n");
    expect(readFileSync(join(e.repo, "e2.txt"), "utf8")).toBe("e two\n");
    expect(existsSync(join(e.repo, "c.txt"))).toBe(false); // the rejected attempt's content never lands
    expect(existsSync(join(e.repo, "e.txt"))).toBe(false);
    expect(await states(e, chain)).toEqual(["APPLIED", "APPLIED", "APPLIED"]);
    expect((await show(e, chain, 2)).history.map((h: any) => [h.event, h.attempt])).toEqual([
      ["REJECTED", undefined], ["APPROVED", 2], ["APPLYING", 2], ["APPLY_REFUSED", 2], ["APPLYING", 2], ["APPLIED", 2],
    ]);
  }, 240_000);

  test("rejecting stage 1 rebuilds it from a fresh worktree snapshot and keeps the pinned base; a still-building later stage becomes STALE", async () => {
    const e = env();
    const chain = chainCreate(e.ctx, { projectID: "repo", lane: "feature" }).id;
    await stage(e, chain, "s1", "b.txt");
    await stage(e, chain, "s2"); // attached, never finished: BUILDING
    expect(await states(e, chain)).toEqual(["READY", "BUILDING"]);
    const r1 = (await chainStatus(e.ctx, chain)).stages[0]!.result!;
    const base = git(e.repo, "rev-parse", `${REF(chain)}/base`);

    const out = await decide(e, "stageReject", chain, 1, r1);
    expect(out.stale).toEqual([2]);
    expect(await states(e, chain)).toEqual(["REJECTED", "STALE"]);
    expect((await show(e, chain, 2)).history[0]).toMatchObject({ event: "STALE", result: ZERO });
    expect((await chainStatus(e.ctx, chain)).nextSnapshot).toEqual({ worktree: true });

    await stage(e, chain, "s1b", "b2.txt");
    const [first, second] = (await chainStatus(e.ctx, chain)).stages;
    expect([first!.n, first!.state, first!.attempt, first!.sessionID]).toEqual([1, "READY", 2, "s1b"]);
    expect(first!.changedPaths).toEqual(["b2.txt"]);
    expect(git(e.repo, "rev-parse", `${REF(chain)}/base`)).toBe(base);
    expect(git(e.repo, "rev-parse", `${REF(chain)}/stage/1`)).toBe(r1);
    expect(git(e.repo, "rev-parse", `${REF(chain)}/stage/1.2`)).toBe(first!.result!);
    expect(second!.state).toBe("STALE");

    // the old stage-2 worker finishing later registers its ref but cannot revive the stage
    writeFileSync(join(e.workerDir("s2"), "late.txt"), "late\n");
    await buildPrepareResultOp(e.ctx)(req("prepareResult", "s2", {}));
    const late = (await chainStatus(e.ctx, chain)).stages[1]!;
    expect([late.state, late.result !== undefined]).toEqual(["STALE", true]);
    await expect(decide(e, "stageApprove", chain, 2, late.result!)).rejects.toThrow(/STALE/);
  }, 240_000);

  test("a leaked stage claim is released by rejecting the BUILDING stage with the all-zero result, then the stage is rebuilt", async () => {
    const e = env();
    const chain = chainCreate(e.ctx, { projectID: "repo", lane: "feature" }).id;
    await stage(e, chain, "leak"); // its worker was released/failed: no result ever
    // positive control: the claim blocks both a new stage and any decision
    await buildEnsureWorkerOp(e.ctx)(req("ensureWorker", "next", { projectDir: e.repo }));
    await expect(chainAttach(e.ctx, chain, "next")).rejects.toThrow(/not ready/);
    expect((await chainStatus(e.ctx, chain)).nextSnapshot).toBeNull();
    await expect(decide(e, "stageApprove", chain, 1, ZERO)).rejects.toThrow(/BUILDING/);
    await expect(decide(e, "stageReject", chain, 1, "1".repeat(40))).rejects.toThrow(/BUILDING/);
    // only the stage-review role may release it
    for (const session of ["orch", "plain", "wrk"]) await expect(decide(e, "stageReject", chain, 1, ZERO, {}, session)).rejects.toThrow(/stage-review/);
    expect(await states(e, chain)).toEqual(["BUILDING"]);

    const out = await decide(e, "stageReject", chain, 1, ZERO, { note: "worker released after a failed finish" });
    expect(out).toMatchObject({ n: 1, state: "REJECTED", result: ZERO });
    expect((await show(e, chain, 1)).history[0]).toMatchObject({ event: "REJECTED", result: ZERO, note: "worker released after a failed finish" });
    await expect(decide(e, "stageReject", chain, 1, ZERO)).rejects.toThrow(/REJECTED/);
    expect((await chainStatus(e.ctx, chain)).nextSnapshot).toEqual({ worktree: true });
    await chainAttach(e.ctx, chain, "next"); // the same session now gets the stage, as attempt 2
    expect(await states(e, chain)).toEqual(["BUILDING"]);
    expect((await chainStatus(e.ctx, chain)).stages[0]).toMatchObject({ sessionID: "next", attempt: 2 });
  }, 120_000);

  test("existing behaviour is unchanged for a chain that never rebuilds", async () => {
    const e = env();
    const chain = chainCreate(e.ctx, { projectID: "repo", lane: "feature" }).id;
    await stage(e, chain, "s1", "b.txt");
    const r1 = (await chainStatus(e.ctx, chain)).stages[0]!.result!;
    const listed = (await e.dispatch("stageList", "rev", { chainID: chain })).stages;
    expect(listed).toEqual([{ n: 1, sessionID: "s1", state: "READY", baseline: expect.any(String), result: r1, changedPaths: ["b.txt"], touchesProtected: false }]);
    expect(git(e.repo, "for-each-ref", "--format=%(refname)", REF(chain)).split("\n")).toEqual([`${REF(chain)}/base`, `${REF(chain)}/stage/1`]); // attempt 1 keeps the P1 ref names
    // a lone rejected stage reports exactly what P2b reported, with no stale list and no attempt field
    expect(await decide(e, "stageReject", chain, 1, r1)).toEqual({ chainID: chain, n: 1, state: "REJECTED", result: r1 });
    const history = (await show(e, chain, 1)).history;
    expect(history).toHaveLength(1);
    expect(Object.keys(history[0]).sort()).toEqual(["at", "by", "event", "n", "note", "result"]);
  }, 120_000);
});

/** Seeded fixture (no worker): host main has a.txt and d.txt; stage 1 edits a.txt, deletes d.txt, adds b.txt; stage 2 adds broker/src/x.ts (S17). */
function seeded() {
  const e = env();
  const { repo } = e;
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "-b", "side");
  writeFileSync(join(repo, "a.txt"), "a two\n");
  writeFileSync(join(repo, "b.txt"), "b\n");
  rmSync(join(repo, "d.txt"));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "stage 1");
  const s1 = git(repo, "rev-parse", "HEAD");
  mkdirSync(join(repo, "broker/src"), { recursive: true });
  writeFileSync(join(repo, "broker/src/x.ts"), "export {};\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "stage 2");
  const s2 = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "main");
  const chain = chainCreate(e.ctx, { projectID: "repo", lane: "feature" }).id;
  git(repo, "update-ref", `${REF(chain)}/base`, base);
  git(repo, "update-ref", `${REF(chain)}/stage/1`, s1);
  git(repo, "update-ref", `${REF(chain)}/stage/2`, s2);
  e.ctx.store.touch("w1", { projectID: "repo", state: "RESULT_READY", chain: { id: chain, n: 1, baseline: base } });
  e.ctx.store.touch("w2", { projectID: "repo", state: "RESULT_READY", chain: { id: chain, n: 2, baseline: s1 } });
  const decisions = join(e.stateDir, "chains", `${chain}.decisions.json`);
  /** What a crash after the APPLYING write leaves behind. */
  const crashApplying = (n: number, result: string) => {
    const rec = JSON.parse(readFileSync(decisions, "utf8"));
    rec.events.push({ n, event: "APPLYING", result, at: new Date().toISOString(), by: { sessionID: "rev", agent: REVIEWER } });
    writeFileSync(decisions, JSON.stringify(rec));
  };
  /** The owner's hand apply of stage 1: its content on the host working tree. */
  const handApplyStage1 = () => {
    writeFileSync(join(repo, "a.txt"), "a two\n");
    writeFileSync(join(repo, "b.txt"), "b\n");
    rmSync(join(repo, "d.txt"));
  };
  const history = async (n: number) => (await show(e, chain, n)).history ?? [];
  return { ...e, base, s1, s2, chain, crashApplying, handApplyStage1, history, rec: (op: string, n: number, session = "rev") => decide(e, op, chain, n, n === 1 ? s1 : s2, {}, session) };
}

describe("reconcile (carry-forward: stuck APPLYING, hand-applied S17 stages)", () => {
  test("an APPLYING stage whose content is on the host becomes APPLIED with the reconciled marker, and the host is not written", async () => {
    const f = seeded();
    await f.rec("stageApprove", 1);
    f.crashApplying(1, f.s1);
    f.handApplyStage1();
    expect((await show(f, f.chain, 1)).state).toBe("APPLYING");
    // positive control: while APPLYING, a normal apply is refused
    await expect(f.rec("stageApply", 1)).rejects.toThrow(/APPLYING/);
    const before = hostFingerprint(f.repo);
    const out = await f.rec("stageReconcile", 1);
    expect(out).toMatchObject({ chainID: f.chain, n: 1, state: "APPLIED", reconciled: true, result: f.s1 });
    expect(hostFingerprint(f.repo)).toBe(before); // reconcile never writes the host
    const h = await f.history(1);
    expect(h.map((x: any) => x.event)).toEqual(["APPROVED", "APPLYING", "APPLIED"]);
    expect(h[2]).toMatchObject({ reconciled: true, result: f.s1, by: { sessionID: "rev", agent: REVIEWER } });
    expect((await show(f, f.chain, 1)).state).toBe("APPLIED");
    await expect(f.rec("stageReconcile", 1)).rejects.toThrow(/APPLIED/); // not twice
    // positive control: the fingerprint sees a host edit
    writeFileSync(join(f.repo, "b.txt"), "changed\n");
    expect(hostFingerprint(f.repo)).not.toBe(before);
  });

  test("a host that does not match records nothing and returns every difference (changed, missing and undeleted paths)", async () => {
    const f = seeded();
    await f.rec("stageApprove", 1);
    f.crashApplying(1, f.s1);
    const before = hostFingerprint(f.repo);
    const none = await f.rec("stageReconcile", 1); // nothing was applied
    expect(none).toMatchObject({ state: "APPLYING", reconciled: false, differenceCount: 3 });
    expect(none.differences.join("\n")).toMatch(/a\.txt.*differs/);
    expect(none.differences.join("\n")).toMatch(/b\.txt.*missing/);
    expect(none.differences.join("\n")).toMatch(/d\.txt.*deleted by the stage but present/);
    expect(hostFingerprint(f.repo)).toBe(before);
    expect((await f.history(1)).map((x: any) => x.event)).toEqual(["APPROVED", "APPLYING"]);
    // a nearly applied tree: only the wrong path is named
    f.handApplyStage1();
    writeFileSync(join(f.repo, "b.txt"), "b but edited\n");
    const partial = await f.rec("stageReconcile", 1);
    expect(partial).toMatchObject({ reconciled: false, differenceCount: 1 });
    expect(partial.differences[0]).toMatch(/^b\.txt/);
    expect((await show(f, f.chain, 1)).state).toBe("APPLYING");
    // a symlink where a file belongs is a difference, not a pass
    rmSync(join(f.repo, "b.txt"));
    symlinkSync("a.txt", join(f.repo, "b.txt"));
    expect((await f.rec("stageReconcile", 1)).differences[0]).toMatch(/b\.txt.*not a regular file/);
    // positive control: the exact content reconciles
    rmSync(join(f.repo, "b.txt"));
    writeFileSync(join(f.repo, "b.txt"), "b\n");
    expect((await f.rec("stageReconcile", 1)).state).toBe("APPLIED");
  });

  test("an APPROVED protected (S17) stage the owner applied by hand is reconciled; an unapplied one is not", async () => {
    const f = seeded();
    await f.rec("stageApprove", 1);
    await f.rec("stageApply", 1);
    await decide(f, "stageApprove", f.chain, 2, f.s2, { confirmProtected: true });
    const before = hostFingerprint(f.repo);
    const nothing = await f.rec("stageReconcile", 2);
    expect(nothing).toMatchObject({ state: "APPROVED", reconciled: false });
    expect(nothing.differences[0]).toMatch(/broker\/src\/x\.ts.*missing/);
    expect(hostFingerprint(f.repo)).toBe(before);
    mkdirSync(join(f.repo, "broker/src"), { recursive: true });
    writeFileSync(join(f.repo, "broker/src/x.ts"), "export {};\n"); // the hand apply
    const out = await f.rec("stageReconcile", 2);
    expect(out).toMatchObject({ n: 2, state: "APPLIED", reconciled: true, touchesProtected: true });
    expect((await f.history(2)).map((x: any) => x.event)).toEqual(["APPROVED", "APPLIED"]);
  });

  test("it refuses a READY stage, an APPROVED non-protected stage, a rejected stage and an out-of-order stage", async () => {
    const f = seeded();
    await refusedLeavesHost(f, () => f.rec("stageReconcile", 1), /READY/);
    await f.rec("stageApprove", 1);
    f.handApplyStage1();
    await refusedLeavesHost(f, () => f.rec("stageReconcile", 1), /only an APPLYING stage or an APPROVED protected/); // use stageApply instead
    // stage 2 (protected, approved, hand-applied) cannot be reconciled while stage 1 is not APPLIED
    await decide(f, "stageApprove", f.chain, 2, f.s2, { confirmProtected: true });
    mkdirSync(join(f.repo, "broker/src"), { recursive: true });
    writeFileSync(join(f.repo, "broker/src/x.ts"), "export {};\n");
    await refusedLeavesHost(f, () => f.rec("stageReconcile", 2), /stage 1 is not APPLIED/);
    expect((await f.history(2)).map((x: any) => x.event)).toEqual(["APPROVED"]);
    // a rejected stage is not reconciled
    const g = seeded();
    await g.rec("stageReject", 1);
    await refusedLeavesHost(g, () => g.rec("stageReconcile", 1), /REJECTED/);
    await refusedLeavesHost(g, () => g.rec("stageReconcile", 2), /STALE/);
    // the payload carries no extra field
    await expect(f.dispatch("stageReconcile", "rev", { chainID: f.chain, n: 1, result: f.s1, confirm: "APPLY" })).rejects.toThrow(/unexpected field/);
  });

  test("a stage ref rewritten after approval is not reconciled (the approval names the commit)", async () => {
    const f = seeded();
    await f.rec("stageApprove", 1);
    f.crashApplying(1, f.s1);
    f.handApplyStage1();
    git(f.repo, "update-ref", "-d", `${REF(f.chain)}/stage/1`);
    git(f.repo, "update-ref", `${REF(f.chain)}/stage/1`, f.s2);
    await expect(f.rec("stageReconcile", 1)).rejects.toThrow(/pinned result commit/);
    await expect(decide(f, "stageReconcile", f.chain, 1, f.s2)).rejects.toThrow(/moved since approval/);
    expect((await f.history(1)).map((x: any) => x.event)).toEqual(["APPROVED", "APPLYING"]);
  });

  test("only the stage-review role reconciles; every other identity and a worker of the chain is denied", async () => {
    const f = seeded();
    await f.rec("stageApprove", 1);
    f.crashApplying(1, f.s1);
    f.handApplyStage1();
    f.ctx.store.touch("w1", { agent: REVIEWER });
    for (const session of ["orch", "plain", "wrk", "unknown-session", "w1"]) {
      await refusedLeavesHost(f, () => f.rec("stageReconcile", 1, session), /stage-review|worker/);
    }
    expect((await f.history(1)).map((x: any) => x.event)).toEqual(["APPROVED", "APPLYING"]);
    f.ctx.store.touch("w1", { agent: undefined });
    expect((await f.rec("stageReconcile", 1)).reconciled).toBe(true); // positive control
  });
});

describe("registration, admission, tool and fragments for stageReconcile", () => {
  test("the operation is registered once, sandbox-guard exempt, a stage-review-only mutation with a strict payload", () => {
    expect(OPERATIONS).toContain("stageReconcile" as never);
    expect(new Set(OPERATIONS).size).toBe(OPERATIONS.length);
    expect(SANDBOX_GUARD_CLASS).toHaveProperty("stageReconcile", "exempt-from-sandbox-guard");
    expect(hostToolAccess("stageReconcile")).toBe("mutation");
    expect(HOST_MUTATION_OPERATIONS).not.toContain("stageReconcile");
    for (const ops of Object.values(HOST_MUTATION_IDENTITY_OPERATIONS)) expect(ops).not.toContain("stageReconcile");
    expect(ALLOWED_PAYLOAD_KEYS).toMatchObject({ stageReconcile: ["chainID", "n", "result"] });
  });

  test("tool admission: the reviewer is admitted to host_stage_reconcile, every other identity is denied", async () => {
    const e = env();
    const admit = (session: string, tool: string) =>
      buildToolAdmissionOp(e.ctx)({ version: 1, id: "a", operation: "toolAdmission", sessionID: session, payload: { tool } } as BrokerRequestEnvelope) as Promise<{ decision: string }>;
    expect(classifyOperation("host_stage_reconcile")).toBe("HOST_ADMIN_STRUCTURED");
    expect((await admit("rev", "host_stage_reconcile")).decision).toBe("allow");
    for (const other of ["orch", "plain", "wrk", "unknown-session"]) expect((await admit(other, "host_stage_reconcile")).decision, other).toBe("deny");
    expect(decideStageReview("HOST_ADMIN_STRUCTURED", "host_stage_reconcile").decision).toBe("allow");
    expect(decideStageReview("HOST_ADMIN_STRUCTURED", "host_stage_unknown").decision).toBe("deny"); // positive control: admission is by tool name
  });

  const ROOT = join(import.meta.dir, "../..");
  const specs = readFileSync(join(ROOT, "opencode/plugins/lib/tool-specs-host-ops.ts"), "utf8");
  const block = (tool: string) => specs.split(new RegExp(`\\n {2}${tool}: defineTool\\(\\{`))[1]?.split(/\n {2}host_[a-z_]+: defineTool/)[0] ?? "";
  const rule = (file: string, tool: string) => new RegExp(`^\\s*"${tool}":\\s*"(\\w+)"`, "m").exec(readFileSync(join(ROOT, file), "utf8"))?.[1];

  test("the tool asks the owner in code, calls only stageReconcile, and both fragments deny it globally", () => {
    const body = block("host_stage_reconcile");
    expect(body).toContain("ctx.ask(");
    expect(body).toContain('"stageReconcile"');
    expect(body).not.toContain('"stageApply"');
    expect(block("host_stage_list")).not.toContain("ctx.ask("); // positive control: the scan tells ask from no-ask
    for (const file of ["opencode/config-fragments/sandbox-permissions.jsonc", "opencode/plugins-v2/config-fragments/sandbox-permissions.jsonc"]) {
      expect(rule(file, "host_stage_reconcile")).toBe("deny");
      expect(rule(file, "host_stage_list")).toBe("deny"); // positive control: the reader finds rules
    }
  });
});
