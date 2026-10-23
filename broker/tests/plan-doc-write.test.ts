import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { buildPlanDocWriteOp } from "../src/service.ts";
import { ValidationError } from "../src/validation.ts";
import type { BrokerRequestEnvelope, SessionRecord } from "../src/types.ts";

const ORCHESTRATOR = "gentle-orchestrator";

function makeContext(root: string, overrides: Record<string, unknown> = {}) {
  const config = defaultConfig({
    projects: [{ id: "write-test", path: root }],
    readOnlyAgents: [ORCHESTRATOR],
    ...overrides,
  });
  const record: SessionRecord = {
    sessionID: "session-write",
    state: "HOST_READ_ONLY",
    agent: ORCHESTRATOR,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  return {
    config,
    store: { get: () => record },
    adapter: {}, budget: {}, resources: {}, pool: {}, hostRead: { has: () => false },
    logger: {}, git: { runnerMode: "planned", spawn: async () => ({ status: 0, stdout: "", stderr: "", timedOut: false }) },
  } as never;
}

function request(root: string, payload: Record<string, unknown>, agent = "planner"): BrokerRequestEnvelope {
  return {
    version: 1, id: "write", operation: "planDocWrite", sessionID: "session-write", agent,
    payload: { projectDir: root, target: "tasks", name: "phase-two", content: "# Phase two", expectedRevision: 0, note: "initial", agent, ...payload },
  } as BrokerRequestEnvelope;
}

function withProject(run: (root: string) => Promise<void>) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-doc-write-"));
    try { await run(root); } finally { rmSync(root, { recursive: true, force: true }); }
  };
}

async function write(root: string, payload: Record<string, unknown>, agent?: string) {
  return buildPlanDocWriteOp(makeContext(root))(request(root, payload, agent));
}

const rejectsValidation = async (promise: Promise<unknown>, expected: RegExp) => {
  await expect(promise).rejects.toBeInstanceOf(ValidationError);
  await expect(promise).rejects.toThrow(expected);
};

describe("host plan document write", () => {
  test("configures the default task and mini writer allowlists", () => {
    const config = defaultConfig();
    expect(config.planWriterAgents).toEqual(["planner"]);
    expect(config.planMiniWriterAgents).toEqual(["pm-odd", "pm-systematic"]);
  });

  test("creates the first revision atomically", withProject(async (root) => {
    const result = await write(root, {});
    expect(result).toMatchObject({ target: "tasks", path: "odd/tasks/phase-two.md", revision: 1, created: true });
    const text = readFileSync(join(root, "odd/tasks/phase-two.md"), "utf8");
    expect(text).toMatch(/# Phase two\n\n## Revisions\n- r1 \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ planner: initial\n$/);
    expect(readdirSync(join(root, "odd/tasks"))).toEqual(["phase-two.md"]);
  }));

  test("appends a second revision without changing the first line", withProject(async (root) => {
    await write(root, {});
    const first = readFileSync(join(root, "odd/tasks/phase-two.md"), "utf8").split("\n").at(-2);
    const result = await write(root, { content: "# Replaced body", expectedRevision: 1, note: "second" });
    const text = readFileSync(join(root, "odd/tasks/phase-two.md"), "utf8");
    expect(result).toMatchObject({ revision: 2, created: false });
    expect(text.indexOf(first!)).toBeLessThan(text.indexOf("planner: second"));
    expect(text).toContain(`${first}\n- r2 `);
  }));

  test("refuses stale revisions with both values", withProject(async (root) => {
    await write(root, {});
    await rejectsValidation(write(root, { expectedRevision: 0 }), /current.*1.*expected.*0/i);
  }));

  test.each(["../x", "a/b", ".", "..", "a..b", ""]) (
    "refuses unsafe name %j",
    (name) => withProject(async (root) => {
      await rejectsValidation(write(root, { name }), /name/i);
    })(),
  );

  test("refuses content over 256 KiB and reports observed bytes", withProject(async (root) => {
    await rejectsValidation(write(root, { content: "x".repeat(262145) }), /262144.*262145|262145.*262144/);
  }));

  test("refuses newline in note", withProject(async (root) => {
    await rejectsValidation(write(root, { note: "first\nsecond" }), /note.*newline/i);
  }));

  test("uses target-specific agent allowlists", withProject(async (root) => {
    await rejectsValidation(write(root, {}, "not-allowed"), /tasks.*allowed/i);
    await rejectsValidation(write(root, { target: "mini", name: "mini-plan" }, "not-allowed"), /mini.*allowed/i);
    await write(root, { target: "mini", name: "mini-plan" }, "pm-odd");
    await rejectsValidation(write(root, { target: "tasks", name: "task-plan" }, "pm-odd"), /tasks.*allowed/i);
  }));

  test("refuses a symlinked destination", withProject(async (root) => {
    mkdirSync(join(root, "odd/tasks"), { recursive: true });
    const outside = join(root, "outside.md");
    await Bun.write(outside, "outside");
    symlinkSync(outside, join(root, "odd/tasks/phase-two.md"));
    await rejectsValidation(write(root, {}), /symlink.*phase-two|phase-two.*symlink/i);
  }));

  test("refuses a symlinked parent directory by naming the path", withProject(async (root) => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(root, "odd"));
    await rejectsValidation(write(root, {}), /symlink.*odd|odd.*symlink/i);
  }));

  test("removes the sibling temp after a forced atomic rename failure", withProject(async (root) => {
    const source = `import { mock } from "bun:test"; const fs = await import("node:fs"); mock.module("node:fs", () => ({ ...fs, renameSync: () => { throw new Error("forced rename failure"); } })); const { defaultConfig } = await import("./src/config.ts"); const { buildPlanDocWriteOp } = await import("./src/service.ts"); const { join } = await import("node:path"); const root = ${JSON.stringify(root)}; const config = defaultConfig({ projects: [{ id: "test", path: root }], readOnlyAgents: ["gentle-orchestrator"] }); const record = { sessionID: "s", state: "HOST_READ_ONLY", agent: "gentle-orchestrator", createdAt: "now", updatedAt: "now" }; const handler = buildPlanDocWriteOp({ config, store: { get: () => record } }); let failed = false; try { await handler({ version: 1, id: "x", operation: "planDocWrite", sessionID: "s", payload: { projectDir: root, target: "tasks", name: "failed", content: "x", expectedRevision: 0, note: "n", agent: "planner" } }); } catch { failed = true; } const names = fs.readdirSync(join(root, "odd/tasks")); if (!failed || names.some((name) => name.startsWith(".plan-doc-"))) process.exit(1);`;
    const child = Bun.spawn(["bun", "-e", source], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(exitCode, stderr).toBe(0);
  }));

  test("removes temporary files after a successful write and a failed write", withProject(async (root) => {
    const directory = join(root, "odd/tasks");
    await write(root, {});
    expect(readdirSync(directory).some((entry) => entry.startsWith(".plan-doc-"))).toBe(false);
    await rejectsValidation(write(root, { expectedRevision: 0 }), /current/i);
    expect(readdirSync(directory).some((entry) => entry.startsWith(".plan-doc-"))).toBe(false);
  }));

  test("rejects invalid target, content, note, and revision values", withProject(async (root) => {
    await rejectsValidation(write(root, { target: "other" }), /target/i);
    await rejectsValidation(write(root, { content: "" }), /content/i);
    await rejectsValidation(write(root, { content: 42 }), /content/i);
    await rejectsValidation(write(root, { note: "  " }), /note/i);
    await rejectsValidation(write(root, { note: "n".repeat(201) }), /note.*200/i);
    await rejectsValidation(write(root, { expectedRevision: -1 }), /expectedRevision/i);
    await rejectsValidation(write(root, { expectedRevision: 1.2 }), /expectedRevision/i);
  }));

  test("returns the UTF-8 byte count", withProject(async (root) => {
    const result = await write(root, { content: "é\n" });
    const text = readFileSync(join(root, "odd/tasks/phase-two.md"), "utf8");
    expect(text.startsWith("é\n\n\n## Revisions\n")).toBe(true);
    expect(result).toHaveProperty("bytes", Buffer.byteLength(text));
  }));
});
