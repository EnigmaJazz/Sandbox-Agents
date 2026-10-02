/**
 * Client receive fixes (odd/tasks/request-line-cap.md T2; socket-write-drain T4):
 * a timeout must never corrupt another request's partly received reply, and a
 * queued hold must keep a bounded deadline.
 *
 * Imported with a query suffix so a module mock of broker-client.ts registered
 * by another test file (sandbox-edit-tool-activation.test.ts) cannot leak in.
 */
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createBrokerClient } = (await import(
  "../../opencode/plugins/lib/broker-client.ts?receive-tests"
)) as typeof import("../../opencode/plugins/lib/broker-client.ts");

type Req = { id: string; operation: string };
type Handler = (req: Req, sock: { write(d: string): number }) => void;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

/** A scripted broker: one handler per request, newline-delimited JSON frames. */
function fakeBroker(handler: Handler): string {
  const socketPath = join(tmpdir(), `broker-client-receive-${randomUUID()}.sock`);
  let buffer = "";
  const server = Bun.listen({
    unix: socketPath,
    socket: {
      data(sock, chunk) {
        buffer += chunk.toString("utf8");
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const req = JSON.parse(buffer.slice(0, nl)) as Req;
          buffer = buffer.slice(nl + 1);
          handler(req, sock);
        }
      },
    },
  });
  cleanups.push(async () => {
    server.stop(true);
    await unlink(socketPath).catch(() => {});
  });
  return socketPath;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a timeout leaves a neighbouring request's partial reply intact", async () => {
  const big = "b".repeat(64 * 1024);
  const socketPath = fakeBroker((req, sock) => {
    if (req.operation === "slowUnknownOp") return; // never answered: times out
    // "exec" (130 s client timeout): send half the reply, wait past the other
    // request's timeout, then send the rest.
    const reply = `${JSON.stringify({ version: 1, id: req.id, ok: true, result: big })}\n`;
    const half = Math.floor(reply.length / 2);
    sock.write(reply.slice(0, half));
    setTimeout(() => sock.write(reply.slice(half)), 600);
  });
  const client = await createBrokerClient({ socketPath, timeoutMs: 300 });
  cleanups.push(() => client.close());
  const slow = client.request("slowUnknownOp", "s1");
  await delay(20);
  const exec = client.request("exec", "s1");
  await expect(slow).rejects.toThrow("timed out");
  await expect(exec).resolves.toBe(big);
});

test("a queued hold keeps a bounded deadline instead of waiting forever", async () => {
  const socketPath = fakeBroker((req, sock) => {
    // Park the request and never deliver its real reply.
    sock.write(`${JSON.stringify({ version: 1, id: req.id, progress: { queued: true, position: 1 } })}\n`);
  });
  const client = await createBrokerClient({ socketPath, timeoutMs: 100, queuedHoldTimeoutMs: 200 });
  cleanups.push(() => client.close());
  const started = Date.now();
  await expect(client.request("parkedUnknownOp", "s1")).rejects.toThrow("timed out");
  const elapsed = Date.now() - started;
  // Hold deadline (200 ms) plus the operation timeout (100 ms), not the bare 100 ms.
  expect(elapsed).toBeGreaterThanOrEqual(280);
  expect(elapsed).toBeLessThan(2_000);
}, 5_000);

test("repeated queued notices do not extend the deadline", async () => {
  const socketPath = fakeBroker((req, sock) => {
    const notice = (position: number) =>
      sock.write(`${JSON.stringify({ version: 1, id: req.id, progress: { queued: true, position } })}\n`);
    notice(3);
    setTimeout(() => notice(2), 150);
    setTimeout(() => notice(1), 250);
  });
  const client = await createBrokerClient({ socketPath, timeoutMs: 100, queuedHoldTimeoutMs: 200 });
  cleanups.push(() => client.close());
  const started = Date.now();
  await expect(client.request("parkedUnknownOp", "s1")).rejects.toThrow("timed out");
  expect(Date.now() - started).toBeLessThan(450);
}, 5_000);

test("a malformed fragment that merely contains a pending id does not fail that request", async () => {
  const socketPath = fakeBroker((req, sock) => {
    // A broken line whose content mentions the caller's id, not at the frame start.
    sock.write(`garbage before {"id":"${req.id}" and more garbage\n`);
    setTimeout(() => sock.write(`${JSON.stringify({ version: 1, id: req.id, ok: true, result: "real" })}\n`), 50);
  });
  const client = await createBrokerClient({ socketPath, timeoutMs: 2_000 });
  cleanups.push(() => client.close());
  await expect(client.request("anyUnknownOp", "s1")).resolves.toBe("real");
});

test("a queued request that is released resolves with its real reply", async () => {
  const socketPath = fakeBroker((req, sock) => {
    sock.write(`${JSON.stringify({ version: 1, id: req.id, progress: { queued: true, position: 1 } })}\n`);
    setTimeout(() => sock.write(`${JSON.stringify({ version: 1, id: req.id, ok: true, result: "released" })}\n`), 150);
  });
  const client = await createBrokerClient({ socketPath, timeoutMs: 100, queuedHoldTimeoutMs: 1_000 });
  cleanups.push(() => client.close());
  await expect(client.request("parkedUnknownOp", "s1")).resolves.toBe("released");
});
