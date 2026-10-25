import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { buildGateVerdictOp, buildTaskMarkOp, readLatestGateVerdict } from "../src/service.ts";
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

/** Record a real gate verdict through the operation and return its hash. */
async function runGate(
  root: string,
  taskId = "T5",
  verdict: "PASS" | "REFINE" | "ESCALATE" = "PASS",
  payload: Record<string, unknown> = {},
): Promise<string> {
  const gate = buildGateVerdictOp(makeContext(root, "planner"));
  const result = await gate({
    version: 1,
    id: "gate",
    operation: "gateVerdict",
    sessionID: "session-task-mark",
    agent: "planner",
    payload: { projectDir: root, name: "phase-five", taskId, verdict, agent: "planner", ...payload },
  } as BrokerRequestEnvelope) as { verdictHash?: string };
  if (typeof result.verdictHash !== "string") throw new Error("gateVerdict did not return a verdictHash");
  return result.verdictHash;
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
    const path = preparePlan(root);
    const gateRef = await runGate(root);
    await expect(runMark(root, commit, { gateRef })).resolves.toMatchObject({ tier: "medium" });
    const text = readFileSync(path, "utf8");
    expect(text).toContain(`T5 passed evidence=${commit} gate=${gateRef}`);
    expect(text).toContain("## Gates");
  }));

  test("allows plans without route or a Gates section", withProject(async (root, commit) => {
    const path = preparePlan(root, "# Phase five\n\n## Revisions\n- r1 2026-01-01T00:00:00Z pm-odd: initial\n");
    await expect(runMark(root, commit)).resolves.toMatchObject({ tier: "medium" });
    const text = readFileSync(path, "utf8");
    expect(text).toContain(`T5 passed evidence=${commit}`);
    expect(text.trimEnd()).toMatch(new RegExp(`## Ticks\\nT5 passed evidence=${commit} tier=medium \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z pm-odd(?:: done)?$`));
    expect(text.match(/^## Ticks$/gm)).toHaveLength(1);
  }));

  test("places one Ticks section immediately before final Gates", withProject(async (root, commit) => {
    const path = preparePlan(root);
    const gateRef = await runGate(root);
    await expect(runMark(root, commit, { gateRef })).resolves.toMatchObject({ tier: "medium" });
    const text = readFileSync(path, "utf8");
    expect(text.match(/^## Ticks$/gm)).toHaveLength(1);
    expect(text.indexOf("## Ticks")).toBeLessThan(text.indexOf("## Gates"));
    expect(text.trimEnd()).toMatch(/## Gates\n- T5 PASS \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ planner$/);
  }));

  test("appends ticks to the existing Ticks section before Gates", withProject(async (root, commit) => {
    const path = preparePlan(root, "# Phase five\n\n## Revisions\n- r1 2026-01-01T00:00:00Z pm-odd: initial\n\n## Ticks\nT5 passed evidence=old tier=medium 2026-01-01T00:00:00Z pm-odd\n");
    const gateRef = await runGate(root);
    await expect(runMark(root, commit, { gateRef })).resolves.toMatchObject({ tier: "medium" });
    const text = readFileSync(path, "utf8");
    expect(text.match(/^## Ticks$/gm)).toHaveLength(1);
    expect(text.indexOf(`evidence=${commit}`)).toBeLessThan(text.indexOf("## Gates"));
    expect(text.trimEnd()).toMatch(/## Gates\n- T5 PASS \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ planner$/);
  }));

  test("allows a gate verdict after tick and reads the latest verdict", withProject(async (root, commit) => {
    const path = preparePlan(root);
    const passRef = await runGate(root);
    await expect(runMark(root, commit, { gateRef: passRef })).resolves.toMatchObject({ tier: "medium" });
    await runGate(root, "T5", "REFINE", { refinementPlan: "Update evidence" });
    expect(readLatestGateVerdict(readFileSync(path, "utf8"), "T5")?.verdict).toBe("REFINE");
  }));

  test("requires PASS for routed plans even without a Gates section", withProject(async (root, commit) => {
    preparePlan(root, "---\nroute: odd\n---\n# Phase five\n\n## Revisions\n- r1 2026-01-01T00:00:00Z pm-odd: initial\n");
    await expect(runMark(root, commit)).rejects.toThrow("TASK_MARK_GATE_NOT_PASSED");
  }));

  test("uses the latest verdict, matching readLatestGateVerdict", withProject(async (root, commit) => {
    const path = preparePlan(root);
    await runGate(root, "T5", "PASS");
    await runGate(root, "T5", "REFINE", { refinementPlan: "Needs another pass" });
    expect(readLatestGateVerdict(readFileSync(path, "utf8"), "T5")?.verdict).toBe("REFINE");
    await expect(runMark(root, commit)).rejects.toThrow("TASK_MARK_GATE_NOT_PASSED");

    writeFileSync(path, "# Phase five\n\n## Revisions\n- r1 2026-01-01T00:00:00Z pm-odd: initial\n");
    await runGate(root, "T5", "REFINE", { refinementPlan: "Needs another pass" });
    const passRef = await runGate(root, "T5", "PASS");
    expect(readLatestGateVerdict(readFileSync(path, "utf8"), "T5")?.verdict).toBe("PASS");
    await expect(runMark(root, commit, { gateRef: passRef })).resolves.toMatchObject({ tier: "medium" });
  }));

  test("requires PASS for routed plans with a Gates section", withProject(async (root, commit) => {
    const path = preparePlan(root, "---\nroute: odd\n---\n# Phase five\n\n## Revisions\n- r1 2026-01-01T00:00:00Z pm-odd: initial\n");
    await runGate(root, "T5", "REFINE", { refinementPlan: "Needs another pass" });
    await expect(runMark(root, commit)).rejects.toThrow("TASK_MARK_GATE_NOT_PASSED");
    const passRef = await runGate(root, "T5", "PASS");
    await expect(runMark(root, commit, { gateRef: passRef })).resolves.toMatchObject({ tier: "medium" });
    expect(readFileSync(path, "utf8")).toContain(`gate=${passRef}`);
  }));

  test("requires a gateRef when a Gates section exists", withProject(async (root, commit) => {
    preparePlan(root);
    await runGate(root);
    await expect(runMark(root, commit)).rejects.toThrow("TASK_MARK_GATE_REF_REQUIRED");
  }));

  test("refuses a stale gateRef when a later PASS exists", withProject(async (root, commit) => {
    preparePlan(root);
    const staleRef = await runGate(root);
    await runGate(root, "T5", "PASS", { evidenceRef: "second-review" });
    await expect(runMark(root, commit, { gateRef: staleRef })).rejects.toThrow("TASK_MARK_GATE_REF_MISMATCH");
  }));

  test("refuses a gateRef belonging to a different task", withProject(async (root, commit) => {
    preparePlan(root);
    const otherTaskRef = await runGate(root, "T4");
    await runGate(root, "T5");
    await expect(runMark(root, commit, { gateRef: otherTaskRef })).rejects.toThrow("TASK_MARK_GATE_REF_MISMATCH");
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
