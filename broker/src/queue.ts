/**
 * FIFO pending queue for pool-exhausted ensureWorker requests (Feature 2).
 *
 * When the worker pool is exhausted, ensureWorker parks instead of failing:
 * the request stays open on the socket until a slot frees (drained by
 * releaseWorker), times out (queued_timed_out), or the client disconnects.
 *
 * Invariants:
 * - FIFO admission: drainQueue admits the head first, never skipping.
 * - One entry per sessionID (double-parks share the same pending result).
 * - `inFlight` counts entries admitted by the drain whose allocation has not
 *   been pushed into the pool yet, so admission checks can reserve their
 *   budget and never oversubscribe the pool.
 */
import { PolicyError } from "./policy.ts";
import type { BrokerRequestEnvelope } from "./types.ts";

/** Typed timeout error: the parked request waited longer than queueTimeoutMs. */
export class QueuedTimedOutError extends PolicyError {
  readonly code = "queued_timed_out" as const;
  constructor(message: string) {
    super(message);
    this.name = "QueuedTimedOutError";
  }
}

export interface QueuedEntry {
  sessionID: string;
  /** Original request — the drain re-runs the full creation path with it. */
  request: BrokerRequestEnvelope;
  projectID: string;
  /** FIFO position at enqueue time (1-based); reported to the client. */
  position: number;
  pending: Promise<unknown>;
  resolve(result: unknown): void;
  reject(err: unknown): void;
  timer?: ReturnType<typeof setTimeout>;
}

export class PendingQueue {
  private readonly entries: QueuedEntry[] = [];

  /**
   * Creations admitted by the drain that have not pushed their allocation
   * into the pool yet. Admission checks add this as virtual allocations so a
   * direct ensureWorker cannot slip into a slot the drain already promised.
   */
  inFlight = 0;

  get length(): number {
    return this.entries.length;
  }

  enqueue(entry: QueuedEntry): void {
    entry.position = this.entries.length + 1;
    this.entries.push(entry);
  }

  find(sessionID: string): QueuedEntry | undefined {
    return this.entries.find((e) => e.sessionID === sessionID);
  }

  /** FIFO head, or undefined when empty. */
  head(): QueuedEntry | undefined {
    return this.entries[0];
  }

  remove(sessionID: string): QueuedEntry | undefined {
    const i = this.entries.findIndex((e) => e.sessionID === sessionID);
    if (i === -1) return undefined;
    return this.entries.splice(i, 1)[0];
  }

  /** Remove a parked entry and reject it (disconnect cleanup, timers). Frees the queue slot; caller should drainQueue. */
  cancel(sessionID: string, message: string): QueuedEntry | undefined {
    const entry = this.remove(sessionID);
    if (!entry) return undefined;
    if (entry.timer) clearTimeout(entry.timer);
    entry.reject(new PolicyError(message));
    // FIFO entry removed and queue slot freed; drainQueue will admit next head if pool allows (called by server onSocketClose / releaseWorker).
    return entry;
  }
}
