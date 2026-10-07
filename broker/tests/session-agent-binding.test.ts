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
import { BrokerServer } from "../src/server.ts";
import { PolicyError } from "../src/policy.ts";
import {
  authorizeHostDispatch,
  bindSessionAgent,
  buildEnsureWorkerOp,
  type OpContext,
} from "../src/service.ts";
import { SessionStore } from "../src/state.ts";
import { OPERATIONS, SANDBOX_OPERATIONS } from "../src/types.ts";
import {
  HOST_MUTATION_IDENTITY_OPERATIONS,
  HOST_MUTATION_OPERATIONS,
  HOST_READ_OPERATIONS,
  HostToolPolicy,
  hostToolAccess,
  ValidationError,
} from "../src/validation.ts";
import {
  BIND_SESSION_AGENT_OPERATION,
  hostSessionBinding,
} from "../../opencode/plugins/lib/session-agent-binding.ts";

const ORCHESTRATOR = "gentle-orchestrator";
const ORCHESTRATOR_ALT = "gentle-orchestrator-alt";
const PM_AGENTS = ["pm-odd", "pm-systematic", "pm-sdd"] as const;
const HOST_IDENTITIES = [ORCHESTRATOR, ...PM_AGENTS] as const;

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

  test("request-envelope agent claims cannot override the broker session identity", () => {
    const { store, dir } = freshStore();
    try {
      const ctx = bindingCtx(store, [...HOST_IDENTITIES]);
      bindSessionAgent(ctx, "envelope-orchestrator", { agent: ORCHESTRATOR });
      bindSessionAgent(ctx, "envelope-pm", { agent: "pm-odd" });
      const orchestratorRequest = { agent: "pm-odd" };
      const pmRequest = { agent: ORCHESTRATOR };

      expect(authorizeHostDispatch(ctx, "registerProject", "envelope-orchestrator", orchestratorRequest.agent)).toBe("mutation");
      expect(new HostToolPolicy([...HOST_IDENTITIES]).decide("registerProject", store.get("envelope-orchestrator")?.agent)).toEqual({
        allowed: true,
        access: "mutation",
        reasonCode: "HOST_MUTATION_ORCHESTRATOR",
      });
      expect(() => authorizeHostDispatch(ctx, "registerProject", "envelope-pm", pmRequest.agent)).toThrow(
        'host mutation tool "registerProject" is orchestrator-only (HOST_MUTATION_NOT_ORCHESTRATOR)',
      );
      expect(new HostToolPolicy([...HOST_IDENTITIES]).decide("registerProject", store.get("envelope-pm")?.agent)).toEqual({
        allowed: false,
        access: "mutation",
        reasonCode: "HOST_MUTATION_NOT_ORCHESTRATOR",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tool-argument agent claims cannot override the broker session identity", () => {
    const { store, dir } = freshStore();
    try {
      const ctx = bindingCtx(store, [...HOST_IDENTITIES]);
      bindSessionAgent(ctx, "argument-orchestrator", { agent: ORCHESTRATOR });
      bindSessionAgent(ctx, "argument-pm", { agent: "pm-odd" });
      const forgedArgsForOrchestrator = { message: "commit", agent: "pm-odd" };
      const forgedArgsForPm = { message: "commit", agent: ORCHESTRATOR };

      expect(authorizeHostDispatch(ctx, "registerProject", "argument-orchestrator", forgedArgsForOrchestrator.agent)).toBe("mutation");
      expect(() => authorizeHostDispatch(ctx, "registerProject", "argument-pm", forgedArgsForPm.agent)).toThrow(
        'host mutation tool "registerProject" is orchestrator-only (HOST_MUTATION_NOT_ORCHESTRATOR)',
      );
      const pluginSource = readFileSync(
        new URL("../../opencode/plugins/sandbox-tools.ts", import.meta.url),
        "utf8",
      );
      const hostCommit = pluginSource.slice(
        pluginSource.indexOf("host_git_commit: tool({"),
        pluginSource.indexOf("host_git_clear_commit_intent: tool({"),
      );
      expect(hostCommit).toContain("}, ctx.agent)");
      expect(hostCommit).not.toContain("args.agent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unbound session remains denied when its request envelope claims an allowed identity", () => {
    const { store, dir } = freshStore();
    try {
      const ctx = bindingCtx(store, [...HOST_IDENTITIES]);
      const request = { agent: ORCHESTRATOR };
      expect(() => authorizeHostDispatch(ctx, "gitCommit", "unbound-forged", request.agent)).toThrow(
        'host mutation tool "gitCommit" is orchestrator-only (HOST_MUTATION_UNKNOWN_AGENT)',
      );
      expect(new HostToolPolicy([...HOST_IDENTITIES]).decide("gitCommit", store.get("unbound-forged")?.agent)).toEqual({
        allowed: false,
        access: "mutation",
        reasonCode: "HOST_MUTATION_UNKNOWN_AGENT",
      });
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

describe("PM host identity policy", () => {
  test("broker and plugin default identity lists stay identical", () => {
    const pluginSource = readFileSync(
      new URL("../../opencode/plugins/sandbox-tools.ts", import.meta.url),
      "utf8",
    );
    const pluginList = pluginSource.match(/const READ_ONLY_AGENTS: readonly string\[\] = (\[[^\]]*\])/s)?.[1]
      ?.match(/"([^"]+)"/g)
      ?.map((entry) => entry.slice(1, -1));
    expect(pluginList).toEqual(HOST_IDENTITIES);
    expect(pluginList).not.toContain("pm-probe");
    expect(defaultConfig().readOnlyAgents).toEqual(HOST_IDENTITIES);
    expect(defaultConfig().readOnlyAgents).not.toContain("pm-probe");
  });

  test.each(PM_AGENTS)("%s receives PM mutations but not registerProject", (agent) => {
    const { store, dir } = freshStore();
    try {
      const ctx = bindingCtx(store, [...HOST_IDENTITIES]);
      bindSessionAgent(ctx, "pm-session", { agent });
      expect(authorizeHostDispatch(ctx, "gitCommit", "pm-session")).toBe("mutation");
      expect(authorizeHostDispatch(ctx, "reviewStart", "pm-session")).toBe("mutation");
      expect(() => authorizeHostDispatch(ctx, "registerProject", "pm-session")).toThrow(PolicyError);
      expect(authorizeHostDispatch(ctx, "reviewStatus", "pm-session")).toBe("read");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a lingering pm-probe session is unknown and cannot inherit mutation rights", () => {
    const { store, dir } = freshStore();
    try {
      const ctx = bindingCtx(store, [...HOST_IDENTITIES]);
      expect(HOST_MUTATION_IDENTITY_OPERATIONS["pm-probe"]).toBeUndefined();
      store.touch("probe-session", { agent: "pm-probe" });
      expect(new HostToolPolicy([...HOST_IDENTITIES]).decide("gitCommit", "pm-probe")).toEqual({
        allowed: false,
        access: "mutation",
        reasonCode: "HOST_MUTATION_NOT_ORCHESTRATOR",
      });
      expect(() => authorizeHostDispatch(ctx, "gitCommit", "probe-session")).toThrow(
        'host mutation tool "gitCommit" is orchestrator-only (HOST_MUTATION_NOT_ORCHESTRATOR)',
      );
      expect(() => bindSessionAgent(ctx, "new-probe-session", { agent: "pm-probe" })).toThrow(PolicyError);
      expect(store.get("new-probe-session")).toBeUndefined();
      expect(authorizeHostDispatch(ctx, "reviewStatus", "probe-session")).toBe("read");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each(HOST_IDENTITIES)("%s ensureWorker refusal has an identity-specific reason", async (agent) => {
    const { store, dir } = freshStore();
    try {
      const ctx = bindingCtx(store, [...HOST_IDENTITIES]);
      const ensureCtx = { config: ctx.config, store } as unknown as OpContext;
      await expect(
        buildEnsureWorkerOp(ensureCtx)({
          version: 1,
          id: `ensure-${agent}`,
          operation: "ensureWorker",
          sessionID: `unbound-${agent}`,
          agent,
          payload: { projectDir: dir },
        }),
      ).rejects.toThrow(`orchestrator agent "${agent}" is not allowed to create a worker (orchestrator-readonly)`);
      expect(store.get(`unbound-${agent}`)).toBeUndefined();
      expect(() => authorizeHostDispatch(ctx, "gitCommit", `unbound-${agent}`, agent)).toThrow(PolicyError);
      expect(authorizeHostDispatch(ctx, "reviewStatus", `unbound-${agent}`, agent)).toBe("read");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("every sandbox dispatch refuses each bound allowlisted identity before handlers run", async () => {
    const operations = [
      "ensureWorker", "workerStatus", "exec", "readFile", "writeFile", "applyPatch",
      "listDir", "grep", "diff", "prepareResult", "applyResult", "discardResult",
      "keepResult", "destroyWorker", "listWorkers", "copyInInfo", "copyIn",
      "copyOutInfo", "copyOut",
    ] as const;
    const dir = mkdtempSync(join(tmpdir(), "sandbox-dispatch-binding-"));
    try {
      const config = defaultConfig({
        readOnlyAgents: [...HOST_IDENTITIES],
        stateDir: dir,
        projects: [{ id: "test-project", path: dir }],
      });
      const server = new BrokerServer(config);
      const serverStore = (server as unknown as { ctx: { store: SessionStore } }).ctx.store;
      expect(SANDBOX_OPERATIONS).toEqual([
        "ensureWorker", "workerStatus", "exec", "readFile", "writeFile", "applyPatch",
        "listDir", "grep", "diff", "prepareResult", "applyResult", "discardResult",
        "keepResult", "destroyWorker", "listWorkers", "copyInInfo", "copyIn",
        "copyOutInfo", "copyOut",
      ]);
      const dispatch = (server as unknown as {
        dispatch(req: { version: number; id: string; operation: string; sessionID: string; payload: unknown }): Promise<unknown>;
      }).dispatch.bind(server);

      for (const agent of HOST_IDENTITIES) {
        const sessionID = `bound-${agent}`;
        serverStore.touch(sessionID, { agent });
        for (const operation of operations) {
          const req = {
            version: 1,
            id: `${operation}-${agent}`,
            operation,
            sessionID,
            payload: operation === "ensureWorker" ? { projectDir: dir } : {},
          };
          await expect(dispatch(req)).rejects.toMatchObject({
            code: "policy",
            message: operation === "ensureWorker"
              ? `orchestrator agent "${agent}" is not allowed to create a worker (orchestrator-readonly)`
              : `orchestrator agent "${agent}" is not allowed to use sandbox operation "${operation}" (orchestrator-readonly)`,
          });
        }
      }

      serverStore.touch("ordinary-unbound");
      for (const operation of operations) {
        const req = {
          version: 1,
          id: `ordinary-${operation}`,
          operation,
          sessionID: "ordinary-unbound",
          payload: operation === "ensureWorker" ? { projectDir: "/not-registered" } : {},
        };
        try {
          await dispatch(req);
        } catch (error) {
          expect(String(error)).not.toContain("orchestrator-readonly");
        }
      }
      await expect(dispatch({
        version: 1,
        id: "unbound-envelope-claim",
        operation: "workerStatus",
        sessionID: "unbound-envelope-claim",
        agent: "pm-odd",
        payload: {},
      })).rejects.toMatchObject({ message: "unknown session unbound-envelope-claim" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an ordinary existing worker session is permitted through ensureWorker", async () => {
    const { store, dir } = freshStore();
    try {
      const ctx = bindingCtx(store, [...HOST_IDENTITIES]);
      const ensureCtx = {
        config: { ...ctx.config, projects: [{ id: "ordinary-project", path: dir }] },
        store,
        git: {
          spawn: async (argv: string[]) => ({
            status: 0,
            stdout: argv.includes("--format=%s") ? "ordinary baseline" : "a".repeat(40),
            stderr: "",
          }),
        },
      } as unknown as OpContext;
      store.touch("ordinary-active", {
        state: "SANDBOX_ACTIVE",
        projectID: "ordinary-project",
        baselineRef: "refs/baseline/ordinary-active",
        workerName: "worker-ordinary",
        workerState: "ACTIVE",
      });
      await expect(
        buildEnsureWorkerOp(ensureCtx)({
          version: 1,
          id: "ensure-ordinary",
          operation: "ensureWorker",
          sessionID: "ordinary-active",
          payload: { projectDir: dir },
        }),
      ).resolves.toMatchObject({ worker: "worker-ordinary", state: "SANDBOX_ACTIVE", reused: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each(HOST_IDENTITIES)("%s binding is first-writer-wins", (agent) => {
    const { store, dir } = freshStore();
    try {
      const ctx = bindingCtx(store, [...HOST_IDENTITIES]);
      bindSessionAgent(ctx, `first-${agent}`, { agent });
      const replacement = agent === ORCHESTRATOR ? "pm-odd" : ORCHESTRATOR;
      expect(() => bindSessionAgent(ctx, `first-${agent}`, { agent: replacement })).toThrow(PolicyError);
      expect(store.get(`first-${agent}`)?.agent).toBe(agent);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sandbox plugin guards every mutation and read surface with the identity list", () => {
    const pluginSource = readFileSync(
      new URL("../../opencode/plugins/sandbox-tools.ts", import.meta.url),
      "utf8",
    );
    for (const tool of ["sandbox_read", "sandbox_list", "sandbox_grep", "sandbox_write", "sandbox_edit", "sandbox_apply_patch", "sandbox_bash", "sandbox_diff", "sandbox_finish", "sandbox_apply", "sandbox_copy_out", "sandbox_copy_in", "sandbox_discard"]) {
      expect(pluginSource).toContain(`assertNotOrchestrator(ctx.agent, "${tool}")`);
    }
    expect(pluginSource).toContain("READ_ONLY_AGENTS.includes(agent)");
  });

  test.each(HOST_IDENTITIES)("%s host binding comes only from allowed chat.params fields", (agent) => {
    expect(hostSessionBinding({ sessionID: `session-${agent}`, agent }, [agent])).toEqual({
      sessionID: `session-${agent}`,
      agent,
    });
    expect(hostSessionBinding({ sessionID: `session-${agent}`, agent }, [])).toBeNull();
    expect(hostSessionBinding({ sessionID: `session-${agent}`, agent: "request-envelope" }, [agent])).toBeNull();
  });

  test("a worker-lifecycle session can never acquire a privileged binding", () => {
    const { store, dir } = freshStore();
    try {
      const ctx = bindingCtx(store, [...HOST_IDENTITIES]);
      store.touch("unnamed-active", { state: "SANDBOX_ACTIVE", workerName: "worker-1" });
      expect(() => bindSessionAgent(ctx, "unnamed-active", { agent: "pm-odd" })).toThrow(PolicyError);
      store.touch("terminal-worker", { state: "REJECTED", workerLifecycleEntered: true });
      expect(() => bindSessionAgent(ctx, "terminal-worker", { agent: "pm-sdd" })).toThrow(PolicyError);
      store.touch("named-worker", { state: "SANDBOX_ACTIVE", agent: "general", workerName: "worker-2" });
      expect(() => bindSessionAgent(ctx, "named-worker", { agent: "pm-systematic" })).toThrow(PolicyError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
