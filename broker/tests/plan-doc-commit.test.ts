import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import {
  assertPlanDocCommitPath,
  buildGateVerdictOp,
  buildPlanDocWriteOp,
  buildTaskMarkOp,
  commitPlanDocRevision,
} from "../src/service.ts";
import type { BrokerRequestEnvelope, SessionRecord } from "../src/types.ts";

const ORCHESTRATOR = "gentle-orchestrator";
const SESSION = "session-plan-commit";

interface SpawnOptionsLike {
  cwd?: string;
  env?: Record<string, string>;
}

interface SpawnResultLike {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Real git spawn used by the operation contexts. `sanitizeIdentity` removes
 * inherited author/committer/email variables so the "no user.email" case fails
 * for the reason the test names, not because of the host environment.
 */
function spawnRealGit(options: { sanitizeIdentity?: boolean } = {}) {
  const baseEnv = (): NodeJS.ProcessEnv => {
    const env = { ...process.env };
    if (!options.sanitizeIdentity) return env;
    for (const key of Object.keys(env)) {
      if (/^(?:GIT_AUTHOR_|GIT_COMMITTER_|EMAIL|GIT_CONFIG|GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE)/.test(key)) {
        delete env[key];
      }
    }
    return env;
  };
  return async (argv: string[], opts: SpawnOptionsLike): Promise<SpawnResultLike> => {
    try {
      const stdout = execFileSync(argv[0]!, argv.slice(1), {
        cwd: opts.cwd,
        env: { ...baseEnv(), ...(opts.env ?? {}) },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
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

function withProject(run: (root: string, seed: string) => Promise<void>) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-doc-commit-"));
    try {
      execFileSync("git", ["init", "-q", root]);
      execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
      execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
      writeFileSync(join(root, "seed.txt"), "seed\n");
      execFileSync("git", ["-C", root, "add", "seed.txt"]);
      execFileSync("git", ["-C", root, "commit", "-qm", "seed"]);
      const seed = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      await run(root, seed);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

/** Repo without identity: `git commit` has no user.email to write a commit. */
function withBareRepo(run: (root: string) => Promise<void>) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-doc-commit-noid-"));
    try {
      execFileSync("git", ["init", "-q", root]);
      await run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function makeContext(root: string, identity = "planner", spawn = spawnRealGit()) {
  const config = defaultConfig({
    projects: [{ id: "plan-doc-commit-test", path: root }],
    readOnlyAgents: [ORCHESTRATOR],
  });
  const record: SessionRecord = {
    sessionID: SESSION,
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
    git: { runnerMode: "real", spawn },
    reviewAssess: async () => ({ status: 0, json: { tier: "medium" } }),
  } as never;
}

function planWriteRequest(root: string, payload: Record<string, unknown> = {}): BrokerRequestEnvelope {
  const agent = "planner";
  return {
    version: 1, id: "plan-write", operation: "planDocWrite", sessionID: SESSION, agent,
    payload: {
      projectDir: root, target: "tasks", name: "phase-commit", content: "# Phase commit",
      expectedRevision: 0, note: "initial", agent, ...payload,
    },
  } as BrokerRequestEnvelope;
}

function gateRequest(root: string, name: string, taskId: string, verdict: string): BrokerRequestEnvelope {
  return {
    version: 1, id: "gate", operation: "gateVerdict", sessionID: SESSION, agent: "planner",
    payload: { projectDir: root, name, taskId, verdict, agent: "planner" },
  } as BrokerRequestEnvelope;
}

function taskMarkRequest(root: string, name: string, evidenceCommit: string, payload: Record<string, unknown> = {}): BrokerRequestEnvelope {
  return {
    version: 1, id: "task-mark", operation: "taskMark", sessionID: SESSION, agent: "pm-odd",
    payload: {
      projectDir: root, target: "tasks", name, taskId: "T5", status: "passed",
      evidenceCommit, note: "done", ...payload,
    },
  } as BrokerRequestEnvelope;
}

function seedPlan(root: string, relative: string, text: string): string {
  const absolute = join(root, relative);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
  execFileSync("git", ["-C", root, "add", "--", relative]);
  execFileSync("git", ["-C", root, "commit", "-qm", "seed plan"]);
  return absolute;
}

function headOf(root: string): string {
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function lastMessage(root: string): string {
  return execFileSync("git", ["-C", root, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
}

function lastCommitPaths(root: string): string[] {
  return execFileSync("git", ["-C", root, "log", "-1", "--name-only", "--format="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
}

describe("plan document commits", () => {
  test("commits a fresh revision, lists exactly the plan file, and reports a 40-char id", withProject(async (root, seed) => {
    const result = await buildPlanDocWriteOp(makeContext(root))(planWriteRequest(root)) as Record<string, unknown>;
    expect(result).toMatchObject({ revision: 1, created: true, committed: true });
    expect(String(result.commit)).toMatch(/^[0-9a-f]{40}$/);
    expect(result.commit).not.toBe(seed);
    expect(lastCommitPaths(root)).toEqual(["odd/tasks/phase-commit.md"]);
    expect(lastMessage(root)).toBe("docs(odd): phase-commit r1 plan revision");
  }));

  test("commits the plan file while an unrelated modified file stays modified and uncommitted", withProject(async (root) => {
    writeFileSync(join(root, "unrelated.txt"), "unrelated\n");
    execFileSync("git", ["-C", root, "add", "unrelated.txt"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "unrelated"]);
    writeFileSync(join(root, "unrelated.txt"), "unrelated modified\n");

    const result = await buildPlanDocWriteOp(makeContext(root))(planWriteRequest(root)) as Record<string, unknown>;
    expect(result).toMatchObject({ committed: true });
    expect(lastCommitPaths(root)).toEqual(["odd/tasks/phase-commit.md"]);
    const status = execFileSync("git", ["-C", root, "status", "--porcelain", "--", "unrelated.txt"], { encoding: "utf8" });
    expect(status.trimEnd()).toBe(" M unrelated.txt");
  }));

  test("leaves an unrelated STAGED file staged and out of the plan commit", withProject(async (root) => {
    writeFileSync(join(root, "staged.txt"), "staged\n");
    execFileSync("git", ["-C", root, "add", "staged.txt"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "staged"]);
    writeFileSync(join(root, "staged.txt"), "staged modified\n");
    execFileSync("git", ["-C", root, "add", "staged.txt"]);

    const result = await buildPlanDocWriteOp(makeContext(root))(planWriteRequest(root)) as Record<string, unknown>;
    expect(result).toMatchObject({ committed: true });
    expect(lastCommitPaths(root)).toEqual(["odd/tasks/phase-commit.md"]);
    const status = execFileSync("git", ["-C", root, "status", "--porcelain", "--", "staged.txt"], { encoding: "utf8" });
    expect(status.trimEnd()).toBe("M  staged.txt");
    const staged = execFileSync("git", ["-C", root, "diff", "--cached", "--name-only"], { encoding: "utf8" });
    expect(staged.split("\n").filter((line) => line.length > 0)).toEqual(["staged.txt"]);
  }));

  test("commits a gate verdict with the gate message", withProject(async (root) => {
    seedPlan(root, "odd/tasks/phase-gate.md", "# Phase gate\n\n## Revisions\n- r1 2026-01-01T00:00:00Z planner: initial\n");
    const result = await buildGateVerdictOp(makeContext(root, "planner"))(
      gateRequest(root, "phase-gate", "unit-a", "PASS"),
    ) as Record<string, unknown>;
    expect(result).toMatchObject({ committed: true, gates: 1 });
    expect(lastMessage(root)).toBe("docs(odd): phase-gate gate unit-a PASS");
    expect(lastCommitPaths(root)).toEqual(["odd/tasks/phase-gate.md"]);
  }));

  test("commits a task tick with the tick message naming the same task", withProject(async (root, seed) => {
    const path = seedPlan(root, "odd/tasks/phase-tick.md", "# Phase tick\n\n## Revisions\n- r1 2026-01-01T00:00:00Z pm-odd: initial\n");
    const result = await buildTaskMarkOp(makeContext(root, "pm-odd"))(
      taskMarkRequest(root, "phase-tick", seed),
    ) as Record<string, unknown>;
    expect(result).toMatchObject({ committed: true, revision: 2 });
    expect(lastMessage(root)).toBe("docs(odd): phase-tick tick T5 passed");
    expect(lastMessage(root)).toContain("T5");
    expect(lastCommitPaths(root)).toEqual(["odd/tasks/phase-tick.md"]);
    expect(readFileSync(path, "utf8")).toContain(`T5 passed evidence=${seed}`);
  }));

  test("refuses a tick without PASS: no commit and no revision bump", withProject(async (root, seed) => {
    const path = seedPlan(
      root,
      "odd/tasks/phase-refused.md",
      "# Phase refused\n\n## Gates\n- T5 REFINE 2026-01-01T00:00:00Z planner\n\n## Revisions\n- r1 2026-01-01T00:00:00Z pm-odd: initial\n",
    );
    const beforeHead = headOf(root);
    const beforeText = readFileSync(path, "utf8");

    await expect(buildTaskMarkOp(makeContext(root, "pm-odd"))(taskMarkRequest(root, "phase-refused", seed)))
      .rejects.toThrow("TASK_MARK_GATE_NOT_PASSED");

    expect(headOf(root)).toBe(beforeHead);
    expect(readFileSync(path, "utf8")).toBe(beforeText);
    expect(lastMessage(root)).toBe("seed plan");
  }));

  test("a commit failure keeps the durable write and reports a bounded commitError", withBareRepo(async (root) => {
    const result = await buildPlanDocWriteOp(makeContext(root, "planner", spawnRealGit({ sanitizeIdentity: true })))(
      planWriteRequest(root),
    ) as Record<string, unknown>;

    expect(result).toMatchObject({ revision: 1, committed: false });
    const commitError = String(result.commitError);
    expect(commitError.length).toBeGreaterThan(0);
    expect(commitError.length).toBeLessThanOrEqual(200);
    expect(commitError).not.toContain("\n");

    const text = readFileSync(join(root, "odd/tasks/phase-commit.md"), "utf8");
    expect(text).toContain("## Revisions");
    expect(text).toContain("- r1 ");
    expect(() => headOf(root)).toThrow();
  }));

  test("leaves an unchanged plan document uncommitted (no-op write)", withProject(async (root) => {
    seedPlan(root, "odd/tasks/phase-noop.md", "# Phase noop\n\n## Revisions\n- r1 2026-01-01T00:00:00Z planner: initial\n");
    const beforeHead = headOf(root);

    const result = await commitPlanDocRevision(
      makeContext(root),
      root,
      "odd/tasks/phase-noop.md",
      "docs(odd): phase-noop r1 plan revision",
    );

    expect(result).toEqual({ committed: false });
    expect(headOf(root)).toBe(beforeHead);
    expect(lastMessage(root)).toBe("seed plan");
  }));

  test("asserts the plan-root guard instead of assuming it", () => {
    expect(() => assertPlanDocCommitPath("broker/src/service.ts")).toThrow("PLAN_DOC_COMMIT_PATH_OUTSIDE_PLAN_ROOT");
    expect(() => assertPlanDocCommitPath("odd/tasks/../tasks/escape.md")).toThrow("PLAN_DOC_COMMIT_PATH_OUTSIDE_PLAN_ROOT");
    expect(assertPlanDocCommitPath("odd/mini/mini-plan.md")).toBe("odd/mini/mini-plan.md");
  });
});
