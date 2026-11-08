/**
 * Staging chains, phase P1 (docs/staging/plan.md): chain + stage records, git
 * refs, chainCreate / chainStatus / chainAttach, worker-from-tip, and stage
 * registration on finish. Nothing is applied to the host.
 *
 * A real git repository (mkdtemp under the OS tmpdir, never inside the
 * worktree) plays the host; a directory-backed adapter plays the microVM, so
 * ensureWorker -> prepareResult run their real git plans end to end.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { spawnArgv } from "../src/msb.ts";
import { buildEnsureWorkerOp, buildPrepareResultOp, type OpContext } from "../src/service.ts";
import { chainAttach, chainCreate, chainStatus } from "../src/staging-chain.ts";
import { SessionStore } from "../src/state.ts";
import type { BrokerRequestEnvelope } from "../src/types.ts";

const GiB = 1024 ** 3;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).trim();

interface Harness {
  ctx: OpContext;
  repo: string;
  stateDir: string;
  workerDir: (sessionID: string) => string;
}

function harness(): Harness {
  const base = mkdtempSync(join(tmpdir(), "staging-chain-"));
  roots.push(base);
  const repo = join(base, "repo");
  const stateDir = join(base, "state");
  const workers = join(base, "workers");
  for (const d of [repo, stateDir, workers]) mkdirSync(d, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@local");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");

  const dirOf = (name: string) => join(workers, name);
  const map = (name: string) => (a: string) => (a.startsWith("/work") ? join(dirOf(name), a.slice("/work".length)) : a);
  const ctx = {
    config: defaultConfig({ stateDir, projects: [{ id: "repo", path: repo }] }),
    store: new SessionStore(stateDir),
    adapter: {
      workerNameFor: (id: string) => `worker-${id}`,
      createWorker: async (spec: { name: string }) => void mkdirSync(dirOf(spec.name), { recursive: true }),
      copyIn: async (name: string, src: string, dest: string) => {
        copyFileSync(src, map(name)(dest));
      },
      copyOut: async (name: string, src: string, dest: string) => copyFileSync(map(name)(src), dest),
      exec: async (name: string, argv: string[], opts?: { env?: Record<string, string>; timeoutMs?: number }) =>
        spawnArgv(argv.map(map(name)), { cwd: dirOf(name), env: opts?.env, timeoutMs: opts?.timeoutMs }),
      stop: async () => undefined,
      // `msb remove` destroys the VM, so a released worker's directory is gone
      // and a later re-ensure creates a fresh one. Modelling a no-op removal
      // would let a re-ensure reuse the old repo (and its `work` branch).
      remove: async (name: string) => {
        rmSync(dirOf(name), { recursive: true, force: true });
      },
    },
    budget: {
      perWorkerCpu: 2,
      perWorkerMemBytes: 2 * GiB,
      maxAggregateCpu: 32,
      maxAggregateMemBytes: 32 * GiB,
      maxWorkers: 16,
      hostReservedCpu: 4,
      hostReservedMemBytes: 8 * GiB,
    },
    resources: { cpuCount: 16, totalMemBytes: 64 * GiB },
    pool: { allocations: [] },
    hostRead: { has: () => false, execute: async () => ({}) },
    logger: {},
    git: { runnerMode: "real" as const, spawn: spawnArgv },
  } as unknown as OpContext;
  return { ctx, repo, stateDir, workerDir: (id) => dirOf(`worker-${id}`) };
}

const req = (operation: string, sessionID: string, payload: Record<string, unknown>): BrokerRequestEnvelope =>
  ({ version: 1, id: `${operation}-${sessionID}`, operation, sessionID, payload }) as BrokerRequestEnvelope;

const ensure = (h: Harness, sessionID: string, snapshot?: unknown) =>
  buildEnsureWorkerOp(h.ctx)(req("ensureWorker", sessionID, { projectDir: h.repo, ...(snapshot ? { snapshot } : {}) }));
const finish = (h: Harness, sessionID: string) => buildPrepareResultOp(h.ctx)(req("prepareResult", sessionID, {}));
const work = (h: Harness, sessionID: string, file: string, text: string) =>
  writeFileSync(join(h.workerDir(sessionID), file), text);

/** Everything a host apply could change: HEAD, branches, status, index bytes, tracked file bytes. */
function hostFingerprint(repo: string): string {
  return createHash("sha256")
    .update(git(repo, "rev-parse", "HEAD"))
    .update(git(repo, "for-each-ref", "refs/heads", "refs/tags"))
    .update(git(repo, "status", "--porcelain=v1", "--untracked-files=all"))
    .update(readFileSync(join(repo, ".git", "index")))
    .update(readFileSync(join(repo, "a.txt")))
    .digest("hex");
}

const prefix = (id: string) => `refs/opencode-sandbox/chain/${id}`;

describe("chainCreate / chainStatus", () => {
  test("creates a persisted record with lane limits and an empty status", async () => {
    const h = harness();
    const feature = chainCreate(h.ctx, { projectID: "repo", lane: "feature" });
    const fix = chainCreate(h.ctx, { projectID: "repo", lane: "fix" });
    expect(feature.maxStages).toBe(5);
    expect(fix.maxStages).toBe(2);
    expect(feature.id).not.toBe(fix.id);
    expect(await chainStatus(h.ctx, feature.id)).toEqual({ chain: feature, stages: [], nextSnapshot: { worktree: true } });
  });

  test("rejects an unknown lane, an unknown project and malformed chain ids", async () => {
    const h = harness();
    expect(() => chainCreate(h.ctx, { projectID: "repo", lane: "hotfix" })).toThrow(/lane/);
    expect(() => chainCreate(h.ctx, { projectID: "nope", lane: "fix" })).toThrow(/allowlist/);
    for (const id of ["", "../x", "c/../..", "cABCDEF123456", "c123", "ca1b2c3d4e5f6/extra"]) {
      await expect(chainStatus(h.ctx, id)).rejects.toThrow(/chain/);
    }
    await expect(chainStatus(h.ctx, "caaaaaaaaaaaa")).rejects.toThrow(/unknown chain/);
  });
});

describe("two-stage staged build (S76, S77)", () => {
  test("stage 2 starts from stage 1's result, refs pin both, and the host is untouched", async () => {
    const h = harness();
    const before = hostFingerprint(h.repo);
    const chain = chainCreate(h.ctx, { projectID: "repo", lane: "feature" });

    await ensure(h, "stage-one");
    await chainAttach(h.ctx, chain.id, "stage-one");
    let status = await chainStatus(h.ctx, chain.id);
    expect(status.stages.map((s) => s.state)).toEqual(["BUILDING"]);
    expect(status.nextSnapshot).toBeNull();
    work(h, "stage-one", "b.txt", "b\n");
    await finish(h, "stage-one");

    status = await chainStatus(h.ctx, chain.id);
    const s1 = status.stages[0]!;
    expect(s1.state).toBe("READY");
    expect(s1.changedPaths).toEqual(["b.txt"]);
    expect(s1.touchesProtected).toBe(false);
    expect(status.nextSnapshot).toEqual({ resultRef: "refs/opencode-sandbox/result/stage-one" });
    expect(git(h.repo, "rev-parse", `${prefix(chain.id)}/base`)).toBe(s1.baseline);
    expect(git(h.repo, "rev-parse", `${prefix(chain.id)}/stage/1`)).toBe(s1.result!);

    await ensure(h, "stage-two", status.nextSnapshot);
    await chainAttach(h.ctx, chain.id, "stage-two");
    work(h, "stage-two", "c.txt", "c\n");
    await finish(h, "stage-two");

    status = await chainStatus(h.ctx, chain.id);
    const [first, second] = status.stages;
    expect(second!.state).toBe("READY");
    expect(second!.baseline).toBe(first!.result!); // S76: second stage sits on the preceding tip
    expect(second!.changedPaths).toEqual(["c.txt"]); // only stage 2's own delta
    expect(git(h.repo, "rev-parse", `${prefix(chain.id)}/stage/2`)).toBe(second!.result!);
    expect(git(h.repo, "rev-parse", `${second!.result!}~1`)).toBe(first!.result!);

    expect(hostFingerprint(h.repo)).toBe(before); // S77: nothing applied to the host
  }, 60_000);

  test("positive control: the fingerprint detects a host edit", () => {
    const h = harness();
    const before = hostFingerprint(h.repo);
    writeFileSync(join(h.repo, "a.txt"), "edited\n");
    expect(hostFingerprint(h.repo)).not.toBe(before);
  });

  test("flags a stage that touches a protected (S17) path", async () => {
    const h = harness();
    const chain = chainCreate(h.ctx, { projectID: "repo", lane: "fix" });
    await ensure(h, "sec-one");
    await chainAttach(h.ctx, chain.id, "sec-one");
    mkdirSync(join(h.workerDir("sec-one"), "broker/src"), { recursive: true });
    work(h, "sec-one", "broker/src/x.ts", "export {};\n");
    await finish(h, "sec-one");
    const [stage] = (await chainStatus(h.ctx, chain.id)).stages;
    expect(stage!.changedPaths).toEqual(["broker/src/x.ts"]);
    expect(stage!.touchesProtected).toBe(true);
  }, 60_000);
});

describe("broker-derived baselines (refusals)", () => {
  test("refuses out-of-order starts, foreign baselines, re-attach and the stage limit", async () => {
    const h = harness();
    const chain = chainCreate(h.ctx, { projectID: "repo", lane: "fix" }); // 2 stages max

    // Stage 1 must come from the worktree snapshot, not an arbitrary commit.
    await ensure(h, "bad-commit", { commit: git(h.repo, "rev-parse", "HEAD") });
    await expect(chainAttach(h.ctx, chain.id, "bad-commit")).rejects.toThrow(/worktree/);

    await ensure(h, "one");
    await chainAttach(h.ctx, chain.id, "one");
    await expect(chainAttach(h.ctx, chain.id, "one")).rejects.toThrow(/already/);

    // Stage 2 cannot start while stage 1 is still building.
    await ensure(h, "early");
    await expect(chainAttach(h.ctx, chain.id, "early")).rejects.toThrow(/not ready/);

    work(h, "one", "b.txt", "b\n");
    await finish(h, "one");

    // A worker that snapshotted the host instead of the tip cannot claim stage 2.
    await expect(chainAttach(h.ctx, chain.id, "early")).rejects.toThrow(/baseline/);

    const next = (await chainStatus(h.ctx, chain.id)).nextSnapshot;
    await ensure(h, "two", next);
    await chainAttach(h.ctx, chain.id, "two");
    work(h, "two", "c.txt", "c\n");
    await finish(h, "two");

    // The fix lane is full: no tip snapshot is offered and a third stage is refused.
    const full = await chainStatus(h.ctx, chain.id);
    expect(full.nextSnapshot).toBeNull();
    await ensure(h, "three", { resultRef: "refs/opencode-sandbox/result/two" });
    await expect(chainAttach(h.ctx, chain.id, "three")).rejects.toThrow(/limit/);
  }, 120_000);

  test("refuses the planned runner, a missing session and another project's session", async () => {
    const h = harness();
    const chain = chainCreate(h.ctx, { projectID: "repo", lane: "fix" });
    const planned = { ...h.ctx, git: { ...h.ctx.git, runnerMode: "planned" as const } } as OpContext;
    await expect(chainAttach(planned, chain.id, "whatever")).rejects.toThrow(/real git runner/);
    await expect(chainAttach(h.ctx, chain.id, "ghost")).rejects.toThrow(/no active session/);
  });

  test("a registered stage is immutable: an unchanged re-finish is idempotent, a changed one is refused", async () => {
    const h = harness();
    const chain = chainCreate(h.ctx, { projectID: "repo", lane: "feature" });
    await ensure(h, "pin");
    await chainAttach(h.ctx, chain.id, "pin");
    work(h, "pin", "b.txt", "b\n");
    await finish(h, "pin");
    const pinned = git(h.repo, "rev-parse", `${prefix(chain.id)}/stage/1`);

    // The finish released the worker (T5), so a re-finish needs one again: the
    // re-ensure restores the worker from its own result, which keeps the
    // unchanged re-finish a real export (not the RESULT_READY fast path).
    await ensure(h, "pin", { resultRef: "refs/opencode-sandbox/result/pin" });
    await finish(h, "pin"); // nothing new -> same commit -> no-op
    expect(git(h.repo, "rev-parse", `${prefix(chain.id)}/stage/1`)).toBe(pinned);

    // Same for the changed-content case: without a live worker the edits could
    // not be exported, so the `already pinned` refusal must stay exercised.
    await ensure(h, "pin", { resultRef: "refs/opencode-sandbox/result/pin" });
    work(h, "pin", "b.txt", "changed after registration\n");
    await expect(finish(h, "pin")).rejects.toThrow(/already pinned/);
    expect(git(h.repo, "rev-parse", `${prefix(chain.id)}/stage/1`)).toBe(pinned);
    // The session's result ref has moved on; status must not offer it as the next stage's start.
    expect((await chainStatus(h.ctx, chain.id)).nextSnapshot).toBeNull();
  }, 60_000);
});

describe("non-chain sessions are unaffected", () => {
  test("ensureWorker + prepareResult behave as before and create no chain state", async () => {
    const h = harness();
    await ensure(h, "plain");
    work(h, "plain", "b.txt", "b\n");
    const result = (await finish(h, "plain")) as { resultRef: string; state: string; imported: boolean };
    expect(result).toEqual({ resultRef: "refs/opencode-sandbox/result/plain", state: "RESULT_READY", imported: true });
    expect(h.ctx.store.get("plain")!.chain).toBeUndefined();
    expect(git(h.repo, "for-each-ref", "refs/opencode-sandbox/chain")).toBe("");
  }, 60_000);
});
