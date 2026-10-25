import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { buildTaskMarkOp } from "../src/service.ts";
import type { BrokerRequestEnvelope, SessionRecord } from "../src/types.ts";

const ORCHESTRATOR = "gentle-orchestrator";

function withProject(run: (root: string, evidenceCommit: string) => Promise<void>) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "task-mark-"));
    try {
      execFileSync("git", ["init", "-q", root]);
      execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
      execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
      writeFileSync(join(root, "seed.txt"), "seed\n");
      execFileSync("git", ["-C", root, "add", "seed.txt"]);
      execFileSync("git", ["-C", root, "commit", "-qm", "seed"]);
      const evidenceCommit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      await run(root, evidenceCommit);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function makeContext(root: string, identity = "pm-odd", assessor: () => Promise<unknown> = async () => ({ status: 0, json: { tier: "medium" } })) {
  const config = defaultConfig({ projects: [{ id: "task-mark-test", path: root }], readOnlyAgents: [ORCHESTRATOR] });
  const record: SessionRecord = {
    sessionID: "session-task-mark",
    state: "HOST_READ_ONLY",
    agent: identity,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  return {
    config,
    store: { get: () => record },
    adapter: {}, budget: {}, resources: {}, pool: {}, hostRead: { has: () => false },
    logger: {},
    git: {
      runnerMode: "planned",
      spawn: async (argv: string[], options: { cwd: string }) => {
        try {
          execFileSync(argv[0]!, argv.slice(1), { cwd: options.cwd, stdio: "ignore" });
          return { status: 0, stdout: "", stderr: "", timedOut: false };
        } catch {
          return { status: 1, stdout: "", stderr: "", timedOut: false };
        }
      },
    },
    reviewAssess: assessor,
  } as never;
}

function request(root: string, evidenceCommit: string, payload: Record<string, unknown> = {}, identity = "pm-odd"): BrokerRequestEnvelope {
  return {
    version: 1, id: "task-mark", operation: "taskMark", sessionID: "session-task-mark", agent: identity,
    payload: { projectDir: root, target: "tasks", name: "phase-five", taskId: "T5", status: "passed", evidenceCommit, note: "done", ...payload },
  } as BrokerRequestEnvelope;
}

function preparePlan(root: string, text = "# Phase five\n\n## Revisions\n- r1 2026-01-01T00:00:00Z pm-odd: initial\n") {
  const path = join(root, "odd", "tasks", "phase-five.md");
  mkdirSync(join(root, "odd", "tasks"), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function runMark(root: string, evidenceCommit: string, payload: Record<string, unknown> = {}, identity = "pm-odd", assessor?: () => Promise<unknown>) {
  return buildTaskMarkOp(makeContext(root, identity, assessor))(request(root, evidenceCommit, payload, identity));
}

describe("taskMark", () => {
  test("appends one tick, derives tier, bumps revision, and sanitizes the note", withProject(async (root, commit) => {
    const path = preparePlan(root);
    await expect(runMark(root, commit, { note: "finished\nunsafe\u0001 text" })).resolves.toMatchObject({ revision: 2, tier: "medium" });
    const text = readFileSync(path, "utf8");
    expect(text).toContain(`T5 passed evidence=${commit} tier=medium `);
    expect(text).toContain("pm-odd: finished unsafe  text");
    expect(text).toContain("## Ticks");
    expect(text).toContain("- r2 ");
  }));

  test("assessor failure records high tier", withProject(async (root, commit) => {
    const path = preparePlan(root);
    await expect(runMark(root, commit, {}, "pm-odd", async () => { throw new Error("assessment failed"); })).resolves.toMatchObject({ tier: "high" });
    expect(readFileSync(path, "utf8")).toContain(`evidence=${commit} tier=high `);
  }));

  test("missing assessor or unparsable assessor output fails closed to high", withProject(async (root, commit) => {
    const path = preparePlan(root);
    const context = makeContext(root) as { reviewAssess?: unknown };
    delete context.reviewAssess;
    await buildTaskMarkOp(context as never)(request(root, commit));
    expect(readFileSync(path, "utf8")).toContain(`evidence=${commit} tier=high `);
    writeFileSync(path, "# Phase five\n");
    await expect(runMark(root, commit, {}, "pm-odd", async () => ({ status: 0, json: "not-json" }))).resolves.toMatchObject({ tier: "high" });
    expect(readFileSync(path, "utf8")).toContain(`evidence=${commit} tier=high `);
  }));

  test("calls the assessor with the canonical project root and committed evidence", withProject(async (root, commit) => {
    preparePlan(root);
    let assessmentArgs: unknown;
    await runMark(root, commit, {}, "pm-odd", async (args: unknown) => {
      assessmentArgs = args;
      return { status: 0, json: { tier: "passive" } };
    });
    expect(assessmentArgs).toEqual({ projectDir: root, baseRef: commit, committedOnly: true });
  }));

  test("refuses missing or unresolvable evidence commits", withProject(async (root, commit) => {
    preparePlan(root);
    await expect(runMark(root, "")).rejects.toThrow();
    await expect(runMark(root, commit.slice(0, 7))).rejects.toThrow();
    await expect(runMark(root, "a".repeat(40))).rejects.toThrow();
  }));

  test("rejects malformed task ids", withProject(async (root, commit) => {
    preparePlan(root);
    await expect(runMark(root, commit, { taskId: "T5x" })).rejects.toThrow();
    await expect(runMark(root, commit, { taskId: "" })).rejects.toThrow();
  }));

  test("refuses planner and orchestrator identities with TASK_MARK_PM_ONLY", withProject(async (root, commit) => {
    preparePlan(root);
    for (const identity of ["planner", ORCHESTRATOR]) {
      await expect(runMark(root, commit, {}, identity)).rejects.toThrow("TASK_MARK_PM_ONLY");
    }
  }));

  test("requires a PASS verdict when a Gates section has no route", withProject(async (root, commit) => {
    preparePlan(root, "# Phase five\n\n## Gates\n\n## Revisions\n- r1 2026-01-01T00:00:00Z pm-odd: initial\n");
    await expect(runMark(root, commit)).rejects.toThrow("TASK_MARK_GATE_NOT_PASSED: routed plan tasks require a latest PASS gate verdict");
  }));

  test("refuses a last FAIL verdict when a Gates section has no route", withProject(async (root, commit) => {
    preparePlan(root, "# Phase five\n\n## Gates\n- T5 FAIL 2026-01-01T00:00:00Z pm-odd\n\n## Revisions\n- r1 2026-01-01T00:00:00Z pm-odd: initial\n");
    await expect(runMark(root, commit)).rejects.toThrow("TASK_MARK_GATE_NOT_PASSED");
  }));

  test("accepts a last PASS verdict when a Gates section has no route", withProject(async (root, commit) => {
    const path = preparePlan(root, "# Phase five\n\n## Gates\n- T5 PASS 2026-01-01T00:00:00Z pm-odd\n\n## Revisions\n- r1 2026-01-01T00:00:00Z pm-odd: initial\n");
    await expect(runMark(root, commit)).resolves.toMatchObject({ tier: "medium" });
    expect(readFileSync(path, "utf8")).toContain(`T5 passed evidence=${commit}`);
  }));

  test("allows plans without route or a Gates section", withProject(async (root, commit) => {
    const path = preparePlan(root, "# Phase five\n\n## Revisions\n- r1 2026-01-01T00:00:00Z pm-odd: initial\n");
    await expect(runMark(root, commit)).resolves.toMatchObject({ tier: "medium" });
    expect(readFileSync(path, "utf8")).toContain(`T5 passed evidence=${commit}`);
  }));

  test("requires PASS for routed plans even without a Gates section", withProject(async (root, commit) => {
    preparePlan(root, "---\nroute: odd\n---\n# Phase five\n\n## Revisions\n- r1 2026-01-01T00:00:00Z pm-odd: initial\n");
    await expect(runMark(root, commit)).rejects.toThrow("TASK_MARK_GATE_NOT_PASSED");
  }));

  test("uses the last Gates section, matching readLatestGateVerdict", withProject(async (root, commit) => {
    const path = preparePlan(root, "# Phase five\n\n## Gates\n- T5 PASS 2026-01-01T00:00:00Z pm-odd\n\n## Gates\n- T5 FAIL 2026-01-02T00:00:00Z pm-odd\n\n## Revisions\n- r1 2026-01-01T00:00:00Z pm-odd: initial\n");
    await expect(runMark(root, commit)).rejects.toThrow("TASK_MARK_GATE_NOT_PASSED");
    writeFileSync(path, "# Phase five\n\n## Gates\n- T5 FAIL 2026-01-01T00:00:00Z pm-odd\n\n## Gates\n- T5 PASS 2026-01-02T00:00:00Z pm-odd\n\n## Revisions\n- r1 2026-01-01T00:00:00Z pm-odd: initial\n");
    await expect(runMark(root, commit)).resolves.toMatchObject({ tier: "medium" });
  }));

  test("requires PASS for routed plans with a Gates section", withProject(async (root, commit) => {
    const path = preparePlan(root, "---\nroute: odd\n---\n# Phase five\n\n## Gates\n- T5 REFINE 2026-01-01T00:00:00Z pm-odd\n");
    await expect(runMark(root, commit)).rejects.toThrow("TASK_MARK_GATE_NOT_PASSED");
    writeFileSync(path, "---\nroute: odd\n---\n# Phase five\n\n## Gates\n- T5 PASS 2026-01-01T00:00:00Z pm-odd\n");
    await expect(runMark(root, commit)).resolves.toMatchObject({ tier: "medium" });
  }));

  test("accumulates ticks in call order", withProject(async (root, commit) => {
    const path = preparePlan(root);
    await runMark(root, commit, { note: "first" });
    await runMark(root, commit, { note: "second" });
    const text = readFileSync(path, "utf8");
    expect(text.indexOf("pm-odd: first")).toBeLessThan(text.indexOf("pm-odd: second"));
    expect(text.match(/^T5 passed evidence=/gm)).toHaveLength(2);
    expect(text).toContain("- r2 ");
    expect(text).toContain("- r3 ");
  }));
});
