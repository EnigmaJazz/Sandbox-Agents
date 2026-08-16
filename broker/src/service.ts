/**
 * Broker domain operations (SYSTEM_PROMPT.md §7, §10, §17-§20, §28).
 *
 * Each operation is a pure-ish function of an OpContext: state machine
 * transitions, policy admission, msb adapter calls, git snapshot/result
 * boundary, structured host reads. Every error path fails closed (S14).
 *
 * Gate 1 note: git execution defaults to "planned" mode — the snapshot and
 * result steps verify and FAIL with a clear message instead of running git
 * against the host repo. Set BROKER_GIT_MODE=real only after Gate 5 review.
 */
import { existsSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { BrokerConfig } from "./config.ts";
import type { SessionStore } from "./state.ts";
import type { MsbAdapter } from "./msb.ts";
import type { HostReadExecutor } from "./hostread.ts";
import type { Logger } from "./logging.ts";
import type { Budget, HostResources, WorkerPool } from "./policy.ts";
import type { SpawnFn } from "./msb.ts";
import {
  assertArgv,
  assertContent,
  assertGrepQuery,
  assertPayloadKeys,
  assertPositiveInt,
  assertSandboxPath,
  resolveProjectID,
  ValidationError,
} from "./validation.ts";
import {
  baselineRef,
  resultRef,
  buildCheckArgv,
  bundlePathFor,
  patchPathFor,
  classifyRawDiff,
  checkProtectedPaths,
  computeDivergence,
  parseLsFilesLines,
  parseLsTreeLines,
} from "./gitops.ts";
import { MsbError } from "./msb.ts";
import { StateError } from "./state.ts";
import { PolicyError, checkAdmission } from "./policy.ts";
import type { BrokerRequestEnvelope, SessionRecord, WorkerRecord, MetricsRecord, PolicyRecord, Operation } from "./types.ts";

export interface OpContext {
  config: BrokerConfig;
  store: SessionStore;
  adapter: MsbAdapter;
  budget: Budget;
  resources: HostResources;
  pool: WorkerPool;
  hostRead: HostReadExecutor;
  logger: Logger;
  git: {
    spawn: SpawnFn;
    /** "planned" (Gate 1 default) or "real" (Gate 5+, after review). */
    runnerMode: "planned" | "real";
  };
}

export type OpHandler = (req: BrokerRequestEnvelope) => Promise<unknown>;

type Payload = Record<string, unknown> | undefined;

function payloadOf(req: BrokerRequestEnvelope): Payload {
  assertPayloadKeys(req.operation, req.payload);
  return (req.payload ?? {}) as Payload;
}

/** Worker ops require an ACTIVE worker; state/workerState are authoritative (§10). */
function requireActiveWorker(record: SessionRecord): string {
  if (record.state !== "SANDBOX_ACTIVE" && record.state !== "RESULT_READY") {
    throw new StateError(`session ${record.sessionID} is not sandbox-active (state=${record.state})`);
  }
  if (!record.workerName) {
    throw new StateError(`session ${record.sessionID} has no worker recorded — fail closed`);
  }
  if (record.workerState === "DESTROYED" || record.workerState === "FAILED") {
    throw new StateError(`worker for session ${record.sessionID} is ${record.workerState}; re-ensure before use`);
  }
  return record.workerName;
}

function recordOr404(store: SessionStore, sessionID: string): SessionRecord {
  const record = store.get(sessionID);
  if (!record) {
    throw new StateError(`unknown session ${sessionID}`);
  }
  return record;
}

// ---------------------------------------------------------------------------
// ensureWorker — lazy creation (§4, §11, §13)
// ---------------------------------------------------------------------------

export function buildEnsureWorkerOp(ctx: OpContext): OpHandler {
  return async (req) => {
    const payload = payloadOf(req) as { projectDir?: unknown };
    const projectID = resolveProjectID(payload.projectDir, ctx.config.projects);
    const store = ctx.store;
    let record = store.touch(req.sessionID, { projectID, agent: req.agent });

    switch (record.state) {
      case "SANDBOX_ACTIVE":
      case "RESULT_READY":
        // Worker reuse (§28): same session keeps its worker.
        return { worker: record.workerName, state: record.state, reused: true };
      case "FAILED_CLOSED":
        throw new StateError(`session ${req.sessionID} is FAILED_CLOSED; manual review required`);
      case "CREATING_SANDBOX":
        throw new StateError(`sandbox creation already in progress for ${req.sessionID} — retry`);
      case "HOST_READ_ONLY":
      case "APPLIED":
      case "RETAINED":
      case "REJECTED":
        break;
    }

    // Admission: reject when the pool budget is exhausted (§22).
    const admission = checkAdmission(ctx.pool, ctx.budget, {});
    if (!admission.allowed) {
      throw new PolicyError(
        `${admission.reason}${admission.queueHint > 0 ? ` (queue position ~${admission.queueHint})` : ""}`,
      );
    }

    record = store.transition(req.sessionID, record.state, "CREATING_SANDBOX", {
      projectID,
      agent: req.agent,
      error: undefined,
    });

    const workerName = ctx.adapter.workerNameFor(req.sessionID);
    try {
      const repoDir = projectDirFor(ctx, projectID);
      ensureGitRepo(ctx, repoDir);

      // Snapshot: synthetic baseline B under refs/opencode-sandbox/baseline/<id>.
      // MUST be awaited — the bundle is required before createWorker/copyIn.
      const bundle = bundlePathFor(ctx.config.stateDir, req.sessionID);
      await runSnapshot(ctx, repoDir, req.sessionID, bundle);

      // Create the worker from the TRUSTED image with policy-derived resources.
      await ctx.adapter.createWorker({
        name: workerName,
        cpu: ctx.budget.perWorkerCpu,
        memBytes: ctx.budget.perWorkerMemBytes,
        image: ctx.config.workerImage,
        configDir: join(ctx.config.stateDir, "workers", workerName),
        networkMode: "deny-by-default",
      });

      // Transfer the baseline bundle into the worker repo.
      await ctx.adapter.copyIn(workerName, bundle, `/work/${req.sessionID}.bundle`);

      // §17: prepare the worker repo — init, fetch the baseline bundle, create
      // the work branch. All argv vectors, no shell. `sync` first: msb copy's
      // return does not guarantee the guest fs flushed the bundle (Gate 5
      // finding: fetch read a partially-written pack -> "non-monotonic index").
      const prep = [
        ["sync"],
        ["git", "init", "-q"],
        ["git", "config", "user.name", "opencode-sandbox"],
        ["git", "config", "user.email", "sandbox@local"],
        ["git", "fetch", `/work/${req.sessionID}.bundle`, `${baselineRef(req.sessionID)}:refs/heads/baseline`],
        ["git", "checkout", "-q", "-b", "work", "baseline"],
      ] as const;
      for (const argv of prep) {
        // Gate 5 finding: the guest upper fs can transiently serve a partially
        // written pack/idx ("non-monotonic index") — bounded retry.
        let res: Awaited<ReturnType<typeof ctx.adapter.exec>> | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          res = await ctx.adapter.exec(workerName, [...argv], { cwd: "/work", timeoutMs: 120_000 });
          if (res.status === 0) break;
          await new Promise((r) => setTimeout(r, 400));
        }
        if (!res || res.status !== 0) {
          throw new MsbError(`worker repo prep failed (${argv[1]}): ${trimErr(res?.stderr || res?.stdout || "")}`);
        }
      }

      ctx.pool.allocations.push({ cpu: ctx.budget.perWorkerCpu, memBytes: ctx.budget.perWorkerMemBytes });
      record = store.transition(req.sessionID, "CREATING_SANDBOX", "SANDBOX_ACTIVE", {
        workerName,
        workerState: "ACTIVE",
        baselineRef: baselineRef(req.sessionID),
        resultRef: undefined,
        error: undefined,
        resources: { cpu: ctx.budget.perWorkerCpu, memBytes: ctx.budget.perWorkerMemBytes },
      });
      return { worker: workerName, state: record.state, reused: false };
    } catch (err) {
      // §10: creation failure -> FAILED_CLOSED. Never fall back to host (S14).
      try {
        store.transition(req.sessionID, "CREATING_SANDBOX", "FAILED_CLOSED", {
          error: err instanceof Error ? err.message : String(err),
          workerState: "FAILED",
        });
      } catch {
        /* state may already have moved; the original error wins */
      }
      if (err instanceof MsbError || err instanceof ValidationError) throw err;
      throw err;
    }
  };
}

function projectDirFor(ctx: OpContext, projectID: string): string {
  const project = ctx.config.projects.find((p) => p.id === projectID);
  if (!project) throw new StateError(`project ${projectID} not in allowlist`);
  return project.path;
}

function ensureGitRepo(ctx: OpContext, repoDir: string): void {
  if (!existsSync(join(repoDir, ".git"))) {
    throw new StateError(`project is not a git repository: ${repoDir}`);
  }
}

/**
 * Snapshot plan execution (real mode, Gate 5): synthetic baseline B under
 * refs/opencode-sandbox/baseline/<sessionID> via a TEMPORARY index, then a
 * bundle for the worker. The user's branch/index are never touched (§17).
 * Any failure fails closed (S14) — no partial state is published.
 */
async function runSnapshot(
  ctx: OpContext,
  repoDir: string,
  sessionID: string,
  bundle: string,
): Promise<string> {
  mkdirSync(join(ctx.config.stateDir, "bundles"), { recursive: true, mode: 0o700 });
  mkdirSync(join(ctx.config.stateDir, "tmp"), { recursive: true, mode: 0o700 });
  const gitDir = join(repoDir, ".git");
  const tmpIndex = join(ctx.config.stateDir, "tmp", `${sessionID}.index`);
  const ref = baselineRef(sessionID);
  const env = {
    GIT_DIR: gitDir,
    GIT_INDEX_FILE: tmpIndex,
    GIT_AUTHOR_NAME: "opencode-sandbox",
    GIT_AUTHOR_EMAIL: "sandbox@local",
    GIT_COMMITTER_NAME: "opencode-sandbox",
    GIT_COMMITTER_EMAIL: "sandbox@local",
  };
  const git = (argv: string[], timeoutMs = 120_000) =>
    ctx.git.spawn(argv, { env, cwd: repoDir, timeoutMs });

  // HEAD must exist: the baseline commit B has HEAD as its parent.
  const head = await git(["git", "rev-parse", "--verify", "HEAD"]);
  if (head.status !== 0) {
    throw new StateError(`project has no HEAD commit; cannot snapshot (${repoDir})`);
  }

  // Stage the full working tree (HEAD + staged + unstaged + untracked,
  // respecting .gitignore) into the TEMPORARY index only.
  const add = await git(["git", "add", "-A", "--"]);
  if (add.status !== 0) {
    throw new StateError(`snapshot add failed: ${trimErr(add.stderr)}`);
  }
  const tree = await git(["git", "write-tree"]);
  if (tree.status !== 0) {
    throw new StateError(`snapshot write-tree failed: ${trimErr(tree.stderr)}`);
  }
  const commit = await git([
    "git", "commit-tree", tree.stdout.trim(), "-p", "HEAD",
    "-m", `opencode-sandbox baseline for ${sessionID}`,
  ]);
  if (commit.status !== 0) {
    throw new StateError(`snapshot commit-tree failed: ${trimErr(commit.stderr)}`);
  }
  const update = await git(["git", "update-ref", ref, commit.stdout.trim()]);
  if (update.status !== 0) {
    throw new StateError(`snapshot update-ref failed: ${trimErr(update.stderr)}`);
  }
  const bundleCreate = await git(["git", "bundle", "create", bundle, ref]);
  if (bundleCreate.status !== 0) {
    throw new StateError(`snapshot bundle failed: ${trimErr(bundleCreate.stderr)}`);
  }
  return ref;
}

function trimErr(s: string): string {
  return s.trim().slice(0, 500);
}

// ---------------------------------------------------------------------------
// Worker file/exec ops — all argv vectors, all validation-gated (§28)
// ---------------------------------------------------------------------------

export function buildExecOp(ctx: OpContext): OpHandler {
  return async (req) => {
    const payload = payloadOf(req) as { argv?: unknown; cwd?: unknown; timeoutMs?: unknown; env?: unknown };
    assertArgv(payload.argv, {
      itemMaxBytes: ctx.config.resource.argvItemMaxBytes,
      maxItems: ctx.config.resource.argvMaxItems,
      totalMaxBytes: ctx.config.resource.argvTotalMaxBytes,
    });
    const timeoutMs =
      payload.timeoutMs === undefined
        ? ctx.config.resource.execTimeoutMsDefault
        : payload.timeoutMs;
    assertPositiveInt(timeoutMs, ctx.config.resource.execTimeoutMsMax, "timeoutMs");
    let cwd: string | undefined;
    if (payload.cwd !== undefined) {
      assertSandboxPath(payload.cwd, ctx.config.resource.pathMaxBytes);
      cwd = payload.cwd;
    }
    const record = recordOr404(ctx.store, req.sessionID);
    const worker = requireActiveWorker(record);
    const result = await ctx.adapter.exec(worker, payload.argv, {
      cwd,
      timeoutMs: timeoutMs as number,
      env: (payload.env as Record<string, string> | undefined) ?? undefined,
    });
    return {
      exitCode: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    };
  };
}

export function buildReadFileOp(ctx: OpContext): OpHandler {
  return async (req) => {
    const payload = payloadOf(req) as { path?: unknown };
    assertSandboxPath(payload.path, ctx.config.resource.pathMaxBytes);
    const record = recordOr404(ctx.store, req.sessionID);
    const worker = requireActiveWorker(record);
    const result = await ctx.adapter.exec(worker, ["cat", "--", payload.path as string], {
      timeoutMs: 30_000,
    });
    if (result.status !== 0) {
      throw new MsbError(`readFile failed in worker (status ${result.status}): ${result.stderr.trim()}`);
    }
    return { content: result.stdout };
  };
}

export function buildWriteFileOp(ctx: OpContext): OpHandler {
  return async (req) => {
    const payload = payloadOf(req) as { path?: unknown; content?: unknown };
    assertSandboxPath(payload.path, ctx.config.resource.pathMaxBytes);
    assertContent(payload.content, ctx.config.resource.contentMaxBytes);
    const record = recordOr404(ctx.store, req.sessionID);
    const worker = requireActiveWorker(record);

    const hostTmp = join(ctx.config.stateDir, "tmp", `write-${req.sessionID}-${randomUUID()}.tmp`);
    const workerTmp = `/work/.broker-tmp/write-${randomUUID()}.tmp`;
    try {
      mkdirSync(join(ctx.config.stateDir, "tmp"), { recursive: true, mode: 0o700 });
      // 0644: msb copy preserves the host mode with ROOT ownership in the
      // guest; 0600 would be unreadable to the non-root worker user
      // (Gate 5 finding — chmod by nobody on a root-owned file is EPERM).
      writeFileSync(hostTmp, payload.content as string, { mode: 0o644 });
      // mkdir the worker tmp dir BEFORE the copy (copy of a missing parent
      // fails with ENOENT — Gate 5 finding); argv vectors, no shell.
      const mkdirRes = await ctx.adapter.exec(
        worker,
        ["mkdir", "-p", workerDirOf(workerTmp)],
        { timeoutMs: 30_000 },
      );
      if (mkdirRes.status !== 0) {
        throw new MsbError(`writeFile mkdir failed in worker (status ${mkdirRes.status}): ${mkdirRes.stderr.trim()}`);
      }
      await ctx.adapter.copyIn(worker, hostTmp, workerTmp);
      const moved = await ctx.adapter.exec(worker, ["mv", "-f", workerTmp, payload.path as string], {
        timeoutMs: 30_000,
      });
      if (moved.status !== 0) {
        throw new MsbError(`writeFile failed in worker (status ${moved.status}): ${moved.stderr.trim()}`);
      }
      return { path: payload.path };
    } finally {
      rmSync(hostTmp, { force: true });
    }
  };
}

function workerDirOf(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx > 0 ? filePath.slice(0, idx) : "/work";
}

export function buildApplyOp(ctx: OpContext): OpHandler {
  return async (req) => {
    const payload = payloadOf(req) as { patch?: unknown };
    assertContent(payload.patch, ctx.config.resource.patchMaxBytes);
    const record = recordOr404(ctx.store, req.sessionID);
    const worker = requireActiveWorker(record);

    const hostTmp = join(ctx.config.stateDir, "tmp", `patch-${req.sessionID}-${randomUUID()}.patch`);
    const workerTmp = `/work/.broker-tmp/apply-${randomUUID()}.patch`;
    try {
      // 0644: readable by the non-root worker user (Gate 5 finding).
      writeFileSync(hostTmp, payload.patch as string, { mode: 0o644 });
      await ctx.adapter.copyIn(worker, hostTmp, workerTmp);
      // §19.6: `git apply --check` before applying, inside the worker repo.
      const check = await ctx.adapter.exec(worker, ["git", "apply", "--check", workerTmp], {
        cwd: "/work",
        timeoutMs: 60_000,
      });
      if (check.status !== 0) {
        throw new MsbError(`patch does not apply cleanly: ${check.stderr.trim()}`);
      }
      const applied = await ctx.adapter.exec(worker, ["git", "apply", workerTmp], {
        cwd: "/work",
        timeoutMs: 60_000,
      });
      if (applied.status !== 0) {
        throw new MsbError(`patch apply failed: ${applied.stderr.trim()}`);
      }
      return { ok: true };
    } finally {
      rmSync(hostTmp, { force: true });
    }
  };
}

export function buildListDirOp(ctx: OpContext): OpHandler {
  return async (req) => {
    const payload = payloadOf(req) as { path?: unknown };
    assertSandboxPath(payload.path, ctx.config.resource.pathMaxBytes);
    const record = recordOr404(ctx.store, req.sessionID);
    const worker = requireActiveWorker(record);
    const result = await ctx.adapter.exec(worker, ["ls", "-la", payload.path as string], {
      timeoutMs: 30_000,
    });
    return { listing: result.stdout };
  };
}

export function buildGrepOp(ctx: OpContext): OpHandler {
  return async (req) => {
    const payload = payloadOf(req) as { query?: unknown; path?: unknown };
    assertGrepQuery(payload.query, ctx.config.resource.grepQueryMaxBytes);
    assertSandboxPath(payload.path, ctx.config.resource.pathMaxBytes);
    const record = recordOr404(ctx.store, req.sessionID);
    const worker = requireActiveWorker(record);
    // `grep -e <query>` keeps the pattern out of any shell/glob interpretation.
    const result = await ctx.adapter.exec(
      worker,
      ["grep", "-rn", "--exclude-dir=.git", "-e", payload.query as string, payload.path as string],
      { timeoutMs: 60_000 },
    );
    return { matches: result.stdout, exitCode: result.status };
  };
}

export function buildDiffOp(ctx: OpContext): OpHandler {
  return async (req) => {
    payloadOf(req);
    const record = recordOr404(ctx.store, req.sessionID);
    const worker = requireActiveWorker(record);
    const ref = record.baselineRef ?? baselineRef(record.sessionID);
    const stat = await ctx.adapter.exec(worker, ["git", "diff", "--stat", ref, "HEAD"], {
      cwd: "/work",
      timeoutMs: 60_000,
    });
    const diff = await ctx.adapter.exec(worker, ["git", "diff", ref, "HEAD"], {
      cwd: "/work",
      timeoutMs: 60_000,
    });
    return { stat: stat.stdout, diff: diff.stdout, exitCode: diff.status };
  };
}

// ---------------------------------------------------------------------------
// Result boundary (§15, §18-§20)
// ---------------------------------------------------------------------------

export function buildPrepareResultOp(ctx: OpContext): OpHandler {
  return async (req) => {
    payloadOf(req);
    let record = recordOr404(ctx.store, req.sessionID);
    if (record.state === "RESULT_READY") {
      return { resultRef: record.resultRef, state: record.state };
    }
    if (record.state !== "SANDBOX_ACTIVE") {
      throw new StateError(`cannot prepare result from state ${record.state}`);
    }
    const ref = await runPrepare(ctx, req.sessionID);
    record = ctx.store.transition(req.sessionID, "SANDBOX_ACTIVE", "RESULT_READY", {
      resultRef: ref,
    });
    return { resultRef: ref, state: record.state, imported: true };
  };
}

/** Worker-side bundle export + host-side import under the sandbox namespace. */
async function runPrepare(ctx: OpContext, sessionID: string): Promise<string> {
  const record = recordOr404(ctx.store, sessionID);
  const worker = requireActiveWorker(record);
  const ref = resultRef(sessionID);
  mkdirSync(join(ctx.config.stateDir, "bundles"), { recursive: true, mode: 0o700 });
  const hostBundle = bundlePathFor(ctx.config.stateDir, sessionID);
  const workerBundle = `/work/.broker-tmp/result-${sessionID}.bundle`;

  // Worker side: publish result ref + bundle (all argv vectors).
  await ctx.adapter.exec(worker, ["git", "update-ref", ref, "HEAD"], { cwd: "/work", timeoutMs: 60_000 });
  await ctx.adapter.exec(worker, ["git", "bundle", "create", workerBundle, ref], {
    cwd: "/work",
    timeoutMs: 120_000,
  });
  await ctx.adapter.copyOut(worker, workerBundle, hostBundle);

  // Host side: verify + import under the sandbox result namespace.
  if (ctx.git.runnerMode !== "real") {
    // Import is gated; the bundle is retained in the state dir for Gate 6.
    return ref;
  }
  const verify = await ctx.git.spawn(["git", "bundle", "verify", hostBundle], { timeoutMs: 60_000 });
  if (verify.status !== 0) {
    throw new MsbError(`result bundle verification failed: ${verify.stderr.trim()}`);
  }
  const imported = await ctx.git.spawn(["git", "fetch", "--no-tags", hostBundle, `${ref}:${ref}`], {
    timeoutMs: 120_000,
  });
  if (imported.status !== 0) {
    throw new MsbError(`result import failed: ${imported.stderr.trim()}`);
  }
  return ref;
}

export function buildApplyResultOp(ctx: OpContext): OpHandler {
  return async (req) => {
    const payload = payloadOf(req) as { confirm?: unknown };
    if (payload.confirm !== "APPLY") {
      throw new ValidationError("applyResult requires confirm: \"APPLY\"");
    }
    let record = recordOr404(ctx.store, req.sessionID);
    if (record.state !== "RESULT_READY") {
      throw new StateError(`cannot apply result from state ${record.state}`);
    }
    const resultRefName = record.resultRef ?? resultRef(req.sessionID);
    const baselineRefName = record.baselineRef ?? baselineRef(req.sessionID);

    record = ctx.store.transition(req.sessionID, "RESULT_READY", "APPLY_PENDING", {});

    // §19.1 / S16: host must still match the baseline the worker was built from.
    const divergence = await hostDivergence(ctx, baselineRefName);
    if (divergence.length > 0) {
      ctx.store.transition(req.sessionID, "APPLY_PENDING", "RESULT_READY", {
        error: `host diverged from baseline; result retained for reconciliation (${divergence.slice(0, 10).join(", ")})`,
      });
      throw new StateError(
        `host project diverged from baseline (S16). Automatic apply refused; result retained at ${resultRefName}. ` +
          `Reconcile manually or discard the result.`,
      );
    }

    // §19.2-5: inspect changed paths; reject protected/symlink/submodule.
    const changed = await changedPathsBetween(ctx, baselineRefName, resultRefName);
    const rejectedProtected = checkProtectedPaths(changed, [
      ...ctx.config.protectedPaths,
      ...ctx.config.protectedSecurityFiles,
    ]);
    if (rejectedProtected.length > 0) {
      ctx.store.transition(req.sessionID, "APPLY_PENDING", "RESULT_READY", {
        error: `result touches protected paths: ${rejectedProtected.join(", ")}`,
      });
      throw new StateError(`result touches protected paths (S7/S17): ${rejectedProtected.join(", ")}`);
    }

    // §19.6: dry-run check then apply; working-tree only (no index/branch).
    const patchFile = patchPathFor(ctx.config.stateDir, req.sessionID);
    const patch = await ctx.git.spawn(["git", "diff", baselineRefName, resultRefName, "--", "."], {
      timeoutMs: 60_000,
    });
    if (patch.status !== 0) {
      ctx.store.transition(req.sessionID, "APPLY_PENDING", "RESULT_READY", { error: "diff generation failed" });
      throw new StateError("diff generation failed; result retained");
    }
    mkdirSync(join(ctx.config.stateDir, "patches"), { recursive: true, mode: 0o700 });
    writeFileSync(patchFile, patch.stdout, { mode: 0o600 });
    const check = await ctx.git.spawn(buildCheckArgv(patchFile), { timeoutMs: 60_000 });
    if (check.status !== 0) {
      ctx.store.transition(req.sessionID, "APPLY_PENDING", "RESULT_READY", {
        error: `git apply --check failed: ${check.stderr.trim()}`,
      });
      throw new StateError(`git apply --check failed (${check.stderr.trim()}); result retained`);
    }
    const applied = await ctx.git.spawn(["git", "apply", patchFile], { timeoutMs: 120_000 });
    if (applied.status !== 0) {
      ctx.store.transition(req.sessionID, "APPLY_PENDING", "RESULT_READY", {
        error: `apply failed: ${applied.stderr.trim()}`,
      });
      throw new StateError(`apply failed (${applied.stderr.trim()}); host unchanged`);
    }
    record = ctx.store.transition(req.sessionID, "APPLY_PENDING", "APPLIED", {
      error: undefined,
      resultRef: resultRefName,
    });
    return { state: record.state, applied: true, resultRef: resultRefName };
  };
}

/** S16: compare current host tree with the baseline tree. */
async function hostDivergence(ctx: OpContext, baselineRefName: string): Promise<string[]> {
  const project = ctx.config.projects[0]; // Gate 1: single-project assumption, revisit per-session at Gate 5
  if (!project) throw new StateError("no projects configured");
  const gitDir = join(project.path, ".git");
  const tmpIndex = join(ctx.config.stateDir, "tmp", `divergence-${randomUUID()}.index`);
  const env = { GIT_DIR: gitDir, GIT_INDEX_FILE: tmpIndex };
  const currentTree = await ctx.git.spawn(["git", "add", "-A", "--"], { env, timeoutMs: 60_000 });
  if (currentTree.status !== 0) {
    throw new StateError(`cannot read host working tree: ${currentTree.stderr.trim()}`);
  }
  const lsFiles = await ctx.git.spawn(["git", "ls-files", "-s"], { env, timeoutMs: 60_000 });
  const baseline = await ctx.git.spawn(["git", "ls-tree", "-r", baselineRefName], { env, timeoutMs: 60_000 });
  return computeDivergence(
    parseLsTreeLines(baseline.stdout.split("\n")),
    parseLsFilesLines(lsFiles.stdout.split("\n")),
  );
}

/** §19.2: changed paths between baseline B and result C. */
async function changedPathsBetween(ctx: OpContext, baselineRefName: string, resultRefName: string): Promise<string[]> {
  const project = ctx.config.projects[0];
  if (!project) throw new StateError("no projects configured");
  const gitDir = join(project.path, ".git");
  const raw = await ctx.git.spawn(
    ["git", "diff", "--raw", "-z", baselineRefName, resultRefName],
    { env: { GIT_DIR: gitDir }, timeoutMs: 60_000 },
  );
  if (raw.status !== 0) {
    throw new StateError(`cannot diff result: ${raw.stderr.trim()}`);
  }
  const changes = classifyRawDiff(raw.stdout.split("\u0000"));
  return changes.map((c) => c.path);
}

export function buildKeepResultOp(ctx: OpContext): OpHandler {
  return async (req) => {
    const payload = payloadOf(req) as { confirm?: unknown };
    if (payload.confirm !== "KEEP") {
      throw new ValidationError('keepResult requires confirm: "KEEP"');
    }
    let record = recordOr404(ctx.store, req.sessionID);
    if (record.state === "SANDBOX_ACTIVE") {
      // §20 KEEP: prepare the result first, then retire the transient worker.
      const ref = await runPrepare(ctx, req.sessionID);
      record = ctx.store.transition(req.sessionID, "SANDBOX_ACTIVE", "RESULT_READY", {
        resultRef: ref,
      });
    }
    if (record.state !== "RESULT_READY" && record.state !== "APPLIED") {
      throw new StateError(`cannot keep result from state ${record.state}`);
    }
    if (record.workerName && record.workerState === "ACTIVE") {
      await ctx.adapter.remove(record.workerName).catch(() => undefined);
    }
    ctx.store.touch(req.sessionID, { workerState: record.workerName ? "DESTROYED" : undefined });
    record = ctx.store.transition(req.sessionID, record.state, "RETAINED", {
      error: undefined,
    });
    return {
      state: record.state,
      resultRef: record.resultRef ?? resultRef(req.sessionID),
      retained: true,
    };
  };
}

export function buildDiscardResultOp(ctx: OpContext): OpHandler {
  return async (req) => {
    const payload = payloadOf(req) as { confirm?: unknown };
    if (payload.confirm !== "REJECT") {
      throw new ValidationError('discardResult requires confirm: "REJECT"');
    }
    let record = recordOr404(ctx.store, req.sessionID);
    if (record.state !== "RESULT_READY" && record.state !== "RETAINED") {
      throw new StateError(`cannot discard result from state ${record.state}`);
    }
    if (record.workerName && record.workerState === "ACTIVE") {
      await ctx.adapter.remove(record.workerName).catch(() => undefined);
      ctx.pool.allocations = ctx.pool.allocations.filter(
        (a) => a.memBytes !== (record.resources?.memBytes ?? -1) || a.cpu !== (record.resources?.cpu ?? -1),
      );
    }
    const ref = record.resultRef ?? resultRef(req.sessionID);
    if (ctx.git.runnerMode === "real") {
      await ctx.git.spawn(["git", "update-ref", "-d", ref], { timeoutMs: 30_000 });
    }
    ctx.store.transition(req.sessionID, record.state, "REJECTED", {
      workerState: record.workerName ? "DESTROYED" : undefined,
      error: undefined,
    });
    return { state: "REJECTED" };
  };
}

export function buildDestroyWorkerOp(ctx: OpContext): OpHandler {
  return async (req) => {
    payloadOf(req);
    const record = recordOr404(ctx.store, req.sessionID);
    if (!record.workerName) {
      return { destroyed: true, worker: null };
    }
    if (record.workerState === "ACTIVE" || record.workerState === "CREATING") {
      await ctx.adapter.remove(record.workerName).catch(() => undefined);
    }
    ctx.store.touch(req.sessionID, { workerState: "DESTROYED" });
    return { destroyed: true, worker: record.workerName };
  };
}

export function buildWorkerStatusOp(ctx: OpContext): OpHandler {
  return async (req) => {
    payloadOf(req);
    const record = recordOr404(ctx.store, req.sessionID);
    return { sessionID: record.sessionID, state: record.state, worker: record.workerName ?? null, workerState: record.workerState ?? null };
  };
}

export function buildListWorkersOp(ctx: OpContext): OpHandler {
  return async () => {
    const records = ctx.store.list();
    const workers: WorkerRecord[] = records
      .filter((r) => r.workerName)
      .map((r) => ({
        workerName: r.workerName as string,
        sessionID: r.sessionID,
        projectID: r.projectID ?? "",
        state: r.workerState ?? "ACTIVE",
        cpu: r.resources?.cpu ?? 0,
        memBytes: r.resources?.memBytes ?? 0,
        createdAt: r.createdAt,
      }));
    return { workers };
  };
}

export function buildMetricsOp(ctx: OpContext): OpHandler {
  return async () => {
    const records = ctx.store.list();
    const sessionsByState: Record<string, number> = {};
    for (const r of records) {
      sessionsByState[r.state] = (sessionsByState[r.state] ?? 0) + 1;
    }
    const aggCpu = ctx.pool.allocations.reduce((a, w) => a + w.cpu, 0);
    const aggMem = ctx.pool.allocations.reduce((a, w) => a + w.memBytes, 0);
    const metrics: MetricsRecord = {
      totalCpu: ctx.resources.cpuCount,
      totalMemBytes: ctx.resources.totalMemBytes,
      reservedCpu: ctx.budget.hostReservedCpu,
      reservedMemBytes: ctx.budget.hostReservedMemBytes,
      aggregateCpuInUse: aggCpu,
      aggregateMemBytesInUse: aggMem,
      workersActive: ctx.pool.allocations.length,
      workersMax: ctx.budget.maxWorkers,
      sessionsByState,
      budgetExhausted:
        checkAdmission(ctx.pool, ctx.budget, {}).allowed === false,
    };
    return metrics;
  };
}

export function buildPolicyOp(ctx: OpContext): OpHandler {
  return async () => {
    const policy: PolicyRecord = {
      socketPath: ctx.config.socketPath,
      projects: ctx.config.projects,
      approvedExternalReadRoots: ctx.config.approvedExternalReadRoots,
      protectedPaths: [...ctx.config.protectedPaths, ...ctx.config.protectedSecurityFiles],
      workerImage: ctx.config.workerImage,
      resourceCaps: {
        perWorkerCpu: ctx.budget.perWorkerCpu,
        perWorkerMemBytes: ctx.budget.perWorkerMemBytes,
        maxWorkers: ctx.budget.maxWorkers,
        maxAggregateCpu: ctx.budget.maxAggregateCpu,
        maxAggregateMemBytes: ctx.budget.maxAggregateMemBytes,
      },
      network: ctx.config.network,
    };
    return policy;
  };
}

export function buildHostOp(ctx: OpContext): OpHandler {
  return async (req) => {
    const op = req.operation as Operation;
    if (!ctx.hostRead.has(op)) {
      throw new StateError(`host read '${op}' is not enabled`);
    }
    const result = await ctx.hostRead.execute(op, payloadOf(req) as Record<string, unknown> | undefined);
    return result;
  };
}

// Re-exported helpers used by tests.
export { formatBytes };
