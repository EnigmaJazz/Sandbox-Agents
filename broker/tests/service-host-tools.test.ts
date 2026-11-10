import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config.ts";
import { PolicyError } from "../src/policy.ts";
import { authorizeHostDispatch } from "../src/service.ts";
import { buildGhIssueCreateOp, buildGitBranchOp, buildGitHeadOp, buildGitWorktreeOp, buildGitCommitOp, buildGitPushOp, buildRegisterProjectOp } from "../src/service.ts";
import { MsbError } from "../src/msb.ts";
import { StateError } from "../src/state.ts";
import { GitGuardError, gitSubcommand } from "../src/gitguard.ts";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlanDocAppendOp, computePlanDocAppend } from "../src/service.ts";
import {
  buildReviewAssessOp,
  buildReviewAcknowledgeApprovedOp,
  buildReviewCaptureCorrectionPlanOp,
  buildReviewCaptureRefuterOp,
  buildReviewCaptureResultOp,
  buildReviewCaptureUnachievableOp,
  buildReviewCaptureValidationOp,
  buildReviewLensContextOp,
  buildReviewRecoverOp,
  buildReviewStartOp,
  buildReviewValidateOp,
  buildReviewModeStatusOp,
  buildReviewStatusOp,
  buildSddArchiveComposeOp,
  buildSddAttemptGrantOp,
  buildSddContinueOp,
  buildSddStatusOp,
  buildSddTaskResultOp,
  type SddOpContext,
} from "../src/sdd-service.ts";
import { gitDirFor, HOST_MUTATION_OPERATIONS, HOST_READ_OPERATIONS, ValidationError } from "../src/validation.ts";
import { GIT_HEAD_BRANCH_MAX_BYTES } from "../src/gitops.ts";
import type { BrokerRequestEnvelope, SessionRecord } from "../src/types.ts";

// Host mutations require a broker-bound session record carrying this agent.
const ORCHESTRATOR = "gentle-orchestrator";

interface RuntimeCall {
  method: string;
  payload: unknown;
}

function makeRuntime() {
  const calls: RuntimeCall[] = [];
  const record = (method: string) => (payload: unknown) => {
    calls.push({ method, payload });
    return Promise.resolve({ status: 0, json: {}, stderr: "" });
  };
  const runtime = {
    calls,
    status: (projectDir: unknown, options: unknown) => {
      calls.push({ method: "status", payload: { projectDir, options } });
      return Promise.resolve({ status: 0, json: {}, stderr: "" });
    },
    sddContinue: record("sddContinue"),
    archiveCompose: record("archiveCompose"),
    taskResult: record("taskResult"),
    reviewAssess: record("reviewAssess"),
    reviewModeStatus: record("reviewModeStatus"),
    reviewStatus: record("reviewStatus"),
    reviewLensContext: record("reviewLensContext"),
    attemptGrant: record("attemptGrant"),
    reviewStart: record("reviewStart"),
    reviewCaptureResult: record("reviewCaptureResult"),
    reviewCaptureUnachievable: record("reviewCaptureUnachievable"),
    reviewAcknowledgeApproved: record("reviewAcknowledgeApproved"),
    reviewCaptureCorrectionPlan: record("reviewCaptureCorrectionPlan"),
    reviewCaptureRefuter: record("reviewCaptureRefuter"),
    reviewCaptureValidation: record("reviewCaptureValidation"),
    reviewValidate: record("reviewValidate"),
    reviewRecover: record("reviewRecover"),
  };
  return runtime;
}

function makeCtx(options: { recordAgent?: string; readOnlyAgents?: string[] } = {}): SddOpContext {
  const config = defaultConfig({
    readOnlyAgents: options.readOnlyAgents ?? [ORCHESTRATOR],
    // These tests exercise the SDD operations as they run on gentle-ai 3.x
    // (the rollback path); the dormant default is covered by legacy-sdd-dormancy.test.ts.
    sddRuntime: { legacySddEnabled: true },
  });
  const record: SessionRecord | undefined =
    (options as { noRecord?: boolean }).noRecord === true
      ? undefined
      : {
          sessionID: "session-1",
          state: "HOST_READ_ONLY",
          agent: options.recordAgent ?? ORCHESTRATOR,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
  return {
    config,
    store: { get: () => record },
    sddRuntime: makeRuntime(),
    pool: { allocations: [] },
    hostRead: { has: () => false },
    logger: {},
    resources: {},
    budget: {},
    adapter: {},
    git: { runnerMode: "planned", spawn: async () => ({ status: 0, stdout: "", stderr: "", timedOut: false }) },
  } as unknown as SddOpContext;
}

function request(
  operation: BrokerRequestEnvelope["operation"],
  payload: Record<string, unknown>,
  agent?: string,
): BrokerRequestEnvelope {
  return {
    version: 1,
    id: `req-${operation}`,
    operation,
    sessionID: "session-1",
    ...(agent ? { agent } : {}),
    payload,
  };
}

const READ_REQUESTS: Array<[BrokerRequestEnvelope["operation"], Record<string, unknown>]> = [
  ["sddStatus", { projectDir: "/repo" }],
  ["sddContinue", { projectDir: "/repo" }],
  ["sddTaskResult", { projectDir: "/repo", phase: "apply", input: "task.json" }],
  ["reviewAssess", { projectDir: "/repo" }],
  ["reviewModeStatus", { projectDir: "/repo" }],
  ["reviewStatus", { projectDir: "/repo", agent: "opencode" }],
  ["reviewLensContext", { projectDir: "/repo", repositoryContext: "R", lineage: "L", target: "T", expectedRevision: `sha256:${"a".repeat(64)}`, lens: "review-risk" }],
];

const MUTATION_REQUESTS: Array<[BrokerRequestEnvelope["operation"], Record<string, unknown>]> = [
  ["sddArchiveCompose", { projectDir: "/repo", canonical: "a.md", delta: "b.md", output: "c.md" }],
  ["gitCommit", { projectDir: "/repo", message: "fix: scoped" }],
  ["gitPush", { projectDir: "/repo", remote: "origin" }],
  ["gitBranch", { projectDir: "/repo", name: "feature/x" }],
  ["ghIssueCreate", { projectDir: "/repo", repo: "owner/repo", title: "Bug", body: "body" }],
  ["sddAttemptGrant", { projectDir: "/repo", change: "agent-host-tools", roots: ["/home/james/a"], changeInstance: "instance-token", requestId: "grant-request", actor: "gentle-orchestrator", reason: "widen" }],
  ["planDocAppend", { projectDir: "/repo", doc: "todo", content: "hello" }],
  ["reviewStart", { projectDir: "/repo", focus: "risk" }],
  ["reviewCaptureResult", { projectDir: "/repo", input: "-" }],
  ["reviewCaptureUnachievable", { projectDir: "/repo", reason: "cannot" }],
  ["reviewAcknowledgeApproved", { projectDir: "/repo" }],
  ["reviewCaptureCorrectionPlan", { projectDir: "/repo", correctionLines: 3 }],
  ["reviewCaptureRefuter", { projectDir: "/repo", materialize: true }],
  ["reviewCaptureValidation", { projectDir: "/repo", execute: true }],
  ["reviewValidate", { projectDir: "/repo", gate: "pre-pr" }],
  ["reviewRecover", { projectDir: "/repo", disposition: "scope_changed" }],
  ["registerProject", { path: "/srv/project", dryRun: true }],
];

const HANDLERS: Record<
  string,
  (ctx: SddOpContext) => (req: BrokerRequestEnvelope) => Promise<unknown>
> = {
  sddStatus: buildSddStatusOp,
  sddContinue: buildSddContinueOp,
  sddTaskResult: buildSddTaskResultOp,
  reviewAssess: buildReviewAssessOp,
  reviewModeStatus: buildReviewModeStatusOp,
  reviewStatus: buildReviewStatusOp,
  reviewLensContext: buildReviewLensContextOp,
  sddArchiveCompose: buildSddArchiveComposeOp,
  gitCommit: buildGitCommitOp,
  gitPush: buildGitPushOp,
  gitBranch: buildGitBranchOp,
  ghIssueCreate: buildGhIssueCreateOp,
  sddAttemptGrant: buildSddAttemptGrantOp,
  planDocAppend: buildPlanDocAppendOp,
  reviewStart: buildReviewStartOp,
  reviewCaptureResult: buildReviewCaptureResultOp,
  reviewCaptureUnachievable: buildReviewCaptureUnachievableOp,
  reviewAcknowledgeApproved: buildReviewAcknowledgeApprovedOp,
  reviewCaptureCorrectionPlan: buildReviewCaptureCorrectionPlanOp,
  reviewCaptureRefuter: buildReviewCaptureRefuterOp,
  reviewCaptureValidation: buildReviewCaptureValidationOp,
  reviewValidate: buildReviewValidateOp,
  reviewRecover: buildReviewRecoverOp,
  registerProject: buildRegisterProjectOp,
};

describe("review trace path guard", () => {
  function traceContext() {
    const root = mkdtempSync(join(tmpdir(), "review-trace-guard-"));
    const projectRoot = join(root, "project");
    mkdirSync(projectRoot);
    const ctx = makeCtx();
    ctx.config.projects = [{ id: "repo", path: projectRoot }];
    return { root, projectRoot, ctx };
  }

  test("refuses a trace path inside the project before calling reviewStart", async () => {
    const { root, projectRoot, ctx } = traceContext();
    try {
      const handler = buildReviewStartOp(ctx);
      await expect(
        handler(request("reviewStart", { projectDir: projectRoot, trace: join(projectRoot, "trace.json") })),
      ).rejects.toThrow(
        "reviewStart trace must resolve unambiguously outside the project root",
      );
      expect(ctx.sddRuntime.calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("forwards an outside-project trace token verbatim", async () => {
    const { root, projectRoot, ctx } = traceContext();
    try {
      const trace = join(root, "outside-trace.json");
      await buildReviewStartOp(ctx)(request("reviewStart", {
        projectDir: projectRoot,
        trace,
        focus: "risk",
      }));
      expect(ctx.sddRuntime.calls).toEqual([{
        method: "reviewStart",
        payload: expect.objectContaining({ projectDir: projectRoot, trace, focus: "risk" }),
      }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses an unresolvable trace token before calling reviewStart", async () => {
    const { root, projectRoot, ctx } = traceContext();
    try {
      await expect(
        buildReviewStartOp(ctx)(request("reviewStart", { projectDir: projectRoot, trace: String.fromCharCode(0) })),
      ).rejects.toThrow(
        "reviewStart trace must resolve unambiguously outside the project root",
      );
      expect(ctx.sddRuntime.calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("host tool authorization", () => {
  test("reads are open to every agent", () => {
    const ctx = makeCtx();
    expect(authorizeHostDispatch(ctx, "sddStatus", "session-1", "general")).toBe("read");
    expect(authorizeHostDispatch(ctx, "reviewAssess", "session-1", undefined)).toBe("read");
  });

  test("mutations require a broker-bound trusted session record", () => {
    const ctx = makeCtx();
    expect(authorizeHostDispatch(ctx, "sddAttemptGrant", "session-1", ORCHESTRATOR)).toBe(
      "mutation",
    );
    // The envelope `agent` claim alone never authorizes: an unknown session
    // (no record) fails closed even when it claims the orchestrator.
    const unknown = makeCtx({ noRecord: true });
    expect(() => authorizeHostDispatch(unknown, "sddAttemptGrant", "session-1", ORCHESTRATOR)).toThrow(
      PolicyError,
    );
    expect(() => authorizeHostDispatch(unknown, "sddArchiveCompose", "session-1", ORCHESTRATOR)).toThrow(
      PolicyError,
    );
    expect(() => authorizeHostDispatch(unknown, "sddArchiveCompose", "session-1", undefined)).toThrow(
      PolicyError,
    );
  });

  test("the broker session record wins over the envelope agent claim", () => {
    const ctx = makeCtx({ recordAgent: "general" });
    expect(() =>
      authorizeHostDispatch(ctx, "sddArchiveCompose", "session-1", ORCHESTRATOR),
    ).toThrow(PolicyError);
  });

  test("unknown operations fail closed", () => {
    const ctx = makeCtx();
    expect(() => authorizeHostDispatch(ctx, "sddNotAThing", "session-1", ORCHESTRATOR)).toThrow(
      ValidationError,
    );
  });

  test("every read operation runs for a non-orchestrator agent", async () => {
    for (const [operation, payload] of READ_REQUESTS) {
      expect(HOST_READ_OPERATIONS).toContain(operation);
      const ctx = makeCtx();
      const handler = HANDLERS[operation]!(ctx);
      await expect(handler(request(operation, payload, "general"))).resolves.toBeDefined();
      expect((ctx.sddRuntime as unknown as { calls: RuntimeCall[] }).calls.length).toBe(1);
    }
  });

  test("every mutation is refused for a non-orchestrator agent", async () => {
    for (const [operation, payload] of MUTATION_REQUESTS) {
      expect(HOST_MUTATION_OPERATIONS).toContain(operation);
      const ctx = makeCtx({ recordAgent: "general" });
      const handler = HANDLERS[operation]!(ctx);
      await expect(handler(request(operation, payload, "general"))).rejects.toThrow(PolicyError);
      expect((ctx.sddRuntime as unknown as { calls: RuntimeCall[] }).calls.length).toBe(0);
    }
  });
});
describe("host project registration handler", () => {
  function makeRegisterCtx(
    spawn: SddOpContext["git"]["spawn"],
    options: { recordAgent?: string; noRecord?: boolean } = {},
  ): SddOpContext {
    const ctx = makeCtx(options);
    (ctx as unknown as { git: { spawn: SddOpContext["git"]["spawn"] } }).git.spawn = spawn;
    return ctx;
  }

  function recordingSpawn(result: { status: number; stdout: string; stderr: string }) {
    const calls: string[][] = [];
    const spawn: SddOpContext["git"]["spawn"] = async (argv) => {
      calls.push(argv);
      return { ...result, timedOut: false };
    };
    return { calls, spawn };
  }

  test("registerProject spawns the exact fixed argv for an eligible directory", async () => {
    const { calls, spawn } = recordingSpawn({ status: 0, stdout: "registered", stderr: "" });
    const ctx = makeRegisterCtx(spawn);
    const eligible = process.cwd();
    const result = (await buildRegisterProjectOp(ctx)(
      request(
        "registerProject",
        { path: eligible, dryRun: true, createRemote: true, makePublic: true },
        ORCHESTRATOR,
      ),
    )) as { ok?: boolean; status?: number };
    expect(result.ok).toBe(true);
    expect(result.status).toBe(0);
    expect(calls).toEqual([
      ["bun", "scripts/register-project.ts", "--dry-run", "--create-remote", "--public", eligible],
    ]);
  });

  describe("worktreeRoot (D36)", () => {
    const root = join(process.cwd(), ".wtroot-probe");
    const target = join(root, "proj");

    test("spawns the fixed argv with --worktree-root for a not-yet-existing <root>/<project>", async () => {
      const { calls, spawn } = recordingSpawn({ status: 0, stdout: "registered", stderr: "" });
      const result = (await buildRegisterProjectOp(makeRegisterCtx(spawn))(
        request("registerProject", { path: target, worktreeRoot: true, dryRun: true }, ORCHESTRATOR),
      )) as { ok?: boolean };
      expect(result.ok).toBe(true);
      expect(calls).toEqual([["bun", "scripts/register-project.ts", "--dry-run", "--worktree-root", target]]);
    });

    test.each([
      ["a project name the broker would not accept", join(root, "Bad Name"), /name must match/],
      ["a credential directory", join(homedir(), ".ssh", "proj"), /refusing to register a path under/],
      ["$HOME as the root", join(homedir(), "proj"), /refusing to register the filesystem root or \$HOME/],
      ["a path under /etc", "/etc/wt/proj", /refusing to register a path under/],
      ["a relative path", "wt/proj", /absolute/],
    ])("refuses %s without spawning", async (_label, path, reason) => {
      const { calls, spawn } = recordingSpawn({ status: 0, stdout: "", stderr: "" });
      await expect(
        buildRegisterProjectOp(makeRegisterCtx(spawn))(
          request("registerProject", { path, worktreeRoot: true }, ORCHESTRATOR),
        ),
      ).rejects.toThrow(reason);
      expect(calls).toEqual([]);
    });

    test("refuses a root whose parent does not exist, without spawning", async () => {
      const { calls, spawn } = recordingSpawn({ status: 0, stdout: "", stderr: "" });
      await expect(
        buildRegisterProjectOp(makeRegisterCtx(spawn))(
          request("registerProject", { path: join(process.cwd(), "no-such-parent", "wt", "proj"), worktreeRoot: true }, ORCHESTRATOR),
        ),
      ).rejects.toThrow(/parent of the worktree root does not exist/);
      expect(calls).toEqual([]);
    });

    test("refuses worktreeRoot combined with createRemote or makePublic, without spawning", async () => {
      for (const extra of [{ createRemote: true }, { makePublic: true, createRemote: true }]) {
        const { calls, spawn } = recordingSpawn({ status: 0, stdout: "", stderr: "" });
        await expect(
          buildRegisterProjectOp(makeRegisterCtx(spawn))(
            request("registerProject", { path: target, worktreeRoot: true, ...extra }, ORCHESTRATOR),
          ),
        ).rejects.toThrow(/cannot be combined|requires --create-remote|--public requires/);
        expect(calls).toEqual([]);
      }
    });

    test("worktreeRoot must be a boolean", async () => {
      const { calls, spawn } = recordingSpawn({ status: 0, stdout: "", stderr: "" });
      await expect(
        buildRegisterProjectOp(makeRegisterCtx(spawn))(
          request("registerProject", { path: target, worktreeRoot: "yes" }, ORCHESTRATOR),
        ),
      ).rejects.toThrow(ValidationError);
      expect(calls).toEqual([]);
    });

    test("without worktreeRoot the existing behaviour is unchanged: a missing directory is still refused", async () => {
      const { calls, spawn } = recordingSpawn({ status: 0, stdout: "", stderr: "" });
      await expect(
        buildRegisterProjectOp(makeRegisterCtx(spawn))(
          request("registerProject", { path: target }, ORCHESTRATOR),
        ),
      ).rejects.toThrow(ValidationError);
      expect(calls).toEqual([]);
    });
  });

  test("registerProject surfaces a non-zero spawn as a worker error", async () => {
    const { spawn } = recordingSpawn({ status: 2, stdout: "", stderr: "boom" });
    const ctx = makeRegisterCtx(spawn);
    await expect(
      buildRegisterProjectOp(ctx)(
        request("registerProject", { path: process.cwd() }, ORCHESTRATOR),
      ),
    ).rejects.toThrow(MsbError);
  });

  test("registerProject refuses a banned path without spawning", async () => {
    const { calls, spawn } = recordingSpawn({ status: 0, stdout: "", stderr: "" });
    const ctx = makeRegisterCtx(spawn);
    await expect(
      buildRegisterProjectOp(ctx)(request("registerProject", { path: "/etc" }, ORCHESTRATOR)),
    ).rejects.toThrow(ValidationError);
    expect(calls).toHaveLength(0);
  });

  test("registerProject refuses --public without --create-remote without spawning", async () => {
    const { calls, spawn } = recordingSpawn({ status: 0, stdout: "", stderr: "" });
    const ctx = makeRegisterCtx(spawn);
    await expect(
      buildRegisterProjectOp(ctx)(
        request("registerProject", { path: process.cwd(), makePublic: true }, ORCHESTRATOR),
      ),
    ).rejects.toThrow(ValidationError);
    expect(calls).toHaveLength(0);
  });

  test("registerProject rejects undeclared payload fields", async () => {
    const { calls, spawn } = recordingSpawn({ status: 0, stdout: "", stderr: "" });
    const ctx = makeRegisterCtx(spawn);
    await expect(
      buildRegisterProjectOp(ctx)(
        request("registerProject", { path: process.cwd(), cwd: "/tmp" }, ORCHESTRATOR),
      ),
    ).rejects.toThrow(ValidationError);
    expect(calls).toHaveLength(0);
  });

  test("registerProject is orchestrator-only and never spawns for another agent", async () => {
    const { calls, spawn } = recordingSpawn({ status: 0, stdout: "", stderr: "" });
    const ctx = makeRegisterCtx(spawn, { recordAgent: "general" });
    await expect(
      buildRegisterProjectOp(ctx)(request("registerProject", { path: process.cwd() }, "general")),
    ).rejects.toThrow(PolicyError);
    expect(calls).toHaveLength(0);
  });
});

describe("SDD host tool payloads", () => {
  test("status forwards change/contract options", async () => {
    const ctx = makeCtx();
    await buildSddStatusOp(ctx)(
      request("sddStatus", { projectDir: "/repo", change: "agent-host-tools", contract: "gentle-ai.sdd-status/v2" }, ORCHESTRATOR),
    );
    const call = (ctx.sddRuntime as unknown as { calls: RuntimeCall[] }).calls[0]!;
    expect(call.payload).toMatchObject({
      projectDir: "/repo",
      options: { change: "agent-host-tools", contract: "gentle-ai.sdd-status/v2" },
    });
  });

  test("read payloads reject undeclared fields", async () => {
    const ctx = makeCtx();
    await expect(
      buildReviewAssessOp(ctx)(request("reviewAssess", { projectDir: "/repo", token: "x" }, "general")),
    ).rejects.toThrow(ValidationError);
  });
});

describe("host git/GH handlers", () => {
  const projectRoot = process.cwd();

  function makeGitCtx(spawn: SddOpContext["git"]["spawn"], root: string = projectRoot): SddOpContext {
    const config = defaultConfig({
      readOnlyAgents: [ORCHESTRATOR],
      projects: [{ id: "test", path: root }],
    });
    const record: SessionRecord = {
      sessionID: "session-1",
      state: "APPLIED",
      agent: ORCHESTRATOR,
      projectID: "test",
      baselineRef: "refs/opencode-sandbox/baseline/session-1",
      resultRef: "refs/opencode-sandbox/result/session-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    return {
      config,
      store: {
        get: () => record,
        touch: (_sessionID, patch = {}) => {
          Object.assign(record, patch);
          return record;
        },
        transition: (_sessionID, from, to, patch = {}) => {
          if (record.state !== from) throw new Error(`expected ${from}, got ${record.state}`);
          Object.assign(record, patch, { state: to });
          return record;
        },
      },
      sddRuntime: makeRuntime(),
      pool: { allocations: [] },
      hostRead: { has: () => false },
      logger: {},
      resources: {},
      budget: {},
      adapter: {},
      git: { runnerMode: "planned", spawn },
    } as unknown as SddOpContext;
  }

  function spawnStub(
    rules: Array<[RegExp, { status: number; stdout: string; stderr: string }]>,
  ) {
    const calls: string[][] = [];
    const spawn: SddOpContext["git"]["spawn"] = async (argv) => {
      calls.push(argv);
      for (const [pattern, result] of rules) {
        if (pattern.test(argv.join(" "))) return { ...result, timedOut: false };
      }
      if (argv.join(" ") === "git rev-parse HEAD") {
        return { status: 0, stdout: "abcdef0123456789abcdef0123456789abcdef01\n", stderr: "", timedOut: false };
      }
      if (argv[1] === "rev-parse" && argv[2] === "--verify") {
        return { status: 0, stdout: "0123456789abcdef0123456789abcdef01234567\n", stderr: "", timedOut: false };
      }
      return { status: 0, stdout: "", stderr: "", timedOut: false };
    };
    return { calls, spawn };
  }

  const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

  function headProject(prefix = "git-head-"): { root: string; projectDir: string } {
    const root = mkdtempSync(join(tmpdir(), prefix));
    const projectDir = join(root, "project");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(projectDir, ".git"), { recursive: true });
    return { root, projectDir };
  }

  function headSpawn(options: {
    branch?: string;
    branchStatus?: number;
    branchStdout?: string;
    head?: string;
    headStatus?: number;
    branchTruncated?: boolean;
    headTruncated?: boolean;
    branchTimedOut?: boolean;
    branchStderrTruncated?: boolean;
    headTimedOut?: boolean;
    headStderrTruncated?: boolean;
  } = {}) {
    const calls: Array<{ argv: string[]; env?: Record<string, string> }> = [];
    const spawn: SddOpContext["git"]["spawn"] = async (argv, opts) => {
      calls.push({ argv, env: opts?.env });
      if (argv[1] === "symbolic-ref") {
        if (options.branchStatus !== undefined && options.branchStatus !== 0) {
          return { status: options.branchStatus, stdout: options.branchStdout ?? "", stderr: "", timedOut: options.branchTimedOut === true };
        }
        return { status: 0, stdout: options.branchStdout ?? `${options.branch ?? "main"}\n`, stderr: "", timedOut: false, outputTruncated: options.branchTruncated === true, stderrTruncated: options.branchStderrTruncated === true };
      }
      if (argv[1] === "rev-parse") {
        return { status: options.headStatus ?? 0, stdout: `${options.head ?? HEAD_SHA}\n`, stderr: "", timedOut: options.headTimedOut === true, outputTruncated: options.headTruncated === true, stderrTruncated: options.headStderrTruncated === true };
      }
      return { status: 0, stdout: "", stderr: "", timedOut: false };
    };
    return { calls, spawn };
  }

  test("gitHead returns branch and HEAD SHA using the fixed argv and validated GIT_DIR", async () => {
    const { root, projectDir } = headProject();
    try {
      const { calls, spawn } = headSpawn();
      const result = await buildGitHeadOp(makeGitCtx(spawn, projectDir))(request("gitHead", { projectDir }, ORCHESTRATOR));
      expect(result).toEqual({ branch: "main", detached: false, head: HEAD_SHA });
      expect(calls.map(({ argv }) => argv)).toEqual([
        ["git", "symbolic-ref", "--short", "-q", "HEAD"],
        ["git", "rev-parse", "--verify", "HEAD"],
      ]);
      for (const call of calls) expect(call.env?.GIT_DIR).toBe(join(projectDir, ".git"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("gitHead accepts branch names outside the creation allowlist", async () => {
    const { root, projectDir } = headProject();
    try {
      for (const name of ["release+hotfix", "hotfix/修复-üñîçødé"]) {
        const { spawn } = headSpawn({ branch: name });
        const result = await buildGitHeadOp(makeGitCtx(spawn, projectDir))(request("gitHead", { projectDir }, ORCHESTRATOR));
        expect(result).toEqual({ branch: name, detached: false, head: HEAD_SHA });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("gitHead resolves a linked worktree git directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "git-head-worktree-"));
    const mainGitDir = join(root, "main", ".git");
    const worktreeGitDir = join(mainGitDir, "worktrees", "wt");
    const wtPath = join(root, "wt");
    mkdirSync(worktreeGitDir, { recursive: true });
    mkdirSync(wtPath, { recursive: true });
    writeFileSync(join(worktreeGitDir, "gitdir"), join(wtPath, ".git"));
    writeFileSync(join(wtPath, ".git"), `gitdir: ${worktreeGitDir}`);
    try {
      const { calls, spawn } = headSpawn();
      const result = await buildGitHeadOp(makeGitCtx(spawn, wtPath))(request("gitHead", { projectDir: wtPath }, ORCHESTRATOR));
      expect(result).toEqual({ branch: "main", detached: false, head: HEAD_SHA });
      for (const call of calls) expect(call.env?.GIT_DIR).toBe(gitDirFor(wtPath));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("gitHead returns a null branch for detached HEAD", async () => {
    const { root, projectDir } = headProject();
    try {
      const { spawn } = headSpawn({ branchStatus: 1 });
      const result = await buildGitHeadOp(makeGitCtx(spawn, projectDir))(request("gitHead", { projectDir }, ORCHESTRATOR));
      expect(result).toEqual({ branch: null, detached: true, head: HEAD_SHA });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("gitHead rejects a forged .git pointer before spawning", async () => {
    const { root, projectDir } = headProject();
    try {
      rmSync(join(projectDir, ".git"), { recursive: true, force: true });
      writeFileSync(join(projectDir, ".git"), `gitdir: ${join(root, "elsewhere", ".git")}`);
      mkdirSync(join(root, "elsewhere", ".git"), { recursive: true });
      const { calls, spawn } = headSpawn();
      await expect(buildGitHeadOp(makeGitCtx(spawn, projectDir))(request("gitHead", { projectDir }, ORCHESTRATOR)))
        .rejects.toThrow(/does not point at its own linked git directory/);
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("gitHead rejects unsafe repository-local filter config before spawning", async () => {
    const { root, projectDir } = headProject();
    try {
      writeFileSync(join(projectDir, ".git", "config"), '[filter "evil"]\n\tclean = cat\n');
      const { calls, spawn } = headSpawn();
      await expect(buildGitHeadOp(makeGitCtx(spawn, projectDir))(request("gitHead", { projectDir }, ORCHESTRATOR)))
        .rejects.toThrow(GitGuardError);
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("gitHead rejects malformed branch output", async () => {
    const { root, projectDir } = headProject();
    try {
      for (const options of [
        { branchStdout: "main\nrelease\n" },
        { branchStdout: `main${String.fromCharCode(7)}x\n` },
        { branchStdout: `main${String.fromCharCode(0)}x\n` },
        { branchStdout: `${"a".repeat(GIT_HEAD_BRANCH_MAX_BYTES + 1)}\n` },
      ]) {
        const { spawn } = headSpawn(options);
        await expect(buildGitHeadOp(makeGitCtx(spawn, projectDir))(request("gitHead", { projectDir }, ORCHESTRATOR))).rejects.toThrow(StateError);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("gitHead rejects truncated branch or HEAD output", async () => {
    const { root, projectDir } = headProject();
    try {
      const branch = headSpawn({ branchTruncated: true });
      await expect(buildGitHeadOp(makeGitCtx(branch.spawn, projectDir))(request("gitHead", { projectDir }, ORCHESTRATOR))).rejects.toThrow(StateError);
      const head = headSpawn({ headTruncated: true });
      await expect(buildGitHeadOp(makeGitCtx(head.spawn, projectDir))(request("gitHead", { projectDir }, ORCHESTRATOR))).rejects.toThrow(StateError);
      const headTimeout = headSpawn({ headTimedOut: true });
      await expect(buildGitHeadOp(makeGitCtx(headTimeout.spawn, projectDir))(request("gitHead", { projectDir }, ORCHESTRATOR))).rejects.toThrow(StateError);
      const headStderr = headSpawn({ headStderrTruncated: true });
      await expect(buildGitHeadOp(makeGitCtx(headStderr.spawn, projectDir))(request("gitHead", { projectDir }, ORCHESTRATOR))).rejects.toThrow(StateError);
      const branchStderr = headSpawn({ branchStderrTruncated: true });
      await expect(buildGitHeadOp(makeGitCtx(branchStderr.spawn, projectDir))(request("gitHead", { projectDir }, ORCHESTRATOR))).rejects.toThrow(StateError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("gitHead rejects malformed output, failed commands, and timeouts", async () => {
    const { root, projectDir } = headProject();
    try {
      for (const options of [
        { head: "not-a-sha" },
        { branchStatus: 128 },
        { headStatus: 128 },
        { branchStatus: 1, branchTimedOut: true },
      ]) {
        const { spawn } = headSpawn(options);
        await expect(buildGitHeadOp(makeGitCtx(spawn, projectDir))(request("gitHead", { projectDir }, ORCHESTRATOR))).rejects.toThrow(StateError);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("gitHead rejects unknown payload keys before spawning", async () => {
    const { root, projectDir } = headProject();
    try {
      const { calls, spawn } = headSpawn();
      await expect(buildGitHeadOp(makeGitCtx(spawn, projectDir))(request("gitHead", { projectDir, force: true }, ORCHESTRATOR)))
        .rejects.toThrow(ValidationError);
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("gitHead is available to read-open agents without orchestrator identity", async () => {
    const { root, projectDir } = headProject();
    try {
      const ctx = makeCtx({ recordAgent: "general" });
      ctx.config.projects = [{ id: "test", path: realpathSync(projectDir) }];
      const { spawn } = headSpawn();
      (ctx.git as SddOpContext["git"]).spawn = spawn;
      const result = await buildGitHeadOp(ctx)(request("gitHead", { projectDir }, "general"));
      expect(result).toEqual({ branch: "main", detached: false, head: HEAD_SHA });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("gitCommit stages/commits exactly the derived B→C paths", async () => {
    const { calls, spawn } = spawnStub([[
      /diff --name-only/,
      { status: 0, stdout: "a.ts\u0000", stderr: "" },
    ]]);
    const ctx = makeGitCtx(spawn);
    const result = (await buildGitCommitOp(ctx)(
      request("gitCommit", { projectDir: projectRoot, message: "fix: scoped" }, ORCHESTRATOR),
    )) as { committed?: boolean; paths?: string[] };
    expect(result.committed).toBe(true);
    expect(result.paths).toEqual(["a.ts"]);
    expect(calls).toContainEqual(["git", "add", "--", "a.ts"]);
    expect(calls).toContainEqual([
      "git",
      "-c",
      "user.name=opencode-sandbox",
      "-c",
      "user.email=sandbox@local",
      "commit",
      "-m",
      "fix: scoped",
      "--",
      "a.ts",
    ]);
    expect(calls.flatMap((c) => c).join(" ")).not.toContain("-A");
  });

  test("gitCommit rejects a protected path (S17) without spawning a commit", async () => {
    const { calls, spawn } = spawnStub([[
      /diff --name-only/,
      { status: 0, stdout: "broker/src/server.ts\u0000", stderr: "" },
    ]]);
    const ctx = makeGitCtx(spawn);
    await expect(
      buildGitCommitOp(ctx)(request("gitCommit", { projectDir: projectRoot, message: "m" }, ORCHESTRATOR)),
    ).rejects.toThrow(StateError);
    expect(calls.some((c) => gitSubcommand(c) === "commit")).toBe(false);
  });

  test("gitCommit rejects an empty B→C result", async () => {
    const { spawn } = spawnStub([[/diff --name-only/, { status: 0, stdout: "", stderr: "" }]]);
    const ctx = makeGitCtx(spawn);
    await expect(
      buildGitCommitOp(ctx)(request("gitCommit", { projectDir: projectRoot, message: "m" }, ORCHESTRATOR)),
    ).rejects.toThrow(StateError);
  });

  test("gitPush refuses detached HEAD before spawning the push", async () => {
    const { calls, spawn } = spawnStub([[/symbolic-ref/, { status: 1, stdout: "", stderr: "" }]]);
    const ctx = makeGitCtx(spawn);
    await expect(
      buildGitPushOp(ctx)(request("gitPush", { projectDir: projectRoot, remote: "origin" }, ORCHESTRATOR)),
    ).rejects.toThrow(ValidationError);
    expect(calls.some((c) => c[1] === "push")).toBe(false);
  });

  test("gitPush emits exact push argv for a tracking branch", async () => {
    const { calls, spawn } = spawnStub([
      [/symbolic-ref/, { status: 0, stdout: "feature/x\n", stderr: "" }],
      [/rev-parse --abbrev-ref/, { status: 0, stdout: "origin/feature/x\n", stderr: "" }],
      [/rev-list --count/, { status: 0, stdout: "3\n", stderr: "" }],
    ]);
    const ctx = makeGitCtx(spawn);
    const result = (await buildGitPushOp(ctx)(
      request("gitPush", { projectDir: projectRoot, remote: "origin" }, ORCHESTRATOR),
    )) as { pushed?: boolean; ahead?: number; branch?: string };
    expect(result.ahead).toBe(3);
    expect(result.branch).toBe("feature/x");
    expect(calls).toContainEqual(["git", "push", "origin", "feature/x"]);
  });

  test("gitPush refuses main without allowProtectedBranch", async () => {
    const { calls, spawn } = spawnStub([
      [/symbolic-ref/, { status: 0, stdout: "main\n", stderr: "" }],
      [/rev-parse --abbrev-ref/, { status: 0, stdout: "origin/main\n", stderr: "" }],
      [/rev-list --count/, { status: 0, stdout: "1\n", stderr: "" }],
    ]);
    const ctx = makeGitCtx(spawn);
    await expect(
      buildGitPushOp(ctx)(request("gitPush", { projectDir: projectRoot, remote: "origin" }, ORCHESTRATOR)),
    ).rejects.toThrow(ValidationError);
    expect(calls.some((c) => c[1] === "push")).toBe(false);
  });

  test("ghIssueCreate spawns exactly the fixed argv and rejects extra keys", async () => {
    const { calls, spawn } = spawnStub([]);
    const ctx = makeGitCtx(spawn);
    await buildGhIssueCreateOp(ctx)(
      request(
        "ghIssueCreate",
        { projectDir: projectRoot, repo: "owner/repo", title: "Bug", body: "body" },
        ORCHESTRATOR,
      ),
    );
    expect(calls).toContainEqual([
      "gh",
      "issue",
      "create",
      "--repo",
      "owner/repo",
      "--title",
      "Bug",
      "--body",
      "body",
    ]);
    await expect(
      buildGhIssueCreateOp(ctx)(
        request(
          "ghIssueCreate",
          { projectDir: projectRoot, repo: "owner/repo", title: "Bug", body: "body", force: true },
          ORCHESTRATOR,
        ),
      ),
    ).rejects.toThrow(ValidationError);
  });

  test("gitPush payload rejects force/delete keys", async () => {
    const { spawn } = spawnStub([]);
    const ctx = makeGitCtx(spawn);
    await expect(
      buildGitPushOp(ctx)(
        request("gitPush", { projectDir: projectRoot, remote: "origin", force: true }, ORCHESTRATOR),
      ),
    ).rejects.toThrow(ValidationError);
  });

  const BRANCH_SHA = "0123456789abcdef0123456789abcdef01234567";

  function branchSpawn(
    options: {
      exists?: boolean;
      postSha?: string;
      switchBranch?: boolean;
      resolveStatus?: number;
      showRefStatus?: number;
      headBranch?: string;
      changedPaths?: string[];
      diffTruncated?: boolean;
    } = {},
  ) {
    const calls: string[][] = [];
    const spawn: SddOpContext["git"]["spawn"] = async (argv) => {
      calls.push(argv);
      const line = argv.join(" ");
      if (line.startsWith("git rev-parse --verify --quiet ")) {
        if (options.resolveStatus !== undefined && options.resolveStatus !== 0) {
          return { status: options.resolveStatus, stdout: "", stderr: "unknown revision", timedOut: false };
        }
        return { status: 0, stdout: `${BRANCH_SHA}\n`, stderr: "", timedOut: false };
      }
      if (line.startsWith("git show-ref --verify --quiet refs/heads/")) {
        if (options.showRefStatus !== undefined) {
          return { status: options.showRefStatus, stdout: "", stderr: "show-ref failed", timedOut: false };
        }
        return { status: options.exists === true ? 0 : 1, stdout: "", stderr: "", timedOut: false };
      }
      if (line.startsWith("git rev-parse --verify refs/heads/")) {
        return { status: 0, stdout: `${options.postSha ?? BRANCH_SHA}\n`, stderr: "", timedOut: false };
      }
      if (line.startsWith("git diff --name-only --no-renames -z ")) {
        return { status: 0, stdout: (options.changedPaths ?? []).map((path) => `${path}\u0000`).join(""), stderr: "", timedOut: false, outputTruncated: options.diffTruncated === true };
      }
      if (line.startsWith("git symbolic-ref --short -q HEAD")) {
        const branch = options.headBranch ?? (options.switchBranch === true ? "feature/x" : "main");
        return { status: 0, stdout: `${branch}\n`, stderr: "", timedOut: false };
      }
      return { status: 0, stdout: "", stderr: "", timedOut: false };
    };
    return { calls, spawn };
  }

  test("gitBranch creates at HEAD by default with the exact fixed argv", async () => {
    const { calls, spawn } = branchSpawn();
    const ctx = makeGitCtx(spawn);
    const result = (await buildGitBranchOp(ctx)(
      request("gitBranch", { projectDir: projectRoot, name: "feature/x" }, ORCHESTRATOR),
    )) as { created?: boolean; base?: string; switched?: boolean; name?: string };
    expect(result).toMatchObject({
      created: true,
      name: "feature/x",
      base: BRANCH_SHA,
      switched: false,
    });
    expect(calls).toContainEqual(["git", "rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    expect(calls).toContainEqual(["git", "branch", "feature/x", BRANCH_SHA]);
    const flat = calls.flat();
    expect(flat).not.toContain("--force");
    expect(flat).not.toContain("-f");
  });

  test("gitBranch resolves an explicit base before creating", async () => {
    const { calls, spawn } = branchSpawn();
    const ctx = makeGitCtx(spawn);
    const result = (await buildGitBranchOp(ctx)(
      request(
        "gitBranch",
        { projectDir: projectRoot, name: "feature/x", base: "feature/base" },
        ORCHESTRATOR,
      ),
    )) as { base?: string };
    expect(result.base).toBe(BRANCH_SHA);
    expect(calls).toContainEqual([
      "git",
      "rev-parse",
      "--verify",
      "--quiet",
      "feature/base^{commit}",
    ]);
    expect(calls).toContainEqual(["git", "branch", "feature/x", BRANCH_SHA]);
  });

  test("gitBranch switch:true creates and checks out with git switch -c", async () => {
    const { calls, spawn } = branchSpawn({ switchBranch: true });
    const ctx = makeGitCtx(spawn);
    const result = (await buildGitBranchOp(ctx)(
      request("gitBranch", { projectDir: projectRoot, name: "feature/x", switch: true }, ORCHESTRATOR),
    )) as { switched?: boolean; currentBranch?: string };
    expect(result.switched).toBe(true);
    expect(result.currentBranch).toBe("feature/x");
    expect(calls).toContainEqual(["git", "switch", "-c", "feature/x", BRANCH_SHA]);
    expect(calls.some((c) => c[1] === "branch")).toBe(false);
  });

  test("gitBranch refuses an existing branch before mutation (positive control: absent branch creates)", async () => {
    const existing = branchSpawn({ exists: true });
    await expect(
      buildGitBranchOp(makeGitCtx(existing.spawn))(
        request("gitBranch", { projectDir: projectRoot, name: "feature/x" }, ORCHESTRATOR),
      ),
    ).rejects.toThrow(StateError);
    expect(existing.calls.some((c) => c[1] === "branch" || c[1] === "switch")).toBe(false);

    const fresh = branchSpawn();
    const created = (await buildGitBranchOp(makeGitCtx(fresh.spawn))(
      request("gitBranch", { projectDir: projectRoot, name: "feature/x" }, ORCHESTRATOR),
    )) as { created?: boolean };
    expect(created.created).toBe(true);
    expect(fresh.calls).toContainEqual(["git", "branch", "feature/x", BRANCH_SHA]);
  });

  test("gitBranch refuses invalid names and flag-shaped bases before any git call", async () => {
    const invalidName = branchSpawn();
    await expect(
      buildGitBranchOp(makeGitCtx(invalidName.spawn))(
        request("gitBranch", { projectDir: projectRoot, name: "--force" }, ORCHESTRATOR),
      ),
    ).rejects.toThrow(ValidationError);
    expect(invalidName.calls).toHaveLength(0);

    const flagBase = branchSpawn();
    await expect(
      buildGitBranchOp(makeGitCtx(flagBase.spawn))(
        request("gitBranch", { projectDir: projectRoot, name: "feature/x", base: "-x" }, ORCHESTRATOR),
      ),
    ).rejects.toThrow(ValidationError);
    expect(flagBase.calls).toHaveLength(0);

    // positive control: a fresh valid name and base still reach the git steps.
    const valid = branchSpawn();
    await buildGitBranchOp(makeGitCtx(valid.spawn))(
      request("gitBranch", { projectDir: projectRoot, name: "feature/valid", base: "HEAD" }, ORCHESTRATOR),
    );
    expect(valid.calls.length).toBeGreaterThan(0);
  });

  test("gitBranch refuses an unresolvable base and an unknown payload key", async () => {
    const unresolvable = branchSpawn({ resolveStatus: 128 });
    await expect(
      buildGitBranchOp(makeGitCtx(unresolvable.spawn))(
        request("gitBranch", { projectDir: projectRoot, name: "feature/x", base: "nope" }, ORCHESTRATOR),
      ),
    ).rejects.toThrow(StateError);
    expect(unresolvable.calls.some((c) => c[1] === "branch" || c[1] === "switch")).toBe(false);

    const unknownKey = branchSpawn();
    await expect(
      buildGitBranchOp(makeGitCtx(unknownKey.spawn))(
        request("gitBranch", { projectDir: projectRoot, name: "feature/x", force: true }, ORCHESTRATOR),
      ),
    ).rejects.toThrow(ValidationError);
    expect(unknownKey.calls).toHaveLength(0);
  });

  test("gitBranch fails closed when the created ref does not match the resolved base", async () => {
    const { spawn } = branchSpawn({ postSha: "fedcba9876543210fedcba9876543210fedcba98" });
    await expect(
      buildGitBranchOp(makeGitCtx(spawn))(
        request("gitBranch", { projectDir: projectRoot, name: "feature/x" }, ORCHESTRATOR),
      ),
    ).rejects.toThrow(StateError);
  });

  test("gitBranch authorizes before payload validation (no git call for a non-orchestrator)", async () => {
    const { calls, spawn } = branchSpawn();
    const ctx = makeCtx({ recordAgent: "general" });
    (ctx as unknown as { git: { spawn: SddOpContext["git"]["spawn"] } }).git.spawn = spawn;
    await expect(
      buildGitBranchOp(ctx)(
        request("gitBranch", { projectDir: "/repo", name: "--force", force: true }, "general"),
      ),
    ).rejects.toThrow(PolicyError);
    expect(calls).toHaveLength(0);
  });

  test("gitBranch refuses a forged `.git` pointer aimed at another repository (no git call)", async () => {
    const root = mkdtempSync(join(tmpdir(), "git-branch-forged-"));
    try {
      const elsewhere = join(root, "elsewhere");
      mkdirSync(join(elsewhere, ".git"), { recursive: true });
      const projectDir = join(root, "project");
      mkdirSync(projectDir);
      writeFileSync(join(projectDir, ".git"), `gitdir: ${join(elsewhere, ".git")}\n`);
      const { calls, spawn } = branchSpawn();
      await expect(
        buildGitBranchOp(makeGitCtx(spawn, projectDir))(
          request("gitBranch", { projectDir, name: "feature/x" }, ORCHESTRATOR),
        ),
      ).rejects.toThrow(/does not point at its own linked git directory/);
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("positive control: an ordinary `.git` directory still reaches the git steps", async () => {
    const root = mkdtempSync(join(tmpdir(), "git-branch-real-git-"));
    try {
      const projectDir = join(root, "project");
      mkdirSync(join(projectDir, ".git"), { recursive: true });
      const { calls, spawn } = branchSpawn();
      await buildGitBranchOp(makeGitCtx(spawn, projectDir))(
        request("gitBranch", { projectDir, name: "feature/x" }, ORCHESTRATOR),
      );
      expect(calls.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("gitBranch switch:true refuses a base that changes a protected path", async () => {
    const { calls, spawn } = branchSpawn({ switchBranch: true, changedPaths: ["broker/src/service.ts"] });
    await expect(
      buildGitBranchOp(makeGitCtx(spawn))(
        request("gitBranch", { projectDir: projectRoot, name: "feature/x", switch: true }, ORCHESTRATOR),
      ),
    ).rejects.toThrow(/protected paths \(S7\/S17\)/);
    expect(calls.some((c) => c[1] === "switch" || c[1] === "branch")).toBe(false);
  });

  test("gitBranch switch:true refuses a truncated NUL-aligned base diff (protected path beyond the cap)", async () => {
    const { calls, spawn } = branchSpawn({
      switchBranch: true,
      changedPaths: ["docs/readme.md"],
      diffTruncated: true,
    });
    await expect(
      buildGitBranchOp(makeGitCtx(spawn))(
        request("gitBranch", { projectDir: projectRoot, name: "feature/x", switch: true }, ORCHESTRATOR),
      ),
    ).rejects.toThrow(/truncated/i);
    expect(calls.some((c) => c[1] === "switch" || c[1] === "branch")).toBe(false);
  });

  test("positive control: a base that changes only unprotected paths switches", async () => {
    const { calls, spawn } = branchSpawn({ switchBranch: true, changedPaths: ["docs/readme.md"] });
    const result = (await buildGitBranchOp(makeGitCtx(spawn))(
      request("gitBranch", { projectDir: projectRoot, name: "feature/x", switch: true }, ORCHESTRATOR),
    )) as { switched?: boolean };
    expect(result.switched).toBe(true);
    expect(calls).toContainEqual(["git", "switch", "-c", "feature/x", BRANCH_SHA]);
  });

  test("gitBranch without switch never consults the base diff", async () => {
    const { calls, spawn } = branchSpawn({ changedPaths: ["broker/src/service.ts"] });
    const result = (await buildGitBranchOp(makeGitCtx(spawn))(
      request("gitBranch", { projectDir: projectRoot, name: "feature/x" }, ORCHESTRATOR),
    )) as { created?: boolean };
    expect(result.created).toBe(true);
    expect(calls.some((c) => c[1] === "diff")).toBe(false);
  });

  test("gitBranch refuses a non-boolean switch before any git call", async () => {
    const { calls, spawn } = branchSpawn();
    await expect(
      buildGitBranchOp(makeGitCtx(spawn))(
        request("gitBranch", { projectDir: projectRoot, name: "feature/x", switch: "yes" }, ORCHESTRATOR),
      ),
    ).rejects.toThrow(ValidationError);
    expect(calls).toHaveLength(0);
  });

  test("gitBranch refuses whitespace, control-character and refspec names before any git call", async () => {
    const names = [
      "feature x",
      `feature${String.fromCharCode(9)}x`,
      "feature:main",
      "+main",
      "feature~1",
      "feature^",
      "feature?",
      "feature*",
      "feature[",
      `a${String.fromCharCode(1)}b`,
    ];
    for (const name of names) {
      const { calls, spawn } = branchSpawn();
      await expect(
        buildGitBranchOp(makeGitCtx(spawn))(
          request("gitBranch", { projectDir: projectRoot, name }, ORCHESTRATOR),
        ),
      ).rejects.toThrow(ValidationError);
      expect(calls).toHaveLength(0);
    }
  });

  test("gitBranch fails closed on an unexpected show-ref status", async () => {
    const { calls, spawn } = branchSpawn({ showRefStatus: 2 });
    await expect(
      buildGitBranchOp(makeGitCtx(spawn))(
        request("gitBranch", { projectDir: projectRoot, name: "feature/x" }, ORCHESTRATOR),
      ),
    ).rejects.toThrow(StateError);
    expect(calls.some((c) => c[1] === "branch" || c[1] === "switch")).toBe(false);
  });

  test("gitBranch fails closed when switch leaves HEAD on another branch", async () => {
    const { spawn } = branchSpawn({ switchBranch: true, headBranch: "main" });
    await expect(
      buildGitBranchOp(makeGitCtx(spawn))(
        request("gitBranch", { projectDir: projectRoot, name: "feature/x", switch: true }, ORCHESTRATOR),
      ),
    ).rejects.toThrow(StateError);
  });
});

describe("host tool ledger grant routing", () => {
  const revision = "a".repeat(64);

  test("grant forwards repeated roots in order and an omitted initial revision", async () => {
    const ctx = makeCtx();
    await buildSddAttemptGrantOp(ctx)(
      request(
        "sddAttemptGrant",
        {
          projectDir: "/repo",
          change: "agent-host-tools",
          roots: ["/home/james/a", "/home/james/b"],
          changeInstance: "instance-token",
          requestId: "grant-request",
          actor: "gentle-orchestrator",
          reason: "widen",
        },
        ORCHESTRATOR,
      ),
    );
    const call = (ctx.sddRuntime as unknown as { calls: RuntimeCall[] }).calls[0]!;
    const payload = call.payload as { roots: string[]; expectedRevision?: string };
    expect(payload.roots).toEqual(["/home/james/a", "/home/james/b"]);
    expect(payload.expectedRevision).toBeUndefined();
  });
});

describe("host tool untracked and review status forwarding", () => {
  test("review status forwards the runtime agent", async () => {
    const ctx = makeCtx();
    await buildReviewStatusOp(ctx)(
      request("reviewStatus", { projectDir: "/repo", agent: "opencode-sandbox" }, "general"),
    );
    const call = (ctx.sddRuntime as unknown as { calls: RuntimeCall[] }).calls[0]!;
    expect(call.payload).toMatchObject({ agent: "opencode-sandbox" });
  });

  test("review status forwards the bound passthrough flags", async () => {
    const ctx = makeCtx();
    await buildReviewStatusOp(ctx)(
      request(
        "reviewStatus",
        {
          projectDir: "/repo",
          lineage: "Lineage-TOKEN",
          repositoryContext: "Repo-Context",
          projection: "staged",
        },
        "general",
      ),
    );
    const call = (ctx.sddRuntime as unknown as { calls: RuntimeCall[] }).calls[0]!;
    expect(call.payload).toMatchObject({
      lineage: "Lineage-TOKEN",
      repositoryContext: "Repo-Context",
      projection: "staged",
    });
  });

  test("review status forwards the intended untracked selection", async () => {
    const ctx = makeCtx();
    const selection =
      '{"schema":"gentle-ai.review-intended-untracked-selection/v1","paths":["openspec/changes/x/new.md"]}';
    await buildReviewStatusOp(ctx)(
      request(
        "reviewStatus",
        { projectDir: "/repo", intendedUntrackedSelection: selection },
        "general",
      ),
    );
    const call = (ctx.sddRuntime as unknown as { calls: RuntimeCall[] }).calls[0]!;
    expect(call.method).toBe("reviewStatus");
    expect(call.payload).toMatchObject({ intendedUntrackedSelection: selection });
  });

  test("reviewLensContext is a read open to every agent and forwards its fields", async () => {
    const ctx = makeCtx();
    const revision = `sha256:${"a".repeat(64)}`;
    await buildReviewLensContextOp(ctx)(
      request("reviewLensContext", {
        projectDir: "/repo",
        repositoryContext: "Repo-Context",
        lineage: "Lineage-TOKEN",
        target: "Target-TOKEN",
        expectedRevision: revision,
        lens: "review-readability",
      }, "general"),
    );
    const call = (ctx.sddRuntime as unknown as { calls: RuntimeCall[] }).calls[0]!;
    expect(call.method).toBe("reviewLensContext");
    expect(call.payload).toEqual({
      projectDir: "/repo",
      repositoryContext: "Repo-Context",
      lineage: "Lineage-TOKEN",
      target: "Target-TOKEN",
      expectedRevision: revision,
      lens: "review-readability",
    });
  });

  test("reviewLensContext rejects undeclared keys and missing bound fields", async () => {
    const ctx = makeCtx();
    await expect(
      buildReviewLensContextOp(ctx)(
        request("reviewLensContext", { projectDir: "/repo", lens: "review-risk", extra: 1 }, ORCHESTRATOR),
      ),
    ).rejects.toThrow(ValidationError);
    await expect(
      buildReviewLensContextOp(ctx)(
        request("reviewLensContext", { projectDir: "/repo", lens: "review-risk" }, ORCHESTRATOR),
      ),
    ).rejects.toThrow(ValidationError);
  });

  test("review capture-result forwards the inline inputJson body", async () => {
    const ctx = makeCtx();
    await buildReviewCaptureResultOp(ctx)(
      request("reviewCaptureResult", { projectDir: "/repo", inputJson: '{"a":1}' }, ORCHESTRATOR),
    );
    const call = (ctx.sddRuntime as unknown as { calls: RuntimeCall[] }).calls[0]!;
    expect(call.method).toBe("reviewCaptureResult");
    expect(call.payload).toMatchObject({ projectDir: "/repo", inputJson: '{"a":1}' });
  });

});

describe("host plan-document append", () => {
  const ORCH = "gentle-orchestrator";

  function makePlanCtx(root: string, protectedPaths?: string[]): SddOpContext {
    const config = defaultConfig({
      readOnlyAgents: [ORCH],
      projects: [{ id: "test", path: root }],
      ...(protectedPaths ? { protectedPaths } : {}),
    });
    const record: SessionRecord = {
      sessionID: "session-1",
      state: "HOST_READ_ONLY",
      agent: ORCH,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    return {
      config,
      store: { get: () => record },
      sddRuntime: makeRuntime(),
      pool: { allocations: [] },
      hostRead: { has: () => false },
      logger: {},
      resources: {},
      budget: {},
      adapter: {},
      git: {
        runnerMode: "planned",
        spawn: async () => ({ status: 0, stdout: "", stderr: "", timedOut: false }),
      },
    } as unknown as SddOpContext;
  }

  test("computePlanDocAppend preserves existing bytes and normalizes separators", () => {
    expect(computePlanDocAppend("", "x")).toBe("x\n");
    expect(computePlanDocAppend("a", "x")).toBe("a\nx\n");
    expect(computePlanDocAppend("a\n", "x")).toBe("a\nx\n");
    expect(computePlanDocAppend("a\n\n", "x")).toBe("a\n\nx\n");
  });

  test("creates the allowlisted document when absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-doc-create-"));
    try {
      const ctx = makePlanCtx(root);
      const result = (await buildPlanDocAppendOp(ctx)(
        request("planDocAppend", { projectDir: root, doc: "todo", content: "first item" }, ORCH),
      )) as { doc?: string; path?: string; created?: boolean };
      expect(result.doc).toBe("todo");
      expect(result.path).toBe("docs/TODO.md");
      expect(result.created).toBe(true);
      expect(readFileSync(join(root, "docs", "TODO.md"), "utf8")).toBe("first item\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("appends while preserving every existing byte", async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-doc-append-"));
    try {
      mkdirSync(join(root, "docs"));
      const before = "# TODO\n\n- existing item\n";
      writeFileSync(join(root, "docs", "TODO.md"), before);
      const ctx = makePlanCtx(root);
      const result = (await buildPlanDocAppendOp(ctx)(
        request("planDocAppend", { projectDir: root, doc: "todo", content: "  - new item\n" }, ORCH),
      )) as { created?: boolean };
      expect(result.created).toBe(false);
      const after = readFileSync(join(root, "docs", "TODO.md"), "utf8");
      expect(after.startsWith(before)).toBe(true);
      expect(after).toBe(`${before}- new item\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("inserts before the next heading of equal or higher level", async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-doc-heading-"));
    try {
      mkdirSync(join(root, "docs"));
      const existing = "# PLAN\n\nintro\n\n## Phase 1\n\n- a\n\n## Phase 2\n\n- b\n";
      writeFileSync(join(root, "docs", "PLAN.md"), existing);
      const ctx = makePlanCtx(root);
      await buildPlanDocAppendOp(ctx)(
        request(
          "planDocAppend",
          { projectDir: root, doc: "plan", content: "- added under phase 1", heading: "Phase 1" },
          ORCH,
        ),
      );
      expect(readFileSync(join(root, "docs", "PLAN.md"), "utf8")).toBe(
        "# PLAN\n\nintro\n\n## Phase 1\n\n- a\n\n- added under phase 1\n\n## Phase 2\n\n- b\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a missing or ambiguous heading without writing", async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-doc-heading-reject-"));
    try {
      mkdirSync(join(root, "docs"));
      const existing = "# PLAN\n\n## A\n\nx\n\n## A\n\ny\n";
      writeFileSync(join(root, "docs", "PLAN.md"), existing);
      const ctx = makePlanCtx(root);
      await expect(
        buildPlanDocAppendOp(ctx)(
          request("planDocAppend", { projectDir: root, doc: "plan", content: "z", heading: "Missing" }, ORCH),
        ),
      ).rejects.toThrow(ValidationError);
      await expect(
        buildPlanDocAppendOp(ctx)(
          request("planDocAppend", { projectDir: root, doc: "plan", content: "z", heading: "A" }, ORCH),
        ),
      ).rejects.toThrow(ValidationError);
      expect(readFileSync(join(root, "docs", "PLAN.md"), "utf8")).toBe(existing);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects unknown or path-shaped doc values without any write", async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-doc-doc-enum-"));
    try {
      const ctx = makePlanCtx(root);
      for (const doc of ["docs/TODO.md", "../TODO.md", "/etc/passwd", "readme"]) {
        await expect(
          buildPlanDocAppendOp(ctx)(request("planDocAppend", { projectDir: root, doc, content: "x" }, ORCH)),
        ).rejects.toThrow(ValidationError);
      }
      expect(existsSync(join(root, "docs"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a protected destination before any write", async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-doc-protected-"));
    try {
      const ctx = makePlanCtx(root, ["docs/**"]);
      await expect(
        buildPlanDocAppendOp(ctx)(
          request("planDocAppend", { projectDir: root, doc: "todo", content: "x" }, ORCH),
        ),
      ).rejects.toThrow(ValidationError);
      expect(existsSync(join(root, "docs"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a symlinked destination without writing through it", async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-doc-symlink-"));
    const outside = join(tmpdir(), `plan-doc-outside-${process.pid}-${Date.now()}`);
    try {
      mkdirSync(join(root, "docs"));
      writeFileSync(outside, "outside\n");
      try {
        symlinkSync(outside, join(root, "docs", "TODO.md"));
      } catch {
        return; // symlinks unsupported on this filesystem
      }
      const ctx = makePlanCtx(root);
      await expect(
        buildPlanDocAppendOp(ctx)(
          request("planDocAppend", { projectDir: root, doc: "todo", content: "x" }, ORCH),
        ),
      ).rejects.toThrow();
      expect(readFileSync(outside, "utf8")).toBe("outside\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { force: true });
    }
  });

  test("a plan-doc append does not alter any other project file", async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-doc-isolation-"));
    try {
      mkdirSync(join(root, "docs"));
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "docs", "PLAN.md"), "# PLAN\n\nx\n");
      writeFileSync(join(root, "docs", "OTHER.md"), "# OTHER\n\nuntouched\n");
      writeFileSync(join(root, "src", "main.ts"), "export const x = 1;\n");
      writeFileSync(join(root, "README.md"), "# Repo\n");
      const ctx = makePlanCtx(root);
      await buildPlanDocAppendOp(ctx)(
        request("planDocAppend", { projectDir: root, doc: "plan", content: "- appended" }, ORCH),
      );
      expect(readFileSync(join(root, "docs", "OTHER.md"), "utf8")).toBe("# OTHER\n\nuntouched\n");
      expect(readFileSync(join(root, "src", "main.ts"), "utf8")).toBe("export const x = 1;\n");
      expect(readFileSync(join(root, "README.md"), "utf8")).toBe("# Repo\n");
      expect(readFileSync(join(root, "docs", "PLAN.md"), "utf8")).toBe("# PLAN\n\nx\n- appended\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("serializes concurrent appends without losing a block", async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-doc-concurrent-"));
    try {
      const ctx = makePlanCtx(root);
      const handler = buildPlanDocAppendOp(ctx);
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          handler(request("planDocAppend", { projectDir: root, doc: "todo", content: `item ${i}` }, ORCH)),
        ),
      );
      const text = readFileSync(join(root, "docs", "TODO.md"), "utf8");
      for (let i = 0; i < 8; i++) expect(text).toContain(`item ${i}`);
      expect(text.split("\n").filter((line) => line.startsWith("item ")).length).toBe(8);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("leaves no temporary files behind", async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-doc-temp-"));
    try {
      const ctx = makePlanCtx(root);
      await buildPlanDocAppendOp(ctx)(
        request("planDocAppend", { projectDir: root, doc: "todo", content: "x" }, ORCH),
      );
      expect(readdirSync(join(root, "docs"))).toEqual(["TODO.md"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

describe("host review lifecycle routing", () => {
  test("review start forwards provider tokens verbatim to the executor", async () => {
    const ctx = makeCtx();
    await buildReviewStartOp(ctx)(
      request(
        "reviewStart",
        {
          projectDir: process.cwd(),
          contract: "Contract-TOKEN.:v2",
          target: "Target-TOKEN",
          focus: "risk",
          lineage: "Lineage-TOKEN",
          trace: join(tmpdir(), "Trace-TOKEN"),
        },
        ORCHESTRATOR,
      ),
    );
    const call = (ctx.sddRuntime as unknown as { calls: RuntimeCall[] }).calls[0]!;
    expect(call.method).toBe("reviewStart");
    expect(call.payload).toMatchObject({
      projectDir: process.cwd(),
      contract: "Contract-TOKEN.:v2",
      target: "Target-TOKEN",
      focus: "risk",
      lineage: "Lineage-TOKEN",
      trace: join(tmpdir(), "Trace-TOKEN"),
    });
  });

  test("review capture-result forwards the project-relative input path", async () => {
    const ctx = makeCtx();
    await buildReviewCaptureResultOp(ctx)(
      request("reviewCaptureResult", { projectDir: "/repo", input: "openspec/result.json", order: 2 }, ORCHESTRATOR),
    );
    const call = (ctx.sddRuntime as unknown as { calls: RuntimeCall[] }).calls[0]!;
    expect(call.method).toBe("reviewCaptureResult");
    expect(call.payload).toMatchObject({ projectDir: "/repo", input: "openspec/result.json", order: 2 });
  });

  test("review recover rejects undeclared keys and non-orchestrator callers", async () => {
    const trusted = makeCtx();
    const foreign = makeCtx({ recordAgent: "general" });
    await expect(
      buildReviewRecoverOp(trusted)(
        request("reviewRecover", { projectDir: "/repo", cwd: "/tmp" }, ORCHESTRATOR),
      ),
    ).rejects.toThrow(ValidationError);
    await expect(
      buildReviewRecoverOp(foreign)(
        request("reviewRecover", { projectDir: "/repo", disposition: "scope_changed" }, "general"),
      ),
    ).rejects.toThrow(PolicyError);
  });
});
});

