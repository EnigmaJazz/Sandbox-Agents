/**
 * T1 (read) — host sandbox-result read operation.
 *
 * Verifies the fixed argv vectors, the fail-closed session resolution, the
 * bounded/redacted patch, the two-ref comparison mode, and that a read never
 * mutates the working tree or the index.
 */
import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config.ts";
import { GIT_OUTPUT_MAX_BYTES } from "../src/gitops.ts";
import { buildSandboxResultOp, type OpContext } from "../src/service.ts";
import { StateError } from "../src/state.ts";
import { ValidationError } from "../src/validation.ts";
import type { BrokerRequestEnvelope, SessionRecord } from "../src/types.ts";

const ORCHESTRATOR = "gentle-orchestrator";
const projectRoot = process.cwd();

const BASELINE_7 = "refs/opencode-sandbox/baseline/worker-7";
const RESULT_7 = "refs/opencode-sandbox/result/worker-7";
const RESULT_8 = "refs/opencode-sandbox/result/worker-8";

const IDENTITY_7 =
  "0123456789abcdef0123456789abcdef01234567\u00002026-09-23T10:00:00+00:00\u0000fix: worker seven";
const IDENTITY_8 =
  "89abcdef0123456789abcdef0123456789abcdef\u00002026-09-23T11:30:00+00:00\u0000fix: worker eight";

function request(payload: Record<string, unknown>): BrokerRequestEnvelope {
  return {
    version: 1,
    id: "req-sandboxResult",
    operation: "sandboxResult",
    sessionID: "session-1",
    agent: ORCHESTRATOR,
    payload,
  };
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
    store: { get: (sessionID: string) => records[sessionID] },
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

const isShow = (argv: string[]) => argv[1] === "show";
const isNumstat = (argv: string[]) => argv.includes("--numstat");
const isNameOnly = (argv: string[]) => argv.includes("--name-only");
const isPatch = (argv: string[]) =>
  argv[1] === "diff" && !isNumstat(argv) && !isNameOnly(argv);

const IDENTITY_RULE: StubRule = {
  match: isShow,
  result: { status: 0, stdout: `${IDENTITY_7}\n`, stderr: "" },
};
const NUMSTAT_RULE: StubRule = {
  match: isNumstat,
  result: { status: 0, stdout: "3\t1\ta.ts\u0000", stderr: "" },
};
const PATHS_RULE: StubRule = {
  match: isNameOnly,
  result: { status: 0, stdout: "a.ts\u0000", stderr: "" },
};
const PATCH_RULE: StubRule = {
  match: isPatch,
  result: {
    status: 0,
    stdout: "diff --git a/a.ts b/a.ts\n@@ -1 +1,3 @@\n+api_key=supersecretvalue\n",
    stderr: "",
  },
};

const READ_SUBCOMMANDS = new Set([
  "diff",
  "show",
  "name-only",
  "numstat",
  "ls-tree",
  "ls-files",
  "rev-parse",
  "symbolic-ref",
]);

describe("sandboxResult read — fixed argv and identity", () => {
  test("reads the result ref's identity, changed paths and patch with fixed argv", async () => {
    const { calls, spawn } = spawnStub([
      IDENTITY_RULE,
      NUMSTAT_RULE,
      PATHS_RULE,
      PATCH_RULE,
    ]);
    const ctx = makeCtx(spawn, {
      "session-1": readableRecord("session-1", { state: "HOST_READ_ONLY", resultRef: undefined }),
      "worker-7": readableRecord("worker-7"),
    });

    const result = (await buildSandboxResultOp(ctx)(
      request({ projectDir: projectRoot, sandboxSessionID: "worker-7" }),
    )) as {
      mode: string;
      sessionID: string;
      result: { ref: string; commit: string; committedAt: string; subject: string };
      baseline: { ref: string };
      changedPaths: { path: string; added: number | null; removed: number | null }[];
      patch: string;
      patchTruncated: boolean;
    };

    expect(result.mode).toBe("result");
    expect(result.sessionID).toBe("worker-7");
    expect(result.result.ref).toBe(RESULT_7);
    expect(result.result.commit).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(result.result.committedAt).toBe("2026-09-23T10:00:00+00:00");
    expect(result.result.subject).toBe("fix: worker seven");
    expect(result.baseline.ref).toBe(BASELINE_7);
    expect(result.changedPaths).toEqual([{ path: "a.ts", added: 3, removed: 1 }]);
    expect(result.patchTruncated).toBe(false);
    expect(result.patch).toContain("diff --git a/a.ts b/a.ts");

    expect(calls).toContainEqual([
      "git",
      "show",
      "-s",
      "--format=%H%x00%cI%x00%s",
      RESULT_7,
    ]);
    expect(calls).toContainEqual([
      "git",
      "diff",
      "--numstat",
      "--no-renames",
      "-z",
      BASELINE_7,
      RESULT_7,
      "--",
      ".",
    ]);
    expect(calls).toContainEqual([
      "git",
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      BASELINE_7,
      RESULT_7,
      "--",
      ".",
    ]);
    expect(calls).toContainEqual(["git", "diff", BASELINE_7, RESULT_7, "--", "."]);
  });

  test("every spawned vector is an argv array with a fixed git binary (never a shell string)", async () => {
    const { calls, spawn } = spawnStub([IDENTITY_RULE, NUMSTAT_RULE, PATHS_RULE, PATCH_RULE]);
    const ctx = makeCtx(spawn, {
      "session-1": readableRecord("session-1", { state: "HOST_READ_ONLY", resultRef: undefined }),
      "worker-7": readableRecord("worker-7"),
    });
    await buildSandboxResultOp(ctx)(
      request({ projectDir: projectRoot, sandboxSessionID: "worker-7" }),
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const argv of calls) {
      expect(Array.isArray(argv)).toBe(true);
      expect(argv[0]).toBe("git");
      for (const token of argv) {
        expect(token).not.toContain(";");
        expect(token).not.toContain("&&");
        expect(token).not.toContain("|");
        expect(token).not.toContain("$(");
      }
    }
    const joined = calls.flat().join(" ");
    expect(joined).not.toContain(" -A ");
    expect(joined).not.toContain("--all");
  });

  test("reads the caller's own result when sandboxSessionID is omitted", async () => {
    const { calls, spawn } = spawnStub([IDENTITY_RULE, NUMSTAT_RULE, PATHS_RULE, PATCH_RULE]);
    const ctx = makeCtx(spawn, { "session-1": readableRecord("session-1") });
    const result = (await buildSandboxResultOp(ctx)(
      request({ projectDir: projectRoot }),
    )) as { sessionID: string; result: { ref: string } };
    expect(result.sessionID).toBe("session-1");
    expect(result.result.ref).toBe("refs/opencode-sandbox/result/session-1");
    expect(calls.some((c) => c.includes("refs/opencode-sandbox/result/session-1"))).toBe(true);
  });
});

describe("sandboxResult read — fail closed", () => {
  test("refuses an unknown session with a named reason and spawns no git", async () => {
    const { calls, spawn } = spawnStub([]);
    const ctx = makeCtx(spawn, {
      "session-1": readableRecord("session-1", { state: "HOST_READ_ONLY", resultRef: undefined }),
    });
    await expect(
      buildSandboxResultOp(ctx)(
        request({ projectDir: projectRoot, sandboxSessionID: "ghost" }),
      ),
    ).rejects.toThrow(/unknown session ghost/);
    expect(calls).toHaveLength(0);
  });

  test("refuses a session with no durable result", async () => {
    const { calls, spawn } = spawnStub([]);
    const ctx = makeCtx(spawn, {
      "session-1": readableRecord("session-1", { state: "HOST_READ_ONLY", resultRef: undefined }),
      "worker-7": readableRecord("worker-7", { state: "SANDBOX_ACTIVE", resultRef: undefined }),
    });
    await expect(
      buildSandboxResultOp(ctx)(
        request({ projectDir: projectRoot, sandboxSessionID: "worker-7" }),
      ),
    ).rejects.toThrow(StateError);
    expect(calls).toHaveLength(0);
  });

  test("refuses a session bound to another project", async () => {
    const { calls, spawn } = spawnStub([]);
    const ctx = makeCtx(spawn, {
      "session-1": readableRecord("session-1", { state: "HOST_READ_ONLY", resultRef: undefined }),
      "worker-7": readableRecord("worker-7", { projectID: "other" }),
    });
    await expect(
      buildSandboxResultOp(ctx)(
        request({ projectDir: projectRoot, sandboxSessionID: "worker-7" }),
      ),
    ).rejects.toThrow(/not bound to this project/);
    expect(calls).toHaveLength(0);
  });

  test("refuses a malformed sandboxSessionID before any lookup", async () => {
    const { calls, spawn } = spawnStub([]);
    const ctx = makeCtx(spawn, {
      "session-1": readableRecord("session-1", { state: "HOST_READ_ONLY", resultRef: undefined }),
    });
    for (const sandboxSessionID of ["../escape", "a/b", ".hidden"]) {
      await expect(
        buildSandboxResultOp(ctx)(
          request({ projectDir: projectRoot, sandboxSessionID }),
        ),
      ).rejects.toThrow(ValidationError);
    }
    expect(calls).toHaveLength(0);
  });

  test("rejects an out-of-allowlist payload key (no raw ref)", async () => {
    const { calls, spawn } = spawnStub([]);
    const ctx = makeCtx(spawn, {
      "session-1": readableRecord("session-1", { state: "HOST_READ_ONLY", resultRef: undefined }),
    });
    await expect(
      buildSandboxResultOp(ctx)(
        request({
          projectDir: projectRoot,
          sandboxSessionID: "worker-7",
          ref: "refs/heads/main",
        }),
      ),
    ).rejects.toThrow(ValidationError);
    expect(calls).toHaveLength(0);
  });
});

describe("sandboxResult read — bounded output", () => {
  test("caps and redacts the patch, reporting truncation", async () => {
    const huge = `diff --git a/a.ts b/a.ts\n+api_key=supersecretvalue\n${"x".repeat(
      GIT_OUTPUT_MAX_BYTES + 4096,
    )}`;
    const { spawn } = spawnStub([
      IDENTITY_RULE,
      NUMSTAT_RULE,
      PATHS_RULE,
      { match: isPatch, result: { status: 0, stdout: huge, stderr: "" } },
    ]);
    const ctx = makeCtx(spawn, {
      "session-1": readableRecord("session-1", { state: "HOST_READ_ONLY", resultRef: undefined }),
      "worker-7": readableRecord("worker-7"),
    });
    const result = (await buildSandboxResultOp(ctx)(
      request({ projectDir: projectRoot, sandboxSessionID: "worker-7" }),
    )) as { patch: string; patchTruncated: boolean };
    expect(result.patchTruncated).toBe(true);
    expect(Buffer.byteLength(result.patch, "utf8")).toBeLessThanOrEqual(
      GIT_OUTPUT_MAX_BYTES,
    );
    expect(result.patch).toContain("api_key=REDACTED");
  });
});

describe("sandboxResult read — two-ref comparison", () => {
  test("compares two result refs resolved from session ids", async () => {
    const { calls, spawn } = spawnStub([
      {
        match: isShow,
        result: {
          status: 0,
          stdout: `${IDENTITY_7}\n`,
          stderr: "",
        },
      },
      {
        match: (argv) => argv.includes("--numstat") && argv.includes(RESULT_8),
        result: { status: 0, stdout: "5\t0\tb.ts\u0000", stderr: "" },
      },
      {
        match: (argv) => argv.includes("--numstat"),
        result: { status: 0, stdout: "3\t1\ta.ts\u0000", stderr: "" },
      },
      {
        match: (argv) => argv.includes("--name-only") && argv.includes(RESULT_8),
        result: { status: 0, stdout: "b.ts\u0000", stderr: "" },
      },
      PATHS_RULE,
      PATCH_RULE,
    ]);
    const ctx = makeCtx(spawn, {
      "session-1": readableRecord("session-1", { state: "HOST_READ_ONLY", resultRef: undefined }),
      "worker-7": readableRecord("worker-7"),
      "worker-8": readableRecord("worker-8"),
    });
    const result = (await buildSandboxResultOp(ctx)(
      request({
        projectDir: projectRoot,
        sandboxSessionID: "worker-7",
        compareSandboxSessionID: "worker-8",
      }),
    )) as {
      mode: string;
      comparison: {
        from: { ref: string };
        to: { ref: string };
        changedPaths: { path: string; added: number | null; removed: number | null }[];
      } | null;
    };
    expect(result.mode).toBe("compare");
    expect(result.comparison).not.toBeNull();
    expect(result.comparison?.from.ref).toBe(RESULT_7);
    expect(result.comparison?.to.ref).toBe(RESULT_8);
    expect(result.comparison?.changedPaths).toEqual([
      { path: "b.ts", added: 5, removed: 0 },
    ]);
    expect(calls).toContainEqual([
      "git",
      "diff",
      "--numstat",
      "--no-renames",
      "-z",
      RESULT_7,
      RESULT_8,
      "--",
      ".",
    ]);
    expect(calls).toContainEqual(["git", "diff", RESULT_7, RESULT_8, "--", "."]);
  });

  test("refuses a comparison session bound to another project", async () => {
    const { calls, spawn } = spawnStub([]);
    const ctx = makeCtx(spawn, {
      "session-1": readableRecord("session-1", { state: "HOST_READ_ONLY", resultRef: undefined }),
      "worker-7": readableRecord("worker-7"),
      "worker-8": readableRecord("worker-8", { projectID: "other" }),
    });
    await expect(
      buildSandboxResultOp(ctx)(
        request({
          projectDir: projectRoot,
          sandboxSessionID: "worker-7",
          compareSandboxSessionID: "worker-8",
        }),
      ),
    ).rejects.toThrow(/not bound to this project/);
    expect(calls).toHaveLength(0);
  });
});

describe("sandboxResult read — working tree and index untouched", () => {
  test("issues only read subcommands and never stages, applies or moves a ref", async () => {
    const { calls, spawn } = spawnStub([
      IDENTITY_RULE,
      NUMSTAT_RULE,
      PATHS_RULE,
      PATCH_RULE,
    ]);
    const ctx = makeCtx(spawn, {
      "session-1": readableRecord("session-1", { state: "HOST_READ_ONLY", resultRef: undefined }),
      "worker-7": readableRecord("worker-7"),
    });
    await buildSandboxResultOp(ctx)(
      request({ projectDir: projectRoot, sandboxSessionID: "worker-7" }),
    );
    const mutating = new Set([
      "add",
      "commit",
      "apply",
      "checkout",
      "reset",
      "restore",
      "stash",
      "update-ref",
      "rm",
      "mv",
      "fetch",
      "push",
      "clean",
    ]);
    for (const argv of calls) {
      expect(READ_SUBCOMMANDS.has(argv[1] ?? "")).toBe(true);
      expect(mutating.has(argv[1] ?? "")).toBe(false);
      expect(argv).not.toContain("--index");
    }
  });
});
