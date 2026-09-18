import { describe, expect, test } from "bun:test";
import {
  buildGhIssueCreateAsk,
  buildGitCommitAsk,
  buildReviewAcknowledgeApprovedAsk,
  buildReviewCaptureCorrectionPlanAsk,
  buildReviewCaptureRefuterAsk,
  buildReviewCaptureResultAsk,
  buildReviewCaptureUnachievableAsk,
  buildReviewCaptureValidationAsk,
  buildReviewRecoverAsk,
  buildRegisterProjectAsk,
  buildReviewStartAsk,
  buildReviewValidateAsk,
  buildGitPushAsk,
  HostToolAskError,
  buildHostToolAsk,
  buildPlanDocAppendAsk,
  buildSddArchiveComposeAsk,
  buildSddAttemptGrantAsk,
} from "../../opencode/plugins/lib/host-tool-approval.ts";
import { OPERATION_TIMEOUT_MS } from "../../opencode/plugins/lib/broker-client.ts";

describe("host tool ask metadata", () => {
  test("base builder never auto-approves and keeps the permission key", () => {
    const ask = buildHostToolAsk({
      permission: "host_example",
      operation: "sddArchiveCompose",
      summary: "compose it",
      details: { a: 1 },
    });
    expect(ask.permission).toBe("host_example");
    expect(ask.patterns).toEqual(["*"]);
    expect(ask.always).toEqual([]);
    expect(ask.metadata).toEqual({
      operation: "sddArchiveCompose",
      summary: "compose it",
      details: { a: 1 },
    });
  });

  test("base builder rejects malformed input", () => {
    expect(() =>
      buildHostToolAsk({
        permission: "",
        operation: "sddArchiveCompose",
        summary: "s",
        details: {},
      }),
    ).toThrow(HostToolAskError);
    expect(() =>
      buildHostToolAsk({
        permission: "p",
        operation: "sddArchiveCompose",
        summary: "",
        details: {},
      }),
    ).toThrow(HostToolAskError);
    expect(() =>
      buildHostToolAsk({
        permission: "p",
        operation: "sddArchiveCompose",
        summary: "s",
        details: [] as never,
      }),
    ).toThrow(HostToolAskError);
  });

  test("archive ask lists the three project-relative paths", () => {
    const ask = buildSddArchiveComposeAsk({
      canonical: "openspec/specs/x/spec.md",
      delta: "openspec/changes/y/specs/x/spec.md",
      output: "openspec/changes/y/composed.md",
    });
    expect(ask.permission).toBe("host_sdd_archive_compose");
    expect(ask.metadata.operation).toBe("sddArchiveCompose");
    expect(ask.metadata.details).toEqual({
      canonical: "openspec/specs/x/spec.md",
      delta: "openspec/changes/y/specs/x/spec.md",
      output: "openspec/changes/y/composed.md",
    });
  });

  test("git commit ask carries branch/subject/path preview and protected result", () => {
    const ask = buildGitCommitAsk({
      message: "fix: scoped",
      branch: "feature/x",
      subject: "fix: scoped",
      paths: ["a.ts", "b.ts"],
      protectedPaths: [],
    });
    expect(ask.permission).toBe("host_git_commit");
    expect(ask.metadata.operation).toBe("gitCommit");
    expect(ask.metadata.details).toMatchObject({
      message: "fix: scoped",
      branch: "feature/x",
      subject: "fix: scoped",
      pathCount: 2,
      pathPreview: "a.ts, b.ts",
      protectedRejected: "none",
    });
    expect(() => buildGitCommitAsk({ message: "" })).toThrow(HostToolAskError);
  });

  test("git commit ask surfaces a delegated sandbox session id", () => {
    const ask = buildGitCommitAsk({ message: "fix: delegated", sandboxSessionID: "worker-7" });
    expect(ask.permission).toBe("host_git_commit");
    expect(ask.metadata.details).toMatchObject({
      message: "fix: delegated",
      sandboxSessionID: "worker-7",
    });
    expect(ask.metadata.details.pathCount).toBeUndefined();
    expect(() =>
      buildGitCommitAsk({ message: "m", sandboxSessionID: "" }),
    ).toThrow(HostToolAskError);
  });

  test("git push ask carries remote/branch/ahead/upstream and warning", () => {
    const ask = buildGitPushAsk({
      remote: "origin",
      branch: "feature/x",
      ahead: 3,
      upstream: "origin/feature/x",
      setUpstream: false,
      warning: "creates a new commit",
    });
    expect(ask.permission).toBe("host_git_push");
    expect(ask.metadata.operation).toBe("gitPush");
    expect(ask.metadata.details).toMatchObject({
      remote: "origin",
      branch: "feature/x",
      ahead: 3,
      upstream: "origin/feature/x",
      setUpstream: "no",
      warning: "creates a new commit",
    });
    expect(() => buildGitPushAsk({ remote: "o", branch: "b", ahead: -1, upstream: null, setUpstream: false })).toThrow(HostToolAskError);
  });

  test("gh issue ask carries repo/title/body preview and byte count", () => {
    const ask = buildGhIssueCreateAsk({ repo: "owner/repo", title: "Bug", body: "line1\nline2" });
    expect(ask.permission).toBe("host_gh_issue_create");
    expect(ask.metadata.operation).toBe("ghIssueCreate");
    expect(ask.metadata.details).toMatchObject({
      repo: "owner/repo",
      title: "Bug",
      bodyPreview: "line1\nline2",
      bodyBytes: 11,
    });
    expect(() => buildGhIssueCreateAsk({ repo: "", title: "t", body: "b" })).toThrow(HostToolAskError);
  });

  test("grant ask surfaces the root count and caller token", () => {
    const ask = buildSddAttemptGrantAsk({
      change: "agent-host-tools",
      roots: ["/home/james/a", "/home/james/b"],
      changeInstance: "instance-token",
      requestId: "grant-request",
      actor: "gentle-orchestrator",
      reason: "widen",
    });
    expect(ask.permission).toBe("host_sdd_attempt_grant");
    expect(ask.metadata.operation).toBe("sddAttemptGrant");
    expect(ask.metadata.details).toMatchObject({
      rootCount: 2,
      changeInstance: "instance-token",
      actor: "gentle-orchestrator",
    });
  });

  test("plan append ask surfaces the document, heading, and byte count", () => {
    const ask = buildPlanDocAppendAsk({ doc: "todo", content: "line1\nline2", heading: "Next" });
    expect(ask.permission).toBe("host_plan_append");
    expect(ask.metadata.operation).toBe("planDocAppend");
    expect(ask.metadata.details).toEqual({
      doc: "todo",
      contentBytes: 11,
      heading: "Next",
    });
    expect(ask.always).toEqual([]);
  });

  test("plan append ask omits the heading when absent and rejects bad input", () => {
    const ask = buildPlanDocAppendAsk({ doc: "plan", content: "x" });
    expect(ask.metadata.details).toEqual({ doc: "plan", contentBytes: 1 });
    expect(() => buildPlanDocAppendAsk({ doc: "todo", content: "" })).toThrow(HostToolAskError);
    expect(() => buildPlanDocAppendAsk({ doc: "other" as never, content: "x" })).toThrow(HostToolAskError);
    expect(() => buildPlanDocAppendAsk({ doc: "todo", content: "x", heading: "" })).toThrow(
      HostToolAskError,
    );
  });

  test("register project ask carries the path and yes/no flags", () => {
    const ask = buildRegisterProjectAsk({
      path: "/home/james/new-project",
      dryRun: true,
      createRemote: false,
      makePublic: true,
    });
    expect(ask.permission).toBe("host_register_project");
    expect(ask.metadata.operation).toBe("registerProject");
    expect(ask.always).toEqual([]);
    expect(ask.patterns).toEqual(["*"]);
    expect(ask.metadata.details).toMatchObject({
      path: "/home/james/new-project",
      dryRun: "yes",
      createRemote: "no",
      makePublic: "yes",
    });
    expect(ask.metadata.summary).toContain("/home/james/new-project");
  });

  test("register project ask rejects an empty path", () => {
    expect(() => buildRegisterProjectAsk({ path: "" })).toThrow(HostToolAskError);
  });

describe("host review lifecycle ask metadata", () => {
  test("each review op keeps its permission key and never auto-approves", () => {
    const asks = [
      buildReviewStartAsk({ contract: "Contract-TOKEN", target: "Target-TOKEN", focus: "risk", lineage: "Lineage-TOKEN" }),
      buildReviewCaptureResultAsk({ input: "-", lens: "lens-token", order: 2 }),
      buildReviewCaptureUnachievableAsk({ target: "T", reason: "r" }),
      buildReviewAcknowledgeApprovedAsk({}),
      buildReviewCaptureCorrectionPlanAsk({ target: "T", correctionLines: 4 }),
      buildReviewCaptureRefuterAsk({ target: "T", materialize: true }),
      buildReviewCaptureValidationAsk({ target: "T", requestHash: `sha256:${"a".repeat(64)}`, execute: true }),
      buildReviewValidateAsk({ gate: "pre-pr", lineage: "L" }),
      buildReviewRecoverAsk({ actor: "gentle-orchestrator", disposition: "scope_changed" }),
    ];
    for (const ask of asks) {
      expect(ask.permission.startsWith("host_review_")).toBe(true);
      expect(ask.always).toEqual([]);
      expect(ask.patterns).toEqual(["*"]);
      expect(typeof ask.metadata.summary).toBe("string");
    }
  });

  test("review recover ask never surfaces maintainer authorization content", () => {
    const ask = buildReviewRecoverAsk({
      actor: "gentle-orchestrator",
      disposition: "scope_changed",
      maintainerAuthorization: '{"approve":true}',
      reason: "r",
    });
    expect(JSON.stringify(ask.metadata.details)).not.toContain("approve");
    expect(ask.metadata.details).toMatchObject({
      actor: "gentle-orchestrator",
      disposition: "scope_changed",
    });
  });

  test("review ask builders reject invalid enums and malformed inputs", () => {
    expect(() => buildReviewStartAsk({ focus: "nope" as never })).toThrow(HostToolAskError);
    expect(() => buildReviewCaptureResultAsk({ order: 0 })).not.toThrow();
    expect(buildReviewCaptureResultAsk({ order: 0 }).metadata.details.order).toBe(0);
    expect(() => buildReviewCaptureResultAsk({ order: 33 })).toThrow(HostToolAskError);
    expect(() => buildReviewValidateAsk({ gate: "nope" as never })).toThrow(HostToolAskError);
  });

  test("review capture-result ask surfaces inline byte count and digest only", () => {
    const body = '{"reviewer":"x"}';
    const ask = buildReviewCaptureResultAsk({
      inputJsonBytes: Buffer.byteLength(body, "utf8"),
      inputJsonDigest: "abcd1234",
    });
    expect(ask.metadata.details.inputJsonBytes).toBe(Buffer.byteLength(body, "utf8"));
    expect(ask.metadata.details.inputJsonDigest).toBe("abcd1234");
    expect(JSON.stringify(ask.metadata.details)).not.toContain("reviewer");
  });
});
});

describe("host review lens-context client timeout", () => {
  test("bounds the reviewLensContext client wait above the read default", () => {
    expect(OPERATION_TIMEOUT_MS.reviewLensContext).toBe(130_000);
    expect(OPERATION_TIMEOUT_MS.reviewLensContext).toBeGreaterThan(30_000);
  });
});
