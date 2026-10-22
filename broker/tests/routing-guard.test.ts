import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import routingGuardPlugin from "../../opencode/plugins/routing-guard.ts";

type Request = {
  id: string;
  operation: string;
  sessionID: string;
  payload?: { tool?: string };
};
type Socket = { write(data: string): number; end(): void };
type BeforeHook = (input: { tool: string; sessionID: string }, output: { args?: Record<string, unknown> }) => Promise<void>;

function captureBeforeHook(): BeforeHook {
  const plugin = routingGuardPlugin();
  const hook = plugin["tool.execute.before"];
  if (!hook) throw new Error("tool.execute.before hook was not registered");
  return hook as BeforeHook;
}

const callsByTool = new Map<string, number>();
let server: ReturnType<typeof Bun.listen>;
let socketPath: string;
let previousSocket: string | undefined;

beforeAll(() => {
  socketPath = join(tmpdir(), `routing-guard-${randomUUID()}.sock`);
  previousSocket = process.env.BROKER_SOCKET;
  process.env.BROKER_SOCKET = socketPath;
  let buffer = "";
  server = Bun.listen({
    unix: socketPath,
    socket: {
      data(sock, chunk) {
        buffer += chunk.toString("utf8");
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const request = JSON.parse(buffer.slice(0, newline)) as Request;
          buffer = buffer.slice(newline + 1);
          const tool = request.payload?.tool ?? "";
          if (request.operation === "toolAdmission") {
            callsByTool.set(tool, (callsByTool.get(tool) ?? 0) + 1);
            if (tool === "broker_unreachable_tool") {
              (sock as unknown as Socket).end();
              continue;
            }
            const hostAdminDenied = ["bash", "write", "edit"].includes(tool);
            const decision = tool === "denied_tool" || hostAdminDenied ? "deny" : "allow";
            const classification = hostAdminDenied ? "HOST_ADMIN_STRUCTURED" : tool === "unclassified_tool" ? "unclassified" : "CONSULT";
            const reason = hostAdminDenied ? "HOST_ADMIN_DENIED" : tool === "denied_tool" ? "POLICY_DENIED" : "AUTHORIZED";
            sock.write(`${JSON.stringify({
              id: request.id,
              ok: true,
              result: { schema: "opencode-sandbox.tool-admission/v1", tool, classification, decision, reason },
            })}\n`);
            continue;
          }
          if (request.operation === "workerStatus") {
            sock.write(`${JSON.stringify({ id: request.id, ok: true, result: { state: "HOST_READ_ONLY" } })}\n`);
            continue;
          }
          if (request.operation === "policy") {
            sock.write(`${JSON.stringify({ id: request.id, ok: true, result: { approvedExternalReadRoots: [] } })}\n`);
          }
        }
      },
    },
  });
});

afterAll(async () => {
  server.stop(true);
  await unlink(socketPath).catch(() => {});
  if (previousSocket === undefined) delete process.env.BROKER_SOCKET;
  else process.env.BROKER_SOCKET = previousSocket;
});

describe("routing guard tool admission", () => {
  const before = captureBeforeHook();

  test("broker allow decision lets a tool call through", async () => {
    await expect(before({ tool: "allowed_tool", sessionID: "allow-session" }, { args: {} })).resolves.toBeUndefined();
  });

  test("broker deny decision throws a diagnosable error", async () => {
    await expect(before({ tool: "denied_tool", sessionID: "deny-session" }, { args: {} })).rejects.toThrow(
      'Tool "denied_tool" is denied by broker admission (POLICY_DENIED).',
    );
  });

  test("host-admin tools throw the broker denial message", async () => {
    for (const tool of ["bash", "write", "edit"]) {
      await expect(before({ tool, sessionID: `host-admin-${tool}` }, { args: {} })).rejects.toThrow(
        `Tool "${tool}" is denied by broker admission (HOST_ADMIN_DENIED).`,
      );
    }
  });

  test("unclassified tools throw a diagnosable error", async () => {
    await expect(before({ tool: "unclassified_tool", sessionID: "unknown-session" }, { args: {} })).rejects.toThrow(
      'Tool "unclassified_tool" is denied by broker admission',
    );
  });

  test("unreachable broker throws instead of allowing the call", async () => {
    await expect(before({ tool: "broker_unreachable_tool", sessionID: "offline-session" }, { args: {} })).rejects.toThrow();
  });

  test("caches the broker answer per session and tool", async () => {
    const sessionID = "cache-session";
    await before({ tool: "cached_tool", sessionID }, { args: {} });
    await before({ tool: "cached_tool", sessionID }, { args: {} });
    expect(callsByTool.get("cached_tool")).toBe(1);
  });

  test("sandbox writes clear that session's admission cache", async () => {
    const sessionID = "clear-session";
    await before({ tool: "after_write_tool", sessionID }, { args: {} });
    await before({ tool: "sandbox_write", sessionID }, { args: {} });
    await before({ tool: "after_write_tool", sessionID }, { args: {} });
    expect(callsByTool.get("after_write_tool")).toBe(2);
  });

  test("read tools keep their worker-status path without tool admission", async () => {
    const sessionID = "read-session";
    await expect(before({ tool: "read", sessionID }, { args: { filePath: "/project/file" } })).resolves.toBeUndefined();
    expect(callsByTool.has("read")).toBe(false);
  });
});
