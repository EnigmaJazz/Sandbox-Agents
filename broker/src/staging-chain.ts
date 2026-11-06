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
 * Reduced P4 (docs/staging/plan.md, 2026-11-06): a stage can have several
 * ATTEMPTS. Attempt 1 keeps `stage/<n>`; attempt a > 1 is `stage/<n>.<a>` (new
 * name, create-only, so no pinned ref is ever moved). Only the newest attempt
 * of a stage number is the stage; older attempts survive as refs and history.
 *
 * P2 (read half) exposes them as broker operations: chainCreate / chainAttach
 * (orchestrator mutations), chainStatus (host read) and stageList / stageShow
 * (stage-review role only; they read the stage refs, never a session result
 * ref, which can move ahead of the pinned stage).
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
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
  event: "APPROVED" | "REJECTED" | "STALE" | "APPLYING" | "APPLIED" | "APPLY_REFUSED";
  /** Which attempt of stage `n` the event is about; absent means attempt 1. */
  attempt?: number;
  /** All zeros for a stage that never produced a result (BUILDING when released or made STALE). */
  result: string;
  at: string;
  by: { sessionID: string; agent: string };
  note?: string;
  reason?: string;
  protectedConfirmed?: true;
  /** APPLIED by `stageReconcile`: the host content was verified, not applied by the broker. */
  reconciled?: true;
}

export interface StageStatus {
  n: number;
  sessionID: string;
  state: "BUILDING" | "READY" | "APPROVED" | "REJECTED" | "STALE" | "APPLYING" | "APPLIED";
  /** Present only for a rebuild (attempt 2 or later). */
  attempt?: number;
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
  nextSnapshot: { worktree: true } | { resultRef: string } | { commit: string } | null;
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

const attemptOf = (x: { attempt?: number } | undefined): number => x?.attempt ?? 1;
/** Only a rebuild (attempt > 1) carries an attempt field, so attempt-1 records stay byte-identical to P1/P2. */
const attemptField = (x: { attempt?: number } | undefined): { attempt?: number } => (attemptOf(x) > 1 ? { attempt: attemptOf(x) } : {});
/** Stage ref suffix: `<n>` for attempt 1 (as in P1), `<n>.<attempt>` after. */
const stageKey = (n: number, attempt: number): string => (attempt === 1 ? `${n}` : `${n}.${attempt}`);

/** READY stage attempts: stageKey -> result commit, from the stage refs. */
async function readyStages(git: Git, id: string): Promise<Map<string, string>> {
  const r = await git(["git", "for-each-ref", "--format=%(refname) %(objectname)", `${REF_ROOT}/${id}/stage/`]);
  if (r.status !== 0) throw new StateError(`cannot list chain stages: ${r.stderr.trim().slice(0, 500)}`);
  const ready = new Map<string, string>();
  for (const line of r.stdout.split("\n").filter(Boolean)) {
    const [ref, sha] = line.split(" ") as [string, string];
    ready.set(ref.slice(ref.lastIndexOf("/") + 1), sha);
  }
  return ready;
}

/**
 * The session holding each stage number (its newest attempt), in stage order. A
 * FAILED_CLOSED session that never registered frees its slot.
 */
function claims(ctx: OpContext, id: string, ready: ReadonlyMap<string, string>): SessionRecord[] {
  const newest = new Map<number, SessionRecord>();
  for (const s of ctx.store.list()) {
    if (s.chain?.id !== id || !(ready.has(stageKey(s.chain.n, attemptOf(s.chain))) || s.state !== "FAILED_CLOSED")) continue;
    const held = newest.get(s.chain.n);
    if (!held || attemptOf(s.chain) > attemptOf(held.chain)) newest.set(s.chain.n, s);
  }
  return [...newest.values()].sort((a, b) => a.chain!.n - b.chain!.n);
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

const EVENT_NAMES: readonly StageEvent["event"][] = ["APPROVED", "REJECTED", "STALE", "APPLYING", "APPLIED", "APPLY_REFUSED"];

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
    typeof e.at === "string" && typeof e.by?.sessionID === "string" && typeof e.by.agent === "string" &&
    (e.attempt === undefined || (Number.isInteger(e.attempt) && e.attempt >= 2));
  if (!Array.isArray(parsed.events) || !parsed.events.every((e) => typeof e === "object" && e !== null && valid(e))) {
    throw new StateError(`corrupt decision record ${id}: shape validation failed`);
  }
  return parsed.events as StageEvent[];
}

type Decided = Exclude<StageStatus["state"], "BUILDING" | "READY">;

function decidedState(events: readonly StageEvent[], n: number, attempt = 1): Decided | undefined {
  let state: Decided | undefined;
  for (const e of events) if (e.n === n && attemptOf(e) === attempt) state = e.event === "APPLY_REFUSED" ? "APPROVED" : e.event;
  return state;
}

/** The state of stage `n`'s newest attempt (the one with events; older attempts are never APPLIED). */
function latestState(events: readonly StageEvent[], n: number): Decided | undefined {
  return decidedState(events, n, Math.max(1, ...events.filter((e) => e.n === n).map(attemptOf)));
}

/** Append event(s) after `guard` accepted the current events, in one atomic write. Synchronous on purpose (no interleaving). */
function recordEvent(ctx: OpContext, id: string, event: Omit<StageEvent, "at"> | Omit<StageEvent, "at">[], guard?: (events: readonly StageEvent[]) => void): void {
  const events = loadEvents(ctx, id);
  guard?.(events);
  const at = new Date().toISOString();
  mkdirSync(join(ctx.config.stateDir, "chains"), { recursive: true, mode: 0o700 });
  writeFileAtomic(decisionsPath(ctx, id), JSON.stringify({ events: [...events, ...[event].flat().map((e) => ({ ...e, at }))] }, null, 2));
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
    const attempt = attemptOf(s.chain);
    const result = ready.get(stageKey(n, attempt));
    const decided = decidedState(events, n, attempt);
    // A stage that never produced a result is BUILDING, unless it was released (REJECTED) or made STALE.
    const state = result || decided === "REJECTED" || decided === "STALE" ? (decided ?? "READY") : "BUILDING";
    const stage: StageStatus = { n, sessionID: s.sessionID, state, ...attemptField(s.chain), baseline };
    const own = events.filter((e) => e.n === n); // every attempt: a rebuild keeps its predecessors' history
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

/**
 * Where the next worker goes. After a rejection that is a REBUILD: the first
 * REJECTED or STALE stage is run again as a new attempt, from the previous stage's
 * pinned result, which must be APPROVED or APPLIED (never merge-tree replay of the
 * old content). Otherwise the next stage after a finished tip.
 */
function nextTarget(chain: ChainRecord, stages: readonly StageStatus[]): { n: number; attempt: number; prev?: StageStatus; rebuild: boolean } | { refuse: string } {
  const dead = stages.find((s) => s.state === "REJECTED" || s.state === "STALE");
  if (dead) {
    const prev = stages.find((s) => s.n === dead.n - 1);
    if (prev && prev.state !== "APPROVED" && prev.state !== "APPLIED") {
      return { refuse: `stage ${dead.n} is ${dead.state}; stage ${prev.n} is ${prev.state} and must be APPROVED or APPLIED before stage ${dead.n} is rebuilt` };
    }
    return { n: dead.n, attempt: attemptOf(dead) + 1, ...(prev ? { prev } : {}), rebuild: true };
  }
  const tip = stages.at(-1);
  if (!tip) return { n: 1, attempt: 1, rebuild: false };
  if (tip.n >= chain.maxStages) return { refuse: `chain ${chain.id} reached its stage limit (${chain.maxStages})` };
  if (!tip.result) return { refuse: `stage ${tip.n} is not ready` };
  return { n: tip.n + 1, attempt: 1, prev: tip, rebuild: false };
}

export async function chainStatus(ctx: OpContext, id: string): Promise<ChainStatus> {
  const { chain, git, stages } = await chainStages(ctx, id);
  const target = nextTarget(chain, stages);
  if ("refuse" in target) return { chain, stages, nextSnapshot: null };
  if (!target.prev) return { chain, stages, nextSnapshot: { worktree: true } };
  // A rebuild starts from the previous stage's pinned commit (its session result ref may be gone).
  if (target.rebuild) return { chain, stages, nextSnapshot: { commit: target.prev.result! } };
  // Offer the session's result ref only while it still IS the pinned stage commit (a refused re-finish or a discard moves/deletes it).
  const offered = target.prev.state === "READY" ? resultRef(target.prev.sessionID) : undefined;
  const stillPinned = offered !== undefined && (await commitOf(git, offered)) === target.prev.result;
  return { chain, stages, nextSnapshot: stillPinned ? { resultRef: offered! } : null };
}

/**
 * Bind an already-started worker session to the next stage of a chain. The
 * session must have been started with `chainStatus(...).nextSnapshot`; the
 * broker checks that its pinned baseline IS the derived one and refuses
 * otherwise (fail closed, no fallback). After a rejection the stage number is
 * reused as a new attempt (see nextTarget); the older attempt keeps its ref.
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
  const { stages } = await chainStages(ctx, id);

  // Everything below is synchronous (no await) so two attaches cannot interleave.
  const target = nextTarget(chain, stages);
  if ("refuse" in target) throw new StateError(target.refuse);
  if (!target.prev) {
    const source = (session as { snapshotIdentity?: { source?: string } }).snapshotIdentity?.source;
    if (source !== "worktree") throw new StateError("stage 1 must start from the host worktree snapshot");
  } else if (baseline !== target.prev.result) {
    throw new StateError(`session baseline is not stage ${target.prev.n}'s result`);
  }
  ctx.store.touch(sessionID, { chain: { id, n: target.n, baseline, ...attemptField(target) } }, "chainAttach");
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
  if (member.n === 1 && attemptOf(member) === 1) await pin(git, `${REF_ROOT}/${member.id}/base`, member.baseline);
  await pin(git, `${REF_ROOT}/${member.id}/stage/${stageKey(member.n, attemptOf(member))}`, result);
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

/**
 * Resolve the stage a decision names and bind the decision to its pinned result commit.
 * `release` (reject only) also accepts a BUILDING stage, named by the all-zero result: the way to free the claim of a worker that was released or failed.
 */
async function decisionTarget(ctx: OpContext, by: Decider, p: Record<string, unknown>, release = false) {
  const id = String(p.chainID);
  const n = p.n;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) throw new ValidationError("n must be a positive integer");
  if (typeof p.result !== "string" || !SHA_RE.test(p.result)) throw new ValidationError("result must be the stage's 40-hex result commit");
  // A session that owns a stage of the chain can never decide on it, whatever name it is bound to.
  if (ctx.store.get(by.sessionID)?.chain?.id === id) throw new PolicyError("a worker session of the chain cannot decide on its stages (STAGE_DECISION_NOT_WORKER)");
  const { chain, stages } = await chainStages(ctx, id);
  const stage = stages.find((s) => s.n === n);
  if (!stage) throw new StateError(`chain ${id} has no stage ${n}`);
  if (!stage.result && !(release && stage.state === "BUILDING" && p.result === ZERO_OID)) throw new StateError(`stage ${n} is ${stage.state === "BUILDING" ? "BUILDING; it has no result to decide on" : stage.state}`);
  if (stage.result && stage.result !== p.result) throw new StateError(`stage ${n}: the decision names a result commit that is not the stage's pinned result commit`);
  return { id, n, result: p.result, chain, stage, stages };
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
  recordEvent(ctx, id, { n, event: "APPROVED", result, by, ...attemptField(stage), ...(confirmed ? { protectedConfirmed: true as const } : {}) }, (events) => {
    const state = decidedState(events, n, attemptOf(stage));
    if (state) throw new StateError(`stage ${n} is already ${state}; only a READY stage can be approved`);
  });
  return { chainID: id, n, state: "APPROVED", result };
}

/**
 * Records REJECTED with the revision note and marks every later stage that is not
 * APPLIED as STALE, in one write (reduced P4: no replay; the stages are re-run from
 * the new tip, see nextTarget). Rejecting a BUILDING stage (all-zero `result`)
 * releases the claim of a worker that was released or failed.
 */
export async function stageReject(ctx: OpContext, by: Decider, p: Record<string, unknown>) {
  if (typeof p.note !== "string" || p.note.trim().length === 0 || p.note.length > NOTE_MAX) {
    throw new ValidationError(`note must be a non-empty revision note of at most ${NOTE_MAX} characters`);
  }
  const { id, n, result, stage, stages } = await decisionTarget(ctx, by, p, true);
  const attempt = attemptOf(stage);
  const stale = stages
    .filter((s) => s.n > n && !["APPLIED", "REJECTED", "STALE"].includes(s.state))
    .map((s) => ({ n: s.n, event: "STALE" as const, result: s.result ?? ZERO_OID, by, ...attemptField(s), reason: `stage ${n} was rejected` }));
  recordEvent(ctx, id, [{ n, event: "REJECTED", result, by, ...attemptField(stage), note: p.note }, ...stale], (events) => {
    const state = decidedState(events, n, attempt);
    if (state && state !== "APPROVED") throw new StateError(`stage ${n} is ${state}; only a READY or APPROVED stage can be rejected`);
  });
  return { chainID: id, n, state: "REJECTED", result, ...(stale.length > 0 ? { stale: stale.map((e) => e.n) } : {}) };
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
  const attempt = attemptOf(stage);
  recordEvent(ctx, id, { n, event: "APPLYING", result, by, ...attemptField(stage) }, (events) => {
    const state = decidedState(events, n, attempt);
    if (state !== "APPROVED") throw new StateError(`stage ${n} is ${state ?? "READY"}, not APPROVED; only an APPROVED stage is applied`);
    for (let k = 1; k < n; k++) {
      if (latestState(events, k) !== "APPLIED") throw new StateError(`stage ${k} is not APPLIED; stages apply strictly in order`);
    }
  });

  const key = `stage-${id}-${n}`; // scratch names for the divergence index, patch and preview
  const patchFile = patchPathFor(ctx.config.stateDir, key);
  const projectDir = projectDirFor(ctx, chain.projectID);
  let landing = false; // true once `git apply` may have run: from then on a failure is NOT recorded as a clean refusal
  try {
    // The approval is of one commit: the APPROVED event, the payload and the pinned stage ref must all name it (a host-side ref rewrite after approval is refused).
    const approved = loadEvents(ctx, id).filter((e) => e.n === n && attemptOf(e) === attempt && e.event === "APPROVED").pop();
    if (!approved || approved.result !== result) throw new StateError(`stage ${n}: stage ref moved since approval; the approved result commit is not the one to apply`);
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
    recordEvent(ctx, id, { n, event: "APPLIED", result, by, ...attemptField(stage) });
    return { chainID: id, n, state: "APPLIED", applied: true, result, touchesProtected: stage.touchesProtected === true, applyPreview: buildApplyPreview(patch.stdout), applyPreviewFiles };
  } catch (err) {
    if (!landing) recordEvent(ctx, id, { n, event: "APPLY_REFUSED", result, by, ...attemptField(stage), reason: (err instanceof Error ? err.message : String(err)).slice(0, 500) });
    throw err;
  } finally {
    rmSync(patchFile, { force: true });
  }
}

/**
 * What differs between the host working tree and a stage's pinned result, over
 * the paths the stage changed (read-only: lstat, read and hash; nothing is written).
 * A path the result keeps must hold exactly the result's blob; a path the result
 * deletes must be absent. Symlinks, submodules and anything outside the project
 * root cannot be verified here and count as differences.
 */
async function hostDifferences(ctx: OpContext, chain: ChainRecord, stage: StageStatus): Promise<string[]> {
  const projectDir = projectDirFor(ctx, chain.projectID);
  const paths = stage.changedPaths ?? [];
  const tree = await ctx.git.spawn(["git", "ls-tree", "-r", "-z", "--full-tree", stage.result!, "--", ...paths], {
    env: { GIT_DIR: join(projectDir, ".git"), GIT_LITERAL_PATHSPECS: "1" },
    cwd: projectDir,
    timeoutMs: 60_000,
  });
  if (tree.status !== 0 || tree.outputTruncated === true) throw new StateError(`cannot read stage ${stage.n}'s tree`);
  const expected = new Map<string, { mode: string; sha: string }>();
  for (const entry of tree.stdout.split("\0").filter(Boolean)) {
    const m = /^(\d{6}) blob ([0-9a-f]{40})\t([\s\S]+)$/.exec(entry) ?? /^(\d{6}) commit ([0-9a-f]{40})\t([\s\S]+)$/.exec(entry);
    if (m) expected.set(m[3]!, { mode: m[1]!, sha: m[2]! });
  }
  const root = realpathSync(projectDir);
  const differences: string[] = [];
  for (const path of paths) {
    const want = expected.get(path);
    const full = join(projectDir, path);
    let present = true;
    try {
      lstatSync(full);
    } catch {
      present = false;
    }
    if (!want) {
      if (present) differences.push(`${path}: deleted by the stage but present on the host`);
      continue;
    }
    if (!present) {
      differences.push(`${path}: missing on the host`);
      continue;
    }
    if (want.mode === "120000" || want.mode === "160000") {
      differences.push(`${path}: a symlink or submodule cannot be verified; the owner checks it by hand`);
    } else if (!lstatSync(full).isFile() || !realpathSync(dirname(full)).startsWith(root)) {
      differences.push(`${path}: not a regular file inside the project`);
    } else {
      const bytes = readFileSync(full);
      const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      if (sha !== want.sha) differences.push(`${path}: content differs from the stage's result`);
    }
  }
  return differences;
}

/**
 * Record APPLIED for a stage the broker did not finish applying: an APPLYING stage
 * left by a crash, or an APPROVED protected (S17) stage the owner applied by hand.
 * Only when every changed path on the host equals the stage's pinned result, every
 * earlier stage is APPLIED, and the approval names this commit. Never writes to the
 * host; a mismatch records nothing and returns the differences.
 */
export async function stageReconcile(ctx: OpContext, by: Decider, p: Record<string, unknown>) {
  if (ctx.git.runnerMode !== "real") throw new StateError("stage reconcile requires the real git runner");
  const { id, n, result, chain, stage } = await decisionTarget(ctx, by, p);
  const attempt = attemptOf(stage);
  const eligible = (state: StageStatus["state"], events: readonly StageEvent[]): void => {
    if (state !== "APPLYING" && !(state === "APPROVED" && stage.touchesProtected === true)) {
      throw new StateError(`stage ${n} is ${state}; only an APPLYING stage or an APPROVED protected (S17) stage is reconciled`);
    }
    for (let k = 1; k < n; k++) {
      if (latestState(events, k) !== "APPLIED") throw new StateError(`stage ${k} is not APPLIED; stages are reconciled strictly in order`);
    }
    const approved = events.filter((e) => e.n === n && attemptOf(e) === attempt && e.event === "APPROVED").pop();
    if (!approved || approved.result !== result) throw new StateError(`stage ${n}: stage ref moved since approval; the approved result commit is not the one to reconcile`);
  };
  eligible(stage.state, loadEvents(ctx, id));
  const differences = await hostDifferences(ctx, chain, stage);
  if (differences.length > 0) return { chainID: id, n, state: stage.state, reconciled: false, differences: differences.slice(0, 50), differenceCount: differences.length };
  recordEvent(ctx, id, { n, event: "APPLIED", result, by, ...attemptField(stage), reconciled: true }, (events) => {
    const state = decidedState(events, n, attempt);
    if (state !== stage.state) throw new StateError(`stage ${n} changed while it was verified (now ${state})`);
    eligible(stage.state, events);
  });
  return { chainID: id, n, state: "APPLIED", reconciled: true, result, touchesProtected: stage.touchesProtected === true };
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

function buildDecisionOp(ctx: OpContext, operation: "stageApprove" | "stageReject" | "stageApply" | "stageReconcile", run: (ctx: OpContext, by: Decider, p: Record<string, unknown>) => Promise<unknown>): OpHandler {
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
export const buildStageReconcileOp = (ctx: OpContext): OpHandler => buildDecisionOp(ctx, "stageReconcile", stageReconcile);
