/**
 * BrokerServer reaper log seams: a disconnect-triggered reap must emit the
 * same `action`/`detail` payload as a periodic sweep (via `toReaperLogEntry`),
 * so an operator filtering `action="reaped_active"` also sees socket-close
 * reaps and a successful reap never carries a populated `error` field.
 *
 * These tests assert on what the server hands to `Logger.log` (the seam
 * payload) — not on `toReaperLogEntry`'s return value and not on source text.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { Logger, type LogEntry } from "../src/logging.ts";
import { BrokerServer } from "../src/server.ts";
import type { SessionStore } from "../src/state.ts";

const roots: string[] = [];
const GiB = 1024 * 1024 * 1024;
const OLD_UPDATED_AT = new Date(Date.now() - 3_600_000).toISOString();

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface ServerInternals {
  ctx: {
    adapter: { stop(name: string): Promise<void>; remove(name: string): Promise<void> };
    store: SessionStore;
  };
  sessionsBySocket: WeakMap<object, Set<string>>;
  onSocketClose(socket: object): void;
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "server-reaper-log-"));
  roots.push(root);
  const stateDir = join(root, "state");
  const logged: Omit<LogEntry, "ts">[] = [];
  const logger = new Logger({ toConsole: false });
  logger.log = (entry) => {
    logged.push(entry);
  };
  const server = new BrokerServer(
    defaultConfig({
      stateDir,
      socketPath: join(root, "broker.sock"),
      projects: [{ id: "repo", path: join(root, "repo") }],
      disconnectReapMs: 60_000,
    }),
    logger,
  );
  const internals = server as unknown as ServerInternals;
  // The disconnect path must not touch a real msb binary in this test.
  internals.ctx.adapter = {
    stop: async () => undefined,
    remove: async () => undefined,
  };
  return { internals, logged, stateDir };
}

async function waitForLog(logged: Omit<LogEntry, "ts">[], count = 1): Promise<void> {
  for (let i = 0; i < 200 && logged.length < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function closeSocketFor(internals: ServerInternals, sessionID: string): void {
  const socket = {};
  internals.sessionsBySocket.set(socket, new Set([sessionID]));
  internals.onSocketClose(socket);
}

describe("BrokerServer disconnect reaper log seam", () => {
  test("a successful disconnect reap logs action=reaped_active without an error field", async () => {
    const { internals, logged } = setup();
    internals.ctx.store.touch("disconnected", {
      state: "SANDBOX_ACTIVE",
      workerName: "worker-disconnected",
      workerState: "ACTIVE",
      resources: { cpu: 2, memBytes: 2 * GiB },
      updatedAt: OLD_UPDATED_AT,
    });

    closeSocketFor(internals, "disconnected");
    await waitForLog(logged);

    expect(logged).toHaveLength(1);
    const entry = logged[0]!;
    expect(entry.operation).toBe("reaper");
    expect(entry.sessionID).toBe("disconnected");
    expect(entry.action).toBe("reaped_active");
    expect(entry.result).toBe("ok");
    expect(entry.detail).toBe("client disconnected");
    expect(entry.error).toBeUndefined();

    const record = internals.ctx.store.get("disconnected")!;
    expect(record.workerState).toBe("DESTROYED");
    expect(record.workerName).toBeUndefined();
    expect(record.reapedAt).toBeDefined();
  });

  test("a store read that throws before the internal try still logs reaper error telemetry", async () => {
    const { internals, logged, stateDir } = setup();
    // SessionStore.get throws StateCorruptionError on unparseable JSON; that
    // read sits BEFORE reapOnDisconnect's internal try, so only the server
    // catch can surface the rejection (it used to be swallowed silently).
    writeFileSync(join(stateDir, "sessions", "corrupt.json"), "{ not json");

    closeSocketFor(internals, "corrupt");
    await waitForLog(logged);

    expect(logged).toHaveLength(1);
    const entry = logged[0]!;
    expect(entry.operation).toBe("reaper");
    expect(entry.sessionID).toBe("corrupt");
    expect(entry.action).toBe("error");
    expect(entry.result).toBe("error");
    expect(entry.error).toContain("corrupt state file for session corrupt");
    expect(entry.detail).toBeUndefined();
  });
});
