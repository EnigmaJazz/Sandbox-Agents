/**
 * Idle reaper (Feature 1): auto-releases workers that finished but were never
 * applied, and workers left behind by crashed SANDBOX_ACTIVE sessions.
 *
 * Root cause fixed: releaseWorker was only called on APPLIED/discard/retain,
 * so a session that reached RESULT_READY kept its worker VM + pool allocation
 * forever until someone applied — exhausting the pool with "finished but
 * unapplied" workers.
 *
 * Sweep semantics (per record, per sweep):
 * - RESULT_READY -> release worker + allocation immediately (no age gate)
 *   through the SAME export-before-release policy as finishOrReleaseActive:
 *   a clean worktree is released, a dirty one is re-exported first, and an
 *   unreadable status (or a failed export) keeps the worker. State stays
 *   RESULT_READY and resultRef is kept: the result is already on the host side
 *   (git ref + bundle), so apply/preview/retain/discard still work. This is the
 *   safety net for a finish path that failed to release its own worker. A
 *   later ensureWorker re-creates it on demand.
 * - SANDBOX_ACTIVE + stale -> export-before-release through the same
 *   finishOrReleaseActive policy as sweepUnfinished: a clean worker is
 *   released (`reaped_active`), a dirty or unreadable one is exported to
 *   RESULT_READY first (`auto_finished`), and a failed export keeps the
 *   worker. No reaper path discards unexported edits.
 * - Terminal state (APPLIED/REJECTED/RETAINED/FAILED_CLOSED) still holding a
 *   live worker -> release it at once. Every path into those states should
 *   release its own worker; this catches the one that did not.
 * - Everything else is skipped: parked queue sessions have no worker yet,
 *   CREATING_SANDBOX is mid-creation, APPLY_PENDING is waiting on the user,
 *   and DESTROYED/FAILED workers are gone.
 *
 * Export-before-release (finishOrReleaseActive) is the single policy for a
 * SANDBOX_ACTIVE worker that is going away early, shared by sweepUnfinished
 * and reapOnDisconnect: a clean worker is released, a dirty or unreadable one
 * is exported to RESULT_READY first, and a failed export keeps the worker.
 *
 * The sweep is idempotent (workerName cleared after a reap) and one bad
 * record never kills the sweep (per-record catch, log, continue).
 *
 * State-dir artifact GC (same loop, no second timer): the six session-scoped
 * transport artifacts (bundle, temp indexes, patch, apply previews) plus the
 * divergence temp index are removed once past the grace period, but only when
 * the durability rule allows it (a host result ref resolves, or REJECTED, or a
 * result-less FAILED_CLOSED) or the file is an orphan. A live or
 * not-yet-durable record's artifact is NEVER removed - it may still be the
 * only copy (planned mode / not-yet-imported result). See artifacts.ts.
 */
import { existsSync, statSync } from "node:fs";
import { bundlePathFor } from "./gitops.ts";
import {
  durableHostRefResolves,
  listOrphanArtifactCandidates,
  removeArtifact,
  removalNeedsDurableRef,
  removeSessionArtifacts,
  shouldRemoveSessionArtifacts,
  type ArtifactRemoval,
} from "./artifacts.ts";
import type { LogEntry } from "./logging.ts";
import { describePoolOccupancy, FAILED_CLEANUP_STATES, hasPendingFailedCleanup, isFinishing, removeWorkerVerified, runPrepare, withFinishGuard, type OpContext, type PoolOccupancySnapshot } from "./service.ts";
import { isTerminalState, StateError } from "./state.ts";
import type { SessionRecord } from "./types.ts";

export interface ReaperLogEntry {
  sessionID: string;
  action:
    | "reaped_result_ready"
    | "reaped_active"
    | "reaped_terminal"
    | "reaped_failed_cleanup"
    | "auto_finished"
    | "auto_finished_retained"
    | "release_skipped_dirty"
    | "release_skipped_busy"
    | "swept_artifact"
    | "error";
  detail?: string;
}

/**
 * Map a reaper telemetry event onto a logger payload (the Logger adds `ts`).
 * Preserving `action` and `detail` keeps a lossy `reaped_active` (worker
 * released without an export) distinguishable from an `auto_finished` that
 * exported its edits first.
 */
export function toReaperLogEntry(entry: ReaperLogEntry): Omit<LogEntry, "ts"> {
  return {
    operation: "reaper",
    sessionID: entry.sessionID || undefined,
    action: entry.action,
    result: entry.action === "error" ? "error" : "ok",
    error: entry.action === "error" ? entry.detail : undefined,
    detail: entry.action === "error" ? undefined : entry.detail,
  };
}

export interface ReaperOptions {
  /** Sweep interval in ms (default 60_000). */
  intervalMs: number;
  /** Release workers whose record is older than this, in ms (default 3_600_000). */
  idleMs: number;
  /**
   * Remove a terminal/orphan bundle or temp index only once its record
   * (or file mtime, for orphans) is older than this, in ms. Default 1h.
   */
  artifactGraceMs?: number;
  /**
   * Test seam: the export step used by every export-before-release path
   * (defaults to runPrepare). Threaded into sweepUnfinished and sweepIdle so a
   * sweep never needs a real worker to exercise its policy.
   */
  prepare?: PrepareResult;
  onLog?: (entry: ReaperLogEntry) => void;
  onDrop?: () => void;
}

export interface ReaperHandle {
  stop(): void;
}

/** Default grace before a terminal/orphan transport artifact is removed. */
export const DEFAULT_ARTIFACT_GRACE_MS = 3_600_000;

function safeLog(
  onLog: ReaperOptions["onLog"],
  entry: ReaperLogEntry,
  onDrop?: ReaperOptions["onDrop"],
): void {
  try {
    onLog?.(entry);
  } catch {
    // Telemetry must not interrupt cleanup or worker release.
    try {
      onDrop?.();
    } catch {
      // Drop accounting must not interrupt cleanup or worker release.
    }
  }
}

/**
 * Log the removals for one session: session id, artifact kind, and bytes
 * freed (or the failure). Best-effort by construction - the removals were
 * already attempted and never throw.
 */
function logRemovals(
  sessionID: string,
  removals: ArtifactRemoval[],
  onLog?: (entry: ReaperLogEntry) => void,
  onDrop?: ReaperOptions["onDrop"],
): { removed: number; bytesFreed: number } {
  let removed = 0;
  let bytesFreed = 0;
  for (const r of removals) {
    if (r.removed) {
      removed++;
      bytesFreed += r.bytes;
      safeLog(onLog, {
        sessionID,
        action: "swept_artifact",
        detail: `${r.kind} ${r.bytes} bytes ${r.path}`,
      }, onDrop);
    } else if (r.error) {
      safeLog(onLog, {
        sessionID,
        action: "error",
        detail: `${r.kind}: ${r.error}`,
      }, onDrop);
    }
  }
  return { removed, bytesFreed };
}

/**
 * Best-effort terminal artifact removal for the worker sweeps. Applies the
 * same durability gate as the sweep: a record with a result ref is only
 * cleared once the host ref resolves, so a planned-mode result survives.
 * Never throws and never affects the caller's flow: a GC failure (or an
 * operation-level test harness without a config) is a silent no-op, so
 * reaping still counts.
 */
async function cleanupTerminalArtifacts(
  ctx: OpContext,
  sessionID: string,
  onLog?: (entry: ReaperLogEntry) => void,
  onDrop?: ReaperOptions["onDrop"],
): Promise<void> {
  const stateDir = ctx.config?.stateDir;
  if (!stateDir) return;
  try {
    const record = ctx.store.get(sessionID);
    if (!record) return;
    const bundleExists = existsSync(bundlePathFor(stateDir, sessionID));
    let durable = false;
    if (removalNeedsDurableRef(record, bundleExists)) {
      durable = await durableHostRefResolves(ctx, record);
    }
    if (!shouldRemoveSessionArtifacts(record, durable, bundleExists)) return;
    logRemovals(sessionID, removeSessionArtifacts(stateDir, sessionID), onLog, onDrop);
  } catch (err) {
    safeLog(onLog, {
      sessionID,
      action: "error",
      detail: err instanceof Error ? err.message : String(err),
    }, onDrop);
  }
}

/**
 * One artifact sweep over all session records plus the state-dir files.
 *
 * Removes (after `graceMs`), under the durability rule:
 * - the six session-scoped artifacts of terminal records whose removal the
 *   rule allows (a durable host ref resolves, or REJECTED, or result-less
 *   FAILED_CLOSED);
 * - orphan artifacts with no session record at all.
 * Never removes a live or non-durable record's artifact. Idempotent, per-item
 * catch: one bad file is logged and never aborts the sweep.
 */
export async function sweepStateArtifacts(
  ctx: OpContext,
  graceMs: number = DEFAULT_ARTIFACT_GRACE_MS,
  onLog?: (entry: ReaperLogEntry) => void,
  onDrop?: ReaperOptions["onDrop"],
): Promise<{ removed: number; bytesFreed: number }> {
  const now = Date.now();
  let removed = 0;
  let bytesFreed = 0;

  // 1. Terminal records: the six session-scoped artifacts, after the grace
  //    period AND only when the durability rule allows removal. Live records
  //    (and non-durable terminal ones) are skipped - their artifact may be the
  //    only copy.
  const known = new Set<string>();
  for (const record of ctx.store.list()) {
    known.add(record.sessionID);
    try {
      if (!isTerminalState(record.state)) continue;
      const age = now - Date.parse(record.updatedAt);
      // NaN-safe: an unparseable timestamp is never "stale enough".
      if (!(age > graceMs)) continue;
      const bundleExists = existsSync(
        bundlePathFor(ctx.config.stateDir, record.sessionID),
      );
      let durable = false;
      if (removalNeedsDurableRef(record, bundleExists)) {
        durable = await durableHostRefResolves(ctx, record);
      }
      if (!shouldRemoveSessionArtifacts(record, durable, bundleExists)) continue;
      const result = logRemovals(
        record.sessionID,
        removeSessionArtifacts(ctx.config.stateDir, record.sessionID),
        onLog,
        onDrop,
      );
      removed += result.removed;
      bytesFreed += result.bytesFreed;
    } catch (err) {
      safeLog(onLog, {
        sessionID: record.sessionID,
        action: "error",
        detail: err instanceof Error ? err.message : String(err),
      }, onDrop);
    }
  }

  // 2. Orphan artifacts: no session record, older than the grace period.
  //    Every candidate carries the session key encoded in its filename - the
  //    divergence temp index included (`divergence-<id>.index`) - so a file
  //    owned by a KNOWN session is handled by pass 1 and skipped here even
  //    when that session is live. A live record's artifact is never swept.
  for (const candidate of listOrphanArtifactCandidates(ctx.config.stateDir)) {
    const sessionID = candidate.sessionKey ?? "";
    try {
      if (candidate.sessionKey !== null && known.has(candidate.sessionKey)) {
        continue;
      }
      const stat = statSync(candidate.path);
      if (!stat.isFile()) continue;
      if (!(now - stat.mtimeMs > graceMs)) continue;
      const result = logRemovals(
        sessionID,
        [removeArtifact({ kind: candidate.kind, path: candidate.path })],
        onLog,
        onDrop,
      );
      removed += result.removed;
      bytesFreed += result.bytesFreed;
    } catch (err) {
      safeLog(onLog, {
        sessionID,
        action: "error",
        detail: err instanceof Error ? err.message : String(err),
      }, onDrop);
    }
  }

  return { removed, bytesFreed };
}

/**
 * Startup-safe wrapper around one artifact sweep: clears today's accumulated
 * leftovers without ever throwing into the caller.
 */
export async function runArtifactSweep(
  ctx: OpContext,
  graceMs: number = DEFAULT_ARTIFACT_GRACE_MS,
  onLog?: (entry: ReaperLogEntry) => void,
  onDrop?: ReaperOptions["onDrop"],
): Promise<{ removed: number; bytesFreed: number }> {
  try {
    return await sweepStateArtifacts(ctx, graceMs, onLog, onDrop);
  } catch (err) {
    safeLog(onLog, {
      sessionID: "",
      action: "error",
      detail: err instanceof Error ? err.message : String(err),
    }, onDrop);
    return { removed: 0, bytesFreed: 0 };
  }
}

/** Run the interval loop; returns a handle that stops it. */
export function startReaper(ctx: OpContext, opts: ReaperOptions): ReaperHandle {
  // Startup pass: clear the bundles/temp indexes accumulated before this
  // broker process started (the defect left one bundle per session forever).
  void runArtifactSweep(
    ctx,
    opts.artifactGraceMs ?? DEFAULT_ARTIFACT_GRACE_MS,
    opts.onLog,
    opts.onDrop,
  );
  // A tick never starts while the previous sweep (which can wait on test runners) is still running.
  let sweeping = false;
  const timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void runReaperSweeps(ctx, opts).finally(() => { sweeping = false; });
  }, opts.intervalMs);
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  return { stop: () => clearInterval(timer) };
}

/**
 * One full reaper tick: artifact GC + unfinished auto-finish + idle release.
 * Exported so tests (and a caller that prefers explicit ticks) can run the
 * exact logic the interval runs. Each phase is isolated: one failing phase
 * never skips the others.
 */
export async function runReaperSweeps(
  ctx: OpContext,
  opts: ReaperOptions,
): Promise<void> {
  const logError = (err: unknown) =>
    safeLog(opts.onLog, {
      sessionID: "",
      action: "error",
      detail: err instanceof Error ? err.message : String(err),
    }, opts.onDrop);
  try {
    await sweepStateArtifacts(
      ctx,
      opts.artifactGraceMs ?? DEFAULT_ARTIFACT_GRACE_MS,
      opts.onLog,
      opts.onDrop,
    );
  } catch (err) {
    logError(err);
  }
  try {
    await sweepUnfinished(ctx, 60_000, opts.onLog, opts.onDrop, opts.prepare);
  } catch (err) {
    logError(err);
  }
  try {
    await sweepIdle(ctx, opts.idleMs, opts.onLog, opts.onDrop, opts.prepare);
  } catch (err) {
    logError(err);
  }
}

/**
 * One sweep over all session records. Exported for tests and for callers that
 * prefer explicit sweeps over the interval loop.
 */
export async function sweepIdle(
  ctx: OpContext,
  idleMs: number,
  onLog?: (entry: ReaperLogEntry) => void,
  onDrop?: ReaperOptions["onDrop"],
  prepare: PrepareResult = runPrepare,
): Promise<{ reaped: number }> {
  const now = Date.now();
  let reaped = 0;
  for (const record of ctx.store.list()) {
    try {
      // Skip truly-not-idle: parked in queue, waiting for permission, or exec in-flight
      if (ctx.queue?.find(record.sessionID)) continue;
      if (record.state === "APPLY_PENDING") continue;
      if ((ctx.activeLocks?.get(record.sessionID) ?? 0) > 0) continue;
      if (isFinishing(ctx, record.sessionID)) continue;
      // A worker whose cleanup was never CONFIRMED still owns its name and its
      // slot. Retry it FIRST — under the same lifecycle claim, with a fresh
      // revalidation — before the ordinary FAILED exclusion below; the narrow
      // predicate covers APPLIED/RETAINED (a landed commit/apply), not only
      // RESULT_READY. A failed retry keeps identity and accounting for the next
      // sweep; only a CONFIRMED removal clears them.
      if (
        hasPendingFailedCleanup(record) &&
        FAILED_CLEANUP_STATES.includes(record.state)
      ) {
        const entry = await releaseFailedCleanupWorker(ctx, record);
        safeLog(onLog, entry, onDrop);
        if (entry.action === "reaped_failed_cleanup") reaped++;
        continue;
      }
      // No worker -> nothing to release (includes sessions parked in the pool
      // queue: they never transitioned past HOST_READ_ONLY). DESTROYED/FAILED
      // workers were already released.
      if (!record.workerName) continue;
      if (record.workerState === "DESTROYED" || record.workerState === "FAILED") continue;
      if (isTerminalState(record.state)) {
        // The session is finished, so there is no idle period to wait out. The
        // release still takes the finish guard: a terminal record can be left
        // behind by a finish that is exporting right now, and two release
        // paths must never stop/remove the same worker twice.
        const entry = await releaseTerminalWorker(ctx, record);
        safeLog(onLog, entry, onDrop);
        if (entry.action !== "reaped_terminal") continue;
        reaped++;
        continue;
      }
      if (record.state === "RESULT_READY") {
        // The result lives on the host (ref + bundle) as soon as the export
        // finished, so there is no idle period to wait out. A live worker is
        // still released through the SAME export-before-release policy as
        // finishOrReleaseActive: clean -> release, dirty -> re-export then
        // release, unreadable or failed export -> keep the worker. This is the
        // safety net for a finish path that did not release its own worker.
        const entry = await releaseResultReadyWorker(
          ctx,
          record,
          "result already host-side",
          prepare,
        );
        safeLog(onLog, entry, onDrop);
        if (entry.action !== "reaped_result_ready" && entry.action !== "auto_finished") continue;
        reaped++;
        continue;
      }

      const age = now - Date.parse(record.updatedAt);
      // NaN-safe: an unparseable timestamp is never "stale enough" to reap.
      if (!(age > idleMs)) continue;

      if (record.state === "SANDBOX_ACTIVE") {
        // Export-before-release (T7): an idle worker that still holds edits is
        // exported to RESULT_READY first; only a clean worker is released
        // outright. No reaper path discards unexported edits.
        const entry = await finishOrReleaseActive(ctx, record, "idle clean worker released", prepare);
        safeLog(onLog, entry, onDrop);
        // A failed release (action "error") keeps the worker for the next
        // sweep; a retained worker (export landed, removal did not) is not a
        // release either and must not be counted as one.
        if (entry.action !== "error" && entry.action !== "auto_finished_retained") reaped++;
      }
      // Any other state: skip. CREATING_SANDBOX is mid-creation and must
      // never be reaped.
    } catch (err) {
      // One bad record must not kill the whole sweep.
      safeLog(onLog, {
        sessionID: record.sessionID,
        action: "error",
        detail: err instanceof Error ? err.message : String(err),
      }, onDrop);
    }
  }
  return { reaped };
}

/** Test seam: the export step (runPrepare in production). */
export type PrepareResult = (ctx: OpContext, sessionID: string) => Promise<string>;

/** Which state the live worker is released from; selects the post-export transition. */
type ReleaseFromState = "SANDBOX_ACTIVE" | "RESULT_READY";

/** A guard rejection is a quiet skip: another operation owns this session. */
function skippedBusy(sessionID: string, detail: string): ReaperLogEntry {
  return { sessionID, action: "release_skipped_busy", detail };
}

/**
 * Run one live-worker release decision under the finish guard. A guard
 * rejection ("another operation owns this session") is a skip, never a throw:
 * the interval sweep and the parking-pressure pass must each stay best-effort.
 */
async function guardedRelease(
  ctx: OpContext,
  sessionID: string,
  decide: () => Promise<ReaperLogEntry>,
): Promise<ReaperLogEntry> {
  // This check and withFinishGuard's claim have no await between them, so the
  // pre-check cannot lose a race inside this call. The check after an awaited
  // status probe is the one that lets a concurrent client finish win.
  if (isFinishing(ctx, sessionID)) {
    return skippedBusy(sessionID, "another operation owns this session");
  }
  try {
    return await withFinishGuard(ctx, sessionID, decide);
  } catch (err) {
    // The claim is synchronous, so a StateError here is a rejected claim (or
    // the finish deadline): the session is owned elsewhere, so skip quietly.
    if (err instanceof StateError) {
      return skippedBusy(sessionID, err.message);
    }
    throw err;
  }
}

/**
 * Re-read the record under the finish claim. Returns null when another
 * operation changed the ownership or state that this decision was built on -
 * re-checked after acquiring the claim and after the status probe, before any
 * release.
 */
function releasableRecord(ctx: OpContext, record: SessionRecord): SessionRecord | null {
  if ((ctx.activeLocks?.get(record.sessionID) ?? 0) > 0) return null;
  const fresh = ctx.store.get(record.sessionID);
  if (!fresh) return null;
  if (fresh.state !== record.state) return null;
  if (fresh.workerName !== record.workerName) return null;
  if (fresh.workerState === "DESTROYED" || fresh.workerState === "FAILED") return null;
  return fresh;
}

/**
 * Release the worker of a terminal record (APPLIED/REJECTED/RETAINED/
 * FAILED_CLOSED). The session is finished, so there is no export to run; the
 * removal still takes the lifecycle claim AND the export proof (D3): the
 * worker's HEAD must equal the durable result tip and its tree must be clean.
 * A terminal state is never a licence to remove unexported edits - a worker
 * that cannot prove the export is KEPT for owner recovery.
 */
function releaseTerminalWorker(
  ctx: OpContext,
  record: SessionRecord,
): Promise<ReaperLogEntry> {
  return guardedRelease(ctx, record.sessionID, async () => {
    const fresh = releasableRecord(ctx, record);
    if (!fresh || !isTerminalState(fresh.state)) {
      return skippedBusy(record.sessionID, "another operation owns this session");
    }
    const outcome = await removeWorkerVerified(ctx, fresh);
    // A failed removal keeps the record for the next sweep; releaseWorker
    // already logged it. Never record DESTROYED without a confirmed release.
    if (!outcome.released) {
      if (outcome.proof.reason === "identity-changed" || outcome.proof.reason === "no-live-worker") {
        return skippedBusy(record.sessionID, "worker identity changed");
      }
      return {
        sessionID: record.sessionID,
        action: outcome.reason === "remove-failed" ? "error" : "release_skipped_dirty",
        detail: `${outcome.error ?? "removal not proven safe"}; worker retained`,
      };
    }
    ctx.store.touch(record.sessionID, {
      workerName: undefined,
      workerState: "DESTROYED",
      reapedAt: new Date().toISOString(),
    });
    return { sessionID: record.sessionID, action: "reaped_terminal" };
  });
}

/**
 * Retry the removal of a worker whose bootstrap cleanup was never confirmed
 * (T11 / C3). The narrow failed-bootstrap predicate needs no export proof (the
 * bootstrap never reached Git), but it still takes the lifecycle claim and
 * re-reads the record INSIDE it, so a concurrent finish/apply wins and this
 * pass skips. Identity and accounting stay owned until a CONFIRMED removal.
 */
function releaseFailedCleanupWorker(
  ctx: OpContext,
  record: SessionRecord,
): Promise<ReaperLogEntry> {
  return guardedRelease(ctx, record.sessionID, async () => {
    const fresh = ctx.store.get(record.sessionID);
    if (!fresh) return skippedBusy(record.sessionID, "session record disappeared");
    if (
      fresh.workerName !== record.workerName ||
      fresh.workerState !== "FAILED" ||
      fresh.state !== record.state
    ) {
      return skippedBusy(record.sessionID, "worker identity changed");
    }
    const outcome = await removeWorkerVerified(ctx, fresh);
    if (!outcome.released) {
      return {
        sessionID: record.sessionID,
        action: "error",
        detail: `${outcome.error ?? "worker removal failed"}; failed-cleanup worker retained`,
      };
    }
    ctx.store.touch(record.sessionID, {
      workerName: undefined,
      workerState: "DESTROYED",
      reapedAt: new Date().toISOString(),
    });
    return { sessionID: record.sessionID, action: "reaped_failed_cleanup" };
  });
}

/**
 * Release a live RESULT_READY worker through the SAME export-before-release
 * policy as finishOrReleaseActive. The status probe runs INSIDE the lifecycle
 * claim (D3/F3): a write that completes between a pre-claim probe and the claim
 * can no longer be released on a stale `clean` answer, and a client finish that
 * is exporting right now owns the claim, so this pass loses the race and skips.
 */
function releaseResultReadyWorker(
  ctx: OpContext,
  record: SessionRecord,
  cleanDetail: string,
  prepare: PrepareResult,
): Promise<ReaperLogEntry> {
  return guardedRelease(ctx, record.sessionID, () =>
    finishOrReleaseGuarded(ctx, record, cleanDetail, prepare, "RESULT_READY"),
  );
}

/**
 * Take a SANDBOX_ACTIVE worker away without losing its edits: every removal
 * goes through removeWorkerVerified, which exports once and re-proves, and
 * keeps the worker when the proof or the export fails.
 */
function finishOrReleaseActive(
  ctx: OpContext,
  record: SessionRecord,
  cleanDetail: string,
  prepare: PrepareResult,
): Promise<ReaperLogEntry> {
  // One lifecycle owner per session: the claim is taken before the status probe
  // and held through export, stop/remove and the state write.
  return guardedRelease(ctx, record.sessionID, () =>
    finishOrReleaseGuarded(ctx, record, cleanDetail, prepare, "SANDBOX_ACTIVE"),
  );
}

/**
 * The single export-before-release policy, run while the caller holds the
 * lifecycle claim. `fromState` only selects the reported action: the transition
 * to RESULT_READY (and the refreshed resultRef) is performed by
 * removeWorkerVerified when it exports. A result is never discarded on a guess.
 */
async function finishOrReleaseGuarded(
  ctx: OpContext,
  record: SessionRecord,
  cleanDetail: string,
  prepare: PrepareResult,
  fromState: ReleaseFromState,
): Promise<ReaperLogEntry> {
  const sessionID = record.sessionID;
  // Re-check AFTER the claim: the record may have moved while an await elapsed.
  const fresh = releasableRecord(ctx, record);
  if (!fresh) {
    return skippedBusy(sessionID, "another operation owns this session");
  }
  // Proof first: a worker whose HEAD already equals the durable exported tip and
  // whose tree is clean is released without touching it. Anything else from a
  // live ACTIVE/RESULT_READY session is exported once and re-proven; if the
  // export or the re-proof fails, the worker is KEPT (edits and allocation).
  const removal = await removeWorkerVerified(ctx, fresh, { exportFirst: true, prepare });
  if (removal.released) {
    ctx.store.touch(sessionID, {
      workerName: undefined,
      workerState: "DESTROYED",
      reapedAt: new Date().toISOString(),
    });
    if (removal.exported) {
      const ref = ctx.store.get(sessionID)?.resultRef ?? removal.proof.exportedCommit ?? "";
      return { sessionID, action: "auto_finished", detail: ref };
    }
    return {
      sessionID,
      action: fromState === "RESULT_READY" ? "reaped_result_ready" : "reaped_active",
      detail: cleanDetail,
    };
  }
  if (removal.exported) {
    // The edits are host-side (ref + bundle) and the record was updated, but
    // the worker survived: report it distinctly so it is never mistaken for a
    // fully-released worker.
    const ref = ctx.store.get(sessionID)?.resultRef ?? removal.proof.exportedCommit ?? "";
    return {
      sessionID,
      action: "auto_finished_retained",
      detail: `${ref} (worker retained for the next sweep)`,
    };
  }
  if (removal.reason === "remove-failed") {
    return {
      sessionID,
      action: "error",
      detail: "worker release failed; retained for the next sweep",
    };
  }
  if (removal.error?.startsWith("export before release failed")) {
    // The export itself failed: the worker is kept so the edits survive.
    return { sessionID, action: "error", detail: removal.error };
  }
  return {
    sessionID,
    action: "release_skipped_dirty",
    detail: `worker ${fresh.workerName} is not provably exported (${removal.proof.reason}); not released`,
  };
}

/**
 * Is the worker's /work tree clean? `true` = clean, `false` = dirty,
 * `undefined` = the status could not be read. Every caller treats anything but
 * `true` as dirty, so an unreadable worker is never released before its edits
 * are exported. The excludes are the broker's transfer artifacts; they are not
 * the session's edits. The single implementation now lives in service.ts so
 * the removal proof and the reaper can never disagree about cleanliness.
 */

/** Pressure telemetry; a logging failure must never change release or admission. */
function logPressure(
  ctx: OpContext,
  event: {
    action:
      | "pressure_occupancy"
      | "pressure_release"
      | "pressure_skipped"
      | "pressure_skipped_dirty"
      | "error";
    sessionID?: string;
    state?: SessionRecord["state"];
    detail?: string;
    phase?: "before" | "after";
    occupancy?: PoolOccupancySnapshot;
  },
): void {
  try {
    // Assign first: the snapshot carries fields beyond LogEntry, and these
    // structured extras are intentionally serialized into the JSONL entry.
    const entry = {
      operation: "reaper",
      result: event.action === "error" ? "error" : "ok",
      ...(event.occupancy ?? {}),
      action: event.action,
      sessionID: event.sessionID,
      state: event.state,
      detail: event.detail,
      phase: event.phase,
    };
    ctx.logger?.log?.(entry);
  } catch {
    // Telemetry must not change an admission or release outcome.
  }
}

/** The occupancy snapshot, or undefined when this context cannot describe it. */
function safeOccupancy(ctx: OpContext): PoolOccupancySnapshot | undefined {
  try {
    return describePoolOccupancy(ctx);
  } catch {
    return undefined;
  }
}

/**
 * Pressure release (T7): a request is about to park because the pool is full.
 * Give a slot back when that is provably safe. It never blind-releases
 * unexported edits:
 * - RESULT_READY with a live worker: released through the same
 *   export-before-release policy as finishOrReleaseActive - a clean worktree is
 *   released at once, a dirty one is re-exported first, and an unreadable
 *   status or a failed export keeps the worker. State and resultRef stay, so
 *   apply/preview/retain/discard keep working.
 * - SANDBOX_ACTIVE with a live worker: the same export-before-release policy
 *   as finishOrReleaseActive, under the lifecycle claim. A dirty ACTIVE worker
 *   is exported and re-verified BEFORE release, so its slot is given back only
 *   once the edits are host-side (D3 invariant 1); the export runs inside the
 *   pressure scan and is bounded by the adapter's own exec timeouts. An
 *   unreadable status is never exported blind, and a failed export or a failed
 *   re-proof keeps the worker, its edits and its allocation
 *   (`pressure_skipped_dirty`). A worker whose lifecycle claim is already held
 *   is skipped (`release_skipped_busy`).
 * Every live-worker release takes the finish guard, so the interval sweep and a
 * client finish of the same session can never stop/remove the same worker twice
 * or tear one down mid-export; the losing pass skips and logs.
 * Never touched: the requesting session, APPLY_PENDING, CREATING_SANDBOX,
 * sessions parked in the pool queue, sessions with an operation in flight and
 * sessions whose finish is running.
 *
 * The occupancy snapshot is logged before and after the pass, plus one line
 * per released or skipped session. Best-effort by construction: it returns
 * counts and never throws into an admission path.
 */
export async function releaseUnderPressure(
  ctx: OpContext,
  exceptSessionID?: string,
  prepare: PrepareResult = runPrepare,
): Promise<{ released: number; skipped: number }> {
  let released = 0;
  let skipped = 0;
  logPressure(ctx, {
    action: "pressure_occupancy",
    phase: "before",
    occupancy: safeOccupancy(ctx),
  });
  for (const record of ctx.store.list()) {
    try {
      const sessionID = record.sessionID;
      const skip = (detail: string, dirty = false): void => {
        skipped++;
        logPressure(ctx, {
          action: dirty ? "pressure_skipped_dirty" : "pressure_skipped",
          sessionID,
          state: record.state,
          detail,
        });
      };
      const hasLiveWorker =
        !!record.workerName &&
        record.workerState !== "DESTROYED" &&
        record.workerState !== "FAILED";
      // No worker -> not a candidate; a parked session is normal, not a skip.
      if (!hasLiveWorker) continue;
      if (sessionID === exceptSessionID) {
        skip("requesting session");
        continue;
      }
      if (record.state === "APPLY_PENDING") {
        skip("APPLY_PENDING (waiting on the user)");
        continue;
      }
      if (record.state === "CREATING_SANDBOX") {
        skip("CREATING_SANDBOX (mid-creation)");
        continue;
      }
      if (record.state !== "RESULT_READY" && record.state !== "SANDBOX_ACTIVE") {
        skip(`state ${record.state} is not releasable under pressure`);
        continue;
      }
      if (ctx.queue?.find(sessionID)) {
        skip("parked in the pool queue");
        continue;
      }
      if ((ctx.activeLocks?.get(sessionID) ?? 0) > 0) {
        skip("an operation is in flight");
        continue;
      }
      if (isFinishing(ctx, sessionID)) {
        skip("a finish is in flight");
        continue;
      }
      if (record.state === "RESULT_READY") {
        // Same export-before-release policy as finishOrReleaseActive: a dirty
        // live RESULT_READY is re-exported before its worker is given back, and
        // an unreadable status or a failed export keeps the worker. The release
        // takes the finish guard, so a client finish that is exporting right
        // now always wins and this pass never removes a worker mid-export.
        const entry = await releaseResultReadyWorker(
          ctx,
          record,
          "result already host-side",
          prepare,
        );
        if (entry.action === "reaped_result_ready" || entry.action === "auto_finished") {
          released++;
          logPressure(ctx, {
            action: "pressure_release",
            sessionID,
            state: "RESULT_READY",
            detail: entry.detail ?? "result already host-side",
          });
        } else {
          skip(
            entry.detail ?? "worker retained",
            entry.action === "release_skipped_dirty",
          );
        }
        continue;
      }
      // SANDBOX_ACTIVE: the same export-before-release policy as
      // finishOrReleaseActive, under the lifecycle claim. A dirty or unreadable
      // worker is exported and re-proven first; if the proof or the export
      // fails the worker is KEPT (`pressure_skipped_dirty`).
      const entry = await finishOrReleaseActive(
        ctx,
        record,
        "clean worktree",
        prepare,
      );
      if (entry.action === "reaped_active" || entry.action === "auto_finished") {
        released++;
        logPressure(ctx, {
          action: "pressure_release",
          sessionID,
          state: "SANDBOX_ACTIVE",
          detail: entry.action === "auto_finished" ? "exported before release" : "clean worktree",
        });
      } else {
        skip(
          entry.detail ?? "worker retained",
          entry.action === "release_skipped_dirty" ||
            /export before release failed/.test(entry.detail ?? ""),
        );
      }
    } catch (err) {
      skipped++;
      logPressure(ctx, {
        action: "error",
        sessionID: record.sessionID,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  logPressure(ctx, {
    action: "pressure_occupancy",
    phase: "after",
    occupancy: safeOccupancy(ctx),
  });
  return { released, skipped };
}

/**
 * Auto-finish guard: if a session ends with SANDBOX_ACTIVE and has unstaged
 * changes and no recent activity (>60s), automatically call runPrepare to
 * export to RESULT_READY (same as sandbox_finish) so S17 workers don't need
 * explicit finish.
 *
 * Checks: SANDBOX_ACTIVE, worker ACTIVE, no resultRef, idle >60s -> runPrepare -> RESULT_READY
 * Wired into periodic sweep; existing reaper is kept.
 */
export async function sweepUnfinished(
  ctx: OpContext,
  idleMs = 60_000,
  onLog?: (entry: ReaperLogEntry) => void,
  onDrop?: ReaperOptions["onDrop"],
  prepare: PrepareResult = runPrepare,
): Promise<{ finished: number }> {
  const now = Date.now();
  let finished = 0;
  for (const record of ctx.store.list()) {
    try {
      // Skip truly-not-idle: parked, waiting for permission, or exec in-flight
      if (ctx.queue?.find(record.sessionID)) continue;
      if (record.state === "APPLY_PENDING") continue;
      if ((ctx.activeLocks?.get(record.sessionID) ?? 0) > 0) continue;
      if (isFinishing(ctx, record.sessionID)) continue;
      if (record.state !== "SANDBOX_ACTIVE") continue;
      if (!record.workerName) continue;
      if (record.workerState !== "ACTIVE") continue;
      if (record.resultRef) continue;
      if (record.workerState === "DESTROYED" || record.workerState === "FAILED") continue;
      const age = now - Date.parse(record.updatedAt);
      if (!(age > idleMs)) continue;
      const entry = await finishOrReleaseActive(ctx, record, "idle clean worker released", prepare);
      safeLog(onLog, entry, onDrop);
      // A failed release (action "error") must NOT count as finished: the
      // session still holds its worker and the sweep must retry it. An export
      // that landed DOES finish the session (RESULT_READY), even when the
      // worker could not be removed yet (auto_finished_retained).
      if (entry.action !== "error") finished++;
    } catch (err) {
      safeLog(onLog, {
        sessionID: record.sessionID,
        action: "error",
        detail: err instanceof Error ? err.message : String(err),
      }, onDrop);
    }
  }
  return { finished };
}

/**
 * Disconnect-triggered reap (Feature 2b): a single SANDBOX_ACTIVE session
 * that lost its client socket and has been idle longer than disconnectIdleMs
 * gives its worker back early. It applies the same export-before-release
 * policy as sweepUnfinished, so a disconnect never discards unexported edits,
 * and it skips a session with an operation in flight or parked in the queue.
 * Returns true when the worker was released. Used by server onSocketClose;
 * the periodic sweeps remain the safety net.
 */
export async function reapOnDisconnect(
  ctx: OpContext,
  sessionID: string,
  disconnectIdleMs: number,
  onLog?: (entry: ReaperLogEntry) => void,
  onDrop?: ReaperOptions["onDrop"],
  prepare: PrepareResult = runPrepare,
): Promise<boolean> {
  const record = ctx.store.get(sessionID);
  if (!record) return false;
  if (ctx.queue?.find(sessionID)) return false;
  if ((ctx.activeLocks?.get(sessionID) ?? 0) > 0) return false;
  if (isFinishing(ctx, sessionID)) return false;
  if (record.state !== "SANDBOX_ACTIVE") return false;
  // A resultRef no longer excludes the reap: a clean worker whose HEAD equals
  // the durable exported tip is provably safe to give back, and anything else
  // is exported (or kept) by the shared policy below.
  if (!record.workerName) return false;
  if (record.workerState === "DESTROYED" || record.workerState === "FAILED") return false;
  const age = Date.now() - Date.parse(record.updatedAt);
  if (!(age > disconnectIdleMs)) return false;
  try {
    const entry = await finishOrReleaseActive(ctx, record, "client disconnected", prepare);
    safeLog(onLog, entry, onDrop);
    // True only when the worker was actually given back: an export that landed
    // but kept the worker (auto_finished_retained) or a failed proof is false.
    return entry.action === "reaped_active" || entry.action === "auto_finished";
  } catch (err) {
    safeLog(onLog, {
      sessionID,
      action: "error",
      detail: err instanceof Error ? err.message : String(err),
    }, onDrop);
    return false;
  }
}
