/**
 * OpenCode V2 entry for the read-routing guard (docs/upgrades/opencode-v2.md, workstream V3).
 *
 * The decisions live in ./lib/guard-core.ts (tested in broker/tests/v2-routing-guard.test.ts); this file wires them to
 * the V2 hooks and keeps one cached broker connection. The `00-` prefix makes the file sort first: V2 runs hooks in
 * sorted discovery order and skips later plugins' hooks once one throws, so the guard must refuse before any other
 * plugin sees the call. The system rule goes in through the session `context` hook.
 *
 * Gate 1: NOT installed. Delivery is manual (S17): the USER reviews this diff and installs the exact bytes by hand.
 */
import { brokerSocketPath, createBrokerClient, type BrokerClient } from "../plugins/lib/broker-client.ts";
import { SYSTEM_RULE, createRoutingGuard } from "./lib/guard-core.ts";

let clientPromise: Promise<BrokerClient> | null = null;
let clientSocketPath: string | null = null;

/** One cached client; replaced when the socket path changes, dropped when connecting fails so the next call retries. */
function broker(): Promise<BrokerClient> {
  const socketPath = brokerSocketPath();
  if (clientPromise && clientSocketPath !== socketPath) {
    void clientPromise.then((client) => client.close(), () => {});
    clientPromise = null;
    clientSocketPath = null;
  }
  if (!clientPromise) {
    clientSocketPath = socketPath;
    const pending: Promise<BrokerClient> = createBrokerClient({ socketPath }).catch((err) => {
      if (clientPromise === pending) {
        clientPromise = null;
        clientSocketPath = null;
      }
      throw err;
    });
    clientPromise = pending;
  }
  return clientPromise;
}

interface V2Context {
  tool: {
    hook(name: "execute.before", fn: (event: { tool: string; sessionID: string; input?: unknown; agent?: string }) => Promise<void>): Promise<unknown>;
  };
  session: {
    hook(name: "context", fn: (event: { system: unknown[] }) => void): Promise<unknown>;
  };
}

export default {
  id: "routing-guard",
  async setup(ctx: V2Context) {
    const guard = createRoutingGuard({ broker });
    await ctx.tool.hook("execute.before", (event) => guard.before(event));
    await ctx.session.hook("context", (event) => {
      if (Array.isArray(event.system)) event.system.push({ type: "text", text: SYSTEM_RULE });
    });
  },
};
