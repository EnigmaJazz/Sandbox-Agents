import { readdirSync } from "node:fs";
import { spawnExec, type SpawnFn, type SpawnResult } from "./msb.ts";
import {
  assertReviewRunId,
  assertRunOwnership,
  readRunArtifact,
  ReviewRunError,
  ReviewRunStore,
  type ReviewRunRecord,
} from "./review-run.ts";

export const REVIEW_SLICE_MAX_LINES = 1500;
export const REVIEW_SLICE_MAX_BYTES = 45 * 1024;
export const REVIEW_SLICE_READ_MAX_BYTES = 64 * 1024;
const OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export class ReviewMaterializeError extends ReviewRunError {
  constructor(code: string, message: string) { super(code, message); }
}
export class ReviewRangeRefError extends ReviewMaterializeError {
  constructor(ref: string) { super("review_range_ref_unresolvable", `review range ref '${ref}' did not resolve to a commit`); }
}
export class ReviewRangeObjectIdError extends ReviewMaterializeError {
  constructor(ref: string) { super("review_range_object_id_invalid", `git returned an invalid object id while resolving ref '${ref}'`); }
}
export class ReviewWorkspaceUnsupportedError extends ReviewMaterializeError {
  constructor() { super("review_workspace_not_supported", "workspace mode is not supported in this slice: safe index/tree diffing without hooks or filters is not available"); }
}
export class ReviewRangeCapError extends ReviewMaterializeError {
  constructor(bytes: number, cap: number) { super("review_range_byte_cap", `review range is ${bytes} bytes, over the per-run byte cap of ${cap}`); }
}
export class ReviewFileSliceCapError extends ReviewMaterializeError {
  constructor(path: string, lines: number, bytes: number) { super("review_range_file_slice_cap", `file '${path}' requires ${lines} lines and ${bytes} bytes, over a slice budget of ${REVIEW_SLICE_MAX_LINES} lines or ${REVIEW_SLICE_MAX_BYTES} bytes`); }
}
export class ReviewSliceNotFoundError extends ReviewMaterializeError {
  constructor(name: string) { super("review_slice_not_found", `review slice '${name}' does not exist`); }
}

export interface MaterializeReviewPayload { baseRef: string; headRef?: string; contextLines?: number; paths?: string[]; mode?: "committed" | "workspace"; }
export interface ReviewMaterializeOptions {
  projectRoot: string;
  store: ReviewRunStore;
  gitBinary?: string;
  /** Test seam; production defaults to replacement-env Git spawning with hardening. */
  spawn?: SpawnFn;
}
export interface ReviewSliceIndex { name: string; bytes: number; sha256: string; }
export interface ReviewMaterializeIndex {
  runId: string; baseObjectId: string; headObjectId: string; changedPaths: string[];
  sliceCount: number; slices: ReviewSliceIndex[]; totalBytes: number;
}

function invokeGit(spawn: SpawnFn, binary: string, args: string[], cwd: string, env: Record<string, string>): Promise<SpawnResult> {
  return spawn([binary, ...args], { cwd, env, timeoutMs: 30_000, maxOutputBytes: 9 * 1024 * 1024 });
}
const spawnWithReplacementEnv: SpawnFn = (argv, opts) => spawnExec(argv, { ...opts, envMode: "replace" });
async function resolveCommit(ref: string, opts: ReviewMaterializeOptions): Promise<string> {
  let result: SpawnResult;
  try {
    result = await invokeGit(opts.spawn ?? spawnWithReplacementEnv, opts.gitBinary ?? "git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], opts.projectRoot, { PATH: process.env.PATH ?? "" });
  } catch {
    throw new ReviewRangeRefError(ref);
  }
  if (result.status !== 0 || result.timedOut || result.outputTruncated) throw new ReviewRangeRefError(ref);
  const oid = result.stdout.trim();
  if (!OBJECT_ID_RE.test(oid)) throw new ReviewRangeObjectIdError(ref);
  return oid;
}
function splitFileSections(diff: Buffer, paths: string[]): { path: string; data: Buffer; lines: number }[] {
  if (diff.length === 0) return [];
  const text = diff.toString("latin1");
  const starts: number[] = [];
  const marker = /^diff --git /gm;
  for (let match = marker.exec(text); match; match = marker.exec(text)) starts.push(match.index);
  if (starts.length !== paths.length || starts[0] !== 0) throw new ReviewMaterializeError("review_range_diff_parse", "git diff file sections did not match the changed-path manifest");
  return starts.map((start, i) => {
    const end = starts[i + 1] ?? diff.length;
    const data = diff.subarray(start, end);
    return { path: paths[i]!, data, lines: data.toString("utf8").split("\n").length - (data.length > 0 && data[data.length - 1] === 10 ? 1 : 0) };
  });
}
function packSlices(sections: ReturnType<typeof splitFileSections>): Buffer[] {
  const slices: Buffer[] = [];
  let current: Buffer[] = [];
  let bytes = 0;
  let lines = 0;
  for (const section of sections) {
    if (section.data.byteLength > REVIEW_SLICE_MAX_BYTES || section.lines > REVIEW_SLICE_MAX_LINES) {
      throw new ReviewFileSliceCapError(section.path, section.lines, section.data.byteLength);
    }
    if (current.length > 0 && (bytes + section.data.byteLength > REVIEW_SLICE_MAX_BYTES || lines + section.lines > REVIEW_SLICE_MAX_LINES)) {
      slices.push(Buffer.concat(current)); current = []; bytes = 0; lines = 0;
    }
    current.push(section.data); bytes += section.data.byteLength; lines += section.lines;
  }
  if (current.length) slices.push(Buffer.concat(current));
  return slices;
}

export async function materializeReviewRange(payload: MaterializeReviewPayload, sessionID: string, options: ReviewMaterializeOptions): Promise<ReviewMaterializeIndex> {
  if (payload.mode === "workspace") throw new ReviewWorkspaceUnsupportedError();
  options.store.assertRunAdmission(sessionID);
  const headRef = payload.headRef ?? "HEAD";
  const baseObjectId = await resolveCommit(payload.baseRef, options);
  const headObjectId = await resolveCommit(headRef, options);
  const spawn = options.spawn ?? spawnWithReplacementEnv;
  const binary = options.gitBinary ?? "git";
  const env = { PATH: process.env.PATH ?? "" };
  const contextLines = payload.contextLines ?? 3;
  if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > 100) throw new ReviewMaterializeError("review_range_context_invalid", "contextLines must be an integer from 0 through 100");
  const paths = payload.paths ?? [];
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string" || path.includes("\0"))) throw new ReviewMaterializeError("review_range_paths_invalid", "paths must be an array of strings without NUL bytes");
  const pathArgs = ["--", ...paths];
  const diffResult = await invokeGit(spawn, binary, ["diff", "--no-ext-diff", "--no-color", "--no-textconv", `-U${contextLines}`, baseObjectId, headObjectId, ...pathArgs], options.projectRoot, env);
  if (diffResult.status !== 0 || diffResult.timedOut || diffResult.outputTruncated) throw new ReviewMaterializeError("review_range_diff_failed", "git diff failed or exceeded its output bound");
  const diff = diffResult.stdoutBytes ?? Buffer.from(diffResult.stdout, "utf8");
  const cap = options.store.caps.maxBytes;
  if (diff.byteLength > cap) throw new ReviewRangeCapError(diff.byteLength, cap);
  const namesResult = await invokeGit(spawn, binary, ["diff", "--no-ext-diff", "--no-color", "--no-textconv", "--name-only", "-z", baseObjectId, headObjectId, ...pathArgs], options.projectRoot, env);
  if (namesResult.status !== 0 || namesResult.timedOut || namesResult.outputTruncated) throw new ReviewMaterializeError("review_range_manifest_failed", "git changed-path manifest failed");
  const changedPaths = namesResult.stdout.split("\0").filter(Boolean);
  const sections = splitFileSections(diff, changedPaths);
  const slices = packSlices(sections);
  const writer = options.store.createRun(sessionID, { baseObjectId, headObjectId });
  try {
    writer.record.changedPaths = changedPaths;
    writer.record.totalBytes = diff.byteLength;
    writer.addArtifact("scope.diff", diff);
    const index: ReviewSliceIndex[] = [];
    for (let i = 0; i < slices.length; i += 1) {
      index.push(writer.addArtifact(`slice-${String(i).padStart(4, "0")}.diff`, slices[i]!));
    }
    writer.publish();
    return { runId: writer.record.runId, baseObjectId, headObjectId, changedPaths, sliceCount: index.length, slices: index, totalBytes: diff.byteLength };
  } catch (error) {
    writer.fail();
    throw error;
  }
}

export async function readReviewSlice(runId: string, name: string, sessionID: string, options: Pick<ReviewMaterializeOptions, "store">): Promise<string> {
  assertReviewRunId(runId);
  if (!/^slice-[0-9]{4}\.diff$/.test(name)) throw new ReviewSliceNotFoundError(name);
  let runDir: string | undefined;
  let record: ReviewRunRecord | undefined;
  for (const candidateSession of readdirSync(options.store.root)) {
    let candidateDir: string;
    try { candidateDir = options.store.runDir(candidateSession, runId); } catch { continue; }
    try {
      const candidateRecord = JSON.parse(readRunArtifact({ runDir: candidateDir, name: "metadata.json", allowRecord: true, maxFileBytes: 1024 * 1024 }).data.toString("utf8")) as ReviewRunRecord;
      if (candidateRecord.runId === runId) { runDir = candidateDir; record = candidateRecord; break; }
    } catch { /* an unrelated session directory or run is not a match */ }
  }
  if (!runDir || !record) throw new ReviewSliceNotFoundError(name);
  assertRunOwnership(record, sessionID);
  if (record.state !== "published") throw new ReviewMaterializeError("review_run_not_published", "review run is not published");
  const artifact = record.artifacts.find((item) => item.name === name);
  if (!artifact) throw new ReviewSliceNotFoundError(name);
  return readRunArtifact({ runDir, name, maxFileBytes: REVIEW_SLICE_READ_MAX_BYTES }).data.toString("utf8");
}
