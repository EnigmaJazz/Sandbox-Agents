/**
 * Broker-owned private store for review-run artifacts (ODD
 * review-run-foundation, slice U1b-1). Deliberately NOT a model-facing tool:
 * no host tool routes here yet.
 *
 * Properties this module enforces:
 * - 2 (broker side): a store root is refused when it sits inside the project
 *   root, inside $TMPDIR, or under an operator-denied prefix — each by
 *   canonical containment, never a bare prefix string. Confinement of the
 *   writing agent is the nono profile's property, proven by the operator probe
 *   in docs/review-run-store.md; the broker does NOT assert it from inside.
 * - 5: run metadata (session, evidence object ids, per-artifact digests) is
 *   persisted through the same atomic publisher as any other artifact.
 * - 6: per-run and per-file byte caps plus a per-session run quota, enforced
 *   BEFORE publication; an over-cap input is a named refusal, never truncated.
 * - 7: atomic publication — a sibling temp file opened O_EXCL, fsync, rename,
 *   directory fsync; a failed publication leaves no artifact and no temp file.
 *
 * Security style (§30): explicit types, allowlist grammar for every id, caller
 * input validated but never sanitized, canonical-path checks, fail closed.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { SESSION_ID_RE } from "./validation.ts";

/** The only accepted runId shape: 32 lowercase hex chars (128 random bits). */
export const REVIEW_RUN_ID_RE = /^[0-9a-f]{32}$/;
/** Git object/tree ids: full sha1 (40) or sha256 (64), lowercase hex. */
const REVIEW_RUN_OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Artifact names: one bounded, separator-free path segment. */
const REVIEW_RUN_ARTIFACT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Persisted run record name inside a run directory. */
export const REVIEW_RUN_METADATA_NAME = "metadata.json";

export interface ReviewRunCaps {
  /** Whole-run byte cap, checked against the run total before publication. */
  maxBytes: number;
  /** Single-artifact byte cap; exactly-at-cap is accepted, one over refused. */
  maxFileBytes: number;
  /** Maximum runs that may exist for one session. */
  maxPerSession: number;
}

export const DEFAULT_REVIEW_RUN_CAPS: ReviewRunCaps = Object.freeze({
  maxBytes: 8 * 1024 * 1024,
  maxFileBytes: 4 * 1024 * 1024,
  maxPerSession: 8,
});

export type ReviewRunState = "publishing" | "published" | "failed";

export interface ReviewRunArtifact {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ReviewRunRecord {
  runId: string;
  sessionID: string;
  createdAt: string;
  state: ReviewRunState;
  baseObjectId: string | null;
  headObjectId: string | null;
  artifacts: ReviewRunArtifact[];
}

export interface ReviewRunEvidence {
  baseObjectId?: string;
  headObjectId?: string;
}

export interface ReviewRunStoreOptions {
  /** Store root; defaults are wired from broker config in config.ts. */
  root: string;
  /** Canonical project root the store must stay outside of. */
  projectRoot: string;
  /** Operator mirror of agent-writable prefixes; refused when containing root. */
  deniedPrefixes?: readonly string[];
  caps?: Partial<ReviewRunCaps>;
}

/** Base for every refusal this module raises; `name` is the concrete class. */
export class ReviewRunError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
export class ReviewRunIdError extends ReviewRunError {
  constructor(message: string) {
    super("review_run_id", message);
  }
}
export class ReviewRunSessionError extends ReviewRunError {
  constructor(message: string) {
    super("review_run_session", message);
  }
}
export class ReviewRunEvidenceError extends ReviewRunError {
  constructor(message: string) {
    super("review_run_evidence", message);
  }
}
export class ReviewRunStoreInProjectError extends ReviewRunError {
  constructor(message: string) {
    super("review_run_store_in_project", message);
  }
}
export class ReviewRunStoreInTmpError extends ReviewRunError {
  constructor(message: string) {
    super("review_run_store_in_tmp", message);
  }
}
export class ReviewRunStoreDeniedPrefixError extends ReviewRunError {
  constructor(message: string) {
    super("review_run_store_denied_prefix", message);
  }
}
export class ReviewRunFileCapError extends ReviewRunError {
  constructor(message: string) {
    super("review_run_file_cap", message);
  }
}
export class ReviewRunCapError extends ReviewRunError {
  constructor(message: string) {
    super("review_run_byte_cap", message);
  }
}
export class ReviewRunQuotaError extends ReviewRunError {
  constructor(message: string) {
    super("review_run_quota", message);
  }
}

/** Bounded, control-character-free rendering of hostile input for messages. */
function show(value: unknown): string {
  if (typeof value !== "string") return value === null ? "null" : typeof value;
  const bounded = value.slice(0, 64);
  return value.length > 64 ? `${JSON.stringify(bounded)}...` : JSON.stringify(bounded);
}

/**
 * Canonicalize a path that may not exist yet: realpath the nearest existing
 * ancestor and rejoin the unresolved remainder. An unresolvable filesystem
 * root degrades to the lexical resolve — never to a shorter prefix that could
 * make containment checks lie.
 */
function canonicalForContainment(path: string): string {
  let current = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : join(real, ...tail);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

/** Boundary-aware containment on already-canonical paths (exported isWithin). */
function contains(parent: string, child: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** Broker-generated, unpredictable run id (128 bits, 32 lowercase hex). */
export function generateRunId(): string {
  return randomBytes(16).toString("hex");
}

/** Reject any runId that is not exactly REVIEW_RUN_ID_RE — never sanitize. */
export function assertReviewRunId(runId: unknown): asserts runId is string {
  if (typeof runId !== "string" || !REVIEW_RUN_ID_RE.test(runId)) {
    throw new ReviewRunIdError(
      `review run id must be exactly 32 lowercase hex characters (got ${show(runId)})`,
    );
  }
}

export function assertReviewRunArtifactName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !REVIEW_RUN_ARTIFACT_NAME_RE.test(name)) {
    throw new ReviewRunError(
      "review_run_artifact_name",
      `review run artifact name must be one bounded [A-Za-z0-9._-] segment (got ${show(name)})`,
    );
  }
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** mkdir (recursive) then chmod, so modes hold regardless of the umask. */
function ensureOwnedDir(path: string, mode: number): void {
  mkdirSync(path, { recursive: true, mode });
  chmodSync(path, mode);
}

function fsyncDirectory(dir: string): void {
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface PublishArtifactOptions {
  /**
   * Test seam: runs after the temp file is written+fsynced and immediately
   * before the rename, so a test can drive the failure path deterministically.
   * Production callers never pass it.
   */
  beforeRename?: () => void;
}

/**
 * Publish one artifact atomically: temp file in the SAME directory opened
 * O_EXCL (mode 0600), fsync, rename over the destination, fsync the directory.
 * The destination is never written directly, and any failure removes the temp
 * file so no partial artifact is observable.
 */
export function publishArtifactAtomic(
  dir: string,
  name: string,
  data: Buffer | string,
  opts: PublishArtifactOptions = {},
): ReviewRunArtifact {
  assertReviewRunArtifactName(name);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  // A leading dot never matches REVIEW_RUN_ARTIFACT_NAME_RE, so a temp name is
  // always distinguishable from a published artifact name.
  const tempPath = join(dir, `.${name}.${randomBytes(8).toString("hex")}.tmp`);
  let tempOnDisk = false;
  try {
    const fd = openSync(
      tempPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      fchmodSync(fd, 0o600); // deterministic even when the umask strips owner bits
      writeFileSync(fd, buf);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    tempOnDisk = true;
    opts.beforeRename?.();
    renameSync(tempPath, join(dir, name));
    tempOnDisk = false;
    fsyncDirectory(dir);
  } finally {
    if (tempOnDisk) {
      try {
        unlinkSync(tempPath);
      } catch {
        /* best-effort cleanup of our own temp file */
      }
    }
  }
  return { name, bytes: buf.byteLength, sha256: sha256Hex(buf) };
}

/** A single run writer: creates its directory 0700 and publishes atomically. */
export class ReviewRunWriter {
  readonly runDir: string;
  readonly record: ReviewRunRecord;
  private readonly caps: ReviewRunCaps;
  private totalBytes = 0;

  constructor(runDir: string, record: ReviewRunRecord, caps: ReviewRunCaps) {
    this.runDir = runDir;
    this.record = record;
    this.caps = caps;
    ensureOwnedDir(runDir, 0o700);
    this.persist("publishing");
  }

  /**
   * Enforce both byte caps BEFORE publication and refuse by name, naming the
   * cap and the observed size. Exactly-at-cap is accepted; one byte over is
   * refused and never truncated.
   */
  addArtifact(name: string, data: Buffer | string): ReviewRunArtifact {
    assertReviewRunArtifactName(name);
    if (this.record.state !== "publishing") {
      throw new ReviewRunError(
        "review_run_state",
        `review run ${this.record.runId} is ${this.record.state}; refusing a new artifact`,
      );
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const bytes = buf.byteLength;
    if (bytes > this.caps.maxFileBytes) {
      throw new ReviewRunFileCapError(
        `review run artifact '${name}' is ${bytes} bytes, over the per-file cap of ${this.caps.maxFileBytes}`,
      );
    }
    const total = this.totalBytes + bytes;
    if (total > this.caps.maxBytes) {
      throw new ReviewRunCapError(
        `review run total ${total} bytes (artifact '${name}' is ${bytes}) is over the per-run cap of ${this.caps.maxBytes}`,
      );
    }
    const artifact = publishArtifactAtomic(this.runDir, name, buf);
    this.record.artifacts.push(artifact);
    this.totalBytes = total;
    return artifact;
  }

  /** Persist the metadata record with state "published". */
  publish(): ReviewRunRecord {
    this.persist("published");
    return this.record;
  }

  /** Persist the metadata record with state "failed" (interrupted run). */
  fail(): ReviewRunRecord {
    this.persist("failed");
    return this.record;
  }

  private persist(state: ReviewRunState): void {
    this.record.state = state;
    publishArtifactAtomic(
      this.runDir,
      REVIEW_RUN_METADATA_NAME,
      `${JSON.stringify(this.record, null, 2)}\n`,
    );
  }
}

/**
 * Refuse a store root that is not provably outside every writer the confined
 * agent can reach: the project tree, $TMPDIR, and each denied prefix.
 */
export function resolveReviewRunRoot(opts: ReviewRunStoreOptions): string {
  if (typeof opts.root !== "string" || opts.root.length === 0 || !isAbsolute(opts.root)) {
    throw new ReviewRunError(
      "review_run_root",
      `review run store root must be a non-empty absolute path (got ${show(opts.root)})`,
    );
  }
  const root = canonicalForContainment(opts.root);
  const project = canonicalForContainment(opts.projectRoot);
  const tmp = canonicalForContainment(tmpdir());
  if (contains(project, root)) {
    throw new ReviewRunStoreInProjectError(
      `review run store root is inside the project root: ${root} (project ${project})`,
    );
  }
  if (contains(tmp, root)) {
    throw new ReviewRunStoreInTmpError(
      `review run store root is inside $TMPDIR: ${root} (tmp ${tmp})`,
    );
  }
  for (const prefix of opts.deniedPrefixes ?? []) {
    const denied = canonicalForContainment(prefix);
    if (contains(denied, root)) {
      throw new ReviewRunStoreDeniedPrefixError(
        `review run store root is under a denied prefix: ${root} (prefix ${denied})`,
      );
    }
  }
  return root;
}

/**
 * The store: canonically validated root (0700), per-session run directories
 * (0700), a per-session quota, and atomic run creation. Access control for a
 * run (owner-session check) is a later slice and is NOT implemented here.
 */
export class ReviewRunStore {
  readonly root: string;
  readonly caps: ReviewRunCaps;
  private readonly deniedPrefixes: readonly string[];

  constructor(opts: ReviewRunStoreOptions) {
    this.deniedPrefixes = opts.deniedPrefixes ?? [];
    this.root = resolveReviewRunRoot({ ...opts, deniedPrefixes: this.deniedPrefixes });
    this.caps = { ...DEFAULT_REVIEW_RUN_CAPS, ...opts.caps };
    ensureOwnedDir(this.root, 0o700);
  }

  sessionDir(sessionID: string): string {
    if (typeof sessionID !== "string" || !SESSION_ID_RE.test(sessionID)) {
      throw new ReviewRunSessionError(`invalid review run session id (got ${show(sessionID)})`);
    }
    return join(this.root, sessionID);
  }

  runDir(sessionID: string, runId: string): string {
    const session = this.sessionDir(sessionID);
    assertReviewRunId(runId);
    return join(session, runId);
  }

  /** Runs that already exist for a session (quota accounting). */
  countRunsForSession(sessionID: string): number {
    const dir = this.sessionDir(sessionID);
    if (!existsSync(dir)) return 0;
    let count = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && REVIEW_RUN_ID_RE.test(entry.name)) count += 1;
    }
    return count;
  }

  /** Broker-generated runId bound to the session; quota-checked first. */
  createRun(sessionID: string, evidence: ReviewRunEvidence = {}): ReviewRunWriter {
    const existing = this.countRunsForSession(sessionID);
    if (existing >= this.caps.maxPerSession) {
      throw new ReviewRunQuotaError(
        `session ${sessionID} already has ${existing} review runs, at the per-session quota of ${this.caps.maxPerSession}`,
      );
    }
    const baseObjectId = normalizeObjectId(evidence.baseObjectId, "baseObjectId");
    const headObjectId = normalizeObjectId(evidence.headObjectId, "headObjectId");
    const runId = generateRunId();
    assertReviewRunId(runId);
    const session = this.sessionDir(sessionID);
    ensureOwnedDir(session, 0o700);
    const runDir = this.runDir(sessionID, runId);
    const record: ReviewRunRecord = {
      runId,
      sessionID,
      createdAt: new Date().toISOString(),
      state: "publishing",
      baseObjectId,
      headObjectId,
      artifacts: [],
    };
    return new ReviewRunWriter(runDir, record, this.caps);
  }
}

function normalizeObjectId(value: string | undefined, field: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !REVIEW_RUN_OBJECT_ID_RE.test(value)) {
    throw new ReviewRunEvidenceError(
      `review run ${field} must be a full 40- or 64-character lowercase hex object id (got ${show(value)})`,
    );
  }
  return value;
}
