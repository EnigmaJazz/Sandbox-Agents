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
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { SESSION_ID_RE } from "./validation.ts";
import type { BrokerConfig } from "./config.ts";

/** The only accepted runId shape: 32 lowercase hex chars (128 random bits). */
export const REVIEW_RUN_ID_RE = /^[0-9a-f]{32}$/;
/** Git object/tree ids: full sha1 (40) or sha256 (64), lowercase hex. */
const REVIEW_RUN_OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Artifact names: one bounded, separator-free path segment. */
const REVIEW_RUN_ARTIFACT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Persisted run record name inside a run directory. */
export const REVIEW_RUN_METADATA_NAME = "metadata.json";

/** Default retention TTL: a run untouched for 7 days is expired. */
export const DEFAULT_REVIEW_RUN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Default global run bound across every session. */
export const DEFAULT_REVIEW_RUN_MAX_RUNS = 64;
/** Config grammar for the pinned review-helper digest. */
export const REVIEW_HELPER_SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * File names reserved inside a run directory; an artifact may never take one.
 * `REVIEW_RUN_METADATA_NAME` is the only reserved name today — the list exists
 * so a future reserved file is one entry here, not a new guard.
 */
const REVIEW_RUN_RESERVED_NAMES: readonly string[] = [REVIEW_RUN_METADATA_NAME];

/**
 * Case-insensitive reservation test: `Metadata.json` collides with
 * `metadata.json` on a case-insensitive filesystem, so an exact-case compare
 * is not sufficient.
 */
function isReservedReviewRunName(name: string): boolean {
  const lower = name.toLowerCase();
  return REVIEW_RUN_RESERVED_NAMES.some((reserved) => reserved.toLowerCase() === lower);
}

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
  /** Canonical project root that owned this run at creation. */
  projectRoot: string;
  /** Finalize phase evidence; artifact is absent when finalize was not accepted. */
  finalizeProvenance?: {
    phase: "finalize";
    outcome: "accepted" | "structurally_rejected" | "validation_unavailable";
    artifact?: ReviewRunArtifact;
  };
  /** Materialized range manifest and complete byte length, when present. */
  changedPaths?: string[];
  totalBytes?: number;
  /**
   * Set by recovery (T9) when a run interrupted mid-write is marked `failed`, so
   * a later reader can see the run was interrupted rather than deliberately
   * failed. Absent on every other run.
   */
  failureReason?: string;
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

export function reviewRunStoreOptions(
  config: Pick<BrokerConfig, "reviewRunRoot" | "reviewRunDeniedPrefixes" | "reviewRunMaxBytes" | "reviewRunMaxFileBytes" | "reviewRunMaxPerSession">,
): Pick<ReviewRunStoreOptions, "root" | "deniedPrefixes" | "caps"> {
  return {
    root: config.reviewRunRoot,
    deniedPrefixes: config.reviewRunDeniedPrefixes,
    caps: {
      maxBytes: config.reviewRunMaxBytes,
      maxFileBytes: config.reviewRunMaxFileBytes,
      maxPerSession: config.reviewRunMaxPerSession,
    },
  };
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

/**
 * Grammar-only artifact-name guard: one bounded, separator-free segment. Split
 * out from the reserved-name check so the read path can validate grammar while
 * still offering an explicit opt-in for the run record.
 */
function assertReviewRunArtifactNameGrammar(name: unknown): asserts name is string {
  if (typeof name !== "string" || !REVIEW_RUN_ARTIFACT_NAME_RE.test(name)) {
    throw new ReviewRunError(
      "review_run_artifact_name",
      `review run artifact name must be one bounded [A-Za-z0-9._-] segment (got ${show(name)})`,
    );
  }
}

export function assertReviewRunArtifactName(name: unknown): asserts name is string {
  assertReviewRunArtifactNameGrammar(name);
  if (isReservedReviewRunName(name)) {
    throw new ReviewRunError(
      "review_run_artifact_name_reserved",
      `review run artifact name ${show(name)} is reserved for the run record (reserved name: ${show(REVIEW_RUN_METADATA_NAME)})`,
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
 *
 * The name is validated as a caller-supplied artifact name, so the reserved
 * run-record name is refused here.
 */
export function publishArtifactAtomic(
  dir: string,
  name: string,
  data: Buffer | string,
  opts: PublishArtifactOptions = {},
): ReviewRunArtifact {
  assertReviewRunArtifactName(name);
  return publishValidatedArtifactAtomic(dir, name, data, opts);
}

/**
 * Publication core for an already-validated name. Module-private: the run
 * record itself is the only writer permitted the reserved metadata name, and it
 * passes the module constant — never caller input — so the reserved-name
 * refusal stays the sole entry point for a caller-supplied name.
 */
function publishValidatedArtifactAtomic(
  dir: string,
  name: string,
  data: Buffer | string,
  opts: PublishArtifactOptions = {},
): ReviewRunArtifact {
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
    // The run record is the one legitimate writer of the reserved metadata
    // name; it publishes through the validated-name core directly.
    publishValidatedArtifactAtomic(
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
  readonly projectRoot: string;
  readonly caps: ReviewRunCaps;
  private readonly deniedPrefixes: readonly string[];

  constructor(opts: ReviewRunStoreOptions) {
    this.deniedPrefixes = opts.deniedPrefixes ?? [];
    this.projectRoot = canonicalForContainment(opts.projectRoot);
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

  readRecord(sessionID: string, runId: string): ReviewRunRecord {
    const raw = readRunArtifact({ runDir: this.runDir(sessionID, runId), name: REVIEW_RUN_METADATA_NAME, maxFileBytes: this.caps.maxFileBytes, allowRecord: true }).data;
    let record: ReviewRunRecord;
    try { record = JSON.parse(raw.toString("utf8")) as ReviewRunRecord; }
    catch { throw new ReviewRunError("review_run_record_invalid", "review run record is not valid JSON"); }
    if (!record || record.runId !== runId || record.sessionID !== sessionID || typeof record.projectRoot !== "string") {
      throw new ReviewRunError("review_run_record_invalid", "review run record is missing its owner or canonical project identity");
    }
    return record;
  }

  recordFinalizeProvenance(
    sessionID: string,
    runId: string,
    provenance: NonNullable<ReviewRunRecord["finalizeProvenance"]>,
  ): void {
    const record = this.readRecord(sessionID, runId);
    record.finalizeProvenance = provenance;
    publishValidatedArtifactAtomic(this.runDir(sessionID, runId), REVIEW_RUN_METADATA_NAME, `${JSON.stringify(record, null, 2)}\n`);
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

  /** Cheap admission gate used before expensive Git resolution and diffing. */
  assertRunAdmission(sessionID: string): void {
    const existing = this.countRunsForSession(sessionID);
    if (existing >= this.caps.maxPerSession) {
      throw new ReviewRunQuotaError(
        `session ${sessionID} already has ${existing} review runs, at the per-session quota of ${this.caps.maxPerSession}`,
      );
    }
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
      projectRoot: this.projectRoot,
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

// ---------------------------------------------------------------------------
// T7 — Pinned helper identity (design property 1)
// ---------------------------------------------------------------------------

/** Minimal config slice `assertPinnedReviewHelper` consumes (never the whole config). */
export interface ReviewHelperPinConfig {
  reviewHelperPath: string | null;
  reviewHelperSha256: string | null;
  /** Test seam for deterministic filesystem failure classification. */
  lstat?: typeof lstatSync;
}

export interface PinnedReviewHelper {
  /** Lexically-resolved absolute path of the verified helper. */
  path: string;
  sha256: string;
  bytes: number;
}

export interface ReviewHelperInterpreterConfig {
  reviewHelperInterpreter: string | null;
  lstat?: typeof lstatSync;
}

export class ReviewHelperInterpreterUnconfiguredError extends ReviewRunError {
  constructor(message: string) { super("review_helper_interpreter_unconfigured", message); }
}
export class ReviewHelperInterpreterMissingError extends ReviewRunError {
  constructor(message: string) { super("review_helper_interpreter_missing", message); }
}
export class ReviewHelperInterpreterNotRegularError extends ReviewRunError {
  constructor(message: string) { super("review_helper_interpreter_not_regular", message); }
}
export class ReviewHelperInterpreterNotExecutableError extends ReviewRunError {
  constructor(message: string) { super("review_helper_interpreter_not_executable", message); }
}

export function resolveReviewHelperInterpreter(cfg: ReviewHelperInterpreterConfig): string {
  const configured = cfg.reviewHelperInterpreter;
  if (configured === null) {
    throw new ReviewHelperInterpreterUnconfiguredError("review helper interpreter is not configured");
  }
  if (typeof configured !== "string" || configured.length === 0 || !isAbsolute(configured)) {
    throw new ReviewHelperInterpreterUnconfiguredError("review helper interpreter must be a non-empty absolute path");
  }
  const path = resolve(configured);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = (cfg.lstat ?? lstatSync)(path);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") throw new ReviewHelperInterpreterMissingError(`review helper interpreter does not exist: ${path}`);
    throw new ReviewRunError("review_helper_interpreter_unavailable", `review helper interpreter could not be inspected: ${path}`);
  }
  if (!stat.isFile()) {
    throw new ReviewHelperInterpreterNotRegularError(`review helper interpreter is not a regular file: ${path} (${describeFileType(stat)})`);
  }
  if ((stat.mode & 0o111) === 0) {
    throw new ReviewHelperInterpreterNotExecutableError(`review helper interpreter is not executable: ${path}`);
  }
  return path;
}

export class ReviewHelperUnconfiguredError extends ReviewRunError {
  constructor(message: string) {
    super("review_helper_unconfigured", message);
  }
}
export class ReviewHelperMissingError extends ReviewRunError {
  constructor(message: string) {
    super("review_helper_missing", message);
  }
}
export class ReviewHelperNotRegularError extends ReviewRunError {
  constructor(message: string) {
    super("review_helper_not_regular", message);
  }
}
export class ReviewHelperDigestMismatchError extends ReviewRunError {
  constructor(message: string) {
    super("review_helper_digest_mismatch", message);
  }
}

function describeFileType(stat: {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
}): string {
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isDirectory()) return "directory";
  return "non-regular file";
}

/**
 * Verify the configured helper is a regular file whose sha256 equals the
 * configured digest, reading ONLY the configured path — never searching, never
 * falling back to any package-cache location.
 *
 * `resolve` (lexical) is used deliberately instead of `realpath`: realpath
 * would follow the very symlink this guard must reject. `lstat` (not `stat`)
 * reports the link itself, so a symlink is refused as a non-regular type.
 */
export function assertPinnedReviewHelper(cfg: ReviewHelperPinConfig): PinnedReviewHelper {
  const configuredPath = cfg.reviewHelperPath;
  const configuredSha = cfg.reviewHelperSha256;
  if (configuredPath === null || configuredSha === null) {
    throw new ReviewHelperUnconfiguredError(
      "review helper is not configured: both reviewHelperPath and reviewHelperSha256 must be set",
    );
  }
  const resolved = resolve(configuredPath);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = (cfg.lstat ?? lstatSync)(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      throw new ReviewHelperMissingError(`review helper does not exist: ${resolved}`);
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new ReviewRunError(
        "review_helper_unreadable",
        `review helper exists but is not readable: ${resolved} (${code})`,
      );
    }
    if (code === "ENOTDIR") {
      throw new ReviewRunError(
        "review_helper_path_component_not_directory",
        `review helper path has a component that is not a directory: ${resolved}`,
      );
    }
    throw new ReviewRunError(
      "review_helper_lstat_unexpected",
      `review helper lstat failed unexpectedly for ${resolved} (code: ${typeof code === "string" ? code : "missing"})`,
    );
  }
  if (!stat.isFile()) {
    throw new ReviewHelperNotRegularError(
      `review helper is not a regular file: ${resolved} (${describeFileType(stat)})`,
    );
  }
  const bytes = readFileSync(resolved);
  const observed = sha256Hex(bytes);
  if (observed !== configuredSha) {
    throw new ReviewHelperDigestMismatchError(
      `review helper digest mismatch for ${resolved}: expected ${configuredSha}, observed ${observed}`,
    );
  }
  return { path: resolved, sha256: observed, bytes: bytes.byteLength };
}

// ---------------------------------------------------------------------------
// T8 — Owner-session access (design property 3)
// ---------------------------------------------------------------------------

export class ReviewRunOwnershipError extends ReviewRunError {
  constructor(message: string) {
    super("review_run_ownership", message);
  }
}

/**
 * Serve a run only to the session that owns it. The refusal names the run but
 * NEVER the requesting session id, so a probing session cannot learn another
 * session's identifier through the error.
 */
export function assertRunOwnership(record: ReviewRunRecord, sessionID: string): void {
  if (record.sessionID !== sessionID) {
    throw new ReviewRunOwnershipError(
      `review run ${record.runId} is not owned by the requesting session`,
    );
  }
}

// ---------------------------------------------------------------------------
// T9 — Retention, expiry and recovery (design property 8)
// ---------------------------------------------------------------------------

interface DiscoveredRun {
  sessionID: string;
  runId: string;
  runDir: string;
  mtimeMs: number;
  record: ReviewRunRecord | null;
}

interface RunRef {
  sessionID: string;
  runId: string;
}

function readRunRecord(runDir: string): ReviewRunRecord | null {
  try {
    const raw = readFileSync(join(runDir, REVIEW_RUN_METADATA_NAME), "utf8");
    const parsed = JSON.parse(raw) as ReviewRunRecord;
    if (parsed && typeof parsed === "object" && typeof parsed.state === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/** Every run directory under a root, with its mtime and (best-effort) record. */
function discoverRuns(root: string): DiscoveredRun[] {
  const out: DiscoveredRun[] = [];
  if (!existsSync(root)) return out;
  for (const session of readdirSync(root, { withFileTypes: true })) {
    if (!session.isDirectory()) continue;
    const sessionDir = join(root, session.name);
    for (const run of readdirSync(sessionDir, { withFileTypes: true })) {
      if (!run.isDirectory() || !REVIEW_RUN_ID_RE.test(run.name)) continue;
      const runDir = join(sessionDir, run.name);
      let mtimeMs: number;
      try {
        mtimeMs = statSync(runDir).mtimeMs;
      } catch {
        continue;
      }
      out.push({
        sessionID: session.name,
        runId: run.name,
        runDir,
        mtimeMs,
        record: readRunRecord(runDir),
      });
    }
  }
  return out;
}

/** An open run for this slice: its record state is `publishing`. */
function isOpenRun(run: DiscoveredRun): boolean {
  return run.record?.state === "publishing";
}

export interface PrunedReviewRun extends RunRef {
  reason: "expired" | "over-bound";
  state: ReviewRunState | null;
}

export interface PruneReviewRunsSummary {
  pruned: PrunedReviewRun[];
  /** Runs protected because they are `publishing` (open) — never pruned. */
  keptOpen: RunRef[];
  totalBefore: number;
}

export interface PruneReviewRunsOptions {
  /** Store root to sweep (the same root `ReviewRunStore` owns). */
  root: string;
  /** Retain runs whose directory mtime is within this window. */
  ttlMs: number;
  /** Global bound across every session; oldest pruned first when exceeded. */
  maxRuns: number;
  /** Inject "now" for deterministic tests; defaults to Date.now(). */
  now?: number;
}

/**
 * Remove expired runs and, when over the global bound, the oldest runs first.
 * A run whose record reads `publishing` is "open" and is NEVER removed by
 * either pass: it is reported in `keptOpen` instead. The summary names every
 * run removed and the reason it was removed.
 */
export function pruneReviewRuns(opts: PruneReviewRunsOptions): PruneReviewRunsSummary {
  const now = opts.now ?? Date.now();
  const runs = discoverRuns(opts.root);
  const pruned: PrunedReviewRun[] = [];
  const keptOpen: RunRef[] = [];
  const keptOpenDirs = new Set<string>();
  const removed = new Set<string>();

  const noteOpen = (run: DiscoveredRun): void => {
    if (keptOpenDirs.has(run.runDir)) return;
    keptOpenDirs.add(run.runDir);
    keptOpen.push({ sessionID: run.sessionID, runId: run.runId });
  };

  // Pass 1 — expiry by directory mtime.
  for (const run of runs) {
    if (now - run.mtimeMs <= opts.ttlMs) continue;
    if (isOpenRun(run)) {
      noteOpen(run);
      continue;
    }
    rmSync(run.runDir, { recursive: true, force: true });
    removed.add(run.runDir);
    pruned.push({
      sessionID: run.sessionID,
      runId: run.runId,
      reason: "expired",
      state: run.record?.state ?? null,
    });
  }

  // Pass 2 — global bound, oldest first, still never an open run.
  const remaining = runs
    .filter((run) => !removed.has(run.runDir))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  let excess = remaining.length - opts.maxRuns;
  for (const run of remaining) {
    if (excess <= 0) break;
    if (isOpenRun(run)) {
      noteOpen(run);
      continue;
    }
    rmSync(run.runDir, { recursive: true, force: true });
    removed.add(run.runDir);
    pruned.push({
      sessionID: run.sessionID,
      runId: run.runId,
      reason: "over-bound",
      state: run.record?.state ?? null,
    });
    excess -= 1;
  }

  return { pruned, keptOpen, totalBefore: runs.length };
}

export interface RecoveredReviewRun extends RunRef {}

export interface RecoverInterruptedRunsSummary {
  recovered: RecoveredReviewRun[];
}

export interface RecoverInterruptedRunsOptions {
  root: string;
  ttlMs: number;
  now?: number;
}

/**
 * A run interrupted mid-write has a record still reading `publishing`. Once it
 * is older than the TTL, mark it `failed` through the existing writer path and
 * record `failureReason: "interrupted"` in the record — do NOT delete it, so a
 * later reader can see the outcome.
 */
export function recoverInterruptedRuns(
  opts: RecoverInterruptedRunsOptions,
): RecoverInterruptedRunsSummary {
  const now = opts.now ?? Date.now();
  const recovered: RecoveredReviewRun[] = [];
  for (const run of discoverRuns(opts.root)) {
    if (run.record?.state !== "publishing") continue;
    if (now - run.mtimeMs <= opts.ttlMs) continue;
    const record = run.record;
    record.failureReason = "interrupted";
    const writer = new ReviewRunWriter(run.runDir, record, DEFAULT_REVIEW_RUN_CAPS);
    writer.fail();
    recovered.push({ sessionID: run.sessionID, runId: run.runId });
  }
  return { recovered };
}

// ---------------------------------------------------------------------------
// T10 — Race-resistant read helper (design property 4)
// ---------------------------------------------------------------------------

export class ReviewRunArtifactEscapeError extends ReviewRunError {
  constructor(message: string) {
    super("review_run_artifact_escape", message);
  }
}
export class ReviewRunArtifactSymlinkError extends ReviewRunError {
  constructor(message: string) {
    super("review_run_artifact_symlink", message);
  }
}
export class ReviewRunArtifactNotRegularError extends ReviewRunError {
  constructor(message: string) {
    super("review_run_artifact_not_regular", message);
  }
}
export class ReviewRunArtifactNotFoundError extends ReviewRunError {
  constructor(message: string) {
    super("review_run_artifact_not_found", message);
  }
}
export class ReviewRunArtifactCapError extends ReviewRunError {
  constructor(message: string) {
    super("review_run_artifact_cap", message);
  }
}

export interface ReadRunArtifactOptions {
  /** The specific run directory the artifact must stay inside. */
  runDir: string;
  /** One bounded artifact name (the same grammar as `addArtifact`). */
  name: string;
  /** Read byte cap; exactly-at-cap is accepted, one over is refused. */
  maxFileBytes: number;
  /**
   * Explicit opt-in to read the reserved run record (`metadata.json`). Default
   * false, so an ordinary artifact read can never fetch the record.
   */
  allowRecord?: boolean;
  /** Override O_NOFOLLOW for deterministic capability testing; null means absent. */
  noFollowFlag?: number | null;
  /** Test seam for proving capability refusals occur before open. */
  open?: typeof openSync;
}

export interface ReadReviewRunArtifact {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly data: Buffer;
}

/**
 * Read one artifact from a run directory with the race-resistant shape:
 *  1. name grammar + reserved-name validation (same as `addArtifact`);
 *  2. canonical containment against the specific run directory (reusing the
 *     module's boundary-aware `contains`/`canonicalForContainment`);
 *  3. a SINGLE `openSync` (with `O_NOFOLLOW`) followed by `fstatSync` on that
 *     SAME fd — never `stat` then `open`, which is the TOCTOU shape;
 *  4. a regular-file requirement from that fstat (a symlink is refused by
 *     `O_NOFOLLOW` before fstat, a directory by the isFile check);
 *  5. a byte cap enforced by the observed fstat size AND the returned length.
 */
export function readRunArtifact(opts: ReadRunArtifactOptions): ReadReviewRunArtifact {
  const { runDir, name } = opts;
  assertReviewRunArtifactNameGrammar(name);
  if (isReservedReviewRunName(name)) {
    if (opts.allowRecord !== true || name !== REVIEW_RUN_METADATA_NAME) {
      throw new ReviewRunError(
        "review_run_artifact_name_reserved",
        `review run artifact name ${show(name)} is reserved for the run record; pass allowRecord to read the record explicitly`,
      );
    }
  }
  const runDirCanonical = canonicalForContainment(runDir);
  const target = join(runDir, name);
  const targetCanonical = canonicalForContainment(target);
  if (!contains(runDirCanonical, targetCanonical)) {
    throw new ReviewRunArtifactEscapeError(
      `review run artifact ${show(name)} resolves outside its run directory`,
    );
  }
  const noFollow = opts.noFollowFlag === undefined ? constants.O_NOFOLLOW : opts.noFollowFlag;
  if (noFollow === undefined || noFollow === null || !Number.isSafeInteger(noFollow) || noFollow <= 0) {
    throw new ReviewRunError(
      "review_run_artifact_no_follow_unavailable",
      `review run artifact ${show(name)} cannot be opened safely: no-follow capability is unavailable`,
    );
  }
  let fd: number;
  try {
    fd = (opts.open ?? openSync)(target, constants.O_RDONLY | noFollow);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EINVAL") {
      throw new ReviewRunError(
        "review_run_artifact_no_follow_unavailable",
        `review run artifact ${show(name)} cannot be opened safely: no-follow capability is unusable`,
      );
    }
    if (code === "ELOOP") {
      throw new ReviewRunArtifactSymlinkError(
        `review run artifact ${show(name)} is a symlink; refusing to follow it`,
      );
    }
    if (code === "ENOENT") {
      throw new ReviewRunArtifactNotFoundError(
        `review run artifact ${show(name)} does not exist in the run directory`,
      );
    }
    throw new ReviewRunError(
      "review_run_artifact_read",
      `review run artifact ${show(name)} could not be opened`,
    );
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new ReviewRunArtifactNotRegularError(
        `review run artifact ${show(name)} is not a regular file`,
      );
    }
    if (stat.size > opts.maxFileBytes) {
      throw new ReviewRunArtifactCapError(
        `review run artifact ${show(name)} is ${stat.size} bytes, over the read cap of ${opts.maxFileBytes}`,
      );
    }
    const data = readFileSync(fd);
    if (data.byteLength > opts.maxFileBytes) {
      throw new ReviewRunArtifactCapError(
        `review run artifact ${show(name)} returned ${data.byteLength} bytes, over the read cap of ${opts.maxFileBytes}`,
      );
    }
    return { name, bytes: data.byteLength, sha256: sha256Hex(data), data };
  } finally {
    closeSync(fd);
  }
}
