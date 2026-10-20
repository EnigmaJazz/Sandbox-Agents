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
  buildSandboxResultInstallAsk,
  buildReviewStartAsk,
  buildReviewValidateAsk,
  buildGitPushAsk,
  HostToolAskError,
  buildHostToolAsk,
  buildPlanDocAppendAsk,
  assertReviewPersistPreflightClear,
  buildReviewPersistAsk,
  buildSddArchiveComposeAsk,
  buildSddAttemptGrantAsk,
} from "../../opencode/plugins/lib/host-tool-approval.ts";
import { OPERATION_TIMEOUT_MS } from "../../opencode/plugins/lib/broker-client.ts";

describe("host tool ask metadata", () => {
  test("base builder keeps approval metadata visible and never auto-approves", () => {
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
      hostOperation: "sddArchiveCompose",
      summary: "compose it",
      a: 1,
    });
    expect(ask.metadata).not.toHaveProperty("details");
  });

  test("base builder avoids PermissionCard metadata-suppression keys", () => {
    const ask = buildHostToolAsk({
      permission: "host_example",
      operation: "sddArchiveCompose",
      summary: "compose it",
      details: { preview: "visible diff" },
    });
    // PermissionCard's genericContent and description branches suppress the Details dump.
    for (const key of ["command", "content", "action", "operation", "description"]) {
      expect(ask.metadata).not.toHaveProperty(key);
    }
    expect(ask.metadata.hostOperation).toBe("sddArchiveCompose");
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
    expect(ask.metadata.hostOperation).toBe("sddArchiveCompose");
    expect(ask.metadata).toMatchObject({
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
    expect(ask.metadata.hostOperation).toBe("gitCommit");
    expect(ask.metadata).toMatchObject({
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
    expect(ask.metadata).toMatchObject({
      message: "fix: delegated",
      sandboxSessionID: "worker-7",
    });
    expect(ask.metadata.pathCount).toBeUndefined();
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
    expect(ask.metadata.hostOperation).toBe("gitPush");
    expect(ask.metadata).toMatchObject({
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
    expect(ask.metadata.hostOperation).toBe("ghIssueCreate");
    expect(ask.metadata).toMatchObject({
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
    expect(ask.metadata.hostOperation).toBe("sddAttemptGrant");
    expect(ask.metadata).toMatchObject({
      rootCount: 2,
      changeInstance: "instance-token",
      actor: "gentle-orchestrator",
    });
  });

  test("plan append ask surfaces the document, heading, and byte count", () => {
    const ask = buildPlanDocAppendAsk({ doc: "todo", content: "line1\nline2", heading: "Next" });
    expect(ask.permission).toBe("host_plan_append");
    expect(ask.metadata.hostOperation).toBe("planDocAppend");
    expect(ask.metadata).toMatchObject({
      doc: "todo",
      contentBytes: 11,
      heading: "Next",
    });
    expect(ask.always).toEqual([]);
  });

  test("review persist write ask names the checked artifact, verdict, provenance, and publication", () => {
    const ask = buildReviewPersistAsk({
      projectDir: "/work/project",
      runId: "0123456789abcdef0123456789abcdef",
      finalizeRef: "phase-finalize.json",
      mode: "write",
      preflight: {
        finalize: { name: "phase-finalize.json", bytes: 321, sha256: "digest-123" },
        baseObjectId: "base-object",
        headObjectId: "head-object",
        changedPaths: 4,
        verdict: "pass",
        verdictSource: "plan_assessment.verdict",
        counts: { findings_count: 3, findings: 3 },
        finalizeInput: "inputRef",
      },
    });
    expect(ask.permission).toBe("host_review_persist");
    expect(ask.metadata.hostOperation).toBe("reviewPersist");
    for (const detail of [
      "/work/project", "0123456789abcdef0123456789abcdef", "review-summary.json",
      "validation happens after publication", "may replace an existing summary",
      ".context/.gitignore may be created or changed", "digest-123", "pass", "artifact reference phase-finalize.json",
    ]) expect(ask.metadata.summary).toContain(detail);
    expect(ask.metadata.summary).not.toContain("NO project file will be written");
    expect(ask.metadata).toMatchObject({
      projectDir: "/work/project", runId: "0123456789abcdef0123456789abcdef", finalizeRef: "phase-finalize.json",
      artifactName: "phase-finalize.json", artifactBytes: 321, artifactSha256: "digest-123",
      baseObjectId: "base-object", headObjectId: "head-object", changedPaths: 4,
      verdict: "pass", verdictSource: "plan_assessment.verdict", counts: "findings=3; findings_count=3",
      finalizeInput: "artifact reference phase-finalize.json",
    });
    expect(ask.metadata.summary).toContain("counts findings=3; findings_count=3");
  });

  test("review persist counts render as sorted bounded flat text", () => {
    const base = {
      projectDir: "/work/project", runId: "0123456789abcdef0123456789abcdef", finalizeRef: "phase-finalize.json",
      preflight: {
        finalize: { name: "phase-finalize.json", bytes: 1, sha256: "digest" },
        baseObjectId: null, headObjectId: null, changedPaths: 0, verdict: null, verdictSource: null,
        finalizeInput: "unknown" as const,
      },
    };
    expect(buildReviewPersistAsk({ ...base, preflight: { ...base.preflight, counts: {} } }).metadata.counts).toBe("none");
    const counts = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`count_${String(index).padStart(2, "0")}`, index]));
    const rendered = buildReviewPersistAsk({ ...base, preflight: { ...base.preflight, counts } }).metadata.counts;
    expect(typeof rendered).toBe("string");
    expect(String(rendered).length).toBeLessThanOrEqual(512);
    expect(String(rendered).startsWith("count_00=0; count_01=1")).toBe(true);
  });

  test("review persist blockers refuse before approval with all broker reasons", () => {
    expect(() => assertReviewPersistPreflightClear([
      { code: "review_persist_kind", message: "not writing" },
      { code: "review_persist_finalize_ref_mismatch", message: "wrong ref" },
    ])).toThrow("review_persist_kind: not writing; review_persist_finalize_ref_mismatch: wrong ref");
    try { assertReviewPersistPreflightClear([{ code: "review_persist_kind", message: "not writing" }]); }
    catch (error) { expect(error).toMatchObject({ code: "review_persist_preflight_blocked" }); }
  });

  test("review persist report-only ask states that no project write or validation occurs", () => {
    const ask = buildReviewPersistAsk({
      projectDir: "/work/project",
      runId: "0123456789abcdef0123456789abcdef",
      finalizeRef: "phase-finalize.json",
      mode: "report_only",
      preflight: {
        finalize: { name: "phase-finalize.json", bytes: 321, sha256: "digest-123" },
        baseObjectId: "base-object", headObjectId: "head-object", changedPaths: 4,
        verdict: "pass", verdictSource: "verdict", counts: {}, finalizeInput: "stdin",
      },
    });
    expect(ask.permission).toBe("host_review_persist");
    expect(ask.metadata.hostOperation).toBe("reviewPersist");
    expect(ask.metadata.summary).toContain("NO project file will be written");
    expect(ask.metadata.summary).toContain("validation is not attempted");
    expect(ask.metadata.summary).not.toContain("may replace an existing summary");
  });

  test("plan append ask omits the heading when absent and rejects bad input", () => {
    const ask = buildPlanDocAppendAsk({ doc: "plan", content: "x" });
    expect(ask.metadata).toMatchObject({ doc: "plan", contentBytes: 1 });
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
    expect(ask.metadata.hostOperation).toBe("registerProject");
    expect(ask.always).toEqual([]);
    expect(ask.patterns).toEqual(["*"]);
    expect(ask.metadata).toMatchObject({
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
      expect(JSON.stringify(ask.metadata)).not.toContain("approve");
      expect(ask.metadata).toMatchObject({
        actor: "gentle-orchestrator",
        disposition: "scope_changed",
      });
    });

    test("review ask builders reject invalid enums and malformed inputs", () => {
      expect(() => buildReviewStartAsk({ focus: "nope" as never })).toThrow(HostToolAskError);
      expect(() => buildReviewCaptureResultAsk({ order: 0 })).not.toThrow();
      expect(buildReviewCaptureResultAsk({ order: 0 }).metadata.order).toBe(0);
      expect(() => buildReviewCaptureResultAsk({ order: 33 })).toThrow(HostToolAskError);
      expect(() => buildReviewValidateAsk({ gate: "nope" as never })).toThrow(HostToolAskError);
    });

    test("review capture-result ask surfaces inline byte count and digest only", () => {
      const body = '{"reviewer":"x"}';
      const ask = buildReviewCaptureResultAsk({
        inputJsonBytes: Buffer.byteLength(body, "utf8"),
        inputJsonDigest: "abcd1234",
      });
      expect(ask.metadata.inputJsonBytes).toBe(Buffer.byteLength(body, "utf8"));
      expect(ask.metadata.inputJsonDigest).toBe("abcd1234");
      expect(JSON.stringify(ask.metadata)).not.toContain("reviewer");
    });
  });
});

describe("host review client timeouts", () => {
  test("bounds the reviewLensContext client wait above the read default", () => {
    expect(OPERATION_TIMEOUT_MS.reviewLensContext).toBe(130_000);
    expect(OPERATION_TIMEOUT_MS.reviewLensContext).toBeGreaterThan(30_000);
  });

  test("gives reviewMaterialize a 60-second operation budget", () => {
    expect(OPERATION_TIMEOUT_MS.reviewMaterialize).toBe(60_000);
  });
});

describe("sandbox result install ask metadata", () => {
  test("approval metadata carries the summary and bounded install preview", () => {
    const ask = buildSandboxResultInstallAsk({
      resultRef: "refs/opencode-sandbox/result/worker-7",
      resultCommit: "0123456789abcdef0123456789abcdef01234567",
      changedPaths: ["broker/src/server.ts", "gone.ts"],
      sandboxSessionID: "worker-7",
      preview: "diff --git a/file.ts b/file.ts\n+visible change",
      previewTruncated: true,
      previewFile: "/private/preview.patch",
    });
    expect(ask.permission).toBe("host_sandbox_result_install");
    expect(ask.metadata.hostOperation).toBe("sandboxResultInstall");
    expect(ask.always).toEqual([]);
    expect(ask.patterns).toEqual(["*"]);
    expect(ask.metadata).toMatchObject({
      summary: "Install 2 result path(s) from refs/opencode-sandbox/result/worker-7 at commit 0123456789ab",
      resultRef: "refs/opencode-sandbox/result/worker-7",
      resultCommit: "0123456789abcdef0123456789abcdef01234567",
      sandboxSessionID: "worker-7",
      pathCount: 2,
      pathPreview: "broker/src/server.ts, gone.ts",
      preview: "diff --git a/file.ts b/file.ts\n+visible change",
      previewTruncated: true,
      previewFile: "/private/preview.patch",
    });
    expect(ask.metadata).not.toHaveProperty("details");
    expect(() =>
      buildSandboxResultInstallAsk({ resultRef: "", resultCommit: "x" }),
    ).toThrow(HostToolAskError);
  });
});
