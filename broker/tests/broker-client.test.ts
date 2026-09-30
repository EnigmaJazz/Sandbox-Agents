import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { BrokerClientError, createBrokerClient } from "../../opencode/plugins/lib/broker-client.ts";

describe("broker-client NDJSON framing", () => {
  test("resolves a response fragmented across multiple socket reads", async () => {
    const socketPath = join(tmpdir(), `broker-client-${randomUUID()}.sock`);
    const server = Bun.listen({ unix: socketPath, socket: { data(sock, chunk) {
      const nl = chunk.indexOf(0x0a);
      if (nl < 0) return;
      const req = JSON.parse(chunk.subarray(0, nl).toString("utf8")) as { id: string };
      const frame = Buffer.from(`${JSON.stringify({ version: 1, id: req.id, ok: true, result: "x".repeat(64 * 1024) })}\n`);
      void (async () => { sock.write(frame.subarray(0, 10)); await Bun.sleep(10); sock.write(frame.subarray(10, 40)); await Bun.sleep(10); sock.write(frame.subarray(40)); })();
    } } });
    let client: Awaited<ReturnType<typeof createBrokerClient>> | null = null;
    try {
      client = await createBrokerClient({ socketPath, timeoutMs: 1500 });
      expect((await client.request("echoLarge", "session-1") as string).length).toBe(64 * 1024);
    } finally { client?.close(); server.stop(true); await unlink(socketPath).catch(() => {}); }
  });

  test("resolves a 250 KB frame and preserves UTF-8 split across chunks", async () => {
    const socketPath = join(tmpdir(), `broker-client-${randomUUID()}.sock`);
    const expected = `é-start-${"x".repeat(250 * 1024)}-終-end`;
    const server = Bun.listen({ unix: socketPath, socket: { data(sock, chunk) {
      const nl = chunk.indexOf(0x0a); if (nl < 0) return;
      const req = JSON.parse(chunk.subarray(0, nl).toString("utf8")) as { id: string };
      const frame = Buffer.from(`${JSON.stringify({ version: 1, id: req.id, ok: true, result: expected })}\n`, "utf8");
      const split = frame.indexOf(Buffer.from("é")) + 1;
      if (Buffer.concat([frame.subarray(0, split), frame.subarray(split)]).toString("utf8") !== `${JSON.stringify({ version: 1, id: req.id, ok: true, result: expected })}\n`) throw new Error("test frame splitting changed its bytes");
      void (async () => { sock.write(Buffer.from(frame.subarray(0, split))); await Bun.sleep(10); sock.write(Buffer.from(frame.subarray(split, split + 128 * 1024))); await Bun.sleep(10); sock.write(Buffer.from(frame.subarray(split + 128 * 1024))); })();
    } } });
    let client: Awaited<ReturnType<typeof createBrokerClient>> | null = null;
    try { client = await createBrokerClient({ socketPath, timeoutMs: 1500 }); expect(await client.request("large", "session-large")).toBe(expected); }
    finally { client?.close(); server.stop(true); await unlink(socketPath).catch(() => {}); }
  });

  test("rejects an unparseable response promptly and keeps the socket usable", async () => {
    const socketPath = join(tmpdir(), `broker-client-${randomUUID()}.sock`);
    let count = 0;
    const server = Bun.listen({ unix: socketPath, socket: { data(sock, chunk) {
      const nl = chunk.indexOf(0x0a); if (nl < 0) return;
      const req = JSON.parse(chunk.subarray(0, nl).toString("utf8")) as { id: string };
      count++;
      sock.write(count === 1 ? `{"version":1,"id":"${req.id}","ok":truX}\n` : `${JSON.stringify({ version: 1, id: req.id, ok: true, result: "alive" })}\n`);
    } } });
    let client: Awaited<ReturnType<typeof createBrokerClient>> | null = null;
    try {
      client = await createBrokerClient({ socketPath, timeoutMs: 1500 });
      const started = Date.now();
      await expect(client.request("malformed", "session-1")).rejects.toMatchObject({ name: "BrokerClientError", code: "malformed_response" } satisfies Partial<BrokerClientError>);
      expect(Date.now() - started).toBeLessThan(500);
      await expect(client.request("afterMalformed", "session-1")).resolves.toBe("alive");
    } finally { client?.close(); server.stop(true); await unlink(socketPath).catch(() => {}); }
  });

  test("logs unmatched response ids without rejecting unrelated requests", async () => {
    const socketPath = join(tmpdir(), `broker-client-${randomUUID()}.sock`);
    const logs: string[] = []; const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => logs.push(args.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" "));
    const server = Bun.listen({ unix: socketPath, socket: { data(sock, chunk) {
      const nl = chunk.indexOf(0x0a); if (nl < 0) return;
      const req = JSON.parse(chunk.subarray(0, nl).toString("utf8")) as { id: string };
      void (async () => { sock.write(`${JSON.stringify({ version: 1, id: "late-or-duplicate-id", ok: true, result: null })}\n`); await Bun.sleep(10); sock.write(`${JSON.stringify({ version: 1, id: req.id, ok: true, result: "matched" })}\n`); })();
    } } });
    let client: Awaited<ReturnType<typeof createBrokerClient>> | null = null;
    try {
      client = await createBrokerClient({ socketPath, timeoutMs: 1500 });
      await expect(client.request("matched", "session-1")).resolves.toBe("matched");
      expect(logs.join("\n")).toContain("late-or-duplicate-id");
      expect(logs.join("\n")).toContain("pendingCount");
    } finally { console.warn = originalWarn; client?.close(); server.stop(true); await unlink(socketPath).catch(() => {}); }
  });
});
