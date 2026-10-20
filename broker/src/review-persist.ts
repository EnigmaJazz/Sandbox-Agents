import { randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync, fsyncSync, chmodSync } from "node:fs";
import { basename, join, resolve, relative, sep } from "node:path";
import { homedir } from "node:os";
import { spawnExec } from "./msb.ts";
import { assertPinnedReviewHelper, readRunArtifact, ReviewRunStore, resolveReviewHelperInterpreter } from "./review-run.ts";
import type { BrokerConfig } from "./config.ts";
import type { ReviewPipelineResult } from "./review-pipeline.ts";

export type ReviewArtifactValidation =
  | { status: "passed"; code: "review_artifact_validation_passed" }
  | { status: "failed"; code: "review_artifact_validation_failed"; reason: string }
  | { status: "unavailable"; code: "review_artifact_validator_unavailable"; reason: string }
  | { status: "not_attempted"; code: "review_artifact_not_attempted" };
export interface ReviewPersistResult { outcome: "persisted" | "incomplete" | "report_only"; path?: string; stagingPath?: string; validation: ReviewArtifactValidation; ignoreFile: { status: "unchanged" | "created" | "changed" } }
export class ReviewPersistError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = new.target.name; }
}

export interface ReviewPersistPreflight {
  runId: string;
  projectDir: string;
  baseObjectId: string | null;
  headObjectId: string | null;
  changedPaths: number;
  totalBytes: number;
  finalize: { name: string | null; bytes: number | null; sha256: string | null };
  finalizeInput: "stdin" | "inputRef" | "inputRefs" | "unknown";
  kind: string | null;
  verdict: string | null;
  verdictSource: string | null;
  counts: Record<string, number>;
  blockers: Array<{ code: string; message: string }>;
}

export function preflightReviewPersist(options: {
  projectDir: string;
  runId: string;
  finalizeRef: string;
  store: ReviewRunStore;
  sessionID: string;
  maxFileBytes: number;
}): ReviewPersistPreflight {
  const projectDir = realpathSync(resolve(options.projectDir));
  const record = options.store.readRecord(options.sessionID, options.runId);
  const blockers: ReviewPersistPreflight["blockers"] = [];
  const add = (code: string, message: string) => blockers.push({ code, message: message.slice(0, 128) });
  if (record.projectRoot !== projectDir) add("review_persist_project_mismatch", "review run is bound to a different canonical project root");
  const provenance = record.finalizeProvenance;
  if (!provenance) add("review_persist_finalize_provenance_missing", "review run has no finalize phase provenance");
  else {
    if (provenance.phase !== "finalize") add("review_persist_finalize_phase_invalid", "recorded artifact was not published by the finalize phase");
    if (provenance.outcome !== "accepted") add("review_persist_finalize_outcome_invalid", "recorded finalize phase did not have an accepted outcome");
    if (!provenance.artifact) add("review_persist_finalize_provenance_missing", "accepted finalize phase has no published artifact");
  }
  const recorded = provenance?.artifact;
  if (recorded && options.finalizeRef !== recorded.name) add("review_persist_finalize_ref_mismatch", "finalizeRef does not name the recorded finalize artifact");
  let artifact: ReturnType<typeof readRunArtifact> | undefined;
  if (recorded) {
    try {
      artifact = readRunArtifact({ runDir: options.store.runDir(options.sessionID, options.runId), name: recorded.name, maxFileBytes: options.maxFileBytes });
      if (artifact.bytes !== recorded.bytes || artifact.sha256 !== recorded.sha256) add("review_persist_finalize_digest_mismatch", "finalize artifact bytes no longer match the recorded length and sha256");
    } catch {
      add("review_persist_preflight_artifact_unreadable", "finalize artifact cannot be read safely");
    }
  }
  let document: Record<string, unknown> | undefined;
  if (artifact) {
    try {
      const parsed: unknown = JSON.parse(artifact.data.toString("utf8"));
      document = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      add("review_persist_preflight_json_invalid", "finalize artifact is not a JSON object");
    }
  }
  const wrapper = document as { kind?: unknown; artifact?: unknown } | undefined;
  const kind = typeof wrapper?.kind === "string" ? wrapper.kind.slice(0, 128) : null;
  if (document && kind !== "writing") add("review_persist_kind", "finalize output is not a writing artifact");
  const body = wrapper?.artifact;
  const payloadDocument = body !== null && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
  if (document && kind === "writing" && !payloadDocument) add("review_persist_artifact", "finalize writing wrapper must contain a JSON artifact object");
  const verdict = typeof payloadDocument?.verdict === "string" ? payloadDocument.verdict :
    payloadDocument?.plan_assessment !== null && typeof payloadDocument?.plan_assessment === "object" && typeof (payloadDocument.plan_assessment as Record<string, unknown>).verdict === "string"
      ? (payloadDocument.plan_assessment as Record<string, string>).verdict : null;
  const verdictSource = verdict === null ? null : typeof payloadDocument?.verdict === "string" ? "verdict" : "plan_assessment.verdict";
  const counts: Record<string, number> = {};
  if (payloadDocument) {
    for (const [key, value] of Object.entries(payloadDocument)) {
      if (Object.keys(counts).length >= 16) break;
      if ((key.endsWith("_count") && Number.isInteger(value)) || Array.isArray(value)) counts[key.slice(0, 128)] = Array.isArray(value) ? value.length : value as number;
    }
  }
  const inputSource = provenance?.inputSource;
  return {
    runId: options.runId.slice(0, 128), projectDir: projectDir.slice(0, 128),
    baseObjectId: typeof record.baseObjectId === "string" ? record.baseObjectId.slice(0, 128) : null,
    headObjectId: typeof record.headObjectId === "string" ? record.headObjectId.slice(0, 128) : null,
    changedPaths: Array.isArray(record.changedPaths) ? record.changedPaths.length : 0,
    totalBytes: Number.isInteger(record.totalBytes) ? record.totalBytes! : 0,
    finalize: { name: recorded?.name.slice(0, 128) ?? null, bytes: recorded?.bytes ?? null, sha256: recorded?.sha256.slice(0, 128) ?? null },
    finalizeInput: inputSource === "stdin" || inputSource === "inputRef" || inputSource === "inputRefs" ? inputSource : "unknown", kind, verdict: verdict?.slice(0, 128) ?? null,
    verdictSource, counts, blockers: blockers.slice(0, 16),
  };
}

export const REVIEW_IGNORE_MAX_BYTES = 64 * 1024;
export interface PersistReviewArtifactOptions extends Pick<BrokerConfig, "reviewHelperPath" | "reviewHelperSha256" | "reviewHelperInterpreter"> {
  root: string;
  runId: string;
  runDir: string;
  storeRunDir: string;
  mode: "write" | "report_only";
  finalize: ReviewPipelineResult;
  env?: Record<string, string>;
  spawn?: typeof spawnExec;
  beforeRename?: () => void;
  beforeTempCreate?: () => void;
  procFdAvailable?: () => boolean;
}

const DIRECTORY_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
const procFdPath = (fd: number, name?: string): string => `/proc/self/fd/${fd}${name ? `/${name}` : ""}`;

function assertRunDirectoryAnchor(anchorFd: number, expectedRunDir: string): void {
  let anchoredPath: string;
  try {
    anchoredPath = realpathSync(procFdPath(anchorFd));
  } catch {
    throw new ReviewPersistError("review_persist_anchor_changed", "repository review directory anchor cannot be resolved; refusing publication");
  }
  if (anchoredPath !== expectedRunDir) {
    throw new ReviewPersistError("review_persist_anchor_changed", "repository review directory moved from its canonical location; refusing publication");
  }
}

function assertProcFdAvailable(options: PersistReviewArtifactOptions): void {
  let probeFd: number | undefined;
  try {
    if (options.procFdAvailable) {
      if (!options.procFdAvailable()) throw new Error("probe unavailable");
    } else {
      probeFd = openSync("/proc/self/fd", DIRECTORY_FLAGS);
      closeSync(probeFd);
      probeFd = undefined;
    }
  } catch {
    if (probeFd !== undefined) closeSync(probeFd);
    throw new ReviewPersistError("review_persist_fd_path_unavailable", "/proc/self/fd is unavailable; refusing pathname-based persistence");
  }
}

function openContainedRunDirectories(root: string, runDir: string): { contextFd: number; runDirFd: number } {
  let anchor = openSync(root, DIRECTORY_FLAGS);
  let contextFd: number | undefined;
  let pendingFd: number | undefined;
  try {
    const relative = runDir.slice(root.length).split(/[\\/]/).filter(Boolean);
    for (const component of relative) {
      const childPath = procFdPath(anchor, component);
      let child: number;
      try {
        child = openSync(childPath, DIRECTORY_FLAGS);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new ReviewPersistError("review_persist_unsafe_directory", `unsafe review directory component: ${component}`);
        }
        try { mkdirSync(childPath, { mode: 0o700 }); } catch (mkdirCause) {
          if ((mkdirCause as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirCause;
        }
        try {
          child = openSync(childPath, DIRECTORY_FLAGS);
        } catch {
          throw new ReviewPersistError("review_persist_unsafe_directory", `unsafe review directory component: ${component}`);
        }
      }
      pendingFd = child;
      if (component === ".context") contextFd = child;
      if (anchor !== contextFd) closeSync(anchor);
      anchor = child;
      pendingFd = undefined;
    }
    if (contextFd === undefined) throw new ReviewPersistError("review_persist_unsafe_directory", "review context directory was not resolved");
    return { contextFd, runDirFd: anchor };
  } catch (cause) {
    for (const fd of new Set([pendingFd, anchor, contextFd])) {
      if (fd === undefined) continue;
      try { closeSync(fd); } catch { /* best-effort close all opened descriptors */ }
    }
    throw cause;
  }
}

export async function persistReviewArtifact(options: PersistReviewArtifactOptions): Promise<ReviewPersistResult> {
  if (options.finalize.outcome === "structurally_rejected") throw new ReviewPersistError("review_persist_rejected", "cannot persist structurally rejected finalize output");
  if (options.finalize.outcome === "validation_unavailable") throw new ReviewPersistError("review_persist_unavailable", "cannot persist unavailable finalize output");
  const wrapper = options.finalize.output as { kind?: unknown; artifact?: unknown };
  if (!wrapper || typeof wrapper !== "object" || wrapper.kind !== "writing") throw new ReviewPersistError("review_persist_kind", "finalize output is not a writing artifact");
  if (options.mode === "report_only") return { outcome: "report_only", validation: { status: "not_attempted", code: "review_artifact_not_attempted" }, ignoreFile: { status: "unchanged" } };
  const root = realpathSync(resolve(options.root));
  const runId = options.runId;
  if (!/^[a-f0-9]{32}$/.test(runId)) throw new ReviewPersistError("review_persist_run_id", "invalid review run id");
  const expectedRunDir = join(root, ".context", "systematic", "ce-review", runId);
  if (resolve(options.runDir) !== expectedRunDir) throw new ReviewPersistError("review_persist_path", "run directory does not match the repository review path");
  const artifact = wrapper.artifact;
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) throw new ReviewPersistError("review_persist_artifact", "finalize artifact must be a JSON object");
  const document = { ...(artifact as Record<string, unknown>) };
  if (!Object.hasOwn(document, "schema_version")) document.schema_version = 1;
  const runDir = expectedRunDir;
  let storeRunDir: string;
  try { storeRunDir = realpathSync(resolve(options.storeRunDir)); }
  catch { throw new ReviewPersistError("review_persist_staging_path", "broker review run directory cannot be resolved; refusing staging"); }
  const storeRelative = relative(root, storeRunDir);
  if (basename(storeRunDir) !== runId || storeRelative === "" || (storeRelative !== ".." && storeRelative.startsWith(`..${sep}`) === false)) {
    throw new ReviewPersistError("review_persist_staging_path", "broker review staging directory must be a run-store directory outside the project; refusing staging");
  }
  const stagingRoot = join(storeRunDir, "staging");
  const stagedRelativePath = `.context/systematic/ce-review/${runId}/review-summary.json`;
  const stagedTarget = join(stagingRoot, stagedRelativePath);
  const target = join(runDir, "review-summary.json");
  const documentBytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
  assertProcFdAvailable(options);
  const { contextFd, runDirFd: anchorFd } = openContainedRunDirectories(root, runDir);
  let ignoreFile: { status: "unchanged" | "created" | "changed" };
  try {
    ignoreFile = await ensureReviewIgnored(root, runDir, contextFd, options.spawn ?? spawnExec);
    try {
      mkdirSync(join(stagingRoot, `.context`, `systematic`, `ce-review`, runId), { recursive: true, mode: 0o700 });
      const stageDirectory = join(stagingRoot, `.context`, `systematic`, `ce-review`, runId);
      chmodSync(stageDirectory, 0o700);
      const stageTmp = `${stagedTarget}.${randomUUID()}.tmp`;
      let stageFd: number | undefined;
      try {
        stageFd = openSync(stageTmp, "wx", 0o600);
        fchmodSync(stageFd, 0o600);
        writeFileSync(stageFd, documentBytes);
        fsyncSync(stageFd);
        closeSync(stageFd); stageFd = undefined;
        renameSync(stageTmp, stagedTarget);
      } catch (cause) {
        if (stageFd !== undefined) closeSync(stageFd);
        try { unlinkSync(stageTmp); } catch { /* absent after rename or failed creation */ }
        throw cause;
      }
      const validation = await validateArtifact(options, stagedRelativePath, stagingRoot);
      if (validation.status !== "passed") {
        return { outcome: "incomplete", stagingPath: `staging/${stagedRelativePath}`, validation, ignoreFile };
      }
      const tmpName = `.review-summary.${randomUUID()}.tmp`;
      const tmp = procFdPath(anchorFd, tmpName);
      const anchoredTarget = procFdPath(anchorFd, "review-summary.json");
      let fd: number | undefined;
      try {
        options.beforeTempCreate?.();
        assertRunDirectoryAnchor(anchorFd, runDir);
        fd = openSync(tmp, "wx", 0o600);
        fchmodSync(fd, 0o600);
        writeFileSync(fd, documentBytes);
        fsyncSync(fd);
        closeSync(fd); fd = undefined;
        options.beforeRename?.();
        assertRunDirectoryAnchor(anchorFd, runDir);
        renameSync(tmp, anchoredTarget);
        fsyncSync(anchorFd);
      } catch (cause) {
        if (fd !== undefined) closeSync(fd);
        try { unlinkSync(tmp); } catch { /* absent after rename or failed creation */ }
        throw cause;
      }
      return { outcome: "persisted", path: target, validation, ignoreFile };
    } catch (cause) {
      if (ignoreFile.status !== "unchanged") {
        const message = cause instanceof Error ? cause.message : "artifact persistence failed";
        const code = cause instanceof ReviewPersistError ? cause.code : "review_persist_partial_project_change";
        throw new ReviewPersistError(code, `${message}; .context/.gitignore was ${ignoreFile.status} and remains modified`);
      }
      throw cause;
    }
  } finally {
    try { closeSync(anchorFd); }
    finally { closeSync(contextFd); }
  }
}

async function ensureReviewIgnored(root: string, runDir: string, contextFd: number, spawn: typeof spawnExec): Promise<{ status: "unchanged" | "created" | "changed" }> {
  const check = async () => spawn(["git", "check-ignore", "-q", "--", join(runDir, "review-summary.json")], {
    cwd: root, timeoutMs: 10_000, maxOutputBytes: 4096,
    // Git's global config is trusted operator input; never redirect HOME into the project.
    env: { PATH: process.env.PATH ?? "", HOME: homedir(), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    envMode: "replace",
  });
  const initial = await check();
  if (initial.status === 0) return { status: "unchanged" };
  if (initial.status !== 1) throw new ReviewPersistError("review_ignore_check_failed", `git check-ignore failed with status ${initial.status}`);
  const ignore = procFdPath(contextFd, ".gitignore");
  let existing = Buffer.alloc(0);
  let existed = false;
  try {
    const stat = lstatSync(ignore);
    existed = true;
    if (stat.isSymbolicLink()) throw new ReviewPersistError("review_ignore_symlink", ".context/.gitignore must not be a symlink");
    if (!stat.isFile()) throw new ReviewPersistError("review_ignore_unsafe_target", ".context/.gitignore must be a regular file");
    if (stat.size > REVIEW_IGNORE_MAX_BYTES) throw new ReviewPersistError("review_ignore_file_too_large", `.context/.gitignore exceeds ${REVIEW_IGNORE_MAX_BYTES}-byte cap (observed ${stat.size} bytes)`);
    const readFd = openSync(ignore, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const opened = fstatSync(readFd);
      if (!opened.isFile()) throw new ReviewPersistError("review_ignore_unsafe_target", ".context/.gitignore must be a regular file");
      if (opened.size > REVIEW_IGNORE_MAX_BYTES) throw new ReviewPersistError("review_ignore_file_too_large", `.context/.gitignore exceeds ${REVIEW_IGNORE_MAX_BYTES}-byte cap (observed ${opened.size} bytes)`);
      const bounded = Buffer.alloc(REVIEW_IGNORE_MAX_BYTES + 1);
      const bytes = readSync(readFd, bounded, 0, bounded.byteLength, 0);
      if (bytes > REVIEW_IGNORE_MAX_BYTES) throw new ReviewPersistError("review_ignore_file_too_large", `.context/.gitignore exceeds ${REVIEW_IGNORE_MAX_BYTES}-byte cap (observed at least ${bytes} bytes)`);
      existing = bounded.subarray(0, bytes);
    } finally { closeSync(readFd); }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  const entry = Buffer.from(`systematic/ce-review/${basename(runDir)}/`, "utf8");
  const lines = existing.toString("utf8").split(/\r?\n/);
  if (lines.includes(entry.toString("utf8"))) throw new ReviewPersistError("review_ignore_ineffective", ".context/.gitignore already contains the review entry but git does not ignore the run artifact");
  const suffix = Buffer.from(`${existing.byteLength > 0 && existing[existing.byteLength - 1] !== 10 ? "\n" : ""}${entry.toString("utf8")}\n`, "utf8");
  const tmp = procFdPath(contextFd, `.gitignore.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, Buffer.concat([existing, suffix]));
    closeSync(fd); fd = undefined;
    renameSync(tmp, ignore);
    fsyncSync(contextFd);
  } catch (cause) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(tmp); } catch { /* best effort cleanup */ }
    throw cause;
  }
  const verified = await check();
  if (verified.status !== 0) throw new ReviewPersistError("review_ignore_ineffective", `git check-ignore did not ignore the review artifact (status ${verified.status}); .context/.gitignore was ${existed ? "changed" : "created"} and remains modified`);
  return { status: existed ? "changed" : "created" };
}

async function validateArtifact(options: PersistReviewArtifactOptions, target: string, cwd: string): Promise<ReviewArtifactValidation> {
  let helper: ReturnType<typeof assertPinnedReviewHelper>;
  let interpreter: string;
  try {
    helper = assertPinnedReviewHelper(options);
    interpreter = resolveReviewHelperInterpreter(options);
  } catch (cause) {
    return { status: "unavailable", code: "review_artifact_validator_unavailable", reason: cause instanceof Error ? cause.message : "pinned validator unavailable" };
  }
  let result;
  try {
    result = await (options.spawn ?? spawnExec)([interpreter, helper.path, "artifact", target], {
      cwd, timeoutMs: 30_000, maxOutputBytes: 64 * 1024,
      env: { PATH: process.env.PATH ?? "", ...(options.env ?? {}) }, envMode: "replace",
    });
  } catch (cause) {
    return { status: "unavailable", code: "review_artifact_validator_unavailable", reason: cause instanceof Error ? cause.message : "validator could not start" };
  }
  if (result.status === 0 && !result.timedOut && !result.outputTruncated) return { status: "passed", code: "review_artifact_validation_passed" };
  if (result.status === 1 && !result.timedOut && !result.outputTruncated) return { status: "failed", code: "review_artifact_validation_failed", reason: result.stderr.slice(0, 4096) };
  if (result.status === 3 && !result.timedOut) return { status: "unavailable", code: "review_artifact_validator_unavailable", reason: "legacy artifact: validator returned exit status 3 despite schema_version insertion" };
  return { status: "unavailable", code: "review_artifact_validator_unavailable", reason: result.stderr.slice(0, 4096) || `validator exited with status ${result.status}` };
}
