/**
 * T2 (install) — host sandbox-result install operation.
 *
 * Verifies the fixed argv vectors, the fail-closed resolution, the binding
 * between the previewed and installed result commit, deletion handling, and
 * that no install ever stages the index.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { PolicyError } from "../src/policy.ts";
import { buildSandboxResultInstallOp, type OpContext } from "../src/service.ts";
import { validateEnvelope } from "../src/validation.ts";
import { assertResultDiffPaths, buildResultRestoreArgv } from "../src/sandbox-result.ts";
import { StateError } from "../src/state.ts";
import { ValidationError } from "../src/validation.ts";
import type { BrokerRequestEnvelope, SessionRecord } from "../src/types.ts";

const ORCHESTRATOR = "gentle-orchestrator";
const projectRoot = process.cwd();

const BASELINE_7 = "refs/opencode-sandbox/baseline/worker-7";
const RESULT_7 = "refs/opencode-sandbox/result/worker-7";
const COMMIT_7 = "0123456789abcdef0123456789abcdef01234567";
const OTHER_COMMIT = "ffffffffffffffffffffffffffffffffffffffff";

function request(payload: Record<string, unknown>): BrokerRequestEnvelope {
  return {
    version: 1,
    id: "req-sandboxResultInstall",
    operation: "sandboxResultInstall",
    sessionID: "session-1",
    agent: ORCHESTRATOR,
    payload,
  };
}

function installRequest(payload: Record<string, unknown> = {}): BrokerRequestEnvelope {
  return request({
    projectDir: projectRoot,
    sandboxSessionID: "worker-7",
    expectedResultCommit: COMMIT_7,
    ...payload,
  });
}

function readableRecord(
  sessionID: string,
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    sessionID,
    state: "RESULT_READY",
    projectID: "test",
    baselineRef: `refs/opencode-sandbox/baseline/${sessionID}`,
    resultRef: `refs/opencode-sandbox/result/${sessionID}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeCtx(
  spawn: OpContext["git"]["spawn"],
  records: Record<string, SessionRecord>,
): OpContext {
  const config = defaultConfig({
    readOnlyAgents: [ORCHESTRATOR],
    projects: [{ id: "test", path: projectRoot }],
  });
  return {
    config,
    store: {
      get: (sessionID: string) => records[sessionID],
      touch: (sessionID: string, patch: Partial<SessionRecord>) => {
        const next = { ...records[sessionID]!, ...patch };
        records[sessionID] = next;
        return next;
      },
    },
    adapter: {},
    budget: {},
    resources: {},
    pool: { allocations: [] },
    hostRead: { has: () => false },
    logger: {},
    git: { runnerMode: "planned", spawn },
  } as unknown as OpContext;
}

interface StubRule {
  match: (argv: string[]) => boolean;
  result: { status: number; stdout: string; stderr: string };
}

function spawnStub(rules: StubRule[]) {
  const calls: string[][] = [];
  const spawn: OpContext["git"]["spawn"] = async (argv) => {
    calls.push(argv);
    for (const rule of rules) {
      if (rule.match(argv)) return { ...rule.result, timedOut: false };
    }
    return { status: 0, stdout: "", stderr: "", timedOut: false };
  };
  return { calls, spawn };
}

const isNameOnly = (argv: string[]) => argv.includes("--name-only");
const isRaw = (argv: string[]) => argv.includes("--raw");
const isRevParse = (argv: string[]) => argv[1] === "rev-parse";
const isWorkingTreeDiff = (argv: string[]) => argv[0] === "git" && argv[1] === "diff" && argv.includes("--quiet");
const isRestore = (argv: string[]) => argv[1] === "restore";
const isRm = (argv: string[]) => argv[0] === "rm";

function ok(result: Partial<{ status: number; stdout: string; stderr: string }>): StubRule["result"] {
  return { status: 0, stdout: "", stderr: "", ...result };
}

/** Every install must restore/delete only; it must never stage the index. */
function expectNoIndexStaging(calls: string[][]): void {
  const joined = calls.flat().join(" ");
  for (const argv of calls) {
    expect(argv).not.toContain("--staged");
    expect(argv).not.toContain("--cached");
    expect(argv).not.toContain("--index");
    expect(argv).not.toContain("-A");
    expect(argv).not.toContain("--all");
    expect(argv).not.toContain("update-index");
  }
  expect(joined).not.toContain("git add");
  expect(joined).not.toContain("git reset");
  expect(joined).not.toContain("git rm");
  expect(joined).not.toContain("git checkout");
}

const record7 = () => ({
  "session-1": readableRecord("session-1", { state: "HOST_READ_ONLY", agent: ORCHESTRATOR }),
  "worker-7": readableRecord("worker-7"),
});

describe("sandboxResultInstall — fixed argv and install", () => {
  test("installs the result's present path when the baseline has not diverged", async () => {
    const { calls, spawn } = spawnStub([
      { match: isRevParse, result: ok({ stdout: `${COMMIT_7}\n` }) },
      { match: isNameOnly, result: ok({ stdout: "a.ts\u0000" }) },
      { match: isRaw, result: ok({ stdout: ":100644 100644 1111111 2222222 M\ta.ts\n" }) },
    ]);
    const ctx = makeCtx(spawn, record7());
    const result = (await buildSandboxResultInstallOp(ctx)(installRequest())) as {
      installed: boolean;
      resultRef: string;
      resultCommit: string;
      paths: string[];
      restoredPaths: string[];
      deletedPaths: string[];
    };
    expect(result.installed).toBe(true);
    expect(result.resultRef).toBe(RESULT_7);
    expect(result.resultCommit).toBe(COMMIT_7);
    expect(result.paths).toEqual(["a.ts"]);
    const divergenceCheck = ["git", "diff", "--quiet", BASELINE_7, "--", "a.ts"];
    expect(calls).toContainEqual(divergenceCheck);
    expect(
      calls.findIndex((argv) => JSON.stringify(argv) === JSON.stringify(divergenceCheck)),
    ).toBeLessThan(calls.findIndex((argv) => argv[1] === "restore" || argv[0] === "rm"));
    expect(calls).toContainEqual([
      "git",
      "restore",
      `--source=${RESULT_7}`,
      "--worktree",
      "--",
      "a.ts",
    ]);
    expectNoIndexStaging(calls);
  });

  test("restores a new-file result path and never stages it", async () => {
    const { calls, spawn } = spawnStub([
      { match: isRevParse, result: ok({ stdout: `${COMMIT_7}\n` }) },
      { match: isNameOnly, result: ok({ stdout: "new.ts\u0000" }) },
      { match: isRaw, result: ok({ stdout: ":000000 100644 0000000 3333333 A\tnew.ts\n" }) },
    ]);
    const ctx = makeCtx(spawn, record7());
    const result = (await buildSandboxResultInstallOp(ctx)(installRequest())) as {
      installed: boolean;
      restoredPaths: string[];
      deletedPaths: string[];
    };
    expect(result.installed).toBe(true);
    expect(result.restoredPaths).toEqual(["new.ts"]);
    expect(result.deletedPaths).toEqual([]);
    expect(calls).toContainEqual([
      "git",
      "restore",
      `--source=${RESULT_7}`,
      "--worktree",
      "--",
      "new.ts",
    ]);
    expect(calls.some(isRm)).toBe(false);
    expectNoIndexStaging(calls);
  });

  test("the protocol exposes sandboxResultInstall with the exact payload allowlist", () => {
    const accepted = validateEnvelope({
      version: 1,
      id: "req",
      operation: "sandboxResultInstall",
      sessionID: "session-1",
      payload: {
        projectDir: projectRoot,
        sandboxSessionID: "worker-7",
        expectedResultCommit: COMMIT_7,
      },
    });
    expect(accepted.operation).toBe("sandboxResultInstall");
    expect(() =>
      validateEnvelope({
        version: 1,
        id: "req",
        operation: "sandboxResultInstall",
        sessionID: "session-1",
        payload: { projectDir: projectRoot, ref: "refs/heads/main" },
      }),
    ).toThrow(ValidationError);
  });
});

describe("sandboxResultInstall — baseline divergence", () => {
  test("refuses a divergent restore path and names it before mutation", async () => {
    const { calls, spawn } = spawnStub([
      { match: isRevParse, result: ok({ stdout: `${COMMIT_7}\n` }) },
      { match: isNameOnly, result: ok({ stdout: "a.ts\u0000" }) },
      { match: isRaw, result: ok({ stdout: ":100644 100644 1111111 2222222 M\ta.ts\n" }) },
      { match: isWorkingTreeDiff, result: { status: 1, stdout: "", stderr: "" } },
      { match: (argv) => argv[0] === "git" && argv[1] === "diff" && argv.includes("--name-only"), result: ok({ stdout: "a.ts\u0000" }) },
    ]);
    const ctx = makeCtx(spawn, record7());
    await expect(buildSandboxResultInstallOp(ctx)(installRequest())).rejects.toThrow(/a\.ts/);
    const check = ["git", "diff", "--quiet", BASELINE_7, "--", "a.ts"];
    expect(calls).toContainEqual(check);
    expect(calls.some(isRestore)).toBe(false);
    expect(calls.some(isRm)).toBe(false);
  });

  test("refuses a divergent delete path and names it before deletion", async () => {
    const { calls, spawn } = spawnStub([
      { match: isRevParse, result: ok({ stdout: `${COMMIT_7}\n` }) },
      { match: isNameOnly, result: ok({ stdout: "gone.ts\u0000" }) },
      { match: isRaw, result: ok({ stdout: ":100644 000000 1111111 0000000 D\tgone.ts\n" }) },
      { match: isWorkingTreeDiff, result: { status: 1, stdout: "", stderr: "" } },
      { match: (argv) => argv[0] === "git" && argv[1] === "diff" && argv.includes("--name-only"), result: ok({ stdout: "gone.ts\u0000" }) },
    ]);
    const ctx = makeCtx(spawn, record7());
    await expect(buildSandboxResultInstallOp(ctx)(installRequest())).rejects.toThrow(/gone\.ts/);
    const check = ["git", "diff", "--quiet", BASELINE_7, "--", "gone.ts"];
    expect(calls).toContainEqual(check);
    expect(calls.some(isRestore)).toBe(false);
    expect(calls.some(isRm)).toBe(false);
  });

  test("refuses when the baseline cannot be resolved", async () => {
    const { calls, spawn } = spawnStub([
      { match: isRevParse, result: ok({ stdout: `${COMMIT_7}\n` }) },
      { match: isNameOnly, result: ok({ stdout: "a.ts\u0000" }) },
      { match: isRaw, result: ok({ stdout: ":100644 100644 1111111 2222222 M\ta.ts\n" }) },
      { match: isWorkingTreeDiff, result: { status: 128, stdout: "", stderr: "fatal: bad revision" } },
    ]);
    const ctx = makeCtx(spawn, record7());
    await expect(buildSandboxResultInstallOp(ctx)(installRequest())).rejects.toThrow(/baseline/);
    expect(calls.some(isRestore)).toBe(false);
    expect(calls.some(isRm)).toBe(false);
  });
});

describe("sandboxResultInstall — commit binding (preview == installed)", () => {
  test("refuses a result ref that moved since the preview by name", async () => {
    const { calls, spawn } = spawnStub([
      { match: isRevParse, result: ok({ stdout: `${OTHER_COMMIT}\n` }) },
      { match: isNameOnly, result: ok({ stdout: "a.ts\u0000" }) },
      { match: isRaw, result: ok({ stdout: ":100644 100644 1111111 2222222 M\ta.ts\n" }) },
    ]);
    const ctx = makeCtx(spawn, record7());
    await expect(
      buildSandboxResultInstallOp(ctx)(installRequest()),
    ).rejects.toThrow(/result-commit-mismatch/);
    expect(calls.some(isRestore)).toBe(false);
    expect(calls.some(isRm)).toBe(false);
  });

  test("installs when expectedResultCommit matches and persists installedCommit", async () => {
    const { calls, spawn } = spawnStub([
      { match: isRevParse, result: ok({ stdout: `${COMMIT_7}\n` }) },
      { match: isNameOnly, result: ok({ stdout: "a.ts\u0000" }) },
      { match: isRaw, result: ok({ stdout: ":100644 100644 1111111 2222222 M\ta.ts\n" }) },
    ]);
    const records = record7();
    const ctx = makeCtx(spawn, records);
    const result = (await buildSandboxResultInstallOp(ctx)(installRequest())) as {
      installed: boolean;
      resultCommit: string;
    };
    expect(result.installed).toBe(true);
    expect(result.resultCommit).toBe(COMMIT_7);
    expect(records["worker-7"]?.installedCommit).toBe(COMMIT_7);
    expect(calls).toContainEqual(["git", "rev-parse", "--verify", `${RESULT_7}^{commit}`]);
  });

  test("returns alreadyInstalled without touching the worktree when commit matches", async () => {
    const { calls, spawn } = spawnStub([]);
    const ctx = makeCtx(spawn, {
      "session-1": readableRecord("session-1", { state: "HOST_READ_ONLY", agent: ORCHESTRATOR }),
      "worker-7": readableRecord("worker-7", { installedCommit: COMMIT_7 }),
    });
    const result = (await buildSandboxResultInstallOp(ctx)(installRequest())) as {
      alreadyInstalled: boolean;
    };
    expect(result.alreadyInstalled).toBe(true);
    expect(calls.some(isRestore)).toBe(false);
    expect(calls.some(isRm)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("refuses a second install request with a different stored installedCommit", async () => {
    // Without the stored-marker guard, the valid result ref below matches the request and this install would succeed.
    const { calls, spawn } = spawnStub([
      { match: isRevParse, result: ok({ stdout: `${COMMIT_7}\n` }) },
      { match: isNameOnly, result: ok({ stdout: "a.ts\0" }) },
      { match: isRaw, result: ok({ stdout: ":100644 100644 1111111 2222222 M\ta.ts\n" }) },
    ]);
    const ctx = makeCtx(spawn, {
      "session-1": readableRecord("session-1", { state: "HOST_READ_ONLY", agent: ORCHESTRATOR }),
      "worker-7": readableRecord("worker-7", { installedCommit: OTHER_COMMIT }),
    });
    await expect(buildSandboxResultInstallOp(ctx)(installRequest())).rejects.toThrow(StateError);
    expect(calls).toHaveLength(0);
  });

  test("refuses an install with no expectedResultCommit", async () => {
    const { calls, spawn } = spawnStub([]);
    const ctx = makeCtx(spawn, record7());
    await expect(
      buildSandboxResultInstallOp(ctx)(
        request({ projectDir: projectRoot, sandboxSessionID: "worker-7" }),
      ),
    ).rejects.toThrow(ValidationError);
    expect(calls).toHaveLength(0);
  });

  test("refuses a malformed expectedResultCommit before any spawn", async () => {
    const { calls, spawn } = spawnStub([]);
    const ctx = makeCtx(spawn, record7());
    await expect(
      buildSandboxResultInstallOp(ctx)(
        installRequest({ expectedResultCommit: "not-a-commit" }),
      ),
    ).rejects.toThrow(ValidationError);
    expect(calls).toHaveLength(0);
  });
});

describe("sandboxResultInstall — deletions", () => {
  test("a deletion-only result removes the deleted path without git restore", async () => {
    const { calls, spawn } = spawnStub([
      { match: isRevParse, result: ok({ stdout: `${COMMIT_7}\n` }) },
      { match: isNameOnly, result: ok({ stdout: "gone.ts\u0000" }) },
      { match: isRaw, result: ok({ stdout: ":100644 000000 1111111 0000000 D\tgone.ts\n" }) },
      {
        match: (argv) => isRestore(argv) && argv.includes("gone.ts"),
        result: { status: 1, stdout: "", stderr: "pathspec 'gone.ts' did not match" },
      },
    ]);
    const ctx = makeCtx(spawn, record7());
    const result = (await buildSandboxResultInstallOp(ctx)(installRequest())) as {
      installed: boolean;
      restoredPaths: string[];
      deletedPaths: string[];
    };
    expect(result.installed).toBe(true);
    expect(result.restoredPaths).toEqual([]);
    expect(result.deletedPaths).toEqual(["gone.ts"]);
    expect(calls).toContainEqual(["rm", "-f", "--", "gone.ts"]);
    expect(calls.some(isRestore)).toBe(false);
    expectNoIndexStaging(calls);
  });

  test("a mixed result restores present paths and removes deleted paths", async () => {
    const { calls, spawn } = spawnStub([
      { match: isRevParse, result: ok({ stdout: `${COMMIT_7}\n` }) },
      { match: isNameOnly, result: ok({ stdout: "a.ts\u0000gone.ts\u0000" }) },
      {
        match: isRaw,
        result: ok({
          stdout:
            ":100644 100644 1111111 2222222 M\ta.ts\n" +
            ":100644 000000 1111111 0000000 D\tgone.ts\n",
        }),
      },
      {
        match: (argv) => isRestore(argv) && argv.includes("gone.ts"),
        result: { status: 1, stdout: "", stderr: "pathspec did not match" },
      },
    ]);
    const ctx = makeCtx(spawn, record7());
    const result = (await buildSandboxResultInstallOp(ctx)(installRequest())) as {
      installed: boolean;
      restoredPaths: string[];
      deletedPaths: string[];
    };
    expect(result.installed).toBe(true);
    expect(result.restoredPaths).toEqual(["a.ts"]);
    expect(result.deletedPaths).toEqual(["gone.ts"]);
    expect(calls).toContainEqual([
      "git",
      "restore",
      `--source=${RESULT_7}`,
      "--worktree",
      "--",
      "a.ts",
    ]);
    expect(calls).toContainEqual(["rm", "-f", "--", "gone.ts"]);
    // The deleted path must never be handed to `git restore` (it is absent in
    // the result ref, which is exactly the failure this handling removes).
    for (const argv of calls.filter(isRestore)) {
      expect(argv).not.toContain("gone.ts");
    }
    expectNoIndexStaging(calls);
  });
});

describe("sandboxResultInstall — fail closed", () => {
  test("refuses an unknown session with a named reason and spawns no git", async () => {
    const { calls, spawn } = spawnStub([]);
    const ctx = makeCtx(spawn, record7());
    await expect(
      buildSandboxResultInstallOp(ctx)(
        installRequest({ sandboxSessionID: "ghost" }),
      ),
    ).rejects.toThrow(/unknown session ghost/);
    expect(calls).toHaveLength(0);
  });

  test("is orchestrator-only and never spawns for another agent", async () => {
    const { calls, spawn } = spawnStub([]);
    const records = record7();
    records["session-1"] = readableRecord("session-1", {
      state: "HOST_READ_ONLY",
      agent: "general",
    });
    const ctx = makeCtx(spawn, records);
    await expect(
      buildSandboxResultInstallOp(ctx)(installRequest()),
    ).rejects.toThrow(PolicyError);
    expect(calls).toHaveLength(0);
  });

  test("refuses a caller-supplied path list without spawning", async () => {
    const { calls, spawn } = spawnStub([]);
    const ctx = makeCtx(spawn, record7());
    await expect(
      buildSandboxResultInstallOp(ctx)(
        installRequest({ paths: ["/etc/passwd"] }),
      ),
    ).rejects.toThrow(ValidationError);
    expect(calls).toHaveLength(0);
  });

  test("refuses an empty B→C result", async () => {
    const { calls, spawn } = spawnStub([
      { match: isRevParse, result: ok({ stdout: `${COMMIT_7}\n` }) },
      { match: isNameOnly, result: ok({ stdout: "" }) },
    ]);
    const ctx = makeCtx(spawn, record7());
    await expect(
      buildSandboxResultInstallOp(ctx)(installRequest()),
    ).rejects.toThrow(/result is empty/);
    expect(calls.some(isRestore)).toBe(false);
  });

  test("path validation refuses traversal, absolute and empty lists", () => {
    expect(() => buildResultRestoreArgv(RESULT_7, [])).toThrow(ValidationError);
    expect(() => buildResultRestoreArgv(RESULT_7, ["../escape"])).toThrow(ValidationError);
    expect(() => buildResultRestoreArgv(RESULT_7, ["/etc/passwd"])).toThrow(ValidationError);
    expect(() => assertResultDiffPaths(["-"], "path")).toThrow(ValidationError);
  });
});

/**
 * Live git helper: run a git subcommand in the isolated temp repository.
 * spawnSync receives an argv vector; no shell is ever involved.
 */
function liveGit(repo: string, args: string[]): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const res = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/**
 * A real (non-stub) `ctx.git.spawn`: runs the argv vector with spawnSync
 * against the temp repository. When a production caller omits `cwd` (for
 * example `changedPathsBetween`, which only sets GIT_DIR) the command runs
 * from the project root, mirroring a broker whose process cwd is the project.
 */
function liveSpawn(repo: string, calls: string[][]): OpContext["git"]["spawn"] {
  return async (argv, opts) => {
    calls.push(argv);
    const res = spawnSync(argv[0]!, argv.slice(1), {
      cwd: opts.cwd ?? repo,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      encoding: "utf8",
    });
    return {
      status: res.status,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      timedOut: false,
    };
  };
}

function makeLiveCtx(
  repo: string,
  spawn: OpContext["git"]["spawn"],
  records: Record<string, SessionRecord>,
): OpContext {
  const config = defaultConfig({
    readOnlyAgents: [ORCHESTRATOR],
    projects: [{ id: "test", path: repo }],
  });
  return {
    config,
    store: {
      get: (sessionID: string) => records[sessionID],
      touch: (sessionID: string, patch: Partial<SessionRecord>) => {
        const next = { ...records[sessionID]!, ...patch };
        records[sessionID] = next;
        return next;
      },
    },
    adapter: {},
    budget: {},
    resources: {},
    pool: { allocations: [] },
    hostRead: { has: () => false },
    logger: {},
    git: { runnerMode: "real", spawn },
  } as unknown as OpContext;
}

describe("sandboxResultInstall — live git: worktree written, index untouched", () => {
  test("applies new, modified and deleted result paths without staging the index", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "t2-install-live-")));
    try {
      expect(liveGit(repo, ["init", "-q", "-b", "main"]).status).toBe(0);
      for (const [key, value] of [
        ["user.name", "T2 Live Test"],
        ["user.email", "t2-live@example.invalid"],
        ["commit.gpgsign", "false"],
      ] as const) {
        expect(liveGit(repo, ["config", key, value]).status).toBe(0);
      }

      // Baseline B: mod.ts (to modify), gone.ts (to delete), keep.ts (keep).
      writeFileSync(join(repo, "mod.ts"), "baseline\n");
      writeFileSync(join(repo, "gone.ts"), "delete me\n");
      writeFileSync(join(repo, "keep.ts"), "keep\n");
      expect(liveGit(repo, ["add", "--", "mod.ts", "gone.ts", "keep.ts"]).status).toBe(0);
      expect(liveGit(repo, ["commit", "-q", "-m", "baseline"]).status).toBe(0);
      const baselineCommit = liveGit(repo, ["rev-parse", "HEAD"]).stdout.trim();
      expect(liveGit(repo, ["update-ref", BASELINE_7, baselineCommit]).status).toBe(0);

      // Result C: modify mod.ts, add new.ts, delete gone.ts.
      expect(liveGit(repo, ["checkout", "-q", "-b", "result"]).status).toBe(0);
      writeFileSync(join(repo, "mod.ts"), "result\n");
      writeFileSync(join(repo, "new.ts"), "fresh\n");
      rmSync(join(repo, "gone.ts"));
      expect(liveGit(repo, ["add", "--", "mod.ts", "new.ts"]).status).toBe(0);
      expect(liveGit(repo, ["rm", "-q", "--", "gone.ts"]).status).toBe(0);
      expect(liveGit(repo, ["commit", "-q", "-m", "result"]).status).toBe(0);
      const resultCommit = liveGit(repo, ["rev-parse", "HEAD"]).stdout.trim();
      expect(liveGit(repo, ["update-ref", RESULT_7, resultCommit]).status).toBe(0);

      // Return the worktree and index to baseline B.
      expect(liveGit(repo, ["checkout", "-q", "main"]).status).toBe(0);
      expect(liveGit(repo, ["reset", "-q", "--hard", baselineCommit]).status).toBe(0);

      // Stage exactly one unrelated sentinel. A correct install leaves the
      // staged set byte-identical; the staged set must remain exactly this.
      writeFileSync(join(repo, "sentinel.txt"), "sentinel\n");
      expect(liveGit(repo, ["add", "--", "sentinel.txt"]).status).toBe(0);
      const stagedBefore = liveGit(repo, ["diff", "--cached", "--name-only"]).stdout;
      expect(stagedBefore.trim()).toBe("sentinel.txt");

      const calls: string[][] = [];
      const ctx = makeLiveCtx(repo, liveSpawn(repo, calls), {
        "session-1": readableRecord("session-1", {
          state: "HOST_READ_ONLY",
          agent: ORCHESTRATOR,
        }),
        "worker-7": readableRecord("worker-7"),
      });

      const result = (await buildSandboxResultInstallOp(ctx)({
        version: 1,
        id: "req-sandboxResultInstall-live",
        operation: "sandboxResultInstall",
        sessionID: "session-1",
        agent: ORCHESTRATOR,
        payload: {
          projectDir: repo,
          sandboxSessionID: "worker-7",
          expectedResultCommit: resultCommit,
        },
      })) as {
        installed: boolean;
        restoredPaths: string[];
        deletedPaths: string[];
      };

      // The central invariant, proven live rather than inferred from argv.
      const stagedAfter = liveGit(repo, ["diff", "--cached", "--name-only"]).stdout;
      expect(stagedAfter).toBe(stagedBefore);
      expect(stagedAfter.trim()).toBe("sentinel.txt");

      expect(result.installed).toBe(true);
      expect(result.restoredPaths).toEqual(["mod.ts", "new.ts"]);
      expect(result.deletedPaths).toEqual(["gone.ts"]);

      // new file: present in the worktree, untracked, never a staged addition.
      expect(readFileSync(join(repo, "new.ts"), "utf8")).toBe("fresh\n");
      expect(liveGit(repo, ["ls-files", "--", "new.ts"]).stdout).toBe("");
      expect(liveGit(repo, ["diff", "--cached", "--name-only", "--", "new.ts"]).stdout).toBe("");

      // modification: restored to the result's exact bytes, not staged.
      expect(readFileSync(join(repo, "mod.ts"), "utf8")).toBe("result\n");
      expect(liveGit(repo, ["diff", "--cached", "--name-only", "--", "mod.ts"]).stdout).toBe("");

      // deletion: gone from the worktree, index entry untouched, never staged.
      expect(existsSync(join(repo, "gone.ts"))).toBe(false);
      expect(liveGit(repo, ["ls-files", "--", "gone.ts"]).stdout.trim()).toBe("gone.ts");
      expect(liveGit(repo, ["diff", "--cached", "--name-only", "--", "gone.ts"]).stdout).toBe("");

      // The existing argv-level guarantee still holds for the live run.
      expect(calls).toContainEqual([
        "git",
        "restore",
        `--source=${RESULT_7}`,
        "--worktree",
        "--",
        "mod.ts",
        "new.ts",
      ]);
      expectNoIndexStaging(calls);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
