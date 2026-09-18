/**
 * Pure helper for the host-authoritative session→agent binding.
 *
 * The binding value MUST come from the host-resolved `chat.params` hook input
 * (`{ sessionID, agent }`), never from a model tool argument. This module is
 * dependency-free so the broker test suite can exercise it without loading the
 * opencode plugin runtime.
 *
 * Gate 1: NOT installed. Delivery is manual (S17): the USER reviews this diff
 * and installs the exact bytes by hand. Agents never apply or certify it.
 */

/** Broker operation the host plugin uses to record a session's identity. */
export const BIND_SESSION_AGENT_OPERATION = "bindSessionAgent";

/** Mirrors the broker server's session-id allowlist (`SESSION_ID_RE`). */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface HostSessionBinding {
  sessionID: string;
  agent: string;
}

/**
 * Extract a bindable `{ sessionID, agent }` from a host chat-hook input.
 *
 * Returns null unless both values are present and well-formed AND the agent is
 * one of the configured orchestrator identities. The model never supplies this
 * shape: `sessionID` and `agent` are resolved by the host before the LLM call,
 * so a sandbox-worker session (whose host-resolved agent is its own worker
 * identity) can never produce an orchestrator binding through this helper.
 */
export function hostSessionBinding(
  input: unknown,
  orchestratorAgents: readonly string[],
): HostSessionBinding | null {
  if (typeof input !== "object" || input === null) return null;
  const value = input as { sessionID?: unknown; agent?: unknown };
  if (typeof value.sessionID !== "string" || !SESSION_ID_RE.test(value.sessionID)) {
    return null;
  }
  if (
    typeof value.agent !== "string" ||
    value.agent.length === 0 ||
    value.agent.length > 128
  ) {
    return null;
  }
  if (!orchestratorAgents.includes(value.agent)) return null;
  return { sessionID: value.sessionID, agent: value.agent };
}
