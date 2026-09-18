/**
 * Regression test for NDJSON framing in the broker client.
 *
 * The broker writes one full JSON response line per request, but a large
 * response can span multiple socket reads. The client reader must buffer
 * partial bytes until a newline arrives; without that accumulator every
 * fragment fails JSON.parse, the pending entry never resolves, and the
 * request times out. See broker/src/server.ts (onData) for the server side.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { createBrokerClient } from "../../opencode/plugins/lib/broker-client.ts";

describe("broker-client NDJSON framing", () => {
  test("resolves a response fragmented across multiple socket reads", async () => {
    const socketPath = join(tmpdir(), `broker-client-${randomUUID()}.sock`);
    const server = Bun.listen({
      unix: socketPath,
      socket: {
        data(sock, chunk) {
          // The client writes exactly one request line; learn its id.
          const text = chunk.toString("utf8");
          const nl = text.indexOf("\n");
          if (nl === -1) return;
          const req = JSON.parse(text.slice(0, nl)) as { id: string; operation: string };
          const response = JSON.stringify({
            version: 1,
            id: req.id,
            ok: true,
            result: { echoed: req.operation, body: "x".repeat(64 * 1024) },
          });
          // Fragment the single response line across three writes so the
          // client observes separate data() callbacks.
          void (async () => {
            sock.write(response.slice(0, 10));
            await Bun.sleep(25);
            sock.write(response.slice(10, 40));
            await Bun.sleep(25);
            sock.write(`${response.slice(40)}\n`);
          })();
        },
      },
    });

    let client: Awaited<ReturnType<typeof createBrokerClient>> | null = null;
    try {
      client = await createBrokerClient({ socketPath, timeoutMs: 1500 });
      const result = (await client.request("echoLarge", "session-1")) as {
        echoed: string;
        body: string;
      };
      expect(result.echoed).toBe("echoLarge");
      expect(result.body.length).toBe(64 * 1024);
    } finally {
      client?.close();
      server.stop(true);
      await unlink(socketPath).catch(() => {
        /* already gone */
      });
    }
  });
});
