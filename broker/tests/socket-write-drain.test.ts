import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { SocketWriteQueue } from "../src/server.ts";
import { createBrokerClient } from "../../opencode/plugins/lib/broker-client.ts";

interface WritableSocket {
  write(data: string): number;
  close(): void;
}

describe("socket write queues", () => {
  test("fake partial writes drain complete replies FIFO without interleaving", () => {
    let received = "";
    let fail: ((error: unknown) => void) | undefined;
    const socket: WritableSocket = {
      write(data) {
        const accepted = Math.min(5, data.length);
        received += data.slice(0, accepted);
        return accepted;
      },
      close() {},
    };
    const queue = new SocketWriteQueue(socket, (error) => { fail = error; });

    queue.enqueue("first-response\n");
    queue.enqueue("second-response\n");
    while (queue.hasPendingWrites) queue.drain();

    expect(fail).toBeUndefined();
    expect(received).toBe("first-response\nsecond-response\n");
  });

  test("real abstract Unix socket delivers 300 KB and 600 KB queued frames whole", async () => {
    const socketPath = `\0socket-queue-${randomUUID()}`;
    const expected = ["x".repeat(300 * 1024), "y".repeat(600 * 1024)];
    const received: Array<{ id: string; result: string }> = [];
    let receiveBuffer = Buffer.alloc(0);
    let resolveFrames!: () => void;
    const framesReady = new Promise<void>((resolve) => { resolveFrames = resolve; });
    let queue: SocketWriteQueue | undefined;
    const server = Bun.listen({
      unix: socketPath,
      socket: {
        open(socket) {
          queue = new SocketWriteQueue(socket, (error) => { throw error; });
          queue.enqueue(`${JSON.stringify({ version: 1, id: "reply-300", ok: true, result: expected[0] })}\n`);
          queue.enqueue(`${JSON.stringify({ version: 1, id: "reply-600", ok: true, result: expected[1] })}\n`);
        },
        drain() { queue?.drain(); },
      },
    });
    let connection: Awaited<ReturnType<typeof Bun.connect>> | undefined;
    try {
      connection = await Bun.connect({
        unix: socketPath,
        socket: {
          open() {},
          data(_socket, chunk) {
            receiveBuffer = Buffer.concat([receiveBuffer, chunk]);
            while (true) {
              const newline = receiveBuffer.indexOf(0x0a);
              if (newline < 0) break;
              received.push(JSON.parse(receiveBuffer.subarray(0, newline).toString("utf8")));
              receiveBuffer = receiveBuffer.subarray(newline + 1);
              if (received.length === expected.length) resolveFrames();
            }
          },
        },
      });
      await Promise.race([framesReady, Bun.sleep(5000).then(() => { throw new Error("timed out waiting for queued replies"); })]);
      expect(received.map((frame) => frame.id)).toEqual(["reply-300", "reply-600"]);
      expect(received.map((frame) => frame.result)).toEqual(expected);
      expect(Buffer.byteLength(received[0]!.result)).toBe(300 * 1024);
      expect(Buffer.byteLength(received[1]!.result)).toBe(600 * 1024);
    } finally {
      connection?.end();
      server.stop(true);
      await unlink(socketPath).catch(() => {});
    }
  });

  test("plugin sends a 300 KB writeFile request over a real Unix socket", async () => {
    const socketPath = join(tmpdir(), `broker-client-large-${randomUUID()}.sock`);
    const content = "z".repeat(300 * 1024);
    let resolveRequest!: (request: { operation: string; payload: { content: string }; id: string }) => void;
    const requestReady = new Promise<{ operation: string; payload: { content: string }; id: string }>((resolve) => { resolveRequest = resolve; });
    const server = Bun.listen({
      unix: socketPath,
      socket: {
        data(sock, chunk) {
          let buffer = Buffer.concat([this.buffer ?? Buffer.alloc(0), chunk]);
          const newline = buffer.indexOf(0x0a);
          if (newline < 0) { this.buffer = buffer; return; }
          const request = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
          resolveRequest(request);
          sock.write(`${JSON.stringify({ version: 1, id: request.id, ok: true, result: true })}\n`);
        },
      } as never,
    });
    let client: Awaited<ReturnType<typeof createBrokerClient>> | undefined;
    try {
      client = await createBrokerClient({ socketPath, timeoutMs: 5000 });
      await expect(client.request("writeFile", "session-large", { path: "large.txt", content })).resolves.toBe(true);
      const request = await requestReady;
      expect(request.operation).toBe("writeFile");
      expect(request.payload.content).toBe(content);
      expect(Buffer.byteLength(request.payload.content)).toBe(300 * 1024);
    } finally {
      client?.close();
      server.stop(true);
      await unlink(socketPath).catch(() => {});
    }
  });
});
