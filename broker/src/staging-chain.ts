/**
 * Staging chains, phase P1 (docs/staging/plan.md): ordered, unapplied sandbox
 * results. NOT installed: S17 security component (broker/src/**); the OWNER
 * reviews the diff and installs it by hand. Nothing here applies to the host.
 *
 * State, with no read-modify-write file to race:
 *  - chain record: immutable JSON (project, lane, limit) under <stateDir>/chains,
 *    written once.
 *  - stage membership: `SessionRecord.chain = { id, n, baseline }`, written by
 *    the existing atomic SessionStore. The BROKER derives `baseline` (stage 1:
 *    the worktree snapshot it took; stage n: stage n-1's result commit) and
 *    verifies it against the session's pinned baseline, so a worker can never
 *    claim an arbitrary baseline.
 *  - results: refs refs/opencode-sandbox/chain/<id>/{base,stage/<n>}, created
 *    create-only (`update-ref <ref> <new> <zero-oid>`) and never moved, so a
 *    registered stage is immutable.
 * A stage is BUILDING until its ref exists, then READY.
 *
 * P2 (read half) exposes them as broker operations: chainCreate / chainAttach
 * (orchestrator mutations), chainStatus (host read) and stageList / stageShow
 * (stage-review role only; they read the stage refs, never a session result
 * ref, which can move ahead of the pinned stage).
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildChangedPathsArgv, buildCheckArgv, checkProtectedPaths, parseNulDelimitedPaths, patchPathFor, resultRef } from "./gitops.ts";
import { PolicyError } from "./policy.ts";
import {
  authorizeHostDispatch,
  buildApplyPreview,
  ensureCompleteApplyPreview,
  hostDivergence,
  planRootPatterns,
  projectDirFor,
  rawChangesBetween,
  resolveCanonicalProjectRoot,
  writeFileAtomic,
  type OpContext,
  type OpHandler,
} from "./service.ts";
import { StateError } from "./state.ts";
import type { SessionRecord } from "./types.ts";
import { ValidationError, assertPayloadKeys, assertRefComponent, assertSessionID } from "./validation.ts";

/** Lane -> default maximum stages (plan: feature 5, fix 2). */
export const CHAIN_LANES = { feature: 5, fix: 2 } as const;
export type ChainLane = keyof typeof CHAIN_LANES;

export interface ChainRecord {
  id: string;
  projectID: string;
  lane: ChainLane;
  maxStages: number;
  createdAt: string;
}

/** Who decided, when, on which result commit. Recorded append-only per chain (see decisions below). */
export interface StageEvent {
  n: number;
  event: "APPROVED" | "REJECTED" | "APPLYING" | "APPLIED" | "APPLY_REFUSED";
  result: string;
  at: string;
  by: { sessionID: string; agent: string };
  note?: string;
  reason?: string;
  protectedConfirmed?: true;
}

export interface StageStatus {
  n: number;
  sessionID: string;
  state: "BUILDING" | "READY" | "APPROVED" | "REJECTED" | "APPLYING" | "APPLIED";
  baseline: string;
  result?: string;
  changedPaths?: string[];
  touchesProtected?: boolean;
  history?: StageEvent[];
}

export interface ChainStatus {
  chain: ChainRecord;
  stages: StageStatus[];
  /** What to pass as `snapshot` to ensureWorker for the next stage; null while the tip is building, the chain is full, or the tip's result ref no longer matches its pinned stage. */
  nextSnapshot: { worktree: true } | { resultRef: string } | null;
}

const CHAIN_ID_RE = /^c[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const ZERO_OID = "0".repeat(40);
const REF_ROOT = "refs/opencode-sandbox/chain";

function assertChainID(id: unknown): string {
  if (typeof id !== "string" || !CHAIN_ID_RE.test(id)) throw new ValidationError("invalid chain id");
  assertRefComponent(id);
  return id;
}

function chainPath(ctx: OpContext, id: string): string {
  return join(ctx.config.stateDir, "chains", `${assertChainID(id)}.json`);
}

function loadChain(ctx: OpContext, id: string): ChainRecord {
  const path = chainPath(ctx, id);
  if (!existsSync(path)) throw new StateError(`unknown chain ${id}`);
  let c: Partial<ChainRecord>;
  try {
    c = JSON.parse(readFileSync(path, "utf8")) as Partial<ChainRecord>;
  } catch (err) {
    throw new StateError(`corrupt chain record ${id}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (c.id !== id || typeof c.projectID !== "string" || typeof c.maxStages !== "number" || typeof c.createdAt !== "string" || !Object.hasOwn(CHAIN_LANES, String(c.lane))) {
    throw new StateError(`corrupt chain record ${id}: shape validation failed`);
  }
  return c as ChainRecord;
}

/** The chain's project repository, as a git argv runner (GIT_DIR pinned like the other snapshot code). */
function gitFor(ctx: OpContext, chain: ChainRecord) {
  const repoDir = projectDirFor(ctx, chain.projectID);
  return (argv: string[]) => ctx.git.spawn(argv, { env: { GIT_DIR: join(repoDir, ".git") }, cwd: repoDir, timeoutMs: 60_000 });
}
type Git = ReturnType<typeof gitFor>;

async function commitOf(git: Git, rev: string): Promise<string | undefined> {
  const r = await git(["git", "rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  return r.status === 0 && SHA_RE.test(r.stdout.trim()) ? r.stdout.trim() : undefined;
}

/** Create-only pin; an existing ref must already point at `sha` (idempotent), never moves. */
async function pin(git: Git, ref: string, sha: string): Promise<void> {
  const current = await commitOf(git, ref);
  if (current === sha) return;
  if (current) throw new StateError(`${ref} is already pinned to a different commit`);
  const r = await git(["git", "update-ref", ref, sha, ZERO_OID]);
  if (r.status !== 0) throw new StateError(`cannot pin ${ref}: ${r.stderr.trim().slice(0, 500)}`);
}

/** READY stages: n -> result commit, from the stage refs. */
async function readyStages(git: Git, id: string): Promise<Map<number, string>> {
  const r = await git(["git", "for-each-ref", "--format=%(refname) %(objectname)", `${REF_ROOT}/${id}/stage/`]);
  if (r.status !== 0) throw new StateError(`cannot list chain stages: ${r.stderr.trim().slice(0, 500)}`);
  const ready = new Map<number, string>();
  for (const line of r.stdout.split("\n").filter(Boolean)) {
    const [ref, sha] = line.split(" ") as [string, string];
    ready.set(Number(ref.slice(ref.lastIndexOf("/") + 1)), sha);
  }
  return ready;
}

/** Sessions holding a stage of this chain, in stage order. A FAILED_CLOSED session that never registered frees its slot. */
function claims(ctx: OpContext, id: string, ready: ReadonlyMap<number, string>): SessionRecord[] {
  return ctx.store
    .list()
    .filter((s) => s.chain?.id === id && (ready.has(s.chain.n) || s.state !== "FAILED_CLOSED"))
    .sort((a, b) => a.chain!.n - b.chain!.n);
}

export function chainCreate(ctx: OpContext, input: { projectID: string; lane: string }): ChainRecord {
  projectDirFor(ctx, input.projectID); // allowlist check
  if (!Object.hasOwn(CHAIN_LANES, input.lane)) throw new ValidationError("lane must be feature or fix");
  const lane = input.lane as ChainLane;
  const chain: ChainRecord = {
    id: `c${randomBytes(6).toString("hex")}`,
    projectID: input.projectID,
    lane,
    maxStages: CHAIN_LANES[lane],
    createdAt: new Date().toISOString(),
  };
  const dir = join(ctx.config.stateDir, "chains");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileAtomic(chainPath(ctx, chain.id), JSON.stringify(chain, null, 2)); // written once
  return chain;
}

// ---------------------------------------------------------------------------
// Owner decisions. Stage refs stay immutable; a decision is an event appended to
// <stateDir>/chains/<id>.decisions.json (temp + rename, rewritten whole). The
// read-check-write below never awaits, so two decisions cannot interleave.
// A stage's state is its last event: APPLY_REFUSED returns it to APPROVED.
// ---------------------------------------------------------------------------

const EVENT_NAMES: readonly StageEvent["event"][] = ["APPROVED", "REJECTED", "APPLYING", "APPLIED", "APPLY_REFUSED"];

function decisionsPath(ctx: OpContext, id: string): string {
  return join(ctx.config.stateDir, "chains", `${assertChainID(id)}.decisions.json`);
}

function loadEvents(ctx: OpContext, id: string): StageEvent[] {
  const path = decisionsPath(ctx, id);
  if (!existsSync(path)) return [];
  let parsed: { events?: unknown };
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as { events?: unknown };
  } catch (err) {
    throw new StateError(`corrupt decision record ${id}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const valid = (e: Partial<StageEvent>): boolean =>
    Number.isInteger(e.n) && (e.n as number) >= 1 && EVENT_NAMES.includes(e.event as StageEvent["event"]) && typeof e.result === "string" && SHA_RE.test(e.result) &&
    typeof e.at === "string" && typeof e.by?.sessionID === "string" && typeof e.by.agent === "string";
  if (!Array.isArray(parsed.events) || !parsed.events.every((e) => typeof e === "object" && e !== null && valid(e))) {
    throw new StateError(`corrupt decision record ${id}: shape validation failed`);
  }
  return parsed.events as StageEvent[];
}

function decidedState(events: readonly StageEvent[], n: number): Exclude<StageStatus["state"], "BUILDING" | "READY"> | undefined {
  let state: Exclude<StageStatus["state"], "BUILDING" | "READY"> | undefined;
  for (const e of events) if (e.n === n) state = e.event === "APPLY_REFUSED" ? "APPROVED" : e.event;
  return state;
}

/** Append one event after `guard` accepted the current events. Synchronous on purpose (no interleaving). */
function recordEvent(ctx: OpContext, id: string, event: Omit<StageEvent, "at">, guard?: (events: readonly StageEvent[]) => void): void {
  const events = loadEvents(ctx, id);
  guard?.(events);
  mkdirSync(join(ctx.config.stateDir, "chains"), { recursive: true, mode: 0o700 });
  writeFileAtomic(decisionsPath(ctx, id), JSON.stringify({ events: [...events, { ...event, at: new Date().toISOString() }] }, null, 2));
}

/** The chain's stages, from the stage refs (READY) and the sessions holding a stage (BUILDING). */
async function chainStages(ctx: OpContext, id: string): Promise<{ chain: ChainRecord; git: Git; stages: StageStatus[] }> {
  const chain = loadChain(ctx, id);
  const git = gitFor(ctx, chain);
  const ready = await readyStages(git, id);
  const protectedPatterns = [...ctx.config.protectedPaths, ...ctx.config.protectedSecurityFiles];
  const events = loadEvents(ctx, id);
  const stages: StageStatus[] = [];
  for (const s of claims(ctx, id, ready)) {
    const { n, baseline } = s.chain!;
    const result = ready.get(n);
    const stage: StageStatus = { n, sessionID: s.sessionID, state: result ? (decidedState(events, n) ?? "READY") : "BUILDING", baseline };
    const own = events.filter((e) => e.n === n);
    if (own.length > 0) stage.history = own;
    if (result) {
      const diff = await git(buildChangedPathsArgv(baseline, result));
      const parsed = parseNulDelimitedPaths(diff.stdout);
      if (diff.status !== 0 || !parsed.complete) throw new StateError(`cannot list changed paths of stage ${n}`);
      Object.assign(stage, { result, changedPaths: parsed.paths, touchesProtected: checkProtectedPaths(parsed.paths, protectedPatterns).length > 0 });
    }
    stages.push(stage);
  }
  return { chain, git, stages };
}

export async function chainStatus(ctx: OpContext, id: string): Promise<ChainStatus> {
  const { chain, git, stages } = await chainStages(ctx, id);
  const tip = stages.at(-1);
  if (!tip) return { chain, stages, nextSnapshot: { worktree: true } };
  // Offer the session's result ref only while it still IS the pinned stage commit (a refused re-finish or a discard moves/deletes it).
  const offered = tip.state === "READY" && tip.n < chain.maxStages ? resultRef(tip.sessionID) : undefined;
  const stillPinned = offered !== undefined && (await commitOf(git, offered)) === tip.result;
  return { chain, stages, nextSnapshot: stillPinned ? { resultRef: offered! } : null };
}

/**
 * Bind an already-started worker session to the next stage of a chain. The
 * session must have been started with `chainStatus(...).nextSnapshot`; the
 * broker checks that its pinned baseline IS the derived one and refuses
 * otherwise (fail closed, no fallback).
 */
export async function chainAttach(ctx: OpContext, id: string, sessionID: string): Promise<void> {
  assertSessionID(sessionID);
  if (ctx.git.runnerMode !== "real") throw new StateError("chain staging requires the real git runner");
  const chain = loadChain(ctx, id);
  const session = ctx.store.get(sessionID);
  if (!session || session.state !== "SANDBOX_ACTIVE") throw new StateError(`no active session ${sessionID}`);
  if (session.chain) throw new StateError(`session ${sessionID} is already in a chain`);
  if (session.projectID !== chain.projectID || !session.baselineRef) throw new StateError("session does not belong to the chain's project");
  const git = gitFor(ctx, chain);
  const baseline = await commitOf(git, session.baselineRef);
  if (!baseline) throw new StateError("session baseline cannot be resolved");
  const ready = await readyStages(git, id);

  // Everything below is synchronous (no await) so two attaches cannot interleave.
  const held = claims(ctx, id, ready);
  const tip = held.at(-1);
  const n = (tip?.chain!.n ?? 0) + 1;
  if (n > chain.maxStages) throw new StateError(`chain ${id} reached its stage limit (${chain.maxStages})`);
  if (!tip) {
    const source = (session as { snapshotIdentity?: { source?: string } }).snapshotIdentity?.source;
    if (source !== "worktree") throw new StateError("stage 1 must start from the host worktree snapshot");
  } else {
    const previous = ready.get(tip.chain!.n);
    if (!previous) throw new StateError(`stage ${tip.chain!.n} is not ready`);
    if (baseline !== previous) throw new StateError(`session baseline is not stage ${tip.chain!.n}'s result`);
  }
  ctx.store.touch(sessionID, { chain: { id, n, baseline } }, "chainAttach");
}

/**
 * Called when a worker's result has been imported (end of runPrepare). A
 * session outside any chain is a no-op. Otherwise pins the stage ref; the
 * result must descend from the derived baseline, and a stage never moves.
 */
export async function registerChainStage(ctx: OpContext, record: SessionRecord, ref: string): Promise<void> {
  const member = record.chain;
  if (!member) return;
  const git = gitFor(ctx, loadChain(ctx, member.id));
  const result = await commitOf(git, ref);
  if (!result) throw new StateError("result ref does not resolve to a commit");
  const based = await git(["git", "merge-base", "--is-ancestor", member.baseline, result]);
  if (based.status !== 0) throw new StateError("result is not based on the stage baseline");
  if (member.n === 1) await pin(git, `${REF_ROOT}/${member.id}/base`, member.baseline);
  await pin(git, `${REF_ROOT}/${member.id}/stage/${member.n}`, result);
}

/** Stage-review reads: every field comes from the pinned stage refs. */
export async function stageList(ctx: OpContext, id: string): Promise<{ chain: ChainRecord; stages: StageStatus[] }> {
  const { chain, stages } = await chainStages(ctx, id);
  return { chain, stages };
}

export async function stageShow(ctx: OpContext, id: string, n: unknown): Promise<{ chain: ChainRecord; stage: StageStatus }> {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) throw new ValidationError("n must be a positive integer");
  const { chain, stages } = await chainStages(ctx, id);
  const stage = stages.find((s) => s.n === n);
  if (!stage) throw new StateError(`chain ${id} has no stage ${n}`);
  return { chain, stage };
}

// ---------------------------------------------------------------------------
// The owner's decisions: approve, reject, apply (stage-review role only).
// Nothing here approves because an agent asked: the broker records what the
// stage-review identity decided, and apply additionally needs the owner's
// APPLY confirmation. Only apply touches the host.
// ---------------------------------------------------------------------------

type Decider = { sessionID: string; agent: string };
const NOTE_MAX = 4000;

/** Resolve the stage a decision names and bind the decision to its pinned result commit. */
async function decisionTarget(ctx: OpContext, by: Decider, p: Record<string, unknown>) {
  const id = String(p.chainID);
  const n = p.n;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) throw new ValidationError("n must be a positive integer");
  if (typeof p.result !== "string" || !SHA_RE.test(p.result)) throw new ValidationError("result must be the stage's 40-hex result commit");
  // A session that owns a stage of the chain can never decide on it, whatever name it is bound to.
  if (ctx.store.get(by.sessionID)?.chain?.id === id) throw new PolicyError("a worker session of the chain cannot decide on its stages (STAGE_DECISION_NOT_WORKER)");
  const { chain, stages } = await chainStages(ctx, id);
  const stage = stages.find((s) => s.n === n);
  if (!stage) throw new StateError(`chain ${id} has no stage ${n}`);
  if (!stage.result) throw new StateError(`stage ${n} is BUILDING; it has no result to decide on`);
  if (stage.result !== p.result) throw new StateError(`stage ${n}: the decision names a result commit that is not the stage's pinned result commit`);
  return { id, n, result: p.result, chain, stage };
}

/** S17 stages need `confirmProtected: true` to be approved, per stage; there is no batch form. They are never applied through this path. */
function protectedConfirmed(p: Record<string, unknown>, stage: StageStatus): boolean {
  if (p.confirmProtected !== undefined && p.confirmProtected !== true) throw new ValidationError("confirmProtected must be true when present");
  if (stage.touchesProtected && p.confirmProtected !== true) {
    throw new StateError(`stage ${stage.n} touches protected (S17) paths: confirmProtected: true is required for this stage (never batched)`);
  }
  return stage.touchesProtected === true;
}

export async function stageApprove(ctx: OpContext, by: Decider, p: Record<string, unknown>) {
  const { id, n, result, stage } = await decisionTarget(ctx, by, p);
  const confirmed = protectedConfirmed(p, stage);
  recordEvent(ctx, id, { n, event: "APPROVED", result, by, ...(confirmed ? { protectedConfirmed: true as const } : {}) }, (events) => {
    const state = decidedState(events, n);
    if (state) throw new StateError(`stage ${n} is already ${state}; only a READY stage can be approved`);
  });
  return { chainID: id, n, state: "APPROVED", result };
}

/** Records REJECTED with the revision note. Replay and rebuild are the next unit (reduced P4). */
export async function stageReject(ctx: OpContext, by: Decider, p: Record<string, unknown>) {
  if (typeof p.note !== "string" || p.note.trim().length === 0 || p.note.length > NOTE_MAX) {
    throw new ValidationError(`note must be a non-empty revision note of at most ${NOTE_MAX} characters`);
  }
  const { id, n, result } = await decisionTarget(ctx, by, p);
  recordEvent(ctx, id, { n, event: "REJECTED", result, by, note: p.note }, (events) => {
    const state = decidedState(events, n);
    if (state && state !== "APPROVED") throw new StateError(`stage ${n} is ${state}; only a READY or APPROVED stage can be rejected`);
  });
  return { chainID: id, n, state: "REJECTED", result };
}

/**
 * Apply one APPROVED stage, in order, from the PINNED stage commits (never the
 * session result ref), through the same checks as applyResult (S17 paths are
 * refused outright, as there): baseline
 * divergence (S16), plan-root paths, symlink/submodule changes, a complete
 * preview, `git apply --check`, then `git apply` (working tree only, atomic).
 * Every refusal before `git apply` is recorded as APPLY_REFUSED and the host is
 * unchanged; an interruption after APPLYING leaves the stage APPLYING, which
 * blocks any further apply until the owner reconciles it (fail closed).
 */
export async function stageApply(ctx: OpContext, by: Decider, p: Record<string, unknown>) {
  if (p.confirm !== "APPLY") throw new ValidationError('stageApply requires confirm: "APPLY"');
  if (ctx.git.runnerMode !== "real") throw new StateError("stage apply requires the real git runner");
  const { id, n, result, chain, stage } = await decisionTarget(ctx, by, p);
  recordEvent(ctx, id, { n, event: "APPLYING", result, by }, (events) => {
    const state = decidedState(events, n);
    if (state !== "APPROVED") throw new StateError(`stage ${n} is ${state ?? "READY"}, not APPROVED; only an APPROVED stage is applied`);
    for (let k = 1; k < n; k++) {
      if (decidedState(events, k) !== "APPLIED") throw new StateError(`stage ${k} is not APPLIED; stages apply strictly in order`);
    }
  });

  const key = `stage-${id}-${n}`; // scratch names for the divergence index, patch and preview
  const patchFile = patchPathFor(ctx.config.stateDir, key);
  const projectDir = projectDirFor(ctx, chain.projectID);
  let landing = false; // true once `git apply` may have run: from then on a failure is NOT recorded as a clean refusal
  try {
    // S17 / AGENTS.md: protected paths are never applied from an agent session, whatever was confirmed at approval (applyResult's rule).
    if (stage.touchesProtected) throw new StateError(`stage ${n} touches protected paths (S7/S17); the owner applies it by hand`);
    const diverged = await hostDivergence(ctx, key, chain.projectID, stage.baseline);
    if (diverged.length > 0) throw new StateError(`host project diverged from stage ${n}'s baseline (S16); nothing applied (${diverged.slice(0, 10).join(", ")})`);
    const planRoot = checkProtectedPaths(stage.changedPaths ?? [], planRootPatterns(ctx.config));
    if (planRoot.length > 0) throw new StateError(`stage ${n} touches plan-root paths (BROKER_PLAN_ROOT_PROTECTION): ${planRoot.join(", ")}`);
    const unsafe = (await rawChangesBetween(ctx, chain.projectID, stage.baseline, result))
      .filter((c) => c.kind === "symlink" || c.kind === "submodule")
      .map((c) => `${c.kind}:${c.path}`);
    if (unsafe.length > 0) throw new StateError(`stage ${n} contains unsafe symlink/submodule changes: ${unsafe.join(", ")}`);
    const patch = await ctx.git.spawn(["git", "diff", stage.baseline, result, "--", "."], { cwd: projectDir, timeoutMs: 60_000 });
    if (patch.status !== 0 || patch.outputTruncated === true) throw new StateError(`diff generation failed for stage ${n}`);
    mkdirSync(join(ctx.config.stateDir, "patches"), { recursive: true, mode: 0o700 });
    writeFileAtomic(patchFile, patch.stdout);
    const applyPreviewFiles = ensureCompleteApplyPreview(ctx.config.stateDir, key, patch.stdout);
    const check = await ctx.git.spawn(buildCheckArgv(patchFile), { cwd: projectDir, timeoutMs: 60_000 });
    if (check.status !== 0) throw new StateError(`git apply --check failed for stage ${n}: ${check.stderr.trim().slice(0, 500)}`);
    landing = true;
    const applied = await ctx.git.spawn(["git", "apply", patchFile], { cwd: projectDir, timeoutMs: 120_000 });
    if (applied.status !== 0) {
      landing = false; // git apply is all-or-nothing: a non-zero exit left the host unchanged
      throw new StateError(`git apply failed for stage ${n}: ${applied.stderr.trim().slice(0, 500)}; host unchanged`);
    }
    recordEvent(ctx, id, { n, event: "APPLIED", result, by });
    return { chainID: id, n, state: "APPLIED", applied: true, result, touchesProtected: stage.touchesProtected === true, applyPreview: buildApplyPreview(patch.stdout), applyPreviewFiles };
  } catch (err) {
    if (!landing) recordEvent(ctx, id, { n, event: "APPLY_REFUSED", result, by, reason: (err instanceof Error ? err.message : String(err)).slice(0, 500) });
    throw err;
  } finally {
    rmSync(patchFile, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Broker operations. Authorization first (deny by default), then the payload allowlist.
// ---------------------------------------------------------------------------

function payloadFor(operation: string, payload: unknown): Record<string, unknown> {
  assertPayloadKeys(operation, payload);
  return (payload ?? {}) as Record<string, unknown>;
}

export function buildChainCreateOp(ctx: OpContext): OpHandler {
  return async (req) => {
    authorizeHostDispatch(ctx, "chainCreate", req.sessionID, req.agent);
    const p = payloadFor("chainCreate", req.payload);
    const { projectID } = resolveCanonicalProjectRoot(ctx, p.projectDir);
    return chainCreate(ctx, { projectID, lane: String(p.lane) });
  };
}

export function buildChainStatusOp(ctx: OpContext): OpHandler {
  return async (req) => {
    authorizeHostDispatch(ctx, "chainStatus", req.sessionID, req.agent);
    return chainStatus(ctx, String(payloadFor("chainStatus", req.payload).chainID));
  };
}

export function buildChainAttachOp(ctx: OpContext): OpHandler {
  return async (req) => {
    authorizeHostDispatch(ctx, "chainAttach", req.sessionID, req.agent);
    const p = payloadFor("chainAttach", req.payload);
    await chainAttach(ctx, String(p.chainID), p.sessionID as string);
    return { chainID: p.chainID, sessionID: p.sessionID, n: ctx.store.get(p.sessionID as string)?.chain?.n };
  };
}

export function buildStageListOp(ctx: OpContext): OpHandler {
  return async (req) => {
    authorizeHostDispatch(ctx, "stageList", req.sessionID, req.agent);
    return stageList(ctx, String(payloadFor("stageList", req.payload).chainID));
  };
}

export function buildStageShowOp(ctx: OpContext): OpHandler {
  return async (req) => {
    authorizeHostDispatch(ctx, "stageShow", req.sessionID, req.agent);
    const p = payloadFor("stageShow", req.payload);
    return stageShow(ctx, String(p.chainID), p.n);
  };
}

function buildDecisionOp(ctx: OpContext, operation: "stageApprove" | "stageReject" | "stageApply", run: typeof stageApprove): OpHandler {
  return async (req) => {
    authorizeHostDispatch(ctx, operation, req.sessionID, req.agent);
    const p = payloadFor(operation, req.payload);
    // The identity is the broker-bound one (authorizeHostDispatch proved it is a stage-review agent), never the envelope claim.
    return run(ctx, { sessionID: req.sessionID, agent: ctx.store.get(req.sessionID)!.agent as string }, p);
  };
}

export const buildStageApproveOp = (ctx: OpContext): OpHandler => buildDecisionOp(ctx, "stageApprove", stageApprove);
export const buildStageRejectOp = (ctx: OpContext): OpHandler => buildDecisionOp(ctx, "stageReject", stageReject);
export const buildStageApplyOp = (ctx: OpContext): OpHandler => buildDecisionOp(ctx, "stageApply", stageApply);
