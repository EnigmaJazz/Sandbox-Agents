/**
 * Shared NDJSON client for the broker Unix socket (opencode 1.18.x plugin API,
 * used by both sandbox-tools.ts and routing-guard.ts, and by cli/sandboxctl).
 *
 * - User-only socket: $XDG_RUNTIME_DIR/opencode-sandbox-broker.sock (0600),
 *   override with BROKER_SOCKET.
 * - Every request is one JSON line; every response is one JSON line with the
 *   same id. Requests carry a strict envelope (version, id, operation,
 *   sessionID, optional agent, payload).
 * - Fail closed: if the broker is unreachable or a request errors, the client
 *   throws — callers must NOT fall back to host execution (S14).
 *
 * Gate 1: nothing is installed. This module is exercised by cli/sandboxctl
 * and unit tests only; plugin wiring is verified at Gate 4.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface BrokerClientOptions {
  socketPath: string;
  timeoutMs?: number;
}

export interface BrokerResponse {
  version: 1;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export class BrokerClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "BrokerClientError";
  }
}

/** Default socket path: $XDG_RUNTIME_DIR or a state-dir fallback. */
export function brokerSocketPath(env: Record<string, string | undefined> = process.env): string {
  if (env.BROKER_SOCKET && env.BROKER_SOCKET.length > 0) return env.BROKER_SOCKET;
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime && runtime.length > 0) {
    return join(runtime, "opencode-sandbox-broker.sock");
  }
  return join(homedir(), ".local", "state", "opencode-sandbox", "broker.sock");
}

interface Pending {
  resolve: (resp: BrokerResponse) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface PendingWrite {
  data: Buffer;
  offset: number;
  onSent: () => void;
}

export interface BrokerClient {
  request(operation: string, sessionID: string, payload?: unknown, agent?: string): Promise<unknown>;
  close(): void;
}

export const OPERATION_TIMEOUT_MS: Record<string, number> = {
  exec: 130_000,
  bindSessionAgent: 10_000,
  ensureWorker: 120_000,
  gitCommit: 130_000,
  sandboxResultInstall: 130_000,
  gitPush: 130_000,
  ghIssueCreate: 130_000,
  planDocAppend: 30_000,
  sddAttemptGrant: 130_000,
  reviewLensContext: 130_000,
  reviewStart: 130_000,
  reviewCaptureResult: 130_000,
  reviewCaptureUnachievable: 130_000,
  reviewAcknowledgeApproved: 130_000,
  reviewCaptureCorrectionPlan: 130_000,
  reviewCaptureRefuter: 130_000,
  reviewCaptureValidation: 130_000,
  reviewValidate: 130_000,
  reviewRecover: 130_000,
};

/**
 * Create a client. Connecting is lazy but explicit: this throws synchronously
 * if the socket does not exist (fail closed). The client RECONNECTS on demand:
 * a broker restart closes the socket, but the next request opens a fresh one
 * instead of failing closed forever (Gate 5 live finding).
 */
export async function createBrokerClient(opts: BrokerClientOptions): Promise<BrokerClient> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pending = new Map<string, Pending>();
  let socket: ReturnType<typeof Bun.connect> | null = null;
  let closed = false;
  let connecting: Promise<void> | null = null;
  let rx = Buffer.alloc(0);

  const failPending = (err: Error) => {
    for (const p of pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  };
  const outgoing: PendingWrite[] = [];

  const flushWrites = (sock: ReturnType<typeof Bun.connect>) => {
    if (socket !== sock) return;
    while (outgoing.length > 0) {
      const write = outgoing[0]!;
      try {
        const remaining = write.data.subarray(write.offset);
        const writtenBytes = sock.write(remaining);
        if (!Number.isInteger(writtenBytes) || writtenBytes < 0 || writtenBytes > remaining.length) {
          throw new Error(`invalid socket write result: ${writtenBytes}`);
        }
        write.offset += writtenBytes;
        if (write.offset < write.data.length) return;
        outgoing.shift();
        write.onSent();
      } catch (err) {
        outgoing.length = 0;
        closed = true;
        socket = null;
        failPending(new BrokerClientError(`failed to write request: ${String(err)}`, "unavailable"));
        sock.close();
        return;
      }
    }
  };

  const connect = async (): Promise<void> => {
    if (socket && !closed) return;
    if (connecting) return connecting;
    connecting = (async () => {
      socket = await Bun.connect({
        unix: opts.socketPath,
        socket: {
          open() {
            /* connected; reset both frame accumulators */
            rx = Buffer.alloc(0);
            outgoing.length = 0;
          },
          drain(sock) {
            flushWrites(sock);
          },
          data(sock, data: Buffer) {
            // Mirror reviewer-relay-core.ts:828-844: buffer raw bytes and decode
            // only complete lines so chunk-split UTF-8 code points remain intact.
            // No response-side size cap is imposed: the broker currently has no
            // such cap, and introducing one changes the response contract without
            // evidence that truncation caused the observed frame loss.
            rx = Buffer.concat([rx, data]);
            let nl: number;
            while ((nl = rx.indexOf(0x0a)) !== -1) {
              const lineBytes = rx.subarray(0, nl);
              rx = rx.subarray(nl + 1);
              if (lineBytes.toString("utf8").trim().length === 0) continue;
              const line = lineBytes.toString("utf8");
              let resp: BrokerResponse;
              try {
                resp = JSON.parse(line) as BrokerResponse;
              } catch {
                const idMatch = /\"id\"\s*:\s*(\"(?:\\.|[^\"\\])*\")/.exec(line);
                let recoveredId: string | undefined;
                if (idMatch) {
                  try {
                    recoveredId = JSON.parse(idMatch[1]) as string;
                  } catch {
                    // A malformed id value is not safe to match to a caller.
                  }
                }
                const p = recoveredId === undefined ? undefined : pending.get(recoveredId);
                if (p && recoveredId !== undefined) {
                  pending.delete(recoveredId);
                  if (p.timer) clearTimeout(p.timer);
                  p.reject(new BrokerClientError("broker returned an unparseable response frame", "malformed_response"));
                } else {
                  const prefix = lineBytes.subarray(0, 160).toString("utf8");
                  console.warn("broker-client discarded malformed response frame", {
                    lineLength: lineBytes.length,
                    prefix,
                    pendingIds: [...pending.keys()].slice(0, 10),
                    ...(recoveredId === undefined ? {} : { id: recoveredId }),
                  });
                }
                continue; // keep the socket usable after a bad frame
              }
              // queued hold: log and keep pending open, waiting for real worker result with same id
              if ((resp as any).progress?.queued) {
                console.log(`pool full, queued position ${(resp as any).progress.position}`);
                const p = pending.get(resp.id);
                if (p) clearTimeout(p.timer);
                continue;
              }
              const p = pending.get(resp.id);
              if (p) {
                pending.delete(resp.id);
                clearTimeout(p.timer);
                p.resolve(resp);
              } else {
                console.warn("broker-client received unmatched response id", {
                  id: resp.id,
                  pendingCount: pending.size,
                });
              }
            }
          },
          close() {
            closed = true;
            socket = null;
            rx = Buffer.alloc(0);
            outgoing.length = 0;
            failPending(new BrokerClientError("broker socket closed", "unavailable"));
          },
          error(_sock, err) {
            closed = true;
            socket = null;
            rx = Buffer.alloc(0);
            outgoing.length = 0;
            failPending(
              new BrokerClientError(
                `broker connection error: ${String(err?.message ?? err)}`,
                "unavailable",
              ),
            );
          },
        },
      });
      closed = false;
    })()
      .finally(() => {
        connecting = null;
      });
    return connecting;
  };

  // Eager initial connection: a broker that is down at load time fails
  // closed immediately (callers surface a clear "unavailable" error).
  await connect();

  return {
    request: async (operation, sessionID, payload, agent) => {
      if (closed) {
        // Broker restarted under us — reconnect for this request. Only a
        // failed reconnect fails closed; the NEXT request retries again.
        try {
          await connect();
        } catch {
          throw new BrokerClientError("broker connection is closed (fail closed)", "unavailable");
        }
      }
      const id = randomUUID();
      return new Promise<unknown>((resolve, reject) => {
        const opTimeout = OPERATION_TIMEOUT_MS[operation] ?? timeoutMs;
        const pendingRequest: Pending = { resolve, reject };
        const startTimeout = () => {
          // Start only after the complete request frame is sent: backpressure
          // must not consume the broker-response budget while bytes are queued.
          pendingRequest.timer = setTimeout(() => {
            const residualBytes = rx.length;
            const residualPrefix = rx
              .subarray(0, 160)
              .toString("utf8")
              .replace(/[^{}\[\]:,"\\]/g, ".");
            console.warn("broker-client timed out with residual response bytes", {
              operation,
              residualBytes,
              residualPrefix,
            });
            // Drop only the incomplete frame; other pending requests stay pending
            // because their complete newline-delimited responses remain parseable.
            rx = Buffer.alloc(0);
            pending.delete(id);
            reject(new BrokerClientError(`broker request '${operation}' timed out`, "timeout"));
          }, opTimeout);
        };
        pending.set(id, pendingRequest);
        const line = JSON.stringify({
          version: 1,
          id,
          operation,
          sessionID,
          ...(agent ? { agent } : {}),
          ...(payload !== undefined ? { payload } : {}),
        });
        const currentSocket = socket;
        if (!currentSocket) {
          pending.delete(id);
          reject(new BrokerClientError("broker socket is unavailable", "unavailable"));
          return;
        }
        outgoing.push({
          data: Buffer.from(`${line}\n`),
          offset: 0,
          onSent: startTimeout,
        });
        flushWrites(currentSocket);
      }).then((resp: BrokerResponse) => {
        if (!resp.ok) {
          throw new BrokerClientError(
            resp.error?.message ?? `broker operation '${operation}' failed`,
            resp.error?.code ?? "internal",
          );
        }
        return resp.result;
      });
    },
    close: () => {
      closed = true;
      socket?.close();
      socket = null;
    },
  };
}

/** One-shot helper for CLIs: connect, request, close. */
export async function withBroker<T>(
  operation: string,
  sessionID: string,
  payload: unknown | undefined,
  socketPath = brokerSocketPath(),
): Promise<T> {
  const client = await createBrokerClient({ socketPath });
  try {
    return (await client.request(operation, sessionID, payload)) as T;
  } finally {
    client.close();
  }
}
