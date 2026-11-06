/**
 * Staging chains, phase P2 read-only half (docs/staging/plan.md, U2a): the
 * chain/stage broker operations, the `stageReviewAgents` role, and the
 * deny-by-default policy around host_stage_list / host_stage_show.
 *
 * A real git repository (mkdtemp under the OS tmpdir) plays the host; stages are
 * seeded straight into the stage refs plus session records, so no worker runs.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { spawnArgv } from "../src/msb.ts";
import { PolicyError } from "../src/policy.ts";
import { classifyOperation, decideStageReview } from "../src/role-policy.ts";
import { BrokerServer } from "../src/server.ts";
import { authorizeHostDispatch, bindSessionAgent, buildEnsureWorkerOp, buildToolAdmissionOp, type OpContext } from "../src/service.ts";
import { chainAttach, chainCreate, chainStatus } from "../src/staging-chain.ts";
import { OPERATIONS, SANDBOX_GUARD_CLASS, type BrokerRequestEnvelope } from "../src/types.ts";
import { ALLOWED_PAYLOAD_KEYS, HOST_MUTATION_OPERATIONS, HOST_READ_OPERATIONS, HostToolPolicy, hostToolAccess } from "../src/validation.ts";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const ORCH = "gentle-orchestrator";
const REVIEWER = "stage-review";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();

const REF = (id: string) => `refs/opencode-sandbox/chain/${id}`;

interface Env {
  server: BrokerServer;
  ctx: OpContext & { store: { touch(id: string, patch: Record<string, unknown>): unknown } };
  repo: string;
  base: string;
  s1: string;
  s2: string;
  dispatch(operation: string, sessionID: string, payload?: unknown): Promise<any>;
}

function fixture(): Env {
  const root = mkdtempSync(join(tmpdir(), "staging-stage-ops-"));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@local");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  const base = git(repo, "rev-parse", "HEAD");
  // Two stage commits on a side branch; the host branch never moves.
  git(repo, "checkout", "-q", "-b", "side");
  writeFileSync(join(repo, "b.txt"), "b\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "stage 1");
  const s1 = git(repo, "rev-parse", "HEAD");
  mkdirSync(join(repo, "broker/src"), { recursive: true });
  writeFileSync(join(repo, "broker/src/x.ts"), "export {};\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "stage 2");
  const s2 = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "main");

  const server = new BrokerServer(
    defaultConfig({
      stateDir: join(root, "state"),
      projects: [{ id: "repo", path: repo }],
      readOnlyAgents: [ORCH],
      stageReviewAgents: [REVIEWER],
    }),
  );
  const internals = server as unknown as { ctx: Env["ctx"]; dispatch(req: BrokerRequestEnvelope): Promise<unknown> };
  (internals.ctx as { git: unknown }).git = { runnerMode: "real", spawn: spawnArgv };
  internals.ctx.store.touch("orch", { agent: ORCH });
  internals.ctx.store.touch("rev", { agent: REVIEWER });
  internals.ctx.store.touch("plain", {});
  internals.ctx.store.touch("wrk", { agent: "worker" });
  const dispatch = (operation: string, sessionID: string, payload?: unknown) =>
    internals.dispatch({ version: 1, id: `t-${operation}`, operation, sessionID, payload } as BrokerRequestEnvelope) as Promise<any>;
  return { server, ctx: internals.ctx, repo, base, s1, s2, dispatch };
}

/** A chain with stage 1 READY (s1) and stage 2 READY (s2); stage 1's session result ref has moved on to s2. */
function seededChain(e: Env): string {
  const chain = chainCreate(e.ctx, { projectID: "repo", lane: "feature" });
  git(e.repo, "update-ref", `${REF(chain.id)}/base`, e.base);
  git(e.repo, "update-ref", `${REF(chain.id)}/stage/1`, e.s1);
  git(e.repo, "update-ref", `${REF(chain.id)}/stage/2`, e.s2);
  e.ctx.store.touch("w1", { projectID: "repo", state: "RESULT_READY", chain: { id: chain.id, n: 1, baseline: e.base } });
  e.ctx.store.touch("w2", { projectID: "repo", state: "RESULT_READY", chain: { id: chain.id, n: 2, baseline: e.s1 } });
  git(e.repo, "update-ref", "refs/opencode-sandbox/result/w1", e.s2); // advisory 1: the session ref moved ahead of the pinned stage
  return chain.id;
}

describe("registry and classification", () => {
  test("operations are registered once, exempt from the sandbox guard, with payload allowlists", () => {
    for (const op of ["chainCreate", "chainStatus", "chainAttach", "stageList", "stageShow"]) {
      expect(OPERATIONS).toContain(op as never);
      expect(SANDBOX_GUARD_CLASS).toHaveProperty(op, "exempt-from-sandbox-guard");
    }
    expect(new Set(OPERATIONS).size).toBe(OPERATIONS.length);
    expect(ALLOWED_PAYLOAD_KEYS).toMatchObject({
      chainCreate: ["projectDir", "lane"],
      chainStatus: ["chainID"],
      chainAttach: ["chainID", "sessionID"],
      stageList: ["chainID"],
      stageShow: ["chainID", "n"],
    });
  });

  test("chainCreate and chainAttach are host mutations; chainStatus, stageList and stageShow are host reads", () => {
    for (const op of ["chainCreate", "chainAttach"]) {
      expect(HOST_MUTATION_OPERATIONS).toContain(op);
      expect(hostToolAccess(op)).toBe("mutation");
    }
    for (const op of ["chainStatus", "stageList", "stageShow"]) {
      expect(HOST_READ_OPERATIONS).toContain(op);
      expect(hostToolAccess(op)).toBe("read");
    }
  });

  test("tool-admission classes: the stage tools are structured host reads", () => {
    expect(classifyOperation("host_stage_list")).toBe("HOST_READ_STRUCTURED");
    expect(classifyOperation("host_stage_show")).toBe("HOST_READ_STRUCTURED");
    expect(classifyOperation("chainCreate")).toBe("MUTATE_PROJECT");
    expect(classifyOperation("chainAttach")).toBe("MUTATE_PROJECT");
    expect(classifyOperation("host_stage_approve")).toBeNull(); // U2b: not classified yet, so denied
  });

  test("an existing comparable host read and mutation keep their classification and policy", () => {
    expect(hostToolAccess("sandboxResult")).toBe("read");
    expect(hostToolAccess("gitCommit")).toBe("mutation");
    expect(classifyOperation("host_sandbox_result")).toBe("HOST_READ_STRUCTURED");
    expect(classifyOperation("host_git_commit")).toBe("HOST_APPROVED_MUTATION");
    const policy = new HostToolPolicy([ORCH]);
    expect(policy.decide("sandboxResult", undefined)).toEqual({ allowed: true, access: "read", reasonCode: "HOST_READ_OPEN" });
    expect(policy.decide("gitCommit", ORCH).allowed).toBe(true);
    expect(policy.decide("gitCommit", REVIEWER)).toMatchObject({ allowed: false, reasonCode: "HOST_MUTATION_NOT_ORCHESTRATOR" });
    const e = fixture();
    // The new stageReviewAgents gate does not touch an existing read for an unbound session.
    expect(authorizeHostDispatch(e.ctx, "sandboxResult", "plain")).toBe("read");
    expect(authorizeHostDispatch(e.ctx, "gitCommit", "orch")).toBe("mutation");
  });
});

describe("stage-review role policy (deny by default)", () => {
  test("only a session bound to a stageReviewAgents name may list or show stages", async () => {
    const e = fixture();
    const id = seededChain(e);
    for (const session of ["orch", "plain", "wrk", "unknown-session"]) {
      await expect(e.dispatch("stageList", session, { chainID: id })).rejects.toBeInstanceOf(PolicyError);
      await expect(e.dispatch("stageShow", session, { chainID: id, n: 1 })).rejects.toBeInstanceOf(PolicyError);
    }
    expect((await e.dispatch("stageList", "rev", { chainID: id })).stages).toHaveLength(2);
    expect((await e.dispatch("stageShow", "rev", { chainID: id, n: 1 })).stage.n).toBe(1);
  });

  test("the stage-review role holds no mutation and no worker", async () => {
    const e = fixture();
    const id = seededChain(e);
    for (const op of ["chainCreate", "chainAttach", "gitCommit", "planDocWrite"]) {
      await expect(e.dispatch(op, "rev", op === "chainAttach" ? { chainID: id, sessionID: "w1" } : op === "chainCreate" ? { projectDir: e.repo, lane: "fix" } : {})).rejects.toBeInstanceOf(PolicyError);
    }
    for (const op of ["exec", "readFile", "writeFile", "applyPatch", "prepareResult", "destroyWorker"]) {
      await expect(e.dispatch(op, "rev", {})).rejects.toThrow(/stage-review/);
    }
    await expect(buildEnsureWorkerOp(e.ctx)({ version: 1, id: "x", operation: "ensureWorker", sessionID: "rev", payload: { projectDir: e.repo } } as BrokerRequestEnvelope)).rejects.toThrow(/stage-review/);
    // The envelope agent claim cannot smuggle the role into a worker start either.
    await expect(buildEnsureWorkerOp(e.ctx)({ version: 1, id: "x", operation: "ensureWorker", sessionID: "fresh", agent: REVIEWER, payload: { projectDir: e.repo } } as BrokerRequestEnvelope)).rejects.toThrow(/stage-review/);
  });

  test("the reviewer cannot be bound after it entered the worker lifecycle, and the name binds as an identity", () => {
    const e = fixture();
    expect(bindSessionAgent(e.ctx, "bind-ok", { agent: REVIEWER }).agent).toBe(REVIEWER);
    e.ctx.store.touch("has-worker", { state: "SANDBOX_ACTIVE" });
    expect(() => bindSessionAgent(e.ctx, "has-worker", { agent: REVIEWER })).toThrow(PolicyError);
    expect(() => bindSessionAgent(e.ctx, "other", { agent: "not-an-agent" })).toThrow(PolicyError);
  });

  test("tool admission: the reviewer gets read classes only; a plain role keeps today's answer", async () => {
    const e = fixture();
    const admit = (tool: string, session = "rev") =>
      buildToolAdmissionOp(e.ctx)({ version: 1, id: "a", operation: "toolAdmission", sessionID: session, payload: { tool } } as BrokerRequestEnvelope) as Promise<{ decision: string; reason: string }>;
    expect((await admit("host_stage_list")).decision).toBe("allow");
    expect((await admit("host_stage_show")).decision).toBe("allow");
    for (const tool of ["sandbox_write", "sandbox_bash", "host_git_commit", "chainCreate", "host_orca_report"]) {
      expect((await admit(tool)).decision, tool).toBe("deny");
    }
    expect(decideStageReview("MUTATE_PROJECT").decision).toBe("deny");
    expect(decideStageReview("nonsense").decision).toBe("deny");
    expect((await admit("host_sandbox_result", "wrk")).decision).toBe("deny"); // unchanged: a worker is not a structured-read role
  });

  test("config: stageReviewAgents must be non-empty names disjoint from readOnlyAgents", () => {
    expect(defaultConfig().stageReviewAgents).toEqual(["stage-review"]);
    expect(() => new BrokerServer(defaultConfig({ stageReviewAgents: [ORCH], readOnlyAgents: [ORCH] }))).toThrow(/stageReviewAgents/);
    expect(() => new BrokerServer(defaultConfig({ stageReviewAgents: [""] }))).toThrow(/stageReviewAgents/);
    expect(() => new BrokerServer(defaultConfig({ stageReviewAgents: "x" as unknown as string[] }))).toThrow(/stageReviewAgents/);
  });
});

describe("chain operations through the dispatcher", () => {
  test("an orchestrator creates a chain from a project root, reads its status, and a bad root is refused", async () => {
    const e = fixture();
    const created = await e.dispatch("chainCreate", "orch", { projectDir: e.repo, lane: "fix" });
    expect(created).toMatchObject({ projectID: "repo", lane: "fix", maxStages: 2 });
    expect(await e.dispatch("chainStatus", "orch", { chainID: created.id })).toEqual(await chainStatus(e.ctx, created.id));
    await expect(e.dispatch("chainCreate", "orch", { projectDir: join(e.repo, ".."), lane: "fix" })).rejects.toThrow();
    await expect(e.dispatch("chainCreate", "orch", { projectDir: e.repo, lane: "fix", extra: 1 })).rejects.toThrow(/unexpected field/);
  });

  test("chainAttach validates the session id before it touches the store (verifier advisory 2)", async () => {
    const e = fixture();
    const chain = chainCreate(e.ctx, { projectID: "repo", lane: "fix" });
    let touched = 0;
    const spied = new Proxy(e.ctx.store, { get: (t, p, r) => (typeof p === "string" && ["get", "touch", "list"].includes(p) ? (...a: unknown[]) => (touched++, (t as any)[p](...a)) : Reflect.get(t, p, r)) });
    const direct = { ...e.ctx, store: spied } as unknown as OpContext;
    for (const bad of ["../x", "a b", "", "x".repeat(300)]) {
      await expect(chainAttach(direct, chain.id, bad)).rejects.toThrow(/sessionID/);
    }
    expect(touched).toBe(0);
    await expect(e.dispatch("chainAttach", "orch", { chainID: chain.id, sessionID: "../x" })).rejects.toThrow(/sessionID/);
    await expect(e.dispatch("chainAttach", "orch", { chainID: chain.id, sessionID: "ghost" })).rejects.toThrow(/no active session/);
  });
});

describe("host_stage_list / host_stage_show read the stage refs (S78 read-only half)", () => {
  test("list reports state, baseline, result, changed paths and the S17 flag per stage", async () => {
    const e = fixture();
    const id = seededChain(e);
    const listed = await e.dispatch("stageList", "rev", { chainID: id });
    expect(listed.chain.id).toBe(id);
    expect(listed.nextSnapshot).toBeUndefined();
    expect(listed.stages).toEqual([
      { n: 1, sessionID: "w1", state: "READY", baseline: e.base, result: e.s1, changedPaths: ["b.txt"], touchesProtected: false },
      { n: 2, sessionID: "w2", state: "READY", baseline: e.s1, result: e.s2, changedPaths: ["broker/src/x.ts"], touchesProtected: true },
    ]);
  });

  test("a session result ref that moved ahead of the pinned stage is never read (verifier advisory 1)", async () => {
    const e = fixture();
    const id = seededChain(e);
    expect(git(e.repo, "rev-parse", "refs/opencode-sandbox/result/w1")).toBe(e.s2); // positive control: the moved ref is observable
    const shown = await e.dispatch("stageShow", "rev", { chainID: id, n: 1 });
    expect(shown.stage).toMatchObject({ n: 1, result: e.s1, changedPaths: ["b.txt"] });
    expect(shown.chain.id).toBe(id);
  });

  test("show refuses an unknown stage, a malformed number and a malformed chain id; BUILDING has no result", async () => {
    const e = fixture();
    const id = seededChain(e);
    for (const n of [0, 3, -1, 1.5, "1", null]) {
      await expect(e.dispatch("stageShow", "rev", { chainID: id, n })).rejects.toThrow();
    }
    await expect(e.dispatch("stageShow", "rev", { chainID: "../x", n: 1 })).rejects.toThrow(/chain/);
    await expect(e.dispatch("stageList", "rev", { chainID: "caaaaaaaaaaaa" })).rejects.toThrow(/unknown chain/);
    await expect(e.dispatch("stageList", "rev", { chainID: id, extra: 1 })).rejects.toThrow(/unexpected field/);
    git(e.repo, "update-ref", "-d", `${REF(id)}/stage/2`);
    const building = await e.dispatch("stageShow", "rev", { chainID: id, n: 2 });
    expect(building.stage).toEqual({ n: 2, sessionID: "w2", state: "BUILDING", baseline: e.s1 });
  });

  test("the operations change nothing: refs and host HEAD are identical afterwards", async () => {
    const e = fixture();
    const id = seededChain(e);
    const snap = () => git(e.repo, "for-each-ref") + git(e.repo, "rev-parse", "HEAD");
    const before = snap();
    await e.dispatch("stageList", "rev", { chainID: id });
    await e.dispatch("stageShow", "rev", { chainID: id, n: 2 });
    expect(snap()).toBe(before);
  });
});
