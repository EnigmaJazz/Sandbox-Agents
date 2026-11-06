/**
 * Gated acceptance suite for staging chains (plan P6; criteria S88, S89).
 *
 *   STAGING_ACCEPTANCE=dry   bun test tests/acceptance/staging.acceptance.test.ts   # fake worker adapter: proves the assertions
 *   SANDBOX_GATED_TESTS=staging bun test tests/acceptance/staging.acceptance.test.ts # installed stack: real msb workers
 *
 * Skipped unless one of those is set. The dry mode runs the same scenarios against a directory-backed fake
 * adapter; it shows the assertions can pass and fail, not that the installed stack is correct. Only the
 * stack mode, run by the owner, is acceptance evidence, and nothing here self-certifies: sign-off is the
 * owner's, recorded in odd/tasks/staging-chains.md.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../broker/src/config.ts";
import { spawnArgv } from "../../broker/src/msb.ts";
import { BrokerServer } from "../../broker/src/server.ts";
import type { BrokerRequestEnvelope } from "../../broker/src/types.ts";

const GATE = process.env.SANDBOX_GATED_TESTS ?? "";
const DRY = process.env.STAGING_ACCEPTANCE === "dry";
const STACK = GATE === "staging" || GATE === "all";
const enabled = DRY || STACK;
const GiB = 1024 ** 3;
const ORCH = "gentle-orchestrator";
const REVIEWER = "stage-review";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

interface Env {
  repo: string;
  dispatch(operation: string, sessionID: string, payload?: unknown): Promise<any>;
  hostState(): string;
}

function env(): Env {
  const root = mkdtempSync(join(tmpdir(), "staging-acceptance-"));
  roots.push(root);
  const repo = join(root, "repo");
  for (const d of [repo, join(root, "state"), join(root, "workers")]) mkdirSync(d, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@local");
  mkdirSync(join(repo, "broker/src"), { recursive: true });
  writeFileSync(join(repo, "a.txt"), "a\n");
  writeFileSync(join(repo, "broker/src/guard.ts"), "export {};\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");

  const server = new BrokerServer(
    defaultConfig({ stateDir: join(root, "state"), projects: [{ id: "repo", path: repo }], readOnlyAgents: [ORCH], stageReviewAgents: [REVIEWER] }),
  );
  const internals = server as unknown as { ctx: any; dispatch(req: BrokerRequestEnvelope): Promise<unknown> };
  const ctx = internals.ctx;
  if (DRY) {
    const workers = join(root, "workers");
    const dirOf = (name: string) => join(workers, name);
    const map = (name: string) => (a: string) => (a.startsWith("/work") ? join(dirOf(name), a.slice("/work".length)) : a);
    Object.assign(ctx, {
      git: { runnerMode: "real", spawn: spawnArgv },
      adapter: {
        workerNameFor: (id: string) => `worker-${id}`,
        createWorker: async (spec: { name: string }) => void mkdirSync(dirOf(spec.name), { recursive: true }),
        copyIn: async (name: string, src: string, dest: string) => {
          mkdirSync(join(map(name)(dest), ".."), { recursive: true });
          copyFileSync(src, map(name)(dest));
        },
        copyOut: async (name: string, src: string, dest: string) => void copyFileSync(map(name)(src), dest),
        exec: async (name: string, argv: string[], opts?: { env?: Record<string, string>; timeoutMs?: number }) =>
          spawnArgv(argv.map(map(name)), { cwd: dirOf(name), env: opts?.env, timeoutMs: opts?.timeoutMs }),
        stop: async () => undefined,
        remove: async () => undefined,
      },
      budget: { perWorkerCpu: 2, perWorkerMemBytes: 2 * GiB, maxAggregateCpu: 32, maxAggregateMemBytes: 32 * GiB, maxWorkers: 16, hostReservedCpu: 4, hostReservedMemBytes: 8 * GiB },
      resources: { cpuCount: 16, totalMemBytes: 64 * GiB },
    });
  } else {
    ctx.git.runnerMode = "real";
  }
  ctx.store.touch("orch", { agent: ORCH });
  ctx.store.touch("rev", { agent: REVIEWER });
  const dispatch = (operation: string, sessionID: string, payload?: unknown) =>
    internals.dispatch({ version: 1, id: `acc-${operation}`, operation, sessionID, payload } as BrokerRequestEnvelope) as Promise<any>;
  const hostState = () => [git(repo, "rev-parse", "HEAD"), git(repo, "status", "--porcelain=v1", "--untracked-files=all"), git(repo, "diff", "--cached", "--stat")].join("\n");
  return { repo, dispatch, hostState };
}

/** Start a worker from the chain's offered snapshot, bind it to the next stage, write files through the sandbox write tool, and finish it. */
async function buildStage(e: Env, chainID: string, sessionID: string, files: Record<string, string>): Promise<void> {
  const { nextSnapshot } = await e.dispatch("chainStatus", "orch", { chainID });
  expect(nextSnapshot, `a snapshot is offered for ${sessionID}`).not.toBeNull();
  await e.dispatch("ensureWorker", sessionID, { projectDir: e.repo, snapshot: nextSnapshot });
  await e.dispatch("chainAttach", "orch", { chainID, sessionID });
  for (const [path, content] of Object.entries(files)) await e.dispatch("writeFile", sessionID, { path, content });
  await e.dispatch("prepareResult", sessionID, {});
}

const stageOf = async (e: Env, chainID: string, n: number) => (await e.dispatch("stageShow", "rev", { chainID, n })).stage;
const decide = (e: Env, op: string, chainID: string, n: number, result: string, extra: Record<string, unknown> = {}) =>
  e.dispatch(op, "rev", { chainID, n, result, ...(op === "stageApply" ? { confirm: "APPLY" } : {}), ...(op === "stageReject" ? { note: "rework this" } : {}), ...extra });

describe("acceptance: staging chains (P6)", () => {
  test.skipIf(!enabled)("two stages are built in order and nothing reaches the host until a stage is applied", async () => {
    const e = env();
    const before = e.hostState();
    const { id } = await e.dispatch("chainCreate", "orch", { projectDir: e.repo, lane: "feature" });
    await buildStage(e, id, "acc-s1", { "one.txt": "one\n" });
    await buildStage(e, id, "acc-s2", { "two.txt": "two\n" });
    const listed = (await e.dispatch("stageList", "rev", { chainID: id })).stages;
    expect(listed.map((s: any) => [s.n, s.state])).toEqual([[1, "READY"], [2, "READY"]]);
    expect(e.hostState()).toBe(before);
  }, 300_000);

  test.skipIf(!enabled)("review before apply: stages apply strictly in order and each lands only its own delta", async () => {
    const e = env();
    const { id } = await e.dispatch("chainCreate", "orch", { projectDir: e.repo, lane: "feature" });
    await buildStage(e, id, "acc-s1", { "one.txt": "one\n" });
    await buildStage(e, id, "acc-s2", { "two.txt": "two\n" });
    const [s1, s2] = [await stageOf(e, id, 1), await stageOf(e, id, 2)];
    await decide(e, "stageApprove", id, 2, s2.result);
    const before = e.hostState();
    await expect(decide(e, "stageApply", id, 2, s2.result)).rejects.toThrow(/stage 1 is not APPLIED/);
    expect(e.hostState()).toBe(before);
    await decide(e, "stageApprove", id, 1, s1.result);
    await decide(e, "stageApply", id, 1, s1.result);
    expect(readFileSync(join(e.repo, "one.txt"), "utf8")).toBe("one\n");
    expect(existsSync(join(e.repo, "two.txt"))).toBe(false);
    expect(git(e.repo, "rev-parse", "HEAD")).toBe(before.split("\n")[0]); // working tree only: HEAD and index untouched
    expect(git(e.repo, "diff", "--cached", "--stat")).toBe("");
    await decide(e, "stageApply", id, 2, s2.result);
    expect(readFileSync(join(e.repo, "two.txt"), "utf8")).toBe("two\n");
  }, 300_000);

  test.skipIf(!enabled)("rejecting a stage marks later stages STALE and the rebuilt stage applies", async () => {
    const e = env();
    const { id } = await e.dispatch("chainCreate", "orch", { projectDir: e.repo, lane: "feature" });
    await buildStage(e, id, "acc-s1", { "one.txt": "one\n" });
    await buildStage(e, id, "acc-s2", { "two.txt": "two\n" });
    const [s1, s2] = [await stageOf(e, id, 1), await stageOf(e, id, 2)];
    await decide(e, "stageReject", id, 1, s1.result);
    expect((await stageOf(e, id, 2)).state).toBe("STALE");
    await expect(decide(e, "stageApprove", id, 2, s2.result)).rejects.toThrow();
    await buildStage(e, id, "acc-s1b", { "one-b.txt": "one b\n" });
    const rebuilt = await stageOf(e, id, 1);
    expect(rebuilt.result).not.toBe(s1.result);
    await decide(e, "stageApprove", id, 1, rebuilt.result);
    await decide(e, "stageApply", id, 1, rebuilt.result);
    expect(existsSync(join(e.repo, "one-b.txt"))).toBe(true);
    expect(existsSync(join(e.repo, "one.txt"))).toBe(false);
  }, 300_000);

  test.skipIf(!enabled)("a stage that touches a protected path is never applied through the chain", async () => {
    const e = env();
    const { id } = await e.dispatch("chainCreate", "orch", { projectDir: e.repo, lane: "feature" });
    await buildStage(e, id, "acc-s1", { "broker/src/guard.ts": "export const weakened = true;\n" });
    const s1 = await stageOf(e, id, 1);
    expect(s1.touchesProtected).toBe(true);
    const before = e.hostState();
    await decide(e, "stageApprove", id, 1, s1.result, { confirmProtected: true });
    await expect(decide(e, "stageApply", id, 1, s1.result)).rejects.toThrow(/protected/);
    expect(e.hostState()).toBe(before);
  }, 300_000);

  test.skipIf(!enabled)("roles: the reviewer decides but builds nothing; the orchestrator builds but cannot decide", async () => {
    const e = env();
    const { id } = await e.dispatch("chainCreate", "orch", { projectDir: e.repo, lane: "feature" });
    await buildStage(e, id, "acc-s1", { "one.txt": "one\n" });
    const s1 = await stageOf(e, id, 1);
    await expect(e.dispatch("ensureWorker", "rev", { projectDir: e.repo })).rejects.toThrow(/stage-review/);
    await expect(e.dispatch("writeFile", "rev", { path: "x.txt", content: "x" })).rejects.toThrow();
    for (const op of ["stageApprove", "stageReject", "stageApply"]) {
      await expect(e.dispatch(op, "orch", { chainID: id, n: 1, result: s1.result, confirm: "APPLY", note: "n" }), op).rejects.toThrow();
    }
    await expect(e.dispatch("chainStatus", "rev", { chainID: id })).rejects.toThrow();
  }, 300_000);

  test.skipIf(!enabled)("a stage the reviewer cannot see in full is refused", async () => {
    const e = env();
    const { id } = await e.dispatch("chainCreate", "orch", { projectDir: e.repo, lane: "feature" });
    const files: Record<string, string> = {};
    for (let i = 0; i < 201; i++) files[`many/f${i}.txt`] = `${i}\n`;
    await buildStage(e, id, "acc-s1", files);
    const s1 = await stageOf(e, id, 1);
    expect(s1.changedPaths).toHaveLength(200);
    expect(s1.changedPathsOmitted).toBe(1);
    await expect(decide(e, "stageApprove", id, 1, s1.result)).rejects.toThrow(/in full/);
  }, 300_000);
});
