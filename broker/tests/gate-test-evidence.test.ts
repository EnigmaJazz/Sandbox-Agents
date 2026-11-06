/**
 * D30 (multi-tier U4d): stage-bound test evidence. At stage finish the broker runs the CONFIGURED
 * test runners inside the worker's own sandbox, on exactly the stage content, and writes a testRun
 * log whose header binds it to the project and the pinned stage result's tree. `gateVerdictAuto`
 * counts only such a log, so this is what makes its PASS path reachable.
 *
 * A real git repository (mkdtemp under the OS tmpdir) plays the host; a directory-backed adapter
 * plays the microVM (its exec runs the argv in the worker directory, like the other staging tests),
 * so ensureWorker -> prepareResult -> gateVerdictAuto run their real code end to end. No worker
 * backend (msb) is ever started; runner argv in these tests are fixed fixtures of the test config.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { defaultConfig, type TestRunnerConfig } from "../src/config.ts";
import { assertWorkerEnv, spawnArgv } from "../src/msb.ts";
import { buildEnsureWorkerOp, buildPrepareResultOp, buildTestRunOp, type OpContext } from "../src/service.ts";
import { BrokerServer } from "../src/server.ts";
import { chainAttach, chainCreate, chainStatus, stageList, stageShow } from "../src/staging-chain.ts";
import type { BrokerRequestEnvelope } from "../src/types.ts";

const GiB = 1024 ** 3;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const ORCH = "gentle-orchestrator";
const ROUTER = "gate-router";
const REVIEWER = "stage-review";
const IMPL = "implementation-vs-spec";
const HEX = /^[0-9a-f]{40}$/;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();

const PLAN = `# Gate feature

## Specs
- S1 the first criterion
- S2 the second criterion

## Tasks
- T1 the feature
- T1.impl its implementation gate

## Allowed edit surfaces
- \`src/**\`
`;

const runner = (id: string, argv: string[], over: Partial<TestRunnerConfig> = {}): TestRunnerConfig =>
  ({ id, language: "sh", argv, cwd: ".", timeoutMs: 20_000, maxOutputBytes: 1024 * 1024, ...over });
const sh = (id: string, script: string, over: Partial<TestRunnerConfig> = {}) => runner(id, ["/bin/sh", "-c", script], over);

interface Exec { argv: string[]; cwd?: string; env?: Record<string, string> }
interface Opts {
  runners?: TestRunnerConfig[];
  /** Runs before every sandbox exec (worker directory given): simulates a racing worker or a sandbox that vanished. */
  beforeExec?: (argv: string[], workerDir: string) => void | Promise<void>;
}

function harness(opts: Opts = {}) {
  const base = mkdtempSync(join(tmpdir(), "gate-test-evidence-"));
  roots.push(base);
  const repo = join(base, "repo");
  const stateDir = join(base, "state");
  const workers = join(base, "workers");
  for (const d of [repo, stateDir, workers, join(repo, "odd/tasks")]) mkdirSync(d, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@local");
  writeFileSync(join(repo, "a.txt"), "a\n");
  writeFileSync(join(repo, "odd/tasks/gate-feature.md"), PLAN);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");

  const server = new BrokerServer(
    defaultConfig({
      stateDir,
      projects: [{ id: "repo", path: repo }],
      readOnlyAgents: [ORCH],
      stageReviewAgents: [REVIEWER],
      gateRouterAgents: [ROUTER],
      testRunners: opts.runners ?? [],
    }),
  );
  const internals = server as unknown as { ctx: OpContext & { store: { touch(id: string, patch: Record<string, unknown>): unknown } }; dispatch(req: BrokerRequestEnvelope): Promise<unknown> };
  (internals.ctx as { git: unknown }).git = { runnerMode: "real", spawn: spawnArgv };
  internals.ctx.store.touch("router", { agent: ROUTER });

  const execs: Exec[] = [];
  const dirOf = (name: string) => join(workers, name);
  const mapPath = (name: string) => (a: string) => (a.startsWith("/work") ? join(dirOf(name), a.slice("/work".length)) : a);
  const adapter = {
    workerNameFor: (id: string) => `worker-${id}`,
    createWorker: async (spec: { name: string }) => void mkdirSync(dirOf(spec.name), { recursive: true }),
    copyIn: async (name: string, src: string, dest: string) => void copyFileSync(src, mapPath(name)(dest)),
    copyOut: async (name: string, src: string, dest: string) => void copyFileSync(mapPath(name)(src), dest),
    exec: async (name: string, argv: string[], o: { cwd?: string; timeoutMs?: number; env?: Record<string, string>; maxOutputBytes?: number } = {}) => {
      execs.push({ argv: [...argv], ...(o.cwd === undefined ? {} : { cwd: o.cwd }), ...(o.env === undefined ? {} : { env: o.env }) });
      // The real adapter validates every env key against the worker allowlist; so does this one.
      assertWorkerEnv(o.env, internals.ctx.config.resource.envAllowedKeys);
      await opts.beforeExec?.(argv, dirOf(name));
      const map = mapPath(name);
      const env = o.env && Object.fromEntries(Object.entries(o.env).map(([k, v]) => [k, map(v)]));
      return spawnArgv(argv.map(map), { cwd: map(o.cwd ?? "/work"), env, timeoutMs: o.timeoutMs, maxOutputBytes: o.maxOutputBytes });
    },
    stop: async () => undefined,
    remove: async () => undefined,
  };
  const ctx = {
    ...internals.ctx,
    adapter,
    budget: { perWorkerCpu: 2, perWorkerMemBytes: 2 * GiB, maxAggregateCpu: 32, maxAggregateMemBytes: 32 * GiB, maxWorkers: 16, hostReservedCpu: 4, hostReservedMemBytes: 8 * GiB },
    resources: { cpuCount: 16, totalMemBytes: 64 * GiB },
    pool: { allocations: [] },
  } as unknown as OpContext;

  const req = (operation: string, sessionID: string, payload: Record<string, unknown>): BrokerRequestEnvelope =>
    ({ version: 1, id: `${operation}-${sessionID}`, operation, sessionID, payload }) as BrokerRequestEnvelope;
  const chain = chainCreate(ctx, { projectID: "repo", lane: "feature" }).id;
  const put = (session: string, path: string, content: string) => {
    mkdirSync(join(dirOf(`worker-${session}`), path, ".."), { recursive: true });
    writeFileSync(join(dirOf(`worker-${session}`), path), content);
  };
  /** Start stage 1 of the chain, let the worker write `files`, and finish it. */
  const stageOne = async (files: Record<string, string> = { "src/feature.ts": "export const x = 1;\n" }, session = "s1") => {
    await buildEnsureWorkerOp(ctx)(req("ensureWorker", session, { projectDir: repo }));
    await chainAttach(ctx, chain, session);
    for (const [path, content] of Object.entries(files)) put(session, path, content);
    return buildPrepareResultOp(ctx)(req("prepareResult", session, {}));
  };
  const stage = async () => (await stageShow(ctx, chain, 1)).stage as Awaited<ReturnType<typeof stageShow>>["stage"] & { testRunRefs?: string[] };
  const logFile = (id: string) => join(stateDir, "test-runs", `${id}.log`);
  const readLog = (id: string) => readFileSync(logFile(id), "utf8");
  const logs = () => (existsSync(join(stateDir, "test-runs")) ? readdirSync(join(stateDir, "test-runs")) : []);
  const treeOfStage = async () => git(repo, "rev-parse", `${(await stage()).result}^{tree}`);
  const gate = (testRunRefs: string[], over: Record<string, unknown> = {}) =>
    internals.dispatch({
      version: 1, id: "g", operation: "gateVerdictAuto", sessionID: "router",
      payload: {
        projectDir: repo, name: "gate-feature", taskId: "T1", checkpoint: IMPL, chainID: chain, n: 1,
        expectedCriteria: ["S1", "S2"], criteria: [{ id: "S1", p: 0.9 }, { id: "S2", p: 0.95 }], testRunRefs, ...over,
      },
    } as BrokerRequestEnvelope) as Promise<any>;
  return { ctx, repo, stateDir, chain, execs, stageOne, stage, logFile, readLog, logs, treeOfStage, gate, put, req, dirOf, doc: () => readFileSync(join(repo, "odd/tasks/gate-feature.md"), "utf8") };
}

/** The runner execs among a harness's sandbox calls: configured runners are absolute paths, the broker's own plumbing (git, mkdir, rm) is not. */
const runnerExecs = (execs: Exec[]) => execs.filter((e) => e.argv[0]!.startsWith("/"));

describe("a passing runner", () => {
  test("is run in the sandbox and recorded as a bound log; gateVerdictAuto then records a PASS end to end", async () => {
    const h = harness({ runners: [sh("unit", "pwd; echo tests-ok")] });
    await h.stageOne();
    const stage = await h.stage();
    expect(stage.state).toBe("READY");
    expect(stage.testRunRefs).toHaveLength(1);
    const text = h.readLog(stage.testRunRefs![0]!);
    const tree = await h.treeOfStage();
    expect(tree).toMatch(HEX);
    // The exact header format gateVerdictAuto reads (a literal backslash-n ends it), with the binding after the flags.
    expect(text.startsWith(`runner=unit exitCode=0 signal=null timedOut=false truncated=false project=repo tree=${tree}\\nstdout\\n`)).toBe(true);
    // It ran inside the worker directory, not the host project.
    expect(text).toContain(h.dirOf("worker-s1"));
    expect(text).not.toContain(`${h.repo}\n`);
    expect(text).toContain("tests-ok");
    // The sandbox exec used the configured argv, the worker's /work tree and the allowlisted env only.
    const ran = h.execs.find((e) => e.argv[0] === "/bin/sh" && e.argv[2] === "pwd; echo tests-ok")!;
    expect(ran.cwd).toBe("/work");
    expect(ran.env).toEqual({ CI: "1", NO_COLOR: "1" });

    const before = h.doc();
    const result = await h.gate(stage.testRunRefs!);
    expect(result).toMatchObject({ route: "RECORD_PASS", recorded: true, verdict: "PASS", taskId: "T1" });
    expect(h.doc().startsWith(before)).toBe(true);
    expect(h.doc()).toMatch(/tests:pass/);
  }, 60_000);

  test("positive control: the same gate call with no evidence records nothing", async () => {
    const h = harness({ runners: [sh("unit", "true")] });
    await h.stageOne();
    const before = h.doc();
    const result = await h.gate([]);
    expect(result).toMatchObject({ route: "SPEC_CHECK", recorded: false });
    expect(h.doc()).toBe(before);
  }, 60_000);

  test("every configured runner gets its own bound log, in config order; a missing one is not a pass", async () => {
    const h = harness({ runners: [sh("unit", "true"), sh("lint", "true")] });
    await h.stageOne();
    const stage = await h.stage();
    expect(stage.testRunRefs).toHaveLength(2);
    expect(stage.testRunRefs!.map((id) => /^runner=(\S+)/.exec(h.readLog(id))![1])).toEqual(["unit", "lint"]);
    expect((await h.gate(stage.testRunRefs!)).route).toBe("RECORD_PASS");
    const h2 = harness({ runners: [sh("unit", "true"), sh("lint", "true")] });
    await h2.stageOne();
    const only = (await h2.stage()).testRunRefs!.slice(0, 1);
    expect(await h2.gate(only)).toMatchObject({ route: "SPEC_CHECK", recorded: false });
  }, 60_000);
});

describe("a runner that does not pass is never a pass", () => {
  test("a non-zero exit records a bound FAILING log and the gate routes back to the planner", async () => {
    const h = harness({ runners: [sh("unit", "echo boom >&2; exit 3")] });
    await h.stageOne();
    const stage = await h.stage();
    expect(stage.state).toBe("READY"); // registration is not blocked by a failing test
    const text = h.readLog(stage.testRunRefs![0]!);
    expect(text.startsWith(`runner=unit exitCode=3 signal=null timedOut=false truncated=false project=repo tree=${await h.treeOfStage()}\\n`)).toBe(true);
    expect(text).toContain("boom");
    const before = h.doc();
    expect(await h.gate(stage.testRunRefs!)).toMatchObject({ route: "RETURN_TO_PLANNER", recorded: false });
    expect(h.doc()).toBe(before);
  }, 60_000);

  test("one failing runner among passing ones fails the check", async () => {
    const h = harness({ runners: [sh("unit", "true"), sh("lint", "exit 1")] });
    await h.stageOne();
    expect(await h.gate((await h.stage()).testRunRefs!)).toMatchObject({ route: "RETURN_TO_PLANNER", recorded: false });
  }, 60_000);

  test("a timeout is recorded as timedOut with no exit code and routes back", async () => {
    // The runner exits 0 when it is terminated: only the timedOut flag stops that from being a pass.
    const h = harness({ runners: [sh("unit", "trap 'exit 0' TERM; sleep 30 >/dev/null 2>&1 & wait", { timeoutMs: 1000 })] });
    await h.stageOne();
    const stage = await h.stage();
    const text = h.readLog(stage.testRunRefs![0]!);
    expect(text).toMatch(/^runner=unit exitCode=null signal=\S+ timedOut=true truncated=false project=repo tree=[0-9a-f]{40}\\nstdout/);
    expect(await h.gate(stage.testRunRefs!)).toMatchObject({ route: "RETURN_TO_PLANNER", recorded: false });
  }, 60_000);

  test("a runner killed by a signal has no exit code and is not a pass", async () => {
    const h = harness({ runners: [sh("unit", "kill -9 $$")] });
    await h.stageOne();
    const stage = await h.stage();
    expect(h.readLog(stage.testRunRefs![0]!)).toMatch(/^runner=unit exitCode=null signal=\S+ timedOut=false /);
    expect(await h.gate(stage.testRunRefs!)).toMatchObject({ route: "RETURN_TO_PLANNER", recorded: false });
  }, 60_000);

  test("a runner that cannot start is not a pass (exit 127 and a missing executable)", async () => {
    for (const r of [sh("unit", "exit 127"), runner("unit", ["/nonexistent/runner"])]) {
      const h = harness({ runners: [r] });
      await h.stageOne();
      const stage = await h.stage();
      expect(stage.state).toBe("READY");
      expect(stage.testRunRefs, r.argv.join(" ")).toHaveLength(1);
      expect(await h.gate(stage.testRunRefs!), r.argv.join(" ")).toMatchObject({ route: "RETURN_TO_PLANNER", recorded: false });
    }
  }, 60_000);
});

describe("the binding is to the stage content (tree equality is a real check)", () => {
  test("positive control: the logged tree is the tree of the pinned stage result commit", async () => {
    const h = harness({ runners: [sh("unit", "true")] });
    await h.stageOne();
    const stage = await h.stage();
    const logged = /tree=([0-9a-f]+)\\n/.exec(h.readLog(stage.testRunRefs![0]!))![1];
    expect(logged).toBe(git(h.repo, "rev-parse", `${stage.result}^{tree}`));
    expect(logged).toBe(git(h.repo, "rev-parse", `refs/opencode-sandbox/chain/${h.chain}/stage/1^{tree}`));
  }, 60_000);

  test("content that differs from the imported stage when the tests start writes NO evidence, and the runner does not run", async () => {
    let armed = true;
    const h = harness({
      runners: [sh("unit", "echo ran-marker")],
      // A racing worker changes a tracked file after its result was committed, before the evidence run.
      beforeExec: (argv, dir) => {
        if (armed && argv.includes("read-tree")) { armed = false; writeFileSync(join(dir, "src/feature.ts"), "export const x = 2; // changed after finish\n"); }
      },
    });
    await h.stageOne();
    expect(armed).toBe(false); // the hook fired, so the probe could detect a change
    const stage = await h.stage();
    expect(stage.state).toBe("READY");
    expect(stage.testRunRefs).toBeUndefined();
    expect(h.logs()).toEqual([]);
    expect(runnerExecs(h.execs)).toEqual([]);
    expect(await h.gate([])).toMatchObject({ route: "SPEC_CHECK", recorded: false });
  }, 60_000);

  test("a runner that changes the tested tree invalidates its own evidence", async () => {
    const h = harness({ runners: [sh("unit", "echo tampered >> src/feature.ts")] });
    await h.stageOne();
    const stage = await h.stage();
    expect(stage.state).toBe("READY");
    expect(stage.testRunRefs).toBeUndefined();
    expect(h.logs()).toEqual([]);
  }, 60_000);

  test("a new untracked file created by the runner invalidates its evidence", async () => {
    const h = harness({ runners: [sh("unit", "echo x > leftover.txt")] });
    await h.stageOne();
    expect((await h.stage()).testRunRefs).toBeUndefined();
    expect(h.logs()).toEqual([]);
  }, 60_000);
});

describe("infrastructure failure never blocks or alters registration", () => {
  for (const mode of ["the sandbox vanishes", "the runner exec fails"] as const) {
    test(`${mode}: no log is written, the stage is registered, tests are missing (SPEC_CHECK)`, async () => {
      let exported = false;
      const h = harness({
        runners: [sh("unit", "true")],
        beforeExec: (argv) => {
          // read-tree is the first exec of the evidence step; everything before it is the result export.
          if (argv.includes("read-tree")) exported = true;
          if (exported && (mode === "the sandbox vanishes" || argv[0] === "/bin/sh")) throw new Error("sandbox gone");
        },
      });
      const result = (await h.stageOne()) as { resultRef: string; state: string; imported: boolean };
      expect(exported).toBe(true); // the failure was injected, so the probe could detect it
      expect(result).toEqual({ resultRef: "refs/opencode-sandbox/result/s1", state: "RESULT_READY", imported: true });
      const stage = await h.stage();
      expect(stage.state).toBe("READY");
      expect(stage.result).toMatch(HEX);
      expect(stage.testRunRefs).toBeUndefined();
      expect(h.logs()).toEqual([]);
      expect((await chainStatus(h.ctx, h.chain)).nextSnapshot).toEqual({ resultRef: "refs/opencode-sandbox/result/s1" });
      expect(await h.gate([])).toMatchObject({ route: "SPEC_CHECK", recorded: false });
    }, 60_000);
  }
});

describe("runner argv comes only from broker configuration", () => {
  test("a hostile config-like file in the stage content is ignored", async () => {
    const h = harness({ runners: [sh("unit", "exit 0")] });
    await h.stageOne({
      "src/feature.ts": "export const x = 1;\n",
      "broker-test-runners.json": JSON.stringify([{ id: "unit", argv: ["/bin/sh", "-c", "HOSTILE_RUNNER; exit 1"], cwd: ".", timeoutMs: 1000, maxOutputBytes: 1024 }]),
      "package.json": JSON.stringify({ scripts: { test: "HOSTILE_RUNNER" } }),
      "Makefile": "test:\n\tHOSTILE_RUNNER\n",
      "odd/tasks/gate-feature.md": "# hostile plan\n\n- /bin/false\n",
    });
    const stage = await h.stage();
    const flat = JSON.stringify(h.execs.map((e) => e.argv));
    expect(flat).not.toContain("HOSTILE_RUNNER");
    // The runner exec is exactly the configured argv.
    expect(h.execs.filter((e) => e.argv[0] === "/bin/sh").map((e) => e.argv)).toEqual([["/bin/sh", "-c", "exit 0"]]);
    expect(h.readLog(stage.testRunRefs![0]!)).toMatch(/^runner=unit exitCode=0 /);
  }, 60_000);

  test("the runner's cwd is the configured relative directory under /work", async () => {
    const h = harness({ runners: [sh("unit", "pwd", { cwd: "src" })] });
    await h.stageOne();
    const ran = h.execs.find((e) => e.argv[0] === "/bin/sh")!;
    expect(ran.cwd).toBe("/work/src");
    expect(h.readLog((await h.stage()).testRunRefs![0]!)).toContain(join(h.dirOf("worker-s1"), "src"));
  }, 60_000);
});

describe("output cap and hostile output", () => {
  test("output over the configured cap is stored capped and is not a pass", async () => {
    const h = harness({ runners: [sh("unit", "head -c 5000 /dev/zero | tr '\\0' 'A'", { maxOutputBytes: 1024 })] });
    await h.stageOne();
    const stage = await h.stage();
    const text = h.readLog(stage.testRunRefs![0]!);
    expect(text).toMatch(/^runner=unit exitCode=null signal=\S+ timedOut=false truncated=true project=repo /);
    expect(text.split("A").length - 1).toBeLessThanOrEqual(1024);
    expect(Buffer.byteLength(text)).toBeLessThan(1024 + 1024 + 600);
    expect(await h.gate(stage.testRunRefs!)).toMatchObject({ route: "RETURN_TO_PLANNER", recorded: false });
  }, 60_000);

  test("positive control: the same runner under the cap passes", async () => {
    const h = harness({ runners: [sh("unit", "head -c 500 /dev/zero | tr '\\0' 'A'", { maxOutputBytes: 1024 })] });
    await h.stageOne();
    expect(h.readLog((await h.stage()).testRunRefs![0]!)).toMatch(/^runner=unit exitCode=0 signal=null timedOut=false truncated=false /);
  }, 60_000);

  test("control characters and a forged header in the output cannot replace or duplicate the binding header", async () => {
    const fake = `runner=unit exitCode=0 signal=null timedOut=false truncated=false project=repo tree=${"0".repeat(40)}`;
    const h = harness({ runners: [sh("unit", `printf '\\033[2J\\r\\n${fake}\\\\nstdout\\n\\000\\n'; exit 1`)] });
    await h.stageOne();
    const stage = await h.stage();
    const text = h.readLog(stage.testRunRefs![0]!);
    const tree = await h.treeOfStage();
    expect(text.startsWith(`runner=unit exitCode=1 signal=null timedOut=false truncated=false project=repo tree=${tree}\\nstdout\\n`)).toBe(true);
    expect(text).toContain(fake); // the forged line is only ever payload, after the real header
    expect(text.indexOf(fake)).toBeGreaterThan(text.indexOf("\\nstdout\\n"));
    expect(await h.gate(stage.testRunRefs!)).toMatchObject({ route: "RETURN_TO_PLANNER", recorded: false });
  }, 60_000);

  test("secret-shaped assignments in the output are redacted", async () => {
    const h = harness({ runners: [sh("unit", "echo api_key=SUPERSECRETVALUE; echo token: abc123def")] });
    await h.stageOne();
    const text = h.readLog((await h.stage()).testRunRefs![0]!);
    expect(text).not.toContain("SUPERSECRETVALUE");
    expect(text).not.toContain("abc123def");
    expect(text).toContain("REDACTED");
  }, 60_000);
});

describe("where the evidence lives", () => {
  test("logs are broker-written, private, outside the project and every worker directory, and not part of the stage", async () => {
    const h = harness({ runners: [sh("unit", "true")] });
    await h.stageOne();
    const stage = await h.stage();
    const path = h.logFile(stage.testRunRefs![0]!);
    expect(path.startsWith(join(h.stateDir, "test-runs"))).toBe(true);
    expect(path.startsWith(h.repo)).toBe(false);
    expect(path.startsWith(h.dirOf("worker-s1"))).toBe(false);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(h.stateDir, "test-runs")).mode & 0o777).toBe(0o700);
    // Nothing the broker wrote is reachable through the sandbox exec path: no sandbox call named the state directory.
    expect(JSON.stringify(h.execs)).not.toContain(h.stateDir);
    // The worker tree and the pinned result contain no log.
    expect(git(h.repo, "ls-tree", "-r", "--name-only", stage.result!)).not.toMatch(/test-runs|\.log/);
  }, 60_000);

  test("the stage record carries only well-formed log ids, and gateVerdictAuto re-validates them itself", async () => {
    const h = harness({ runners: [sh("unit", "true")] });
    await h.stageOne();
    const stage = await h.stage();
    expect(stage.testRunRefs![0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // Tamper with the stored record: a wrong-tree log cited from the stage record is still not evidence.
    const text = h.readLog(stage.testRunRefs![0]!);
    writeFileSync(h.logFile(stage.testRunRefs![0]!), text.replace(/tree=[0-9a-f]{40}/, `tree=${"1".repeat(40)}`));
    expect(await h.gate(stage.testRunRefs!)).toMatchObject({ route: "SPEC_CHECK", recorded: false });
    writeFileSync(h.logFile(stage.testRunRefs![0]!), text.replace(/ project=repo/, " project=other"));
    expect(await h.gate(stage.testRunRefs!)).toMatchObject({ route: "SPEC_CHECK", recorded: false });
    writeFileSync(h.logFile(stage.testRunRefs![0]!), text);
    expect((await h.gate(stage.testRunRefs!)).route).toBe("RECORD_PASS");
  }, 60_000);
});

describe("limits of the tree binding", () => {
  test("a configured clean filter in the sandbox repository leaves no evidence (add could hash other bytes than the runner reads)", async () => {
    let armed = true;
    let exported = false;
    const h = harness({
      runners: [sh("unit", "true")],
      beforeExec: (argv, dir) => {
        // Fires right before the broker's filter probe (the first evidence exec), so only the probe itself can stop the hashing.
        if (argv.includes("bundle")) exported = true;
        if (exported && armed && argv[0] === "git" && argv[1] === "config") { armed = false; execFileSync("git", ["config", "filter.sneaky.clean", "cat"], { cwd: dir }); }
      },
    });
    await h.stageOne();
    expect(armed).toBe(false);
    expect(h.execs.some((e) => e.argv.includes("read-tree"))).toBe(false);
    expect((await h.stage()).testRunRefs).toBeUndefined();
    expect(h.logs()).toEqual([]);
  }, 60_000);

  test("the tree is computed with the worker's fsmonitor disabled and a throwaway index, never the worker's own", async () => {
    const h = harness({ runners: [sh("unit", "true")] });
    await h.stageOne();
    const reads = h.execs.filter((e) => e.argv.includes("read-tree") || e.argv.includes("write-tree"));
    expect(reads.length).toBeGreaterThanOrEqual(4); // before and after the runners
    for (const e of reads) {
      expect(e.env).toMatchObject({ GIT_CONFIG_KEY_1: "core.fsmonitor", GIT_CONFIG_VALUE_1: "false" });
      expect(e.env!.GIT_INDEX_FILE).toMatch(/^\/work\/\.broker-tmp\/evidence-[0-9a-f-]{36}\.index$/);
    }
    // The throwaway indexes are removed again.
    expect(readdirSync(join(h.dirOf("worker-s1"), ".broker-tmp")).filter((f) => f.endsWith(".index"))).toEqual([]);
  }, 60_000);

  test("KNOWN RESIDUAL (owner decision): a gitignored file in the sandbox tree is visible to the runner but is not part of the stage", async () => {
    const h = harness({ runners: [sh("unit", "test -f helper.sh")] });
    await buildEnsureWorkerOp(h.ctx)(h.req("ensureWorker", "s1", { projectDir: h.repo }));
    await chainAttach(h.ctx, h.chain, "s1");
    h.put("s1", "src/feature.ts", "export const x = 1;\n");
    h.put("s1", ".gitignore", "helper.sh\n");
    h.put("s1", "helper.sh", "echo hi\n");
    await buildPrepareResultOp(h.ctx)(h.req("prepareResult", "s1", {}));
    const stage = await h.stage();
    expect(git(h.repo, "ls-tree", "-r", "--name-only", stage.result!)).not.toContain("helper.sh");
    expect(h.readLog(stage.testRunRefs![0]!)).toMatch(/^runner=unit exitCode=0 /);
  }, 60_000);
});

describe("no stage content runs on the host", () => {
  test("a host testRun log carries no binding and is never evidence; it is also unchanged in format", async () => {
    const h = harness({ runners: [sh("unit", "true")] });
    await h.stageOne();
    const stage = await h.stage();
    h.ctx.store.touch("orch", { agent: ORCH });
    const hostRun = await buildTestRunOp(h.ctx)(h.req("testRun", "orch", { projectDir: h.repo, runner: "unit" })) as { exitCode: number; logArtifact: string };
    expect(hostRun.exitCode).toBe(0);
    expect(readFileSync(hostRun.logArtifact, "utf8")).toBe("runner=unit exitCode=0 signal=null timedOut=false truncated=false\\nstdout\\n\\nstderr\\n");
    const hostId = basename(hostRun.logArtifact, ".log");
    expect(await h.gate([hostId])).toMatchObject({ route: "SPEC_CHECK", recorded: false });
    // Positive control: the sandbox-bound log of the same stage records.
    expect((await h.gate(stage.testRunRefs!)).route).toBe("RECORD_PASS");
  }, 60_000);
});

describe("unchanged behaviour", () => {
  test("a chain without evidence serialises exactly as before (key set and order)", async () => {
    for (const runners of [[], [sh("unit", "echo tampered >> src/feature.ts")]]) {
      const h = harness({ runners });
      await h.stageOne();
      const [listed] = (await stageList(h.ctx, h.chain)).stages;
      expect(Object.keys(listed!)).toEqual(["n", "sessionID", "state", "baseline", "result", "changedPaths", "touchesProtected"]);
      expect(JSON.stringify(listed)).not.toContain("testRunRefs");
      expect(Object.keys(h.ctx.store.get("s1")!.chain!)).toEqual(["id", "n", "baseline"]);
      expect(h.logs()).toEqual([]);
    }
  }, 60_000);

  test("no runners configured: the evidence step issues no sandbox call and no log directory appears", async () => {
    const without = harness({ runners: [] });
    await without.stageOne();
    expect(without.logs()).toEqual([]);
    expect(without.execs.some((e) => e.argv.includes("read-tree") || e.argv.includes("write-tree"))).toBe(false);
  }, 60_000);

  test("a session outside any chain: finishing runs no runner and writes no log", async () => {
    const h = harness({ runners: [sh("unit", "true")] });
    await buildEnsureWorkerOp(h.ctx)(h.req("ensureWorker", "plain", { projectDir: h.repo }));
    h.put("plain", "b.txt", "b\n");
    const result = await buildPrepareResultOp(h.ctx)(h.req("prepareResult", "plain", {}));
    expect(result).toEqual({ resultRef: "refs/opencode-sandbox/result/plain", state: "RESULT_READY", imported: true });
    expect(h.logs()).toEqual([]);
    expect(runnerExecs(h.execs)).toEqual([]);
    expect(h.ctx.store.get("plain")!.chain).toBeUndefined();
  }, 60_000);

  test("an idempotent re-finish of the same stage keeps it registered and leaves a valid bound log", async () => {
    const h = harness({ runners: [sh("unit", "true")] });
    await h.stageOne();
    const first = await h.stage();
    await buildPrepareResultOp(h.ctx)(h.req("prepareResult", "s1", {}));
    const again = await h.stage();
    expect(again.result).toBe(first.result!);
    expect(again.testRunRefs).toHaveLength(1);
    expect((await h.gate(again.testRunRefs!)).route).toBe("RECORD_PASS");
  }, 60_000);
});
