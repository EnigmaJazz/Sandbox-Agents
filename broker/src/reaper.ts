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
 */
import { releaseWorker, runPrepare, type OpContext } from "./service.ts";

export interface ReaperLogEntry {
  sessionID: string;
  action: "reaped_result_ready" | "reaped_active" | "auto_finished" | "error";
  detail?: string;
}

export interface ReaperOptions {
  /** Sweep interval in ms (default 60_000). */
  intervalMs: number;
  /** Release workers whose record is older than this, in ms (default 3_600_000). */
  idleMs: number;
  onLog?: (entry: ReaperLogEntry) => void;
}

export interface ReaperHandle {
  stop(): void;
}

/** Run the interval loop; returns a handle that stops it. */
export function startReaper(ctx: OpContext, opts: ReaperOptions): ReaperHandle {
  const timer = setInterval(() => {
    void (async () => {
      try {
        await sweepUnfinished(ctx, 60_000, opts.onLog);
      } catch (err) {
        opts.onLog?.({
          sessionID: "",
          action: "error",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        await sweepIdle(ctx, opts.idleMs, opts.onLog);
      } catch (err) {
        opts.onLog?.({
          sessionID: "",
          action: "error",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }, opts.intervalMs);
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  return { stop: () => clearInterval(timer) };
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
      // If no changes, skip auto-finish (nothing to export).
      let hasChanges = true;
      try {
        const status = await ctx.adapter.exec(record.workerName, ["git", "status", "--porcelain"], {
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
          if (!hasChanges) continue;
        }
      } catch {
        hasChanges = true;
      }
      if (!hasChanges) continue;
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
    ctx.store.transition(record.sessionID, "SANDBOX_ACTIVE", "FAILED_CLOSED", {
      workerName: undefined,
      workerState: "DESTROYED",
      error: "client disconnected",
      reapedAt: new Date().toISOString(),
    });
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
