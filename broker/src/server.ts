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
import { SddRuntimeExecutor } from "./sdd-runtime.ts";
import { buildSddAttemptAcquireOp, buildSddStatusOp } from "./sdd-service.ts";
import { Logger, durationMs, startTimer } from "./logging.ts";
import { ValidationError } from "./validation.ts";
import { PolicyError } from "./policy.ts";
import { PendingQueue, QueuedTimedOutError } from "./queue.ts";
import { reapOnDisconnect, startReaper, type ReaperHandle } from "./reaper.ts";
import { drainQueue } from "./service.ts";
import {
  buildApplyOp,
  buildApplyResultOp,
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
  buildHostOp,
  buildKeepResultOp,
  buildListDirOp,
  buildListWorkersOp,
  buildMetricsOp,
  buildPolicyOp,
  buildPrepareResultOp,
  buildReadFileOp,
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

const MAX_LINE_BYTES = 1024 * 1024;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9-]{1,128}$/;

interface SocketLike {
  write(data: string): void;
  close(): void;
}

type ServerContext = OpContext & { sddRuntime: SddRuntimeExecutor };

export class BrokerServer {
  private readonly logger: Logger;
  private readonly ctx: ServerContext;
  private readonly sessionLocks = new Map<string, Promise<unknown>>();
  private readonly buffers = new WeakMap<SocketLike, Buffer>();
  /** Sessions each socket has dispatched requests for (disconnect cleanup). */
  private readonly sessionsBySocket = new WeakMap<SocketLike, Set<string>>();
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
    this.logger.log({ operation: "broker.start", result: "ok" });
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
      onLog: (entry) =>
        this.logger.log({
          operation: "reaper",
          sessionID: entry.sessionID || undefined,
          result: entry.action === "error" ? "error" : "ok",
          error: entry.action === "error" ? entry.detail : undefined,
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
  }

  private onData(socket: SocketLike, data: Buffer): void {
    const prev = this.buffers.get(socket) ?? Buffer.alloc(0);
    const buf = Buffer.concat([prev, data]);
    if (buf.length > MAX_LINE_BYTES + 1) {
      this.respond(socket, {
        version: 1,
        id: "0",
        ok: false,
        error: { code: "protocol", message: "request line exceeds size cap" },
      });
      socket.close();
      return;
    }
    let nl: number;
    let offset = 0;
    while ((nl = buf.indexOf(0x0a, offset)) !== -1) {
      const line = buf.subarray(offset, nl).toString("utf8");
      offset = nl + 1;
      void this.dispatchLine(socket, line);
    }
    this.buffers.set(socket, buf.subarray(offset));
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
    // Track the session on this socket so a close can cancel parked entries.
    const sessions = this.sessionsBySocket.get(socket) ?? new Set<string>();
    sessions.add(envelope.sessionID);
    this.sessionsBySocket.set(socket, sessions);
    try {
      const result = await this.withSessionLock(envelope.sessionID, () =>
        this.dispatch(envelope),
      );
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
  private async dispatch(req: BrokerRequestEnvelope): Promise<unknown> {
    const op = req.operation as Operation;
    switch (op) {
      case "ensureWorker":
        return buildEnsureWorkerOp(this.ctx)(req);
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
      case "sddAttemptAcquire":
        return buildSddAttemptAcquireOp(this.ctx)(req);
      case "policy":
        return buildPolicyOp(this.ctx)(req);
      case "copyOutInfo":
        return buildCopyOutInfoOp(this.ctx)(req);
      case "copyOut":
        return buildCopyOutOp(this.ctx)(req);
      case "copyInInfo":
        return buildCopyInInfoOp(this.ctx)(req);
      case "copyIn":
        return buildCopyInOp(this.ctx)(req);
      default:
        return buildHostOp(this.ctx)(req);
    }
  }

  private withSessionLock<T>(sessionID: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sessionLocks.get(sessionID) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.sessionLocks.set(sessionID, next.then(() => undefined, () => undefined));
    return next;
  }

  private respond(socket: SocketLike, resp: BrokerResponseEnvelope): void {
    try {
      socket.write(`${JSON.stringify(resp)}\n`);
    } catch {
      /* socket already closed (e.g. client disconnected while queued) */
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
