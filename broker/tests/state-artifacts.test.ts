/**
 * State-dir artifact retention tests (bundle + temp-index GC).
 *
 * Covers the defect "bundles accumulate forever under <stateDir>/bundles/":
 * - a successful host import deletes the bundle while the result ref resolves;
 * - planned mode (import skipped) keeps the bundle as the only copy;
 * - terminal records are swept after the grace period, live records never;
 * - orphan bundles (no record) are swept after the grace;
 * - the sweep is idempotent and one bad entry never aborts it;
 * - the startup pass clears pre-existing files.
 *
 * The import test uses REAL git repositories (worker repo + host repo) so the
 * "result ref still resolves" assertion is verified against actual git, not a
 * mock.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  durableHostRefResolves,
  removeSessionArtifacts,
  tmpIndexPathFor,
} from "../src/artifacts.ts";
import { bundlePathFor } from "../src/gitops.ts";
import { runArtifactSweep, sweepStateArtifacts } from "../src/reaper.ts";
import {
  buildDiscardResultOp,
  runPrepare,
  type OpContext,
} from "../src/service.ts";
import type { SessionRecord, SessionState } from "../src/types.ts";

const GRACE = 3_600_000;
const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const BUNDLE_BYTES = "bundle-contents";
const INDEX_BYTES = "index";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function record(
  sessionID: string,
  state: SessionState,
  ageMs = 2 * GRACE,
): SessionRecord {
  return {
    sessionID,
    state,
    projectID: "repo",
    createdAt: iso(ageMs),
    updatedAt: iso(ageMs),
  };
}

function writeArtifacts(
  stateDir: string,
  sessionID: string,
  ageMs = 2 * GRACE,
): { bundle: string; index: string } {
  mkdirSync(join(stateDir, "bundles"), { recursive: true });
  mkdirSync(join(stateDir, "tmp"), { recursive: true });
  const bundle = bundlePathFor(stateDir, sessionID);
  const index = tmpIndexPathFor(stateDir, sessionID);
  writeFileSync(bundle, BUNDLE_BYTES);
  writeFileSync(index, INDEX_BYTES);
  const t = (NOW - ageMs) / 1000;
  utimesSync(bundle, t, t);
  utimesSync(index, t, t);
  return { bundle, index };
}

function sweepCtx(
  stateDir: string,
  records: SessionRecord[],
  opts: { durable?: boolean } = {},
): OpContext {
  const durable = opts.durable ?? true;
  return {
    config: { stateDir, projects: [{ id: "repo", path: stateDir }] },
    store: { list: () => records },
    git: {
      runnerMode: "real",
      spawn: async () => ({
        status: durable ? 0 : 1,
        stdout: durable ? "ref" : "",
        stderr: "",
        timedOut: false,
      }),
    },
  } as unknown as OpContext;
}

describe("state-dir artifact sweep", () => {
  test("terminal records: bundle + temp index removed after the grace; kinds and bytes logged", async () => {
    const stateDir = tempDir("artifacts-terminal-");
    const terminal: SessionState[] = [
      "APPLIED",
      "REJECTED",
      "RETAINED",
      "FAILED_CLOSED",
    ];
    const records = terminal.map((state, i) => record(`term-${i}`, state));
    for (const r of records) writeArtifacts(stateDir, r.sessionID);
    const logs: { sessionID: string; action: string; detail?: string }[] = [];

    const result = await sweepStateArtifacts(
      sweepCtx(stateDir, records),
      GRACE,
      (e) => logs.push(e),
    );

    expect(result.removed).toBe(terminal.length * 2);
    expect(result.bytesFreed).toBe(
      terminal.length * (BUNDLE_BYTES.length + INDEX_BYTES.length),
    );
    for (const r of records) {
      expect(existsSync(bundlePathFor(stateDir, r.sessionID))).toBe(false);
      expect(existsSync(tmpIndexPathFor(stateDir, r.sessionID))).toBe(false);
    }
    expect(logs.length).toBe(terminal.length * 2);
    expect(logs.every((e) => e.action === "swept_artifact")).toBe(true);
    expect(logs.some((e) => e.detail?.includes("bundle"))).toBe(true);
    expect(logs.some((e) => e.detail?.includes("tmp_index"))).toBe(true);
  });

  test("live records (CREATING_SANDBOX, SANDBOX_ACTIVE, unimported RESULT_READY) are never swept", async () => {
    const stateDir = tempDir("artifacts-live-");
    const records = [
      record("live-creating", "CREATING_SANDBOX"),
      record("live-active", "SANDBOX_ACTIVE"),
      record("live-ready", "RESULT_READY"),
    ];
    for (const r of records) writeArtifacts(stateDir, r.sessionID);

    const result = await sweepStateArtifacts(sweepCtx(stateDir, records), GRACE);

    expect(result.removed).toBe(0);
    for (const r of records) {
      expect(existsSync(bundlePathFor(stateDir, r.sessionID))).toBe(true);
      expect(existsSync(tmpIndexPathFor(stateDir, r.sessionID))).toBe(true);
    }
  });

  test("a still-fresh terminal record is kept until the grace elapses", async () => {
    const stateDir = tempDir("artifacts-fresh-");
    const records = [record("fresh-terminal", "APPLIED", 1_000)];
    writeArtifacts(stateDir, "fresh-terminal", 1_000);

    const result = await sweepStateArtifacts(sweepCtx(stateDir, records), GRACE);

    expect(result.removed).toBe(0);
    expect(existsSync(bundlePathFor(stateDir, "fresh-terminal"))).toBe(true);
  });

  test("orphan bundles (no record) are swept after the grace; fresh ones and live records survive", async () => {
    const stateDir = tempDir("artifacts-orphan-");
    writeArtifacts(stateDir, "orphan-old", 2 * GRACE);
    writeArtifacts(stateDir, "orphan-fresh", 1_000);
    writeArtifacts(stateDir, "recorded-live");
    const records = [record("recorded-live", "SANDBOX_ACTIVE")];

    const result = await sweepStateArtifacts(sweepCtx(stateDir, records), GRACE);

    expect(result.removed).toBe(1);
    expect(existsSync(bundlePathFor(stateDir, "orphan-old"))).toBe(false);
    expect(existsSync(bundlePathFor(stateDir, "orphan-fresh"))).toBe(true);
    expect(existsSync(bundlePathFor(stateDir, "recorded-live"))).toBe(true);
  });

  test("is idempotent: a second sweep removes nothing", async () => {
    const stateDir = tempDir("artifacts-idempotent-");
    const records = [record("term", "FAILED_CLOSED")];
    writeArtifacts(stateDir, "term");

    const first = await sweepStateArtifacts(sweepCtx(stateDir, records), GRACE);
    const second = await sweepStateArtifacts(sweepCtx(stateDir, records), GRACE);

    expect(first.removed).toBe(2);
    expect(second.removed).toBe(0);
    expect(second.bytesFreed).toBe(0);
  });

  test("one bad entry is logged and never aborts the sweep", async () => {
    const stateDir = tempDir("artifacts-bad-");
    writeArtifacts(stateDir, "good-orphan", 2 * GRACE);
    // Broken symlink: statSync throws, exercising the per-item catch.
    symlinkSync(
      join(stateDir, "does-not-exist"),
      join(stateDir, "bundles", "bad.bundle"),
    );
    const logs: { sessionID: string; action: string; detail?: string }[] = [];

    const result = await sweepStateArtifacts(
      sweepCtx(stateDir, []),
      GRACE,
      (e) => logs.push(e),
    );

    expect(result.removed).toBe(1);
    expect(existsSync(bundlePathFor(stateDir, "good-orphan"))).toBe(false);
    expect(logs.some((e) => e.action === "error")).toBe(true);
  });

  test("startup pass (runArtifactSweep) clears pre-existing files", async () => {
    const stateDir = tempDir("artifacts-startup-");
    writeArtifacts(stateDir, "pre-existing", 2 * GRACE);

    const result = await runArtifactSweep(sweepCtx(stateDir, []), GRACE);

    expect(result.removed).toBe(1);
    expect(existsSync(bundlePathFor(stateDir, "pre-existing"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runPrepare import vs planned mode (real git repositories)
// ---------------------------------------------------------------------------

function git(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnSync> {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["config", "user.email", "test@local"]);
  writeFileSync(join(dir, "a.txt"), "base\n");
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "-q", "-m", "base"]);
}

interface PrepareHarness {
  ctx: OpContext;
  stateDir: string;
  hostDir: string;
  sessionID: string;
  hostBundle: string;
  calls: string[];
}

function makePrepareHarness(runnerMode: "real" | "planned"): PrepareHarness {
  const stateDir = tempDir("prepare-state-");
  const hostDir = tempDir("prepare-host-");
  const workerDir = tempDir("prepare-worker-");
  initRepo(hostDir);
  initRepo(workerDir);
  mkdirSync(join(workerDir, ".broker-tmp"), { recursive: true });
  // A real B->C change so runPrepare commits and bundles.
  writeFileSync(join(workerDir, "a.txt"), "changed\n");

  const sessionID = "prepare-session";
  const record: SessionRecord = {
    sessionID,
    projectID: "repo",
    state: "SANDBOX_ACTIVE",
    workerName: "worker-prepare-session",
    workerState: "ACTIVE",
    createdAt: iso(1_000),
    updatedAt: iso(1_000),
  };
  const calls: string[] = [];
  const workerPath = (p: string) =>
    p.startsWith("/work") ? join(workerDir, p.slice("/work".length)) : p;

  const adapter = {
    exec: async (
      _worker: string,
      argv: string[],
      opts?: { cwd?: string; env?: Record<string, string> },
    ) => {
      calls.push(argv.join(" "));
      const args = argv.map(workerPath);
      const cwd =
        opts?.cwd === "/work" ? workerDir : opts?.cwd ? workerPath(opts.cwd) : workerDir;
      const r = spawnSync(args[0]!, args.slice(1), {
        cwd,
        encoding: "utf8",
        env: { ...process.env, ...(opts?.env ?? {}) },
      });
      return {
        status: r.status ?? 1,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        timedOut: false,
      };
    },
    copyOut: async (_worker: string, src: string, dest: string) => {
      calls.push(`copyOut ${src} ${dest}`);
      copyFileSync(workerPath(src), dest);
    },
  };
  const gitSpawn = async (
    argv: string[],
    opts?: { cwd?: string; env?: Record<string, string> },
  ) => {
    calls.push(argv.join(" "));
    const r = spawnSync(argv[0]!, argv.slice(1), {
      cwd: opts?.cwd ?? hostDir,
      encoding: "utf8",
      env: { ...process.env, ...(opts?.env ?? {}) },
    });
    return {
      status: r.status ?? 1,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      timedOut: false,
    };
  };

  const ctx = {
    config: { stateDir, projects: [{ id: "repo", path: hostDir }] },
    store: { get: () => record },
    adapter,
    git: { runnerMode, spawn: gitSpawn },
    logger: { log: () => {} },
  } as unknown as OpContext;

  return {
    ctx,
    stateDir,
    hostDir,
    sessionID,
    hostBundle: bundlePathFor(stateDir, sessionID),
    calls,
  };
}

describe("runPrepare bundle retention", () => {
  test("successful host import deletes the bundle and the result ref still resolves", async () => {
    const h = makePrepareHarness("real");

    const ref = await runPrepare(h.ctx, h.sessionID);

    expect(existsSync(h.hostBundle)).toBe(false);
    // The temp snapshot index is transport too; a successful import clears it.
    expect(existsSync(tmpIndexPathFor(h.stateDir, h.sessionID))).toBe(false);
    expect(h.calls.some((c) => c.startsWith("git fetch"))).toBe(true);
    // The durable copy is the host ref, and it resolves with the real content.
    const verify = spawnSync("git", ["rev-parse", "--verify", ref], {
      cwd: h.hostDir,
      encoding: "utf8",
    });
    expect(verify.status).toBe(0);
    const show = spawnSync("git", ["show", `${ref}:a.txt`], {
      cwd: h.hostDir,
      encoding: "utf8",
    });
    expect(show.status).toBe(0);
    expect(show.stdout).toBe("changed\n");
  });

  test("planned mode (import skipped) keeps the bundle as the only copy", async () => {
    const h = makePrepareHarness("planned");

    const ref = await runPrepare(h.ctx, h.sessionID);

    expect(ref).toBe(`refs/opencode-sandbox/result/${h.sessionID}`);
    expect(existsSync(h.hostBundle)).toBe(true);
    expect(h.calls.some((c) => c.startsWith("git fetch"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Immediate cleanup on a terminal transition
// ---------------------------------------------------------------------------

describe("terminal transition removes artifacts immediately", () => {
  test("discardResult (REJECTED) removes the bundle and temp index", async () => {
    const stateDir = tempDir("discard-state-");
    const sessionID = "discard-session";
    writeArtifacts(stateDir, sessionID);
    let rec: SessionRecord = {
      sessionID,
      projectID: "repo",
      state: "RESULT_READY",
      resultRef: `refs/opencode-sandbox/result/${sessionID}`,
      createdAt: iso(1_000),
      updatedAt: iso(1_000),
    };
    const ctx = {
      config: { stateDir },
      store: {
        get: () => rec,
        transition: (
          _id: string,
          from: SessionState,
          to: SessionState,
          patch: Partial<SessionRecord> = {},
        ) => {
          if (rec.state !== from) throw new Error(`state mismatch ${rec.state} != ${from}`);
          rec = { ...rec, ...patch, state: to };
          return rec;
        },
      },
      git: {
        runnerMode: "planned",
        spawn: async () => ({ status: 0, stdout: "", stderr: "", timedOut: false }),
      },
      logger: { log: () => {} },
    } as unknown as OpContext;

    const result = (await buildDiscardResultOp(ctx)({
      version: 1,
      id: "discard",
      operation: "discardResult",
      sessionID,
      payload: { confirm: "REJECT" },
    })) as { state: string };

    expect(result.state).toBe("REJECTED");
    expect(existsSync(bundlePathFor(stateDir, sessionID))).toBe(false);
    expect(existsSync(tmpIndexPathFor(stateDir, sessionID))).toBe(false);
    // removeSessionArtifacts is idempotent when the files are already gone.
    expect(removeSessionArtifacts(stateDir, sessionID).every((r) => !r.removed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Durability gate: terminal removal requires a durable host ref (or REJECTED)
// ---------------------------------------------------------------------------

function writeAllArtifacts(
  stateDir: string,
  sessionID: string,
  ageMs = 2 * GRACE,
): {
  bundle: string;
  index: string;
  divergence: string;
  patch: string;
  preview: string;
  ansi: string;
} {
  mkdirSync(join(stateDir, "bundles"), { recursive: true });
  mkdirSync(join(stateDir, "tmp"), { recursive: true });
  mkdirSync(join(stateDir, "patches"), { recursive: true });
  mkdirSync(join(stateDir, "apply-preview"), { recursive: true });
  const paths = {
    bundle: bundlePathFor(stateDir, sessionID),
    index: tmpIndexPathFor(stateDir, sessionID),
    divergence: join(stateDir, "tmp", `divergence-${sessionID}.index`),
    patch: join(stateDir, "patches", `${sessionID}.patch`),
    preview: join(stateDir, "apply-preview", `${sessionID}.diff`),
    ansi: join(stateDir, "apply-preview", `${sessionID}.ansi.diff`),
  };
  const t = (NOW - ageMs) / 1000;
  for (const p of Object.values(paths)) {
    writeFileSync(p, "x");
    utimesSync(p, t, t);
  }
  return paths;
}

describe("durability-gated terminal artifact removal", () => {
  test("planned mode: a terminal record survives with no host ref and is removed when one resolves", async () => {
    const keptDir = tempDir("artifacts-planned-keep-");
    const applied = record("planned-applied", "APPLIED");
    const keptPaths = writeAllArtifacts(keptDir, applied.sessionID);

    const kept = await sweepStateArtifacts(
      sweepCtx(keptDir, [applied], { durable: false }),
      GRACE,
    );

    expect(kept.removed).toBe(0);
    for (const p of Object.values(keptPaths)) expect(existsSync(p)).toBe(true);

    const sweptDir = tempDir("artifacts-durable-");
    const retained = record("durable-retained", "RETAINED");
    const sweptPaths = writeAllArtifacts(sweptDir, retained.sessionID);

    const swept = await sweepStateArtifacts(
      sweepCtx(sweptDir, [retained], { durable: true }),
      GRACE,
    );

    expect(swept.removed).toBe(6);
    for (const p of Object.values(sweptPaths)) expect(existsSync(p)).toBe(false);
  });

  test("REJECTED and result-less FAILED_CLOSED remove every artifact with no host ref", async () => {
    const stateDir = tempDir("artifacts-abandoned-");
    const rejected = record("rejected", "REJECTED");
    const failed = record("failed-closed", "FAILED_CLOSED");
    const rejectedPaths = writeAllArtifacts(stateDir, rejected.sessionID);
    const failedPaths = writeAllArtifacts(stateDir, failed.sessionID);

    const result = await sweepStateArtifacts(
      sweepCtx(stateDir, [rejected, failed], { durable: false }),
      GRACE,
    );

    expect(result.removed).toBe(12);
    for (const p of [
      ...Object.values(rejectedPaths),
      ...Object.values(failedPaths),
    ]) {
      expect(existsSync(p)).toBe(false);
    }
  });

  test("FAILED_CLOSED with a result ref is kept until the ref resolves", async () => {
    const stateDir = tempDir("artifacts-failed-ref-");
    const failed = {
      ...record("failed-with-ref", "FAILED_CLOSED"),
      resultRef: "refs/opencode-sandbox/result/failed-with-ref",
    };
    const paths = writeAllArtifacts(stateDir, failed.sessionID);

    const kept = await sweepStateArtifacts(
      sweepCtx(stateDir, [failed], { durable: false }),
      GRACE,
    );
    expect(kept.removed).toBe(0);
    for (const p of Object.values(paths)) expect(existsSync(p)).toBe(true);

    const swept = await sweepStateArtifacts(
      sweepCtx(stateDir, [failed], { durable: true }),
      GRACE,
    );
    expect(swept.removed).toBe(6);
    for (const p of Object.values(paths)) expect(existsSync(p)).toBe(false);
  });

  test("live records keep patches, apply previews and the divergence index", async () => {
    const stateDir = tempDir("artifacts-live-all-");
    const live = record("live-all", "SANDBOX_ACTIVE");
    const paths = writeAllArtifacts(stateDir, live.sessionID);

    const result = await sweepStateArtifacts(sweepCtx(stateDir, [live]), GRACE);

    expect(result.removed).toBe(0);
    for (const p of Object.values(paths)) expect(existsSync(p)).toBe(true);
  });

  test("orphan divergence index (no record) is swept after the grace", async () => {
    const stateDir = tempDir("artifacts-divergence-orphan-");
    mkdirSync(join(stateDir, "tmp"), { recursive: true });
    const divergence = join(stateDir, "tmp", "divergence-orphan-session.index");
    writeFileSync(divergence, "index");
    const t = (NOW - 2 * GRACE) / 1000;
    utimesSync(divergence, t, t);

    const result = await sweepStateArtifacts(sweepCtx(stateDir, []), GRACE);

    expect(result.removed).toBe(1);
    expect(existsSync(divergence)).toBe(false);
  });

  test("removeSessionArtifacts covers all six session-scoped kinds", () => {
    const stateDir = tempDir("artifacts-six-kinds-");
    const paths = writeAllArtifacts(stateDir, "six-kinds");

    const removals = removeSessionArtifacts(stateDir, "six-kinds");

    expect(removals.length).toBe(6);
    expect(removals.every((r) => r.removed)).toBe(true);
    for (const p of Object.values(paths)) expect(existsSync(p)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// durableHostRefResolves fail-closed coverage
//
// The probe must answer false - keeping the artifacts - whenever durability
// cannot be proven. Each non-provable branch has its own test so a fail-closed
// return can never be removed without a red test.
// ---------------------------------------------------------------------------

describe("durableHostRefResolves fail-closed coverage", () => {
  const durableGit = () => ({
    runnerMode: "real",
    spawn: async () => ({
      status: 0,
      stdout: "ref",
      stderr: "",
      timedOut: false,
    }),
  });

  test("fail-closed probe: keeps a terminal record's artifacts when ctx.git is absent", async () => {
    const stateDir = tempDir("durable-no-git-");
    const rec = record("no-git", "RETAINED");
    const paths = writeAllArtifacts(stateDir, rec.sessionID);
    const ctx = {
      config: { stateDir, projects: [{ id: "repo", path: stateDir }] },
      store: { list: () => [rec] },
    } as unknown as OpContext;

    const result = await sweepStateArtifacts(ctx, GRACE);

    expect(result.removed).toBe(0);
    for (const p of Object.values(paths)) expect(existsSync(p)).toBe(true);
    expect(await durableHostRefResolves(ctx, rec)).toBe(false);
  });

  test("fail-closed probe: keeps a terminal record's artifacts when ctx.git.spawn is not a function", async () => {
    const stateDir = tempDir("durable-bad-spawn-");
    const rec = record("bad-spawn", "RETAINED");
    const paths = writeAllArtifacts(stateDir, rec.sessionID);
    const ctx = {
      config: { stateDir, projects: [{ id: "repo", path: stateDir }] },
      store: { list: () => [rec] },
      git: { runnerMode: "real", spawn: "not-a-function" },
    } as unknown as OpContext;

    const result = await sweepStateArtifacts(ctx, GRACE);

    expect(result.removed).toBe(0);
    for (const p of Object.values(paths)) expect(existsSync(p)).toBe(true);
    expect(await durableHostRefResolves(ctx, rec)).toBe(false);
  });

  test("fail-closed probe: keeps a terminal record's artifacts when record.projectID is absent", async () => {
    const stateDir = tempDir("durable-no-project-");
    const rec = { ...record("no-project", "RETAINED"), projectID: undefined };
    const paths = writeAllArtifacts(stateDir, rec.sessionID);
    // A durable-looking spawn: only the missing projectID can keep it.
    const ctx = {
      config: { stateDir, projects: [{ id: "repo", path: stateDir }] },
      store: { list: () => [rec] },
      git: durableGit(),
    } as unknown as OpContext;

    const result = await sweepStateArtifacts(ctx, GRACE);

    expect(result.removed).toBe(0);
    for (const p of Object.values(paths)) expect(existsSync(p)).toBe(true);
    expect(await durableHostRefResolves(ctx, rec)).toBe(false);
  });

  test("fail-closed probe: keeps a terminal record's artifacts when the project is not allowlisted", async () => {
    const stateDir = tempDir("durable-unknown-project-");
    const rec = record("unknown-project", "RETAINED");
    const paths = writeAllArtifacts(stateDir, rec.sessionID);
    const ctx = {
      config: { stateDir, projects: [{ id: "other", path: stateDir }] },
      store: { list: () => [rec] },
      git: durableGit(),
    } as unknown as OpContext;

    const result = await sweepStateArtifacts(ctx, GRACE);

    expect(result.removed).toBe(0);
    for (const p of Object.values(paths)) expect(existsSync(p)).toBe(true);
    expect(await durableHostRefResolves(ctx, rec)).toBe(false);
  });

  test("fail-closed probe: keeps a terminal record's artifacts when spawn throws", async () => {
    const stateDir = tempDir("durable-spawn-throw-");
    const rec = record("spawn-throw", "RETAINED");
    const paths = writeAllArtifacts(stateDir, rec.sessionID);
    const ctx = {
      config: { stateDir, projects: [{ id: "repo", path: stateDir }] },
      store: { list: () => [rec] },
      git: {
        runnerMode: "real",
        spawn: async () => {
          throw new Error("spawn exploded");
        },
      },
    } as unknown as OpContext;

    const result = await sweepStateArtifacts(ctx, GRACE);

    expect(result.removed).toBe(0);
    for (const p of Object.values(paths)) expect(existsSync(p)).toBe(true);
    expect(await durableHostRefResolves(ctx, rec)).toBe(false);
  });

  test("fail-closed probe: keeps a terminal record's artifacts when spawn resolves status null (killed process)", async () => {
    const stateDir = tempDir("durable-status-null-");
    const rec = record("status-null", "RETAINED");
    const paths = writeAllArtifacts(stateDir, rec.sessionID);
    const ctx = {
      config: { stateDir, projects: [{ id: "repo", path: stateDir }] },
      store: { list: () => [rec] },
      git: {
        runnerMode: "real",
        spawn: async () => ({
          status: null,
          stdout: "",
          stderr: "killed",
          timedOut: true,
        }),
      },
    } as unknown as OpContext;

    const result = await sweepStateArtifacts(ctx, GRACE);

    expect(result.removed).toBe(0);
    for (const p of Object.values(paths)) expect(existsSync(p)).toBe(true);
    expect(await durableHostRefResolves(ctx, rec)).toBe(false);
  });
});
