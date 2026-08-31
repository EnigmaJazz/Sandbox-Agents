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
  timer: ReturnType<typeof setTimeout>;
}

export interface BrokerClient {
  request(operation: string, sessionID: string, payload?: unknown, agent?: string): Promise<unknown>;
  close(): void;
}

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

  const failPending = (err: Error) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  };

  const connect = async (): Promise<void> => {
    if (socket && !closed) return;
    if (connecting) return connecting;
    connecting = (async () => {
      socket = await Bun.connect({
        unix: opts.socketPath,
        socket: {
          open() {
            /* connected */
          },
          data(sock, data: Buffer) {
            // NDJSON framing: complete lines only.
            const text = data.toString("utf8");
            for (const line of text.split("\n")) {
              if (line.trim().length === 0) continue;
              let resp: BrokerResponse;
              try {
                resp = JSON.parse(line) as BrokerResponse;
              } catch {
                continue; // ignore malformed frames; keep the socket alive
              }
              if ((resp as any).progress?.queued) { console.log(`pool full, queued position ${(resp as any).progress.position}`); continue; }
              const p = pending.get(resp.id);
              if (p) {
                pending.delete(resp.id);
                clearTimeout(p.timer);
                p.resolve(resp);
              }
            }
          },
          close() {
            closed = true;
            socket = null;
            failPending(new BrokerClientError("broker socket closed", "unavailable"));
          },
          error(_sock, err) {
            closed = true;
            socket = null;
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
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new BrokerClientError(`broker request '${operation}' timed out`, "timeout"));
        }, timeoutMs);
        pending.set(id, {
          resolve,
          reject,
          timer,
        });
        const line = JSON.stringify({
          version: 1,
          id,
          operation,
          sessionID,
          ...(agent ? { agent } : {}),
          ...(payload !== undefined ? { payload } : {}),
        });
        try {
          socket?.write(`${line}\n`);
        } catch (err) {
          pending.delete(id);
          clearTimeout(timer);
          reject(new BrokerClientError(`failed to write request: ${String(err)}`, "unavailable"));
        }
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
