import { randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, fsyncSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnExec } from "./msb.ts";
import { assertPinnedReviewHelper, resolveReviewHelperInterpreter } from "./review-run.ts";
import type { BrokerConfig } from "./config.ts";
import type { ReviewPipelineResult } from "./review-pipeline.ts";

export type ReviewArtifactValidation =
  | { status: "passed"; code: "review_artifact_validation_passed" }
  | { status: "failed"; code: "review_artifact_validation_failed"; reason: string }
  | { status: "unavailable"; code: "review_artifact_validator_unavailable"; reason: string }
  | { status: "not_attempted"; code: "review_artifact_not_attempted" };
export interface ReviewPersistResult { outcome: "persisted" | "incomplete" | "report_only"; path?: string; validation: ReviewArtifactValidation }
export class ReviewPersistError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = new.target.name; }
}
export interface PersistReviewArtifactOptions extends Pick<BrokerConfig, "reviewHelperPath" | "reviewHelperSha256" | "reviewHelperInterpreter"> {
  root: string;
  runId: string;
  runDir: string;
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
        child = openSync(childPath, DIRECTORY_FLAGS);
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
  if (options.mode === "report_only") return { outcome: "report_only", validation: { status: "not_attempted", code: "review_artifact_not_attempted" } };
  const root = resolve(options.root);
  const runId = options.runId;
  if (!/^[a-f0-9]{32}$/.test(runId)) throw new ReviewPersistError("review_persist_run_id", "invalid review run id");
  const expectedRunDir = join(root, ".context", "systematic", "ce-review", runId);
  if (resolve(options.runDir) !== expectedRunDir) throw new ReviewPersistError("review_persist_path", "run directory does not match the repository review path");
  const artifact = wrapper.artifact;
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) throw new ReviewPersistError("review_persist_artifact", "finalize artifact must be a JSON object");
  const document = { ...(artifact as Record<string, unknown>) };
  if (!Object.hasOwn(document, "schema_version")) document.schema_version = 1;
  const runDir = expectedRunDir;
  assertProcFdAvailable(options);
  const { contextFd, runDirFd: anchorFd } = openContainedRunDirectories(root, runDir);
  try {
    await ensureReviewIgnored(root, runDir, contextFd, options.spawn ?? spawnExec);
    const target = join(runDir, "review-summary.json");
    const tmpName = `.review-summary.${randomUUID()}.tmp`;
    const tmp = procFdPath(anchorFd, tmpName);
    const anchoredTarget = procFdPath(anchorFd, "review-summary.json");
    let fd: number | undefined;
    try {
      options.beforeTempCreate?.();
      fd = openSync(tmp, "wx", 0o600);
      fchmodSync(fd, 0o600);
      writeFileSync(fd, `${JSON.stringify(document, null, 2)}\n`);
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      options.beforeRename?.();
      renameSync(tmp, anchoredTarget);
      fsyncSync(anchorFd);
    } catch (cause) {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(tmp); } catch { /* absent after rename or failed creation */ }
      throw cause;
    }
    const validation = await validateArtifact(options, target, root);
    return { outcome: validation.status === "passed" ? "persisted" : "incomplete", path: target, validation };
  } finally {
    try { closeSync(anchorFd); }
    finally { closeSync(contextFd); }
  }
}

async function ensureReviewIgnored(root: string, runDir: string, contextFd: number, spawn: typeof spawnExec): Promise<void> {
  const check = async () => spawn(["git", "check-ignore", "-q", "--", join(runDir, "review-summary.json")], {
    cwd: root, timeoutMs: 10_000, maxOutputBytes: 4096,
    env: { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    envMode: "replace",
  });
  const initial = await check();
  if (initial.status === 0) return;
  if (initial.status !== 1) throw new ReviewPersistError("review_ignore_check_failed", `git check-ignore failed with status ${initial.status}`);
  const ignore = procFdPath(contextFd, ".gitignore");
  let existing = Buffer.alloc(0);
  try {
    const stat = lstatSync(ignore);
    if (stat.isSymbolicLink()) throw new ReviewPersistError("review_ignore_symlink", ".context/.gitignore must not be a symlink");
    if (!stat.isFile()) throw new ReviewPersistError("review_ignore_unsafe_target", ".context/.gitignore must be a regular file");
    existing = readFileSync(ignore);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  const entry = Buffer.from("systematic/ce-review/", "utf8");
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
  } catch (cause) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(tmp); } catch { /* best effort cleanup */ }
    throw cause;
  }
  const verified = await check();
  if (verified.status !== 0) throw new ReviewPersistError("review_ignore_ineffective", `git check-ignore did not ignore the review artifact (status ${verified.status})`);
}

async function validateArtifact(options: PersistReviewArtifactOptions, target: string, root: string): Promise<ReviewArtifactValidation> {
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
      cwd: root, timeoutMs: 30_000, maxOutputBytes: 64 * 1024,
      env: { PATH: process.env.PATH ?? "", ...(options.env ?? {}) }, envMode: "replace",
    });
  } catch (cause) {
    return { status: "unavailable", code: "review_artifact_validator_unavailable", reason: cause instanceof Error ? cause.message : "validator could not start" };
  }
  if (result.status === 0 && !result.timedOut && !result.outputTruncated) return { status: "passed", code: "review_artifact_validation_passed" };
  if (result.status === 3 && !result.timedOut) return { status: "failed", code: "review_artifact_validation_failed", reason: result.stderr.slice(0, 4096) };
  return { status: "unavailable", code: "review_artifact_validator_unavailable", reason: `validator exited with status ${result.status}` };
}
