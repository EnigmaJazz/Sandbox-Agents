/**
 * TODO Tier 2 item 13: per-line request cap sized for the largest allowed
 * payload, and an oversize request refused on its own without closing the
 * connection every plugin session shares. Tracker: odd/tasks/request-line-cap.md.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { BrokerServer, RequestLineFramer, maxRequestLineBytes } from "../src/server.ts";

const enc = (s: string) => Buffer.from(s, "utf8");
const frame = (obj: unknown) => `${JSON.stringify(obj)}\n`;

describe("request line cap sizing", () => {
  const cap = maxRequestLineBytes(defaultConfig().resource);

  test("a 4 MiB patch of worst-case escaping fits under the cap", () => {
    const patch = "\u0000".repeat(4 * 1024 * 1024);
    const line = frame({ version: 1, id: "req-1", operation: "applyPatch", sessionID: "s1", payload: { patch } });
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(cap + 1);
  });

  test("a 1 MiB write full of quotes and newlines fits (the old 1 MiB cap refused it)", () => {
    const content = '"\n'.repeat(512 * 1024);
    const line = frame({ version: 1, id: "req-2", operation: "writeFile", sessionID: "s1", payload: { path: "a.txt", content } });
    expect(Buffer.byteLength(line)).toBeGreaterThan(1024 * 1024);
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(cap + 1);
  });
});

describe("RequestLineFramer", () => {
  test("pipelined lines are capped one by one, never in sum", () => {
    const framer = new RequestLineFramer(100);
    const line = `${"a".repeat(80)}\n`;
    const events = framer.push(enc(line + line + line));
    expect(events).toEqual([
      { kind: "line", line: "a".repeat(80) },
      { kind: "line", line: "a".repeat(80) },
      { kind: "line", line: "a".repeat(80) },
    ]);
  });

  test("an oversize line arriving whole is refused under its own id, and the next line still parses", () => {
    const framer = new RequestLineFramer(64);
    const big = JSON.stringify({ version: 1, id: "big-1", payload: "x".repeat(200) });
    const small = JSON.stringify({ version: 1, id: "small-1" });
    expect(framer.push(enc(`${big}\n${small}\n`))).toEqual([
      { kind: "oversize", id: "big-1", bytes: Buffer.byteLength(big) },
      { kind: "line", line: small },
    ]);
  });

  test("an oversize line split across chunks is discarded up to its newline, then framing resumes", () => {
    const framer = new RequestLineFramer(64);
    const big = JSON.stringify({ version: 1, id: "big-2", payload: "y".repeat(500) });
    const small = JSON.stringify({ version: 1, id: "small-2" });
    const bytes = enc(`${big}\n${small}\n`);
    const events = [];
    for (let i = 0; i < bytes.length; i += 37) events.push(...framer.push(bytes.subarray(i, i + 37)));
    expect(events).toEqual([
      { kind: "oversize", id: "big-2", bytes: Buffer.byteLength(big) },
      { kind: "line", line: small },
    ]);
  });

  test("an oversize line with no recoverable id is refused without an id", () => {
    const framer = new RequestLineFramer(16);
    expect(framer.push(enc(`${"z".repeat(40)}\n`))).toEqual([{ kind: "oversize", id: undefined, bytes: 40 }]);
  });

  test("a partial line under the cap waits for its newline", () => {
    const framer = new RequestLineFramer(64);
    expect(framer.push(enc('{"id":"p"'))).toEqual([]);
    expect(framer.push(enc("}\n"))).toEqual([{ kind: "line", line: '{"id":"p"}' }]);
  });
});

/**
 * A raw socket client, independent of the plugin's broker client (another test
 * file module-mocks that one): writes frames with partial-write handling and
 * collects newline-delimited replies.
 */
async function rawConnection(socketPath: string) {
  const replies: Array<{ id: string; ok: boolean; error?: { message: string } }> = [];
  let rx = "";
  let waiting: (() => void) | undefined;
  let outgoing = Buffer.alloc(0);
  let closed = false;
  const flush = (sock: { write(d: Uint8Array): number }) => {
    while (outgoing.length > 0) {
      const n = sock.write(outgoing);
      outgoing = outgoing.subarray(n);
      if (n === 0) return;
    }
  };
  const sock = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_s, data) {
        rx += data.toString("utf8");
        let nl: number;
        while ((nl = rx.indexOf("\n")) !== -1) {
          replies.push(JSON.parse(rx.slice(0, nl)));
          rx = rx.slice(nl + 1);
        }
        waiting?.();
      },
      drain(s) { flush(s); },
      close() { closed = true; waiting?.(); },
    },
  });
  return {
    send(line: string) {
      outgoing = Buffer.concat([outgoing, Buffer.from(line)]);
      flush(sock);
    },
    async until(count: number, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      while (replies.length < count && !closed && Date.now() < deadline) {
        await new Promise<void>((resolve) => { waiting = resolve; setTimeout(resolve, 50); });
      }
      return { replies, closed };
    },
    close() { sock.end(); },
  };
}

describe("BrokerServer oversize request on a shared connection", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("the oversize request fails alone; the other requests on the same connection complete", async () => {
    const root = mkdtempSync(join(tmpdir(), "line-cap-"));
    roots.push(root);
    const socketPath = join(root, "broker.sock");
    const config = defaultConfig({ stateDir: join(root, "state"), socketPath });
    const server = new BrokerServer(config);
    await server.start();
    const conn = await rawConnection(socketPath);
    try {
      const cap = maxRequestLineBytes(config.resource);
      const request = (id: string, sessionID: string, payload?: unknown) =>
        frame({ version: 1, id, operation: "workerStatus", sessionID, ...(payload ? { payload } : {}) });
      conn.send(request("req-oversize", "session-a", { filler: "q".repeat(cap + 1024) }));
      conn.send(request("req-normal", "session-b"));
      conn.send(request("req-after", "session-c"));
      const { replies, closed } = await conn.until(3);
      expect(closed).toBe(false);
      const byId = new Map(replies.map((r) => [r.id, r]));
      expect(byId.get("req-oversize")?.error?.message).toContain("exceeds");
      // The other requests got the broker's own answers, not a dropped connection.
      expect(byId.get("req-normal")?.error?.message).toContain("unknown session");
      expect(byId.get("req-after")?.error?.message).toContain("unknown session");
    } finally {
      conn.close();
      server.shutdown();
    }
  }, 30_000);
});
