/**
 * RED contract for the host-authoritative session→agent binding.
 *
 * The correction made `authorizeHostDispatch` record-only, but no path seeds an
 * agent onto an orchestrator's session record, so orchestrator host mutations
 * (including the review lifecycle) fail closed. These tests pin the binding that
 * restores them WITHOUT reopening R1-host-agent-spoof: the agent is recorded
 * from the host plugin's `chat.params` identity, never from a model tool
 * argument, and the operation is absent from the model-facing tool surface.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { PolicyError } from "../src/policy.ts";
import {
  authorizeHostDispatch,
  bindSessionAgent,
  buildEnsureWorkerOp,
  type OpContext,
} from "../src/service.ts";
import { SessionStore } from "../src/state.ts";
import { OPERATIONS } from "../src/types.ts";
import {
  HOST_MUTATION_OPERATIONS,
  HOST_READ_OPERATIONS,
  hostToolAccess,
  ValidationError,
} from "../src/validation.ts";
import {
  BIND_SESSION_AGENT_OPERATION,
  hostSessionBinding,
} from "../../opencode/plugins/lib/session-agent-binding.ts";

const ORCHESTRATOR = "gentle-orchestrator";
const ORCHESTRATOR_ALT = "gentle-orchestrator-alt";

function freshStore(): { store: SessionStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "session-binding-"));
  return { store: new SessionStore(dir), dir };
}

function bindingCtx(store: SessionStore, readOnlyAgents: string[] = [ORCHESTRATOR, ORCHESTRATOR_ALT]) {
  return { config: defaultConfig({ readOnlyAgents }), store };
}

describe("host-authoritative session→agent binding", () => {
  test("the binding establishes orchestrator identity for host mutations", () => {
    const { store, dir } = freshStore();
    try {
      const ctx = bindingCtx(store);
      // No host-authoritative binding yet: the mutation fails closed.
      expect(() => authorizeHostDispatch(ctx, "gitCommit", "s1")).toThrow(PolicyError);
      const record = bindSessionAgent(ctx, "s1", { agent: ORCHESTRATOR });
      expect(record.agent).toBe(ORCHESTRATOR);
      // The record alone now authorizes; the envelope claim is irrelevant.
      expect(authorizeHostDispatch(ctx, "gitCommit", "s1", undefined)).toBe("mutation");
      expect(
        authorizeHostDispatch(ctx, "reviewAcknowledgeApproved", "s1", "general"),
      ).toBe("mutation");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a sandbox-worker path cannot establish or inherit orchestrator identity", async () => {
    const { store, dir } = freshStore();
    try {
      const ctx = bindingCtx(store);
      // 1. The model-reachable ensureWorker path refuses an orchestrator claim
      //    before any side effect, so it can never be the first writer.
      const ensureCtx = { config: ctx.config, store } as unknown as OpContext;
      await expect(
        buildEnsureWorkerOp(ensureCtx)({
          version: 1,
          id: "req-ensure",
          operation: "ensureWorker",
          sessionID: "worker-1",
          agent: ORCHESTRATOR,
          payload: { projectDir: dir },
        }),
      ).rejects.toThrow(PolicyError);
      expect(store.get("worker-1")).toBeUndefined();
      // 2. A plain envelope claim never authorizes; an unbound session fails.
      expect(() =>
        authorizeHostDispatch(ctx, "gitCommit", "worker-1", ORCHESTRATOR),
      ).toThrow(PolicyError);
      // 3. The binding op refuses a non-orchestrator/model-supplied agent and
      //    creates no record.
      expect(() => bindSessionAgent(ctx, "worker-1", { agent: "general" })).toThrow(PolicyError);
      expect(store.get("worker-1")).toBeUndefined();
      // 4. A missing or ill-typed agent is refused too.
      expect(() => bindSessionAgent(ctx, "worker-1", {})).toThrow(ValidationError);
      expect(() => bindSessionAgent(ctx, "worker-1", { agent: 7 })).toThrow(ValidationError);
      // 5. Unknown keys are rejected (exact-payload-key validation).
      expect(() =>
        bindSessionAgent(ctx, "worker-1", { agent: ORCHESTRATOR, sessionID: "spoof" }),
      ).toThrow(ValidationError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the first host-authoritative binding wins and cannot be repointed", () => {
    const { store, dir } = freshStore();
    try {
      const ctx = bindingCtx(store);
      bindSessionAgent(ctx, "s1", { agent: ORCHESTRATOR });
      expect(() => bindSessionAgent(ctx, "s1", { agent: ORCHESTRATOR_ALT })).toThrow(PolicyError);
      expect(store.get("s1")?.agent).toBe(ORCHESTRATOR);
      // Idempotent re-bind of the same host identity is allowed.
      expect(bindSessionAgent(ctx, "s1", { agent: ORCHESTRATOR }).agent).toBe(ORCHESTRATOR);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the binding is not part of the model-facing host tool surface", () => {
    expect(OPERATIONS).toContain(BIND_SESSION_AGENT_OPERATION);
    expect(HOST_READ_OPERATIONS).not.toContain(BIND_SESSION_AGENT_OPERATION);
    expect(HOST_MUTATION_OPERATIONS).not.toContain(BIND_SESSION_AGENT_OPERATION);
    expect(() => hostToolAccess(BIND_SESSION_AGENT_OPERATION)).toThrow(ValidationError);
    const pluginSource = readFileSync(
      new URL("../../opencode/plugins/sandbox-tools.ts", import.meta.url),
      "utf8",
    );
    expect(pluginSource).toContain('"chat.params"');
    expect(pluginSource).toContain("BIND_SESSION_AGENT_OPERATION");
    expect(pluginSource).not.toContain("host_bind_session_agent");
    expect(pluginSource).not.toContain("sandbox_bind_session_agent");
  });
});

describe("host chat hook binding extraction", () => {
  test("binds only a host-resolved session id plus an allowed orchestrator agent", () => {
    expect(hostSessionBinding({ sessionID: "s1", agent: ORCHESTRATOR }, [ORCHESTRATOR])).toEqual({
      sessionID: "s1",
      agent: ORCHESTRATOR,
    });
    expect(hostSessionBinding({ sessionID: "s1", agent: "general" }, [ORCHESTRATOR])).toBeNull();
    expect(hostSessionBinding({ sessionID: "", agent: ORCHESTRATOR }, [ORCHESTRATOR])).toBeNull();
    expect(
      hostSessionBinding({ sessionID: "bad id", agent: ORCHESTRATOR }, [ORCHESTRATOR]),
    ).toBeNull();
    expect(hostSessionBinding({ agent: ORCHESTRATOR }, [ORCHESTRATOR])).toBeNull();
    expect(hostSessionBinding(null, [ORCHESTRATOR])).toBeNull();
    // A tool-argument-shaped object never binds: the allowlist is authoritative.
    expect(
      hostSessionBinding({ agent: ORCHESTRATOR, sessionID: "s1" }, []),
    ).toBeNull();
  });
});
