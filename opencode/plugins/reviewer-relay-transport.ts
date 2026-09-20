/**
 * Reviewer relay transport plugin — OpenCode plugin entry point.
 *
 * OpenCode's plugin loader invokes EVERY exported function of a plugin module
 * as a plugin. Exporting helpers here (or a class, which cannot be called
 * without `new`) made the loader silently skip this plugin. This module
 * therefore exports ONLY the plugin function and its default; every helper
 * lives in `./lib/reviewer-relay-core.ts`, which the loader never auto-loads.
 *
 * Gate 1: NOT installed. Delivery is manual (S17): the USER reviews this diff
 * and installs the exact bytes by hand. Agents never apply or certify it.
 */
import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { createBrokerClient, brokerSocketPath, type BrokerClient } from "./lib/broker-client.ts";
import { createReviewerRelayHooks, type SessionLookupClient } from "./lib/reviewer-relay-core.ts";

let brokerClientPromise: Promise<BrokerClient> | null = null;

/** Lazy, fail-closed broker client. Never connected at module load or in tests. */
function brokerClient(): Promise<BrokerClient> {
  if (!brokerClientPromise) {
    brokerClientPromise = createBrokerClient({ socketPath: brokerSocketPath() }).catch((err) => {
      brokerClientPromise = null; // allow a retry on the next call (fail closed)
      throw err;
    });
  }
  return brokerClientPromise;
}

export const ReviewerRelayTransportPlugin: Plugin = async (input: PluginInput) => {
  console.log(`[reviewer-relay] plugin loaded directory=${input.directory} worktree=${input.worktree}`);
  return createReviewerRelayHooks({
    client: input.client as unknown as SessionLookupClient,
    directory: input.directory,
    worktree: input.worktree,
    // `PluginInput.directory` follows the request (it equals the session's
    // project), so it cannot identify the server's own root. The boot workspace
    // is the process cwd, which is stable for the process lifetime.
    serverRoot: process.cwd(),
    brokerRequest: async (operation, sessionID, payload) => {
      const client = await brokerClient();
      return await client.request(operation, sessionID, payload);
    },
  }) as unknown as Awaited<ReturnType<Plugin>>;
};

export default ReviewerRelayTransportPlugin;
