import { expect, mock, test } from "bun:test";
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
async function runIsolatedReviewToolProbe(): Promise<{ pipelineCalls: number; persistCalls: number; pipelineAsks: number }> {
  const source = `
    import { mock } from "bun:test";
    const schema = new Proxy({}, { get: () => () => schema });
    mock.module("@opencode-ai/plugin", () => ({ tool: (definition) => definition }));
    mock.module("zod", () => ({ z: new Proxy({}, { get: () => () => schema }) }));
    let pipelineCalls = 0;
    let persistCalls = 0;
    mock.module("./opencode/plugins/lib/broker-client.ts", () => ({
      createBrokerClient: async () => ({
        request: async (operation) => {
          if (operation === "reviewPipelineRun") pipelineCalls += 1;
          if (operation === "reviewPersist") persistCalls += 1;
          return { outcome: "ok" };
        },
        close: () => {},
      }),
      brokerSocketPath: () => "/tmp/unreachable-test.sock",
    }));
    const { default: plugin } = await import("./opencode/plugins/sandbox-tools.ts");
    let pipelineAsks = 0;
    await plugin().tool.host_review_pipeline_run.execute({ phase: "prepare", stdin: "{}", runId: "0123456789abcdef0123456789abcdef" }, {
      sessionID: "session-1", directory: "/work/project", agent: "gentle-orchestrator", ask: async () => { pipelineAsks += 1; },
    });
    try {
      await plugin().tool.host_review_persist.execute({ runId: "0123456789abcdef0123456789abcdef", finalizeRef: "phase-finalize.json" }, {
        sessionID: "session-1", directory: "/work/project", agent: "gentle-orchestrator", ask: async () => { throw new Error("denied"); },
      });
    } catch (error) { if (error.message !== "denied") throw error; }
    console.log(JSON.stringify({ pipelineCalls, persistCalls, pipelineAsks }));
  `;
  const child = Bun.spawn(["bun", "-e", source], { cwd: "..", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`isolated plugin probe failed: ${stderr}`);
  return JSON.parse(stdout.trim().split("\\n").at(-1)!);
}
const { applyTargetedEdit } = await import("../../opencode/plugins/lib/sandbox-edit-core.ts");

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

test("review pipeline and persist tools expose only their allowed schema keys", async () => {
  const { default: plugin } = await import("../../opencode/plugins/sandbox-tools.ts");
  const tools = plugin().tool as Record<string, { args: Record<string, unknown>; execute: (args: any, ctx: any) => Promise<string> }>;
  const pipeline = tools.host_review_pipeline_run;
  const persist = tools.host_review_persist;
  expect(pipeline).toBeDefined();
  expect(persist).toBeDefined();
  expect(Object.keys(pipeline.args).sort()).toEqual(["inputRef", "phase", "reviewer", "runId", "stdin"]);
  expect(Object.keys(persist.args).sort()).toEqual(["finalizeRef", "mode", "runId"]);
  const acceptsKeys = (shape: Record<string, unknown>, keys: string[]) =>
    keys.every((key) => Object.hasOwn(shape, key)) && Object.keys(shape).every((key) => keys.includes(key));
  expect(acceptsKeys(pipeline.args, ["phase", "reviewer", "stdin", "inputRef", "runId"])).toBe(true);
  expect(acceptsKeys(persist.args, ["runId", "finalizeRef", "mode"])).toBe(true);
  for (const args of [pipeline.args, persist.args]) {
    expect(acceptsKeys(args, [...Object.keys(args), "unknown"])).toBe(false);
    expect(acceptsKeys(args, [...Object.keys(args), "projectDir"])).toBe(false);
  }
});

test("review tools have matching permission and timeout entries", () => {
  expect(permissionFragment).toContain('"host_review_pipeline_run": "allow"');
  expect(permissionFragment).toContain('"host_review_persist": "ask"');
  expect(brokerClientSource).toContain("reviewPipelineRun: 60_000,");
  expect(brokerClientSource).toContain("reviewPersist: 60_000,");
});

test("pipeline is not ask-gated and denied persist dispatches zero requests", async () => {
  const result = await runIsolatedReviewToolProbe();
  expect(result.pipelineAsks).toBe(0);
  expect(result.pipelineCalls).toBe(1);
  expect(result.persistCalls).toBe(0);
});

test("sandbox_apply_patch gives an actionable remedy for invalid unified diffs", () => {
  expect(service).toContain("include at least one unchanged context line");
  expect(service).toContain("end-of-file append-only hunk is valid");
  expect(sandboxTools).toContain("EOF append-only hunks may");
  expect(sandboxTools).toContain("sandbox_apply_patch failed:");
});
