/**
 * Staging chains, phase P2 decision half (docs/staging/plan.md, U2b): the owner's
 * stageApprove / stageReject / stageApply operations and their tools.
 *
 * A real git repository (mkdtemp under the OS tmpdir) plays the host. Stages are
 * seeded straight into the stage refs plus session records, so no worker runs.
 * Every refusal is followed by a host fingerprint check; the fingerprint has a
 * positive control (a host edit and a real apply both change it).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { spawnArgv } from "../src/msb.ts";
import { PolicyError } from "../src/policy.ts";
import { classifyOperation, decideStageReview } from "../src/role-policy.ts";
import { BrokerServer } from "../src/server.ts";
import { authorizeHostDispatch, buildToolAdmissionOp, type OpContext } from "../src/service.ts";
import { chainCreate } from "../src/staging-chain.ts";
import { OPERATIONS, SANDBOX_GUARD_CLASS, type BrokerRequestEnvelope } from "../src/types.ts";
import { ALLOWED_PAYLOAD_KEYS, HOST_MUTATION_IDENTITY_OPERATIONS, HOST_MUTATION_OPERATIONS, hostToolAccess } from "../src/validation.ts";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const ORCH = "gentle-orchestrator";
const REVIEWER = "stage-review";
const DECISIONS = ["stageApprove", "stageReject", "stageApply"] as const;
const TOOLS = ["host_stage_approve", "host_stage_reject", "host_stage_apply"] as const;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();

const REF = (id: string) => `refs/opencode-sandbox/chain/${id}`;

interface Env {
  ctx: OpContext & { store: { touch(id: string, patch: Record<string, unknown>): unknown } };
  repo: string;
  stateDir: string;
  base: string;
  s1: string;
  s2: string;
  chain: string;
  dispatch(operation: string, sessionID: string, payload?: unknown): Promise<any>;
  /** approve + apply helper for the reviewer session */
  decide(operation: (typeof DECISIONS)[number], n: number, extra?: Record<string, unknown>, session?: string): Promise<any>;
}

/**
 * Host = main at `base` (a.txt). Stage 1 adds b.txt (s1); stage 2 adds broker/src/x.ts (s2, an S17 path).
 * The stage 1 session's result ref has moved ahead to s2 (verifier advisory: apply must use the pinned ref).
 */
function fixture(): Env {
  const root = mkdtempSync(join(tmpdir(), "staging-stage-decisions-"));
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

  const stateDir = join(root, "state");
  const server = new BrokerServer(
    defaultConfig({ stateDir, projects: [{ id: "repo", path: repo }], readOnlyAgents: [ORCH], stageReviewAgents: [REVIEWER] }),
  );
  const internals = server as unknown as { ctx: Env["ctx"]; dispatch(req: BrokerRequestEnvelope): Promise<unknown> };
  (internals.ctx as { git: unknown }).git = { runnerMode: "real", spawn: spawnArgv };
  const ctx = internals.ctx;
  ctx.store.touch("orch", { agent: ORCH });
  ctx.store.touch("rev", { agent: REVIEWER });
  ctx.store.touch("plain", {});
  ctx.store.touch("wrk", { agent: "worker" });
  const chain = chainCreate(ctx, { projectID: "repo", lane: "feature" }).id;
  git(repo, "update-ref", `${REF(chain)}/base`, base);
  git(repo, "update-ref", `${REF(chain)}/stage/1`, s1);
  git(repo, "update-ref", `${REF(chain)}/stage/2`, s2);
  ctx.store.touch("w1", { projectID: "repo", state: "RESULT_READY", chain: { id: chain, n: 1, baseline: base } });
  ctx.store.touch("w2", { projectID: "repo", state: "RESULT_READY", chain: { id: chain, n: 2, baseline: s1 } });
  git(repo, "update-ref", "refs/opencode-sandbox/result/w1", s2);

  const dispatch = (operation: string, sessionID: string, payload?: unknown) =>
    internals.dispatch({ version: 1, id: `t-${operation}`, operation, sessionID, payload } as BrokerRequestEnvelope) as Promise<any>;
  const results: Record<number, string> = { 1: s1, 2: s2 };
  const decide: Env["decide"] = (operation, n, extra = {}, session = "rev") => {
    const body: Record<string, unknown> = { chainID: chain, n, result: results[n] };
    if (operation === "stageApply") body.confirm = "APPLY";
    if (operation === "stageReject") body.note = "please split this";
    return dispatch(operation, session, { ...body, ...extra });
  };
  return { ctx, repo, stateDir, base, s1, s2, chain, dispatch, decide };
}

/** Everything an apply could change on the host: HEAD, branches, status, index bytes, and file bytes of every non-.git file. */
function hostFingerprint(repo: string): string {
  const h = createHash("sha256")
    .update(git(repo, "rev-parse", "HEAD"))
    .update(git(repo, "for-each-ref", "refs/heads", "refs/tags"))
    .update(git(repo, "status", "--porcelain=v1", "--untracked-files=all"))
    .update(readFileSync(join(repo, ".git", "index")));
  const walk = (dir: string) => {
    for (const name of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (name.name === ".git") continue;
      const p = join(dir, name.name);
      h.update(p);
      if (name.isDirectory()) walk(p);
      else h.update(readFileSync(p));
    }
  };
  walk(repo);
  return h.digest("hex");
}

/** Run `fn`, which must reject, and prove the host is byte-identical afterwards. */
async function refusedLeavesHost(e: Env, fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  const before = hostFingerprint(e.repo);
  await expect(fn()).rejects.toThrow(pattern);
  expect(hostFingerprint(e.repo)).toBe(before);
}

const history = async (e: Env, n: number): Promise<any[]> => (await e.dispatch("stageShow", "rev", { chainID: e.chain, n })).stage.history ?? [];

describe("registry, classification and positive controls", () => {
  test("the three decisions are registered once, sandbox-guard exempt, with strict payload allowlists", () => {
    for (const op of DECISIONS) {
      expect(OPERATIONS).toContain(op as never);
      expect(SANDBOX_GUARD_CLASS).toHaveProperty(op, "exempt-from-sandbox-guard");
      expect(hostToolAccess(op)).toBe("mutation");
      // Not a general host mutation: no orchestrator identity is granted them.
      expect(HOST_MUTATION_OPERATIONS).not.toContain(op);
      for (const ops of Object.values(HOST_MUTATION_IDENTITY_OPERATIONS)) expect(ops).not.toContain(op);
    }
    expect(new Set(OPERATIONS).size).toBe(OPERATIONS.length);
    expect(ALLOWED_PAYLOAD_KEYS).toMatchObject({
      stageApprove: ["chainID", "n", "result", "confirmProtected"],
      stageReject: ["chainID", "n", "result", "note"],
      stageApply: ["chainID", "n", "result", "confirm"],
    });
  });

  test("tool admission: the reviewer is admitted to exactly the three decision tools beyond its reads", async () => {
    const e = fixture();
    const admit = (tool: string, session = "rev") =>
      buildToolAdmissionOp(e.ctx)({ version: 1, id: "a", operation: "toolAdmission", sessionID: session, payload: { tool } } as BrokerRequestEnvelope) as Promise<{ decision: string; classification: string }>;
    for (const tool of TOOLS) {
      expect(classifyOperation(tool)).toBe("HOST_ADMIN_STRUCTURED");
      expect((await admit(tool)).decision, tool).toBe("allow");
      // Every other identity is denied, as the broker operation does: the orchestrator, a plain and an unbound session, a worker.
      for (const other of ["orch", "plain", "wrk", "unknown-session"]) expect((await admit(tool, other)).decision, `${tool} for ${other}`).toBe("deny");
    }
    // The widening is by tool name, never by capability class: a sibling approved mutation stays denied.
    expect((await admit("host_git_commit")).decision).toBe("deny");
    expect(decideStageReview("HOST_APPROVED_MUTATION").decision).toBe("deny");
    expect(decideStageReview("HOST_APPROVED_MUTATION", "host_stage_apply").decision).toBe("deny");
    expect(decideStageReview("HOST_ADMIN_STRUCTURED", "host_stage_apply").decision).toBe("allow");
    expect(decideStageReview("HOST_ADMIN_STRUCTURED").decision).toBe("deny");
    expect(decideStageReview("MUTATE_PROJECT", "host_stage_apply").decision).toBe("deny");
  });

  test("positive control: the fingerprint sees a host edit, and a real apply changes it", async () => {
    const e = fixture();
    const before = hostFingerprint(e.repo);
    writeFileSync(join(e.repo, "a.txt"), "edited\n");
    expect(hostFingerprint(e.repo)).not.toBe(before);
    writeFileSync(join(e.repo, "a.txt"), "a\n");
    expect(hostFingerprint(e.repo)).toBe(before);
    await e.decide("stageApprove", 1);
    expect(hostFingerprint(e.repo)).toBe(before); // approving alone never touches the host
    await e.decide("stageApply", 1);
    expect(hostFingerprint(e.repo)).not.toBe(before);
  });
});

describe("identity: nothing but the stage-review role decides (S80)", () => {
  test("every other identity is denied all three decisions, and the host and records are untouched", async () => {
    const e = fixture();
    // A session that owns a stage of the chain, even if it were bound to the review name, may not decide on it.
    e.ctx.store.touch("w1", { agent: REVIEWER });
    for (const session of ["orch", "plain", "wrk", "unknown-session", "w1"]) {
      for (const op of DECISIONS) {
        await refusedLeavesHost(e, () => e.decide(op, 1, {}, session), /stage-review|worker/);
      }
    }
    expect(existsSync(join(e.stateDir, "chains", `${e.chain}.decisions.json`))).toBe(false);
    // positive control: the same calls work for the reviewer
    await e.decide("stageApprove", 1);
    expect(existsSync(join(e.stateDir, "chains", `${e.chain}.decisions.json`))).toBe(true);
  });

  test("the envelope agent claim never authorizes", async () => {
    const e = fixture();
    const claim = (agent: string) =>
      authorizeHostDispatch(e.ctx, "stageApply", "plain", agent);
    expect(() => claim(REVIEWER)).toThrow(PolicyError);
    expect(authorizeHostDispatch(e.ctx, "stageApply", "rev")).toBe("mutation");
  });

  test("the reviewer role still holds no worker or sandbox operation", async () => {
    const e = fixture();
    await expect(e.dispatch("exec", "rev", {})).rejects.toThrow(/stage-review/);
    await expect(e.dispatch("applyResult", "rev", { confirm: "APPLY" })).rejects.toThrow(/stage-review/);
    await expect(e.dispatch("gitCommit", "rev", {})).rejects.toBeInstanceOf(PolicyError);
  });
});

describe("approve and reject record the decision (S80, S82 REJECTED state)", () => {
  test("approve moves READY to APPROVED with who and when, append-only", async () => {
    const e = fixture();
    const out = await e.decide("stageApprove", 1);
    expect(out).toMatchObject({ chainID: e.chain, n: 1, state: "APPROVED", result: e.s1 });
    const shown = (await e.dispatch("stageShow", "rev", { chainID: e.chain, n: 1 })).stage;
    expect(shown.state).toBe("APPROVED");
    expect(shown.history).toHaveLength(1);
    expect(shown.history[0]).toMatchObject({ n: 1, event: "APPROVED", result: e.s1, by: { sessionID: "rev", agent: REVIEWER } });
    expect(Number.isNaN(Date.parse(shown.history[0].at))).toBe(false);
    // stage 2 is untouched and still READY
    expect((await e.dispatch("stageShow", "rev", { chainID: e.chain, n: 2 })).stage.state).toBe("READY");
    // no temp file left behind by the atomic writer
    expect(readdirSync(join(e.stateDir, "chains")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("a decision must name the stage's pinned result commit; a stale or malformed one is refused", async () => {
    const e = fixture();
    await refusedLeavesHost(e, () => e.decide("stageApprove", 1, { result: e.s2 }), /result commit/);
    await refusedLeavesHost(e, () => e.decide("stageApprove", 1, { result: "abc" }), /result/);
    await refusedLeavesHost(e, () => e.decide("stageApprove", 1, { result: undefined }), /result/);
    await refusedLeavesHost(e, () => e.decide("stageApprove", 9, { result: e.s1 }), /no stage 9/);
    await refusedLeavesHost(e, () => e.dispatch("stageApprove", "rev", { chainID: e.chain, n: 1, result: e.s1, extra: 1 }), /unexpected field/);
    expect(await history(e, 1)).toEqual([]);
  });

  test("a BUILDING stage, a repeated approve and an approve after reject are refused", async () => {
    const e = fixture();
    git(e.repo, "update-ref", "-d", `${REF(e.chain)}/stage/2`);
    await expect(e.decide("stageApprove", 2, { result: e.s2 })).rejects.toThrow(/BUILDING/);
    await e.decide("stageApprove", 1);
    await expect(e.decide("stageApprove", 1)).rejects.toThrow(/APPROVED/);
    await e.decide("stageReject", 1);
    await expect(e.decide("stageApprove", 1)).rejects.toThrow(/REJECTED/);
  });

  test("reject records REJECTED with the revision note and never touches the host (S82, record only)", async () => {
    const e = fixture();
    await refusedLeavesHost(e, () => e.decide("stageReject", 1, { note: "" }), /note/);
    await refusedLeavesHost(e, () => e.decide("stageReject", 1, { note: "x".repeat(4001) }), /note/);
    await refusedLeavesHost(e, () => e.decide("stageReject", 1, { note: 5 }), /note/);
    const before = hostFingerprint(e.repo);
    const out = await e.decide("stageReject", 1, { note: "split the helper out" });
    expect(out).toMatchObject({ n: 1, state: "REJECTED" });
    expect(hostFingerprint(e.repo)).toBe(before);
    const shown = (await e.dispatch("stageShow", "rev", { chainID: e.chain, n: 1 })).stage;
    expect(shown.state).toBe("REJECTED");
    expect(shown.history[0]).toMatchObject({ event: "REJECTED", note: "split the helper out", by: { sessionID: "rev", agent: REVIEWER } });
    // a rejected stage can never be approved or applied, and cannot be rejected twice
    await expect(e.decide("stageApprove", 1)).rejects.toThrow(/REJECTED/);
    await refusedLeavesHost(e, () => e.decide("stageApply", 1), /REJECTED/);
    await expect(e.decide("stageReject", 1)).rejects.toThrow(/REJECTED/);
  });

  test("an approved stage can still be rejected before it is applied, but not after", async () => {
    const e = fixture();
    await e.decide("stageApprove", 1);
    await e.decide("stageReject", 1);
    expect((await history(e, 1)).map((h) => h.event)).toEqual(["APPROVED", "REJECTED"]);
    const f = fixture();
    await f.decide("stageApprove", 1);
    await f.decide("stageApply", 1);
    await expect(f.decide("stageReject", 1)).rejects.toThrow(/APPLIED/);
  });
});

describe("apply: owner approval, strict order, pinned ref, fail closed (S80, S81)", () => {
  test("a stage that is not APPROVED is not applied", async () => {
    const e = fixture();
    await refusedLeavesHost(e, () => e.decide("stageApply", 1), /APPROVED/);
    expect(await history(e, 1)).toEqual([]);
  });

  test("apply requires the explicit APPLY confirmation", async () => {
    const e = fixture();
    await e.decide("stageApprove", 1);
    await refusedLeavesHost(e, () => e.decide("stageApply", 1, { confirm: undefined }), /confirm/);
    await refusedLeavesHost(e, () => e.decide("stageApply", 1, { confirm: "yes" }), /confirm/);
  });

  /** Re-pin stage 2 to a non-protected commit (c.txt) built on stage 1, so ordering is tested apart from the S17 rule. */
  function plainStage2(e: Env): string {
    git(e.repo, "checkout", "-q", "-b", "plain2", e.s1);
    writeFileSync(join(e.repo, "c.txt"), "c\n");
    git(e.repo, "add", "-A");
    git(e.repo, "commit", "-q", "-m", "plain stage 2");
    const c = git(e.repo, "rev-parse", "HEAD");
    git(e.repo, "checkout", "-q", "main");
    git(e.repo, "update-ref", `${REF(e.chain)}/stage/2`, c);
    return c;
  }

  test("stages apply strictly in order: stage 2 is refused while stage 1 is not APPLIED, however approved", async () => {
    const e = fixture();
    const c = plainStage2(e);
    await e.decide("stageApprove", 1);
    await e.decide("stageApprove", 2, { result: c });
    await refusedLeavesHost(e, () => e.decide("stageApply", 2, { result: c }), /stage 1/);
    // a rejected earlier stage blocks it too
    const f = fixture();
    const fc = plainStage2(f);
    await f.decide("stageApprove", 2, { result: fc });
    await f.decide("stageReject", 1);
    await refusedLeavesHost(f, () => f.decide("stageApply", 2, { result: fc }), /stage 1/);
    expect(existsSync(join(e.repo, "c.txt"))).toBe(false); // positive control: stage 2's file is observable once applied
    await e.decide("stageApply", 1);
    await e.decide("stageApply", 2, { result: c });
    expect(readFileSync(join(e.repo, "c.txt"), "utf8")).toBe("c\n");
  });

  test("apply takes the pinned stage ref, never the session result ref that moved ahead", async () => {
    const e = fixture();
    expect(git(e.repo, "rev-parse", "refs/opencode-sandbox/result/w1")).toBe(e.s2); // the moved ref is observable
    await e.decide("stageApprove", 1);
    const out = await e.decide("stageApply", 1);
    expect(out).toMatchObject({ n: 1, state: "APPLIED", applied: true, result: e.s1 });
    expect(out.applyPreview.files).toBe(1);
    expect(readFileSync(join(e.repo, "b.txt"), "utf8")).toBe("b\n");
    expect(existsSync(join(e.repo, "broker"))).toBe(false); // stage 2's content was not smuggled in
    // only what the stage diff contains changed: the working tree differs from base by b.txt alone
    expect(git(e.repo, "status", "--porcelain=v1", "--untracked-files=all")).toBe("?? b.txt");
    expect(git(e.repo, "rev-parse", "HEAD")).toBe(e.base); // no commit, no branch move
    const h = await history(e, 1);
    expect(h.map((x) => x.event)).toEqual(["APPROVED", "APPLYING", "APPLIED"]);
    expect(h[2]).toMatchObject({ by: { sessionID: "rev", agent: REVIEWER }, result: e.s1 });
  });

  test("B1: a stage ref rewritten after approval is refused even when the payload names the new commit", async () => {
    const e = fixture();
    await e.decide("stageApprove", 1);
    git(e.repo, "checkout", "-q", "-b", "evil", e.base);
    writeFileSync(join(e.repo, "evil.txt"), "evil\n");
    git(e.repo, "add", "-A");
    git(e.repo, "commit", "-q", "-m", "evil");
    const evil = git(e.repo, "rev-parse", "HEAD");
    git(e.repo, "checkout", "-q", "main");
    git(e.repo, "update-ref", `${REF(e.chain)}/stage/1`, evil);
    const before = hostFingerprint(e.repo);
    await refusedLeavesHost(e, () => e.decide("stageApply", 1, { result: evil }), /moved since approval/);
    expect(existsSync(join(e.repo, "evil.txt"))).toBe(false);
    expect(hostFingerprint(e.repo)).toBe(before);
    expect((await history(e, 1)).map((x) => x.event)).toEqual(["APPROVED", "APPLYING", "APPLY_REFUSED"]);
    // the old approved commit is no longer the pinned one either
    await expect(e.decide("stageApply", 1)).rejects.toThrow(/pinned result commit/);
    // positive control: the fingerprint does see the evil content when it is written
    writeFileSync(join(e.repo, "evil.txt"), "evil\n");
    expect(hostFingerprint(e.repo)).not.toBe(before);
  });

  test("B1: a decisions file whose APPROVED event names another result than the stage ref is not applied", async () => {
    const e = fixture();
    await e.decide("stageApprove", 1);
    const file = join(e.stateDir, "chains", `${e.chain}.decisions.json`);
    const rec = JSON.parse(readFileSync(file, "utf8"));
    rec.events[0].result = e.base;
    writeFileSync(file, JSON.stringify(rec));
    await refusedLeavesHost(e, () => e.decide("stageApply", 1), /moved since approval/);
    expect(existsSync(join(e.repo, "b.txt"))).toBe(false);
  });

  test("B1: matching approval, payload and stage ref still applies", async () => {
    const e = fixture();
    await e.decide("stageApprove", 1);
    expect((await e.decide("stageApply", 1)).state).toBe("APPLIED");
    expect(readFileSync(join(e.repo, "b.txt"), "utf8")).toBe("b\n");
  });

  test("a second apply is refused and leaves the host unchanged", async () => {
    const e = fixture();
    await e.decide("stageApprove", 1);
    await e.decide("stageApply", 1);
    await refusedLeavesHost(e, () => e.decide("stageApply", 1), /APPLIED/);
    // two concurrent applies: exactly one lands
    const f = fixture();
    await f.decide("stageApprove", 1);
    const outcomes = await Promise.allSettled([f.decide("stageApply", 1), f.decide("stageApply", 1)]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect((await history(f, 1)).filter((x) => x.event === "APPLIED")).toHaveLength(1);
  });

  test("host divergence from the stage baseline is refused, recorded, and the host is not modified", async () => {
    const e = fixture();
    await e.decide("stageApprove", 1);
    writeFileSync(join(e.repo, "a.txt"), "edited by the owner\n");
    await refusedLeavesHost(e, () => e.decide("stageApply", 1), /diverged/);
    expect(existsSync(join(e.repo, "b.txt"))).toBe(false);
    expect((await history(e, 1)).map((x) => x.event)).toEqual(["APPROVED", "APPLYING", "APPLY_REFUSED"]);
    expect((await e.dispatch("stageShow", "rev", { chainID: e.chain, n: 1 })).stage.state).toBe("APPROVED");
    // reverting the divergence lets the same approval apply (nothing was consumed)
    writeFileSync(join(e.repo, "a.txt"), "a\n");
    expect((await e.decide("stageApply", 1)).state).toBe("APPLIED");
  });

  test("a symlink in the stage diff is refused (existing apply rule)", async () => {
    const e = fixture();
    git(e.repo, "checkout", "-q", "-b", "link", e.base);
    symlinkSync("/etc/passwd", join(e.repo, "link"));
    git(e.repo, "add", "-A");
    git(e.repo, "commit", "-q", "-m", "link");
    const link = git(e.repo, "rev-parse", "HEAD");
    git(e.repo, "checkout", "-q", "main");
    git(e.repo, "update-ref", "-d", `${REF(e.chain)}/stage/2`);
    git(e.repo, "update-ref", "-d", `${REF(e.chain)}/stage/1`);
    git(e.repo, "update-ref", `${REF(e.chain)}/stage/1`, link);
    await e.decide("stageApprove", 1, { result: link });
    await refusedLeavesHost(e, () => e.decide("stageApply", 1, { result: link }), /symlink/);
    expect(existsSync(join(e.repo, "link"))).toBe(false);
  });
});

describe("protected (S17) stages: approvable per stage, never applied through the broker", () => {
  async function toStage2(e: Env): Promise<void> {
    await e.decide("stageApprove", 1);
    await e.decide("stageApply", 1);
  }

  test("approval needs the per-stage confirmProtected, and records it", async () => {
    const e = fixture();
    await toStage2(e);
    expect((await e.dispatch("stageShow", "rev", { chainID: e.chain, n: 2 })).stage.touchesProtected).toBe(true);
    await refusedLeavesHost(e, () => e.decide("stageApprove", 2), /confirmProtected/);
    await refusedLeavesHost(e, () => e.decide("stageApprove", 2, { confirmProtected: "yes" }), /confirmProtected/);
    await e.decide("stageApprove", 2, { confirmProtected: true });
    expect((await history(e, 2))[0]).toMatchObject({ event: "APPROVED", protectedConfirmed: true, result: e.s2 });
  });

  test("apply refuses an approved and confirmed S17 stage, records the refusal, and leaves the host unchanged", async () => {
    const e = fixture();
    await toStage2(e);
    await e.decide("stageApprove", 2, { confirmProtected: true });
    await refusedLeavesHost(e, () => e.decide("stageApply", 2), /protected/);
    // the apply payload has no confirmation field to smuggle one in
    await refusedLeavesHost(e, () => e.decide("stageApply", 2, { confirmProtected: true }), /unexpected field/);
    expect(existsSync(join(e.repo, "broker"))).toBe(false);
    expect((await history(e, 2)).map((x) => x.event)).toEqual(["APPROVED", "APPLYING", "APPLY_REFUSED"]);
    expect((await e.dispatch("stageShow", "rev", { chainID: e.chain, n: 2 })).stage.state).toBe("APPROVED");
  });

  test("a non-protected stage does not need, and does not record, the confirmation", async () => {
    const e = fixture();
    await e.decide("stageApprove", 1);
    expect((await history(e, 1))[0].protectedConfirmed).toBeUndefined();
  });
});

describe("existing behaviour is unchanged", () => {
  test("stageList and stageShow of an undecided stage report exactly what P2a reported", async () => {
    const e = fixture();
    const listed = await e.dispatch("stageList", "rev", { chainID: e.chain });
    expect(listed.stages).toEqual([
      { n: 1, sessionID: "w1", state: "READY", baseline: e.base, result: e.s1, changedPaths: ["b.txt"], touchesProtected: false },
      { n: 2, sessionID: "w2", state: "READY", baseline: e.s1, result: e.s2, changedPaths: ["broker/src/x.ts"], touchesProtected: true },
    ]);
    // list/show stay reader-only; orchestrators are still refused them
    await expect(e.dispatch("stageList", "orch", { chainID: e.chain })).rejects.toBeInstanceOf(PolicyError);
    // a comparable existing host mutation keeps its policy
    expect(authorizeHostDispatch(e.ctx, "gitCommit", "orch")).toBe("mutation");
    expect(() => authorizeHostDispatch(e.ctx, "gitCommit", "rev")).toThrow(PolicyError);
  });
});

describe("tools and permission fragments", () => {
  const ROOT = join(import.meta.dir, "../..");
  const specs = readFileSync(join(ROOT, "opencode/plugins/lib/tool-specs-host-ops.ts"), "utf8");
  const block = (tool: string) => specs.split(new RegExp(`\\n {2}${tool}: defineTool\\(\\{`))[1]?.split(/\n {2}host_[a-z_]+: defineTool/)[0] ?? "";
  const rule = (file: string, tool: string) => new RegExp(`^\\s*"${tool}":\\s*"(\\w+)"`, "m").exec(readFileSync(join(ROOT, file), "utf8"))?.[1];

  test("each decision tool asks the owner in code and calls only its own broker operation", () => {
    const calls = { host_stage_approve: "stageApprove", host_stage_reject: "stageReject", host_stage_apply: "stageApply" } as const;
    for (const tool of TOOLS) {
      const body = block(tool);
      expect(body, tool).toContain("ctx.ask(");
      expect(body).toContain(`"${calls[tool]}"`);
    }
    expect(block("host_stage_list")).not.toContain("ctx.ask("); // positive control: the scan tells ask from no-ask
  });

  test("both permission fragments deny the decision tools globally; the stage-review agent block enables them as ask", () => {
    for (const file of ["opencode/config-fragments/sandbox-permissions.jsonc", "opencode/plugins-v2/config-fragments/sandbox-permissions.jsonc"]) {
      for (const tool of TOOLS) expect([file, tool, rule(file, tool)]).toEqual([file, tool, "deny"]);
      expect(rule(file, "host_stage_list")).toBe("deny"); // positive control: the reader regex finds rules
    }
  });
});
