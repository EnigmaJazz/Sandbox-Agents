/**
 * D22 (multi-tier S94-S95, S105-S110): `gateVerdictAuto`, the one place code records a gate
 * verdict. Only a trusted non-LLM identity from `gateRouterAgents` may call it; the broker
 * re-derives scope, budget and test status itself and records ONLY a PASS on RECORD_PASS.
 *
 * A real git repository (mkdtemp under the OS tmpdir) plays the host; stages are seeded
 * straight into stage refs plus session records, and the test-run log is written the way
 * `testRun` writes it. No worker backend is started.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { spawnArgv } from "../src/msb.ts";
import { PolicyError } from "../src/policy.ts";
import { classifyOperation, decideGateRouter } from "../src/role-policy.ts";
import { BrokerServer } from "../src/server.ts";
import { authorizeHostDispatch, bindSessionAgent, buildToolAdmissionOp, gateVerdictHash, readLatestGateVerdict, type OpContext } from "../src/service.ts";
import { StateError } from "../src/state.ts";
import { chainCreate } from "../src/staging-chain.ts";
import { OPERATIONS, SANDBOX_GUARD_CLASS, type BrokerRequestEnvelope } from "../src/types.ts";
import {
  ALLOWED_PAYLOAD_KEYS,
  HOST_MUTATION_IDENTITY_OPERATIONS,
  HOST_MUTATION_OPERATIONS,
  HostToolPolicy,
  ValidationError,
  hostToolAccess,
} from "../src/validation.ts";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const ORCH = "gentle-orchestrator";
const REVIEWER = "stage-review";
const ROUTER = "gate-router";
const TOOL = "host_gate_verdict_auto";
const DOC = "odd/tasks/gate-feature.md";
const IMPL = "implementation-vs-spec";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();
const REF = (id: string) => `refs/opencode-sandbox/chain/${id}`;

const PLAN = `# Gate feature

## Specs
- S1 the first criterion
- S2 the second criterion

## Tasks
- T1 the feature
- T1.impl its implementation gate
- T2 second
- T3 third

## Allowed edit surfaces
- \`src/**\`
- \`docs/*.md\`
`;

interface LogOpts { timedOut?: boolean; forChain?: string; bind?: boolean; project?: string; tree?: string; mtimeSeconds?: number }

interface Env {
  ctx: OpContext & { store: { touch(id: string, patch: Record<string, unknown>): unknown } };
  repo: string;
  stateDir: string;
  base: string;
  chain: string;
  dispatch(operation: string, sessionID: string, payload?: unknown, agent?: string): Promise<any>;
  /** A new chain whose stage 1 changes `files` (path -> content) on top of the base commit. */
  stage(files: Record<string, string>): string;
  /**
   * A test-run log id in the header format `testRun` writes PLUS the project/tree binding that only stage-bound
   * evidence carries (synthetic here; gate-test-evidence.test.ts produces the real one end to end). `forChain` binds it to that chain's
   * stage result tree (default: the fixture's first chain); `bind: false` writes today's unbound header.
   */
  log(runner: string, exitCode: number | null, extra?: { timedOut?: boolean; forChain?: string; bind?: boolean; project?: string; tree?: string; mtimeSeconds?: number }): string;
  payload(over?: Record<string, unknown>): Record<string, unknown>;
  doc(): string;
  commits(): number;
  readonly goodLog: string;
}

function fixture(opts: { plan?: string; runners?: boolean } = {}): Env {
  const root = mkdtempSync(join(tmpdir(), "gate-verdict-auto-"));
  roots.push(root);
  const repo = join(root, "repo");
  const stateDir = join(root, "state");
  mkdirSync(join(repo, "odd/tasks"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@local");
  writeFileSync(join(repo, "a.txt"), "a\n");
  writeFileSync(join(repo, DOC), opts.plan ?? PLAN);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  const base = git(repo, "rev-parse", "HEAD");

  const server = new BrokerServer(
    defaultConfig({
      stateDir,
      projects: [{ id: "repo", path: repo }],
      readOnlyAgents: [ORCH],
      stageReviewAgents: [REVIEWER],
      gateRouterAgents: [ROUTER],
      testRunners: opts.runners === false ? [] : [{ id: "unit", language: "ts", argv: ["/bin/true"], cwd: ".", timeoutMs: 1000, maxOutputBytes: 1000 }],
    }),
  );
  const internals = server as unknown as { ctx: Env["ctx"]; dispatch(req: BrokerRequestEnvelope): Promise<unknown> };
  (internals.ctx as { git: unknown }).git = { runnerMode: "real", spawn: spawnArgv };
  const sessions: Record<string, string | undefined> = {
    router: ROUTER, orch: ORCH, planner: "planner", pm: "pm", pmodd: "pm-odd", pmsys: "pm-systematic", pmsdd: "pm-sdd",
    pmoddastra: "pm-odd-astra", pmsysastra: "pm-systematic-astra", rev: REVIEWER, wrk: "worker", plain: undefined,
    upper: "GATE-ROUTER", mixed: "Gate-Router", padded: " gate-router", trailing: "gate-router ", underscore: "gate_router", other: "gate-routerx",
  };
  for (const [id, agent] of Object.entries(sessions)) internals.ctx.store.touch(id, agent === undefined ? {} : { agent });
  const dispatch = (operation: string, sessionID: string, payload?: unknown, agent?: string) =>
    internals.dispatch({ version: 1, id: `t-${operation}`, operation, sessionID, ...(agent ? { agent } : {}), payload } as BrokerRequestEnvelope) as Promise<any>;

  let counter = 0;
  const stage = (files: Record<string, string>): string => {
    counter += 1;
    git(repo, "checkout", "-q", "-b", `side${counter}`, base);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(repo, path, ".."), { recursive: true });
      writeFileSync(join(repo, path), content);
    }
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "--allow-empty", "-m", `stage ${counter}`);
    const result = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "main");
    const chain = chainCreate(internals.ctx, { projectID: "repo", lane: "feature" });
    git(repo, "update-ref", `${REF(chain.id)}/base`, base);
    git(repo, "update-ref", `${REF(chain.id)}/stage/1`, result);
    internals.ctx.store.touch(`w${counter}`, { projectID: "repo", state: "RESULT_READY", chain: { id: chain.id, n: 1, baseline: base } });
    return chain.id;
  };
  let logCounter = 0;
  const treeOf = (chainID: string): string => git(repo, "rev-parse", `${git(repo, "rev-parse", `${REF(chainID)}/stage/1`)}^{tree}`);
  const log = (runner: string, exitCode: number | null, extra: LogOpts = {}): string => {
    logCounter += 1;
    const id = `00000000-0000-4000-8000-${String(logCounter).padStart(12, "0")}`;
    mkdirSync(join(stateDir, "test-runs"), { recursive: true });
    const binding = extra.bind === false ? "" : ` project=${extra.project ?? "repo"} tree=${extra.tree ?? treeOf(extra.forChain ?? chain)}`;
    // The header buildTestRunOp writes (a literal backslash-n follows the flags), plus the stage binding (synthetic; see gate-test-evidence.test.ts).
    const file = join(stateDir, "test-runs", `${id}.log`);
    writeFileSync(file, `runner=${runner} exitCode=${String(exitCode)} signal=null timedOut=${extra.timedOut === true} truncated=false${binding}\\nstdout\\nok\\nstderr\\n`);
    if (extra.mtimeSeconds !== undefined) utimesSync(file, extra.mtimeSeconds, extra.mtimeSeconds);
    return id;
  };
  const chain = stage({ "src/feature.ts": "export const x = 1;\n" });
  const goodLog = log("unit", 0);
  const payload = (over: Record<string, unknown> = {}) => ({
    projectDir: repo, name: "gate-feature", taskId: "T1", checkpoint: IMPL, chainID: chain, n: 1,
    expectedCriteria: ["S1", "S2"], criteria: [{ id: "S1", p: 0.9 }, { id: "S2", p: 0.95 }],
    // Default evidence: a bound passing log for the stage being gated.
    testRunRefs: [typeof over.chainID === "string" && over.chainID !== chain && /^c[0-9a-f]{12}$/.test(over.chainID) && over.chainID !== "c000000000000" ? log("unit", 0, { forChain: over.chainID }) : goodLog],
    ...over,
  });
  return {
    ctx: internals.ctx, repo, stateDir, base, chain, dispatch, stage, log, payload, goodLog,
    doc: () => readFileSync(join(repo, DOC), "utf8"),
    commits: () => Number(git(repo, "rev-list", "--count", "main")),
  };
}

const gateLines = (doc: string) => doc.split("\n").filter((l) => /^- \S+ (PASS|REFINE|ESCALATE) /.test(l));

/** The refusal/label leaves the document bytes and the repository history exactly as they were. */
async function recordsNothing(e: Env, call: () => Promise<any>): Promise<any> {
  const before = e.doc();
  const commits = e.commits();
  let outcome: any;
  try {
    outcome = await call();
  } catch (error) {
    outcome = error;
  }
  expect(e.doc()).toBe(before);
  expect(e.commits()).toBe(commits);
  return outcome;
}

describe("a clear match", () => {
  test("records exactly one PASS authored by the router, with the probabilities and checks as evidence", async () => {
    const e = fixture();
    const before = e.doc();
    const result = await e.dispatch("gateVerdictAuto", "router", e.payload());
    expect(result).toMatchObject({ route: "RECORD_PASS", recorded: true, verdict: "PASS", taskId: "T1", name: "gate-feature" });
    const lines = gateLines(e.doc());
    expect(lines).toHaveLength(1);
    const latest = readLatestGateVerdict(e.doc(), "T1")!;
    expect(latest.verdict).toBe("PASS");
    expect(latest.line.split(" ")[4]).toBe(ROUTER);
    expect(latest.line).toContain("ref=d22-auto:");
    expect(latest.line).toContain("S1=0.9");
    expect(latest.line).toContain("S2=0.95");
    expect(latest.line).toMatch(/scope:pass/);
    expect(latest.line).toMatch(/tests:pass/);
    expect(latest.line).toMatch(/budget:pass/);
    expect(latest.line).toContain("code-recorded under D22");
    expect(result.verdictHash).toBe(gateVerdictHash(latest.line));
    // Append-only: every prior byte is preserved.
    expect(e.doc().startsWith(before)).toBe(true);
  });

  test("the verdict is consumed like any other: taskMark accepts the returned hash as gateRef", async () => {
    const e = fixture();
    const result = await e.dispatch("gateVerdictAuto", "router", e.payload());
    const tick = await e.dispatch("taskMark", "pmodd", { projectDir: e.repo, target: "tasks", name: "gate-feature", taskId: "T1", status: "passed", evidenceCommit: e.base, gateRef: result.verdictHash });
    expect(tick).toMatchObject({ target: "tasks", path: DOC });
    expect(e.doc()).toContain("T1 passed");
    // Negative control: a wrong hash is refused.
    await expect(e.dispatch("taskMark", "pmodd", { projectDir: e.repo, target: "tasks", name: "gate-feature", taskId: "T1", status: "passed", evidenceCommit: e.base, gateRef: `sha256:${"0".repeat(64)}` })).rejects.toThrow(/GATE_REF_MISMATCH/);
  });

  test("the plan checkpoint's Planner PASS on a task id blocks code on that id; a separate gate id works and ticks", async () => {
    const e = fixture();
    await e.dispatch("gateVerdict", "planner", { projectDir: e.repo, name: "gate-feature", taskId: "T1", verdict: "PASS", agent: "planner" });
    const refused = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", "router", e.payload()));
    expect(String(refused.message)).toMatch(/GATE_AUTO_PASS_EXISTS/);
    const result = await e.dispatch("gateVerdictAuto", "router", e.payload({ taskId: "T1.impl" }));
    expect(result.recorded).toBe(true);
    const tick = await e.dispatch("taskMark", "pmodd", { projectDir: e.repo, target: "tasks", name: "gate-feature", taskId: "T1.impl", status: "passed", evidenceCommit: e.base, gateRef: result.verdictHash });
    expect(tick.path).toBe(DOC);
  });
});

describe("only the router identity may call it (deny by default)", () => {
  const denied = ["orch", "planner", "pm", "pmodd", "pmsys", "pmsdd", "pmoddastra", "pmsysastra", "rev", "wrk", "plain", "upper", "mixed", "padded", "trailing", "underscore", "other", "no-such-session"];

  test("every other identity is denied at the operation, and nothing is recorded", async () => {
    const e = fixture();
    for (const session of denied) {
      const outcome = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", session, e.payload()));
      expect(outcome, session).toBeInstanceOf(PolicyError);
    }
    // Positive control: the same payload from the router records.
    expect((await e.dispatch("gateVerdictAuto", "router", e.payload())).recorded).toBe(true);
  });

  test("a forged envelope agent claim does not authorize a non-router session", async () => {
    const e = fixture();
    for (const session of ["orch", "planner", "plain", "wrk", "rev"]) {
      const outcome = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", session, e.payload(), ROUTER));
      expect(outcome, session).toBeInstanceOf(PolicyError);
    }
    // And a payload `agent` is not even a field.
    const outcome = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", "router", e.payload({ agent: "planner" })));
    expect(outcome).toBeInstanceOf(ValidationError);
  });

  test("tool admission: only the router is admitted, and only to this one tool", async () => {
    const e = fixture();
    const admit = (tool: string, session: string) =>
      buildToolAdmissionOp(e.ctx)({ version: 1, id: "a", operation: "toolAdmission", sessionID: session, payload: { tool } } as BrokerRequestEnvelope) as Promise<{ decision: string; reason: string }>;
    expect((await admit(TOOL, "router")).decision).toBe("allow");
    for (const session of denied) expect((await admit(TOOL, session)).decision, session).toBe("deny");
    for (const tool of ["host_gate_verdict", "host_task_mark", "host_stage_list", "host_stage_approve", "host_git_commit", "host_plan_write", "sandbox_read", "sandbox_bash", "host_review_assess", "host_orca_report"]) {
      expect((await admit(tool, "router")).decision, tool).toBe("deny");
    }
    expect(classifyOperation(TOOL)).toBe("HOST_ADMIN_STRUCTURED");
    expect(decideGateRouter("HOST_ADMIN_STRUCTURED", TOOL).decision).toBe("allow");
    expect(decideGateRouter("HOST_ADMIN_STRUCTURED", "host_stage_approve").decision).toBe("deny");
    expect(decideGateRouter("READ_PROJECT").decision).toBe("deny");
    expect(decideGateRouter("nonsense", TOOL).decision).toBe("deny");
  });

  test("the router holds no other host operation, no worker and no sandbox operation", async () => {
    const e = fixture();
    for (const op of ["gateVerdict", "taskMark", "planDocWrite", "gitCommit", "stageList", "stageApprove", "reviewAssess"]) {
      await expect(e.dispatch(op, "router", {}), op).rejects.toBeInstanceOf(PolicyError);
    }
    for (const op of ["exec", "readFile", "writeFile", "applyPatch", "prepareResult", "destroyWorker"]) {
      await expect(e.dispatch(op, "router", {}), op).rejects.toThrow(/gate-router|stage-review/);
    }
    await expect(e.dispatch("ensureWorker", "router", { projectDir: e.repo })).rejects.toThrow(/gate-router/);
    await expect(e.dispatch("ensureWorker", "fresh-session", { projectDir: e.repo }, ROUTER)).rejects.toThrow(/gate-router/);
  });

  test("the name binds as an identity, but not after the session entered the worker lifecycle", () => {
    const e = fixture();
    expect(bindSessionAgent(e.ctx, "bind-ok", { agent: ROUTER }).agent).toBe(ROUTER);
    e.ctx.store.touch("has-worker", { state: "SANDBOX_ACTIVE" });
    expect(() => bindSessionAgent(e.ctx, "has-worker", { agent: ROUTER })).toThrow(PolicyError);
    expect(() => bindSessionAgent(e.ctx, "other", { agent: "Gate-Router" })).toThrow(PolicyError);
  });

  test("registry: a separate list, in no orchestrator identity's subset", () => {
    expect(OPERATIONS).toContain("gateVerdictAuto" as never);
    expect(SANDBOX_GUARD_CLASS).toHaveProperty("gateVerdictAuto", "exempt-from-sandbox-guard");
    expect(new Set(OPERATIONS).size).toBe(OPERATIONS.length);
    expect(HOST_MUTATION_OPERATIONS).not.toContain("gateVerdictAuto");
    expect(hostToolAccess("gateVerdictAuto")).toBe("mutation");
    for (const [identity, ops] of Object.entries(HOST_MUTATION_IDENTITY_OPERATIONS)) expect(ops, identity).not.toContain("gateVerdictAuto");
    expect(new HostToolPolicy([ORCH, "pm-odd"]).decide("gateVerdictAuto", ORCH).allowed).toBe(false);
    expect(new HostToolPolicy([ORCH, "pm-odd"]).decide("gateVerdictAuto", "pm-odd").allowed).toBe(false);
    expect(ALLOWED_PAYLOAD_KEYS.gateVerdictAuto).toEqual(["projectDir", "name", "taskId", "checkpoint", "chainID", "n", "expectedCriteria", "criteria", "testRunRefs"]);
    const e = fixture();
    expect(authorizeHostDispatch(e.ctx, "gateVerdictAuto", "router")).toBe("mutation");
    expect(() => authorizeHostDispatch(e.ctx, "gateVerdictAuto", "orch")).toThrow(/gate-router/);
    // Every other operation refuses the router identity.
    expect(() => authorizeHostDispatch(e.ctx, "gitCommit", "router")).toThrow(PolicyError);
    expect(() => authorizeHostDispatch(e.ctx, "reviewAssess", "router")).toThrow(PolicyError);
  });
});

describe("config: gateRouterAgents", () => {
  const make = (gateRouterAgents: unknown, extra: Record<string, unknown> = {}) =>
    () => new BrokerServer(defaultConfig({ gateRouterAgents: gateRouterAgents as string[], readOnlyAgents: [ORCH], ...extra }));
  test("empty by default; refuses overlap with every other authority and non-names", () => {
    expect(defaultConfig().gateRouterAgents).toEqual([]);
    expect(make([ROUTER])).not.toThrow();
    expect(make([ORCH])).toThrow(/gateRouterAgents/);
    expect(make([REVIEWER], { stageReviewAgents: [REVIEWER] })).toThrow(/gateRouterAgents/);
    expect(make(["planner"])).toThrow(/gateRouterAgents/);
    expect(make(["pm"])).toThrow(/gateRouterAgents/);
    expect(make(["pm-odd"])).toThrow(/gateRouterAgents/);
    expect(make(["pm-systematic-astra"])).toThrow(/gateRouterAgents/);
    expect(make(["worker"])).toThrow(/gateRouterAgents/);
    expect(make(["custom-writer"], { planWriterAgents: ["custom-writer"] })).toThrow(/gateRouterAgents/);
    expect(make(["custom-mini"], { planMiniWriterAgents: ["custom-mini"] })).toThrow(/gateRouterAgents/);
    expect(make([""])).toThrow(/gateRouterAgents/);
    expect(make("x")).toThrow(/gateRouterAgents/);
    expect(make([ROUTER, ROUTER])).toThrow(/gateRouterAgents/);
  });
});

describe("payload (strict allowlist, no caller-supplied verdict inputs)", () => {
  test("unknown keys and every caller-supplied deterministic input are rejected", async () => {
    const e = fixture();
    for (const key of ["deterministicPass", "checks", "thresholds", "touchedPaths", "allowedPaths", "numstat", "testsPassed", "exitCode", "verdict", "agent", "low", "high"]) {
      const outcome = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", "router", e.payload({ [key]: key === "thresholds" ? { low: 0.01, high: 0.02 } : true })));
      expect(outcome, key).toBeInstanceOf(ValidationError);
    }
    for (const bad of [{ id: "S1", p: 0.9, deterministicPass: true }, { id: "S1", p: 0.9, extra: 1 }, { p: 0.9 }, { id: 1, p: 0.9 }, "S1", null]) {
      const outcome = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", "router", e.payload({ criteria: [bad, { id: "S2", p: 0.95 }] })));
      expect(outcome, JSON.stringify(bad)).toBeInstanceOf(ValidationError);
    }
    // Positive control: the same call without the extras records.
    expect((await e.dispatch("gateVerdictAuto", "router", e.payload())).recorded).toBe(true);
  });

  test("bad shape or identifiers are rejected", async () => {
    const e = fixture();
    const cases: Record<string, unknown>[] = [
      { checkpoint: "other" }, { checkpoint: undefined }, { taskId: "../x" }, { taskId: undefined }, { name: "Bad Name" }, { name: "../etc" },
      { chainID: "nope" }, { n: 0 }, { n: "1" }, { n: 1.5 }, { expectedCriteria: [] }, { expectedCriteria: "S1" }, { expectedCriteria: ["S1", 2] },
      { expectedCriteria: ["S1", "bad id"] }, { criteria: "x" }, { testRunRefs: "x" }, { testRunRefs: ["../../etc/passwd"] }, { testRunRefs: [1] },
      { projectDir: "/not/a/project" },
    ];
    for (const over of cases) {
      const outcome = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", "router", e.payload(over)));
      expect(outcome, JSON.stringify(over)).toBeInstanceOf(ValidationError);
    }
  });

  test("an expected criterion id the plan document does not contain is refused", async () => {
    const e = fixture();
    const outcome = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", "router", e.payload({ expectedCriteria: ["S1", "S99"], criteria: [{ id: "S1", p: 0.9 }, { id: "S99", p: 0.9 }] })));
    expect(outcome).toBeInstanceOf(ValidationError);
  });
});

describe("probabilities are never trusted past the router", () => {
  test("a non-finite, out-of-range or non-number p is rejected and records nothing", async () => {
    const e = fixture();
    for (const p of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.1, 1.1, 2, "0.9", null, true, [0.9], { v: 0.9 }]) {
      const outcome = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", "router", e.payload({ criteria: [{ id: "S1", p }, { id: "S2", p: 0.95 }] })));
      expect(outcome, String(p)).toBeInstanceOf(ValidationError);
    }
  });

  test("a missing p, a missing, duplicate or unknown criterion is unsure: SPEC_CHECK, nothing recorded", async () => {
    const e = fixture();
    const unsure: Record<string, unknown>[] = [
      { criteria: [{ id: "S1" }, { id: "S2", p: 0.95 }] },
      { criteria: [{ id: "S1", p: 0.9 }] },
      { criteria: [{ id: "S1", p: 0.9 }, { id: "S1", p: 0.9 }, { id: "S2", p: 0.95 }] },
      { criteria: [{ id: "S1", p: 0.9 }, { id: "S2", p: 0.95 }, { id: "S3", p: 0.9 }] },
    ];
    for (const over of unsure) {
      const out = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", "router", e.payload(over)));
      expect(out, JSON.stringify(over)).toMatchObject({ route: "SPEC_CHECK", recorded: false });
    }
  });

  test("p exactly 0.7 and exactly 0.3 never record; 0.71 does (positive control)", async () => {
    const e = fixture();
    for (const p of [0.7, 0.3, 0.5]) {
      const out = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", "router", e.payload({ criteria: [{ id: "S1", p }, { id: "S2", p: 0.95 }] })));
      expect(out, String(p)).toMatchObject({ route: "SPEC_CHECK", recorded: false });
    }
    const low = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", "router", e.payload({ criteria: [{ id: "S1", p: 0.29 }, { id: "S2", p: 0.95 }] })));
    expect(low).toMatchObject({ route: "RETURN_TO_PLANNER", recorded: false });
    expect((await e.dispatch("gateVerdictAuto", "router", e.payload({ criteria: [{ id: "S1", p: 0.71 }, { id: "S2", p: 0.95 }] }))).recorded).toBe(true);
  });
});

describe("deterministic evidence is re-derived by the broker; confidence alone cannot pass (S98-S100, S110)", () => {
  const high = { criteria: [{ id: "S1", p: 0.999 }, { id: "S2", p: 0.999 }] };

  test("an out-of-scope stage returns to the Planner even with every p high", async () => {
    const e = fixture();
    const chainID = e.stage({ "src/ok.ts": "export {};\n", "scripts/evil.sh": "x\n" });
    const out = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", "router", e.payload({ chainID, ...high })));
    expect(out).toMatchObject({ route: "RETURN_TO_PLANNER", recorded: false });
    expect(JSON.stringify(out.checks)).toContain("scripts/evil.sh");
  });

  test("an over-budget stage returns to the Planner", async () => {
    const e = fixture();
    const chainID = e.stage({ "src/big.ts": Array.from({ length: 250 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n" });
    const out = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", "router", e.payload({ chainID, ...high })));
    expect(out).toMatchObject({ route: "RETURN_TO_PLANNER", recorded: false });
    expect(out.checks.find((c: any) => c.check === "budget").passed).toBe(false);
  });

  test("a nonzero, timed-out or signalled test run returns to the Planner", async () => {
    const e = fixture();
    for (const ref of [e.log("unit", 1), e.log("unit", 0, { timedOut: true }), e.log("unit", null)]) {
      const out = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", "router", e.payload({ testRunRefs: [ref], ...high })));
      expect(out, ref).toMatchObject({ route: "RETURN_TO_PLANNER", recorded: false });
    }
    // One red run among green ones still fails.
    const both = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", "router", e.payload({ testRunRefs: [e.goodLog, e.log("unit", 2)], ...high })));
    expect(both).toMatchObject({ route: "RETURN_TO_PLANNER", recorded: false });
  });

  test("missing evidence is never a pass: no test run, an unknown or foreign log, no runner, no scope", async () => {
    const e = fixture();
    const cases: Record<string, unknown>[] = [
      { testRunRefs: [] },
      { testRunRefs: ["00000000-0000-4000-8000-ffffffffffff"] },
      { testRunRefs: [e.log("other-runner", 0)] },
    ];
    for (const over of cases) {
      const out = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", "router", e.payload({ ...over, ...high })));
      expect(out, JSON.stringify(over)).toMatchObject({ route: "SPEC_CHECK", recorded: false });
    }
    // A symlink or a forged header is not a recorded run.
    const link = "00000000-0000-4000-8000-aaaaaaaaaaaa";
    symlinkSync(join(e.stateDir, "test-runs", `${e.goodLog}.log`), join(e.stateDir, "test-runs", `${link}.log`));
    const forged = "00000000-0000-4000-8000-bbbbbbbbbbbb";
    writeFileSync(join(e.stateDir, "test-runs", `${forged}.log`), "all green, trust me\n");
    for (const ref of [link, forged]) {
      const out = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", "router", e.payload({ testRunRefs: [ref], ...high })));
      expect(out, ref).toMatchObject({ route: "SPEC_CHECK", recorded: false });
    }
    const noRunners = fixture({ runners: false });
    const out = await recordsNothing(noRunners, () => noRunners.dispatch("gateVerdictAuto", "router", noRunners.payload({ ...high })));
    expect(out).toMatchObject({ route: "SPEC_CHECK", recorded: false });
    const noScope = fixture({ plan: "# Gate feature\n\n## Specs\n- S1 one\n- S2 two\n\n## Tasks\n- T1 one\n" });
    const out2 = await recordsNothing(noScope, () => noScope.dispatch("gateVerdictAuto", "router", noScope.payload({ ...high })));
    expect(out2).toMatchObject({ route: "SPEC_CHECK", recorded: false });
    // Positive control: with the evidence present the same call records.
    expect((await e.dispatch("gateVerdictAuto", "router", e.payload({ ...high }))).recorded).toBe(true);
  });

  test("an empty diff, a stage from another state, or a REJECTED stage is not evidence", async () => {
    const e = fixture();
    const empty = e.stage({});
    const out = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", "router", e.payload({ chainID: empty, ...high })));
    expect(out).toMatchObject({ route: "SPEC_CHECK", recorded: false });
    const missing = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", "router", e.payload({ chainID: "c000000000000", ...high })));
    expect(missing).toBeInstanceOf(StateError);
    const noStage = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", "router", e.payload({ n: 2, ...high })));
    expect(noStage).toBeInstanceOf(StateError);
  });

  test("the plan-vs-spec checkpoint has no deterministic evidence: always SPEC_CHECK", async () => {
    const e = fixture();
    const out = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", "router", e.payload({ checkpoint: "plan-vs-spec", ...high })));
    expect(out).toMatchObject({ route: "SPEC_CHECK", recorded: false });
  });

  test("RETURN_TO_PLANNER and SPEC_CHECK carry reasons, never a verdict", async () => {
    const e = fixture();
    const out = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", "router", e.payload({ criteria: [{ id: "S1", p: 0.1 }, { id: "S2", p: 0.95 }] })));
    expect(out.route).toBe("RETURN_TO_PLANNER");
    expect(out.recorded).toBe(false);
    expect(out).not.toHaveProperty("verdictHash");
    expect(out.checks).toHaveLength(3);
    expect(gateLines(e.doc())).toHaveLength(0);
  });
});

describe("test evidence must be bound to the staged commit (F1), and the stage is re-checked under the lock (F2)", () => {
  const high = { criteria: [{ id: "S1", p: 0.999 }, { id: "S2", p: 0.999 }] };
  const testsMissing = (out: any) => expect(out.checks.find((c: any) => c.check === "tests")).toMatchObject({ passed: false, missing: true });

  test("a log written before the stage existed cannot clear a stage that was never tested", async () => {
    const e = fixture();
    const earlier = e.log("unit", 0); // passes, bound to the first stage's tree
    const broken = e.stage({ "src/never_tested.ts": "throw new Error('broken');\n" });
    const out = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", "router", e.payload({ chainID: broken, testRunRefs: [earlier], ...high })));
    expect(out).toMatchObject({ route: "SPEC_CHECK", recorded: false });
    testsMissing(out);
    // Positive control: a log bound to that stage's own tree records.
    expect((await e.dispatch("gateVerdictAuto", "router", e.payload({ chainID: broken, testRunRefs: [e.log("unit", 0, { forChain: broken })], ...high }))).recorded).toBe(true);
  });

  test("an unbound log (what testRun writes today), a log for another tree or project, or an older log is not evidence", async () => {
    const e = fixture();
    const other = e.stage({ "src/other.ts": "export {};\n" });
    const stale = [
      e.log("unit", 0, { bind: false }),
      e.log("unit", 0, { forChain: other }),
      e.log("unit", 0, { project: "elsewhere" }),
      e.log("unit", 0, { tree: "0".repeat(40) }),
      e.log("unit", 0, { mtimeSeconds: 1000 }),
    ];
    for (const ref of stale) {
      const out = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", "router", e.payload({ testRunRefs: [ref], ...high })));
      expect(out, ref).toMatchObject({ route: "SPEC_CHECK", recorded: false });
      testsMissing(out);
    }
    expect((await e.dispatch("gateVerdictAuto", "router", e.payload({ testRunRefs: [e.log("unit", 0)], ...high }))).recorded).toBe(true);
  });

  test("a failing bound log the caller omits does not matter: without a bound passing log the tests are missing", async () => {
    const e = fixture();
    e.log("unit", 1); // bound and failing, never referenced
    for (const refs of [[], [e.log("unit", 0, { bind: false })]]) {
      const out = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", "router", e.payload({ testRunRefs: refs, ...high })));
      expect(out).toMatchObject({ route: "SPEC_CHECK", recorded: false });
      testsMissing(out);
    }
    // A referenced bound failing log still returns to the Planner.
    const red = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", "router", e.payload({ testRunRefs: [e.log("unit", 1)], ...high })));
    expect(red).toMatchObject({ route: "RETURN_TO_PLANNER", recorded: false });
  });

  test("a stage rejected between the read and the append is refused and records nothing", async () => {
    const run = async (reject: boolean) => {
      const e = fixture();
      const git = e.ctx as unknown as { git: { spawn: (argv: string[], opts: unknown) => Promise<unknown> } };
      const real = git.git.spawn;
      let release!: () => void;
      let reached!: () => void;
      const hold = new Promise<void>((r) => (release = r));
      const at = new Promise<void>((r) => (reached = r));
      git.git.spawn = async (argv, opts) => {
        if (argv.includes("--numstat")) { reached(); await hold; }
        return real(argv, opts);
      };
      try {
        const before = e.doc();
        const commits = e.commits();
        const pending = e.dispatch("gateVerdictAuto", "router", e.payload()).catch((error) => error);
        await at;
        if (reject) {
          const result = execFileSync("git", ["rev-parse", `${REF(e.chain)}/stage/1`], { cwd: e.repo, encoding: "utf8" }).trim();
          await e.dispatch("stageReject", "rev", { chainID: e.chain, n: 1, result, note: "no" });
        }
        release();
        const out = await pending;
        return { out, unchanged: e.doc() === before && e.commits() === commits };
      } finally {
        git.git.spawn = real;
      }
    };
    const raced = await run(true);
    expect(String(raced.out.message)).toMatch(/GATE_AUTO_STAGE_STATE/);
    expect(raced.unchanged).toBe(true);
    // Positive control: the same paused call without the rejection records.
    const calm = await run(false);
    expect(calm.out).toMatchObject({ recorded: true, verdict: "PASS" });
  });

  test("a taskId that is not in the plan's Tasks section is refused", async () => {
    const e = fixture();
    const out = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", "router", e.payload({ taskId: "T99" })));
    expect(out).toBeInstanceOf(ValidationError);
    expect(String(out.message)).toMatch(/GATE_AUTO_TASK_UNKNOWN/);
    expect((await e.dispatch("gateVerdictAuto", "router", e.payload({ taskId: "T2" }))).recorded).toBe(true);
  });

  test("a bullet inside a fenced code block under Allowed edit surfaces is not scope", async () => {
    const plan = (surfaces: string) => `# Gate feature\n\n## Specs\n- S1 one\n- S2 two\n\n## Tasks\n- T1 one\n\n## Allowed edit surfaces\n- \`docs/*.md\`\n${surfaces}\n`;
    const fenced = fixture({ plan: plan("\n```\n- `**`\n```") });
    const out = await recordsNothing(fenced, () => fenced.dispatch("gateVerdictAuto", "router", fenced.payload({ ...high })));
    expect(out).toMatchObject({ route: "RETURN_TO_PLANNER", recorded: false });
    expect(out.checks.find((c: any) => c.check === "scope").passed).toBe(false);
    // Positive control: the same bullet outside a fence widens scope and records.
    const open = fixture({ plan: plan("- `**`") });
    expect((await open.dispatch("gateVerdictAuto", "router", open.payload({ ...high }))).recorded).toBe(true);
  });
});

describe("append-only semantics (D22: code can only add a first PASS)", () => {
  const plannerVerdict = (e: Env, taskId: string, verdict: string, extra: Record<string, unknown> = {}) =>
    e.dispatch("gateVerdict", "planner", { projectDir: e.repo, name: "gate-feature", taskId, verdict, agent: "planner", ...extra });

  test("a code PASS cannot supersede a Planner REFINE or ESCALATE on the same gate", async () => {
    const e = fixture();
    await plannerVerdict(e, "T1", "REFINE", { refinementPlan: "tighten scope" });
    await plannerVerdict(e, "T2", "ESCALATE");
    for (const taskId of ["T1", "T2"]) {
      const out = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", "router", e.payload({ taskId })));
      expect(out, taskId).toBeInstanceOf(PolicyError);
      expect(String(out.message)).toMatch(/GATE_AUTO_SUPERSEDE_REFUSED/);
    }
    // Another task on the same document is unaffected (positive control).
    expect((await e.dispatch("gateVerdictAuto", "router", e.payload({ taskId: "T3" }))).recorded).toBe(true);
    expect(readLatestGateVerdict(e.doc(), "T1")!.verdict).toBe("REFINE");
    expect(readLatestGateVerdict(e.doc(), "T2")!.verdict).toBe("ESCALATE");
  });

  test("a PASS already recorded by the Planner is not duplicated or re-authored by code", async () => {
    const e = fixture();
    await plannerVerdict(e, "T1", "PASS");
    const out = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", "router", e.payload()));
    expect(out).toBeInstanceOf(PolicyError);
    expect(String(out.message)).toMatch(/GATE_AUTO_PASS_EXISTS/);
  });

  test("an identical replay records at most once and returns the original hash", async () => {
    const e = fixture();
    const first = await e.dispatch("gateVerdictAuto", "router", e.payload());
    const commits = e.commits();
    const second = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", "router", e.payload()));
    expect(second).toMatchObject({ route: "RECORD_PASS", recorded: false, replayed: true, verdictHash: first.verdictHash });
    expect(e.commits()).toBe(commits);
    expect(gateLines(e.doc())).toHaveLength(1);
  });

  test("concurrent identical calls record exactly one line", async () => {
    const e = fixture();
    const results = await Promise.all([1, 2, 3].map(() => e.dispatch("gateVerdictAuto", "router", e.payload())));
    expect(results.filter((r) => r.recorded)).toHaveLength(1);
    expect(new Set(results.map((r) => r.verdictHash)).size).toBe(1);
    expect(gateLines(e.doc())).toHaveLength(1);
  });

  test("a conflicting second call (different probabilities or evidence) is refused", async () => {
    const e = fixture();
    await e.dispatch("gateVerdictAuto", "router", e.payload());
    const other = e.stage({ "src/other.ts": "export {};\n" });
    for (const over of [{ criteria: [{ id: "S1", p: 0.99 }, { id: "S2", p: 0.95 }] }, { chainID: other }]) {
      const out = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", "router", e.payload(over)));
      expect(out, JSON.stringify(over)).toBeInstanceOf(PolicyError);
      expect(String(out.message)).toMatch(/GATE_AUTO_PASS_EXISTS/);
    }
    expect(gateLines(e.doc())).toHaveLength(1);
  });

  test("the plan document must already exist and the Gates section stays final", async () => {
    const e = fixture();
    const out = await recordsNothing(e, () => e.dispatch("gateVerdictAuto", "router", e.payload({ name: "no-such-plan" })));
    expect(out).toBeInstanceOf(ValidationError);
    await e.dispatch("gateVerdictAuto", "router", e.payload());
    expect(e.doc().trimEnd().split("\n").at(-1)).toMatch(/^- T1 PASS /);
    expect(e.doc().match(/^## Gates$/gm)).toHaveLength(1);
  });
});

describe("host_gate_verdict is unchanged (pin)", () => {
  test("still Planner-only and append-only: the router and orchestrators are refused, the Planner records REFINE, ESCALATE and PASS", async () => {
    const e = fixture();
    for (const session of ["router", "orch", "pmodd", "rev", "wrk", "plain"]) {
      const out = await recordsNothing(e, () => e.dispatch("gateVerdict", session, { projectDir: e.repo, name: "gate-feature", taskId: "T1", verdict: "PASS", agent: session === "plain" ? "planner" : e.ctx.store.get(session)?.agent }));
      expect(out, session).toBeInstanceOf(Error);
    }
    await e.dispatch("gateVerdict", "planner", { projectDir: e.repo, name: "gate-feature", taskId: "T1", verdict: "REFINE", refinementPlan: "x", agent: "planner" });
    await e.dispatch("gateVerdict", "planner", { projectDir: e.repo, name: "gate-feature", taskId: "T1", verdict: "ESCALATE", agent: "planner" });
    await e.dispatch("gateVerdict", "planner", { projectDir: e.repo, name: "gate-feature", taskId: "T1", verdict: "PASS", agent: "planner", evidenceRef: "ok" });
    expect(gateLines(e.doc()).map((l) => l.split(" ")[2])).toEqual(["REFINE", "ESCALATE", "PASS"]);
    expect(gateLines(e.doc()).every((l) => l.split(" ")[4] === "planner")).toBe(true);
    expect(ALLOWED_PAYLOAD_KEYS.gateVerdict).toEqual(["projectDir", "name", "taskId", "verdict", "refinementPlan", "evidenceRef", "agent"]);
  });
});

describe("permission fragments", () => {
  test("both fragments deny the new tool (V2 would otherwise silently allow a tool with no rule)", async () => {
    for (const dir of ["config-fragments", "plugins-v2/config-fragments"]) {
      const text = readFileSync(join(import.meta.dir, "../../opencode", dir, "sandbox-permissions.jsonc"), "utf8");
      expect(text).toMatch(/"host_gate_verdict_auto": "deny"/);
      expect(text).toMatch(/"host_gate_verdict": "allow"/); // positive control: the regex sees real entries
    }
  });
});
