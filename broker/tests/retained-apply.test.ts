/**
 * T10 / F1 + D1: the PUBLIC plugin path after a finish released the worker.
 *
 * This is an end-to-end test of the real tool table (`sandbox_apply`,
 * `sandbox_diff`) against the real broker operation builders, a real temporary
 * Git repository, and an EMULATED VM adapter (a local directory standing in for
 * `/work`). No live broker, no live msb VM and no host project is touched.
 *
 * The scenario proves all of:
 *   - `sandbox_finish` exports the result and releases the transient worker;
 *   - the retained preview artifacts (bounded `applyPreview` + the complete
 *     plain/ANSI files) exist BEFORE any apply;
 *   - `sandbox_diff` after the finish reads the RETAINED result and never
 *     re-creates a worker;
 *   - approval denial applies nothing and leaves the result intact;
 *   - approved `sandbox_apply` updates the host working tree and ends APPLIED;
 *   - a session with no live worker and no result fails closed (no activation).
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The child runs from the repository root so the real plugin sources resolve. */
const REPO_ROOT = join(import.meta.dir, "../..");

const SCRIPT = String.raw`
import { mock } from "bun:test";

// The plugin only needs tool() and the zod argument schemas it never parses
// here (execute is called directly, exactly as the host adapter does).
mock.module("@opencode-ai/plugin", () => ({ tool: (definition) => definition }));
const schema = new Proxy({}, { get: () => () => schema });
mock.module("zod", () => ({ z: new Proxy({}, { get: () => () => schema }) }));

const fs = await import("node:fs");
const path = await import("node:path");
const { spawnSync } = await import("node:child_process");

const root = process.env.Q114_ROOT;
const hostRepo = path.join(root, "host");
const stateDir = path.join(root, "state");
const work = path.join(root, "work");
fs.mkdirSync(hostRepo, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(work, { recursive: true });

const run = (cwd, argv, env) =>
  spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", ...(env ?? {}) },
    timeout: 120000,
  });

// A real temporary Git repository as the host project.
const host = (argv) => run(hostRepo, ["git", ...argv]);
host(["init", "-q"]);
host(["config", "user.email", "t@local"]);
host(["config", "user.name", "t"]);
fs.writeFileSync(path.join(hostRepo, "a.txt"), "original\n");
host(["add", "-A"]);
host(["commit", "-q", "-m", "base"]);

const { defaultConfig } = await import("./broker/src/config.ts");
const { SessionStore } = await import("./broker/src/state.ts");
const svc = await import("./broker/src/service.ts");

const config = defaultConfig({
  stateDir,
  projects: [{ id: "repo", path: hostRepo }],
  workerImage: "test-image",
  testRunners: [],
});
const store = new SessionStore(stateDir);
const calls = { created: 0, stopped: [], removed: [] };
const workerName = "worker-s1";

// ---- Emulated VM adapter: a local directory is the guest /work ------------
const inside = (p) => (p.startsWith("/work") ? path.join(work, p.slice("/work".length)) : p);
const execIn = async (_name, argv, opts = {}) => {
  const cwd = opts.cwd && opts.cwd !== "/work" ? path.join(work, opts.cwd.replace(/^\/work\/?/, "")) : work;
  // The guest only knows /work; this emulated VM translates it to the host dir.
  const guestArgv = argv.map((a) => (a === "/work" || a.startsWith("/work/") ? inside(a) : a));
  const r = run(fs.existsSync(cwd) ? cwd : work, guestArgv, opts.env);
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut: false };
};
const adapter = {
  workerNameFor: () => workerName,
  createWorker: async () => { calls.created++; },
  copyIn: async (_n, src, dst) => {
    fs.mkdirSync(path.dirname(inside(dst)), { recursive: true });
    fs.copyFileSync(src, inside(dst));
  },
  copyOut: async (_n, src, dst) => { fs.copyFileSync(inside(src), dst); },
  exec: execIn,
  stop: async (n) => { calls.stopped.push(n); },
  remove: async (n) => { calls.removed.push(n); },
};

const ctx = {
  config,
  store,
  adapter,
  budget: {
    perWorkerCpu: 2, perWorkerMemBytes: 2 * 1024 * 1024 * 1024,
    maxAggregateCpu: 8, maxAggregateMemBytes: 8 * 1024 * 1024 * 1024,
    maxWorkers: 4, hostReservedCpu: 4, hostReservedMemBytes: 4 * 1024 * 1024 * 1024,
  },
  resources: { cpuCount: 16, totalMemBytes: 32 * 1024 * 1024 * 1024 },
  pool: { allocations: [] },
  sessionLocks: new Map(),
  activeLocks: new Map(),
  hostRead: { has: () => false },
  logger: { log: () => {} },
  git: {
    runnerMode: "real",
    spawn: async (argv, opts = {}) => {
      const r = run(opts.cwd ?? hostRepo, argv, opts.env);
      return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut: false };
    },
  },
};

// ---- The broker dispatch the plugin client talks to ----------------------
const builders = {
  ensureWorker: () => svc.buildEnsureWorkerOp(ctx),
  writeFile: () => svc.buildWriteFileOp(ctx),
  prepareResult: () => svc.buildPrepareResultOp(ctx),
  workerStatus: () => svc.buildWorkerStatusOp(ctx),
  diff: () => svc.buildDiffOp(ctx),
  applyResult: () => svc.buildApplyResultOp(ctx),
};
const dispatch = async (operation, sessionID, payload, agent) => {
  const build = builders[operation];
  if (!build) throw new Error("operation not wired in this test: " + operation);
  return build()({ version: 1, id: "test-" + operation, operation, sessionID, agent, payload });
};
mock.module("./opencode/plugins/lib/broker-client.ts", () => ({
  createBrokerClient: async () => ({ request: dispatch }),
  brokerSocketPath: () => "/tmp/q114-retained-apply.sock",
}));

const { sandboxToolSpecs } = await import("./opencode/plugins/lib/tool-specs-sandbox.ts");
const tools = sandboxToolSpecs;

const approvals = [];
let denyNext = false;
const toolCtx = {
  sessionID: "s1",
  agent: "odd-apply",
  directory: hostRepo,
  ask: async (request) => {
    approvals.push(request);
    if (denyNext) throw new Error("user denied the apply");
  },
};

const observations = {};

// 1. write + finish: the export releases the transient worker.
await tools.sandbox_write.execute({ path: "a.txt", content: "changed\n" }, toolCtx);
await tools.sandbox_finish.execute({}, toolCtx);
const finished = store.get("s1");
observations.afterFinish = {
  state: finished.state,
  resultRef: finished.resultRef,
  workerName: finished.workerName ?? null,
  stopped: [...calls.stopped],
  created: calls.created,
};
const previewDir = path.join(stateDir, "apply-preview");

// 2. public diff after the finish: retained mode, no worker re-created.
const createdBeforeDiff = calls.created;
const diffText = await tools.sandbox_diff.execute({}, toolCtx);
observations.diff = {
  containsChangedLine: typeof diffText === "string" && diffText.includes("+changed"),
  createdDuringDiff: calls.created - createdBeforeDiff,
};
// The retained diff writes the SAME complete artifacts the active path writes.
observations.previewFilesBeforeApply = fs.existsSync(previewDir) ? fs.readdirSync(previewDir).sort() : [];
observations.previewPlainFromDiff = null;

// 3. denial applies nothing and keeps the result.
denyNext = true;
let denied = null;
try {
  await tools.sandbox_apply.execute({}, toolCtx);
} catch (err) {
  denied = err instanceof Error ? err.message : String(err);
}
denyNext = false;
observations.denied = {
  error: denied,
  state: store.get("s1").state,
  hostContent: fs.readFileSync(path.join(hostRepo, "a.txt"), "utf8"),
  approvals: approvals.length,
  approvalMetadata: approvals[0]?.metadata ?? null,
};

// 4. approved apply: the host tree changes and the session ends APPLIED.
await tools.sandbox_apply.execute({}, toolCtx);
const applied = store.get("s1");
observations.applied = {
  state: applied.state,
  resultRef: applied.resultRef,
  workerName: applied.workerName ?? null,
  hostContent: fs.readFileSync(path.join(hostRepo, "a.txt"), "utf8"),
  approvals: approvals.length,
  lastApproval: approvals[approvals.length - 1]?.metadata ?? null,
  removed: [...calls.removed],
};

// 5. stranded session: no live worker and no durable result fails closed.
store.touch("s2", { projectID: "repo", state: "SANDBOX_ACTIVE" });
let stranded = null;
try {
  await tools.sandbox_apply.execute({}, { ...toolCtx, sessionID: "s2" });
} catch (err) {
  stranded = err instanceof Error ? err.message : String(err);
}
observations.stranded = { error: stranded, state: store.get("s2").state, created: calls.created };

console.log("Q114_RESULT " + JSON.stringify(observations));
`;

interface Evidence {
  afterFinish: {
    state: string;
    resultRef?: string;
    workerName: string | null;
    stopped: string[];
    created: number;
  };
  previewFilesBeforeApply: string[];
  diff: { containsChangedLine: boolean; createdDuringDiff: number };
  denied: {
    error: string | null;
    state: string;
    hostContent: string;
    approvals: number;
    approvalMetadata: Record<string, unknown> | null;
  };
  applied: {
    state: string;
    resultRef?: string;
    workerName: string | null;
    hostContent: string;
    approvals: number;
    lastApproval: Record<string, unknown> | null;
    removed: string[];
  };
  stranded: { error: string | null; state: string; created: number };
}

function runScenario(): Evidence {
  const root = mkdtempSync(join(tmpdir(), "q114-retained-apply-"));
  roots.push(root);
  const child = Bun.spawnSync(["bun", "-e", SCRIPT], {
    cwd: REPO_ROOT,
    env: { ...process.env, Q114_ROOT: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = child.stdout.toString();
  const stderr = child.stderr.toString();
  const line = stdout.split("\n").find((l) => l.startsWith("Q114_RESULT "));
  if (!line) {
    throw new Error(`scenario produced no result (exit ${child.exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  return JSON.parse(line.slice("Q114_RESULT ".length)) as Evidence;
}

const evidence = runScenario();

test("sandbox_finish exports the result and releases the transient worker", () => {
  expect(evidence.afterFinish.state).toBe("RESULT_READY");
  expect(evidence.afterFinish.resultRef).toBe("refs/opencode-sandbox/result/s1");
  expect(evidence.afterFinish.workerName).toBeNull();
  expect(evidence.afterFinish.stopped).toEqual(["worker-s1"]);
});

test("the retained result carries the complete approval artifacts before any apply", () => {
  expect(evidence.previewFilesBeforeApply).toEqual(["s1.ansi.diff", "s1.diff"]);
  expect(evidence.diff.containsChangedLine).toBe(true);
  // Inspection must never activate a worker.
  expect(evidence.diff.createdDuringDiff).toBe(0);
});

test("a denied apply changes nothing and keeps the result", () => {
  expect(evidence.denied.error).toMatch(/denied/);
  expect(evidence.denied.state).toBe("RESULT_READY");
  expect(evidence.denied.hostContent).toBe("original\n");
  expect(evidence.denied.approvals).toBe(1);
  // The approval prompt saw the bounded preview and the complete artifacts.
  expect(evidence.denied.approvalMetadata).toMatchObject({
    previewTruncated: false,
    files: 1,
    addedLines: 1,
    removedLines: 1,
  });
  expect(String(evidence.denied.approvalMetadata?.previewFile)).toEndWith("s1.diff");
  expect(String(evidence.denied.approvalMetadata?.previewAnsiFile)).toEndWith("s1.ansi.diff");
});

test("an approved apply after the finish updates the host tree and ends APPLIED", () => {
  expect(evidence.applied.state).toBe("APPLIED");
  expect(evidence.applied.hostContent).toBe("changed\n");
  expect(evidence.applied.workerName).toBeNull();
  expect(evidence.applied.approvals).toBe(2);
  expect(evidence.applied.lastApproval).toMatchObject({ files: 1, addedLines: 1, removedLines: 1 });
});

test("a stranded session without a live worker or a durable result fails closed", () => {
  expect(evidence.stranded.error).toMatch(/no worker|no session record|not sandbox-active|state/i);
  expect(evidence.stranded.state).toBe("SANDBOX_ACTIVE");
});
