import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { buildGateVerdictOp, readLatestGateVerdict } from "../src/service.ts";
import { ValidationError } from "../src/validation.ts";
import type { BrokerRequestEnvelope, SessionRecord } from "../src/types.ts";

const roots: string[] = [];
const ORCHESTRATOR = "gentle-orchestrator";

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "plan-gate-verdict-"));
  roots.push(root);
  return root;
}

function makeContext(root: string, allowedAgents = ["planner"], boundIdentity = "planner") {
  const config = defaultConfig({
    projects: [{ id: "gate-test", path: root }],
    readOnlyAgents: [ORCHESTRATOR],
    planWriterAgents: allowedAgents,
  });
  const record: SessionRecord = {
    sessionID: "session-gate",
    state: "HOST_READ_ONLY",
    agent: boundIdentity,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  return { config, store: { get: () => record } } as never;
}

function request(root: string, payload: Record<string, unknown>, agent = "planner"): BrokerRequestEnvelope {
  return {
    version: 1,
    id: "gate",
    operation: "gateVerdict",
    sessionID: "session-gate",
    agent,
    payload: { projectDir: root, name: "phase-two", taskId: "unit-b", verdict: "PASS", agent, ...payload },
  } as BrokerRequestEnvelope;
}

async function submit(root: string, payload: Record<string, unknown> = {}, agent = "planner", boundIdentity = "planner") {
  return buildGateVerdictOp(makeContext(root, ["planner"], boundIdentity))(request(root, payload, agent));
}

async function rejectsValidation(promise: Promise<unknown>, expected: RegExp) {
  await expect(promise).rejects.toBeInstanceOf(ValidationError);
  await expect(promise).rejects.toThrow(expected);
}

function createPlan(root: string, content = "# Phase two\n\n## Scope\nKeep this byte-for-byte.\n") {
  const directory = join(root, "odd/tasks");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "phase-two.md");
  writeFileSync(path, content);
  return { path, content };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("host gate verdict", () => {
  test("refuses orchestrator authority and payload agent spoofing", async () => {
    const root = makeRoot();
    const { path } = createPlan(root);
    await expect(submit(root, {}, "planner", ORCHESTRATOR)).rejects.toThrow(/plan-writer category/i);
    await rejectsValidation(submit(root, { agent: "pm-odd" }, "planner", "planner"), /agent.*bound|bound.*agent/i);
    await rejectsValidation(submit(root, { agent: undefined }, "planner", "planner"), /agent.*bound|bound.*agent/i);
    expect(readFileSync(path, "utf8")).not.toContain("## Gates");
  });

  test("appends PASS under a new Gates section and preserves prior document bytes", async () => {
    const root = makeRoot();
    const { path, content } = createPlan(root);
    const result = await submit(root);
    const saved = readFileSync(path, "utf8");
    expect(result).toMatchObject({ name: "phase-two", taskId: "unit-b", verdict: "PASS", path: "odd/tasks/phase-two.md", gates: 1 });
    expect(saved.startsWith(content)).toBe(true);
    expect(saved.slice(content.length)).toMatch(/^\n## Gates\n- unit-b PASS \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ planner\n$/);
  });

  test("appends repeated task verdicts in order and reads the latest", async () => {
    const root = makeRoot();
    const { path, content } = createPlan(root);
    await submit(root);
    await submit(root, { verdict: "REFINE", refinementPlan: "Clarify the acceptance criteria.", evidenceRef: "review-42" });
    const saved = readFileSync(path, "utf8");
    const first = /- unit-b PASS \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ planner/;
    const second = /- unit-b REFINE \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ planner ref=review-42 :: Clarify the acceptance criteria\./;
    expect(saved.startsWith(content)).toBe(true);
    expect(saved).toMatch(new RegExp(`## Gates\\n${first.source}\\n${second.source}\\n$`));
    const section = saved.slice(saved.indexOf("## Gates"));
    const gateLines = section.split("\n").slice(1, -1);
    expect(gateLines).toHaveLength(2);
    expect(section).toBe(`## Gates\n${gateLines[0]}\n${gateLines[1]}\n`);
    expect(gateLines[0]).toMatch(/^- unit-b PASS \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ planner$/);
    expect(gateLines[1]).toMatch(/^- unit-b REFINE \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ planner ref=review-42 :: Clarify the acceptance criteria\.$/);
    expect(readLatestGateVerdict(saved, "unit-b")?.verdict).toBe("REFINE");
    expect(readLatestGateVerdict(saved, "unit-b")?.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(await submit(root, { verdict: "ESCALATE" })).toMatchObject({ gates: 3 });
    const afterThird = readFileSync(path, "utf8").slice(content.length);
    expect(afterThird).toMatch(/^\n## Gates\n- unit-b PASS .*\n- unit-b REFINE .*\n- unit-b ESCALATE .*\n$/);
  });

  test("requires refinementPlan exactly for REFINE and validates its shape", async () => {
    const root = makeRoot();
    createPlan(root);
    await rejectsValidation(submit(root, { verdict: "REFINE" }), /refinementPlan.*required/i);
    await rejectsValidation(submit(root, { refinementPlan: "Unexpected" }), /refinementPlan.*only.*REFINE/i);
    await rejectsValidation(submit(root, { verdict: "REFINE", refinementPlan: "  " }), /refinementPlan.*non-empty/i);
    await rejectsValidation(submit(root, { verdict: "REFINE", refinementPlan: "line one\nline two" }), /refinementPlan.*newline/i);
    await rejectsValidation(submit(root, { verdict: "REFINE", refinementPlan: "x".repeat(601) }), /refinementPlan.*600/i);
  });

  test("requires a trimmed single-line evidence reference when supplied", async () => {
    const root = makeRoot();
    createPlan(root);
    await rejectsValidation(submit(root, { evidenceRef: "  " }), /evidenceRef.*non-empty/i);
    await rejectsValidation(submit(root, { evidenceRef: "line one\nline two" }), /evidenceRef.*newline/i);
    await rejectsValidation(submit(root, { evidenceRef: "x".repeat(201) }), /evidenceRef.*200/i);
  });

  test("rejects malformed names, task identifiers, and verdicts", async () => {
    const root = makeRoot();
    createPlan(root);
    await rejectsValidation(submit(root, { name: "../escape" }), /name/i);
    await rejectsValidation(submit(root, { taskId: "not a task" }), /taskId/i);
    await rejectsValidation(submit(root, { verdict: "PASS_WITH_NOTES" }), /verdict/i);
  });

  test("refuses a missing plan document", async () => {
    await rejectsValidation(submit(makeRoot()), /document.*exist|not found/i);
  });

  test("refuses an agent outside planWriterAgents and names the allowed set", async () => {
    const root = makeRoot();
    createPlan(root);
    await rejectsValidation(submit(root, {}, "pm-odd", "pm-odd"), /allowed.*planner/i);
  });

  test("refuses a symlinked plan document", async () => {
    const root = makeRoot();
    mkdirSync(join(root, "odd/tasks"), { recursive: true });
    const outside = join(root, "outside.md");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(root, "odd/tasks/phase-two.md"));
    await rejectsValidation(submit(root), /symlink/i);
  });

  test("latest verdict is undefined for unknown tasks and absent Gates sections", () => {
    expect(readLatestGateVerdict("# Plan\n", "unit-b")).toBeUndefined();
    expect(readLatestGateVerdict("## Gates\n- unit-b PASS 2026-10-23T12:00:00Z planner\n", "unknown")).toBeUndefined();
    expect(readLatestGateVerdict("## Gates\n- unit-b PASS 2026-10-23T12:00:00Z planner\n## Other\n- unit-b ESCALATE 2026-10-23T12:01:00Z planner\n", "unit-b")?.verdict).toBe("PASS");
  });
});
