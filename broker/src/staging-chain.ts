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
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { RESULT_EXCLUDE_PATHS } from "./diff-spec.ts";
import { buildChangedPathsArgv, buildCheckArgv, checkProtectedPaths, parseNulDelimitedPaths, patchPathFor, resultRef } from "./gitops.ts";
import { redact } from "./logging.ts";
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
  pruneTestRunLogs,
  writeTestRunLog,
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
  /** Set only in the reviewer's view (boundedStageView) when more paths changed than are listed. */
  changedPathsOmitted?: number;
  touchesProtected?: boolean;
  history?: StageEvent[];
  /** Ids of the broker's stage-bound testRun logs (D30), present only when evidence was recorded. A pointer, never trusted: gateVerdictAuto re-validates the log. */
  testRunRefs?: string[];
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
  if (c.id !== id || typeof c.projectID !== "string" || !Number.isInteger(c.maxStages) || (c.maxStages as number) < 1 || typeof c.createdAt !== "string" || !Object.hasOwn(CHAIN_LANES, String(c.lane))) {
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
      if (s.chain!.testRunRefs?.length) stage.testRunRefs = [...s.chain!.testRunRefs];
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
  // `stages` was read before an await: re-check against the live decisions and claims, still without an await,
  // so a reject or another attach that landed in that window cannot leave this session on a dead or taken slot.
  if (target.prev) {
    const decided = decidedState(loadEvents(ctx, id), target.prev.n, attemptOf(target.prev));
    if (decided === "REJECTED" || decided === "STALE") throw new StateError(`stage ${target.prev.n} was ${decided === "REJECTED" ? "rejected" : "marked STALE"} while this session was attaching`);
  }
  for (const other of ctx.store.list()) {
    if (other.sessionID !== sessionID && other.chain?.id === id && other.chain.n === target.n && attemptOf(other.chain) === target.attempt && other.state !== "FAILED_CLOSED") {
      throw new StateError(`stage ${target.n} was claimed by another session while this session was attaching`);
    }
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

const TREE_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Tree id of the worker's /work content, as `prepareResult` would commit it: a throwaway index (never the
 * worker's own) seeded from the result ref, then `add -A` with the result excludes, then `write-tree`.
 * Undefined whenever the sandbox cannot say, and whenever the tree or the repository settings mean the runner would see
 * content the id does not cover (a gitlink, `core.fileMode=false`, ...): no evidence is better than evidence for part of it.
 */
async function sandboxTree(ctx: OpContext, worker: string, ref: string, ignoredAllow: readonly string[]): Promise<string | undefined> {
  const index = `/work/.broker-tmp/evidence-${randomUUID()}.index`;
  // core.fsmonitor=false: a worker-set monitor cannot hide edited files from `add`.
  const env = {
    GIT_INDEX_FILE: index, GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "/work",
    GIT_CONFIG_KEY_1: "core.fsmonitor", GIT_CONFIG_VALUE_1: "false",
  };
  const run = (argv: string[]) => ctx.adapter.exec(worker, argv, { cwd: "/work", timeoutMs: 60_000, env });
  try {
    // A clean filter would let `add` hash different bytes than the files the runner reads: no filter may be configured (exit 1 = none).
    if ((await run(["git", "config", "--get-regexp", "^filter[.]"])).status !== 1) return undefined;
    // Repository settings under which the hash and the runner's view of /work can differ: a mode the hash
    // ignores (fileMode, symlinks), files it skips (sparse checkout), a work tree somewhere else (worktree,
    // bare). --type=bool normalises no/off/0; core.worktree is a path, so it fails the conversion (exit 128).
    // core.worktree is read as a raw value: --type=bool would turn a bool spelling (true, yes, 1, on) into "true" and miss it.
    if ((await run(["git", "config", "--get", "core.worktree"])).status !== 1) return undefined;
    // Exit 1 = none set. Anything else, or a value other than the git default, writes no evidence.
    const core = await run(["git", "config", "--type=bool", "--get-regexp", "^core[.](filemode|symlinks|bare|sparsecheckout|worktree)$"]);
    if (core.status !== 0 && core.status !== 1) return undefined;
    for (const line of core.stdout.split("\n").filter((l) => l !== "")) {
      const [key, value] = line.split(" ");
      if ((key === "core.filemode" || key === "core.symlinks") && value !== "true") return undefined;
      if ((key === "core.bare" || key === "core.sparsecheckout") && value !== "false") return undefined;
    }
    if ((await run(["git", "read-tree", ref])).status !== 0) return undefined;
    if ((await run(["git", "add", "-A", "--", ".", ...RESULT_EXCLUDE_PATHS])).status !== 0) return undefined;
    const written = await run(["git", "write-tree"]);
    const tree = written.status === 0 ? written.stdout.trim() : "";
    if (!TREE_RE.test(tree)) return undefined;
    // `add -A` skips git-ignored files, but the runner can load them (a shimmed dependency): only the allowed
    // ignored paths may exist, or the tree id covers less than what ran. --directory keeps a whole ignored
    // directory to one entry, so node_modules is not listed file by file.
    const ignored = await ctx.adapter.exec(worker, ["git", "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory", "--", ".", ...RESULT_EXCLUDE_PATHS], { cwd: "/work", timeoutMs: 60_000, maxOutputBytes: 8 * 1024 * 1024, env });
    if (ignored.status !== 0 || ignored.outputTruncated === true) return undefined;
    for (const entry of ignored.stdout.split("\0").filter((e) => e !== "")) {
      const path = entry.replace(/\/+$/, "");
      if (!ignoredAllow.some((allowed) => path === allowed || path.startsWith(`${allowed}/`))) return undefined;
    }
    // A nested repository is recorded as a bare gitlink (mode 160000): its content, tracked or not, is visible to
    // the runner but is not in the tree id. Refuse the whole tree rather than bind a log to part of what ran.
    const listing = await ctx.adapter.exec(worker, ["git", "ls-tree", "-r", "-z", tree], { cwd: "/work", timeoutMs: 60_000, maxOutputBytes: 8 * 1024 * 1024, env });
    if (listing.status !== 0 || listing.outputTruncated === true) return undefined;
    if (listing.stdout.split("\0").some((entry) => entry.startsWith("160000 "))) return undefined;
    return tree;
  } finally {
    await ctx.adapter.exec(worker, ["rm", "-f", "--", index], { cwd: "/work", timeoutMs: 30_000 }).catch(() => undefined);
  }
}

/**
 * D30: stage-bound test evidence. For a chain stage whose result was just imported and pinned, run each
 * CONFIGURED test runner (broker config only; never the worker, the stage content or the plan) inside the
 * worker's own sandbox, in its /work tree, and write one broker-owned testRun log per runner whose header
 * binds it to the project and the pinned stage result's tree. Nothing runs on the host.
 *
 * The binding is only written when the sandbox content is exactly the pinned stage: the sandbox tree must
 * equal `<stage>^{tree}` before the runners start AND after they finish (a racing worker, or a runner that
 * edits the tree, leaves no evidence). Anything that is not a clean exit 0 (non-zero exit, timeout, signal,
 * no exit code, output over the cap) is recorded as a FAILING log; an infrastructure failure writes nothing,
 * so the tests check stays missing. Every error is swallowed here: evidence can never block or alter the
 * registration that already happened. The log ids are stored on the session's chain membership so stage
 * reads can point at them; gateVerdictAuto still re-validates each log itself.
 */
export async function collectStageTestEvidence(ctx: OpContext, record: SessionRecord, ref: string): Promise<void> {
  const member = record.chain;
  if (!member || !record.workerName || !record.projectID || ctx.config.testRunners.length === 0) return;
  try {
    const git = gitFor(ctx, loadChain(ctx, member.id));
    const stageRef = `${REF_ROOT}/${member.id}/stage/${stageKey(member.n, attemptOf(member))}`;
    const treeRun = await git(["git", "rev-parse", "--verify", "--quiet", `${stageRef}^{tree}`]);
    const tree = treeRun.stdout.trim();
    if (treeRun.status !== 0 || !TREE_RE.test(tree)) return;
    const worker = record.workerName;
    if ((await sandboxTree(ctx, worker, ref, ctx.config.evidenceIgnoredAllow)) !== tree) return;
    const runs = [];
    for (const runner of ctx.config.testRunners) {
      const result = await ctx.adapter.exec(worker, runner.argv, {
        cwd: join("/work", runner.cwd),
        timeoutMs: runner.timeoutMs,
        maxOutputBytes: runner.maxOutputBytes,
        env: { CI: "1", NO_COLOR: "1" },
      });
      runs.push({ runner, result });
    }
    if ((await sandboxTree(ctx, worker, ref, ctx.config.evidenceIgnoredAllow)) !== tree) return;
    const projectRoot = projectDirFor(ctx, record.projectID);
    const ids = runs.map(({ runner, result }) => {
      // Stored output is redacted and capped per stream; whatever was cut makes the run a non-pass.
      const stdout = Buffer.from(redact(result.stdout), "utf8");
      const stderr = Buffer.from(redact(result.stderr), "utf8");
      const truncated = result.outputTruncated === true || result.stderrTruncated === true || stdout.length > runner.maxOutputBytes || stderr.length > runner.maxOutputBytes;
      const clean = result.status !== null && !result.timedOut && !truncated;
      const path = writeTestRunLog(ctx.config.stateDir, projectRoot, {
        runner: runner.id,
        exitCode: clean ? result.status : null,
        signal: result.status === null ? "unknown" : null,
        timedOut: result.timedOut,
        truncated,
        binding: { project: record.projectID!, tree },
        stdout: stdout.subarray(0, runner.maxOutputBytes),
        stderr: stderr.subarray(0, runner.maxOutputBytes),
      });
      return basename(path, ".log");
    });
    pruneTestRunLogs(ctx.config.stateDir);
    const current = ctx.store.get(record.sessionID)?.chain ?? member;
    ctx.store.touch(record.sessionID, { chain: { ...current, testRunRefs: ids } }, "chainEvidence");
  } catch (error) {
    try {
      ctx.logger?.log?.({ sessionID: record.sessionID, operation: "chainEvidence", result: "error", error: redact(error instanceof Error ? error.message : String(error)).slice(0, 500) });
    } catch {
      // Logging must not turn a registered stage into a failed finish.
    }
  }
}

/** Stage-review reads: every field comes from the pinned stage refs. */
const VIEW_PATHS_MAX = 200;
const VIEW_PATH_CHARS_MAX = 300;
// Controls, line separators, soft hyphen, zero-width and bidi formatting characters, and the byte-order mark: all can make a name read differently from its bytes.
const LOOKALIKE_RE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

/** A name as the reviewer reads it: the backslash is escaped first, so an escape sequence in the output can only come from this function. */
function viewName(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(LOOKALIKE_RE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Cut at a whole code point, never inside a surrogate pair. */
function cutName(name: string): string {
  const chars = Array.from(name);
  return chars.length > VIEW_PATH_CHARS_MAX ? `${chars.slice(0, VIEW_PATH_CHARS_MAX).join("")}…` : name;
}

/** True when the reviewer's view omits or cuts anything: such a stage can be rejected but never approved or applied. */
export function viewTruncated(stage: StageStatus): boolean {
  const paths = stage.changedPaths ?? [];
  return paths.length > VIEW_PATHS_MAX || paths.some((path) => Array.from(viewName(path)).length > VIEW_PATH_CHARS_MAX);
}

/**
 * What the stage-review model sees of a stage. changedPaths are worker-authored file names, so they are an injection
 * surface: backslashes, control, zero-width and bidi characters are written as escapes, each name is cut to 300
 * characters and at most 200 are shown, with the omitted count. The broker's own checks (protected paths, scope) use
 * the full list, and approve and apply refuse a stage whose view was truncated (viewTruncated).
 */
export function boundedStageView(stage: StageStatus): StageStatus {
  if (!stage.changedPaths) return stage;
  const paths = stage.changedPaths.slice(0, VIEW_PATHS_MAX).map((path) => cutName(viewName(path)));
  const omitted = stage.changedPaths.length - paths.length;
  const unchanged = omitted === 0 && paths.every((path, i) => path === stage.changedPaths![i]);
  return unchanged ? stage : { ...stage, changedPaths: paths, ...(omitted > 0 ? { changedPathsOmitted: omitted } : {}) };
}

export async function stageList(ctx: OpContext, id: string): Promise<{ chain: ChainRecord; stages: StageStatus[] }> {
  const { chain, stages } = await chainStages(ctx, id);
  return { chain, stages: stages.map(boundedStageView) };
}

export async function stageShow(ctx: OpContext, id: string, n: unknown): Promise<{ chain: ChainRecord; stage: StageStatus }> {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) throw new ValidationError("n must be a positive integer");
  const { chain, stages } = await chainStages(ctx, id);
  const stage = stages.find((s) => s.n === n);
  if (!stage) throw new StateError(`chain ${id} has no stage ${n}`);
  return { chain, stage: boundedStageView(stage) };
}

// ---------------------------------------------------------------------------
// The owner's decisions: approve, reject, apply (stage-review role only).
// Nothing here approves because an agent asked: the broker records what the
// stage-review identity decided, and apply additionally needs the owner's
// APPLY confirmation. Only apply touches the host.
// ---------------------------------------------------------------------------

type Decider = { sessionID: string; agent: string };

/** The owner decides on what the reviewer saw: a stage whose path list was cut cannot be approved or applied (reject it and rebuild it smaller). */
function assertViewComplete(stage: StageStatus): void {
  if (viewTruncated(stage)) {
    throw new StateError(`stage ${stage.n} changes more than the reviewer can be shown (over ${VIEW_PATHS_MAX} paths or a name over ${VIEW_PATH_CHARS_MAX} characters) and cannot be shown to the reviewer in full; reject it and rebuild it smaller`);
  }
}
const NOTE_MAX = 4000;

/**
 * Resolve the stage a decision names and bind the decision to its pinned result commit.
 * `release` (reject only) also accepts a BUILDING stage, named by the all-zero result: the way to free the claim of a worker that was released or failed.
 */
async function decisionTarget(ctx: OpContext, by: Decider, p: Record<string, unknown>, release = false) {
  const id = strictString(p.chainID, "chainID");
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
  assertViewComplete(stage);
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
  // `stages` was read before awaits: a session may have attached to a later stage since. Everything from here to
  // the write is synchronous, so mark any such live claim too (it can only be BUILDING, with no result yet).
  const live = loadEvents(ctx, id);
  for (const other of ctx.store.list()) {
    const member = other.chain;
    if (member?.id !== id || member.n <= n || other.state === "FAILED_CLOSED") continue;
    if (stale.some((e) => e.n === member.n && attemptOf(e) === attemptOf(member))) continue;
    if (["APPLIED", "REJECTED", "STALE"].includes(decidedState(live, member.n, attemptOf(member)) ?? "")) continue;
    stale.push({ n: member.n, event: "STALE" as const, result: ZERO_OID, by, ...attemptField(member), reason: `stage ${n} was rejected` });
  }
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
  const { id, n, result, chain, stage, stages } = await decisionTarget(ctx, by, p);
  assertViewComplete(stage);
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
    // Stage numbers alone do not order a chain: a stage built on a rejected attempt keeps its number. Its baseline
    // must be the pinned result of the newest attempt of the stage before it (a recorded refusal, like the rest).
    const predecessor = n > 1 ? stages.find((s) => s.n === n - 1)?.result : undefined;
    if (n > 1 && (predecessor === undefined || predecessor !== stage.baseline)) {
      throw new StateError(`stage ${n}'s baseline is not stage ${n - 1}'s pinned result (a rebuilt predecessor?); re-run stage ${n} from the current tip`);
    }
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

/** A regular file (not a symlink) whose every ancestor below the project root is a real directory, resolving inside the root. */
function isPlainFileInside(root: string, path: string, full: string): boolean {
  if (!resolve(full).startsWith(root + sep)) return false;
  const parts = path.split("/");
  let cur = root;
  for (const part of parts.slice(0, -1)) {
    cur = join(cur, part);
    const st = lstatSync(cur);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
  }
  return lstatSync(full).isFile();
}

/**
 * What differs between the host working tree and a stage's pinned result, over
 * the paths the stage changed (read-only: lstat, read and hash; nothing is written).
 * A path the result keeps must hold exactly the result's blob; a path the result
 * deletes must be absent. Symlinks (the file or any ancestor directory), submodules and anything outside the
 * project root cannot be verified here and count as differences; only content and
 * the executable bit are compared.
 */
async function hostDifferences(ctx: OpContext, chain: ChainRecord, stage: StageStatus): Promise<string[]> {
  const projectDir = projectDirFor(ctx, chain.projectID);
  const paths = stage.changedPaths ?? [];
  if (paths.length === 0) throw new StateError(`stage ${stage.n} changed no paths; there is nothing to verify on the host`);
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
    const full = join(root, path);
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
    } else if (!isPlainFileInside(root, path, full)) {
      differences.push(`${path}: not a regular file inside the project`);
    } else if (want.mode === "100755" !== ((lstatSync(full).mode & 0o111) !== 0)) {
      differences.push(`${path}: the executable bit differs from the stage's result (${want.mode})`);
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

/** Payload fields arrive as untyped JSON: refuse anything but a string rather than coercing it (String([id]) would pass as id). */
function strictString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new ValidationError(`${name} must be a string`);
  return value;
}

export function buildChainCreateOp(ctx: OpContext): OpHandler {
  return async (req) => {
    authorizeHostDispatch(ctx, "chainCreate", req.sessionID, req.agent);
    const p = payloadFor("chainCreate", req.payload);
    const { projectID } = resolveCanonicalProjectRoot(ctx, p.projectDir);
    return chainCreate(ctx, { projectID, lane: strictString(p.lane, "lane") });
  };
}

export function buildChainStatusOp(ctx: OpContext): OpHandler {
  return async (req) => {
    authorizeHostDispatch(ctx, "chainStatus", req.sessionID, req.agent);
    return chainStatus(ctx, strictString(payloadFor("chainStatus", req.payload).chainID, "chainID"));
  };
}

export function buildChainAttachOp(ctx: OpContext): OpHandler {
  return async (req) => {
    authorizeHostDispatch(ctx, "chainAttach", req.sessionID, req.agent);
    const p = payloadFor("chainAttach", req.payload);
    await chainAttach(ctx, strictString(p.chainID, "chainID"), strictString(p.sessionID, "sessionID"));
    return { chainID: p.chainID, sessionID: p.sessionID, n: ctx.store.get(p.sessionID as string)?.chain?.n };
  };
}

export function buildStageListOp(ctx: OpContext): OpHandler {
  return async (req) => {
    authorizeHostDispatch(ctx, "stageList", req.sessionID, req.agent);
    return stageList(ctx, strictString(payloadFor("stageList", req.payload).chainID, "chainID"));
  };
}

export function buildStageShowOp(ctx: OpContext): OpHandler {
  return async (req) => {
    authorizeHostDispatch(ctx, "stageShow", req.sessionID, req.agent);
    const p = payloadFor("stageShow", req.payload);
    return stageShow(ctx, strictString(p.chainID, "chainID"), p.n);
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
