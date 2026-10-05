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
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  chmodSync,
  copyFileSync,
  renameSync,
  statSync,
  readFileSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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
  assertExpectedResultCommit,
  assertExternalCopyTarget,
  assertGrepQuery,
  assertPayloadKeys,
  assertPositiveInt,
  assertRegisterableProjectPath,
  assertRefComponent,
  assertSandboxPath,
  HostToolPolicy,
  resolveProjectID,
  ValidationError,
  type HostToolAccess,
} from "./validation.ts";
import {
  baselineRef,
  resultRef,
  RESULT_REF_PREFIX,
  buildCheckArgv,
  bundlePathFor,
  patchPathFor,
  applyPreviewPathFor,
  applyPreviewAnsiPathFor,
  coloriseDiff,
  buildChangedPathsArgv,
  parseNulDelimitedPaths,
  checkProtectedPaths,
  buildGitCommitArgv,
  buildGitPushArgv,
  buildGhIssueCreateArgv,
  capAndRedact,
  GIT_OUTPUT_MAX_BYTES,
  classifyRawDiff,
  computeDivergence,
  parseLsFilesLines,
  parseLsTreeLines,
} from "./gitops.ts";
import {
  buildResultCommitArgv,
  buildResultDeleteArgv,
  buildResultPatchArgv,
  buildResultRestoreArgv,
  planSandboxResultInstall,
  readSandboxResult,
} from "./sandbox-result.ts";
import {
  assertCopyOutReviewLimit,
  countCopyLines,
  isSourceCodeTarget,
} from "./copy-review.ts";
import { MsbError } from "./msb.ts";
import { StateError } from "./state.ts";
import {
  divergenceIndexPathFor,
  durableHostRefResolves,
  removeArtifact,
  removalNeedsDurableRef,
  removeSessionArtifacts,
  shouldRemoveSessionArtifacts,
} from "./artifacts.ts";
import { PolicyError, checkAdmission, type Admission } from "./policy.ts";
import {
  PendingQueue,
  QueuedTimedOutError,
  type QueuedEntry,
} from "./queue.ts";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  assertPlanDocHeading,
  assertPlanDocName,
  isWithin,
  normalizePlanDocContent,
  PLAN_DOC_TARGETS,
} from "./validation.ts";
import type {
  BrokerRequestEnvelope,
  SessionRecord,
  WorkerRecord,
  MetricsRecord,
  PolicyRecord,
  Operation,
  SessionState,
} from "./types.ts";

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
  sessionLocks?: Map<string, Promise<unknown>>;
  activeLocks?: Map<string, number>;
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

/**
 * Host-tool authorization (defence in depth; the plugin mirrors this for UX
 * only). Reads are open to every agent; mutations require the broker-derived
 * trusted agent to be an orchestrator identity (config `readOnlyAgents`). The
 * envelope `agent` is caller-controlled and never authorizes: only the broker
 * session record's agent is trusted, so an unknown session fails closed.
 */
export function authorizeHostDispatch(
  ctx: Pick<OpContext, "store"> & { config: { readOnlyAgents?: readonly string[] } },
  operation: string,
  sessionID: string,
  _reqAgent?: string,
): HostToolAccess {
  const policy = new HostToolPolicy(ctx.config.readOnlyAgents ?? []);
  const existing = ctx.store.get(sessionID);
  const trusted = existing?.agent;
  const decision = policy.decide(operation, trusted);
  if (!decision.allowed) {
    throw new PolicyError(
      `host ${decision.access} tool "${operation}" is orchestrator-only (${decision.reasonCode})`,
    );
  }
  return decision.access;
}

/**
 * Orchestrator identities the host plugin may bind: exactly the broker's
 * `readOnlyAgents` allowlist. A model-supplied or unknown agent is refused, so
 * the binding can only ever record a host-authoritative orchestrator identity.
 */
function assertBindableAgent(
  config: { readOnlyAgents?: readonly string[] },
  agent: unknown,
): string {
  if (typeof agent !== "string" || agent.length === 0) {
    throw new ValidationError("bindSessionAgent requires a non-empty agent");
  }
  if (agent.length > 128) {
    throw new ValidationError("bindSessionAgent agent exceeds 128 bytes");
  }
  const allow = config.readOnlyAgents ?? [];
  if (!allow.includes(agent)) {
    throw new PolicyError(
      `session agent binding refused: "${agent}" is not a host-authoritative orchestrator identity`,
    );
  }
  return agent;
}

/**
 * Host-authoritative session->agent binding (defence in depth for the
 * record-only `authorizeHostDispatch`).
 *
 * The OpenCode host plugin's `chat.params` hook calls this operation with the
 * host-resolved `{ sessionID, agent }` before the LLM turn that may emit tool
 * calls. The operation is NOT exposed as a `host_*`/`sandbox_*` tool and is not
 * classified as a host read or mutation, so a model (including a sandbox-worker
 * model, whose only broker reach is the sandbox tool surface) cannot invoke it;
 * `ensureWorker` - the only model-reachable path that writes `record.agent` -
 * refuses orchestrator identities before any side effect. The bound agent must
 * be in the orchestrator allowlist, and the first host-authoritative binding
 * wins: an existing binding for a different agent is refused, never
 * overwritten, so a model-reachable writer can never be the first writer of an
 * orchestrator identity.
 */
export function bindSessionAgent(
  ctx: Pick<OpContext, "store"> & { config: { readOnlyAgents?: readonly string[] } },
  sessionID: string,
  payload: unknown,
): SessionRecord {
  assertPayloadKeys("bindSessionAgent", payload);
  const agent = assertBindableAgent(
    ctx.config,
    (payload as { agent?: unknown } | undefined)?.agent,
  );
  const existing = ctx.store.get(sessionID);
  if (existing?.agent !== undefined && existing.agent !== agent) {
    throw new PolicyError(
      `session ${sessionID} is already bound to "${existing.agent}"; the first host-authoritative binding wins`,
    );
  }
  return ctx.store.touch(
    sessionID,
    { agent, lastOperation: "bindSessionAgent" },
    "bindSessionAgent",
  );
}

/** Plugin-only handler: records the host-resolved agent on the session record. */
export function buildBindSessionAgentOp(ctx: OpContext): OpHandler {
  return async (req) => bindSessionAgent(ctx, req.sessionID, req.payload);
}

/** Worker ops require an ACTIVE worker; state/workerState are authoritative (§10). */
function requireActiveWorker(record: SessionRecord): string {
  if (record.state !== "SANDBOX_ACTIVE" && record.state !== "RESULT_READY") {
    throw new StateError(
      `session ${record.sessionID} is not sandbox-active (state=${record.state})`,
    );
  }
  if (!record.workerName) {
    throw new StateError(
      `session ${record.sessionID} has no worker recorded — fail closed`,
    );
  }
  if (record.workerState === "DESTROYED" || record.workerState === "FAILED") {
    throw new StateError(
      `worker for session ${record.sessionID} is ${record.workerState}; re-ensure before use`,
    );
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

export function buildEnsureWorkerOp(ctx: OpContext): (req: BrokerRequestEnvelope, sendProgress?: (position: number) => void) => Promise<unknown> {
  return async (req, sendProgress) => {
    // Orchestrator read-only: refuse before any touch/admission side effect (R2).
    const existing = ctx.store.get(req.sessionID);
    const trusted = existing?.agent ?? req.agent;
    const readOnly =
      (ctx.config as { readOnlyAgents?: string[] }).readOnlyAgents ?? [];
    if (trusted && readOnly.includes(trusted)) {
      throw new PolicyError(
        `orchestrator agent "${trusted}" is not allowed to create a worker (orchestrator-readonly)`,
      );
    }
    if (req.agent && readOnly.includes(req.agent) && req.agent !== trusted) {
      throw new PolicyError(
        `orchestrator agent "${req.agent}" is not allowed to create a worker (orchestrator-readonly)`,
      );
    }
    const payload = payloadOf(req) as { projectDir?: unknown; snapshot?: unknown };
    const projectID = resolveProjectID(payload.projectDir, ctx.config.projects);
    const record = ctx.store.touch(req.sessionID, {
      projectID,
      agent: req.agent,
      lastOperation: "ensureWorker",
    }, "ensureWorker");

    // Fast paths. State gates run BEFORE admission so FAILED_CLOSED and
    // mid-creation sessions never park in the pool queue.
    switch (record.state) {
      case "SANDBOX_ACTIVE":
      case "RESULT_READY":
        // Worker reuse (§28): same session keeps its worker — unless the idle
        // reaper already released it (no workerName / DESTROYED / FAILED), in
        // which case fall through and (re)create on demand.
        if (
          record.workerName &&
          record.workerState !== "DESTROYED" &&
          record.workerState !== "FAILED"
        ) {
          if (payload.snapshot !== undefined) {
            await assertPinnedSnapshotCompatible(ctx, projectID, record, payload.snapshot);
          }
          const snapshot =
            (record as SessionRecordWithSnapshotIdentity).snapshotIdentity ??
            await pinnedSnapshotIdentity(ctx, projectID, record, payload.snapshot);
          return {
            worker: record.workerName,
            state: record.state,
            reused: true,
            snapshot,
          };
        }
        break;
      case "FAILED_CLOSED":
        throw new StateError(
          `session ${req.sessionID} is FAILED_CLOSED; manual review required`,
        );
      case "CREATING_SANDBOX":
        throw new StateError(
          `sandbox creation already in progress for ${req.sessionID} — retry`,
        );
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
      return parkAndWait(ctx, req, projectID, sendProgress);
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
  const existing2 = ctx.store.get(sessionID);
  const trusted2 = existing2?.agent ?? req.agent;
  const ro2 =
    (ctx.config as { readOnlyAgents?: string[] }).readOnlyAgents ?? [];
  if (trusted2 && ro2.includes(trusted2)) {
    throw new PolicyError(
      `orchestrator agent "${trusted2}" is not allowed to create a worker (orchestrator-readonly)`,
    );
  }
  const store = ctx.store;
  const record = recordOr404(store, sessionID);
  switch (record.state) {
    case "SANDBOX_ACTIVE":
    case "RESULT_READY":
      if (
        record.workerName &&
        record.workerState !== "DESTROYED" &&
        record.workerState !== "FAILED"
      ) {
        return { worker: record.workerName, state: record.state, reused: true };
      }
      break;
    case "FAILED_CLOSED":
      throw new StateError(
        `session ${sessionID} is FAILED_CLOSED; manual review required`,
      );
    case "CREATING_SANDBOX":
      throw new StateError(
        `sandbox creation already in progress for ${sessionID} — retry`,
      );
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
    const snapshotSelection = snapshotFromPayload(payloadOf(req)?.snapshot);
    const snapshot = await runSnapshot(ctx, repoDir, sessionID, bundle, snapshotSelection);

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
      [
        "git",
        "fetch",
        `/work/${sessionID}.bundle`,
        `${baselineRef(sessionID)}:refs/heads/baseline`,
      ],
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
        res = await ctx.adapter.exec(workerName, [...argv], {
          cwd: "/work",
          timeoutMs: 120_000,
        });
        if (res.status === 0) break;
        await new Promise((r) => setTimeout(r, 400));
      }
      if (!res || res.status !== 0) {
        throw new MsbError(
          `worker repo prep failed (${argv[1]}): ${trimErr(res?.stderr || res?.stdout || "")}`,
        );
      }
    }

    ctx.pool.allocations.push({
      cpu: ctx.budget.perWorkerCpu,
      memBytes: ctx.budget.perWorkerMemBytes,
    });
    const next = store.transition(
      sessionID,
      "CREATING_SANDBOX",
      "SANDBOX_ACTIVE",
      {
        workerName,
        workerState: "ACTIVE",
        baselineRef: baselineRef(sessionID),
        snapshotIdentity: snapshot,
        resultRef: undefined,
        error: undefined,
        resources: {
          cpu: ctx.budget.perWorkerCpu,
          memBytes: ctx.budget.perWorkerMemBytes,
        },
      } as Partial<SessionRecord> & { snapshotIdentity: SnapshotIdentity },
    );
    return { worker: workerName, state: next.state, reused: false, snapshot };
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
      // Terminal: the transport bundle/temp index are consumed.
      await gcSessionArtifacts(ctx, sessionID, "ensureWorker");
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
function parkAndWait(
  ctx: OpContext,
  req: BrokerRequestEnvelope,
  projectID: string,
  sendProgress?: (position: number) => void,
): Promise<unknown> {
  const queue = ctx.queue;
  if (!queue) {
    throw new StateError(
      "worker queue is not configured — cannot park request",
    );
  }
  const existing = queue.find(req.sessionID);
  if (existing) {
    sendProgress?.(existing.position);
    return existing.pending;
  }
  if (queue.length >= ctx.config.queueMaxLength) {
    throw new PolicyError(
      `worker queue full (${ctx.config.queueMaxLength}); retry later`,
    );
  }
  const timeoutMs = ctx.config.queueTimeoutMs;
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const pending = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  pending.catch(() => {});
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
  sendProgress?.(entry.position);
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

async function runQueuedCreation(
  ctx: OpContext,
  entry: QueuedEntry,
): Promise<void> {
  try {
    const result = await createWorkerForSession(
      ctx,
      entry.request,
      entry.sessionID,
      entry.projectID,
    );
    entry.resolve({
      ...(result as Record<string, unknown>),
      queued: true,
      queuePosition: entry.position,
    });
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
type SnapshotSelection = { worktree: true } | { resultRef: string } | { commit: string };
type SnapshotIdentity = { commit: string; tree: string; source: "worktree" | "resultRef" | "commit"; resultRef?: string; headSha: string };
type SessionRecordWithSnapshotIdentity = SessionRecord & { snapshotIdentity?: SnapshotIdentity };

function snapshotFromPayload(value: unknown): SnapshotSelection {
  if (value === undefined) return { worktree: true };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("snapshot must be an object");
  const snapshot = value as Record<string, unknown>;
  const keys = Object.keys(snapshot);
  if (keys.length !== 1) throw new ValidationError("snapshot must name exactly one of resultRef, commit, worktree");
  if (keys[0] === "worktree" && snapshot.worktree === true) return { worktree: true };
  if (keys[0] === "resultRef" && typeof snapshot.resultRef === "string" && /^refs\/opencode-sandbox\/result\/[A-Za-z0-9_-]{1,64}$/.test(snapshot.resultRef)) {
    return { resultRef: snapshot.resultRef };
  }
  if (keys[0] === "commit" && typeof snapshot.commit === "string" && /^[0-9a-fA-F]{40}$/.test(snapshot.commit)) {
    return { commit: snapshot.commit };
  }
  throw new ValidationError("snapshot must contain a valid resultRef, full commit SHA, or worktree: true");
}

async function assertPinnedSnapshotCompatible(
  ctx: OpContext,
  projectID: string,
  record: SessionRecord,
  rawSelection: unknown,
): Promise<void> {
  const selection = snapshotFromPayload(rawSelection);
  const repoDir = projectDirFor(ctx, projectID);
  const env = { GIT_DIR: join(repoDir, ".git") };
  if (!record.baselineRef) throw new StateError("existing worker has no pinned snapshot identity");
  const current = await ctx.git.spawn(["git", "rev-parse", "--verify", `${record.baselineRef}^{commit}`], { env, cwd: repoDir });
  if (current.status !== 0 || !/^[0-9a-f]{40}$/.test(current.stdout.trim())) throw new StateError("existing worker snapshot identity cannot be resolved");
  if (!("worktree" in selection)) {
    const reference = "resultRef" in selection ? selection.resultRef : selection.commit;
    const resolved = await ctx.git.spawn(["git", "rev-parse", "--verify", `${reference}^{commit}`], { env, cwd: repoDir });
    if (resolved.status !== 0 || !/^[0-9a-f]{40}$/.test(resolved.stdout.trim())) {
      throw new StateError("snapshot does not resolve to a commit in the registered project");
    }
    if (current.stdout.trim() !== resolved.stdout.trim()) throw new StateError("snapshot differs from the existing worker snapshot");
    return;
  }
  const head = await ctx.git.spawn(["git", "rev-parse", "--verify", "HEAD"], { env, cwd: repoDir });
  if (head.status !== 0) throw new StateError("project has no HEAD commit; cannot compare worker snapshot");
  const index = join(ctx.config.stateDir, "tmp", `${record.sessionID}.snapshot-check.index`);
  mkdirSync(join(ctx.config.stateDir, "tmp"), { recursive: true, mode: 0o700 });
  const worktreeEnv = { ...env, GIT_INDEX_FILE: index };
  try {
    for (const argv of [["git", "read-tree", "HEAD"], ["git", "add", "-A", "--"]]) {
      const result = await ctx.git.spawn(argv, { env: worktreeEnv, cwd: repoDir });
      if (result.status !== 0) throw new StateError(`cannot compare working-tree snapshot: ${trimErr(result.stderr)}`);
    }
    const tree = await ctx.git.spawn(["git", "write-tree"], { env: worktreeEnv, cwd: repoDir });
    const oldTree = await ctx.git.spawn(["git", "rev-parse", "--verify", `${current.stdout.trim()}^{tree}`], { env, cwd: repoDir });
    const oldParent = await ctx.git.spawn(["git", "rev-parse", "--verify", `${current.stdout.trim()}^`], { env, cwd: repoDir });
    const oldSubject = await ctx.git.spawn(["git", "log", "-1", "--format=%s", current.stdout.trim()], { env, cwd: repoDir });
    if (tree.status !== 0 || oldTree.status !== 0 || oldParent.status !== 0 || oldSubject.status !== 0 || tree.stdout.trim() !== oldTree.stdout.trim() || oldParent.stdout.trim() !== head.stdout.trim() || oldSubject.stdout.trim() !== `opencode-sandbox baseline for ${record.sessionID}`) {
      throw new StateError("snapshot differs from the existing worker snapshot");
    }
  } finally {
    rmSync(index, { force: true });
  }
}

async function pinnedSnapshotIdentity(
  ctx: OpContext,
  projectID: string,
  record: SessionRecord,
  rawSelection: unknown,
): Promise<SnapshotIdentity> {
  const repoDir = projectDirFor(ctx, projectID);
  const env = { GIT_DIR: join(repoDir, ".git") };
  if (!record.baselineRef) throw new StateError("existing worker has no pinned snapshot identity");
  const commit = await ctx.git.spawn(["git", "rev-parse", "--verify", `${record.baselineRef}^{commit}`], { env, cwd: repoDir });
  if (commit.status !== 0 || !/^[0-9a-f]{40}$/.test(commit.stdout.trim())) {
    throw new StateError("existing worker snapshot identity cannot be resolved");
  }
  const commitSha = commit.stdout.trim();
  const tree = await ctx.git.spawn(["git", "rev-parse", "--verify", `${commitSha}^{tree}`], { env, cwd: repoDir });
  const head = await ctx.git.spawn(["git", "rev-parse", "--verify", `${commitSha}^`], { env, cwd: repoDir });
  const subject = await ctx.git.spawn(["git", "log", "-1", "--format=%s", commitSha], { env, cwd: repoDir });
  if (tree.status !== 0 || !/^[0-9a-f]{40}$/.test(tree.stdout.trim())) {
    throw new StateError("existing worker snapshot identity cannot be resolved");
  }
  const selection = rawSelection === undefined ? undefined : snapshotFromPayload(rawSelection);
  const source: SnapshotIdentity["source"] = selection
    ? "resultRef" in selection ? "resultRef" : "commit"
    : subject.status === 0 && subject.stdout.trim() === `opencode-sandbox baseline for ${record.sessionID}` ? "worktree" : "commit";
  return {
    commit: commitSha,
    tree: tree.stdout.trim(),
    source,
    ...(selection && "resultRef" in selection ? { resultRef: selection.resultRef } : {}),
    headSha: /^[0-9a-f]{40}$/.test(head.stdout.trim()) ? head.stdout.trim() : commitSha,
  };
}

async function runSnapshot(
  ctx: OpContext,
  repoDir: string,
  sessionID: string,
  bundle: string,
  selection: SnapshotSelection,
): Promise<SnapshotIdentity> {
  mkdirSync(join(ctx.config.stateDir, "bundles"), {
    recursive: true,
    mode: 0o700,
  });
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

  const head = await git(["git", "rev-parse", "--verify", "HEAD"]);
  if (head.status !== 0) throw new StateError(`project has no HEAD commit; cannot snapshot (${repoDir})`);
  const headSha = head.stdout.trim();
  let commitSha: string;
  let treeSha: string;
  let source: SnapshotIdentity["source"];
  let pinnedResultRef: string | undefined;
  if ("worktree" in selection) {
    const add = await git(["git", "add", "-A", "--"]);
    if (add.status !== 0) throw new StateError(`snapshot add failed: ${trimErr(add.stderr)}`);
    const tree = await git(["git", "write-tree"]);
    if (tree.status !== 0) throw new StateError(`snapshot write-tree failed: ${trimErr(tree.stderr)}`);
    treeSha = tree.stdout.trim();
    const commit = await git(["git", "commit-tree", treeSha, "-p", "HEAD", "-m", `opencode-sandbox baseline for ${sessionID}`]);
    if (commit.status !== 0) throw new StateError(`snapshot commit-tree failed: ${trimErr(commit.stderr)}`);
    commitSha = commit.stdout.trim();
    source = "worktree";
  } else {
    const reference = "resultRef" in selection ? selection.resultRef : selection.commit;
    const resolved = await git(["git", "rev-parse", "--verify", `${reference}^{commit}`]);
    if (resolved.status !== 0 || !/^[0-9a-f]{40}$/.test(resolved.stdout.trim())) {
      throw new StateError("snapshot does not resolve to a commit in the registered project");
    }
    commitSha = resolved.stdout.trim();
    const tree = await git(["git", "rev-parse", "--verify", `${commitSha}^{tree}`]);
    if (tree.status !== 0 || !/^[0-9a-f]{40}$/.test(tree.stdout.trim())) throw new StateError("snapshot commit tree cannot be resolved");
    treeSha = tree.stdout.trim();
    source = "resultRef" in selection ? "resultRef" : "commit";
    if ("resultRef" in selection) pinnedResultRef = selection.resultRef;
  }
  const update = await git(["git", "update-ref", ref, commitSha]);
  if (update.status !== 0) throw new StateError(`snapshot update-ref failed: ${trimErr(update.stderr)}`);
  const bundleCreate = await git(["git", "bundle", "create", bundle, ref]);
  if (bundleCreate.status !== 0) throw new StateError(`snapshot bundle failed: ${trimErr(bundleCreate.stderr)}`);
  chmodSync(bundle, 0o644);
  return { commit: commitSha, tree: treeSha, source, ...(pinnedResultRef ? { resultRef: pinnedResultRef } : {}), headSha };
}

function trimErr(s: string): string {
  return s.trim().slice(0, 500);
}

/**
 * Best-effort removal of a session's on-disk transport artifacts (bundle,
 * temp indexes, patch, apply previews) after the session reaches a terminal
 * state or its result is imported. Removal is gated on durability, never on
 * state alone: a planned-mode / not-yet-imported result may still be the only
 * copy, so its artifacts survive until a durable host ref resolves (or the
 * result is deliberately abandoned). `opts.durable` lets a caller that just
 * completed a host import skip the probe. Logs the session id, artifact kind,
 * and bytes freed (or the failure) through the broker logger; never throws, so
 * a GC problem can never fail the operation that triggered it.
 */
async function gcSessionArtifacts(
  ctx: OpContext,
  sessionID: string,
  operation: string,
  opts: { durable?: boolean } = {},
): Promise<void> {
  try {
    const record = ctx.store.get(sessionID);
    if (!record) return;
    let remove: boolean;
    if (opts.durable === true) {
      // The caller just completed the host import; the ref is durable.
      remove = true;
    } else {
      let durable = false;
      const bundleExists = existsSync(
        bundlePathFor(ctx.config.stateDir, sessionID),
      );
      if (removalNeedsDurableRef(record, bundleExists)) {
        durable = await durableHostRefResolves(ctx, record);
      }
      remove = shouldRemoveSessionArtifacts(record, durable, bundleExists);
    }
    if (!remove) return;
    for (const r of removeSessionArtifacts(ctx.config.stateDir, sessionID)) {
      if (r.removed) {
        ctx.logger?.log?.({
          sessionID,
          operation,
          result: "ok",
          detail: `${r.kind} ${r.bytes} bytes`,
        });
      } else if (r.error) {
        ctx.logger?.log?.({
          sessionID,
          operation,
          result: "error",
          error: `${r.kind}: ${r.error}`,
        });
      }
    }
  } catch (err) {
    ctx.logger?.log?.({
      sessionID,
      operation,
      result: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Worker file/exec ops — all argv vectors, all validation-gated (§28)
// ---------------------------------------------------------------------------

export function buildExecOp(ctx: OpContext): OpHandler {
  return async (req) => {
    const payload = payloadOf(req) as {
      argv?: unknown;
      cwd?: unknown;
      timeoutMs?: unknown;
      env?: unknown;
    };
    assertArgv(payload.argv, {
      itemMaxBytes: ctx.config.resource.argvItemMaxBytes,
      maxItems: ctx.config.resource.argvMaxItems,
      totalMaxBytes: ctx.config.resource.argvTotalMaxBytes,
    });
    const timeoutMs =
      payload.timeoutMs === undefined
        ? ctx.config.resource.execTimeoutMsDefault
        : payload.timeoutMs;
    assertPositiveInt(
      timeoutMs,
      ctx.config.resource.execTimeoutMsMax,
      "timeoutMs",
    );
    let cwd: string | undefined;
    if (payload.cwd !== undefined) {
      if (payload.cwd === "/work") {
        cwd = "/work";
      } else {
        assertSandboxPath(payload.cwd, ctx.config.resource.pathMaxBytes);
        // The API cwd is project-relative; msb needs a guest-absolute workdir.
        // Relative workdirs are unusable by the guest, so anchor them under /work.
        cwd = resolve("/work", payload.cwd);
      }
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
    const path = payload.path as string;
    const maxBytes = ctx.config.resource.contentMaxBytes;
    // Size first: a read must be refused, never silently shortened. The read
    // limit equals the write limit, so anything sandbox_write accepts can be
    // read back whole by sandbox_edit.
    const stat = await ctx.adapter.exec(
      worker,
      ["stat", "-L", "-c", "%s:%F", "--", path],
      { timeoutMs: 30_000 },
    );
    if (stat.status !== 0) {
      throw new MsbError(
        `readFile failed in worker (status ${stat.status}): ${stat.stderr.trim()}`,
      );
    }
    const statLine = /^(\d+):(regular file|regular empty file)\s*$/.exec(stat.stdout);
    if (!statLine) {
      throw new ValidationError(`readFile target is not a regular file: ${path}`);
    }
    const size = Number(statLine[1]);
    if (size > maxBytes) {
      throw new ValidationError(
        `readFile refused: ${path} is ${size} bytes, over the ${maxBytes}-byte limit; use sandbox_grep or sandbox_copy_out`,
      );
    }
    // base64, not cat: the exact bytes survive the exec channel, including
    // CRLF line endings that the adapter's PTY normalization would rewrite.
    const result = await ctx.adapter.exec(
      worker,
      ["base64", "-w", "0", "--", path],
      {
        timeoutMs: 30_000,
        maxOutputBytes: Math.ceil(maxBytes / 3) * 4 + 64,
      },
    );
    if (result.status !== 0) {
      throw new MsbError(
        `readFile failed in worker (status ${result.status}): ${result.stderr.trim()}`,
      );
    }
    const bytes = Buffer.from(result.stdout.replace(/\s+/g, ""), "base64");
    if (bytes.length !== size) {
      throw new MsbError(
        `readFile refused: read ${bytes.length} of ${size} bytes from ${path} (truncated or changed during the read)`,
      );
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new ValidationError(
        `readFile refused: ${path} is not valid UTF-8 text; use sandbox_copy_out for binary files`,
      );
    }
    return { content };
  };
}

export function buildWriteFileOp(ctx: OpContext): OpHandler {
  return async (req) => {
    const payload = payloadOf(req) as { path?: unknown; content?: unknown };
    assertSandboxPath(payload.path, ctx.config.resource.pathMaxBytes);
    assertContent(payload.content, ctx.config.resource.contentMaxBytes);
    const record = recordOr404(ctx.store, req.sessionID);
    const worker = requireActiveWorker(record);

    const hostTmp = join(
      ctx.config.stateDir,
      "tmp",
      `write-${req.sessionID}-${randomUUID()}.tmp`,
    );
    const workerTmp = `/work/.broker-tmp/write-${randomUUID()}.tmp`;
    const targetPath = payload.path as string;
    let stageTmp: string | null = null;
    try {
      mkdirSync(join(ctx.config.stateDir, "tmp"), {
        recursive: true,
        mode: 0o700,
      });
      // 0644: msb copy preserves the host mode with ROOT ownership in the
      // guest; 0600 would be unreadable to the non-root worker user
      // (Gate 5 finding — chmod by nobody on a root-owned file is EPERM).
      const rawContent = payload.content as string;
      // Gate 6 follow-up: guarantee a trailing newline so the B->C diff and
      // git apply never reject on a missing final newline (layers above were
      // observed stripping it).
      const content = rawContent.endsWith("\n")
        ? rawContent
        : `${rawContent}\n`;
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
        throw new MsbError(
          `writeFile mkdir failed in worker (status ${mkdirRes.status}): ${mkdirRes.stderr.trim()}`,
        );
      }
      // Read the target's mode BEFORE replacing it: the replacement must keep
      // it (an executable script must stay executable).
      const targetMode = await existingTargetMode(ctx, worker, targetPath);
      await ctx.adapter.copyIn(worker, hostTmp, workerTmp);
      const targetDir = workerDirOf(targetPath);
      const targetMkdir = await ctx.adapter.exec(
        worker,
        ["mkdir", "-p", "--", targetDir],
        { timeoutMs: 30_000 },
      );
      if (targetMkdir.status !== 0) {
        throw new MsbError(
          `writeFile target mkdir failed in worker (status ${targetMkdir.status}): ${targetMkdir.stderr.trim()}`,
        );
      }
      // The copied-in temp is root-owned, so the worker user cannot chmod it.
      // Stage a worker-owned copy beside the target (same filesystem, so the
      // final mv stays an atomic rename), set its mode, then replace.
      stageTmp = `${targetDir}/.broker-write-${randomUUID()}.tmp`;
      await execOrThrow(ctx, worker, ["cp", "--", workerTmp, stageTmp], "writeFile stage");
      await execOrThrow(
        ctx,
        worker,
        ["chmod", targetMode ?? "644", "--", stageTmp],
        "writeFile chmod",
      );
      await execOrThrow(ctx, worker, ["mv", "-f", "--", stageTmp, targetPath], "writeFile");
      stageTmp = null;
      return { path: payload.path };
    } finally {
      rmSync(hostTmp, { force: true });
      // Best-effort worker cleanup; a failure here must not mask the result.
      const leftovers = stageTmp ? [workerTmp, stageTmp] : [workerTmp];
      await ctx.adapter
        .exec(worker, ["rm", "-f", "--", ...leftovers], { timeoutMs: 30_000 })
        .catch(() => undefined);
    }
  };
}

// ---------------------------------------------------------------------------
// Copy tool (S15): worker file <-> allowlisted host file
// ---------------------------------------------------------------------------

export function buildCopyOutInfoOp(ctx: OpContext): OpHandler {
  return async (req) => {
    const payload = payloadOf(req) as {
      workerPath?: unknown;
      hostTarget?: unknown;
    };
    assertSandboxPath(payload.workerPath, ctx.config.resource.pathMaxBytes);
    const target = assertExternalCopyTarget(
      payload.hostTarget,
      ctx.config.externalCopyTargets,
    );
    const record = recordOr404(ctx.store, req.sessionID);
    const worker = requireActiveWorker(record);
    const result = await ctx.adapter.exec(
      worker,
      ["cat", "--", payload.workerPath as string],
      {
        cwd: "/work",
        timeoutMs: 30_000,
      },
    );
    if (result.status !== 0) {
      throw new MsbError(
        `copyOutInfo failed in worker (status ${result.status}): ${result.stderr.trim()}`,
      );
    }
    const lines = result.stdout.split("\n");
    const totalLines = countCopyLines(result.stdout);
    assertCopyOutReviewLimit(
      target,
      totalLines,
      ctx.config.resource.maxApplyDiffLines,
    );
    const preview =
      !isSourceCodeTarget(target) && totalLines > 400
        ? `${lines.slice(0, 400).join("\n")}\n(... truncated: ${totalLines} total lines)`
        : result.stdout;
    return { target, totalLines, preview };
  };
}

export function buildCopyOutOp(ctx: OpContext): OpHandler {
  return async (req) => {
    const payload = payloadOf(req) as {
      workerPath?: unknown;
      hostTarget?: unknown;
      confirm?: unknown;
    };
    if (payload.confirm !== "COPY") {
      throw new ValidationError('copyOut requires confirm: "COPY"');
    }
    assertSandboxPath(payload.workerPath, ctx.config.resource.pathMaxBytes);
    const canonicalTarget = assertExternalCopyTarget(
      payload.hostTarget,
      ctx.config.externalCopyTargets,
    );
    const record = recordOr404(ctx.store, req.sessionID);
    const worker = requireActiveWorker(record);

    const hostTmp = join(
      ctx.config.stateDir,
      "tmp",
      `copy-${req.sessionID}-${randomUUID()}.tmp`,
    );
    try {
      mkdirSync(join(ctx.config.stateDir, "tmp"), {
        recursive: true,
        mode: 0o700,
      });
      // copyOut throws MsbError on failure (msb.ts) — the host target is
      // never written partially.
      // msb needs an absolute endpoint; workerPath is validated relative.
      const workerAbs = (payload.workerPath as string).startsWith("/")
        ? (payload.workerPath as string)
        : `/work/${payload.workerPath as string}`;
      await ctx.adapter.copyOut(worker, workerAbs, hostTmp);
      // Recheck the bytes actually copied before creating a backup or touching the host target.
      const copiedContent = readFileSync(hostTmp, "utf8");
      assertCopyOutReviewLimit(
        canonicalTarget,
        countCopyLines(copiedContent),
        ctx.config.resource.maxApplyDiffLines,
      );
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
    const payload = payloadOf(req) as {
      hostSource?: unknown;
      workerPath?: unknown;
    };
    const canonicalSource = assertExternalCopyTarget(
      payload.hostSource,
      ctx.config.externalCopyTargets,
    );
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
    const payload = payloadOf(req) as {
      hostSource?: unknown;
      workerPath?: unknown;
      confirm?: unknown;
    };
    if (payload.confirm !== "COPY") {
      throw new ValidationError('copyIn requires confirm: "COPY"');
    }
    const canonicalSource = assertExternalCopyTarget(
      payload.hostSource,
      ctx.config.externalCopyTargets,
    );
    assertSandboxPath(payload.workerPath, ctx.config.resource.pathMaxBytes);
    const record = recordOr404(ctx.store, req.sessionID);
    const worker = requireActiveWorker(record);

    const workerTmp = `/work/.broker-tmp/copy-${randomUUID()}.tmp`;
    const mkdirRes = await ctx.adapter.exec(
      worker,
      ["mkdir", "-p", workerDirOf(workerTmp)],
      {
        timeoutMs: 30_000,
      },
    );
    if (mkdirRes.status !== 0) {
      throw new MsbError(
        `copyIn mkdir failed in worker (status ${mkdirRes.status}): ${mkdirRes.stderr.trim()}`,
      );
    }
    // copyIn throws MsbError on failure (msb.ts).
    await ctx.adapter.copyIn(worker, canonicalSource, workerTmp);
    const moved = await ctx.adapter.exec(
      worker,
      ["mv", "-f", workerTmp, payload.workerPath as string],
      {
        timeoutMs: 30_000,
      },
    );
    if (moved.status !== 0) {
      throw new MsbError(
        `copyIn failed in worker (status ${moved.status}): ${moved.stderr.trim()}`,
      );
    }
    return { path: payload.workerPath };
  };
}

/** Run a worker command; any non-zero status fails closed with its stderr. */
async function execOrThrow(
  ctx: OpContext,
  worker: string,
  argv: string[],
  what: string,
): Promise<void> {
  const res = await ctx.adapter.exec(worker, argv, { timeoutMs: 30_000 });
  if (res.status !== 0) {
    throw new MsbError(`${what} failed in worker (status ${res.status}): ${res.stderr.trim()}`);
  }
}

/**
 * Octal mode of an existing regular-file target, or null when the target
 * does not exist. A non-regular target (directory, device) is refused, and a
 * target that exists but cannot be inspected fails closed.
 */
async function existingTargetMode(
  ctx: OpContext,
  worker: string,
  path: string,
): Promise<string | null> {
  const stat = await ctx.adapter.exec(
    worker,
    ["stat", "-L", "-c", "%a:%F", "--", path],
    { timeoutMs: 30_000 },
  );
  if (stat.status === 0) {
    const m = /^([0-7]{3,4}):(regular file|regular empty file)\s*$/.exec(stat.stdout);
    if (!m) throw new ValidationError(`writeFile target is not a regular file: ${path}`);
    return m[1]!;
  }
  const exists = await ctx.adapter.exec(worker, ["test", "-e", path], { timeoutMs: 30_000 });
  if (exists.status === 0) {
    throw new MsbError(
      `writeFile could not read the existing mode of ${path}: ${stat.stderr.trim()}`,
    );
  }
  return null;
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

    const hostTmp = join(
      ctx.config.stateDir,
      "tmp",
      `patch-${req.sessionID}-${randomUUID()}.patch`,
    );
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
      const mkdirRes = await ctx.adapter.exec(
        worker,
        ["mkdir", "-p", workerDirOf(workerTmp)],
        { timeoutMs: 30_000 },
      );
      if (mkdirRes.status !== 0) {
        throw new MsbError(
          `applyPatch mkdir failed in worker (status ${mkdirRes.status}): ${mkdirRes.stderr.trim()}`,
        );
      }
      await ctx.adapter.copyIn(worker, hostTmp, workerTmp);
      // §19.6: `git apply --check` before applying, inside the worker repo.
      const check = await ctx.adapter.exec(
        worker,
        ["git", "apply", "--check", workerTmp],
        {
          cwd: "/work",
          timeoutMs: 60_000,
        },
      );
      if (check.status !== 0) {
        throw new MsbError(
          `patch does not apply cleanly: ${check.stderr.trim()}. Check unified-diff hunk line counts and include at least one unchanged context line in each changed-line hunk; an end-of-file append-only hunk is valid. Include a final newline.`,
        );
      }
      const applied = await ctx.adapter.exec(
        worker,
        ["git", "apply", workerTmp],
        {
          cwd: "/work",
          timeoutMs: 60_000,
        },
      );
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
    const result = await ctx.adapter.exec(
      worker,
      ["ls", "-la", payload.path as string],
      {
        timeoutMs: 30_000,
      },
    );
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
      [
        "grep",
        "-rn",
        "--exclude-dir=.git",
        "-e",
        payload.query as string,
        payload.path as string,
      ],
      { timeoutMs: 60_000 },
    );
    return { matches: result.stdout, exitCode: result.status };
  };
}

/**
 * Bounded line cap for the in-prompt apply-approval preview TEXT. It bounds
 * only the prompt; the complete B->C diff is always written in full to the
 * plain apply-preview artifact (writeApplyPreviewFiles), which is what the
 * reviewer inspects. Distinct from resource.maxApplyDiffLines, which bounds
 * source-code sandbox_copy_out review, not applies.
 */
export const APPLY_PREVIEW_MAX_LINES = 400;

export interface ApplyPreview {
  files: number;
  addedLines: number;
  removedLines: number;
  totalLines: number;
  preview: string;
  previewTruncated: boolean;
}

/**
 * Bounded, reviewable summary of a unified diff for the apply-approval
 * boundary. Exact file/added/removed counts are always returned; only the
 * preview text is capped, with an explicit truncation marker so approval is
 * never made against a UI-truncated unbounded payload.
 */
export function buildApplyPreview(diff: string): ApplyPreview {
  const lines = diff.length === 0 ? [] : diff.split("\n");
  let files = 0;
  let addedLines = 0;
  let removedLines = 0;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) files += 1;
    else if (line.startsWith("+") && !line.startsWith("+++")) addedLines += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removedLines += 1;
  }
  const totalLines = lines.length;
  const previewTruncated = totalLines > APPLY_PREVIEW_MAX_LINES;
  const shown = previewTruncated ? lines.slice(0, APPLY_PREVIEW_MAX_LINES) : lines;
  const preview = previewTruncated
    ? `${shown.join("\n")}\n(... preview truncated: showing ${APPLY_PREVIEW_MAX_LINES} of ${totalLines} lines; see previewFile for the full diff)`
    : shown.join("\n");
  return { files, addedLines, removedLines, totalLines, preview, previewTruncated };
}

export interface ApplyPreviewFiles {
  /** Plain, escape-free unified diff (stable path for editors). */
  plain: string;
  /** ANSI-coloured variant of the same diff for terminal reading. */
  ansi: string;
}

/**
 * Atomic host-side write: temp file in the same directory, then rename, so a
 * reader never observes a partial artifact. 0600 file (umask-independent via
 * chmod) mirroring the patches/<sessionID>.patch precedent.
 */
function writeFileAtomic(target: string, content: string): void {
  const tmp = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, content, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * R4: write the two apply-preview artifacts for a session under
 * <stateDir>/apply-preview/ (outside any worktree, so never tracked). Content
 * is written RAW, not redacted: it is the human's own pending diff and
 * redaction would corrupt the artifact they must inspect, matching the
 * patches/<sessionID>.patch precedent. 0700 directory, 0600 files.
 */
export function writeApplyPreviewFiles(
  stateDir: string,
  sessionID: string,
  diff: string,
): ApplyPreviewFiles {
  mkdirSync(join(stateDir, "apply-preview"), { recursive: true, mode: 0o700 });
  const plain = applyPreviewPathFor(stateDir, sessionID);
  const ansi = applyPreviewAnsiPathFor(stateDir, sessionID);
  writeFileAtomic(plain, diff);
  writeFileAtomic(ansi, coloriseDiff(diff));
  return { plain, ansi };
}

/**
 * Fail-closed approval invariant (§19): approval must never be blind. Before an
 * apply may proceed, the COMPLETE B->C diff must exist at the stable plain
 * apply-preview path. This re-writes the artifacts (idempotent with
 * buildDiffOp), then verifies the on-disk plain bytes equal the complete diff.
 * Only a write/verify failure — the condition that actually makes approval
 * blind — refuses; the diff's size is never a reason to refuse.
 */
function ensureCompleteApplyPreview(
  stateDir: string,
  sessionID: string,
  completeDiff: string,
): ApplyPreviewFiles {
  try {
    const files = writeApplyPreviewFiles(stateDir, sessionID, completeDiff);
    const onDisk = readFileSync(files.plain, "utf8");
    if (onDisk !== completeDiff) {
      throw new Error("plain preview artifact does not match the complete B->C diff");
    }
    return files;
  } catch (err) {
    throw new StateError(
      `apply-preview artifact unavailable: ${trimErr(err instanceof Error ? err.message : String(err))}; ` +
        "refusing to apply without a complete preview (result retained)",
    );
  }
}

export function buildDiffOp(ctx: OpContext): OpHandler {
  return async (req) => {
    const payload = payloadOf(req) as { mode?: unknown };
    const mode = payload.mode ?? "active";
    if (mode !== "active" && mode !== "retained")
      throw new ValidationError("diff mode must be active or retained");
    const record = recordOr404(ctx.store, req.sessionID);
    if (mode === "retained") return buildRetainedDiff(ctx, record);
    const worker = requireActiveWorker(record);
    const ref = record.baselineRef ?? baselineRef(record.sessionID);
    const stat = await ctx.adapter.exec(
      worker,
      ["git", "diff", "--stat", ref, "HEAD"],
      {
        cwd: "/work",
        timeoutMs: 60_000,
      },
    );
    const diff = await ctx.adapter.exec(worker, ["git", "diff", ref, "HEAD"], {
      cwd: "/work",
      timeoutMs: 60_000,
    });
    // Gate 6 follow-up: for whole-file temps (added paths ending in ".new"),
    // also report the diff against the sibling original (or a
    // .broker-tmp/ref-<added> delivery reference) so the approval prompt
    // shows the real change instead of the full new file.
    let compare = "";
    const nameStatus = await ctx.adapter.exec(
      worker,
      ["git", "diff", "--name-status", ref, "HEAD"],
      {
        cwd: "/work",
        timeoutMs: 60_000,
      },
    );
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
        const cmp = await ctx.adapter.exec(
          worker,
          ["git", "diff", "--no-index", "--", cand, added],
          {
            cwd: "/work",
            timeoutMs: 60_000,
          },
        );
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
    const applyPreviewDiff = compare.trim().length > 0 ? compare : diff.stdout;
    const applyPreviewFiles = writeApplyPreviewFiles(
      ctx.config.stateDir,
      req.sessionID,
      applyPreviewDiff,
    );
    return {
      stat: stat.stdout,
      diff: diff.stdout,
      compare,
      applyPreview: buildApplyPreview(applyPreviewDiff),
      applyPreviewFiles,
      changedPaths: parsedChangedPaths.paths,
      changedPathsComplete:
        changedPathResult.status === 0 && parsedChangedPaths.complete,
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
      record = ctx.store.transition(
        req.sessionID,
        "SANDBOX_ACTIVE",
        "RESULT_READY",
        { resultRef: ref },
      );
    }
    return { resultRef: ref, state: record.state, imported: true };
  };
}

/** Worker-side bundle export + host-side import under the sandbox namespace. */
export async function runPrepare(ctx: OpContext, sessionID: string): Promise<string> {
  const record = recordOr404(ctx.store, sessionID);
  const worker = requireActiveWorker(record);
  const ref = resultRef(sessionID);
  mkdirSync(join(ctx.config.stateDir, "bundles"), {
    recursive: true,
    mode: 0o700,
  });
  const hostBundle = bundlePathFor(ctx.config.stateDir, sessionID);
  const workerBundle = `/work/.broker-tmp/result-${sessionID}.bundle`;
  const stagingDir = await ctx.adapter.exec(
    worker,
    ["mkdir", "-p", "/work/.broker-tmp"],
    { cwd: "/work", timeoutMs: 30_000 },
  );
  if (stagingDir.status !== 0) {
    throw new MsbError(`result bundle staging directory failed: ${trimErr(stagingDir.stderr)}`);
  }

  // Worker side: stage the working tree (transfer artifacts excluded), commit
  // it when there is anything new, then publish result ref + bundle. Without
  // this commit HEAD stays at the baseline and the B->C delta is empty, so
  // apply always failed with "No valid patches in input" (Gate 6 finding).
  const add = await ctx.adapter.exec(
    worker,
    [
      "git",
      "add",
      "-A",
      "--",
      ".",
      ":(exclude).broker-tmp",
      ":(exclude)*.bundle",
    ],
    {
      cwd: "/work",
      timeoutMs: 60_000,
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "safe.directory",
        GIT_CONFIG_VALUE_0: "/work",
      },
    },
  );
  if (add.status !== 0) {
    throw new MsbError(`result staging failed: ${trimErr(add.stderr)}`);
  }
  // Nothing staged -> nothing new to export; keeps re-finish idempotent.
  const staged = await ctx.adapter.exec(
    worker,
    ["git", "diff", "--cached", "--quiet"],
    {
      cwd: "/work",
      timeoutMs: 60_000,
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "safe.directory",
        GIT_CONFIG_VALUE_0: "/work",
      },
    },
  );
  if (staged.status !== 0) {
    const commit = await ctx.adapter.exec(
      worker,
      ["git", "commit", "-q", "-m", `opencode-sandbox result for ${sessionID}`],
      {
      cwd: "/work",
      timeoutMs: 60_000,
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "safe.directory",
        GIT_CONFIG_VALUE_0: "/work",
      },
    },
    );
    if (commit.status !== 0) {
      throw new MsbError(`result commit failed: ${trimErr(commit.stderr)}`);
    }
  }
  const updated = await ctx.adapter.exec(
    worker,
    ["git", "update-ref", ref, "HEAD"],
    {
      cwd: "/work",
      timeoutMs: 60_000,
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "safe.directory",
        GIT_CONFIG_VALUE_0: "/work",
      },
    },
  );
  if (updated.status !== 0) {
    throw new MsbError(`result ref staging failed: ${trimErr(updated.stderr)}`);
  }
  const bundle = await ctx.adapter.exec(
    worker,
    ["git", "bundle", "create", workerBundle, ref],
    {
      cwd: "/work",
      timeoutMs: 120_000,
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "safe.directory",
        GIT_CONFIG_VALUE_0: "/work",
      },
    },
  );
  if (bundle.status !== 0) {
    throw new MsbError(`result bundle creation failed: ${trimErr(bundle.stderr)}`);
  }
  await ctx.adapter.copyOut(worker, workerBundle, hostBundle);

  // Host side: verify + import under the sandbox result namespace.
  if (ctx.git.runnerMode !== "real") {
    // Import is gated; the bundle is retained in the state dir for Gate 6.
    return ref;
  }
  const verify = await ctx.git.spawn(["git", "bundle", "verify", hostBundle], {
    timeoutMs: 60_000,
  });
  if (verify.status !== 0) {
    throw new MsbError(
      `result bundle verification failed: ${verify.stderr.trim()}`,
    );
  }
  if (record.projectID === undefined)
    throw new StateError("project not in allowlist");
  const projectID: string = record.projectID;
  const imported = await ctx.git.spawn(
    ["git", "fetch", "--no-tags", hostBundle, `+${ref}:${ref}`],
    {
      cwd: projectDirFor(ctx, projectID),
      timeoutMs: 120_000,
    },
  );
  if (imported.status !== 0) {
    throw new MsbError(`result import failed: ${imported.stderr.trim()}`);
  }
  // The result ref is now the durable copy on the host git side; the on-disk
  // transport bundle + temp index are redundant. Best effort: a GC failure
  // must never fail an already-successful import.
  await gcSessionArtifacts(ctx, sessionID, "prepareResult", { durable: true });
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
    if (record.projectID === undefined)
      throw new StateError("project not in allowlist");
    const projectID: string = record.projectID;
    const project = ctx.config.projects.find((p) => p.id === projectID);
    if (!project) throw new StateError("project not in allowlist");
    const resultRefName = record.resultRef ?? resultRef(req.sessionID);
    const baselineRefName = record.baselineRef ?? baselineRef(req.sessionID);

    record = ctx.store.transition(
      req.sessionID,
      "RESULT_READY",
      "APPLY_PENDING",
      {},
    );

    // §19.1 / S16: host must still match the baseline the worker was built from.
    const divergence = await hostDivergence(ctx, req.sessionID, projectID, baselineRefName);
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
    const changed = await changedPathsBetween(
      ctx,
      projectID,
      baselineRefName,
      resultRefName,
    );
    const rejectedProtected = checkProtectedPaths(changed, [
      ...ctx.config.protectedPaths,
      ...ctx.config.protectedSecurityFiles,
    ]);
    if (rejectedProtected.length > 0) {
      ctx.store.transition(req.sessionID, "APPLY_PENDING", "RESULT_READY", {
        error: `result touches protected paths: ${rejectedProtected.join(", ")}`,
      });
      throw new StateError(
        `result touches protected paths (S7/S17): ${rejectedProtected.join(", ")}`,
      );
    }

    const rawChanges = await rawChangesBetween(
      ctx,
      projectID,
      baselineRefName,
      resultRefName,
    );
    const rejectedUnsafe = rawChanges
      .filter(
        (change) => change.kind === "symlink" || change.kind === "submodule",
      )
      .map((change) => `${change.kind}:${change.path}`);
    if (rejectedUnsafe.length > 0) {
      ctx.store.transition(req.sessionID, "APPLY_PENDING", "RESULT_READY", {
        error: `result contains unsafe symlink/submodule changes: ${rejectedUnsafe.join(", ")}`,
      });
      throw new StateError(
        `result contains unsafe symlink/submodule changes: ${rejectedUnsafe.join(", ")}`,
      );
    }

    // §19.6: dry-run check then apply; working-tree only (no index/branch).
    const patchFile = patchPathFor(ctx.config.stateDir, req.sessionID);
    const patch = await ctx.git.spawn(
      ["git", "diff", baselineRefName, resultRefName, "--", "."],
      {
        cwd: project.path,
        timeoutMs: 60_000,
      },
    );
    if (patch.status !== 0) {
      ctx.store.transition(req.sessionID, "APPLY_PENDING", "RESULT_READY", {
        error: "diff generation failed",
      });
      throw new StateError("diff generation failed; result retained");
    }
    mkdirSync(join(ctx.config.stateDir, "patches"), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(patchFile, patch.stdout, { mode: 0o600 });
    // Approval must never be blind (§19): the complete B->C diff must be on
    // disk at the stable plain apply-preview path before any mutation. Fail
    // closed only when the artifact cannot be written or does not match — never
    // on its size.
    let applyPreviewFiles: ApplyPreviewFiles;
    try {
      applyPreviewFiles = ensureCompleteApplyPreview(
        ctx.config.stateDir,
        req.sessionID,
        patch.stdout,
      );
    } catch (err) {
      ctx.store.transition(req.sessionID, "APPLY_PENDING", "RESULT_READY", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    const check = await ctx.git.spawn(buildCheckArgv(patchFile), {
      cwd: project.path,
      timeoutMs: 60_000,
    });
    if (check.status !== 0) {
      ctx.store.transition(req.sessionID, "APPLY_PENDING", "RESULT_READY", {
        error: `git apply --check failed: ${check.stderr.trim()}`,
      });
      throw new StateError(
        `git apply --check failed (${check.stderr.trim()}); result retained`,
      );
    }
    const applied = await ctx.git.spawn(["git", "apply", patchFile], {
      cwd: project.path,
      timeoutMs: 120_000,
    });
    if (applied.status !== 0) {
      ctx.store.transition(req.sessionID, "APPLY_PENDING", "RESULT_READY", {
        error: `apply failed: ${applied.stderr.trim()}`,
      });
      throw new StateError(
        `apply failed (${applied.stderr.trim()}); host unchanged`,
      );
    }
    record = ctx.store.transition(req.sessionID, "APPLY_PENDING", "APPLIED", {
      error: undefined,
      resultRef: resultRefName,
    });
    // Gate 6 finding: APPLIED is terminal for the session's worker - release
    // the transient worker and its pool allocation now instead of leaking
    // them until an explicit stop/cleanup (pool exhaustion after demos).
    await releaseWorker(ctx, record);
    // APPLIED is terminal: the transport artifacts are consumed.
    await gcSessionArtifacts(ctx, req.sessionID, "applyResult");
    return {
      state: record.state,
      applied: true,
      resultRef: resultRefName,
      applyPreview: buildApplyPreview(patch.stdout),
      applyPreviewFiles,
    };
  };
}

/** S16: compare current host tree with the baseline tree. */
async function hostDivergence(
  ctx: OpContext,
  sessionID: string,
  projectID: string,
  baselineRefName: string,
): Promise<string[]> {
  const project = ctx.config.projects.find((p) => p.id === projectID);
  if (!project) throw new StateError("no projects configured");
  const gitDir = join(project.path, ".git");
  // Session-scoped (not a random UUID): the divergence temp index is a
  // transport artifact under the same state-dir retention rules.
  const tmpIndex = divergenceIndexPathFor(ctx.config.stateDir, sessionID);
  mkdirSync(join(ctx.config.stateDir, "tmp"), {
    recursive: true,
    mode: 0o700,
  });
  // A hard crash can leave the previous run's index behind; the first
  // `git add -A` would then reuse it as the staging index. Unlink it so
  // staging always starts clean; the finally below still removes it.
  removeArtifact({ kind: "divergence_index", path: tmpIndex });
  try {
    const env = { GIT_DIR: gitDir, GIT_INDEX_FILE: tmpIndex };
    const currentTree = await ctx.git.spawn(["git", "add", "-A", "--"], {
      env,
      cwd: project.path,
      timeoutMs: 60_000,
    });
    if (currentTree.status !== 0) {
      throw new StateError(
        `cannot read host working tree: ${currentTree.stderr.trim()}`,
      );
    }
    const lsFiles = await ctx.git.spawn(["git", "ls-files", "-s"], {
      env,
      cwd: project.path,
      timeoutMs: 60_000,
    });
    const baseline = await ctx.git.spawn(
      ["git", "ls-tree", "-r", baselineRefName],
      { env, timeoutMs: 60_000 },
    );
    return computeDivergence(
      parseLsTreeLines(baseline.stdout.split("\n")),
      parseLsFilesLines(lsFiles.stdout.split("\n")),
    );
  } finally {
    // The temp index is scratch: never leave it behind, even on a throw.
    removeArtifact({ kind: "divergence_index", path: tmpIndex });
  }
}

/** §19.2: changed paths between baseline B and result C. */
async function changedPathsBetween(
  ctx: OpContext,
  projectID: string,
  baselineRefName: string,
  resultRefName: string,
): Promise<string[]> {
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
    throw new StateError(
      "cannot diff result: changed path metadata incomplete",
    );
  }
  return parsed.paths;
}

async function buildRetainedDiff(
  ctx: OpContext,
  record: SessionRecord,
): Promise<Record<string, unknown>> {
  if (record.state !== "RESULT_READY" && record.state !== "RETAINED")
    throw new StateError(
      `cannot inspect retained result from state ${record.state}`,
    );
  const project = ctx.config.projects.find((p) => p.id === record.projectID);
  if (!project) throw new StateError("project not in allowlist");
  const baseline = record.baselineRef ?? baselineRef(record.sessionID);
  const result = record.resultRef;
  if (!result) throw new StateError("retained result has no result ref");
  const run = (argv: string[]) =>
    ctx.git.spawn(argv, { cwd: project.path, timeoutMs: 60_000 });
  const stat = await run(["git", "diff", "--stat", baseline, result]);
  const diff = await run(["git", "diff", baseline, result]);
  const changedPathResult = await run(buildChangedPathsArgv(baseline, result));
  const parsedChangedPaths =
    changedPathResult.status === 0
      ? parseNulDelimitedPaths(changedPathResult.stdout)
      : { paths: [], complete: false };
  return {
    stat: stat.stdout,
    diff: diff.stdout,
    compare: "",
    changedPaths: parsedChangedPaths.paths,
    changedPathsComplete:
      changedPathResult.status === 0 && parsedChangedPaths.complete,
    exitCode: diff.status,
  };
}

async function rawChangesBetween(
  ctx: OpContext,
  projectID: string,
  baselineRefName: string,
  resultRefName: string,
) {
  const project = ctx.config.projects.find((p) => p.id === projectID);
  if (!project) throw new StateError("no projects configured");
  const gitDir = join(project.path, ".git");
  const raw = await ctx.git.spawn(
    [
      "git",
      "diff",
      "--raw",
      "--no-renames",
      baselineRefName,
      resultRefName,
      "--",
      ".",
    ],
    { env: { GIT_DIR: gitDir }, cwd: project.path, timeoutMs: 60_000 },
  );
  if (raw.status !== 0)
    throw new StateError(`cannot classify result diff: ${raw.stderr.trim()}`);
  if (raw.stdout.includes("\u0000"))
    throw new StateError("cannot classify result diff: raw metadata malformed");
  const lines = raw.stdout.length === 0 ? [] : raw.stdout.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.some((line) => line.length === 0))
    throw new StateError("cannot classify result diff: raw metadata malformed");
  const changes = classifyRawDiff(lines);
  if (changes.length !== lines.length)
    throw new StateError("cannot classify result diff: raw metadata malformed");
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
      record = ctx.store.transition(
        req.sessionID,
        "SANDBOX_ACTIVE",
        "RESULT_READY",
        {
          resultRef: ref,
        },
      );
    }
    if (record.state !== "RESULT_READY" && record.state !== "APPLIED") {
      throw new StateError(`cannot keep result from state ${record.state}`);
    }
    if (record.workerName && record.workerState === "ACTIVE") {
      await releaseWorker(ctx, record);
    }
    ctx.store.touch(req.sessionID, {
      workerState: record.workerName ? "DESTROYED" : undefined,
    });
    record = ctx.store.transition(req.sessionID, record.state, "RETAINED", {
      error: undefined,
    });
    // RETAINED is terminal for artifact retention: the durable copy lives in
    // the result ref; the on-disk transport bundle is redundant.
    await gcSessionArtifacts(ctx, req.sessionID, "keepResult");
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
      await ctx.git.spawn(["git", "update-ref", "-d", ref], {
        timeoutMs: 30_000,
      });
    }
    ctx.store.transition(req.sessionID, record.state, "REJECTED", {
      workerState: record.workerName ? "DESTROYED" : undefined,
      error: undefined,
    });
    // REJECTED is terminal: the transport artifacts are consumed.
    await gcSessionArtifacts(ctx, req.sessionID, "discardResult");
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
    return {
      sessionID: record.sessionID,
      state: record.state,
      worker: record.workerName ?? null,
      workerState: record.workerState ?? null,
    };
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
      protectedPaths: [
        ...ctx.config.protectedPaths,
        ...ctx.config.protectedSecurityFiles,
      ],
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
      readOnlyAgents:
        (ctx.config as { readOnlyAgents?: string[] }).readOnlyAgents ?? [],
      roleModels:
        (ctx.config as { roleModels?: Record<string, unknown> }).roleModels ??
        {},
    };
    return policy;
  };
}

// ---------------------------------------------------------------------------
// Host git/GH mutations (fixed argv; orchestrator-only; §31)
// ---------------------------------------------------------------------------

/**
 * Resolve an approved project directory to its canonical root with realpath
 * equality (the same BROKER_PROJECTS boundary the SDD runtime uses).
 */
function resolveCanonicalProjectRoot(
  ctx: OpContext,
  projectDir: unknown,
): { projectID: string; projectRoot: string } {
  const projectID = resolveProjectID(projectDir, ctx.config.projects);
  const project = ctx.config.projects.find((p) => p.id === projectID);
  if (!project) throw new ValidationError("project is not in the trusted allowlist");
  let canonicalRoot: string;
  let canonicalRequested: string;
  try {
    canonicalRoot = realpathSync(project.path);
    canonicalRequested = realpathSync(projectDir as string);
  } catch {
    throw new ValidationError("project root does not resolve on the host");
  }
  if (canonicalRequested !== canonicalRoot) {
    throw new ValidationError("host tool requires the exact approved project root");
  }
  return { projectID, projectRoot: canonicalRoot };
}

interface HostStepResult {
  argv: string[];
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn one host git/gh step with the shared 512-KiB output cap. */
async function runHostStep(
  ctx: OpContext,
  argv: string[],
  cwd: string,
  timeoutMs = 120_000,
): Promise<HostStepResult> {
  const result = await ctx.git.spawn(argv, {
    cwd,
    timeoutMs,
    maxOutputBytes: GIT_OUTPUT_MAX_BYTES,
  });
  return {
    argv,
    status: result.status,
    stdout: capAndRedact(result.stdout),
    stderr: capAndRedact(result.stderr),
  };
}

/**
 * Session states whose durable B→C result ref can be read by host tools.
 * `APPLIED` is included so an applied result stays inspectable.
 */
const RESULT_READABLE_STATES: readonly SessionState[] = [
  "RESULT_READY",
  "RETAINED",
  "APPLIED",
];

interface ResultRefPolicy {
  /** Acceptable session states for the caller. */
  states: readonly SessionState[];
  /** Fail-closed error prefix, e.g. "cannot commit" / "cannot read result". */
  prefix: string;
  /** Commit wording: the state gate is specifically "applied". */
  applied: boolean;
}

/** Read-op policy: any state with a durable result, read wording. */
const RESULT_READ_POLICY: ResultRefPolicy = {
  states: RESULT_READABLE_STATES,
  prefix: "cannot read result",
  applied: false,
};

/**
 * Install-op policy: any state with a durable result. Installing writes the
 * result's own diff paths into the working tree under one approval; it is not
 * the commit gate, so APPLIED is not required.
 */
const RESULT_INSTALL_POLICY: ResultRefPolicy = {
  states: RESULT_READABLE_STATES,
  prefix: "cannot install result",
  applied: false,
};

/**
 * Resolve a session's durable B→C result refs. Shared by the commit op
 * (an `APPLIED` result or an installed result whose recorded commit is present)
 * and the read op (any state with a durable result). The
 * identifier is a session id (validated as a git ref component), never an
 * arbitrary commit/tree/branch/path: the broker derives the refs from its own
 * persisted record, requires the record to be in the sandbox result namespace
 * and bound to the same project as the caller, and fails closed otherwise.
 */
function resolveResultRefs(
  ctx: OpContext,
  callerSessionID: string,
  projectID: string,
  sandboxSessionID: unknown,
  policy: ResultRefPolicy,
): { baseline: string; result: string } {
  const { states, prefix, applied } = policy;
  if (sandboxSessionID === undefined) {
    const record = recordOr404(ctx.store, callerSessionID);
    const commitEligible =
      applied &&
      Boolean(record.installedCommit) &&
      (record.state === "RESULT_READY" || record.state === "RETAINED");
    if ((!states.includes(record.state) && !commitEligible) || !record.resultRef) {
      throw new StateError(
        applied
          ? `${prefix}: no applied B→C result for this session`
          : `${prefix}: no B→C result for this session`,
      );
    }
    if (record.projectID !== projectID) {
      throw new StateError(
        applied
          ? `${prefix}: this session's applied result is not bound to this project`
          : `${prefix}: this session's result is not bound to this project`,
      );
    }
    return {
      baseline: record.baselineRef ?? baselineRef(record.sessionID),
      result: record.resultRef,
    };
  }
  if (typeof sandboxSessionID !== "string") {
    throw new ValidationError("sandboxSessionID must be a string");
  }
  // A session id is also a git ref component and a state-file name: reject
  // anything that could traverse or name an outside ref before any lookup.
  assertRefComponent(sandboxSessionID);
  const record = recordOr404(ctx.store, sandboxSessionID);
  const commitEligible = applied && Boolean(record.installedCommit) &&
    (record.state === "RESULT_READY" || record.state === "RETAINED");
  if ((!states.includes(record.state) && !commitEligible) || !record.resultRef) {
    throw new StateError(
      applied
        ? `${prefix}: sandbox session ${sandboxSessionID} has no applied B→C result`
        : `${prefix}: sandbox session ${sandboxSessionID} has no B→C result`,
    );
  }
  if (record.projectID !== projectID) {
    throw new StateError(
      `${prefix}: sandbox session ${sandboxSessionID} is not bound to this project`,
    );
  }
  if (!record.resultRef.startsWith(`${RESULT_REF_PREFIX}/`)) {
    throw new StateError(
      `${prefix}: sandbox session ${sandboxSessionID} result ref is outside the sandbox result namespace`,
    );
  }
  return {
    baseline: record.baselineRef ?? baselineRef(sandboxSessionID),
    result: record.resultRef,
  };
}

/**
 * Resolve a commit-eligible B→C result. The result is the caller's own applied
 * or recorded-installed result unless `sandboxSessionID` names the delegated
 * session whose result should be committed instead.
 */
function resolveCommitResult(
  ctx: OpContext,
  callerSessionID: string,
  projectID: string,
  sandboxSessionID: unknown,
): { baseline: string; result: string } {
  return resolveResultRefs(ctx, callerSessionID, projectID, sandboxSessionID, {
    states: ["APPLIED"],
    prefix: "cannot commit",
    applied: true,
  });
}

/**
 * Ref-scoped commit: derive exactly the resolved result's persisted B→C paths,
 * reject protected paths (S17) and an empty result, then stage/commit ONLY
 * those paths. Never `git add -A`; unrelated staged work is never swept.
 *
 * The result is the caller's own applied result unless `sandboxSessionID`
 * names the (delegated) session whose result should be committed instead.
 */
export function buildGitCommitOp(ctx: OpContext): OpHandler {
  return async (req) => {
    const payload = payloadOf(req) as {
      projectDir?: unknown;
      message?: unknown;
      sandboxSessionID?: unknown;
    };
    authorizeHostDispatch(ctx, "gitCommit", req.sessionID, req.agent);
    const { projectID, projectRoot } = resolveCanonicalProjectRoot(ctx, payload.projectDir);
    const { baseline, result } = resolveCommitResult(
      ctx,
      req.sessionID,
      projectID,
      payload.sandboxSessionID,
    );
    const resultSessionID = (payload.sandboxSessionID ?? req.sessionID) as string;
    const resultRecord = recordOr404(ctx.store, resultSessionID);
    const resolvedResult = await runHostStep(
      ctx,
      buildResultCommitArgv(result),
      projectRoot,
      60_000,
    );
    const resultCommit = resolvedResult.stdout.trim().toLowerCase();
    if (resolvedResult.status !== 0 || !/^[0-9a-f]{40}$/.test(resultCommit)) {
      throw new StateError("cannot commit: result ref commit could not be resolved");
    }
    if (
      resultRecord.installedCommit &&
      resultRecord.installedCommit !== resultCommit
    ) {
      throw new StateError(
        "cannot commit: installed result commit no longer matches the result ref",
      );
    }
    const changed = await changedPathsBetween(ctx, projectID, baseline, result);
    if (changed.length === 0) {
      throw new StateError("refusing to commit: the B→C result is empty");
    }
    const rejected = checkProtectedPaths(changed, [
      ...ctx.config.protectedPaths,
      ...ctx.config.protectedSecurityFiles,
    ]);
    if (rejected.length > 0) {
      throw new StateError(
        `refusing to commit protected paths (S17): ${rejected.join(", ")}`,
      );
    }
    if (resultRecord.committedCommit) {
      return {
        committed: false,
        alreadyCommitted: true,
        committedCommit: resultRecord.committedCommit,
        paths: changed,
        steps: [],
      };
    }
    let retryParentCommit: string | undefined;
    if (resultRecord.pendingCommit) {
      const intent = resultRecord.pendingCommit;
      if (intent.resultCommit !== resultCommit) {
        throw new StateError("cannot commit: pending commit intent no longer matches the result ref");
      }
      const headResult = await runHostStep(ctx, ["git", "rev-parse", "HEAD"], projectRoot);
      const head = headResult.stdout.trim().toLowerCase();
      if (headResult.status !== 0 || !/^[0-9a-f]{40}$/.test(head)) {
        throw new StateError("cannot commit: pending commit HEAD could not be determined");
      }
      if (head === intent.parentCommit) {
        // The prior git commit did not advance HEAD; retry the commit below.
        retryParentCommit = head;
      } else {
        const parentResult = await runHostStep(ctx, ["git", "rev-parse", "HEAD^"], projectRoot);
        const parent = parentResult.stdout.trim().toLowerCase();
        if (
          parentResult.status !== 0 ||
          !/^[0-9a-f]{40}$/.test(parent) ||
          parent !== intent.parentCommit
        ) {
          throw new StateError(
            "cannot commit: pending commit state is ambiguous; stop the broker and follow the exact pendingCommit recovery procedure in docs/TODO.md",
          );
        }
        const treeResult = await runHostStep(
          ctx,
          ["git", "diff", "--quiet", resultCommit, "HEAD", "--", ...changed],
          projectRoot,
        );
        if (treeResult.status !== 0) {
          throw new StateError(
            "cannot commit: HEAD does not carry the pending result; stop the broker and follow the pendingCommit recovery procedure in docs/TODO.md",
          );
        }
        ctx.store.transition(resultSessionID, resultRecord.state, "RETAINED", {
          installedCommit: resultCommit,
          committedCommit: head,
          pendingCommit: undefined,
        });
        return {
          committed: false,
          alreadyCommitted: true,
          committedCommit: head,
          paths: changed,
          steps: [],
        };
      }
    }
    const parentCommit = retryParentCommit ?? await (async () => {
      const parentResult = await runHostStep(ctx, ["git", "rev-parse", "HEAD"], projectRoot);
      const parent = parentResult.stdout.trim().toLowerCase();
      if (parentResult.status !== 0 || !/^[0-9a-f]{40}$/.test(parent)) {
        throw new StateError("cannot commit: current HEAD could not be recorded before commit");
      }
      return parent;
    })();
    ctx.store.touch(resultSessionID, {
      pendingCommit: { resultCommit, parentCommit },
    });
    const steps = buildGitCommitArgv({
      paths: changed,
      message: payload.message as string,
    });
    const results: HostStepResult[] = [];
    for (const argv of steps) {
      const step = await runHostStep(ctx, argv, projectRoot);
      results.push(step);
      if (step.status !== 0) {
        throw new MsbError(`git commit failed (${argv[1]}): ${step.stderr}`);
      }
    }
    const committedHead = await runHostStep(ctx, ["git", "rev-parse", "HEAD"], projectRoot);
    const committedCommit = committedHead.stdout.trim().toLowerCase();
    if (committedHead.status !== 0 || !/^[0-9a-f]{40}$/.test(committedCommit)) {
      throw new StateError("git commit succeeded but its committed HEAD could not be recorded");
    }
    ctx.store.transition(resultSessionID, resultRecord.state, "RETAINED", {
      installedCommit: resultCommit,
      committedCommit,
      pendingCommit: undefined,
    });
    return {
      committed: true,
      alreadyCommitted: false,
      committedCommit,
      paths: changed,
      steps: results,
    };
  };
}

/**
 * T1 read: inspect a session's durable B→C result ref with fixed argv only.
 *
 * The ref is resolved from a session id (never a caller-supplied raw ref);
 * `compareSandboxSessionID` selects a two-ref comparison between two
 * broker-resolved result refs. Read-only: no working-tree, index, or ref
 * mutation, and no worker activation.
 */
export function buildResultDiffOp(ctx: OpContext): OpHandler {
  return async (req) => {
    const payload = payloadOf(req) as { ref?: unknown };
    // Reuse ensureWorker's exact result-ref shape validation; never accept a raw Git revision.
    const selection = snapshotFromPayload({ resultRef: payload.ref });
    if (!("resultRef" in selection)) throw new ValidationError("ref must be a sandbox result ref");
    const ref = selection.resultRef;
    const projectID = ctx.config.advisorProjects
      .filter((id) => req.sessionID.startsWith(`advisor-${id}-`))
      .sort((a, b) => b.length - a.length)
      .find((id) => {
        const nonce = req.sessionID.slice(`advisor-${id}-`.length);
        return nonce.length === 16 && [...nonce].every((c) => "0123456789abcdef".includes(c));
      });
    if (!projectID) throw new PolicyError("resultDiff is available only to a registered advisor session");
    const project = ctx.config.projects.find((entry) => entry.id === projectID);
    if (!project) throw new StateError("advisor project is not registered");

    const sessionID = ref.slice(RESULT_REF_PREFIX.length + 1);
    const record = recordOr404(ctx.store, sessionID);
    if (!RESULT_READABLE_STATES.includes(record.state) || record.resultRef !== ref) {
      throw new StateError(`cannot read result: sandbox session ${sessionID} has no resolvable B→C result`);
    }
    if (record.projectID !== projectID) {
      throw new StateError(`cannot read result: sandbox session ${sessionID} is not bound to this project`);
    }
    const baseline = record.baselineRef ?? baselineRef(sessionID);
    const cwd = project.path;
    const git = async (argv: string[], what: string) => {
      const result = await ctx.git.spawn(argv, { cwd, timeoutMs: 60_000, maxOutputBytes: GIT_OUTPUT_MAX_BYTES });
      if (result.timedOut || result.status !== 0) {
        throw new StateError(`${what}: ${result.stderr.trim().slice(0, 500)}`);
      }
      return result.stdout;
    };
    const commit = (await git(buildResultCommitArgv(ref), "cannot resolve result ref")).trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new StateError("cannot resolve result ref: malformed commit identity");
    const baselineCommit = (await git(buildResultCommitArgv(baseline), "cannot resolve result baseline")).trim();
    if (!/^[0-9a-f]{40}$/.test(baselineCommit)) {
      throw new StateError("cannot resolve result baseline: malformed commit identity");
    }
    const rawDiff = await git(buildResultPatchArgv(baseline, ref), "cannot read result diff");
    if (Buffer.byteLength(rawDiff, "utf8") >= GIT_OUTPUT_MAX_BYTES) {
      throw new StateError("cannot read result diff: output reached the git output cap");
    }
    const preview = buildApplyPreview(rawDiff);
    return {
      ref,
      baseline,
      result: ref,
      commit,
      diff: preview.preview,
      truncated: preview.previewTruncated,
      totalLines: preview.totalLines,
      truncation: {
        helper: "buildApplyPreview",
        maxLines: APPLY_PREVIEW_MAX_LINES,
        maxBytes: GIT_OUTPUT_MAX_BYTES,
      },
    };
  };
}

export function buildSandboxResultOp(ctx: OpContext): OpHandler {
  return async (req) => {
    const payload = payloadOf(req) as {
      projectDir?: unknown;
      sandboxSessionID?: unknown;
      compareSandboxSessionID?: unknown;
    };
    authorizeHostDispatch(ctx, "sandboxResult", req.sessionID, req.agent);
    const { projectID, projectRoot } = resolveCanonicalProjectRoot(ctx, payload.projectDir);
    const { baseline, result } = resolveResultRefs(
      ctx,
      req.sessionID,
      projectID,
      payload.sandboxSessionID,
      RESULT_READ_POLICY,
    );
    // Resolve the comparison ref BEFORE any spawn so a bad second session
    // fails closed without touching git.
    let comparison: { sessionID: string; result: string } | null = null;
    if (payload.compareSandboxSessionID !== undefined) {
      const other = resolveResultRefs(
        ctx,
        req.sessionID,
        projectID,
        payload.compareSandboxSessionID,
        RESULT_READ_POLICY,
      );
      comparison = {
        sessionID: payload.compareSandboxSessionID as string,
        result: other.result,
      };
    }
    const sessionID =
      payload.sandboxSessionID === undefined
        ? req.sessionID
        : (payload.sandboxSessionID as string);
    const readResult = await readSandboxResult(ctx, projectRoot, sessionID, baseline, result, comparison);
    const completePatch = await ctx.git.spawn(buildResultPatchArgv(baseline, result), { cwd: projectRoot, timeoutMs: 60_000, maxOutputBytes: GIT_OUTPUT_MAX_BYTES });
    let applyPreviewFiles: ApplyPreviewFiles | undefined;
    if (completePatch.status === 0 && Buffer.byteLength(completePatch.stdout, "utf8") < GIT_OUTPUT_MAX_BYTES) {
      try {
        applyPreviewFiles = ensureCompleteApplyPreview(ctx.config.stateDir, sessionID, completePatch.stdout);
      } catch {
        // The install approval guard refuses a truncated preview without this artifact.
      }
    }
    return { ...readResult, ...(applyPreviewFiles ? { applyPreviewFiles } : {}) };
  };
}

/**
 * T2 install (approval-gated host mutation): write exactly the resolved B→C
 * result's own diff paths into the host working tree. The broker derives every
 * path from the persisted baseline/result refs; the caller never supplies a ref
 * or a path list. Fixed argv only: `git restore --source=<result> --worktree`
 * restores the working tree and never stages the index. The single human
 * approval is the manual review, so S17 paths surface through it rather than
 * being rejected (unlike gitCommit, which rejects them). No worker activation.
 */
export function buildSandboxResultInstallOp(ctx: OpContext): OpHandler {
  return async (req) => {
    const payload = payloadOf(req) as {
      projectDir?: unknown;
      sandboxSessionID?: unknown;
      expectedResultCommit?: unknown;
    };
    authorizeHostDispatch(ctx, "sandboxResultInstall", req.sessionID, req.agent);
    assertExpectedResultCommit(payload.expectedResultCommit);
    const expectedResultCommit = payload.expectedResultCommit;
    const { projectID, projectRoot } = resolveCanonicalProjectRoot(ctx, payload.projectDir);
    const { baseline, result } = resolveResultRefs(
      ctx,
      req.sessionID,
      projectID,
      payload.sandboxSessionID,
      RESULT_INSTALL_POLICY,
    );
    const resultSessionID = (payload.sandboxSessionID ?? req.sessionID) as string;
    const resultRecord = recordOr404(ctx.store, resultSessionID);
    if (
      resultRecord.installedCommit !== undefined &&
      resultRecord.installedCommit !== expectedResultCommit
    ) {
      throw new StateError(
        "cannot install result: stored installed commit does not match the requested result commit",
      );
    }
    const resolvedCommit = await runHostStep(
      ctx,
      buildResultCommitArgv(result),
      projectRoot,
      60_000,
    );
    if (resolvedCommit.status !== 0) {
      throw new StateError(
        `cannot install result: cannot resolve the result ref commit (${trimErr(resolvedCommit.stderr)})`,
      );
    }
    const resultCommit = resolvedCommit.stdout.trim().toLowerCase();
    if (resultCommit !== expectedResultCommit) {
      throw new StateError(
        `cannot install result: the result ref moved since the preview (result-commit-mismatch): expectedResultCommit ${expectedResultCommit}, resolved ${resultCommit}`,
      );
    }
    const changed = await changedPathsBetween(ctx, projectID, baseline, result);
    if (changed.length === 0) {
      throw new StateError("cannot install result: the B→C result is empty");
    }
    if (resultRecord.installedCommit !== undefined) {
      const worktreeProof = await runHostStep(
        ctx,
        ["git", "diff", "--quiet", result, "--", ...changed],
        projectRoot,
      );
      if (worktreeProof.status !== 0) {
        throw new StateError(
          "cannot install result: stored installed marker is stale; worktree does not match the result ref",
        );
      }
      return {
        installed: true,
        alreadyInstalled: true,
        resultRef: result,
        resultCommit,
      };
    }
    const rawChanges = await rawChangesBetween(ctx, projectID, baseline, result);
    const rawPaths = rawChanges.map((change) => change.path).sort();
    const sortedChanged = [...changed].sort();
    if (
      rawPaths.length !== sortedChanged.length ||
      rawPaths.some((path, index) => path !== sortedChanged[index])
    ) {
      throw new StateError(
        "cannot install result: raw metadata disagrees with the changed-path list",
      );
    }
    const unsafe = rawChanges
      .filter((change) => change.kind === "symlink" || change.kind === "submodule")
      .map((change) => `${change.kind}:${change.path}`);
    if (unsafe.length > 0) {
      throw new StateError(
        `cannot install result: unsafe symlink/submodule changes: ${unsafe.join(", ")}`,
      );
    }
    const { restorePaths, deletePaths } = planSandboxResultInstall(rawChanges);
    assertResultDeleteTargetsContained(projectRoot, deletePaths);
    const targetPaths = [...new Set([...restorePaths, ...deletePaths])].sort();
    if (targetPaths.length > 0) {
      const baselineCheck = await runHostStep(
        ctx,
        ["git", "diff", "--quiet", baseline, "--", ...targetPaths],
        projectRoot,
      );
      if (baselineCheck.status === 1) {
        const divergent = await runHostStep(
          ctx,
          ["git", "diff", "--name-only", "-z", baseline, "--", ...targetPaths],
          projectRoot,
        );
        if (divergent.status !== 0) {
          throw new StateError(
            `cannot install result: cannot identify baseline divergence (${trimErr(divergent.stderr)})`,
          );
        }
        const parsed = parseNulDelimitedPaths(divergent.stdout);
        if (!parsed.complete || parsed.paths.length === 0) {
          throw new StateError("cannot install result: cannot identify baseline divergence");
        }
        throw new StateError(
          `cannot install result: working tree diverged from baseline at: ${parsed.paths.join(", ")}`,
        );
      }
      if (baselineCheck.status !== 0) {
        throw new StateError(
          `cannot install result: baseline check failed (${trimErr(baselineCheck.stderr)})`,
        );
      }
    }
    const steps: HostStepResult[] = [];
    if (restorePaths.length > 0) {
      const restore = await runHostStep(
        ctx,
        buildResultRestoreArgv(result, restorePaths),
        projectRoot,
      );
      steps.push(restore);
      if (restore.status !== 0) {
        throw new MsbError(`cannot install result: git restore failed (${trimErr(restore.stderr)})`);
      }
    }
    if (deletePaths.length > 0) {
      const deleted = await runHostStep(ctx, buildResultDeleteArgv(deletePaths), projectRoot);
      steps.push(deleted);
      if (deleted.status !== 0) {
        throw new MsbError(
          `cannot install result: deleting removed paths failed (${trimErr(deleted.stderr)})`,
        );
      }
    }
    ctx.store.touch(resultSessionID, { installedCommit: expectedResultCommit });
    return {
      installed: true,
      alreadyInstalled: false,
      resultRef: result,
      resultCommit,
      paths: changed,
      restoredPaths: restorePaths,
      deletedPaths: deletePaths,
      steps,
    };
  };
}

function assertResultDeleteTargetsContained(projectRoot: string, paths: readonly string[]): void { for (const path of paths) { const target = resolve(projectRoot, path); let parentRealPath: string; try { parentRealPath = realpathSync(dirname(target)); } catch { throw new StateError(`cannot install result: result-delete-parent-unavailable: cannot resolve parent for ${path}`); } if (!isWithin(projectRoot, parentRealPath)) throw new StateError(`cannot install result: result-delete-parent-escape: resolved parent for ${path} is outside the project`); try { if (!lstatSync(target).isFile()) throw new StateError(`cannot install result: result-delete-not-regular-file: ${path}`); } catch (error) { if (error instanceof StateError) throw error; if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new StateError(`cannot install result: result-delete-target-unavailable: cannot inspect ${path}`); } } }
/**
 * Guarded push: the broker resolves branch/upstream/ahead itself and refuses
 * every unsafe condition BEFORE spawning the push.
 */
export function buildGitPushOp(ctx: OpContext): OpHandler {
  return async (req) => {
    const payload = payloadOf(req) as {
      projectDir?: unknown;
      remote?: unknown;
      setUpstream?: unknown;
      allowProtectedBranch?: unknown;
    };
    authorizeHostDispatch(ctx, "gitPush", req.sessionID, req.agent);
    const { projectRoot } = resolveCanonicalProjectRoot(ctx, payload.projectDir);
    const remote = payload.remote === undefined ? "origin" : payload.remote;
    if (typeof remote !== "string") {
      throw new ValidationError("remote must be a string");
    }
    if (payload.setUpstream !== undefined && typeof payload.setUpstream !== "boolean") {
      throw new ValidationError("setUpstream must be a boolean");
    }
    if (
      payload.allowProtectedBranch !== undefined &&
      typeof payload.allowProtectedBranch !== "boolean"
    ) {
      throw new ValidationError("allowProtectedBranch must be a boolean");
    }
    const head = await runHostStep(
      ctx,
      ["git", "symbolic-ref", "--short", "-q", "HEAD"],
      projectRoot,
      60_000,
    );
    const branch = head.status === 0 ? head.stdout.trim() : null;
    let upstream: string | null = null;
    if (branch !== null) {
      const up = await runHostStep(
        ctx,
        ["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        projectRoot,
        60_000,
      );
      upstream = up.status === 0 ? up.stdout.trim() : null;
    }
    let ahead = 0;
    if (branch !== null) {
      const count = await runHostStep(
        ctx,
        ["git", "rev-list", "--count", upstream !== null ? `${upstream}..HEAD` : "HEAD"],
        projectRoot,
        60_000,
      );
      if (count.status === 0) ahead = Number.parseInt(count.stdout.trim(), 10) || 0;
    }
    const argv = buildGitPushArgv({
      branch,
      upstream,
      ahead,
      remote,
      setUpstream: payload.setUpstream === true,
      allowProtectedBranch: payload.allowProtectedBranch === true,
    });
    const pushed = await runHostStep(ctx, argv, projectRoot);
    return {
      pushed: pushed.status === 0,
      branch,
      remote,
      upstream,
      ahead,
      stdout: pushed.stdout,
      stderr: pushed.stderr,
      status: pushed.status,
    };
  };
}

/** Fixed-argv GitHub issue creation; values validated by the builder. */
export function buildGhIssueCreateOp(ctx: OpContext): OpHandler {
  return async (req) => {
    const payload = payloadOf(req) as {
      projectDir?: unknown;
      repo?: unknown;
      title?: unknown;
      body?: unknown;
    };
    authorizeHostDispatch(ctx, "ghIssueCreate", req.sessionID, req.agent);
    const { projectRoot } = resolveCanonicalProjectRoot(ctx, payload.projectDir);
    const argv = buildGhIssueCreateArgv({
      repo: payload.repo as string,
      title: payload.title as string,
      body: payload.body as string,
    });
    const result = await runHostStep(ctx, argv, projectRoot);
    return {
      created: result.status === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.status,
    };
  };
}

export function buildHostOp(ctx: OpContext): OpHandler {
  return async (req) => {
    const op = req.operation as Operation;
    if (!ctx.hostRead.has(op)) {
      throw new StateError(`host read '${op}' is not enabled`);
    }
    const result = await ctx.hostRead.execute(
      op,
      payloadOf(req) as Record<string, unknown> | undefined,
    );
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
export async function releaseWorker(
  ctx: OpContext,
  record: SessionRecord,
): Promise<void> {
  if (
    record.workerName &&
    record.workerState !== "DESTROYED" &&
    record.workerState !== "FAILED"
  ) {
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
    await (ctx.adapter as unknown as { removeConfigDir?: (name: string) => Promise<void> }).removeConfigDir?.(record.workerName)?.catch(() => undefined);
  }
  removePoolAllocation(ctx, record);
  // Feature 2: a slot just freed — admit parked requests (fire-and-forget).
  drainQueue(ctx);
}

export function buildRegisterProjectOp(ctx: OpContext): OpHandler {
  return async (req) => {
    const payload = payloadOf(req) as {
      path?: unknown;
      dryRun?: unknown;
      createRemote?: unknown;
      makePublic?: unknown;
    };
    authorizeHostDispatch(ctx, "registerProject", req.sessionID, req.agent);
    // Forward the canonical resolved path: the registration script writes this
    // exact value into the sourced launcher conf, never the caller's alias.
    const target = assertRegisterableProjectPath(payload.path);
    if (payload.dryRun !== undefined && typeof payload.dryRun !== "boolean") {
      throw new ValidationError("dryRun must be a boolean");
    }
    if (payload.createRemote !== undefined && typeof payload.createRemote !== "boolean") {
      throw new ValidationError("createRemote must be a boolean");
    }
    if (payload.makePublic !== undefined && typeof payload.makePublic !== "boolean") {
      throw new ValidationError("makePublic must be a boolean");
    }
    if (payload.makePublic === true && payload.createRemote !== true) {
      throw new ValidationError("--public requires --create-remote");
    }
    const repoRoot = resolve(join(import.meta.dir, "../.."));
    const argv: string[] = ["bun", "scripts/register-project.ts"];
    if (payload.dryRun === true) argv.push("--dry-run");
    if (payload.createRemote === true) argv.push("--create-remote");
    if (payload.makePublic === true) argv.push("--public");
    argv.push(target);
    const result = await ctx.git.spawn(argv, {
      cwd: repoRoot,
      timeoutMs: 60_000,
    });
    if (result.status !== 0) {
      throw new MsbError(
        `registerProject failed (status ${result.status}): ${result.stderr.trim()}`,
      );
    }
    return {
      ok: true,
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.status,
    };
  };
}

// ---------------------------------------------------------------------------
// Plan-document mutation (append-only, atomic, orchestrator-only; §31)
// ---------------------------------------------------------------------------

const PLAN_DOC_TEMP_PREFIX = ".plan-doc-";
const PLAN_DOC_ATX_HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

interface PlanDocHeading {
  index: number;
  level: number;
  text: string;
  offset: number;
}

/** Serialize appends by canonical destination (mirrors the session lock chain). */
const planDocLocks = new Map<string, Promise<unknown>>();

async function withPlanDocLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = planDocLocks.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  planDocLocks.set(key, next.then(() => undefined, () => undefined));
  return next;
}

function scanPlanDocHeadings(existing: string): PlanDocHeading[] {
  const headings: PlanDocHeading[] = [];
  const lines = existing.split("\n");
  let offset = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const match = PLAN_DOC_ATX_HEADING_RE.exec(line);
    if (match) {
      headings.push({ index, level: match[1]!.length, text: match[2]!.trim(), offset });
    }
    offset += line.length + 1;
  }
  return headings;
}

/**
 * Insert `content` at EOF, or — with `heading` — immediately before the next
 * heading of equal or higher level. Existing bytes are preserved verbatim and
 * ordered; only separators and the new block are added. A missing or ambiguous
 * heading fails closed.
 */
export function computePlanDocAppend(existing: string, content: string, heading?: string): string {
  let insertionIndex = existing.length;
  if (heading !== undefined) {
    insertionIndex = planDocSectionInsertionIndex(existing, heading);
  }
  const before = existing.slice(0, insertionIndex);
  const after = existing.slice(insertionIndex);
  let insert = "";
  if (before.length > 0 && !before.endsWith("\n")) insert += "\n";
  insert += content + "\n";
  if (after.length > 0 && after.startsWith("#")) insert += "\n";
  return before + insert + after;
}

function planDocSectionInsertionIndex(existing: string, heading: string): number {
  const wanted = heading.trim();
  const headings = scanPlanDocHeadings(existing);
  const matches = headings.filter((entry) => entry.text === wanted);
  if (matches.length === 0) {
    throw new ValidationError(`plan document heading not found: ${wanted}`);
  }
  if (matches.length > 1) {
    throw new ValidationError(`plan document heading is ambiguous: ${wanted}`);
  }
  const match = matches[0]!;
  const next = headings.find((entry) => entry.index > match.index && entry.level <= match.level);
  return next ? next.offset : existing.length;
}

/** Ensure a path resolves (via realpath) beneath the canonical project root. */
function assertBeneathProjectRoot(projectRoot: string, target: string): void {
  let canonical: string;
  try {
    canonical = realpathSync(target);
  } catch {
    throw new ValidationError("plan document path does not resolve on the host");
  }
  if (!isWithin(projectRoot, canonical)) {
    throw new ValidationError("plan document escapes the approved project root");
  }
}

function lstatIfExists(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/** fsync a directory after a rename so the new name is durable (best effort). */
function fsyncPlanDocDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, constants.O_RDONLY);
    fsyncSync(fd);
  } catch {
    /* directory fsync is not supported on every platform */
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

interface PlanDocWriteResult {
  created: boolean;
  bytes: number;
}

/**
 * Atomic, append-only, serialized write of one plan document. Caller must hold
 * the destination lock. Writes a sibling exclusive temp file, fsyncs it,
 * revalidates the destination/parent, renames over the destination, and fsyncs
 * the directory; every failure path removes the temp file.
 */
async function appendPlanDocAtomically(
  projectRoot: string,
  destination: string,
  content: string,
  heading: string | undefined,
): Promise<PlanDocWriteResult> {
  const parent = dirname(destination);
  const existing = lstatIfExists(destination);
  if (existing !== undefined && !existing.isFile()) {
    throw new ValidationError("plan document destination is not a regular file");
  }
  if (existing === undefined) {
    mkdirSync(parent, { recursive: true, mode: 0o755 });
  }
  assertBeneathProjectRoot(projectRoot, parent);
  if (existing !== undefined) assertBeneathProjectRoot(projectRoot, destination);

  const current = existing !== undefined ? readFileSync(destination, "utf8") : "";
  const nextText = computePlanDocAppend(current, content, heading);

  const tempPath = join(parent, `${PLAN_DOC_TEMP_PREFIX}${randomUUID()}.tmp`);
  let tempWritten = false;
  try {
    const fd = openSync(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      writeFileSync(fd, nextText, { encoding: "utf8" });
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    tempWritten = true;

    // Revalidate immediately before rename (path/symlink drift).
    const currentEntry = lstatIfExists(destination);
    if (currentEntry !== undefined && !currentEntry.isFile()) {
      throw new ValidationError("plan document destination changed to a non-regular file");
    }
    assertBeneathProjectRoot(projectRoot, parent);

    renameSync(tempPath, destination);
    tempWritten = false;
    fsyncPlanDocDirectory(parent);
    return { created: existing === undefined, bytes: Buffer.byteLength(nextText, "utf8") };
  } finally {
    if (tempWritten) {
      try {
        unlinkSync(tempPath);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

/**
 * Orchestrator-only append to the allowlisted plan document. There is no
 * caller path, cwd, binary, or argv: `doc` is an enum mapped to a compile-time
 * constant beneath the canonical root.
 */
export function buildPlanDocAppendOp(ctx: OpContext): OpHandler {
  return async (req) => {
    const payload = payloadOf(req) as {
      projectDir?: unknown;
      doc?: unknown;
      content?: unknown;
      heading?: unknown;
    };
    authorizeHostDispatch(ctx, "planDocAppend", req.sessionID, req.agent);
    const { projectRoot } = resolveCanonicalProjectRoot(ctx, payload.projectDir);
    assertPlanDocName(payload.doc);
    const relative = PLAN_DOC_TARGETS[payload.doc];
    const destination = resolve(projectRoot, relative);
    if (!isWithin(projectRoot, destination)) {
      throw new ValidationError("plan document escapes the approved project root");
    }
    const rejected = checkProtectedPaths([relative], [
      ...ctx.config.protectedPaths,
      ...ctx.config.protectedSecurityFiles,
    ]);
    if (rejected.length > 0) {
      throw new ValidationError(
        `refusing protected plan document destination (S17): ${rejected.join(", ")}`,
      );
    }
    const content = normalizePlanDocContent(payload.content);
    let heading: string | undefined;
    if (payload.heading !== undefined) {
      assertPlanDocHeading(payload.heading);
      heading = payload.heading;
    }
    const result = await withPlanDocLock(destination, () =>
      appendPlanDocAtomically(projectRoot, destination, content, heading),
    );
    return {
      doc: payload.doc,
      path: relative,
      created: result.created,
      bytes: result.bytes,
    };
  };
}

export const registerProjectOperationMap = {
  registerProject: buildRegisterProjectOp,
};

export { formatBytes };
