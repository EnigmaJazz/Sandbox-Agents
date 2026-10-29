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

describe("system rule", () => {
  test("states the routing contract in V2 terms", () => {
    expect(SYSTEM_RULE).toContain("Sandbox routing rule");
    expect(SYSTEM_RULE).toContain("sandbox_read / sandbox_list / sandbox_grep");
    expect(SYSTEM_RULE).toContain("shell/edit/write");
    expect(SYSTEM_RULE).not.toContain("bash/edit/write");
  });
});
