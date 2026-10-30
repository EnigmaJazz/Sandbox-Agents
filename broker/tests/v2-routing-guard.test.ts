import { describe, expect, test } from "bun:test";
import {
  SYSTEM_RULE,
  createRoutingGuard,
  toBrokerToolName,
  type GuardBroker,
} from "../../opencode/plugins-v2/lib/guard-core.ts";

const SESSION = "ses_guard1";
const ROOTS = ["/home/james/reference"];

interface Fake {
  broker: GuardBroker;
  calls: Array<{ operation: string; sessionID: string; payload?: unknown }>;
  state: { value: string | "unknown" };
  admission: (tool: string) => unknown;
  setAdmission(fn: (tool: string) => unknown): void;
  down: { value: boolean };
}

function fake(): Fake {
  const calls: Fake["calls"] = [];
  const state = { value: "HOST_READ_ONLY" as string };
  const down = { value: false };
  let admission = (tool: string): unknown => ({
    schema: "opencode-sandbox.tool-admission/v1",
    tool,
    classification: "READ_PROJECT",
    decision: "allow",
    reason: "ok",
  });
  const f: Fake = {
    calls,
    state,
    down,
    admission: (t) => admission(t),
    setAdmission: (fn) => { admission = fn; },
    broker: {
      request: async (operation, sessionID, payload) => {
        calls.push({ operation, sessionID, payload });
        if (down.value) throw new Error("broker down");
        if (operation === "workerStatus") {
          if (state.value === "unknown") throw new Error("unknown session");
          return { state: state.value };
        }
        if (operation === "policy") return { approvedExternalReadRoots: ROOTS };
        if (operation === "toolAdmission") return admission((payload as { tool: string }).tool);
        throw new Error(`unexpected ${operation}`);
      },
    },
  };
  return f;
}

const guardFor = (f: Fake) => createRoutingGuard({ broker: async () => f.broker });
const ev = (tool: string, input: unknown = {}) => ({ tool, sessionID: SESSION, input });
const admissionCalls = (f: Fake) => f.calls.filter((c) => c.operation === "toolAdmission");

describe("tool name mapping", () => {
  test("V2 shell and subagent map to the inventory names the broker classifies", () => {
    expect(toBrokerToolName("shell")).toBe("bash");
    expect(toBrokerToolName("subagent")).toBe("task");
  });
  test("every other name, including Code Mode's execute, passes through unchanged", () => {
    for (const name of ["read", "grep", "glob", "edit", "write", "webfetch", "execute", "sandbox_read", "host_git_commit"]) {
      expect(toBrokerToolName(name)).toBe(name);
    }
  });
});

describe("read routing", () => {
  test("allows host reads before activation (HOST_READ_ONLY)", async () => {
    const f = fake();
    await guardFor(f).before(ev("read", { path: "/home/james/project/a.ts" }));
  });

  test("allows host reads when the session is unknown to the broker", async () => {
    const f = fake();
    f.state.value = "unknown";
    await guardFor(f).before(ev("read", { path: "/home/james/project/a.ts" }));
  });

  for (const state of ["SANDBOX_ACTIVE", "RESULT_READY"]) {
    test(`blocks a project read in ${state} with the redirect message`, async () => {
      const f = fake();
      f.state.value = state;
      await expect(guardFor(f).before(ev("read", { path: "/home/james/project/a.ts" }))).rejects.toThrow(/sandbox_read/);
    });
  }

  test("uses the V2 input keys: read.path, grep.path and pattern, glob.pattern", async () => {
    const f = fake();
    f.state.value = "SANDBOX_ACTIVE";
    const guard = guardFor(f);
    await guard.before(ev("read", { path: "/home/james/reference/x.md" }));
    await guard.before(ev("grep", { pattern: "/home/james/reference/y", path: "/home/james/reference" }));
    await guard.before(ev("glob", { pattern: "/home/james/reference/**/*.md" }));
    await expect(guard.before(ev("grep", { pattern: "needle", path: "/home/james/project" }))).rejects.toThrow(/sandbox_read/);
  });

  test("an approved external root stays readable; a mix of external and project targets does not", async () => {
    const f = fake();
    f.state.value = "SANDBOX_ACTIVE";
    const guard = guardFor(f);
    await guard.before(ev("read", { path: "/home/james/reference/doc.md" }));
    await expect(guard.before(ev("grep", { pattern: "x", path: "/home/james/reference/../project" }))).rejects.toThrow();
    await expect(guard.before(ev("grep", { pattern: "x", path: "/home/james/project" }))).rejects.toThrow();
  });

  test("a read with no path target is blocked once a worker is active", async () => {
    const f = fake();
    f.state.value = "SANDBOX_ACTIVE";
    await expect(guardFor(f).before(ev("glob", {}))).rejects.toThrow(/sandbox_read/);
  });

  test("fails closed when the broker is unreachable", async () => {
    const f = fake();
    f.down.value = true;
    // workerStatus failing means "unknown session" only for a reachable broker; a refused connection must block
    const guard = createRoutingGuard({ broker: async () => { throw new Error("connect ECONNREFUSED"); } });
    await expect(guard.before(ev("read", { path: "/x" }))).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("tool admission", () => {
  test("asks the broker with the inventory name and lets an allowed tool through", async () => {
    const f = fake();
    await guardFor(f).before(ev("shell", { command: "ls" }));
    expect(admissionCalls(f)[0]!.payload).toEqual({ tool: "bash" });
  });

  test("denies a tool the broker denies, with the reason on one line", async () => {
    const f = fake();
    f.setAdmission((tool) => ({
      schema: "opencode-sandbox.tool-admission/v1", tool, classification: "HOST_ADMIN_STRUCTURED", decision: "deny", reason: "host\nmutation",
    }));
    const error = await guardFor(f).before(ev("shell", { command: "rm -rf /" })).catch((e) => e as Error);
    expect(String((error as Error).message)).toContain("denied by broker admission (host mutation)");
  });

  test("denies Code Mode's execute (unclassified) rather than guessing", async () => {
    const f = fake();
    f.setAdmission((tool) => ({
      schema: "opencode-sandbox.tool-admission/v1", tool, classification: "unclassified", decision: "deny", reason: "not in inventory",
    }));
    await expect(guardFor(f).before(ev("execute", { code: "1" }))).rejects.toThrow(/denied by broker admission/);
  });

  test("an unclassified classification is denied even if the broker said allow", async () => {
    const f = fake();
    f.setAdmission((tool) => ({
      schema: "opencode-sandbox.tool-admission/v1", tool, classification: "unclassified", decision: "allow", reason: "x",
    }));
    await expect(guardFor(f).before(ev("mystery"))).rejects.toThrow(/denied by broker admission/);
  });

  for (const [label, reply] of [
    ["null", null],
    ["an array", []],
    ["a wrong schema", { schema: "other", tool: "bash", classification: "x", decision: "allow", reason: "r" }],
    ["a different tool", { schema: "opencode-sandbox.tool-admission/v1", tool: "edit", classification: "x", decision: "allow", reason: "r" }],
    ["a non-string reason", { schema: "opencode-sandbox.tool-admission/v1", tool: "bash", classification: "x", decision: "allow", reason: 1 }],
    ["an unknown decision", { schema: "opencode-sandbox.tool-admission/v1", tool: "bash", classification: "x", decision: "maybe", reason: "r" }],
  ] as const) {
    test(`a malformed reply (${label}) blocks the call`, async () => {
      const f = fake();
      f.setAdmission(() => reply);
      await expect(guardFor(f).before(ev("shell"))).rejects.toThrow(/malformed reply/);
    });
  }

  test("caches the decision per session and tool", async () => {
    const f = fake();
    const guard = guardFor(f);
    await guard.before(ev("webfetch"));
    await guard.before(ev("webfetch"));
    expect(admissionCalls(f)).toHaveLength(1);
  });

  test("a state-changing sandbox tool clears that session's cache", async () => {
    const f = fake();
    const guard = guardFor(f);
    await guard.before(ev("webfetch"));
    await guard.before(ev("sandbox_write"));
    await guard.before(ev("webfetch"));
    expect(admissionCalls(f)).toHaveLength(2);
  });

  test("sandbox_* tools and the apply-preview tools are not sent to admission", async () => {
    const f = fake();
    const guard = guardFor(f);
    await guard.before(ev("sandbox_read"));
    await guard.before(ev("sandbox_apply_preview"));
    await guard.before(ev("applyPreview"));
    expect(admissionCalls(f)).toHaveLength(0);
  });
});

/** A broker that behaves like the real one for identity: until a session is bound to an agent, mutation classes are refused. */
function bindingBroker() {
  const calls: Array<{ operation: string; sessionID: string; payload?: unknown }> = [];
  const bound = new Map<string, string>();
  const behaviour = { bindFails: false };
  const broker: GuardBroker = {
    request: async (operation, sessionID, payload) => {
      calls.push({ operation, sessionID, payload });
      if (operation === "bindSessionAgent") {
        if (behaviour.bindFails) throw new Error("broker refused the binding");
        bound.set(sessionID, (payload as { agent: string }).agent);
        return { ok: true };
      }
      if (operation === "toolAdmission") {
        const tool = (payload as { tool: string }).tool;
        const isBound = bound.has(sessionID);
        return {
          schema: "opencode-sandbox.tool-admission/v1",
          tool,
          classification: "HOST_APPROVED_MUTATION",
          decision: isBound ? "allow" : "deny",
          reason: isBound ? `bound as ${bound.get(sessionID)}` : "UNBOUND_SESSION_MUTATION_DENIED",
        };
      }
      throw new Error(`unexpected ${operation}`);
    },
  };
  return { broker, calls, bound, behaviour };
}
const withAgent = (tool: string, agent?: string, sessionID = SESSION) => ({ tool, sessionID, input: {}, ...(agent === undefined ? {} : { agent }) });
const ops = (calls: Array<{ operation: string }>) => calls.map((c) => c.operation);

describe("session identity (V1 bound it on every turn; V2 has no such hook)", () => {
  test("binds the session with the host-supplied agent before asking admission, then admits", async () => {
    const b = bindingBroker();
    await createRoutingGuard({ broker: async () => b.broker }).before(withAgent("host_git_commit", "gentle-orchestrator"));
    expect(ops(b.calls)).toEqual(["bindSessionAgent", "toolAdmission"]);
    expect(b.calls[0]!.payload).toEqual({ agent: "gentle-orchestrator" });
    expect(b.bound.get(SESSION)).toBe("gentle-orchestrator");
  });

  test("positive control: with no agent from the host the broker is not told anyone and the mutation is refused", async () => {
    const b = bindingBroker();
    await expect(createRoutingGuard({ broker: async () => b.broker }).before(withAgent("host_git_commit"))).rejects.toThrow(/UNBOUND_SESSION_MUTATION_DENIED/);
    expect(ops(b.calls)).toEqual(["toolAdmission"]);
  });

  test("a refusal for an unbound session is not remembered: the same session is admitted once the host supplies its agent", async () => {
    const b = bindingBroker();
    const guard = createRoutingGuard({ broker: async () => b.broker });
    await expect(guard.before(withAgent("host_git_commit"))).rejects.toThrow(/UNBOUND_SESSION_MUTATION_DENIED/);
    await guard.before(withAgent("host_git_commit", "gentle-orchestrator")); // before the fix this replayed the cached refusal
    expect(ops(b.calls).filter((o) => o === "toolAdmission")).toHaveLength(2);
  });

  test("an unbound answer is asked again every time (it is never cached)", async () => {
    const b = bindingBroker();
    const guard = createRoutingGuard({ broker: async () => b.broker });
    await guard.before(withAgent("host_git_commit")).catch(() => {});
    await guard.before(withAgent("host_git_commit")).catch(() => {});
    expect(ops(b.calls)).toEqual(["toolAdmission", "toolAdmission"]);
  });

  test("binds once per session and agent, and still caches a bound decision", async () => {
    const b = bindingBroker();
    const guard = createRoutingGuard({ broker: async () => b.broker });
    await guard.before(withAgent("host_git_commit", "gentle-orchestrator"));
    await guard.before(withAgent("host_git_commit", "gentle-orchestrator"));
    await guard.before(withAgent("host_review_assess", "gentle-orchestrator"));
    expect(ops(b.calls).filter((o) => o === "bindSessionAgent")).toHaveLength(1);
    expect(ops(b.calls).filter((o) => o === "toolAdmission")).toHaveLength(2); // one per distinct tool
  });

  test("a different agent on the same session rebinds and drops the decisions made for the old one", async () => {
    const b = bindingBroker();
    const guard = createRoutingGuard({ broker: async () => b.broker });
    await guard.before(withAgent("host_git_commit", "gentle-orchestrator"));
    await guard.before(withAgent("host_git_commit", "general"));
    expect(ops(b.calls)).toEqual(["bindSessionAgent", "toolAdmission", "bindSessionAgent", "toolAdmission"]);
    expect(b.bound.get(SESSION)).toBe("general");
  });

  test("a binding the broker refuses does not open anything: admission still decides", async () => {
    const b = bindingBroker();
    b.behaviour.bindFails = true;
    await expect(createRoutingGuard({ broker: async () => b.broker }).before(withAgent("host_git_commit", "gentle-orchestrator"))).rejects.toThrow(/UNBOUND_SESSION_MUTATION_DENIED/);
  });

  test("sessions are bound independently", async () => {
    const b = bindingBroker();
    const guard = createRoutingGuard({ broker: async () => b.broker });
    await guard.before(withAgent("host_git_commit", "gentle-orchestrator", "ses_a"));
    await expect(guard.before(withAgent("host_git_commit", undefined, "ses_b"))).rejects.toThrow(/UNBOUND/);
  });

  for (const [label, agent] of [["empty", ""], ["too long", "x".repeat(129)]] as const) {
    test(`a malformed agent (${label}) is never sent to the broker as an identity`, async () => {
      const b = bindingBroker();
      await createRoutingGuard({ broker: async () => b.broker }).before(withAgent("host_git_commit", agent)).catch(() => {});
      expect(ops(b.calls)).not.toContain("bindSessionAgent");
    });
  }

  test("a malformed session id is never bound", async () => {
    const b = bindingBroker();
    await createRoutingGuard({ broker: async () => b.broker }).before(withAgent("host_git_commit", "gentle-orchestrator", "bad id!")).catch(() => {});
    expect(ops(b.calls)).not.toContain("bindSessionAgent");
  });

  test("sandbox tools and host reads do not trigger a binding call", async () => {
    const b = bindingBroker();
    const guard = createRoutingGuard({ broker: async () => b.broker });
    await guard.before(withAgent("sandbox_read", "general"));
    await guard.before(withAgent("sandbox_apply_preview", "general"));
    expect(ops(b.calls)).toEqual([]);
  });
});

describe("system rule", () => {
  test("states the routing contract in V2 terms", () => {
    expect(SYSTEM_RULE).toContain("Sandbox routing rule");
    expect(SYSTEM_RULE).toContain("sandbox_read / sandbox_list / sandbox_grep");
    expect(SYSTEM_RULE).toContain("shell/edit/write");
    expect(SYSTEM_RULE).not.toContain("bash/edit/write");
  });
});
