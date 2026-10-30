/**
 * OpenCode V2 entry for the reviewer relay transport (docs/upgrades/opencode-v2.md, workstream V4).
 *
 * Sandboxed agents have no shell by design, so the host-side plugin runs the provider transport child for the
 * `asi-review-*` reviewer Tasks. The relay logic is the host-neutral ./../plugins/lib/reviewer-relay-core.ts (shared
 * with V1); ./lib/relay-v2.ts maps the V2 hooks onto it (tested in broker/tests/v2-reviewer-relay.test.ts). This file
 * wires the V2 context: the per-session directory comes from `ctx.session.get`, broker access from the shared client,
 * and session events from `ctx.event.subscribe`.
 *
 * Sorts after `00-routing-guard.ts`, so the guard refuses first. Setup runs once per directory, so several instances
 * can exist; the core's process-global registry already deduplicates them.
 *
 * Gate 1: NOT installed. Delivery is manual (S17): the USER reviews this diff and installs the exact bytes by hand.
 */
import { brokerSocketPath, createBrokerClient, type BrokerClient } from "../plugins/lib/broker-client.ts";
import { createReviewerRelayHooks, type SessionLookupClient } from "../plugins/lib/reviewer-relay-core.ts";
import { createRelayV2Handlers } from "./lib/relay-v2.ts";

/** The provider admits a 2.x OpenCode runtime only under this declaration (gentle-ai 4 managed V2 relay). */
export const V2_RELAY_CONTRACT = "gentle-ai.opencode-relay/v2-staged";

let brokerClientPromise: Promise<BrokerClient> | null = null;

/** Lazy, fail-closed broker client. Never connected at module load. */
function brokerClient(): Promise<BrokerClient> {
  if (!brokerClientPromise) {
    brokerClientPromise = createBrokerClient({ socketPath: brokerSocketPath() }).catch((err) => {
      brokerClientPromise = null; // allow a retry on the next call (fail closed)
      throw err;
    });
  }
  return brokerClientPromise;
}

interface V2Context {
  location: { directory: string };
  session: {
    get(input: { sessionID: string }): Promise<{ location?: { directory?: string } } | undefined>;
    hook(name: "context", fn: (event: any) => Promise<void>): Promise<unknown>;
  };
  tool: { hook(name: "execute.before" | "execute.after", fn: (event: any) => Promise<void>): Promise<unknown> };
  event: { subscribe(): AsyncIterable<{ type: string; data?: unknown }> };
}

export default {
  id: "reviewer-relay-transport",
  async setup(ctx: V2Context) {
    console.log(`[reviewer-relay] plugin loaded directory=${ctx.location.directory}`);
    // The core reads a session's directory through a V1-shaped client; answer it from the V2 session record.
    const client: SessionLookupClient = {
      session: {
        get: async ({ path }) => ({ data: { directory: (await ctx.session.get({ sessionID: path.id }))?.location?.directory } }),
      },
    };
    const core = createReviewerRelayHooks({
      client,
      directory: ctx.location.directory,
      relayContract: V2_RELAY_CONTRACT,
      // The launcher exports the directory holding the V2 `opencode`; the running binary's own directory has only opencode.exe.
      // The server's HOME is an overlay; the provider keeps review authority under the caller's real home.
      ...(process.env.OPENCODE_V2_RELAY_HOME ? { home: process.env.OPENCODE_V2_RELAY_HOME } : {}),
      ...(process.env.OPENCODE_V2_RUNTIME_BIN_DIR ? { runtimeDirectory: process.env.OPENCODE_V2_RUNTIME_BIN_DIR } : {}),
      worktree: ctx.location.directory,
      // The boot workspace is the process cwd, which is stable for the process lifetime.
      serverRoot: process.cwd(),
      brokerRequest: async (operation, sessionID, payload) => (await brokerClient()).request(operation, sessionID, payload),
    });
    const handlers = createRelayV2Handlers(core);

    await ctx.tool.hook("execute.before", (event) => handlers.before(event));
    await ctx.tool.hook("execute.after", (event) => handlers.after(event));
    await ctx.session.hook("context", (event) => handlers.context(event));

    let stopped = false;
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe()) {
          if (stopped) break;
          if (event.type === "session.created" || event.type === "session.deleted") await handlers.event(event as any);
        }
      } catch (error) {
        console.warn(`[reviewer-relay] event stream ended: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();

    return async () => {
      stopped = true;
      await handlers.dispose();
    };
  },
};
