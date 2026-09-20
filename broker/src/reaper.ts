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
 * - RESULT_READY  + stale -> release worker + allocation, CLEAR workerName,
 *   record reapedAt. State stays RESULT_READY: the result is already on the
 *   host side (git ref + bundle), so apply/preview/retain/discard still work.
 *   A later ensureWorker re-creates the worker on demand.
 * - SANDBOX_ACTIVE + stale -> release worker + allocation, transition to
 *   FAILED_CLOSED with reason "idle reaped" (crash-leak recovery).
 * - Everything else is skipped: parked queue sessions have no worker yet,
 *   CREATING_SANDBOX is mid-creation, and DESTROYED/FAILED workers are gone.
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
import { statSync } from "node:fs";
import {
  durableHostRefResolves,
  listOrphanArtifactCandidates,
  removeArtifact,
  removalNeedsDurableRef,
  removeSessionArtifacts,
  shouldRemoveSessionArtifacts,
  type ArtifactRemoval,
} from "./artifacts.ts";
import { releaseWorker, runPrepare, type OpContext } from "./service.ts";
import { isTerminalState } from "./state.ts";

export interface ReaperLogEntry {
  sessionID: string;
  action:
    | "reaped_result_ready"
    | "reaped_active"
    | "auto_finished"
    | "swept_artifact"
    | "error";
  detail?: string;
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
  onLog?: (entry: ReaperLogEntry) => void;
}

export interface ReaperHandle {
  stop(): void;
}

/** Default grace before a terminal/orphan transport artifact is removed. */
export const DEFAULT_ARTIFACT_GRACE_MS = 3_600_000;

/**
 * Log the removals for one session: session id, artifact kind, and bytes
 * freed (or the failure). Best-effort by construction - the removals were
 * already attempted and never throw.
 */
function logRemovals(
  sessionID: string,
  removals: ArtifactRemoval[],
  onLog?: (entry: ReaperLogEntry) => void,
): { removed: number; bytesFreed: number } {
  let removed = 0;
  let bytesFreed = 0;
  for (const r of removals) {
    if (r.removed) {
      removed++;
      bytesFreed += r.bytes;
      onLog?.({
        sessionID,
        action: "swept_artifact",
        detail: `${r.kind} ${r.bytes} bytes ${r.path}`,
      });
    } else if (r.error) {
      onLog?.({
        sessionID,
        action: "error",
        detail: `${r.kind}: ${r.error}`,
      });
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
): Promise<void> {
  const stateDir = ctx.config?.stateDir;
  if (!stateDir) return;
  try {
    const record = ctx.store.get(sessionID);
    if (!record) return;
    let durable = false;
    if (removalNeedsDurableRef(record)) {
      durable = await durableHostRefResolves(ctx, record);
    }
    if (!shouldRemoveSessionArtifacts(record, durable)) return;
    logRemovals(sessionID, removeSessionArtifacts(stateDir, sessionID), onLog);
  } catch (err) {
    onLog?.({
      sessionID,
      action: "error",
      detail: err instanceof Error ? err.message : String(err),
    });
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
      let durable = false;
      if (removalNeedsDurableRef(record)) {
        durable = await durableHostRefResolves(ctx, record);
      }
      if (!shouldRemoveSessionArtifacts(record, durable)) continue;
      const result = logRemovals(
        record.sessionID,
        removeSessionArtifacts(ctx.config.stateDir, record.sessionID),
        onLog,
      );
      removed += result.removed;
      bytesFreed += result.bytesFreed;
    } catch (err) {
      onLog?.({
        sessionID: record.sessionID,
        action: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
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
      );
      removed += result.removed;
      bytesFreed += result.bytesFreed;
    } catch (err) {
      onLog?.({
        sessionID,
        action: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
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
): Promise<{ removed: number; bytesFreed: number }> {
  try {
    return await sweepStateArtifacts(ctx, graceMs, onLog);
  } catch (err) {
    onLog?.({
      sessionID: "",
      action: "error",
      detail: err instanceof Error ? err.message : String(err),
    });
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
  );
  const timer = setInterval(() => {
    void runReaperSweeps(ctx, opts);
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
    opts.onLog?.({
      sessionID: "",
      action: "error",
      detail: err instanceof Error ? err.message : String(err),
    });
  try {
    await sweepStateArtifacts(
      ctx,
      opts.artifactGraceMs ?? DEFAULT_ARTIFACT_GRACE_MS,
      opts.onLog,
    );
  } catch (err) {
    logError(err);
  }
  try {
    await sweepUnfinished(ctx, 60_000, opts.onLog);
  } catch (err) {
    logError(err);
  }
  try {
    await sweepIdle(ctx, opts.idleMs, opts.onLog);
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
): Promise<{ reaped: number }> {
  const now = Date.now();
  let reaped = 0;
  for (const record of ctx.store.list()) {
    try {
      // Skip truly-not-idle: parked in queue, waiting for permission, or exec in-flight
      if (ctx.queue?.find(record.sessionID)) continue;
      if (record.state === "APPLY_PENDING") continue;
      if ((ctx.activeLocks?.get(record.sessionID) ?? 0) > 0) continue;
      // No worker -> nothing to release (includes sessions parked in the pool
      // queue: they never transitioned past HOST_READ_ONLY). DESTROYED/FAILED
      // workers were already released.
      if (!record.workerName) continue;
      if (record.workerState === "DESTROYED" || record.workerState === "FAILED") continue;
      const age = now - Date.parse(record.updatedAt);
      // NaN-safe: an unparseable timestamp is never "stale enough" to reap.
      if (!(age > idleMs)) continue;

      if (record.state === "RESULT_READY") {
        // The result lives on the host (ref + bundle): release the transient
        // worker but KEEP the state so apply/preview/retain/discard work.
        await releaseWorker(ctx, record);
        ctx.store.touch(record.sessionID, {
          workerName: undefined,
          workerState: "DESTROYED",
          reapedAt: new Date(now).toISOString(),
        });
        onLog?.({ sessionID: record.sessionID, action: "reaped_result_ready" });
        reaped++;
      } else if (record.state === "SANDBOX_ACTIVE") {
        await releaseWorker(ctx, record);
        ctx.store.transition(record.sessionID, "SANDBOX_ACTIVE", "FAILED_CLOSED", {
          workerName: undefined,
          workerState: "DESTROYED",
          error: "idle reaped",
          reapedAt: new Date(now).toISOString(),
        });
        // Terminal: the transport artifacts are consumed (durability-gated).
        await cleanupTerminalArtifacts(ctx, record.sessionID, onLog);
        onLog?.({ sessionID: record.sessionID, action: "reaped_active" });
        reaped++;
      }
      // Any other state: skip. CREATING_SANDBOX is mid-creation and must
      // never be reaped; APPLIED/REJECTED/RETAINED/FAILED_CLOSED have no live
      // worker the sweep should touch.
    } catch (err) {
      // One bad record must not kill the whole sweep.
      onLog?.({
        sessionID: record.sessionID,
        action: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { reaped };
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
): Promise<{ finished: number }> {
  const now = Date.now();
  let finished = 0;
  for (const record of ctx.store.list()) {
    try {
      // Skip truly-not-idle: parked, waiting for permission, or exec in-flight
      if (ctx.queue?.find(record.sessionID)) continue;
      if (record.state === "APPLY_PENDING") continue;
      if ((ctx.activeLocks?.get(record.sessionID) ?? 0) > 0) continue;
      if (record.state !== "SANDBOX_ACTIVE") continue;
      if (!record.workerName) continue;
      if (record.workerState !== "ACTIVE") continue;
      if (record.resultRef) continue;
      if (record.workerState === "DESTROYED" || record.workerState === "FAILED") continue;
      const age = now - Date.parse(record.updatedAt);
      if (!(age > idleMs)) continue;
      // Has unstaged changes check: query worker git status --porcelain.
      // If no changes, release and fail closed (nothing to export).
      let hasChanges = true;
      try {
        const status = await ctx.adapter.exec(record.workerName, ["git", "status", "--porcelain", "--", ".", ":(exclude).broker-tmp", ":(exclude)*.bundle"], {
          cwd: "/work",
          timeoutMs: 30_000,
          env: {
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "safe.directory",
            GIT_CONFIG_VALUE_0: "/work",
          },
        });
        if (status.status === 0) {
          hasChanges = status.stdout.trim().length > 0;
        }
      } catch {
        hasChanges = true;
      }
      if (!hasChanges) {
        await releaseWorker(ctx, record);
        ctx.store.transition(record.sessionID, "SANDBOX_ACTIVE", "FAILED_CLOSED", {
          workerName: undefined,
          workerState: "DESTROYED",
          error: "idle clean worker released",
          reapedAt: new Date(now).toISOString(),
        });
        // Terminal: the transport artifacts are consumed (durability-gated).
        await cleanupTerminalArtifacts(ctx, record.sessionID, onLog);
        onLog?.({ sessionID: record.sessionID, action: "reaped_active", detail: "idle clean worker released" });
        finished++;
        continue;
      }
      const ref = await runPrepare(ctx, record.sessionID);
      await releaseWorker(ctx, record);
      ctx.store.transition(record.sessionID, "SANDBOX_ACTIVE", "RESULT_READY", {
        resultRef: ref,
        workerName: undefined,
        workerState: "DESTROYED",
      });
      onLog?.({ sessionID: record.sessionID, action: "auto_finished", detail: ref });
      finished++;
    } catch (err) {
      onLog?.({
        sessionID: record.sessionID,
        action: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { finished };
}

/**
 * Disconnect-triggered reap (Feature 2b): reap a single SANDBOX_ACTIVE
 * session that lost its client socket and has been idle longer than
 * disconnectIdleMs with no result. Used by server onSocketClose; the
 * periodic sweepIdle (1h) remains as safety net.
 */
export async function reapOnDisconnect(
  ctx: OpContext,
  sessionID: string,
  disconnectIdleMs: number,
  onLog?: (entry: ReaperLogEntry) => void,
): Promise<boolean> {
  const record = ctx.store.get(sessionID);
  if (!record) return false;
  if (record.state !== "SANDBOX_ACTIVE") return false;
  if (record.resultRef) return false;
  if (!record.workerName) return false;
  if (record.workerState === "DESTROYED" || record.workerState === "FAILED") return false;
  const age = Date.now() - Date.parse(record.updatedAt);
  if (!(age > disconnectIdleMs)) return false;
  try {
    await releaseWorker(ctx, record);
    ctx.store.transition(sessionID, "SANDBOX_ACTIVE", "FAILED_CLOSED", {
      workerName: undefined,
      workerState: "DESTROYED",
      error: "client disconnected",
      reapedAt: new Date().toISOString(),
    });
    // Terminal: the transport artifacts are consumed (durability-gated).
    await cleanupTerminalArtifacts(ctx, sessionID, onLog);
    onLog?.({ sessionID, action: "reaped_active", detail: "client disconnected" });
    return true;
  } catch (err) {
    onLog?.({
      sessionID,
      action: "error",
      detail: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
