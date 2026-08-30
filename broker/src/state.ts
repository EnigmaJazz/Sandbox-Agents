/**
 * Per-session state machine (SYSTEM_PROMPT.md §10) with atomic JSON
 * persistence that survives broker restarts.
 *
 * - State is ALWAYS read from the persisted record; it is never inferred from
 *   a worker name (§10).
 * - Every transition is validated against the legal graph; an illegal
 *   transition throws (fail closed, S14).
 * - Corrupt/unreadable state files throw StateCorruptionError — the caller
 *   must fail the operation, never guess (§10, S14).
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  existsSync,
  readdirSync,
  rmSync,
  unlinkSync,
  openSync,
  fsyncSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionRecord, SessionState } from "./types.ts";

export class StateError extends Error {
  readonly code = "state" as const;
  constructor(message: string) {
    super(message);
    this.name = "StateError";
  }
}

export class StateCorruptionError extends StateError {
  constructor(sessionID: string, detail: string) {
    super(`corrupt state file for session ${sessionID}: ${detail}`);
  }
}

/** Legal transition graph (§10). */
export const LEGAL_TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  HOST_READ_ONLY: ["CREATING_SANDBOX"],
  CREATING_SANDBOX: ["SANDBOX_ACTIVE", "FAILED_CLOSED", "HOST_READ_ONLY"],
  SANDBOX_ACTIVE: ["CREATING_SANDBOX", "RESULT_READY", "FAILED_CLOSED", "RETAINED"],
  // RESULT_READY -> CREATING_SANDBOX: the idle reaper releases the worker of
  // a finished-but-unapplied session; ensureWorker must be able to rebuild it
  // on demand without losing the result (Feature 1).
  RESULT_READY: ["APPLY_PENDING", "REJECTED", "RETAINED", "SANDBOX_ACTIVE", "CREATING_SANDBOX"],
  APPLY_PENDING: ["APPLIED", "FAILED_CLOSED", "RESULT_READY"],
  APPLIED: ["RETAINED"],
  REJECTED: [],
  RETAINED: ["RESULT_READY"],
  FAILED_CLOSED: [],
};

export function assertLegalTransition(from: SessionState, to: SessionState): void {
  if (!LEGAL_TRANSITIONS[from]?.includes(to)) {
    throw new StateError(`illegal state transition ${from} -> ${to}`);
  }
}

const SESSIONS_DIR = "sessions";
const TMP_DIR = "tmp";

export interface SessionStoreOptions {
  /** Test seam: clock provider. */
  now?: () => Date;
}

export class SessionStore {
  private readonly sessionsDir: string;
  private readonly tmpDir: string;
  private readonly now: () => Date;

  constructor(private readonly stateDir: string, opts: SessionStoreOptions = {}) {
    this.sessionsDir = join(stateDir, SESSIONS_DIR);
    this.tmpDir = join(stateDir, TMP_DIR);
    this.now = opts.now ?? (() => new Date());
    mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.tmpDir, { recursive: true, mode: 0o700 });
  }

  private recordPath(sessionID: string): string {
    return join(this.sessionsDir, `${sessionID}.json`);
  }

  /** Load a session record. Missing file -> undefined. Corrupt file -> throw. */
  get(sessionID: string): SessionRecord | undefined {
    const p = this.recordPath(sessionID);
    if (!existsSync(p)) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(p, "utf8"));
    } catch (err) {
      throw new StateCorruptionError(sessionID, err instanceof Error ? err.message : String(err));
    }
    if (!isSessionRecord(parsed)) {
      throw new StateCorruptionError(sessionID, "shape validation failed");
    }
    return parsed;
  }

  /** All persisted sessions (broker restart recovery). */
  list(): SessionRecord[] {
    const out: SessionRecord[] = [];
    for (const f of readdirSync(this.sessionsDir)) {
      if (!f.endsWith(".json")) continue;
      const sessionID = f.slice(0, -".json".length);
      const rec = this.get(sessionID); // may throw on corruption — fail closed at startup
      if (rec) out.push(rec);
    }
    return out;
  }

  /** Atomic write: temp file + fsync + rename. Never partial JSON on disk. */
  private persist(record: SessionRecord): void {
    const tmp = join(this.tmpDir, `${record.sessionID}.${randomUUID()}.tmp`);
    const data = JSON.stringify(record, null, 2);
    writeFileSync(tmp, data, { mode: 0o600, flag: "w" });
    try {
      const fd = openSyncForSync(tmp);
      if (fd !== null) fdSync(fd);
      renameSync(tmp, this.recordPath(record.sessionID));
    } finally {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        /* best effort */
      }
    }
  }

  /** Create or return an existing record for a session. */
  touch(sessionID: string, patch: Partial<SessionRecord> = {}): SessionRecord {
    const existing = this.get(sessionID);
    const nowIso = this.now().toISOString();
    const record: SessionRecord = existing
      ? { ...existing, ...patch, updatedAt: nowIso }
      : {
          sessionID,
          state: "HOST_READ_ONLY",
          createdAt: nowIso,
          updatedAt: nowIso,
          ...patch,
        };
    this.persist(record);
    return record;
  }

  /**
   * Validated transition: throws StateError on illegal transitions or when
   * the record's current state does not match `from`.
   */
  transition(
    sessionID: string,
    from: SessionState,
    to: SessionState,
    patch: Partial<SessionRecord> = {},
  ): SessionRecord {
    const record = this.get(sessionID);
    if (!record) {
      throw new StateError(`no session record for ${sessionID}`);
    }
    if (record.state !== from) {
      throw new StateError(
        `session ${sessionID} is in state ${record.state}, expected ${from} to transition to ${to}`,
      );
    }
    assertLegalTransition(from, to);
    const nowIso = this.now().toISOString();
    const next: SessionRecord = {
      ...record,
      ...patch,
      state: to,
      updatedAt: nowIso,
    };
    this.persist(next);
    return next;
  }

  /** Remove all persisted state for a session (REJECT path, §20). */
  remove(sessionID: string): void {
    const p = this.recordPath(sessionID);
    if (existsSync(p)) rmSync(p, { force: true });
  }
}

function openSyncForSync(p: string): number | null {
  try {
    return openSync(p, "r");
  } catch {
    return null;
  }
}

function fdSync(fd: number): void {
  try {
    fsyncSync(fd);
  } catch {
    /* best effort */
  }
}

function isSessionRecord(v: unknown): v is SessionRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.sessionID !== "string" || typeof r.state !== "string") return false;
  return typeof r.createdAt === "string" && typeof r.updatedAt === "string";
}
