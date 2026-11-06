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
 * A stage is BUILDING until its ref exists, then READY. The functions are not
 * socket operations yet (P2 adds host_stage_* tools and their registration).
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildChangedPathsArgv, checkProtectedPaths, parseNulDelimitedPaths, resultRef } from "./gitops.ts";
import { projectDirFor, type OpContext } from "./service.ts";
import { StateError } from "./state.ts";
import type { SessionRecord } from "./types.ts";
import { ValidationError, assertRefComponent } from "./validation.ts";

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

export interface StageStatus {
  n: number;
  sessionID: string;
  state: "BUILDING" | "READY";
  baseline: string;
  result?: string;
  changedPaths?: string[];
  touchesProtected?: boolean;
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
  // state.ts's atomic writer is private to SessionStore; this record is written once (temp + rename).
  const tmp = `${chainPath(ctx, chain.id)}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(chain, null, 2), { mode: 0o600 });
  renameSync(tmp, chainPath(ctx, chain.id));
  return chain;
}

export async function chainStatus(ctx: OpContext, id: string): Promise<ChainStatus> {
  const chain = loadChain(ctx, id);
  const git = gitFor(ctx, chain);
  const ready = await readyStages(git, id);
  const protectedPatterns = [...ctx.config.protectedPaths, ...ctx.config.protectedSecurityFiles];
  const stages: StageStatus[] = [];
  for (const s of claims(ctx, id, ready)) {
    const { n, baseline } = s.chain!;
    const result = ready.get(n);
    const stage: StageStatus = { n, sessionID: s.sessionID, state: result ? "READY" : "BUILDING", baseline };
    if (result) {
      const diff = await git(buildChangedPathsArgv(baseline, result));
      const parsed = parseNulDelimitedPaths(diff.stdout);
      if (diff.status !== 0 || !parsed.complete) throw new StateError(`cannot list changed paths of stage ${n}`);
      Object.assign(stage, { result, changedPaths: parsed.paths, touchesProtected: checkProtectedPaths(parsed.paths, protectedPatterns).length > 0 });
    }
    stages.push(stage);
  }
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
