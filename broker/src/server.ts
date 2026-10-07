/*
 * NDJSON-over-Unix-socket transport for the sandbox broker
 * (SYSTEM_PROMPT.md §6-§10, §20, §26).
 *
 * - Unix socket, chmod 0600, inside the user's runtime dir (0700): the
 *   socket is user-only by construction (§6).
 * - NDJSON request/response framing with per-line size caps; oversized lines
 *   fail closed.
 * - Dispatch is an explicit allowlist of handlers. ANY error — validation,
 *   state, policy, worker, snapshot — fails the request (S14). There is no
 *   fallback path from sandbox execution to host execution, ever.
 * - Per-session serialization via a promise chain so concurrent calls for
 *   one session cannot interleave state transitions.
 * - Feature 2 (pool queue): each NDJSON line is dispatched fire-and-forget,
 *   so a blocked (parked) ensureWorker never blocks other sessions' ops.
 *   When a client socket closes, its parked queue entries are cancelled so
 *   dead sessions cannot leak queue slots or spawn workers later.
 */
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BrokerConfig } from "./config.ts";
import { computeBudget, discoverHostResources } from "./policy.ts";
import { SessionStore, StateError } from "./state.ts";
import { MsbAdapter, MsbError, spawnArgv, type SpawnFn } from "./msb.ts";
import { HostReadExecutor, buildHostReadOps } from "./hostread.ts";
import { REVIEW_INPUT_DIR_NAME, REVIEW_INPUT_MAX_BYTES, SddRuntimeExecutor } from "./sdd-runtime.ts";
import {
  buildReviewAcknowledgeApprovedOp,
  buildReviewAssessOp,
  buildReviewCaptureCorrectionPlanOp,
  buildReviewCaptureRefuterOp,
  buildReviewCaptureResultOp,
  buildReviewCaptureUnachievableOp,
  buildReviewCaptureValidationOp,
  buildReviewLensContextOp,
  buildReviewModeStatusOp,
  buildReviewRecoverOp,
  buildReviewStartOp,
  buildReviewStatusOp,
  buildReviewValidateOp,
  buildSddArchiveComposeOp,
  buildSddAttemptGrantOp,
  buildSddContinueOp,
  buildSddStatusOp,
  buildSddTaskResultOp,
} from "./sdd-service.ts";
import { Logger, durationMs, startTimer } from "./logging.ts";
import {
  buildAdvisorAskOp,
  buildAdvisorGetOp,
  buildAdvisorEvidenceKeepOp,
  buildAdvisorListOp,
  buildAdvisorReadOp,
  buildAdvisorRespondOp,
} from "./advisor-records.ts";
import {
  advisorSocketPath,
  bindAdvisorRequest,
  newAdvisorSessionID,
  refuseAdvisorSessionOnMain,
  type AdvisorBinding,
} from "./advisor-socket.ts";
import { ValidationError } from "./validation.ts";
import { PolicyError } from "./policy.ts";
import { PendingQueue, QueuedTimedOutError } from "./queue.ts";
import { reapOnDisconnect, startReaper, type ReaperHandle } from "./reaper.ts";
import { drainQueue } from "./service.ts";
import { SANDBOX_OPERATIONS } from "./types.ts";
import {
  buildApplyOp,
  buildApplyResultOp,
  buildBindSessionAgentOp,
  buildCopyInInfoOp,
  buildCopyInOp,
  buildCopyOutInfoOp,
  buildCopyOutOp,
  buildDestroyWorkerOp,
  buildDiffOp,
  buildDiscardResultOp,
  buildEnsureWorkerOp,
  buildExecOp,
  buildGrepOp,
  buildGhIssueCreateOp,
  buildGitCommitOp,
  buildGitClearCommitIntentOp,
  buildGitPushOp,
  buildHostOp,
  buildKeepResultOp,
  buildListDirOp,
  buildListWorkersOp,
  buildMetricsOp,
  buildPolicyOp,
  buildPlanDocAppendOp,
  buildPrepareResultOp,
  buildReadFileOp,
  buildResultDiffOp,
  buildRegisterProjectOp,
  buildSandboxResultInstallOp,
  buildSandboxResultOp,
  buildWorkerStatusOp,
  buildWriteFileOp,
  type OpContext,
} from "./service.ts";
import type {
  BrokerError,
  BrokerRequestEnvelope,
  BrokerResponseEnvelope,
  Operation,
} from "./types.ts";

/** JSON escapes a byte to at most 6 bytes (`\u0000`); content may hold any character. */
const JSON_ESCAPE_WORST_CASE = 6;
/** Allowance for the request envelope and every non-payload field. */
const REQUEST_ENVELOPE_ALLOWANCE = 64 * 1024;
/** Bytes of an oversize line kept to recover its request id. */
const OVERSIZE_ID_PREFIX_BYTES = 512;
const OVERSIZE_ID_RE = /"id"\s*:\s*"([A-Za-z0-9-]{1,128})"/;

/**
 * The largest request line the broker accepts: the largest payload any
 * operation allows, JSON-escaped in the worst case, plus the envelope. Kept
 * derived from config so a raised payload limit can never be silently
 * undercut by the transport (TODO Tier 2 item 13).
 */
export function maxRequestLineBytes(resource: { contentMaxBytes: number; patchMaxBytes: number }): number {
  const largestPayload = Math.max(resource.contentMaxBytes, resource.patchMaxBytes, REVIEW_INPUT_MAX_BYTES);
  return largestPayload * JSON_ESCAPE_WORST_CASE + REQUEST_ENVELOPE_ALLOWANCE;
}

export type FramedRequest =
  | { kind: "line"; line: string }
  | { kind: "oversize"; id: string | undefined; bytes: number };

/**
 * Splits one connection's byte stream into newline-delimited request lines and
 * caps each line on its own. An oversize line is discarded up to its newline
 * and reported once, with the request id recovered from its first bytes, so
 * the connection (shared by every plugin session) stays usable.
 */
export class RequestLineFramer {
  private pending = Buffer.alloc(0);
  private discarding = false;
  private discardedBytes = 0;
  private discardPrefix = Buffer.alloc(0);

  constructor(private readonly maxLineBytes: number) {}

  push(chunk: Buffer): FramedRequest[] {
    const events: FramedRequest[] = [];
    let data = chunk;
    let offset = 0;
    if (this.discarding) {
      const nl = data.indexOf(0x0a);
      if (nl === -1) {
        this.discardedBytes += data.length;
        return events;
      }
      this.discardedBytes += nl;
      events.push(this.oversize(this.discardPrefix, this.discardedBytes));
      this.discarding = false;
      this.discardedBytes = 0;
      this.discardPrefix = Buffer.alloc(0);
      offset = nl + 1;
    } else if (this.pending.length > 0) {
      data = Buffer.concat([this.pending, chunk]);
    }
    let nl: number;
    while ((nl = data.indexOf(0x0a, offset)) !== -1) {
      const line = data.subarray(offset, nl);
      offset = nl + 1;
      events.push(
        line.length > this.maxLineBytes
          ? this.oversize(line, line.length)
          : { kind: "line", line: line.toString("utf8") },
      );
    }
    const rest = data.subarray(offset);
    if (rest.length > this.maxLineBytes) {
      this.discarding = true;
      this.discardedBytes = rest.length;
      this.discardPrefix = Buffer.from(rest.subarray(0, OVERSIZE_ID_PREFIX_BYTES));
      this.pending = Buffer.alloc(0);
    } else {
      this.pending = Buffer.from(rest);
    }
    return events;
  }

  private oversize(line: Buffer, bytes: number): FramedRequest {
    const prefix = line.subarray(0, OVERSIZE_ID_PREFIX_BYTES).toString("utf8");
    return { kind: "oversize", id: OVERSIZE_ID_RE.exec(prefix)?.[1], bytes };
  }
}
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9-]{1,128}$/;

interface SocketLike {
  write(data: string | Uint8Array): number;
  close(): void;
}

interface QueuedSocketWrite {
  data: Buffer;
  offset: number;
  id?: string;
}

/** Per-connection FIFO: never write a later frame until its predecessor drains. */
export class SocketWriteQueue {
  private readonly writes: QueuedSocketWrite[] = [];

  constructor(
    private readonly socket: SocketLike,
    private readonly onFailure: (error: unknown, id?: string) => void,
  ) {}

  get hasPendingWrites(): boolean {
    return this.writes.length > 0;
  }

  enqueue(data: string, id?: string): number {
    const write = { data: Buffer.from(data), offset: 0, id };
    this.writes.push(write);
    this.flush();
    return write.offset;
  }

  drain(): void {
    this.flush();
  }

  private flush(): void {
    while (this.writes.length > 0) {
      const write = this.writes[0]!;
      try {
        const remaining = write.data.subarray(write.offset);
        const writtenBytes = this.socket.write(remaining);
        if (!Number.isInteger(writtenBytes) || writtenBytes < 0 || writtenBytes > remaining.length) {
          throw new Error(`invalid socket write result: ${writtenBytes}`);
        }
        write.offset += writtenBytes;
        if (write.offset < write.data.length) return;
        this.writes.shift();
      } catch (error) {
        this.writes.length = 0;
        this.onFailure(error, write.id);
        return;
      }
    }
  }
}

type ServerContext = OpContext & { sddRuntime: SddRuntimeExecutor };

export class BrokerServer {
  private readonly logger: Logger;
  private readonly ctx: ServerContext;
  private readonly sessionLocks = new Map<string, Promise<unknown>>();
  private readonly activeLocks = new Map<string, number>();
  private readonly framers = new WeakMap<SocketLike, RequestLineFramer>();
  private readonly socketWrites = new WeakMap<SocketLike, SocketWriteQueue>();
  /** Sessions each socket has dispatched requests for (disconnect cleanup). */
  private readonly sessionsBySocket = new WeakMap<SocketLike, Set<string>>();
  /** Advisor connections and the one session each is bound to (advisor-socket.ts). */
  private readonly advisorBindings = new WeakMap<SocketLike, AdvisorBinding>();
  private readonly advisorListeners: Array<{ stop(closeActive?: boolean): void }> = [];
  private listener: { stop(): void } | null = null;
  private reaper: ReaperHandle | null = null;

  constructor(
    private readonly config: BrokerConfig,
    logger?: Logger,
  ) {
    this.logger =
      logger ?? new Logger({ file: config.logPath, toConsole: config.logPath === undefined });
    const store = new SessionStore(config.stateDir);
    const adapter = new MsbAdapter(config);
    const resources = discoverHostResources();
    const budget = computeBudget(resources, config.resource);
    const spawn: SpawnFn = (argv, opts) => spawnArgv(argv, opts);
    const hostRead = new HostReadExecutor({
      spawn,
      ops: buildHostReadOps(config.hostRead),
      approvedReadRoots: config.approvedExternalReadRoots,
      logLinesMax: config.resource.logLinesMax,
      outputMaxBytes: config.resource.outputMaxBytes,
    });
    const sddRuntime = new SddRuntimeExecutor({
      binary: config.sddRuntime.binary,
      projects: config.projects,
      outputMaxBytes: config.sddRuntime.outputMaxBytes,
      reviewInputDir: join(config.stateDir, REVIEW_INPUT_DIR_NAME),
      spawn,
    });
    this.ctx = {
      config,
      store,
      adapter,
      budget,
      resources,
      pool: { allocations: [] },
      queue: new PendingQueue(),
      sessionLocks: this.sessionLocks,
      activeLocks: this.activeLocks,
      hostRead,
      sddRuntime,
      logger: this.logger,
      git: {
        spawn,
        runnerMode: process.env.BROKER_GIT_MODE === "real" ? "real" : "planned",
      },
    };
  }

  /** Bind the Unix socket and start serving. Resolves once listening. */
  async start(): Promise<void> {
    const socketPath = this.config.socketPath;
    mkdirSync(join(socketPath, ".."), { recursive: true, mode: 0o700 });
    const listener = await Bun.listen({
      unix: socketPath,
      socket: {
        open: () => {
          /* nothing per-connection */
        },
        data: (socket, data: Buffer) => this.onData(socket as unknown as SocketLike, data),
        drain: (socket) => this.socketWrites.get(socket as unknown as SocketLike)?.drain(),
        close: (socket) => {
          this.onSocketClose(socket as unknown as SocketLike);
        },
        error: (socket, err) => {
          this.logger.log({
            operation: "connection",
            result: "error",
            error: String(err?.message ?? err),
          });
          this.onSocketClose(socket as unknown as SocketLike);
        },
      },
    });
    this.listener = listener;
    chmodSync(socketPath, 0o600);
    await this.startAdvisorListeners();
    this.logger.log({ operation: "broker.start", result: "ok" });
  }

  /**
   * One 0600 listener per configured advisor project. Each connection is bound
   * at open to a fresh broker-assigned session; see advisor-socket.ts.
   */
  private async startAdvisorListeners(): Promise<void> {
    for (const projectId of this.config.advisorProjects) {
      const project = this.config.projects.find((p) => p.id === projectId);
      if (!project) {
        throw new ValidationError(`advisor project '${projectId}' is not a registered project`);
      }
      const path = advisorSocketPath(this.config.socketPath, projectId);
      const listener = await Bun.listen({
        unix: path,
        socket: {
          open: (socket) => {
            const sessionID = newAdvisorSessionID(projectId);
            this.advisorBindings.set(socket as unknown as SocketLike, {
              projectId,
              projectPath: project.path,
              sessionID,
            });
            this.logger.log({ operation: "advisor.connect", sessionID, result: "ok" });
          },
          data: (socket, data: Buffer) => this.onData(socket as unknown as SocketLike, data),
          drain: (socket) => this.socketWrites.get(socket as unknown as SocketLike)?.drain(),
          close: (socket) => this.onSocketClose(socket as unknown as SocketLike),
          error: (socket, err) => {
            this.logger.log({ operation: "advisor.connection", result: "error", error: String(err?.message ?? err) });
            this.onSocketClose(socket as unknown as SocketLike);
          },
        },
      });
      this.advisorListeners.push(listener);
      chmodSync(path, 0o600);
    }
  }

  /**
   * Start the idle reaper (Feature 1). Call after start(): the sweeper
   * releases workers whose records are untouched past reapIdleMs.
   */
  startReaper(): void {
    if (this.reaper) return;
    this.reaper = startReaper(this.ctx, {
      intervalMs: this.config.reapIntervalMs,
      idleMs: this.config.reapIdleMs,
      artifactGraceMs: this.config.artifactGraceMs,
      onLog: (entry) =>
        this.logger.log({
          operation: "reaper",
          sessionID: entry.sessionID || undefined,
          result: entry.action === "error" ? "error" : "ok",
          error: entry.action === "error" ? entry.detail : undefined,
          detail: entry.action === "swept_artifact" ? entry.detail : undefined,
        }),
    });
  }

  /** Close the socket listener and stop the reaper (used by main.ts shutdown). */
  shutdown(): void {
    this.reaper?.stop();
    this.reaper = null;
    try {
      this.listener?.stop();
    } catch {
      /* already closed */
    }
    for (const listener of this.advisorListeners.splice(0)) {
      try {
        listener.stop();
      } catch {
        /* already closed */
      }
    }
  }

  private onData(socket: SocketLike, data: Buffer): void {
    let framer = this.framers.get(socket);
    if (!framer) {
      framer = new RequestLineFramer(maxRequestLineBytes(this.config.resource));
      this.framers.set(socket, framer);
    }
    for (const event of framer.push(data)) {
      if (event.kind === "line") {
        void this.dispatchLine(socket, event.line);
        continue;
      }
      // Refuse this request alone; the connection carries other sessions' work.
      this.respond(socket, {
        version: 1,
        id: event.id ?? "0",
        ok: false,
        error: {
          code: "protocol",
          message: `request line of ${event.bytes} bytes exceeds the ${maxRequestLineBytes(this.config.resource)}-byte cap`,
        },
      });
    }
  }

  private async dispatchLine(socket: SocketLike, line: string): Promise<void> {
    const t0 = startTimer();
    let envelope: BrokerRequestEnvelope;
    try {
      envelope = this.parseRequest(line);
    } catch (err) {
      this.respond(socket, this.errorResponse("0", err));
      return;
    }
    // The connection, not the request, decides an advisor's session and agent.
    try {
      const advisor = this.advisorBindings.get(socket);
      envelope = advisor ? bindAdvisorRequest(envelope, advisor) : refuseAdvisorSessionOnMain(envelope);
    } catch (err) {
      this.respond(socket, this.errorResponse(envelope.id, err));
      this.logger.log({ sessionID: envelope.sessionID, operation: envelope.operation, result: "error", error: String((err as Error).message) });
      return;
    }
    // Track the session on this socket so a close can cancel parked entries.
    const sessions = this.sessionsBySocket.get(socket) ?? new Set<string>();
    sessions.add(envelope.sessionID);
    this.sessionsBySocket.set(socket, sessions);
    try {
      const sendProgress = (position: number) => {
        this.respond(socket, { version: 1, id: envelope.id, progress: { queued: true, position } } as unknown as BrokerResponseEnvelope);
      };
      const result = await this.withSessionLock(envelope.sessionID, () =>
        this.dispatch(envelope, sendProgress),
      );
      // resultDiff is a strict read and must not create/touch session state.
      if (envelope.operation !== "resultDiff") {
        try { this.ctx.store.touch(envelope.sessionID, { lastOperation: envelope.operation }, envelope.operation); } catch {}
      }

      this.respond(socket, { version: 1, id: envelope.id, ok: true, result });
      this.logger.log({
        sessionID: envelope.sessionID,
        agent: envelope.agent,
        operation: envelope.operation,
        result: "ok",
        durationMs: durationMs(t0),
      });
    } catch (err) {
      const error = toBrokerError(err);
      this.respond(socket, { version: 1, id: envelope.id, ok: false, error });
      this.logger.log({
        sessionID: envelope.sessionID,
        agent: envelope.agent,
        operation: envelope.operation,
        result: "error",
        error: error.message,
        durationMs: durationMs(t0),
      });
    }
  }

  /** Feature 2 disconnect cleanup: cancel queue entries and reap idle SANDBOX_ACTIVE workers. */
  private onSocketClose(socket: SocketLike): void {
    const sessions = this.sessionsBySocket.get(socket);
    if (!sessions) return;
    for (const sessionID of sessions) {
      const cancelled = this.ctx.queue.cancel(sessionID, "client disconnected while queued for a worker slot");
      if (cancelled) {
        try {
          drainQueue(this.ctx);
        } catch {
          /* drain is best-effort */
        }
      }
      void reapOnDisconnect(this.ctx, sessionID, this.config.disconnectReapMs, (entry) =>
        this.logger.log({
          operation: "reaper",
          sessionID: entry.sessionID,
          result: entry.action === "error" ? "error" : "ok",
          error: entry.detail,
        }),
      ).catch(() => {});
    }
    this.sessionsBySocket.delete(socket);
  }

  private parseRequest(line: string): BrokerRequestEnvelope {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new ValidationError("malformed JSON request");
    }
    if (typeof raw !== "object" || raw === null) {
      throw new ValidationError("request must be a JSON object");
    }
    const req = raw as Record<string, unknown>;
    if (req.version !== 1) throw new ValidationError("unsupported protocol version");
    if (typeof req.id !== "string" || !REQUEST_ID_RE.test(req.id)) {
      throw new ValidationError("invalid request id");
    }
    if (typeof req.sessionID !== "string" || !SESSION_ID_RE.test(req.sessionID)) {
      throw new ValidationError("invalid sessionID");
    }
    if (typeof req.operation !== "string") {
      throw new ValidationError("missing operation");
    }
    return {
      version: 1,
      id: req.id,
      operation: req.operation as Operation,
      sessionID: req.sessionID,
      agent: typeof req.agent === "string" && req.agent.length <= 128 ? req.agent : undefined,
      payload: req.payload,
    };
  }

  /** Fail-closed dispatch: unknown operations and any error reject. */
  private async dispatch(req: BrokerRequestEnvelope, sendProgress?: (position: number) => void): Promise<unknown> {
    const op = req.operation as Operation;
    if (op !== "ensureWorker" && SANDBOX_OPERATIONS.includes(op as (typeof SANDBOX_OPERATIONS)[number])) {
      const agent = this.ctx.store.get(req.sessionID)?.agent;
      const readOnly =
        (this.ctx.config as { readOnlyAgents?: string[] }).readOnlyAgents ?? [];
      if (agent && readOnly.includes(agent)) {
        throw new PolicyError(
          `orchestrator agent "${agent}" is not allowed to use sandbox operation "${op}" (orchestrator-readonly)`,
        );
      }
    }
    switch (op) {
      case "ensureWorker":
        return buildEnsureWorkerOp(this.ctx)(req, sendProgress);
      case "workerStatus":
        return buildWorkerStatusOp(this.ctx)(req);
      case "exec":
        return buildExecOp(this.ctx)(req);
      case "readFile":
        return buildReadFileOp(this.ctx)(req);
      case "writeFile":
        return buildWriteFileOp(this.ctx)(req);
      case "applyPatch":
        return buildApplyOp(this.ctx)(req);
      case "listDir":
        return buildListDirOp(this.ctx)(req);
      case "grep":
        return buildGrepOp(this.ctx)(req);
      case "diff":
        return buildDiffOp(this.ctx)(req);
      case "prepareResult":
        return buildPrepareResultOp(this.ctx)(req);
      case "applyResult":
        return buildApplyResultOp(this.ctx)(req);
      case "discardResult":
        return buildDiscardResultOp(this.ctx)(req);
      case "keepResult":
        return buildKeepResultOp(this.ctx)(req);
      case "destroyWorker":
        return buildDestroyWorkerOp(this.ctx)(req);
      case "listWorkers":
        return buildListWorkersOp(this.ctx)(req);
      case "metrics":
        return buildMetricsOp(this.ctx)(req);
      case "sddStatus":
        return buildSddStatusOp(this.ctx)(req);
      case "sddContinue":
        return buildSddContinueOp(this.ctx)(req);
      case "sddAttemptGrant":
        return buildSddAttemptGrantOp(this.ctx)(req);
      case "sddArchiveCompose":
        return buildSddArchiveComposeOp(this.ctx)(req);
      case "sddTaskResult":
        return buildSddTaskResultOp(this.ctx)(req);
      case "reviewAssess":
        return buildReviewAssessOp(this.ctx)(req);
      case "reviewModeStatus":
        return buildReviewModeStatusOp(this.ctx)(req);
      case "reviewStatus":
        return buildReviewStatusOp(this.ctx)(req);
      case "reviewLensContext":
        return buildReviewLensContextOp(this.ctx)(req);
      case "gitCommit":
        return buildGitCommitOp(this.ctx)(req);
      case "gitClearCommitIntent":
        return buildGitClearCommitIntentOp(this.ctx)(req);
      case "gitPush":
        return buildGitPushOp(this.ctx)(req);
      case "ghIssueCreate":
        return buildGhIssueCreateOp(this.ctx)(req);
      case "resultDiff":
        return buildResultDiffOp(this.ctx)(req);
      case "sandboxResult":
        return buildSandboxResultOp(this.ctx)(req);
      case "sandboxResultInstall":
        return buildSandboxResultInstallOp(this.ctx)(req);
      case "policy":
        return buildPolicyOp(this.ctx)(req);
      case "planDocAppend":
        return buildPlanDocAppendOp(this.ctx)(req);
      case "bindSessionAgent":
        return buildBindSessionAgentOp(this.ctx)(req);
      case "reviewStart":
        return buildReviewStartOp(this.ctx)(req);
      case "reviewCaptureResult":
        return buildReviewCaptureResultOp(this.ctx)(req);
      case "reviewCaptureUnachievable":
        return buildReviewCaptureUnachievableOp(this.ctx)(req);
      case "reviewAcknowledgeApproved":
        return buildReviewAcknowledgeApprovedOp(this.ctx)(req);
      case "reviewCaptureCorrectionPlan":
        return buildReviewCaptureCorrectionPlanOp(this.ctx)(req);
      case "reviewCaptureRefuter":
        return buildReviewCaptureRefuterOp(this.ctx)(req);
      case "reviewCaptureValidation":
        return buildReviewCaptureValidationOp(this.ctx)(req);
      case "reviewValidate":
        return buildReviewValidateOp(this.ctx)(req);
      case "reviewRecover":
        return buildReviewRecoverOp(this.ctx)(req);
      case "copyOutInfo":
        return buildCopyOutInfoOp(this.ctx)(req);
      case "copyOut":
        return buildCopyOutOp(this.ctx)(req);
      case "copyInInfo":
        return buildCopyInInfoOp(this.ctx)(req);
      case "copyIn":
        return buildCopyInOp(this.ctx)(req);
      case "registerProject":
        return buildRegisterProjectOp(this.ctx)(req);
      case "advisorAsk":
        return buildAdvisorAskOp(this.ctx)(req);
      case "advisorGet":
        return buildAdvisorGetOp(this.ctx)(req);
      case "advisorList":
        return buildAdvisorListOp(this.ctx)(req);
      case "advisorRead":
        return buildAdvisorReadOp(this.ctx)(req);
      case "advisorRespond":
        return buildAdvisorRespondOp(this.ctx)(req);
      case "evidenceKeep":
        return buildAdvisorEvidenceKeepOp(this.ctx)(req);
      default:
        return buildHostOp(this.ctx)(req);
    }
  }

  private withSessionLock<T>(sessionID: string, fn: () => Promise<T>): Promise<T> {
    this.activeLocks.set(sessionID, (this.activeLocks.get(sessionID) ?? 0) + 1);
    const prev = this.sessionLocks.get(sessionID) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.sessionLocks.set(sessionID, next.then(() => undefined, () => undefined));
    return next.finally(() => { const n = (this.activeLocks.get(sessionID) ?? 1) - 1; if (n <= 0) this.activeLocks.delete(sessionID); else this.activeLocks.set(sessionID, n); });
  }

  private respond(socket: SocketLike, resp: BrokerResponseEnvelope): void {
    const data = `${JSON.stringify(resp)}\n`;
    let queue = this.socketWrites.get(socket);
    if (!queue) {
      queue = new SocketWriteQueue(socket, (err, id) => {
        console.warn("broker response write failed", {
          id,
          error: String(err).slice(0, 160),
        });
        // Closing fails all pending client requests promptly with unavailable.
        socket.close();
      });
      this.socketWrites.set(socket, queue);
    }
    const expectedBytes = Buffer.byteLength(data);
    const writtenBytes = queue.enqueue(data, resp.id);
    if (writtenBytes < expectedBytes) {
      console.warn("broker response write was short", {
        id: resp.id,
        expectedBytes,
        writtenBytes,
      });
    }
  }

  private errorResponse(id: string, err: unknown): BrokerResponseEnvelope {
    return { version: 1, id, ok: false, error: toBrokerError(err) };
  }
}

function toBrokerError(err: unknown): BrokerError {
  if (err instanceof ValidationError) {
    return { code: "validation", message: err.message };
  }
  if (err instanceof StateError) {
    return { code: "state", message: err.message };
  }
  if (err instanceof QueuedTimedOutError) {
    // Must precede the PolicyError check (subclass): parked too long.
    return { code: "queued_timed_out", message: err.message };
  }
  if (err instanceof PolicyError) {
    return { code: "policy", message: err.message };
  }
  if (err instanceof MsbError) {
    return { code: "worker", message: err.message };
  }
  if (err instanceof Error) {
    return { code: "internal", message: err.message };
  }
  return { code: "internal", message: String(err) };
}
