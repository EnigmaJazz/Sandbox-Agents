/**
 * On-disk state-dir artifact retention (transport-artifact GC).
 *
 * A session's transport artifacts are the host-side copies the broker writes
 * under the state dir while moving a result between worker and host:
 *   - <stateDir>/bundles/<id>.bundle           (snapshot + result bundle)
 *   - <stateDir>/tmp/<id>.index                (snapshot temporary git index)
 *   - <stateDir>/tmp/divergence-<id>.index     (S16 divergence temp git index)
 *   - <stateDir>/patches/<id>.patch            (B->C apply patch)
 *   - <stateDir>/apply-preview/<id>.diff       (plain apply-preview diff)
 *   - <stateDir>/apply-preview/<id>.ansi.diff  (ANSI apply-preview diff)
 *
 * Once the result is imported into a host git ref
 * (refs/opencode-sandbox/result/<id>) the ref is the durable copy and these
 * files are redundant. In planned mode (BROKER_GIT_MODE != real) NO host import
 * happens, so the on-disk bundle can be the ONLY copy of the result: it must
 * survive until a durable host ref exists. Nothing else ever deletes these
 * files, so they accumulate forever (the defect this module fixes).
 *
 * Removal is therefore gated on DURABILITY, never on state alone. A session's
 * artifacts are removed only when one of these holds:
 *   - the session record is absent (orphan) after the grace period; or
 *   - a durable host result ref resolves for the session; or
 *   - the record is REJECTED (result deliberately abandoned), or
 *     FAILED_CLOSED with no result ref.
 * Every other case KEEPS the artifact. This module NEVER touches
 * refs/opencode-sandbox/** - deleting a result ref before its result is
 * applied or deliberately preserved is forbidden.
 *
 * Removal is best-effort per item and never throws: a failure is returned so
 * the caller can log it, and one bad file can never abort a sweep or fail an
 * operation (the existing reaper discipline).
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  applyPreviewAnsiPathFor,
  applyPreviewPathFor,
  bundlePathFor,
  patchPathFor,
  resultRef,
} from "./gitops.ts";
import type { SpawnFn } from "./msb.ts";
import type { SessionRecord } from "./types.ts";

export type ArtifactKind =
  | "bundle"
  | "tmp_index"
  | "divergence_index"
  | "patch"
  | "apply_preview"
  | "apply_preview_ansi";

export interface ArtifactPath {
  kind: ArtifactKind;
  path: string;
}

export interface ArtifactRemoval extends ArtifactPath {
  /** Bytes freed. 0 when the file was already absent or could not be removed. */
  bytes: number;
  /** True only when a regular file was actually unlinked. */
  removed: boolean;
  /** Set when the entry exists but could not be removed (never thrown). */
  error?: string;
}

/** <stateDir>/tmp/<sessionID>.index - the snapshot's temporary git index. */
export function tmpIndexPathFor(stateDir: string, sessionID: string): string {
  return join(stateDir, "tmp", `${sessionID}.index`);
}

/**
 * <stateDir>/tmp/divergence-<sessionID>.index - the S16 divergence temp index.
 * Session-scoped (not a random UUID) so the same retention rules can target it;
 * one apply per session is serialized by the per-session lock, so a stable name
 * cannot collide.
 */
export function divergenceIndexPathFor(
  stateDir: string,
  sessionID: string,
): string {
  return join(stateDir, "tmp", `divergence-${sessionID}.index`);
}

/** The session-scoped transport artifacts (bundle first). */
export function sessionArtifactPaths(
  stateDir: string,
  sessionID: string,
): ArtifactPath[] {
  return [
    { kind: "bundle", path: bundlePathFor(stateDir, sessionID) },
    { kind: "tmp_index", path: tmpIndexPathFor(stateDir, sessionID) },
    {
      kind: "divergence_index",
      path: divergenceIndexPathFor(stateDir, sessionID),
    },
    { kind: "patch", path: patchPathFor(stateDir, sessionID) },
    { kind: "apply_preview", path: applyPreviewPathFor(stateDir, sessionID) },
    {
      kind: "apply_preview_ansi",
      path: applyPreviewAnsiPathFor(stateDir, sessionID),
    },
  ];
}

/**
 * Remove one artifact, returning the bytes freed. Never throws: a missing file
 * is a no-op (idempotent) and a bad entry is reported through `error`.
 */
export function removeArtifact(artifact: ArtifactPath): ArtifactRemoval {
  try {
    if (!existsSync(artifact.path)) {
      return { ...artifact, bytes: 0, removed: false };
    }
    const stat = statSync(artifact.path);
    if (!stat.isFile()) {
      return {
        ...artifact,
        bytes: 0,
        removed: false,
        error: `${artifact.kind} is not a regular file`,
      };
    }
    const bytes = stat.size;
    rmSync(artifact.path, { force: true });
    return { ...artifact, bytes, removed: true };
  } catch (err) {
    return {
      ...artifact,
      bytes: 0,
      removed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Remove one session's six transport artifacts. Never throws (per-item catch).
 * Callers MUST have established the durability rule first (see
 * `shouldRemoveSessionArtifacts`); this function does not decide by itself.
 */
export function removeSessionArtifacts(
  stateDir: string,
  sessionID: string,
): ArtifactRemoval[] {
  return sessionArtifactPaths(stateDir, sessionID).map(removeArtifact);
}

// ---------------------------------------------------------------------------
// Durability gate
// ---------------------------------------------------------------------------

type RemovableRecord = Pick<SessionRecord, "state" | "resultRef">;

/**
 * True when the removal decision for this record depends on a durable host
 * result ref. REJECTED and result-less FAILED_CLOSED are already safe to
 * remove; every other state must prove durability first.
 */
export function removalNeedsDurableRef(record: RemovableRecord): boolean {
  if (record.state === "REJECTED") return false;
  if (record.state === "FAILED_CLOSED") return record.resultRef != null;
  return true;
}

/**
 * The single removal predicate. `durable` is the result of
 * `durableHostRefResolves` (false when it was not applicable or did not
 * resolve). Only the three documented cases return true.
 */
export function shouldRemoveSessionArtifacts(
  record: RemovableRecord,
  durable: boolean,
): boolean {
  if (record.state === "REJECTED") return true;
  if (record.state === "FAILED_CLOSED") {
    return record.resultRef == null || durable;
  }
  // APPLIED / RETAINED / any other state: the durable ref is the only proof
  // that the on-disk artifact is redundant.
  return durable;
}

/** Minimal slice of OpContext the durability probe needs. */
export interface DurableRefContext {
  git?: { spawn?: SpawnFn };
  config?: { projects?: readonly { id: string; path: string }[] };
}

/**
 * Does a durable host result ref resolve for this session? Read-only probe
 * through the existing host git runner. Fails closed (false) on any missing
 * input, a non-allowlisted project, a non-zero rev-parse, or a spawn error: a
 * false answer only ever KEEPS artifacts, never deletes them.
 */
export async function durableHostRefResolves(
  ctx: DurableRefContext,
  record: Pick<SessionRecord, "sessionID" | "projectID">,
): Promise<boolean> {
  const git = ctx.git;
  if (!git || typeof git.spawn !== "function") return false;
  const projectID = record.projectID;
  if (!projectID) return false;
  const project = ctx.config?.projects?.find((p) => p.id === projectID);
  if (!project) return false;
  try {
    const res = await git.spawn(
      ["git", "rev-parse", "--verify", "--quiet", resultRef(record.sessionID)],
      { cwd: project.path, timeoutMs: 30_000 },
    );
    return res.status === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Orphan scan (files whose owning session record is gone)
// ---------------------------------------------------------------------------

export interface OrphanArtifactCandidate extends ArtifactPath {
  /**
   * Session id encoded in the filename, or null for a file with no session
   * linkage. The sweep uses it to skip artifacts owned by a KNOWN live session.
   */
  sessionKey: string | null;
}

/** readdir that never throws: a missing/unreadable dir is an empty listing. */
function listDirNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Enumerate every state-dir transport file that can be attributed to a session
 * (or, for the divergence temp index, that is pure scratch). The sweep runs
 * each through the same grace + known-session filter before removal.
 */
export function listOrphanArtifactCandidates(
  stateDir: string,
): OrphanArtifactCandidate[] {
  const out: OrphanArtifactCandidate[] = [];

  const bundlesDir = join(stateDir, "bundles");
  for (const name of listDirNames(bundlesDir)) {
    if (!name.endsWith(".bundle")) continue;
    out.push({
      kind: "bundle",
      path: join(bundlesDir, name),
      sessionKey: name.slice(0, -".bundle".length),
    });
  }

  const patchesDir = join(stateDir, "patches");
  for (const name of listDirNames(patchesDir)) {
    if (!name.endsWith(".patch")) continue;
    out.push({
      kind: "patch",
      path: join(patchesDir, name),
      sessionKey: name.slice(0, -".patch".length),
    });
  }

  const previewDir = join(stateDir, "apply-preview");
  for (const name of listDirNames(previewDir)) {
    if (name.endsWith(".ansi.diff")) {
      out.push({
        kind: "apply_preview_ansi",
        path: join(previewDir, name),
        sessionKey: name.slice(0, -".ansi.diff".length),
      });
    } else if (name.endsWith(".diff")) {
      out.push({
        kind: "apply_preview",
        path: join(previewDir, name),
        sessionKey: name.slice(0, -".diff".length),
      });
    }
  }

  const tmpDir = join(stateDir, "tmp");
  const divergencePrefix = "divergence-";
  const indexSuffix = ".index";
  for (const name of listDirNames(tmpDir)) {
    if (!name.startsWith(divergencePrefix) || !name.endsWith(indexSuffix)) {
      continue;
    }
    out.push({
      kind: "divergence_index",
      path: join(tmpDir, name),
      sessionKey: name.slice(divergencePrefix.length, -indexSuffix.length),
    });
  }

  return out;
}
