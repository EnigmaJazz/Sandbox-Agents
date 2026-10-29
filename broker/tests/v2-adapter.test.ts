import { describe, expect, test } from "bun:test";
import {
  adaptToolSpec,
  askToPermission,
  resultToV2,
  type HostToolSpecLike,
  type V2AdapterDeps,
} from "../../opencode/plugins-v2/lib/v2-adapter.ts";

const SESSION = "ses_abc123";
const toolCtx = { sessionID: SESSION, agent: "pm-odd", messageID: "msg_1", id: "call_1", progress: async () => {} };

interface Calls {
  bind: Array<{ sessionID: string; agent: string }>;
  assert: any[];
  executed: Array<{ args: any; ctx: any }>;
}

function deps(overrides: Partial<V2AdapterDeps> = {}): { deps: V2AdapterDeps; calls: Calls } {
  const calls: Calls = { bind: [], assert: [], executed: [] };
  return {
    calls,
    deps: {
      toInputSchema: (args) => ({ wrapped: args }),
      bindSessionAgent: async (sessionID, agent) => void calls.bind.push({ sessionID, agent }),
      assertPermission: async (request) => void calls.assert.push(request),
      sessionDirectory: async () => "/work/project",
      ...overrides,
    },
  };
}

function spec(execute: HostToolSpecLike["execute"] = async () => "ok"): HostToolSpecLike {
  return { description: "does a thing", args: { path: "a-schema" }, execute };
}

describe("askToPermission", () => {
  test("maps the V1 ask to a V2 permission assertion for the calling session and agent", () => {
    const request = askToPermission(
      { permission: "sandbox_apply", patterns: ["*"], always: ["x"], metadata: { summary: "apply it", totalLines: 3 } },
      SESSION,
      "pm-odd",
    );
    expect(request).toEqual({
      action: "sandbox_apply",
      resources: ["*"],
      metadata: { summary: "apply it", totalLines: 3 },
      sessionID: SESSION,
      agent: "pm-odd",
    });
  });

  test("never carries 'always': a V2 approval is per call", () => {
    const request = askToPermission({ permission: "p", patterns: ["a"], always: ["a"], metadata: {} }, SESSION, undefined);
    expect("always" in request).toBe(false);
  });

  test("rejects an ask without a permission name instead of asserting something vague", () => {
    expect(() => askToPermission({ patterns: ["*"], metadata: {} } as any, SESSION, "x")).toThrow(/permission/);
  });

  test("defaults patterns to the wildcard and metadata to empty", () => {
    expect(askToPermission({ permission: "p" } as any, SESSION, "x")).toMatchObject({ resources: ["*"], metadata: {} });
  });
});

describe("resultToV2", () => {
  test("a string becomes text content", () => {
    expect(resultToV2("hello")).toEqual({ content: "hello" });
  });
  test("a non-string result is serialised, never dropped", () => {
    expect(resultToV2({ a: 1 })).toEqual({ content: JSON.stringify({ a: 1 }, null, 2) });
    expect(resultToV2(undefined)).toEqual({ content: "" });
  });
});

describe("adaptToolSpec", () => {
  test("defines name, description and input, and turns Code Mode off", () => {
    const { deps: d } = deps();
    const tool = adaptToolSpec("sandbox_write", spec(), d);
    expect(tool.name).toBe("sandbox_write");
    expect(tool.description).toBe("does a thing");
    expect(tool.input).toEqual({ wrapped: { path: "a-schema" } });
    expect(tool.options).toEqual({ codemode: false });
  });

  test("binds the host-supplied agent before the handler runs, then hands it the host context", async () => {
    const { deps: d, calls } = deps();
    const order: string[] = [];
    const tool = adaptToolSpec(
      "t",
      spec(async (args, ctx) => {
        order.push("execute");
        calls.executed.push({ args, ctx });
        return "done";
      }),
      { ...d, bindSessionAgent: async (s, a) => { order.push("bind"); calls.bind.push({ sessionID: s, agent: a }); } },
    );
    const result = await tool.execute({ path: "x" }, toolCtx);
    expect(order).toEqual(["bind", "execute"]);
    expect(calls.bind).toEqual([{ sessionID: SESSION, agent: "pm-odd" }]);
    expect(calls.executed[0]!.args).toEqual({ path: "x" });
    expect(calls.executed[0]!.ctx).toMatchObject({ sessionID: SESSION, agent: "pm-odd", directory: "/work/project" });
    expect(result).toEqual({ content: "done" });
  });

  test("ctx.ask routes to the permission assertion with the host's session and agent", async () => {
    const { deps: d, calls } = deps();
    const tool = adaptToolSpec("sandbox_apply", spec(async (_a, ctx) => {
      await ctx.ask({ permission: "sandbox_apply", patterns: ["*"], always: [], metadata: { summary: "s" } });
      return "applied";
    }), d);
    await tool.execute({}, toolCtx);
    expect(calls.assert).toEqual([{ action: "sandbox_apply", resources: ["*"], metadata: { summary: "s" }, sessionID: SESSION, agent: "pm-odd" }]);
  });

  test("a denied approval stops the handler's work: the rejection propagates and nothing is returned", async () => {
    let afterAsk = false;
    const { deps: d } = deps({ assertPermission: async () => { throw new Error("permission.rejected"); } });
    const tool = adaptToolSpec("sandbox_apply", spec(async (_a, ctx) => {
      await ctx.ask({ permission: "sandbox_apply" });
      afterAsk = true;
      return "applied";
    }), d);
    await expect(tool.execute({}, toolCtx)).rejects.toThrow(/permission\.rejected/);
    expect(afterAsk).toBe(false);
  });

  test("a failing bind does not block the tool (the broker then fails host mutations closed)", async () => {
    const { deps: d } = deps({ bindSessionAgent: async () => { throw new Error("broker down"); } });
    const tool = adaptToolSpec("t", spec(async () => "still ran"), d);
    expect(await tool.execute({}, toolCtx)).toEqual({ content: "still ran" });
  });

  test("an unknown directory is passed as undefined, not guessed", async () => {
    const { deps: d, calls } = deps({ sessionDirectory: async () => undefined });
    const tool = adaptToolSpec("t", spec(async (_a, ctx) => { calls.executed.push({ args: {}, ctx }); return ""; }), d);
    await tool.execute({}, toolCtx);
    expect(calls.executed[0]!.ctx.directory).toBeUndefined();
  });

  test("a handler error surfaces unchanged", async () => {
    const { deps: d } = deps();
    const tool = adaptToolSpec("t", spec(async () => { throw new Error("broker said no"); }), d);
    await expect(tool.execute({}, toolCtx)).rejects.toThrow("broker said no");
  });
});
