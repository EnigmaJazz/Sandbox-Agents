import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { classifyOperation } from "../src/role-policy.ts";
import {
  assertPlanArchivePair,
  buildPlanArchiveOp,
  buildPlanDocWriteOp,
  rollbackPlanArchiveMove,
} from "../src/service.ts";
import type { BrokerRequestEnvelope, SessionRecord } from "../src/types.ts";
import { ValidationError } from "../src/validation.ts";

const ORCHESTRATOR = "gentle-orchestrator";
const SESSION = "session-plan-archive";

interface SpawnOptionsLike { cwd?: string; env?: Record<string, string> }
interface SpawnResultLike { status: number | null; stdout: string; stderr: string; timedOut: boolean }
type Spawn = (argv: string[], opts: SpawnOptionsLike) => Promise<SpawnResultLike>;

function spawnRealGit(): Spawn {
  return async (argv, opts) => {
    try {
      const stdout = execFileSync(argv[0]!, argv.slice(1), {
        cwd: opts.cwd, env: { ...process.env, ...(opts.env ?? {}) }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: 0, stdout: String(stdout), stderr: "", timedOut: false };
    } catch (error) {
      const failure = error as { status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer };
      return {
        status: typeof failure.status === "number" ? failure.status : 1,
        stdout: failure.stdout === undefined ? "" : String(failure.stdout),
        stderr: failure.stderr === undefined ? "" : String(failure.stderr),
        timedOut: false,
      };
    }
  };
}

function makeContext(root: string, identity = "planner", spawn: Spawn = spawnRealGit(), overrides: Record<string, unknown> = {}) {
  const config = defaultConfig({ projects: [{ id: "plan-archive-test", path: root }], readOnlyAgents: [ORCHESTRATOR], ...overrides });
  const record: SessionRecord = {
    sessionID: SESSION, state: "HOST_READ_ONLY", agent: identity,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
  return {
    config, store: { get: () => record }, adapter: {}, budget: {}, resources: {}, pool: {},
    hostRead: { has: () => false }, logger: {}, git: { runnerMode: "real", spawn },
  } as never;
}

function request(root: string, payload: Record<string, unknown> = {}, agent = "planner"): BrokerRequestEnvelope {
  return {
    version: 1, id: "archive", operation: "planArchive", sessionID: SESSION, agent,
    payload: { projectDir: root, target: "tasks", name: "alpha", note: "archive", agent, ...payload },
  } as BrokerRequestEnvelope;
}

function planWriteRequest(root: string): BrokerRequestEnvelope {
  return {
    version: 1, id: "write", operation: "planDocWrite", sessionID: SESSION, agent: "planner",
    payload: { projectDir: root, target: "tasks", name: "alpha", content: "# replaced", expectedRevision: 0, note: "concurrent", agent: "planner" },
  } as BrokerRequestEnvelope;
}

function withRepo(run: (root: string) => Promise<void>) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-archive-"));
    try {
      execFileSync("git", ["init", "-q", root]);
      execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
      execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
      writeFileSync(join(root, "seed.txt"), "seed\n");
      execFileSync("git", ["-C", root, "add", "seed.txt"]);
      execFileSync("git", ["-C", root, "commit", "-qm", "seed"]);
      await run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function seed(root: string, relative: string, text: string): string {
  const absolute = join(root, relative);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
  execFileSync("git", ["-C", root, "add", "--", relative]);
  execFileSync("git", ["-C", root, "commit", "-qm", `seed ${relative}`]);
  return absolute;
}

const gitOut = (root: string, args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });

describe("host plan archive", () => {
  test("archives tasks and mini documents with the exact commit", withRepo(async (root) => {
    const source = seed(root, "odd/tasks/alpha.md", "# alpha\n");
    const mini = seed(root, "odd/mini/beta.md", "# beta\n");
    writeFileSync(join(root, "seed.txt"), "seed changed\n");
    writeFileSync(join(root, "staged.txt"), "staged\n");
    execFileSync("git", ["-C", root, "add", "staged.txt"]);

    const tasksResult = await buildPlanArchiveOp(makeContext(root))(request(root, {}, "planner"));
    const miniResult = await buildPlanArchiveOp(makeContext(root, "pm-odd"))(
      request(root, { target: "mini", name: "beta" }, "pm-odd"),
    );

    expect(tasksResult).toMatchObject({ target: "tasks", path: "odd/tasks/alpha.md", archivedPath: "odd/tasks/archive/alpha.md", committed: true });
    expect((tasksResult as { commit: string }).commit).toMatch(/^[0-9a-f]{40}$/);
    expect(miniResult).toMatchObject({ target: "mini", committed: true });
    expect(readFileSync(join(root, "odd/tasks/archive/alpha.md"), "utf8")).toBe("# alpha\n");
    expect(readFileSync(join(root, "odd/mini/archive/beta.md"), "utf8")).toBe("# beta\n");
    expect(existsSync(source)).toBe(false);
    expect(existsSync(mini)).toBe(false);
    expect(gitOut(root, ["log", "-1", "--format=%s"]).trim()).toBe("docs(odd): archive mini/beta");
    expect(gitOut(root, ["log", "-2", "--format=%s"]).trim()).toBe("docs(odd): archive mini/beta\ndocs(odd): archive tasks/alpha");
    expect(gitOut(root, ["show", "--format=", "--name-status", "-M", "HEAD^"]).trim()).toContain("odd/tasks/alpha.md");
    expect(gitOut(root, ["show", "--format=", "--name-status", "-M", "HEAD"]).trim()).toContain("odd/mini/beta.md");
    const status = gitOut(root, ["status", "--porcelain"]);
    expect(status).toContain("A  staged.txt");
    expect(status).toContain(" M seed.txt");
  }));

  test("refuses missing source, occupied destination, protected path, bad name, target, note and pair", withRepo(async (root) => {
    const source = seed(root, "odd/tasks/alpha.md", "# alpha\n");
    const head = gitOut(root, ["rev-parse", "HEAD"]).trim();
    const op = (payload: Record<string, unknown>, overrides: Record<string, unknown> = {}) =>
      buildPlanArchiveOp(makeContext(root, "planner", spawnRealGit(), overrides))(request(root, payload));

    await expect(op({ name: "missing" })).rejects.toBeInstanceOf(ValidationError);
    await expect(op({ name: "missing" })).rejects.toThrow(/PLAN_ARCHIVE_SOURCE_MISSING/);
    mkdirSync(join(root, "odd/tasks/archive"), { recursive: true });
    writeFileSync(join(root, "odd/tasks/archive/alpha.md"), "# already archived\n");
    await expect(op({})).rejects.toThrow(/PLAN_ARCHIVE_DESTINATION_EXISTS/);
    expect(existsSync(source)).toBe(true);
    rmSync(join(root, "odd/tasks/archive"), { recursive: true, force: true });
    await expect(op({}, { protectedPaths: ["odd/tasks/archive/**"] })).rejects.toThrow(/PLAN_ARCHIVE_PROTECTED_PATH/);
    await expect(op({ name: "Bad Name" })).rejects.toThrow(/PLAN_WRITE_NAME_INVALID/);
    await expect(op({ target: "docs" })).rejects.toThrow(/PLAN_ARCHIVE_TARGET_INVALID/);
    await expect(op({ note: "" })).rejects.toThrow(/PLAN_ARCHIVE_NOTE_INVALID/);
    expect(() => assertPlanArchivePair("tasks", "alpha", "odd/tasks/alpha.md", "odd/mini/archive/alpha.md"))
      .toThrow(/PLAN_ARCHIVE_PATH_ESCAPE/);
    expect(gitOut(root, ["rev-parse", "HEAD"]).trim()).toBe(head);
  }));

  test("binds the payload agent to the session identity and target allowlist", withRepo(async (root) => {
    seed(root, "odd/tasks/alpha.md", "# alpha\n");
    const call = (payload: Record<string, unknown>, bound = "planner") =>
      buildPlanArchiveOp(makeContext(root, bound))(request(root, payload, bound));

    await expect(call({ agent: "pm-odd" })).rejects.toThrow(/PLAN_ARCHIVE_AGENT_MISMATCH/);
    await expect(call({ agent: undefined })).rejects.toThrow(/PLAN_ARCHIVE_AGENT_NOT_BOUND/);
    await expect(call({}, "pm-odd")).rejects.toThrow(/PLAN_ARCHIVE_AGENT_REFUSED/);
    expect(classifyOperation("planArchive")).toBe("MUTATE_PROJECT");
    expect(classifyOperation("host_plan_archive")).toBe("HOST_APPROVED_MUTATION");
    expect(classifyOperation("host_plan_write")).toBe("HOST_APPROVED_MUTATION");
  }));

  test("serialises a concurrent plan write to the archived source", withRepo(async (root) => {
    seed(root, "odd/tasks/alpha.md", "# alpha\n");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { entered = resolve; });
    const real = spawnRealGit();
    const spawn: Spawn = async (argv, opts) => {
      if (argv[1] === "commit" && argv.some((arg) => arg.includes("docs(odd): archive tasks/alpha"))) {
        entered();
        await gate;
      }
      return real(argv, opts);
    };

    const archivePromise = buildPlanArchiveOp(makeContext(root, "planner", spawn))(request(root));
    await blocked;
    const writePromise = buildPlanDocWriteOp(makeContext(root, "planner", spawn))(planWriteRequest(root));
    let settled = false;
    writePromise.then(() => { settled = true; }, () => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release();
    await expect(archivePromise).resolves.toMatchObject({ committed: true });
    await expect(writePromise).resolves.toMatchObject({ revision: 1, created: true });
    expect(existsSync(join(root, "odd/tasks/archive/alpha.md"))).toBe(true);
  }));

  test("rolls the move and index back when the commit fails", withRepo(async (root) => {
    const original = "# alpha\n";
    const source = seed(root, "odd/tasks/alpha.md", original);
    const head = gitOut(root, ["rev-parse", "HEAD"]).trim();
    const real = spawnRealGit();
    const spawn: Spawn = async (argv, opts) => {
      if (argv[1] === "commit" && argv.some((arg) => arg.includes("archive tasks/alpha"))) {
        return { status: 1, stdout: "", stderr: "simulated commit failure\n", timedOut: false };
      }
      return real(argv, opts);
    };

    await expect(buildPlanArchiveOp(makeContext(root, "planner", spawn))(request(root)))
      .rejects.toThrow(/PLAN_ARCHIVE_COMMIT_FAILED.*simulated commit failure/);
    expect(readFileSync(source, "utf8")).toBe(original);
    expect(existsSync(join(root, "odd/tasks/archive/alpha.md"))).toBe(false);
    expect(gitOut(root, ["rev-parse", "HEAD"]).trim()).toBe(head);
    expect(gitOut(root, ["diff", "--cached", "--name-only"]).trim()).toBe("");
    expect(gitOut(root, ["status", "--porcelain"]).trim()).toBe("");
  }));

  test("reconciles a timed-out commit that advanced HEAD as committed", withRepo(async (root) => {
    const source = seed(root, "odd/tasks/alpha.md", "# alpha\n");
    const real = spawnRealGit();
    const spawn: Spawn = async (argv, opts) => {
      if (argv[1] === "commit" && argv.some((arg) => arg.includes("archive tasks/alpha"))) {
        const result = await real(argv, opts);
        // A real commit landed, but the runner reports a signal/timeout code.
        if (result.status !== 0) return result;
        return { status: 143, stdout: result.stdout, stderr: "", timedOut: true };
      }
      return real(argv, opts);
    };

    const result = await buildPlanArchiveOp(makeContext(root, "planner", spawn))(request(root));

    expect(result).toMatchObject({ committed: true });
    expect((result as { commitWarning?: string }).commitWarning).toBeDefined();
    expect(gitOut(root, ["log", "-1", "--format=%s"]).trim()).toBe("docs(odd): archive tasks/alpha");
    expect(readFileSync(join(root, "odd/tasks/archive/alpha.md"), "utf8")).toBe("# alpha\n");
    expect(existsSync(source)).toBe(false);
    expect(gitOut(root, ["status", "--porcelain"]).trim()).toBe("");
  }));

  test("reconciles a status-zero commit timeout instead of reporting a clean success", withRepo(async (root) => {
    const original = "# alpha\n";
    const source = seed(root, "odd/tasks/alpha.md", original);
    const head = gitOut(root, ["rev-parse", "HEAD"]).trim();
    const real = spawnRealGit();
    const spawn: Spawn = async (argv, opts) => {
      if (argv[1] === "commit" && argv.some((arg) => arg.includes("archive tasks/alpha"))) {
        // The runner reports a timeout with status 0 and the commit never landed;
        // if `timedOut` is not forwarded this is mistaken for a clean success.
        return { status: 0, stdout: "", stderr: "", timedOut: true };
      }
      return real(argv, opts);
    };

    await expect(buildPlanArchiveOp(makeContext(root, "planner", spawn))(request(root)))
      .rejects.toThrow(/PLAN_ARCHIVE_COMMIT_FAILED: git step timed out/);
    expect(readFileSync(source, "utf8")).toBe(original);
    expect(existsSync(join(root, "odd/tasks/archive/alpha.md"))).toBe(false);
    expect(gitOut(root, ["rev-parse", "HEAD"]).trim()).toBe(head);
    expect(gitOut(root, ["status", "--porcelain"]).trim()).toBe("");
  }));

  test("treats a timed-out diff comparison as an uncertain commit outcome", withRepo(async (root) => {
    const original = "# alpha\n";
    const source = seed(root, "odd/tasks/alpha.md", original);
    const earlier = gitOut(root, ["rev-parse", "HEAD"]).trim();
    // Advance HEAD so reconciliation sees a real commit id that differs from the
    // pre-operation HEAD without the archive commit landing.
    writeFileSync(join(root, "later.txt"), "later\n");
    execFileSync("git", ["-C", root, "add", "later.txt"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "later"]);
    const preHead = gitOut(root, ["rev-parse", "HEAD"]).trim();
    expect(earlier).not.toBe(preHead);
    const real = spawnRealGit();
    let commitAttempted = false;
    const spawn: Spawn = async (argv, opts) => {
      if (argv[1] === "commit" && argv.some((arg) => arg.includes("archive tasks/alpha"))) {
        commitAttempted = true;
        // Status-zero timeout that never landed the archive commit.
        return { status: 0, stdout: "", stderr: "", timedOut: true };
      }
      if (commitAttempted && argv[1] === "rev-parse" && argv[2] === "HEAD") {
        return { status: 0, stdout: `${earlier}\n`, stderr: "", timedOut: false };
      }
      if (commitAttempted && argv[1] === "diff") {
        // A killed comparison reports status 0 without finishing the tree check.
        return { status: 0, stdout: "", stderr: "", timedOut: true };
      }
      return real(argv, opts);
    };

    await expect(buildPlanArchiveOp(makeContext(root, "planner", spawn))(request(root)))
      .rejects.toThrow(/PLAN_ARCHIVE_UNCERTAIN_STATE/);
    // The move must NOT be undone: the incomplete comparison cannot prove the
    // commit is absent.
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(join(root, "odd/tasks/archive/alpha.md"), "utf8")).toBe(original);
    expect(gitOut(root, ["rev-parse", "HEAD"]).trim()).toBe(preHead);
  }));

  test("fails closed when reconciliation cannot spawn git", withRepo(async (root) => {
    const source = seed(root, "odd/tasks/alpha.md", "# alpha\n");
    const head = gitOut(root, ["rev-parse", "HEAD"]).trim();
    const real = spawnRealGit();
    let commitAttempted = false;
    const spawn: Spawn = async (argv, opts) => {
      if (argv[1] === "commit" && argv.some((arg) => arg.includes("archive tasks/alpha"))) {
        commitAttempted = true;
        return { status: null, stdout: "", stderr: "", timedOut: true };
      }
      if (commitAttempted && argv[1] === "rev-parse" && argv[2] === "HEAD") {
        throw Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" });
      }
      return real(argv, opts);
    };

    await expect(buildPlanArchiveOp(makeContext(root, "planner", spawn))(request(root)))
      .rejects.toThrow(/PLAN_ARCHIVE_UNCERTAIN_STATE/);
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(join(root, "odd/tasks/archive/alpha.md"), "utf8")).toBe("# alpha\n");
    expect(gitOut(root, ["rev-parse", "HEAD"]).trim()).toBe(head);
  }));

  test("never rolls back a commit spawn rejection that reconciliation cannot resolve", withRepo(async (root) => {
    const source = seed(root, "odd/tasks/alpha.md", "# alpha\n");
    const head = gitOut(root, ["rev-parse", "HEAD"]).trim();
    const real = spawnRealGit();
    let commitAttempted = false;
    const spawn: Spawn = async (argv, opts) => {
      if (argv[1] === "commit" && argv.some((arg) => arg.includes("archive tasks/alpha"))) {
        commitAttempted = true;
        throw Object.assign(new Error("spawn EBUSY"), { code: "EBUSY" });
      }
      if (commitAttempted && argv[1] === "rev-parse" && argv[2] === "HEAD") {
        throw Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" });
      }
      return real(argv, opts);
    };

    await expect(buildPlanArchiveOp(makeContext(root, "planner", spawn))(request(root)))
      .rejects.toThrow(/PLAN_ARCHIVE_UNCERTAIN_STATE/);
    // The move must NOT be undone: a rejected commit invocation may have landed.
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(join(root, "odd/tasks/archive/alpha.md"), "utf8")).toBe("# alpha\n");
    expect(gitOut(root, ["rev-parse", "HEAD"]).trim()).toBe(head);
  }));

  test("names both paths when a move-back fails", () => {
    expect(() => rollbackPlanArchiveMove(
      "/p/odd/tasks/alpha.md", "/p/odd/tasks/archive/alpha.md", "odd/tasks/alpha.md", "odd/tasks/archive/alpha.md",
      () => { throw new Error("rename denied"); },
    )).toThrow(/PLAN_ARCHIVE_ROLLBACK_FAILED: odd\/tasks\/alpha\.md -> odd\/tasks\/archive\/alpha\.md.*rename denied/);
  });
});
