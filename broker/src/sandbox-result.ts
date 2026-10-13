/**
 * T1 (read) — host sandbox-result inspection (`sandboxResult`).
 *
 * Read-only, fixed-argv helpers for the broker-side `sandboxResult` host
 * operation. The caller (service.ts) resolves the broker-owned refs from a
 * session id; this module never accepts a raw ref, a caller-supplied path
 * list, or a shell string, and it never writes the working tree, the index,
 * or any ref.
 *
 * Reuse (do not reinvent): the authoritative changed-path list comes from
 * `buildChangedPathsArgv`, and the bounded output goes through the shared
 * 512-KiB cap + redaction path (`GIT_OUTPUT_MAX_BYTES` / `capAndRedact`).
 * `git diff --numstat` supplies the per-file added/removed counts.
 */
import type { OpContext } from "./service.ts";
import {
  buildChangedPathsArgv,
  type FileChange,
  capAndRedact,
  GIT_OUTPUT_MAX_BYTES,
  parseNulDelimitedPaths,
} from "./gitops.ts";
import { redact } from "./logging.ts";
import { StateError } from "./state.ts";
import { assertProjectRelativePath, ValidationError } from "./validation.ts";

// ---------------------------------------------------------------------------
// Fixed argv vectors
// ---------------------------------------------------------------------------

/** Commit identity + committer timestamp for one broker-resolved ref. */
export function buildResultIdentityArgv(ref: string): string[] {
  return ["git", "show", "-s", "--format=%H%x00%cI%x00%s", ref];
}

/** Per-file added/removed counts between two broker-resolved refs. */
export function buildNumstatArgv(from: string, to: string): string[] {
  return ["git", "diff", "--numstat", "--no-renames", "-z", from, to, "--", "."];
}

/** Plain unified patch between two broker-resolved refs (working tree untouched). */
export function buildResultPatchArgv(from: string, to: string): string[] {
  return ["git", "diff", from, to, "--", "."];
}

// ---------------------------------------------------------------------------
// T2 install argv (fixed vectors; working-tree only, index never staged)
// ---------------------------------------------------------------------------

/** Repo-relative result-diff paths, validated before they reach any argv. */
export function assertResultDiffPaths(paths: readonly string[], what: string): void {
  if (paths.length === 0) throw new ValidationError(`${what} must not be empty`);
  for (const path of paths) {
    if (path === "-") throw new ValidationError(`${what} must be a repo-relative path`);
    assertProjectRelativePath(path, what);
  }
}

/** Restore the listed present paths from the result ref (worktree only). */
export function buildResultRestoreArgv(resultRef: string, paths: readonly string[]): string[] {
  assertResultDiffPaths(paths, "result restore path");
  return ["git", "restore", `--source=${resultRef}`, "--worktree", "--", ...paths];
}

/** Resolve the result ref to the exact commit the install will read. */
export function buildResultCommitArgv(ref: string): string[] {
  return ["git", "rev-parse", "--verify", `${ref}^{commit}`];
}

/** Remove the listed result-deleted paths from the working tree (never stages). */
export function buildResultDeleteArgv(paths: readonly string[]): string[] {
  assertResultDiffPaths(paths, "result deleted path");
  return ["rm", "-f", "--", ...paths];
}

export interface SandboxResultInstallPlan {
  restorePaths: string[];
  deletePaths: string[];
}

/**
 * Split a classified result diff into the paths to restore (present in the
 * result ref) and the paths to delete (absent from it). Pure; fail closed on a
 * malformed classification rather than guessing.
 */
export function planSandboxResultInstall(
  changes: readonly FileChange[],
): SandboxResultInstallPlan {
  const restorePaths: string[] = [];
  const deletePaths: string[] = [];
  for (const change of changes) {
    if (change.kind === "deleted") deletePaths.push(change.path);
    else restorePaths.push(change.path);
  }
  return {
    restorePaths: [...new Set(restorePaths)].sort(),
    deletePaths: [...new Set(deletePaths)].sort(),
  };
}

// ---------------------------------------------------------------------------
// Parsers (pure; fail closed on malformed bytes)
// ---------------------------------------------------------------------------

export interface RefIdentity {
  commit: string;
  committedAt: string;
  subject: string;
}

/** Parse `git show -s --format=%H%x00%cI%x00%s`; fail closed on malformed output. */
export function parseResultIdentity(output: string): RefIdentity {
  const trimmed = output.endsWith("\n") ? output.slice(0, -1) : output;
  const parts = trimmed.split("\u0000");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new ValidationError("cannot parse result identity: malformed git show output");
  }
  return { commit: parts[0]!, committedAt: parts[1]!, subject: parts[2]! };
}

export interface NumstatEntry {
  path: string;
  added: number | null;
  removed: number | null;
}

function parseNumstatCount(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new ValidationError("cannot parse result numstat: non-numeric count");
  }
  return Number.parseInt(value, 10);
}

/**
 * Parse `git diff --numstat -z` records (`<added>\t<removed>\t<path>\0`).
 * Binary files report `-`/`-`; those stay null. Fail closed on malformed bytes.
 */
export function parseNumstat(output: string): NumstatEntry[] {
  if (output.length === 0) return [];
  if (!output.endsWith("\u0000")) {
    throw new ValidationError("cannot parse result numstat: incomplete output");
  }
  const records = output.slice(0, -1).split("\u0000");
  const entries: NumstatEntry[] = [];
  for (const record of records) {
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab <= 0 || secondTab <= firstTab + 1) {
      throw new ValidationError("cannot parse result numstat: malformed record");
    }
    const addedRaw = record.slice(0, firstTab);
    const removedRaw = record.slice(firstTab + 1, secondTab);
    const path = record.slice(secondTab + 1);
    if (path.length === 0) {
      throw new ValidationError("cannot parse result numstat: empty path");
    }
    entries.push({
      path,
      added: addedRaw === "-" ? null : parseNumstatCount(addedRaw),
      removed: removedRaw === "-" ? null : parseNumstatCount(removedRaw),
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Read steps (fixed argv; bounded; never mutate)
// ---------------------------------------------------------------------------

/** One read-only git step; fails closed on timeout or a non-zero exit. */
async function runReadStep(
  ctx: OpContext,
  argv: string[],
  cwd: string,
  what: string,
): Promise<string> {
  const result = await ctx.git.spawn(argv, {
    cwd,
    timeoutMs: 60_000,
    maxOutputBytes: GIT_OUTPUT_MAX_BYTES,
  });
  if (result.timedOut) throw new StateError(`${what}: git timed out`);
  if (result.status !== 0) {
    throw new StateError(`${what}: ${result.stderr.trim().slice(0, 500)}`);
  }
  return result.stdout;
}

async function readRefIdentity(
  ctx: OpContext,
  cwd: string,
  ref: string,
): Promise<RefIdentity> {
  const stdout = await runReadStep(
    ctx,
    buildResultIdentityArgv(ref),
    cwd,
    "cannot read result identity",
  );
  return parseResultIdentity(stdout);
}

/**
 * Changed paths with per-file counts. The numstat list is cross-checked
 * against the authoritative `--name-only` list from `buildChangedPathsArgv`;
 * a disagreement fails closed rather than returning partial metadata.
 */
async function readChangedPaths(
  ctx: OpContext,
  cwd: string,
  from: string,
  to: string,
): Promise<NumstatEntry[]> {
  const numstatOut = await runReadStep(
    ctx,
    buildNumstatArgv(from, to),
    cwd,
    "cannot read result numstat",
  );
  if (Buffer.byteLength(numstatOut, "utf8") >= GIT_OUTPUT_MAX_BYTES) {
    throw new StateError("cannot read result numstat: metadata exceeded the output cap");
  }
  const entries = parseNumstat(numstatOut);

  const pathsOut = await runReadStep(
    ctx,
    buildChangedPathsArgv(from, to),
    cwd,
    "cannot read result paths",
  );
  if (Buffer.byteLength(pathsOut, "utf8") >= GIT_OUTPUT_MAX_BYTES) {
    throw new StateError("cannot read result paths: metadata exceeded the output cap");
  }
  const parsed = parseNulDelimitedPaths(pathsOut);
  if (!parsed.complete) {
    throw new StateError("cannot read result paths: changed path metadata incomplete");
  }
  const numstatPaths = entries.map((entry) => entry.path).sort();
  const changedPaths = [...parsed.paths].sort();
  if (
    numstatPaths.length !== changedPaths.length ||
    numstatPaths.some((path, index) => path !== changedPaths[index])
  ) {
    throw new StateError(
      "cannot read result numstat: path list disagrees with the changed-path list",
    );
  }
  return entries;
}

async function readPatch(
  ctx: OpContext,
  cwd: string,
  from: string,
  to: string,
): Promise<{ text: string; truncated: boolean }> {
  const stdout = await runReadStep(
    ctx,
    buildResultPatchArgv(from, to),
    cwd,
    "cannot read result patch",
  );
  const text = capAndRedact(stdout);
  const truncated = Buffer.byteLength(text, "utf8") !== Buffer.byteLength(redact(stdout), "utf8");
  return { text, truncated };
}

// ---------------------------------------------------------------------------
// Operation payload
// ---------------------------------------------------------------------------

export interface SandboxResultComparison {
  from: { ref: string; commit: string };
  to: { ref: string; commit: string };
  changedPaths: NumstatEntry[];
  patch: string;
  patchTruncated: boolean;
}

export interface SandboxResultReadPayload {
  mode: "result" | "compare";
  sessionID: string;
  result: { ref: string } & RefIdentity;
  baseline: { ref: string };
  changedPaths: NumstatEntry[];
  patch: string;
  patchTruncated: boolean;
  comparison: SandboxResultComparison | null;
}

/**
 * Inspect a resolved B→C result. `baseline`/`result` are broker-resolved refs;
 * `compare` (optional) is a second broker-resolved result ref for the two-ref
 * comparison mode. Nothing here mutates the repository.
 */
export async function readSandboxResult(
  ctx: OpContext,
  projectRoot: string,
  sessionID: string,
  baseline: string,
  result: string,
  compare: { sessionID: string; result: string } | null,
): Promise<SandboxResultReadPayload> {
  const identity = await readRefIdentity(ctx, projectRoot, result);
  const changedPaths = await readChangedPaths(ctx, projectRoot, baseline, result);
  const patch = await readPatch(ctx, projectRoot, baseline, result);

  let comparison: SandboxResultComparison | null = null;
  if (compare !== null) {
    const otherIdentity = await readRefIdentity(ctx, projectRoot, compare.result);
    const otherPaths = await readChangedPaths(ctx, projectRoot, result, compare.result);
    const otherPatch = await readPatch(ctx, projectRoot, result, compare.result);
    comparison = {
      from: { ref: result, commit: identity.commit },
      to: { ref: compare.result, commit: otherIdentity.commit },
      changedPaths: otherPaths,
      patch: otherPatch.text,
      patchTruncated: otherPatch.truncated,
    };
  }

  return {
    mode: comparison === null ? "result" : "compare",
    sessionID,
    result: { ref: result, ...identity },
    baseline: { ref: baseline },
    changedPaths,
    patch: patch.text,
    patchTruncated: patch.truncated,
    comparison,
  };
}
