/**
 * Git snapshot / result boundary (SYSTEM_PROMPT.md §17-§20, S15/S16).
 *
 * The snapshot represents HEAD + staged + unstaged + untracked non-ignored
 * files WITHOUT changing the host working tree or the user's real index:
 * a temporary GIT_INDEX_FILE drives `git add -A` / `write-tree` /
 * `commit-tree`, producing a synthetic baseline commit B stored under
 * refs/opencode-sandbox/baseline/<sessionID>. The user's branch is never
 * moved, the real index is never touched, and ignored files (incl. secrets)
 * are never included.
 *
 * Results return as a bundle imported under
 * refs/opencode-sandbox/result/<sessionID>; only the B->C delta is applied,
 * and only after the S16 divergence check plus §19 path/symlink/submodule
 * checks.
 *
 * Gate 1: the PURE parts (ref naming, raw-diff classification, protected-path
 * checks, divergence comparison, argv planning) are unit-tested here. Actual
 * git execution is only wired through the broker at Gate 5+.
 */
import { join } from "node:path";
import { assertRefComponent, ValidationError } from "./validation.ts";

export const BASELINE_REF_PREFIX = "refs/opencode-sandbox/baseline";
export const RESULT_REF_PREFIX = "refs/opencode-sandbox/result";

export function baselineRef(sessionID: string): string {
  assertRefComponent(sessionID);
  return `${BASELINE_REF_PREFIX}/${sessionID}`;
}

export function resultRef(sessionID: string): string {
  assertRefComponent(sessionID);
  return `${RESULT_REF_PREFIX}/${sessionID}`;
}

// ---------------------------------------------------------------------------
// Snapshot plan (argv vectors; NOT executed in unit tests)
// ---------------------------------------------------------------------------

export interface GitPlan {
  /** Env for every command in `argvSteps` (temp index, explicit git dir). */
  env: Record<string, string>;
  argvSteps: string[][];
}

/**
 * Build the snapshot command plan. `gitEnvDir` is the repository's .git dir;
 * `tmpIndex` is a broker-owned temp file. No command in the plan touches the
 * real index or any user branch.
 */
export function buildSnapshotPlan(
  gitDir: string,
  tmpIndex: string,
  sessionID: string,
  author: string,
): GitPlan {
  const ref = baselineRef(sessionID);
  const env = {
    GIT_DIR: gitDir,
    GIT_INDEX_FILE: tmpIndex,
  };
  return {
    env,
    argvSteps: [
      // Stage working tree (HEAD + staged + unstaged + untracked non-ignored)
      // into the TEMPORARY index only.
      ["git", "add", "-A", "--"],
      ["git", "write-tree"],
      // Synthetic baseline commit B whose parent is real HEAD.
      ["git", "commit-tree", "<TREE>", "-p", "HEAD", "-m", `opencode-sandbox baseline for ${sessionID}`, `--author=${author}`],
      // Publish B under the sandbox ref namespace (not a user branch).
      ["git", "update-ref", ref, "<COMMIT>"],
      // Transfer bundle for the worker.
      ["git", "bundle", "create", "<BUNDLE>", ref],
    ],
  };
}

export function buildResultImportPlan(gitDir: string, bundlePath: string, sessionID: string): GitPlan {
  const ref = resultRef(sessionID);
  return {
    env: { GIT_DIR: gitDir },
    argvSteps: [
      // Import the worker bundle; the ref is fetched into the sandbox
      // namespace so the worker's result branch is never a host branch.
      ["git", "bundle", "verify", bundlePath],
      ["git", "fetch", "--no-tags", bundlePath, `${ref}:${ref}`],
    ],
  };
}

export function buildDiffArgv(baseline: string, result: string): string[][] {
  return [
    ["git", "diff", "--stat", baseline, result],
    ["git", "diff", "--raw", "-z", baseline, result],
  ];
}

/**
 * Apply plan: produce the B->C patch and apply it to the HOST working tree
 * with `git apply` (working tree only — never touches index or branch).
 */
export function buildApplyArgv(
  baseline: string,
  result: string,
  patchFile: string,
): string[][] {
  return [
    ["git", "diff", baseline, result, "--", ".", ":(exclude).git"],
    ["git", "apply", "--check", "--whitelist=", patchFile],
    ["git", "apply", patchFile],
  ];
}

// ---------------------------------------------------------------------------
// Raw diff classification (§19 checks 2-5)
// ---------------------------------------------------------------------------

export type ChangeKind = "added" | "modified" | "deleted" | "symlink" | "submodule" | "mode";

export interface FileChange {
  path: string;
  kind: ChangeKind;
  oldMode?: string;
  newMode?: string;
}

const RAW_DIFF_RE = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([ACDMRTUX])\d{0,3}\t(.+)$/;

/**
 * Classify `git diff --raw` lines into FileChange records. Pure, parseable
 * with no git binary. Lines that do not parse are ignored (callers may
 * count them to detect a malformed diff — fail closed).
 */
export function classifyRawDiff(lines: readonly string[]): FileChange[] {
  const out: FileChange[] = [];
  for (const raw of lines) {
    const m = RAW_DIFF_RE.exec(raw);
    if (!m) continue;
    const oldMode = m[1];
    const newMode = m[2];
    const status = m[3];
    const path = m[4];
    const mode = newMode ?? oldMode ?? "";
    const isSymlink = mode.startsWith("120000");
    const isSubmodule = mode.startsWith("160000");
    let kind: ChangeKind;
    if (isSymlink) kind = "symlink";
    else if (isSubmodule) kind = "submodule";
    else if (status === "A") kind = "added";
    else if (status === "D") kind = "deleted";
    else if (status === "M" && oldMode !== newMode) kind = "mode";
    else kind = "modified";
    out.push({ path, kind, oldMode, newMode });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Protected-path checks (§19.3, S7, S17)
// ---------------------------------------------------------------------------

/** Minimal glob matcher supporting `*` (within a segment) and `**` (any depth). */
export function globMatch(pattern: string, path: string): boolean {
  const regex = globToRegex(pattern);
  return regex.test(path);
}

export function globToRegex(pattern: string): RegExp {
  let out = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` matches zero or more path segments; a trailing `**` matches
        // the remainder of the path (including nothing).
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if ("\\.+(){}[]^$|".includes(c)) {
      out += `\\${c}`;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  out += "$";
  return new RegExp(out);
}

/**
 * Return the subset of `changed` paths that match any protected pattern.
 * Empty result = safe to proceed.
 */
export function checkProtectedPaths(
  changed: readonly string[],
  protectedPatterns: readonly string[],
): string[] {
  const rejected: string[] = [];
  for (const path of changed) {
    for (const pattern of protectedPatterns) {
      if (globMatch(pattern, path)) {
        rejected.push(path);
        break;
      }
    }
  }
  return rejected;
}

// ---------------------------------------------------------------------------
// Divergence (S16, §19.1)
// ---------------------------------------------------------------------------

/** path -> git blob/tree OID. */
export type TreeEntries = ReadonlyMap<string, string>;

export function parseLsTreeLines(lines: readonly string[]): TreeEntries {
  const map = new Map<string, string>();
  // Format: <mode> SP <type> SP <oid> TAB <path>
  for (const line of lines) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const meta = line.slice(0, tab);
    const path = line.slice(tab + 1);
    const parts = meta.split(" ");
    if (parts.length >= 3) {
      map.set(path, parts[2] ?? "");
    }
  }
  return map;
}

export function parseLsFilesLines(lines: readonly string[]): TreeEntries {
  const map = new Map<string, string>();
  // Format: <mode> SP <oid> SP <stage> TAB <path>
  for (const line of lines) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const meta = line.slice(0, tab);
    const path = line.slice(tab + 1);
    const parts = meta.split(" ");
    if (parts.length >= 2) {
      map.set(path, parts[1] ?? "");
    }
  }
  return map;
}

/**
 * S16 host divergence: compare the host's current tree with the baseline
 * tree the worker was created from. Returns paths whose OID differs or that
 * exist in only one side. Empty result = host still matches baseline.
 */
export function computeDivergence(baseline: TreeEntries, current: TreeEntries): string[] {
  const diverged: string[] = [];
  const allPaths = new Set([...baseline.keys(), ...current.keys()]);
  for (const path of allPaths) {
    if ((baseline.get(path) ?? "") !== (current.get(path) ?? "")) {
      diverged.push(path);
    }
  }
  return diverged.sort();
}

/**
 * §19.6: verify the B->C delta applies to the host with `git apply --check`.
 * The argv is constructed here (pure); execution is broker-gated.
 */
export function buildCheckArgv(patchFile: string): string[] {
  if (patchFile.includes("\u0000")) {
    throw new ValidationError("patchFile must not contain NUL");
  }
  return ["git", "apply", "--check", patchFile];
}

export function patchPathFor(stateDir: string, sessionID: string): string {
  return join(stateDir, "patches", `${sessionID}.patch`);
}

export function bundlePathFor(stateDir: string, sessionID: string): string {
  return join(stateDir, "bundles", `${sessionID}.bundle`);
}
