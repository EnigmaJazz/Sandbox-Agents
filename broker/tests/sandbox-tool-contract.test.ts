import { afterAll, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
const schema = new Proxy({}, {
  get: () => () => schema,
});
mock.module("@opencode-ai/plugin", () => ({ tool: (definition: unknown) => definition }));
mock.module("zod", () => ({
  z: new Proxy({}, {
    get: () => () => schema,
  }),
}));

afterAll(() => mock.restore());
async function runIsolatedReviewToolProbe(): Promise<{ requests: unknown[]; outputs: string[]; pipelineAsks: number; persistMode: string; persistAskSummary: string }> {
  const source = `
    import { mock } from "bun:test";
    const schema = new Proxy({}, { get: () => () => schema });
    mock.module("@opencode-ai/plugin", () => ({ tool: (definition) => definition }));
    mock.module("zod", () => ({ z: new Proxy({}, { get: () => () => schema }) }));
    const requests = [];
    const failures = [];
    let persistAskSummary = "";
    let failure;
    mock.module("./opencode/plugins/lib/broker-client.ts", () => ({
      createBrokerClient: async () => ({
        request: async (operation, sessionID, payload, agent) => {
          if (failure) throw failure;
          requests.push({ operation, sessionID, payload, agent });
          if (operation === "reviewPersistPreflight") return {
            runId: payload.runId, projectDir: payload.projectDir, baseObjectId: "base", headObjectId: "head",
            changedPaths: 2, totalBytes: 100,
            finalize: { name: payload.finalizeRef, bytes: 100, sha256: "digest-123" },
            finalizeInput: "stdin", kind: "writing", verdict: "pass", verdictSource: "verdict",
            counts: { finding_count: 1 }, blockers: [],
          };
          return { operation, accepted: true };
        },
        close: () => {},
      }),
      brokerSocketPath: () => "/tmp/unreachable-test.sock",
    }));
    const { default: plugin } = await import("./opencode/plugins/sandbox-tools.ts");
    const tools = plugin().tool;
    let pipelineAsks = 0;
    const pipelineOutput = await tools.host_review_pipeline_run.execute({ phase: "prepare", stdin: "{}", runId: "0123456789abcdef0123456789abcdef" }, {
      sessionID: "session-1", directory: "/work/project", agent: "gentle-orchestrator", ask: async () => { pipelineAsks += 1; },
    });
    const persistOutput = await tools.host_review_persist.execute({ runId: "0123456789abcdef0123456789abcdef", finalizeRef: "phase-finalize.json", mode: "report_only" }, {
      sessionID: "session-1", directory: "/work/project", agent: "gentle-orchestrator", ask: async (ask) => { persistAskSummary = ask.metadata.summary; },
    });
    for (const [name, tool, args] of [
      ["host_review_pipeline_run", tools.host_review_pipeline_run, { phase: "prepare", stdin: "{}", runId: "0123456789abcdef0123456789abcdef" }],
      ["host_review_persist", tools.host_review_persist, { runId: "0123456789abcdef0123456789abcdef", finalizeRef: "phase-finalize.json" }],
    ]) {
      for (const coded of [true, false]) {
        failure = new Error("broker detail");
        if (coded) failure.code = "review_test_code";
        try {
          await tool.execute(args, { sessionID: "session-1", directory: "/work/project", agent: "gentle-orchestrator", ask: async () => {} });
        } catch (error) { failures.push({ name, coded, message: error.message }); }
        failure = undefined;
      }
    }
    console.log(JSON.stringify({ requests, outputs: [pipelineOutput, persistOutput], failures, pipelineAsks, persistMode: requests[2].payload.mode, persistAskSummary }));
  `;
  const child = Bun.spawn(["bun", "-e", source], { cwd: `${import.meta.dir}/../..`, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`isolated plugin probe failed: ${stderr}`);
  return JSON.parse(stdout.trim());
}
const { applyTargetedEdit } = await import("../../opencode/plugins/lib/sandbox-edit-core.ts");

async function runIsolatedPlanWriteProbe(): Promise<{ calls: unknown[]; asks: number }> {
  const source = `
    import { mock } from "bun:test";
    const schema = new Proxy({}, { get: () => () => schema });
    mock.module("@opencode-ai/plugin", () => ({ tool: (definition) => definition }));
    mock.module("zod", () => ({ z: new Proxy({}, { get: () => () => schema }) }));
    const calls = [];
    mock.module("./opencode/plugins/lib/broker-client.ts", () => ({
      createBrokerClient: async () => ({
        request: async (operation, sessionID, payload, agent) => {
          calls.push({ operation, sessionID, payload, agent });
          return { target: payload.target, revision: 1 };
        },
        close: () => {},
      }),
      brokerSocketPath: () => "/tmp/unreachable-test.sock",
    }));
    const { default: plugin } = await import("./opencode/plugins/sandbox-tools.ts");
    let asks = 0;
    const result = await plugin().tool.host_plan_write.execute({
      target: "tasks", name: "phase-two", content: "# Plan", expectedRevision: 0, note: "initial",
    }, {
      sessionID: "session-write", directory: "/work/project", agent: "planner",
      ask: async () => { asks += 1; throw new Error("approval must not be requested"); },
    });
    console.log(JSON.stringify({ calls, asks, result }));
  `;
  const child = Bun.spawn(["bun", "-e", source], { cwd: `${import.meta.dir}/../..`, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`isolated plan write probe failed: ${stderr}`);
  return JSON.parse(stdout.trim());
}

async function runIsolatedGateVerdictProbe(): Promise<{ calls: unknown[]; asks: number }> {
  const source = `
    import { mock } from "bun:test";
    const schema = new Proxy({}, { get: () => () => schema });
    mock.module("@opencode-ai/plugin", () => ({ tool: (definition) => definition }));
    mock.module("zod", () => ({ z: new Proxy({}, { get: () => () => schema }) }));
    const calls = [];
    mock.module("./opencode/plugins/lib/broker-client.ts", () => ({
      createBrokerClient: async () => ({
        request: async (operation, sessionID, payload, agent) => {
          calls.push({ operation, sessionID, payload, agent });
          return { name: payload.name, taskId: payload.taskId, verdict: payload.verdict, gates: 1 };
        },
        close: () => {},
      }),
      brokerSocketPath: () => "/tmp/unreachable-test.sock",
    }));
    const { default: plugin } = await import("./opencode/plugins/sandbox-tools.ts");
    let asks = 0;
    const result = await plugin().tool.host_gate_verdict.execute({
      name: "phase-two", taskId: "unit-b", verdict: "PASS",
    }, {
      sessionID: "session-gate", directory: "/work/project", agent: "planner",
      ask: async () => { asks += 1; throw new Error("approval must not be requested"); },
    });
    console.log(JSON.stringify({ calls, asks, result }));
  `;
  const child = Bun.spawn(["bun", "-e", source], { cwd: `${import.meta.dir}/../..`, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`isolated gate verdict probe failed: ${stderr}`);
  return JSON.parse(stdout.trim());
}

async function runIsolatedTaskMarkProbe(): Promise<{ calls: unknown[]; asks: number }> {
  const source = `
    import { mock } from "bun:test";
    const schema = new Proxy({}, { get: () => () => schema });
    mock.module("@opencode-ai/plugin", () => ({ tool: (definition) => definition }));
    mock.module("zod", () => ({ z: new Proxy({}, { get: () => () => schema }) }));
    const calls = [];
    mock.module("./opencode/plugins/lib/broker-client.ts", () => ({
      createBrokerClient: async () => ({
        request: async (operation, sessionID, payload, agent) => {
          calls.push({ operation, sessionID, payload, agent });
          return { target: payload.target, name: payload.name, taskId: payload.taskId, status: payload.status, tier: "medium" };
        },
        close: () => {},
      }),
      brokerSocketPath: () => "/tmp/unreachable-test.sock",
    }));
    const { default: plugin } = await import("./opencode/plugins/sandbox-tools.ts");
    let asks = 0;
    const result = await plugin().tool.host_task_mark.execute({
      target: "tasks", name: "phase-two", taskId: "T12", status: "passed", evidenceCommit: "a".repeat(40),
      gateRef: "sha256:" + "b".repeat(64), evidenceBaseRef: "c".repeat(40), note: "verified",
    }, {
      sessionID: "session-task-mark", directory: "/work/project", agent: "pm-odd",
      ask: async () => { asks += 1; throw new Error("approval must not be requested"); },
    });
    console.log(JSON.stringify({ calls, asks, result }));
  `;
  const child = Bun.spawn(["bun", "-e", source], { cwd: `${import.meta.dir}/../..`, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`isolated task mark probe failed: ${stderr}`);
  return JSON.parse(stdout.trim());
}

async function runIsolatedTaskMarkSchemaProbe(): Promise<{
  calls: unknown[];
  callsAfterValid: number;
  callsAfterMalformed: number;
  malformedError: string | null;
  gateAcceptsValid: boolean;
  gateRejectsMalformed: boolean;
}> {
  const source = `
    import { mock } from "bun:test";
    const schemaFor = (kind, state = { optional: false }) => {
      const schema = new Proxy(function () {}, {
        get(_target, prop) {
          if (prop === "__optional") return state.optional;
          if (prop === "optional") return () => { state.optional = true; return schema; };
          if (prop === "regex") return (pattern) => { state.regex = pattern; return schema; };
          if (prop === "length") return (length) => { state.length = length; return schema; };
          if (prop === "min") return (min) => { state.min = min; return schema; };
          if (prop === "max") return (max) => { state.max = max; return schema; };
          if (prop === "parse") return (value) => {
            if (kind === "string" && typeof value !== "string") throw new Error("expected string");
            if (typeof state.length === "number" && value.length !== state.length) throw new Error("unexpected length");
            if (state.regex instanceof RegExp && !state.regex.test(value)) throw new Error("pattern mismatch");
            return value;
          };
          if (prop === "safeParse") return (value) => {
            try { schema.parse(value); return { success: true, data: value }; }
            catch (error) { return { success: false, error }; }
          };
          return () => schema;
        },
      });
      return schema;
    };
    const z = new Proxy({}, { get: (_target, kind) => () => schemaFor(kind) });
    mock.module("zod", () => ({ z }));
    mock.module("@opencode-ai/plugin", () => ({
      tool: (definition) => ({
        ...definition,
        execute: async (args, ctx) => {
          for (const [name, schema] of Object.entries(definition.args)) {
            const value = args[name];
            if (value === undefined) {
              if (schema.__optional !== true) throw new Error("missing required argument: " + name);
              continue;
            }
            schema.parse(value);
          }
          return definition.execute(args, ctx);
        },
      }),
    }));
    const calls = [];
    mock.module("./opencode/plugins/lib/broker-client.ts", () => ({
      createBrokerClient: async () => ({
        request: async (operation, sessionID, payload, agent) => {
          calls.push({ operation, sessionID, payload, agent });
          return { target: payload.target, name: payload.name, taskId: payload.taskId, status: payload.status, tier: "medium" };
        },
        close: () => {},
      }),
      brokerSocketPath: () => "/tmp/unreachable-test.sock",
    }));
    const { default: plugin } = await import("./opencode/plugins/sandbox-tools.ts");
    const tool = plugin().tool.host_task_mark;
    const ctx = {
      sessionID: "session-task-mark-schema", directory: "/work/project", agent: "pm-odd",
      ask: async () => { throw new Error("approval must not be requested"); },
    };
    const gateRef = "sha256:" + "b".repeat(64);
    const baseArgs = { target: "tasks", name: "phase-two", taskId: "T12", status: "passed", evidenceCommit: "a".repeat(40) };
    const validResult = await tool.execute({ ...baseArgs, gateRef, evidenceBaseRef: "c".repeat(40) }, ctx);
    const callsAfterValid = calls.length;
    let malformedError = null;
    try {
      await tool.execute({ ...baseArgs, gateRef: "gate-abc" }, ctx);
    } catch (error) {
      malformedError = error instanceof Error ? error.message : String(error);
    }
    const callsAfterMalformed = calls.length;
    console.log(JSON.stringify({
      calls, validResult, callsAfterValid, callsAfterMalformed, malformedError,
      gateAcceptsValid: tool.args.gateRef.safeParse(gateRef).success === true,
      gateRejectsMalformed: tool.args.gateRef.safeParse("gate-abc").success === false,
    }));
  `;
  const child = Bun.spawn(["bun", "-e", source], { cwd: `${import.meta.dir}/../..`, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`isolated task mark schema probe failed: ${stderr}`);
  return JSON.parse(stdout.trim());
}

async function runIsolatedTaskMarkTaskIdSchemaProbe(): Promise<{
  acceptsLong: boolean;
  rejectsLeadingDash: boolean;
  rejectsEmpty: boolean;
  callsAfterLong: number;
  callsAfterRejections: number;
  longTaskIdPayload: Record<string, unknown> | null;
}> {
  const source = `
    import { mock } from "bun:test";
    const schemaFor = (kind) => {
      const state = {};
      const schema = new Proxy(function () {}, {
        get(_target, prop) {
          if (prop === "optional") return () => schema;
          if (prop === "regex") return (pattern) => { state.regex = pattern; return schema; };
          if (prop === "length") return (length) => { state.length = length; return schema; };
          if (prop === "min") return (min) => { state.min = min; return schema; };
          if (prop === "max") return (max) => { state.max = max; return schema; };
          if (prop === "parse") return (value) => {
            if (kind === "string" && typeof value !== "string") throw new Error("expected string");
            if (typeof state.length === "number" && value.length !== state.length) throw new Error("unexpected length");
            if (typeof state.min === "number" && value.length < state.min) throw new Error("too short");
            if (typeof state.max === "number" && value.length > state.max) throw new Error("too long");
            if (state.regex instanceof RegExp && !state.regex.test(value)) throw new Error("pattern mismatch");
            return value;
          };
          if (prop === "safeParse") return (value) => {
            try { schema.parse(value); return { success: true, data: value }; }
            catch (error) { return { success: false, error }; }
          };
          return () => schema;
        },
      });
      return schema;
    };
    const z = new Proxy({}, { get: (_target, kind) => () => schemaFor(kind) });
    mock.module("zod", () => ({ z }));
    mock.module("@opencode-ai/plugin", () => ({
      tool: (definition) => ({
        ...definition,
        execute: async (args, ctx) => {
          for (const [name, schema] of Object.entries(definition.args)) {
            const value = args[name];
            if (value === undefined) continue;
            schema.parse(value);
          }
          return definition.execute(args, ctx);
        },
      }),
    }));
    const calls = [];
    mock.module("./opencode/plugins/lib/broker-client.ts", () => ({
      createBrokerClient: async () => ({
        request: async (operation, sessionID, payload, agent) => {
          calls.push({ operation, sessionID, payload, agent });
          return { target: payload.target, name: payload.name, taskId: payload.taskId, status: payload.status, tier: "medium" };
        },
        close: () => {},
      }),
      brokerSocketPath: () => "/tmp/unreachable-test.sock",
    }));
    const { default: plugin } = await import("./opencode/plugins/sandbox-tools.ts");
    const tool = plugin().tool.host_task_mark;
    const ctx = {
      sessionID: "session-task-id-schema", directory: "/work/project", agent: "pm-odd",
      ask: async () => { throw new Error("approval must not be requested"); },
    };
    const gateRef = "sha256:" + "b".repeat(64);
    const longTaskId = "ST1-implementation-task";
    const baseArgs = { target: "tasks", name: "phase-two", status: "passed", evidenceCommit: "a".repeat(40), gateRef };
    await tool.execute({ ...baseArgs, taskId: longTaskId }, ctx);
    const callsAfterLong = calls.length;
    for (const taskId of ["-bad", ""]) {
      try { await tool.execute({ ...baseArgs, taskId }, ctx); } catch {}
    }
    const callsAfterRejections = calls.length;
    console.log(JSON.stringify({
      acceptsLong: tool.args.taskId.safeParse(longTaskId).success === true,
      rejectsLeadingDash: tool.args.taskId.safeParse("-bad").success === false,
      rejectsEmpty: tool.args.taskId.safeParse("").success === false,
      callsAfterLong,
      callsAfterRejections,
      longTaskIdPayload: callsAfterLong > 0 ? calls[0].payload : null,
    }));
  `;
  const child = Bun.spawn(["bun", "-e", source], { cwd: `${import.meta.dir}/../..`, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`isolated task id schema probe failed: ${stderr}`);
  return JSON.parse(stdout.trim());
}

const sandboxTools = readFileSync(
  new URL("../../opencode/plugins/sandbox-tools.ts", import.meta.url),
  "utf8",
);
const service = readFileSync(new URL("../src/service.ts", import.meta.url), "utf8");
const brokerClientSource = readFileSync(new URL("../../opencode/plugins/lib/broker-client.ts", import.meta.url), "utf8");
const permissionFragment = readFileSync(new URL("../../opencode/config-fragments/sandbox-permissions.jsonc", import.meta.url), "utf8");

function refusalReason(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  }
  throw new Error("Expected targeted edit to be refused");
}

test("plugin wrappers export only their plugin function(s) and default", async () => {
  const wrappers = [
    {
      path: "sandbox-tools.ts",
      module: await import("../../opencode/plugins/sandbox-tools.ts"),
      allowed: ["default"],
    },
    {
      path: "routing-guard.ts",
      module: await import("../../opencode/plugins/routing-guard.ts"),
      allowed: ["default"],
    },
    {
      path: "reviewer-relay-transport.ts",
      module: await import("../../opencode/plugins/reviewer-relay-transport.ts"),
      allowed: ["ReviewerRelayTransportPlugin", "default"],
    },
  ];

  for (const wrapper of wrappers) {
    const exportedNames = Object.keys(wrapper.module);
    for (const name of exportedNames) {
      expect(
        wrapper.allowed,
        `${wrapper.path} has unexpected plugin export: ${name}`,
      ).toContain(name);
    }
    for (const name of wrapper.allowed) {
      expect(exportedNames, `${wrapper.path} is missing plugin export: ${name}`).toContain(name);
    }
  }
});

test("sandbox_edit replaces one unique match in place", () => {
  expect(applyTargetedEdit("const value = 1;\n", "1", "2")).toBe("const value = 2;\n");
});

test("sandbox_edit refuses zero matches with a named reason", () => {
  expect(refusalReason(() => applyTargetedEdit("alpha", "missing", "beta"))).toBe(
    "sandbox_edit: oldString was not found",
  );
});

test("sandbox_edit refuses multiple matches unless replaceAll is true", () => {
  expect(refusalReason(() => applyTargetedEdit("a a", "a", "b"))).toBe(
    "sandbox_edit: oldString matched multiple times; set replaceAll to true to replace all",
  );
});

test("sandbox_edit replaces all matches when replaceAll is true", () => {
  expect(applyTargetedEdit("a a a", "a", "b", true)).toBe("b b b");
});

test("sandbox_edit refuses an empty oldString with a named reason", () => {
  expect(refusalReason(() => applyTargetedEdit("content", "", "replacement"))).toBe(
    "sandbox_edit: oldString must not be empty",
  );
});

test("sandbox_edit refuses edits that would blank the file with a named reason", () => {
  expect(refusalReason(() => applyTargetedEdit("only content", "only content", ""))).toBe(
    "sandbox_edit: edit would leave the file empty",
  );
});

test("sandbox_edit changes a small region of a large file without retranscribing it", () => {
  const prefix = "unchanged-before\n".repeat(100_000);
  const suffix = "unchanged-after\n".repeat(100_000);
  const result = applyTargetedEdit(`${prefix}target${suffix}`, "target", "updated");
  expect(result).toBe(`${prefix}updated${suffix}`);
  expect(result.length).toBeGreaterThan(2_000_000);
});

test("sandbox_edit and sandbox_write descriptions distinguish targeted and whole-file edits", () => {
  expect(sandboxTools).toContain("replacing only the specified text");
  expect(sandboxTools).toContain("whole-file replacement, use sandbox_write");
  expect(sandboxTools).toContain("replace the entire file contents");
  expect(sandboxTools).toContain("sandbox_edit for targeted text changes");
});

test("host_review_materialize exposes only a bounded index and preserves broker errors", () => {
  expect(sandboxTools).toContain("host_review_materialize: tool({");
  expect(sandboxTools).toContain('c.request("reviewMaterialize", ctx.sessionID, payload, ctx.agent)');
  expect(sandboxTools).toContain("materializes a git range into the broker-owned run store");
  expect(sandboxTools).toContain("returns only a bounded index");
  expect(sandboxTools).toContain("reviewers are expected");
  expect(sandboxTools).toContain("fetch slices separately");
  expect(sandboxTools).toContain("host_review_materialize failed");
  expect(sandboxTools).toContain("typeof code === \"string\"");
});

test("pipeline reviewer enum accepts ce:review personas and rejects native 4R lens names", () => {
  const reviewerEnum = /reviewer:\s*z\.enum\((\[[^\]]+\])\)\.optional\(\)/.exec(sandboxTools)?.[1];
  expect(reviewerEnum).toBeDefined();
  const reviewers = JSON.parse(reviewerEnum!) as string[];
  expect(reviewers).toEqual([
    "correctness", "testing", "project-standards", "maintainability", "security", "performance",
    "api-contract", "data-migrations", "reliability", "adversarial", "cli-readiness", "previous-comments",
    "kieran-typescript",
  ]);
  expect(reviewers.includes("correctness")).toBe(true);
  expect(reviewers.includes("review-risk")).toBe(false);
});

test("review pipeline and persist tools expose only their allowed schema keys", async () => {
  const { default: plugin } = await import("../../opencode/plugins/sandbox-tools.ts");
  const tools = plugin().tool as Record<string, { args: Record<string, unknown>; execute: (args: any, ctx: any) => Promise<string> }>;
  const pipeline = tools.host_review_pipeline_run;
  const persist = tools.host_review_persist;
  expect(pipeline).toBeDefined();
  expect(persist).toBeDefined();
  expect(Object.keys(pipeline.args).sort()).toEqual(["adjudication", "dispatch_records", "inputRef", "inputRefs", "merge", "mergeRef", "parent_run_metadata", "phase", "plan_assessment", "prepared", "preparedRef", "reviewer", "runId", "screen_results", "selected_dispatches", "stdin", "validator_lifecycle_results"]);
  expect(Object.keys(pipeline.args)).toContain("inputRefs");
  expect(sandboxTools).toMatch(/inputRefs:\s*z\.array\(z\.string\(\)\.min\(1\)\.max\(255\)\)\.max\(16\)\.optional\(\)/);
  expect(Object.keys(persist.args).sort()).toEqual(["finalizeRef", "mode", "runId"]);
  const acceptsKeys = (shape: Record<string, unknown>, keys: string[]) =>
    keys.every((key) => Object.hasOwn(shape, key)) && Object.keys(shape).every((key) => keys.includes(key));
  expect(acceptsKeys(pipeline.args, ["phase", "reviewer", "stdin", "inputRef", "inputRefs", "runId", "adjudication", "preparedRef", "mergeRef", "dispatch_records", "validator_lifecycle_results", "plan_assessment", "parent_run_metadata", "prepared", "merge", "screen_results", "selected_dispatches"])).toBe(true);
  expect(acceptsKeys(persist.args, ["runId", "finalizeRef", "mode"])).toBe(true);
  for (const args of [pipeline.args, persist.args]) {
    expect(acceptsKeys(args, [...Object.keys(args), "unknown"])).toBe(false);
    expect(acceptsKeys(args, [...Object.keys(args), "projectDir"])).toBe(false);
  }
});

test("host_task_mark forwards the broker payload and caller identity without approval", async () => {
  const result = await runIsolatedTaskMarkProbe();
  expect(result.asks).toBe(0);
  expect(result.calls).toHaveLength(1);
  const [call] = result.calls as Array<{ operation: string; sessionID: string; payload: Record<string, unknown>; agent: string }>;
  expect(call.operation).toBe("taskMark");
  expect(call.sessionID).toBe("session-task-mark");
  expect(Object.keys(call.payload).sort()).toEqual([
    "evidenceBaseRef", "evidenceCommit", "gateRef", "name", "note", "projectDir", "status", "target", "taskId",
  ]);
  expect(call.payload).not.toHaveProperty("agent");
  expect(call.payload).toEqual({
    projectDir: "/work/project",
    target: "tasks",
    name: "phase-two",
    taskId: "T12",
    status: "passed",
    evidenceCommit: "a".repeat(40),
    gateRef: "sha256:" + "b".repeat(64),
    evidenceBaseRef: "c".repeat(40),
    note: "verified",
  });
  expect(call.agent).toBe("pm-odd");
});

test("host_task_mark rejects a malformed gateRef at the schema boundary before any request", async () => {
  const result = await runIsolatedTaskMarkSchemaProbe();
  expect(result.gateAcceptsValid).toBe(true);
  expect(result.gateRejectsMalformed).toBe(true);
  expect(result.malformedError).not.toBeNull();
  expect(result.callsAfterValid).toBe(1);
  expect(result.callsAfterMalformed).toBe(1);
  expect(result.calls).toHaveLength(1);
});

test("host_task_mark accepts a long taskId and rejects malformed task ids before any request", async () => {
  const result = await runIsolatedTaskMarkTaskIdSchemaProbe();
  expect(result.acceptsLong).toBe(true);
  expect(result.rejectsLeadingDash).toBe(true);
  expect(result.rejectsEmpty).toBe(true);
  expect(result.callsAfterLong).toBe(1);
  expect(result.callsAfterRejections).toBe(1);
  expect(result.longTaskIdPayload).toEqual({
    projectDir: "/work/project",
    target: "tasks",
    name: "phase-two",
    taskId: "ST1-implementation-task",
    status: "passed",
    evidenceCommit: "a".repeat(40),
    gateRef: "sha256:" + "b".repeat(64),
  });
});

test("task mark has an allow permission entry", () => {
  expect(permissionFragment).toContain('"host_task_mark": "allow"');
});

test("pipeline tool description requires an existing materialized run directory", () => {
  expect(sandboxTools).toContain("runId from a prior host_review_materialize");
  expect(sandboxTools).toContain("run directory must already exist");
});

test("review tools have matching permission and timeout entries", () => {
  expect(permissionFragment).toContain('"host_review_pipeline_run": "allow"');
  expect(permissionFragment).toContain('"host_review_persist": "ask"');
  expect(brokerClientSource).toContain("reviewPipelineRun: 60_000,");
  expect(brokerClientSource).toContain("reviewPersist: 60_000,");
});

test("pipeline is not ask-gated and persist approval receives the caller mode before dispatch", async () => {
  const result = await runIsolatedReviewToolProbe();
  expect(result.pipelineAsks).toBe(0);
  expect(result.requests).toEqual([
    {
      operation: "reviewPipelineRun",
      sessionID: "session-1",
      payload: { projectDir: "/work/project", phase: "prepare", stdin: "{}", runId: "0123456789abcdef0123456789abcdef" },
      agent: "gentle-orchestrator",
    },
    {
      operation: "reviewPersistPreflight",
      sessionID: "session-1",
      payload: { projectDir: "/work/project", runId: "0123456789abcdef0123456789abcdef", finalizeRef: "phase-finalize.json", mode: "report_only" },
      agent: "gentle-orchestrator",
    },
    {
      operation: "reviewPersist",
      sessionID: "session-1",
      payload: { projectDir: "/work/project", runId: "0123456789abcdef0123456789abcdef", finalizeRef: "phase-finalize.json", mode: "report_only" },
      agent: "gentle-orchestrator",
    },
  ]);
  expect(result.outputs).toEqual([
    JSON.stringify({ operation: "reviewPipelineRun", accepted: true }, null, 2),
    JSON.stringify({ operation: "reviewPersist", accepted: true }, null, 2),
  ]);
  expect(result.failures).toEqual([
    { name: "host_review_pipeline_run", coded: true, message: "host_review_pipeline_run failed [review_test_code]: broker detail" },
    { name: "host_review_pipeline_run", coded: false, message: "host_review_pipeline_run failed: broker detail" },
    { name: "host_review_persist", coded: true, message: "host_review_persist failed [review_test_code]: broker detail" },
    { name: "host_review_persist", coded: false, message: "host_review_persist failed: broker detail" },
  ]);
  expect(result.persistMode).toBe("report_only");
  expect(result.persistAskSummary).toContain("sha256 digest-123");
  expect(result.persistAskSummary).toContain("verdict pass");
  expect(result.persistAskSummary).toContain("finalize input inline stdin");
  expect(result.persistAskSummary).toContain("NO project file will be written");
  expect(result.persistAskSummary).toContain("validation is not attempted");
});

test("sandbox_apply_patch gives an actionable remedy for invalid unified diffs", () => {
  expect(service).toContain("include at least one unchanged context line");
  expect(service).toContain("end-of-file append-only hunk is valid");
  expect(sandboxTools).toContain("EOF append-only hunks may");
  expect(sandboxTools).toContain("sandbox_apply_patch failed:");
});

test("host_gate_verdict forwards planner identity without requesting approval", async () => {
  const result = await runIsolatedGateVerdictProbe();
  expect(result.asks).toBe(0);
  expect(result.calls).toEqual([{
    operation: "gateVerdict",
    sessionID: "session-gate",
    payload: { projectDir: "/work/project", name: "phase-two", taskId: "unit-b", verdict: "PASS", agent: "planner" },
    agent: "planner",
  }]);
});

test("host_plan_write forwards ctx.agent without requesting approval", async () => {
  const result = await runIsolatedPlanWriteProbe();
  expect(result.asks).toBe(0);
  expect(result.calls).toEqual([{
    operation: "planDocWrite",
    sessionID: "session-write",
    payload: {
      projectDir: "/work/project", target: "tasks", name: "phase-two", content: "# Plan",
      expectedRevision: 0, note: "initial", agent: "planner",
    },
    agent: "planner",
  }]);
});
