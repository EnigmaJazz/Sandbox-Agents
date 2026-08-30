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
import { existsSync, mkdirSync, writeFileSync, rmSync, chmodSync, copyFileSync, renameSync, statSync, readFileSync, type Stats } from "node:fs";
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
  assertExternalCopyTarget,
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
  buildChangedPathsArgv,
  parseNulDelimitedPaths,
  checkProtectedPaths,
  classifyRawDiff,
  computeDivergence,
  parseLsFilesLines,
  parseLsTreeLines,
} from "./gitops.ts";
import {
  assertCopyOutReviewLimit,
  countCopyLines,
  isSourceCodeTarget,
} from "./copy-review.ts";
import { MsbError } from "./msb.ts";
import { StateError } from "./state.ts";
import { PolicyError, checkAdmission, type Admission } from "./policy.ts";
import { PendingQueue, QueuedTimedOutError, type QueuedEntry } from "./queue.ts";
import type { BrokerRequestEnvelope, SessionRecord, WorkerRecord, MetricsRecord, PolicyRecord, Operation } from "./types.ts";

export interface OpContext {
  config: BrokerConfig;
  store: SessionStore;
  adapter: MsbAdapter;
  budget: Budget;
  resources: HostResources;
  pool: WorkerPool;
  /**
   * FIFO pending queue for pool-exhausted ensureWorker requests (Feature 2).
   * The server always provides one; operation-level unit tests that never
   * queue may omit it (drain/park guard on absence).
   */
  queue?: PendingQueue;
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
// ensureWorker — lazy creation (§4, §11, §13) + pool queue (Feature 2)
// ---------------------------------------------------------------------------

export function buildEnsureWorkerOp(ctx: OpContext): OpHandler {
  return async (req) => {
    // Orchestrator read-only: refuse before any touch/admission side effect (R2).
    const existing = ctx.store.get(req.sessionID)
    const trusted = existing?.agent ?? req.agent
    const readOnly = (ctx.config as { readOnlyAgents?: string[] }).readOnlyAgents ?? []
    if (trusted && readOnly.includes(trusted)) {
      throw new PolicyError(`orchestrator agent "${trusted}" is not allowed to create a worker (orchestrator-readonly)`)
    }
    if (req.agent && readOnly.includes(req.agent) && req.agent !== trusted) {
      throw new PolicyError(`orchestrator agent "${req.agent}" is not allowed to create a worker (orchestrator-readonly)`)
    }
    const payload = payloadOf(req) as { projectDir?: unknown };
    const projectID = resolveProjectID(payload.projectDir, ctx.config.projects);
    const record = ctx.store.touch(req.sessionID, { projectID, agent: req.agent });

    // Fast paths. State gates run BEFORE admission so FAILED_CLOSED and
    // mid-creation sessions never park in the pool queue.
    switch (record.state) {
      case "SANDBOX_ACTIVE":
      case "RESULT_READY":
        // Worker reuse (§28): same session keeps its worker — unless the idle
        // reaper already released it (no workerName / DESTROYED / FAILED), in
        // which case fall through and (re)create on demand.
        if (record.workerName && record.workerState !== "DESTROYED" && record.workerState !== "FAILED") {
          return { worker: record.workerName, state: record.state, reused: true };
        }
        break;
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

    // Admission (Feature 2): pool-exhausted requests PARK in the FIFO queue
    // instead of killing the subagent session; request-level refusals (invalid
    // or above-policy) still fail immediately — queueing can never fix them.
    const admission = admissionFor(ctx);
    if (!admission.allowed) {
      if (!admission.queueable) {
        throw new PolicyError(
          `${admission.reason}${admission.queueHint > 0 ? ` (queue position ~${admission.queueHint})` : ""}`,
        );
      }
      return parkAndWait(ctx, req, projectID);
    }

    return createWorkerForSession(ctx, req, req.sessionID, projectID);
  };
}

/**
 * Shared creation path: snapshot -> createWorker -> copyIn -> prep -> pool
 * allocation -> SANDBOX_ACTIVE. Used by the direct admission path AND by the
 * queue drain (a parked request re-runs the FULL creation path once a slot
 * frees). Re-validates the record state because time passed while parked.
 * Any failure fails closed (S14): CREATING_SANDBOX -> FAILED_CLOSED.
 */
async function createWorkerForSession(
  ctx: OpContext,
  req: BrokerRequestEnvelope,
  sessionID: string,
  projectID: string,
): Promise<unknown> {
  // Orchestrator read-only: fail closed even for queued creations
  const existing2 = ctx.store.get(sessionID)
  const trusted2 = existing2?.agent ?? req.agent
  const ro2 = (ctx.config as { readOnlyAgents?: string[] }).readOnlyAgents ?? []
  if (trusted2 && ro2.includes(trusted2)) {
    throw new PolicyError(`orchestrator agent "${trusted2}" is not allowed to create a worker (orchestrator-readonly)`)
  }
  const store = ctx.store;
  const record = recordOr404(store, sessionID);
  switch (record.state) {
    case "SANDBOX_ACTIVE":
    case "RESULT_READY":
      if (record.workerName && record.workerState !== "DESTROYED" && record.workerState !== "FAILED") {
        return { worker: record.workerName, state: record.state, reused: true };
      }
      break;
    case "FAILED_CLOSED":
      throw new StateError(`session ${sessionID} is FAILED_CLOSED; manual review required`);
    case "CREATING_SANDBOX":
      throw new StateError(`sandbox creation already in progress for ${sessionID} — retry`);
    case "HOST_READ_ONLY":
    case "APPLIED":
    case "RETAINED":
    case "REJECTED":
      break;
  }

  store.transition(sessionID, record.state, "CREATING_SANDBOX", {
    projectID,
    agent: req.agent,
    error: undefined,
  });

  const workerName = ctx.adapter.workerNameFor(sessionID);
  try {
    const repoDir = projectDirFor(ctx, projectID);
    ensureGitRepo(ctx, repoDir);

    // Snapshot: synthetic baseline B under refs/opencode-sandbox/baseline/<id>.
    // MUST be awaited — the bundle is required before createWorker/copyIn.
    const bundle = bundlePathFor(ctx.config.stateDir, sessionID);
    await runSnapshot(ctx, repoDir, sessionID, bundle);

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
    await ctx.adapter.copyIn(workerName, bundle, `/work/${sessionID}.bundle`);

    // §17: prepare the worker repo — init, fetch the baseline bundle, create
    // the work branch. All argv vectors, no shell. `sync` first: msb copy's
    // return does not guarantee the guest fs flushed the bundle (Gate 5
    // finding: fetch read a partially-written pack -> "non-monotonic index").
    const prep = [
      ["sync"],
      ["git", "init", "-q"],
      ["git", "config", "user.name", "opencode-sandbox"],
      ["git", "config", "user.email", "sandbox@local"],
      ["git", "fetch", `/work/${sessionID}.bundle`, `${baselineRef(sessionID)}:refs/heads/baseline`],
      ["git", "checkout", "-q", "-b", "work", "baseline"],
      // Mirror the host-side baseline ref name in the worker so buildDiffOp
      // (git diff refs/opencode-sandbox/baseline/<id> HEAD) resolves (Gate 6
      // demo finding: the worker only had refs/heads/baseline).
      ["git", "update-ref", baselineRef(sessionID), "refs/heads/baseline"],
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
    const next = store.transition(sessionID, "CREATING_SANDBOX", "SANDBOX_ACTIVE", {
      workerName,
      workerState: "ACTIVE",
      baselineRef: baselineRef(sessionID),
      resultRef: undefined,
      error: undefined,
      resources: { cpu: ctx.budget.perWorkerCpu, memBytes: ctx.budget.perWorkerMemBytes },
    });
    return { worker: workerName, state: next.state, reused: false };
  } catch (err) {
    // §10: creation failure -> FAILED_CLOSED. Never fall back to host (S14).
    // Gate 5 live finding: a partially created worker must not be left
    // running (resource leak) — stop + remove it best-effort.
    if (workerName) {
      try {
        await ctx.adapter.stop(workerName);
        await ctx.adapter.remove(workerName);
      } catch {
        /* cleanup is best-effort; the session is closed regardless */
      }
    }
    try {
      store.transition(sessionID, "CREATING_SANDBOX", "FAILED_CLOSED", {
        error: err instanceof Error ? err.message : String(err),
        workerState: "FAILED",
      });
    } catch {
      /* state may already have moved; the original error wins */
    }
    if (err instanceof MsbError || err instanceof ValidationError) throw err;
    throw err;
  }
}

/**
 * Park a pool-exhausted ensureWorker in the FIFO queue. The request stays
 * open on the socket until a slot frees (drain), the bounded timeout fires
 * (queued_timed_out with the real position), or the client disconnects.
 */
function parkAndWait(ctx: OpContext, req: BrokerRequestEnvelope, projectID: string): Promise<unknown> {
  const queue = ctx.queue;
  if (!queue) {
    throw new StateError("worker queue is not configured — cannot park request");
  }
  const existing = queue.find(req.sessionID);
  if (existing) {
    // Idempotency: the same session is already parked — share its result.
    return existing.pending;
  }
  if (queue.length >= ctx.config.queueMaxLength) {
    throw new PolicyError(`worker queue full (${ctx.config.queueMaxLength}); retry later`);
  }
  const timeoutMs = ctx.config.queueTimeoutMs;
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const pending = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const entry: QueuedEntry = {
    sessionID: req.sessionID,
    request: req,
    projectID,
    position: 0,
    pending,
    resolve,
    reject,
  };
  const timer = setTimeout(() => {
    queue.remove(req.sessionID);
    reject(
      new QueuedTimedOutError(
        `ensureWorker queued for session ${req.sessionID} timed out after ${timeoutMs}ms (queue position ${entry.position})`,
      ),
    );
  }, timeoutMs);
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  entry.timer = timer;
  queue.enqueue(entry);
  return pending;
}

/**
 * Admission that accounts for creations the drain already promised
 * (queue.inFlight): a direct ensureWorker must not slip into a slot that a
 * parked request is about to consume (that would oversubscribe the pool).
 */
function admissionFor(ctx: OpContext): Admission {
  const inFlight = ctx.queue?.inFlight ?? 0;
  if (inFlight === 0) return checkAdmission(ctx.pool, ctx.budget, {});
  const virtual = ctx.pool.allocations.concat(
    Array.from({ length: inFlight }, () => ({
      cpu: ctx.budget.perWorkerCpu,
      memBytes: ctx.budget.perWorkerMemBytes,
    })),
  );
  return checkAdmission({ allocations: virtual }, ctx.budget, {});
}

/**
 * Drain point (Feature 2): admit as many parked requests as the freed budget
 * allows, FIFO order, each as its own fire-and-forget creation task. Never
 * awaited inside releaseWorker — the drain must not block the releaser.
 */
export function drainQueue(ctx: OpContext): void {
  const queue = ctx.queue;
  if (!queue) return;
  while (true) {
    const entry = queue.head();
    if (!entry) return;
    if (!admissionFor(ctx).allowed) return; // head cannot fit yet — FIFO, leave the rest parked
    queue.remove(entry.sessionID);
    if (entry.timer) clearTimeout(entry.timer);
    queue.inFlight++;
    void runQueuedCreation(ctx, entry);
  }
}

async function runQueuedCreation(ctx: OpContext, entry: QueuedEntry): Promise<void> {
  try {
    const result = await createWorkerForSession(ctx, entry.request, entry.sessionID, entry.projectID);
    entry.resolve({ ...(result as Record<string, unknown>), queued: true, queuePosition: entry.position });
  } catch (err) {
    entry.reject(err);
  } finally {
    const queue = ctx.queue;
    if (queue) queue.inFlight = Math.max(0, queue.inFlight - 1);
    // The freed slot is now consumed (success) or still free (failure): admit
    // the next parked request promptly instead of waiting for another release.
    drainQueue(ctx);
  }
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
  // systemd UMask=0077 makes git create the bundle 0600 -> root-owned in the
  // guest -> unreadable by the non-root worker user (Gate 5 live finding).
  chmodSync(bundle, 0o644);
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
      const rawContent = payload.content as string;
      // Gate 6 follow-up: guarantee a trailing newline so the B->C diff and
      // git apply never reject on a missing final newline (layers above were
      // observed stripping it).
      const content = rawContent.endsWith("\n") ? rawContent : `${rawContent}\n`;
      writeFileSync(hostTmp, content, { mode: 0o644 });
      // chmod, not the create mode: the broker's umask (systemd UMask=0077)
      // masks 0644 down to 0600, which becomes root-owned 0600 in the guest
      // and unreadable by the non-root worker user (Gate 5 live finding).
      chmodSync(hostTmp, 0o644);
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

// ---------------------------------------------------------------------------
// Copy tool (S15): worker file <-> allowlisted host file
// ---------------------------------------------------------------------------

export function buildCopyOutInfoOp(ctx: OpContext): OpHandler {
  return async (req) => {
    const payload = payloadOf(req) as { workerPath?: unknown; hostTarget?: unknown };
    assertSandboxPath(payload.workerPath, ctx.config.resource.pathMaxBytes);
    const target = assertExternalCopyTarget(payload.hostTarget, ctx.config.externalCopyTargets);
    const record = recordOr404(ctx.store, req.sessionID);
    const worker = requireActiveWorker(record);
    const result = await ctx.adapter.exec(worker, ["cat", "--", payload.workerPath as string], {
      cwd: "/work",
      timeoutMs: 30_000,
    });
    if (result.status !== 0) {
      throw new MsbError(`copyOutInfo failed in worker (status ${result.status}): ${result.stderr.trim()}`);
    }
    const lines = result.stdout.split("\n");
    const totalLines = countCopyLines(result.stdout);
    assertCopyOutReviewLimit(target, totalLines, ctx.config.resource.maxApplyDiffLines);
    const preview =
      !isSourceCodeTarget(target) && totalLines > 400
        ? `${lines.slice(0, 400).join("\n")}\n(... truncated: ${totalLines} total lines)`
        : result.stdout;
    return { target, totalLines, preview };
  };
}

export function buildCopyOutOp(ctx: OpContext): OpHandler {
  return async (req) => {
    const payload = payloadOf(req) as { workerPath?: unknown; hostTarget?: unknown; confirm?: unknown };
    if (payload.confirm !== "COPY") {
      throw new ValidationError('copyOut requires confirm: "COPY"');
    }
    assertSandboxPath(payload.workerPath, ctx.config.resource.pathMaxBytes);
    const canonicalTarget = assertExternalCopyTarget(payload.hostTarget, ctx.config.externalCopyTargets);
    const record = recordOr404(ctx.store, req.sessionID);
    const worker = requireActiveWorker(record);

    const hostTmp = join(ctx.config.stateDir, "tmp", `copy-${req.sessionID}-${randomUUID()}.tmp`);
    try {
      mkdirSync(join(ctx.config.stateDir, "tmp"), { recursive: true, mode: 0o700 });
      // copyOut throws MsbError on failure (msb.ts) — the host target is
      // never written partially.
      // msb needs an absolute endpoint; workerPath is validated relative.
      const workerAbs = (payload.workerPath as string).startsWith("/")
        ? (payload.workerPath as string)
        : `/work/${payload.workerPath as string}`;
      await ctx.adapter.copyOut(worker, workerAbs, hostTmp);
      // Recheck the bytes actually copied before creating a backup or touching the host target.
      const copiedContent = readFileSync(hostTmp, "utf8");
      assertCopyOutReviewLimit(canonicalTarget, countCopyLines(copiedContent), ctx.config.resource.maxApplyDiffLines);
      // Gate 6: keep a recoverable backup of the host target before overwriting
      // it (copy_out is a whole-file host write; a bad copy must be restorable).
      if (existsSync(canonicalTarget)) {
        copyFileSync(canonicalTarget, `${canonicalTarget}.bak`);
      }
      // Atomic publish: rename into place, then fix the mode. The host umask
      // (systemd UMask=0077) masks 0644 down to 0600, so chmod explicitly.
      renameSync(hostTmp, canonicalTarget);
      chmodSync(canonicalTarget, 0o644);
      return { target: canonicalTarget, copied: true };
    } finally {
      rmSync(hostTmp, { force: true });
    }
  };
}

export function buildCopyInInfoOp(ctx: OpContext): OpHandler {
  return async (req) => {
    const payload = payloadOf(req) as { hostSource?: unknown; workerPath?: unknown };
    const canonicalSource = assertExternalCopyTarget(payload.hostSource, ctx.config.externalCopyTargets);
    assertSandboxPath(payload.workerPath, ctx.config.resource.pathMaxBytes);
    let st: Stats;
    try {
      st = statSync(canonicalSource);
    } catch {
      throw new ValidationError("copy source does not exist on the host");
    }
    if (!st.isFile()) {
      throw new ValidationError("copy source must be a regular file");
    }
    return { source: canonicalSource, bytes: st.size };
  };
}

export function buildCopyInOp(ctx: OpContext): OpHandler {
  return async (req) => {
    const payload = payloadOf(req) as { hostSource?: unknown; workerPath?: unknown; confirm?: unknown };
    if (payload.confirm !== "COPY") {
      throw new ValidationError('copyIn requires confirm: "COPY"');
    }
    const canonicalSource = assertExternalCopyTarget(payload.hostSource, ctx.config.externalCopyTargets);
    assertSandboxPath(payload.workerPath, ctx.config.resource.pathMaxBytes);
    const record = recordOr404(ctx.store, req.sessionID);
    const worker = requireActiveWorker(record);

    const workerTmp = `/work/.broker-tmp/copy-${randomUUID()}.tmp`;
    const mkdirRes = await ctx.adapter.exec(worker, ["mkdir", "-p", workerDirOf(workerTmp)], {
      timeoutMs: 30_000,
    });
    if (mkdirRes.status !== 0) {
      throw new MsbError(`copyIn mkdir failed in worker (status ${mkdirRes.status}): ${mkdirRes.stderr.trim()}`);
    }
    // copyIn throws MsbError on failure (msb.ts).
    await ctx.adapter.copyIn(worker, canonicalSource, workerTmp);
    const moved = await ctx.adapter.exec(worker, ["mv", "-f", workerTmp, payload.workerPath as string], {
      timeoutMs: 30_000,
    });
    if (moved.status !== 0) {
      throw new MsbError(`copyIn failed in worker (status ${moved.status}): ${moved.stderr.trim()}`);
    }
    return { path: payload.workerPath };
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
      // Trailing-newline guarantee: the transport strips the final \n and
      // git apply rejects patches whose last line lacks it (live finding).
      const patchContent = (payload.patch as string).endsWith("\n")
        ? (payload.patch as string)
        : `${payload.patch as string}\n`;
      writeFileSync(hostTmp, patchContent, { mode: 0o644 });
      // chmod, not the create mode: see buildWriteFileOp — umask masking.
      chmodSync(hostTmp, 0o644);
      const mkdirRes = await ctx.adapter.exec(worker, ["mkdir", "-p", workerDirOf(workerTmp)], { timeoutMs: 30_000 });
      if (mkdirRes.status !== 0) {
        throw new MsbError(`applyPatch mkdir failed in worker (status ${mkdirRes.status}): ${mkdirRes.stderr.trim()}`);
      }
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
    const payload = payloadOf(req) as { mode?: unknown };
    const mode = payload.mode ?? "active";
    if (mode !== "active" && mode !== "retained") throw new ValidationError("diff mode must be active or retained");
    const record = recordOr404(ctx.store, req.sessionID);
    if (mode === "retained") return buildRetainedDiff(ctx, record);
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
    // Gate 6 follow-up: for whole-file temps (added paths ending in ".new"),
    // also report the diff against the sibling original (or a
    // .broker-tmp/ref-<added> delivery reference) so the approval prompt
    // shows the real change instead of the full new file.
    let compare = "";
    const nameStatus = await ctx.adapter.exec(worker, ["git", "diff", "--name-status", ref, "HEAD"], {
      cwd: "/work",
      timeoutMs: 60_000,
    });
    for (const line of nameStatus.stdout.split("\n")) {
      const m = /^A[\t ]+(.+)$/.exec(line.trim());
      if (!m) continue;
      const added = m[1]!;
      if (!added.endsWith(".new")) continue;
      const candidates = [added.slice(0, -4), `.broker-tmp/ref-${added}`];
      for (const cand of candidates) {
        // Gate 6 finding: git diff --no-index treats a MISSING path as
        // empty and exits 1, so a non-existent sibling would be accepted
        // as a full-file diff and shadow the ref. Probe existence first.
        const exists = await ctx.adapter.exec(worker, ["test", "-e", cand], {
          cwd: "/work",
          timeoutMs: 30_000,
        });
        if (exists.status !== 0) continue;
        const cmp = await ctx.adapter.exec(worker, ["git", "diff", "--no-index", "--", cand, added], {
          cwd: "/work",
          timeoutMs: 60_000,
        });
        // exit 0 = identical, 1 = differences; anything else skips.
        if (cmp.status !== 0 && cmp.status !== 1) continue;
        compare += cmp.stdout + "\n";
        break;
      }
    }
    const changedPathResult = await ctx.adapter.exec(
      worker,
      buildChangedPathsArgv(ref, "HEAD"),
      {
        cwd: "/work",
        timeoutMs: 60_000,
      },
    );
    const parsedChangedPaths =
      changedPathResult.status === 0
        ? parseNulDelimitedPaths(changedPathResult.stdout)
        : { paths: [], complete: false };
    return {
      stat: stat.stdout,
      diff: diff.stdout,
      compare,
      changedPaths: parsedChangedPaths.paths,
      changedPathsComplete: changedPathResult.status === 0 && parsedChangedPaths.complete,
      exitCode: diff.status,
    };
  };
}

// ---------------------------------------------------------------------------
// Result boundary (§15, §18-§20)
// ---------------------------------------------------------------------------

export function buildPrepareResultOp(ctx: OpContext): OpHandler {
  return async (req) => {
    payloadOf(req);
    let record = recordOr404(ctx.store, req.sessionID);
    if (record.state !== "SANDBOX_ACTIVE" && record.state !== "RESULT_READY") {
      throw new StateError(`cannot prepare result from state ${record.state}`);
    }
    // Always re-export: runPrepare commits only new changes, so a retained
    // result after a failed apply is refreshed, not frozen (Gate 6 finding).
    const ref = await runPrepare(ctx, req.sessionID);
    if (record.state === "SANDBOX_ACTIVE") {
      record = ctx.store.transition(req.sessionID, "SANDBOX_ACTIVE", "RESULT_READY", { resultRef: ref });
    }
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

  // Worker side: stage the working tree (transfer artifacts excluded), commit
  // it when there is anything new, then publish result ref + bundle. Without
  // this commit HEAD stays at the baseline and the B->C delta is empty, so
  // apply always failed with "No valid patches in input" (Gate 6 finding).
  const add = await ctx.adapter.exec(
    worker,
    ["git", "add", "-A", "--", ".", ":(exclude).broker-tmp", ":(exclude)*.bundle"],
    { cwd: "/work", timeoutMs: 60_000 },
  );
  if (add.status !== 0) {
    throw new MsbError(`result staging failed: ${trimErr(add.stderr)}`);
  }
  // Nothing staged -> nothing new to export; keeps re-finish idempotent.
  const staged = await ctx.adapter.exec(worker, ["git", "diff", "--cached", "--quiet"], {
    cwd: "/work",
    timeoutMs: 60_000,
  });
  if (staged.status !== 0) {
    const commit = await ctx.adapter.exec(
      worker,
      ["git", "commit", "-q", "-m", `opencode-sandbox result for ${sessionID}`],
      { cwd: "/work", timeoutMs: 60_000 },
    );
    if (commit.status !== 0) {
      throw new MsbError(`result commit failed: ${trimErr(commit.stderr)}`);
    }
  }
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
  if (record.projectID === undefined) throw new StateError("project not in allowlist");
  const projectID: string = record.projectID;
  const imported = await ctx.git.spawn(["git", "fetch", "--no-tags", hostBundle, `${ref}:${ref}`], {
    cwd: projectDirFor(ctx, projectID),
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
      throw new ValidationError('applyResult requires confirm: "APPLY"');
    }
    let record = recordOr404(ctx.store, req.sessionID);
    if (record.state !== "RESULT_READY") {
      throw new StateError(`cannot apply result from state ${record.state}`);
    }
    if (record.projectID === undefined) throw new StateError("project not in allowlist");
    const projectID: string = record.projectID;
    const project = ctx.config.projects.find((p) => p.id === projectID);
    if (!project) throw new StateError("project not in allowlist");
    const resultRefName = record.resultRef ?? resultRef(req.sessionID);
    const baselineRefName = record.baselineRef ?? baselineRef(req.sessionID);

    record = ctx.store.transition(req.sessionID, "RESULT_READY", "APPLY_PENDING", {});

    // §19.1 / S16: host must still match the baseline the worker was built from.
    const divergence = await hostDivergence(ctx, projectID, baselineRefName);
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
    const changed = await changedPathsBetween(ctx, projectID, baselineRefName, resultRefName);
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

    const rawChanges = await rawChangesBetween(ctx, projectID, baselineRefName, resultRefName);
    const rejectedUnsafe = rawChanges
      .filter((change) => change.kind === "symlink" || change.kind === "submodule")
      .map((change) => `${change.kind}:${change.path}`);
    if (rejectedUnsafe.length > 0) {
      ctx.store.transition(req.sessionID, "APPLY_PENDING", "RESULT_READY", {
        error: `result contains unsafe symlink/submodule changes: ${rejectedUnsafe.join(", ")}`,
      });
      throw new StateError(`result contains unsafe symlink/submodule changes: ${rejectedUnsafe.join(", ")}`);
    }

    // §19.6: dry-run check then apply; working-tree only (no index/branch).
    const patchFile = patchPathFor(ctx.config.stateDir, req.sessionID);
    const patch = await ctx.git.spawn(["git", "diff", baselineRefName, resultRefName, "--", "."], {
      cwd: project.path,
      timeoutMs: 60_000,
    });
    if (patch.status !== 0) {
      ctx.store.transition(req.sessionID, "APPLY_PENDING", "RESULT_READY", { error: "diff generation failed" });
      throw new StateError("diff generation failed; result retained");
    }
    // Gate 6: the approval prompt preview caps at maxApplyDiffLines — never
    // ask the human to approve a delta larger than the preview can show.
    const patchLines = patch.stdout.split("\n").length;
    if (patchLines > ctx.config.resource.maxApplyDiffLines) {
      ctx.store.transition(req.sessionID, "APPLY_PENDING", "RESULT_READY", {
        error: `apply delta too large to review (${patchLines} > ${ctx.config.resource.maxApplyDiffLines} lines)`,
      });
      throw new StateError(
        `apply delta exceeds the reviewable preview limit (${patchLines} lines > ${ctx.config.resource.maxApplyDiffLines}); split the change into smaller applies and retry`,
      );
    }
    mkdirSync(join(ctx.config.stateDir, "patches"), { recursive: true, mode: 0o700 });
    writeFileSync(patchFile, patch.stdout, { mode: 0o600 });
    const check = await ctx.git.spawn(buildCheckArgv(patchFile), { cwd: project.path, timeoutMs: 60_000 });
    if (check.status !== 0) {
      ctx.store.transition(req.sessionID, "APPLY_PENDING", "RESULT_READY", {
        error: `git apply --check failed: ${check.stderr.trim()}`,
      });
      throw new StateError(`git apply --check failed (${check.stderr.trim()}); result retained`);
    }
    const applied = await ctx.git.spawn(["git", "apply", patchFile], { cwd: project.path, timeoutMs: 120_000 });
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
    // Gate 6 finding: APPLIED is terminal for the session's worker - release
    // the transient worker and its pool allocation now instead of leaking
    // them until an explicit stop/cleanup (pool exhaustion after demos).
    await releaseWorker(ctx, record);
    return { state: record.state, applied: true, resultRef: resultRefName };
  };
}

/** S16: compare current host tree with the baseline tree. */
async function hostDivergence(ctx: OpContext, projectID: string, baselineRefName: string): Promise<string[]> {
  const project = ctx.config.projects.find((p) => p.id === projectID);
  if (!project) throw new StateError("no projects configured");
  const gitDir = join(project.path, ".git");
  const tmpIndex = join(ctx.config.stateDir, "tmp", `divergence-${randomUUID()}.index`);
  const env = { GIT_DIR: gitDir, GIT_INDEX_FILE: tmpIndex };
  const currentTree = await ctx.git.spawn(["git", "add", "-A", "--"], { env, cwd: project.path, timeoutMs: 60_000 });
  if (currentTree.status !== 0) {
    throw new StateError(`cannot read host working tree: ${currentTree.stderr.trim()}`);
  }
  const lsFiles = await ctx.git.spawn(["git", "ls-files", "-s"], { env, cwd: project.path, timeoutMs: 60_000 });
  const baseline = await ctx.git.spawn(["git", "ls-tree", "-r", baselineRefName], { env, timeoutMs: 60_000 });
  return computeDivergence(
    parseLsTreeLines(baseline.stdout.split("\n")),
    parseLsFilesLines(lsFiles.stdout.split("\n")),
  );
}

/** §19.2: changed paths between baseline B and result C. */
async function changedPathsBetween(ctx: OpContext, projectID: string, baselineRefName: string, resultRefName: string): Promise<string[]> {
  const project = ctx.config.projects.find((p) => p.id === projectID);
  if (!project) throw new StateError("no projects configured");
  const gitDir = join(project.path, ".git");
  const raw = await ctx.git.spawn(
    buildChangedPathsArgv(baselineRefName, resultRefName),
    { env: { GIT_DIR: gitDir }, timeoutMs: 60_000 },
  );
  if (raw.status !== 0) {
    throw new StateError(`cannot diff result: ${raw.stderr.trim()}`);
  }
  const parsed = parseNulDelimitedPaths(raw.stdout);
  if (!parsed.complete) {
    throw new StateError("cannot diff result: changed path metadata incomplete");
  }
  return parsed.paths;
}

async function buildRetainedDiff(ctx: OpContext, record: SessionRecord): Promise<Record<string, unknown>> {
  if (record.state !== "RESULT_READY" && record.state !== "RETAINED") throw new StateError(`cannot inspect retained result from state ${record.state}`);
  const project = ctx.config.projects.find((p) => p.id === record.projectID);
  if (!project) throw new StateError("project not in allowlist");
  const baseline = record.baselineRef ?? baselineRef(record.sessionID);
  const result = record.resultRef;
  if (!result) throw new StateError("retained result has no result ref");
  const run = (argv: string[]) => ctx.git.spawn(argv, { cwd: project.path, timeoutMs: 60_000 });
  const stat = await run(["git", "diff", "--stat", baseline, result]);
  const diff = await run(["git", "diff", baseline, result]);
  const changedPathResult = await run(buildChangedPathsArgv(baseline, result));
  const parsedChangedPaths = changedPathResult.status === 0
    ? parseNulDelimitedPaths(changedPathResult.stdout)
    : { paths: [], complete: false };
  return {
    stat: stat.stdout,
    diff: diff.stdout,
    compare: "",
    changedPaths: parsedChangedPaths.paths,
    changedPathsComplete: changedPathResult.status === 0 && parsedChangedPaths.complete,
    exitCode: diff.status,
  };
}

async function rawChangesBetween(ctx: OpContext, projectID: string, baselineRefName: string, resultRefName: string) {
  const project = ctx.config.projects.find((p) => p.id === projectID);
  if (!project) throw new StateError("no projects configured");
  const gitDir = join(project.path, ".git");
  const raw = await ctx.git.spawn(
    ["git", "diff", "--raw", "--no-renames", baselineRefName, resultRefName, "--", "."],
    { env: { GIT_DIR: gitDir }, cwd: project.path, timeoutMs: 60_000 },
  );
  if (raw.status !== 0) throw new StateError(`cannot classify result diff: ${raw.stderr.trim()}`);
  if (raw.stdout.includes("\u0000")) throw new StateError("cannot classify result diff: raw metadata malformed");
  const lines = raw.stdout.length === 0 ? [] : raw.stdout.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.some((line) => line.length === 0)) throw new StateError("cannot classify result diff: raw metadata malformed");
  const changes = classifyRawDiff(lines);
  if (changes.length !== lines.length) throw new StateError("cannot classify result diff: raw metadata malformed");
  return changes;
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
      await releaseWorker(ctx, record);
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
      removePoolAllocation(ctx, record);
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
      await releaseWorker(ctx, record);
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
        maxApplyDiffLines: ctx.config.resource.maxApplyDiffLines,
      },
      network: ctx.config.network,
      readOnlyAgents: (ctx.config as { readOnlyAgents?: string[] }).readOnlyAgents ?? [],
      roleModels: (ctx.config as { roleModels?: Record<string, unknown> }).roleModels ?? {},
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

/**
 * Remove EXACTLY ONE pool allocation matching the record's resources.
 *
 * The previous value-match filter removed EVERY allocation with matching
 * values — in a homogeneous pool (all workers share perWorkerCpu /
 * perWorkerMemBytes) one release silently freed the whole pool, corrupting
 * admission accounting and (with the Feature 2 drain) oversubscribing the
 * real pool. A session owns exactly one allocation; remove that one (S22).
 */
function removePoolAllocation(ctx: OpContext, record: SessionRecord): void {
  const mem = record.resources?.memBytes ?? -1;
  const cpu = record.resources?.cpu ?? -1;
  const idx = ctx.pool.allocations.findIndex(
    (a) => a.memBytes === mem && a.cpu === cpu,
  );
  if (idx !== -1) ctx.pool.allocations.splice(idx, 1);
}

/**
 * Release a session's transient worker and its pool allocation (S22).
 *
 * This is the SINGLE choke point where allocations are freed — the queue
 * drain lives here so every release path (apply, keep, destroy, reaper)
 * also admits parked ensureWorker requests.
 */
export async function releaseWorker(ctx: OpContext, record: SessionRecord): Promise<void> {
  if (record.workerName && record.workerState !== "DESTROYED" && record.workerState !== "FAILED") {
    // Gate 6 finding: msb remove fails while a guest is still running, so
    // stop first, then remove; retry once in case removal races the stop.
    await ctx.adapter.stop(record.workerName).catch(() => undefined);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await ctx.adapter.remove(record.workerName);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
  removePoolAllocation(ctx, record);
  // Feature 2: a slot just freed — admit parked requests (fire-and-forget).
  drainQueue(ctx);
}

export { formatBytes };
