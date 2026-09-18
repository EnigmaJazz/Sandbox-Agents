import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config.ts";
import { PolicyError } from "../src/policy.ts";
import { authorizeHostDispatch } from "../src/service.ts";
import { buildGhIssueCreateOp, buildGitCommitOp, buildGitPushOp, buildRegisterProjectOp } from "../src/service.ts";
import { MsbError } from "../src/msb.ts";
import { StateError } from "../src/state.ts";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
import { HOST_MUTATION_OPERATIONS, HOST_READ_OPERATIONS, ValidationError } from "../src/validation.ts";
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

  function makeGitCtx(spawn: SddOpContext["git"]["spawn"]): SddOpContext {
    const config = defaultConfig({
      readOnlyAgents: [ORCHESTRATOR],
      projects: [{ id: "test", path: projectRoot }],
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
      store: { get: () => record },
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
      return { status: 0, stdout: "", stderr: "", timedOut: false };
    };
    return { calls, spawn };
  }

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
    expect(calls).toContainEqual(["git", "commit", "-m", "fix: scoped", "--", "a.ts"]);
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
    expect(calls.some((c) => c[1] === "commit")).toBe(false);
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
          projectDir: "/repo",
          contract: "Contract-TOKEN.:v2",
          target: "Target-TOKEN",
          focus: "risk",
          lineage: "Lineage-TOKEN",
          trace: "Trace-TOKEN",
        },
        ORCHESTRATOR,
      ),
    );
    const call = (ctx.sddRuntime as unknown as { calls: RuntimeCall[] }).calls[0]!;
    expect(call.method).toBe("reviewStart");
    expect(call.payload).toMatchObject({
      projectDir: "/repo",
      contract: "Contract-TOKEN.:v2",
      target: "Target-TOKEN",
      focus: "risk",
      lineage: "Lineage-TOKEN",
      trace: "Trace-TOKEN",
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

