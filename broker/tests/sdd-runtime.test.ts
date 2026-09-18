import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SpawnFn } from "../src/msb.ts";
import { ValidationError } from "../src/validation.ts";
import {
  SddRuntimeExecutor,
  buildReviewAssessArgv,
  buildReviewAcknowledgeApprovedArgv,
  buildReviewCaptureCorrectionPlanArgv,
  buildReviewCaptureRefuterArgv,
  buildReviewCaptureResultArgv,
  buildReviewCaptureUnachievableArgv,
  buildReviewCaptureValidationArgv,
  buildReviewLensContextArgv,
  buildReviewRecoverArgv,
  buildReviewStartArgv,
  buildReviewValidateArgv,
  buildReviewModeStatusArgv,
  buildReviewStatusArgv,
  buildSddArchiveComposeArgv,
  buildSddAttemptGrantArgv,
  buildSddContinueArgv,
  buildSddStatusArgv,
  buildSddTaskResultArgv,
  cleanupStaleReviewInputs,
} from "../src/sdd-runtime.ts";

const projectRoot = realpathSync(resolve(import.meta.dir, "../.."));
const configuredProjectRoot = `${projectRoot}/broker/..`;

const revision = "a".repeat(64);

function makeExecutor(spawn: SpawnFn): SddRuntimeExecutor {
  return new SddRuntimeExecutor({
    binary: "gentle-ai",
    projects: [{ id: "repo", path: configuredProjectRoot }],
    spawn,
  });
}

describe("host-side SDD runtime argv", () => {
  test("builds the exact status argv for a configured project root", () => {
    expect(
      buildSddStatusArgv({ binary: "gentle-ai", projectRoot }),
    ).toEqual([
      "gentle-ai",
      "sdd-status",
      "--cwd",
      projectRoot,
      "--json",
      "--instructions",
    ]);
  });

  test("status accepts an optional change and allowlisted contract", () => {
    expect(
      buildSddStatusArgv({
        binary: "gentle-ai",
        projectRoot,
        change: "agent-host-tools",
        contract: "gentle-ai.sdd-status/v2",
      }),
    ).toEqual([
      "gentle-ai",
      "sdd-status",
      "agent-host-tools",
      "--cwd",
      projectRoot,
      "--json",
      "--instructions",
      "--contract",
      "gentle-ai.sdd-status/v2",
    ]);
  });

  test("status rejects an unknown contract and unsafe change", () => {
    expect(() =>
      buildSddStatusArgv({ binary: "gentle-ai", projectRoot, contract: "evil/v9" }),
    ).toThrow(ValidationError);
    expect(() =>
      buildSddStatusArgv({ binary: "gentle-ai", projectRoot, change: "../escape" }),
    ).toThrow(ValidationError);
  });

  test("continue never emits --json", () => {
    expect(buildSddContinueArgv({ binary: "gentle-ai", projectRoot })).toEqual([
      "gentle-ai",
      "sdd-continue",
      "--cwd",
      projectRoot,
    ]);
    expect(
      buildSddContinueArgv({ binary: "gentle-ai", projectRoot, change: "agent-host-tools" }),
    ).toEqual([
      "gentle-ai",
      "sdd-continue",
      "agent-host-tools",
      "--cwd",
      projectRoot,
    ]);
  });

  test("archive compose resolves project-relative paths beneath the root", () => {
    expect(
      buildSddArchiveComposeArgv({
        binary: "gentle-ai",
        projectRoot,
        canonical: "openspec/specs/host-sdd-runtime-tools/spec.md",
        delta: "openspec/changes/agent-host-tools/specs/host-sdd-runtime-tools/spec.md",
        output: "openspec/changes/agent-host-tools/archive-composed.md",
      }),
    ).toEqual([
      "gentle-ai",
      "sdd-archive-compose",
      "--canonical",
      `${projectRoot}/openspec/specs/host-sdd-runtime-tools/spec.md`,
      "--delta",
      `${projectRoot}/openspec/changes/agent-host-tools/specs/host-sdd-runtime-tools/spec.md`,
      "--output",
      `${projectRoot}/openspec/changes/agent-host-tools/archive-composed.md`,
    ]);
    expect(() =>
      buildSddArchiveComposeArgv({
        binary: "gentle-ai",
        projectRoot,
        canonical: "/etc/passwd",
        delta: "../delta.md",
        output: "out.md",
      }),
    ).toThrow(ValidationError);
  });

  test("task-result carries phase, cwd, and a resolved input", () => {
    expect(
      buildSddTaskResultArgv({
        binary: "gentle-ai",
        projectRoot,
        phase: "apply",
        input: "openspec/changes/agent-host-tools/task-result.json",
      }),
    ).toEqual([
      "gentle-ai",
      "sdd-task-result",
      "--phase",
      "apply",
      "--cwd",
      projectRoot,
      "--input",
      `${projectRoot}/openspec/changes/agent-host-tools/task-result.json`,
    ]);
  });

  test("review assess keeps --cwd and --json", () => {
    expect(buildReviewAssessArgv({ binary: "gentle-ai", projectRoot })).toEqual([
      "gentle-ai",
      "review",
      "assess",
      "--cwd",
      projectRoot,
      "--json",
    ]);
  });

  test("review mode status has no --cwd and no --json", () => {
    expect(buildReviewModeStatusArgv({ binary: "gentle-ai" })).toEqual([
      "gentle-ai",
      "review",
      "mode",
      "status",
    ]);
    expect(() => buildReviewModeStatusArgv({ binary: "gentle-ai", extra: true } as never)).toThrow(
      ValidationError,
    );
  });
});

describe("host-side SDD runtime executor", () => {
  test("resolves only an exact configured project root", () => {
    const spawn: SpawnFn = async () => ({
      status: 0,
      stdout: "{}",
      stderr: "",
      timedOut: false,
    });
    const executor = makeExecutor(spawn);

    expect(executor.resolveProjectRoot(configuredProjectRoot)).toBe(projectRoot);
    expect(() => executor.resolveProjectRoot("/etc")).toThrow(ValidationError);
  });

  test("passes exact argv and canonical cwd, parsing JSON despite a nonzero exit", async () => {
    const calls: Array<{ argv: string[]; cwd: string | undefined }> = [];
    const spawn: SpawnFn = async (argv, options) => {
      calls.push({ argv: [...argv], cwd: options.cwd });
      return {
        status: 17,
        stdout: JSON.stringify({ state: "blocked", reason: "attempt-held" }),
        stderr: "attempt already held",
        timedOut: false,
      };
    };
    const executor = makeExecutor(spawn);

    const result = await executor.status(configuredProjectRoot);

    expect(calls).toEqual([
      {
        argv: [
          "gentle-ai",
          "sdd-status",
          "--cwd",
          projectRoot,
          "--json",
          "--instructions",
        ],
        cwd: projectRoot,
      },
    ]);
    expect(result).toEqual({
      status: 17,
      json: { state: "blocked", reason: "attempt-held" },
      stderr: "attempt already held",
    });
  });

  test("rejects non-JSON stdout instead of returning an unstructured result", async () => {
    const spawn: SpawnFn = async () => ({
      status: 1,
      stdout: "not JSON",
      stderr: "command failed",
      timedOut: false,
    });
    const executor = makeExecutor(spawn);

    await expect(executor.status(configuredProjectRoot)).rejects.toThrow(/JSON/);
  });

  test("review mode status tolerates non-JSON stdout without failing", async () => {
    const spawn: SpawnFn = async () => ({
      status: 0,
      stdout: "review mode: passive\n",
      stderr: "",
      timedOut: false,
    });
    const executor = makeExecutor(spawn);

    const result = await executor.reviewModeStatus({ projectDir: configuredProjectRoot });

    expect(result.status).toBe(0);
    expect(result.json).toBeUndefined();
    expect(result.text).toContain("passive");
  });

  test("review mode status parses JSON when the binary emits it", async () => {
    const spawn: SpawnFn = async () => ({
      status: 0,
      stdout: JSON.stringify({ mode: "passive" }),
      stderr: "",
      timedOut: false,
    });
    const executor = makeExecutor(spawn);

    const result = await executor.reviewModeStatus({ projectDir: configuredProjectRoot });
    expect(result.json).toEqual({ mode: "passive" });
  });

});

describe("host-side attempt ledger grant argv", () => {
  const objective = {
    binary: "gentle-ai",
    projectRoot: "/home/james/peak-redir",
    change: "peak-hour-routing",
    expectedRevision: `sha256:${revision}`,
    requestId: "ledger-request",
    workUnit: "slice-1-proof-policy",
    evidenceGoal: "proof-policy-implementation",
    maxAttempts: 1,
    maxChangedLines: 300,
  };

  test("grant repeats --root in order, keeps initial revision optional, and bounds roots", () => {
    const compact = {
      binary: "gentle-ai",
      projectRoot: "/home/james/peak-redir",
      change: "peak-hour-routing",
      roots: ["/home/james/a", "/home/james/b"],
      changeInstance: "instance-token",
      requestId: "grant-request",
      actor: "gentle-orchestrator",
      reason: "widen roots",
    };
    expect(buildSddAttemptGrantArgv(compact)).toEqual([
      "gentle-ai",
      "sdd-attempt",
      "grant",
      "--cwd",
      "/home/james/peak-redir",
      "--change",
      "peak-hour-routing",
      "--root",
      "/home/james/a",
      "--root",
      "/home/james/b",
      "--change-instance",
      "instance-token",
      "--request-id",
      "grant-request",
      "--actor",
      "gentle-orchestrator",
      "--reason",
      "widen roots",
    ]);
    const withRevision = buildSddAttemptGrantArgv({
      ...compact,
      expectedRevision: `sha256:${revision}`,
    });
    expect(withRevision.indexOf("--expected-revision")).toBeGreaterThan(
      withRevision.indexOf("--change"),
    );
    expect(withRevision[withRevision.indexOf("--expected-revision") + 1]).toBe(
      `sha256:${revision}`,
    );
    const badRoots: string[][] = [
      [],
      ["/home/james/a", "/home/james/a"],
      ["relative/path"],
      ["/home/james/../etc"],
      ["/home/james/a/"],
      [`/home/james/${"x".repeat(4097)}`],
      Array.from({ length: 33 }, (_, i) => `/home/james/r${i}`),
    ];
    for (const roots of badRoots) {
      expect(() => buildSddAttemptGrantArgv({ ...compact, roots } as never)).toThrow(
        ValidationError,
      );
    }
    expect(() => buildSddAttemptGrantArgv({ ...compact, changeInstance: "" } as never)).toThrow(
      ValidationError,
    );
    expect(() => buildSddAttemptGrantArgv({ ...compact, reason: "" } as never)).toThrow(
      ValidationError,
    );
    expect(() =>
      buildSddAttemptGrantArgv({ ...compact, actor: "a".repeat(129) } as never),
    ).toThrow(ValidationError);
  });

});

describe("host-side review status forwarding", () => {
  test("review status builds the exact argv and defaults the agent to opencode", () => {
    expect(buildReviewStatusArgv({ binary: "gentle-ai", projectRoot })).toEqual([
      "gentle-ai",
      "review",
      "status",
      "--cwd",
      projectRoot,
      "--contract",
      "gentle-ai.review-integration/v2",
      "--agent",
      "opencode",
      "--next-transition",
    ]);
    expect(
      buildReviewStatusArgv({ binary: "gentle-ai", projectRoot, agent: "opencode-sandbox" }),
    ).toEqual([
      "gentle-ai",
      "review",
      "status",
      "--cwd",
      projectRoot,
      "--contract",
      "gentle-ai.review-integration/v2",
      "--agent",
      "opencode-sandbox",
      "--next-transition",
    ]);
    expect(() =>
      buildReviewStatusArgv({ binary: "gentle-ai", projectRoot, agent: "Bad Agent" }),
    ).toThrow(ValidationError);
    expect(() =>
      buildReviewStatusArgv({ binary: "gentle-ai", projectRoot, extra: true } as never),
    ).toThrow(ValidationError);
  });

  test("review status emits the bound passthrough flags in order", () => {
    expect(
      buildReviewStatusArgv({
        binary: "gentle-ai",
        projectRoot,
        lineage: "Lineage-TOKEN",
        repositoryContext: "Repo-Context!",
        projection: "staged",
      }),
    ).toEqual([
      "gentle-ai",
      "review",
      "status",
      "--cwd",
      projectRoot,
      "--contract",
      "gentle-ai.review-integration/v2",
      "--agent",
      "opencode",
      "--lineage",
      "Lineage-TOKEN",
      "--repository-context",
      "Repo-Context!",
      "--projection",
      "staged",
      "--next-transition",
    ]);
    expect(() =>
      buildReviewStatusArgv({ binary: "gentle-ai", projectRoot, projection: "sideways" as never }),
    ).toThrow(ValidationError);
    expect(() =>
      buildReviewStatusArgv({ binary: "gentle-ai", projectRoot, lineage: "-flag" }),
    ).toThrow(ValidationError);
  });

  test("review status emits the intended untracked selection and forwards it verbatim", async () => {
    const selection =
      '{"schema":"gentle-ai.review-intended-untracked-selection/v1","paths":["openspec/changes/x/new.md"]}';
    const expected = [
      "gentle-ai",
      "review",
      "status",
      "--cwd",
      projectRoot,
      "--contract",
      "gentle-ai.review-integration/v2",
      "--agent",
      "opencode",
      "--projection",
      "workspace",
      "--intended-untracked-selection",
      selection,
      "--next-transition",
    ];
    expect(
      buildReviewStatusArgv({
        binary: "gentle-ai",
        projectRoot,
        projection: "workspace",
        intendedUntrackedSelection: selection,
      }),
    ).toEqual(expected);

    // Verbatim bytes: unusual spacing is JSON-validated, never re-serialized.
    const spaced =
      '{ "schema" : "gentle-ai.review-intended-untracked-selection/v1" , "paths" : [ "a.md" ] }';
    const calls: string[][] = [];
    const spawn: SpawnFn = async (argv) => {
      calls.push([...argv]);
      return {
        status: 0,
        stdout: JSON.stringify({ next_transition: { kind: "collect" } }),
        stderr: "",
        timedOut: false,
      };
    };
    const result = await makeExecutor(spawn).reviewStatus({
      projectDir: configuredProjectRoot,
      intendedUntrackedSelection: spaced,
    });
    expect(result.json).toEqual({ next_transition: { kind: "collect" } });
    expect(calls).toEqual([
      [
        "gentle-ai",
        "review",
        "status",
        "--cwd",
        projectRoot,
        "--contract",
        "gentle-ai.review-integration/v2",
        "--agent",
        "opencode",
        "--intended-untracked-selection",
        spaced,
        "--next-transition",
      ],
    ]);

    // Fail closed before any spawn.
    for (const bad of [
      "",
      "not json",
      "{",
      "-5",
      '"ok"\n',
      '{"a":"b' + String.fromCharCode(0) + '"}',
      '"' + "a".repeat(70_000) + '"',
    ]) {
      expect(() =>
        buildReviewStatusArgv({ binary: "gentle-ai", projectRoot, intendedUntrackedSelection: bad }),
      ).toThrow(ValidationError);
    }
  });

  test("review status executor passes the exact argv and parses the envelope", async () => {
    const calls: string[][] = [];
    const spawn: SpawnFn = async (argv) => {
      calls.push([...argv]);
      return {
        status: 0,
        stdout: JSON.stringify({ eligible_untracked_inventory: `sha256:${"b".repeat(64)}` }),
        stderr: "",
        timedOut: false,
      };
    };
    const executor = makeExecutor(spawn);

    const result = await executor.reviewStatus({ projectDir: configuredProjectRoot });

    expect(calls).toEqual([
      [
        "gentle-ai",
        "review",
        "status",
        "--cwd",
        projectRoot,
        "--contract",
        "gentle-ai.review-integration/v2",
        "--agent",
        "opencode",
        "--next-transition",
      ],
    ]);
    expect(result.json).toEqual({ eligible_untracked_inventory: `sha256:${"b".repeat(64)}` });
  });

  test("surfaces bounded stderr when stdout is empty or not JSON", async () => {
    const emptySpawn: SpawnFn = async () => ({
      status: 1,
      stdout: "",
      stderr: "Error: untracked files require an explicit declaration",
      timedOut: false,
    });
    await expect(makeExecutor(emptySpawn).status(configuredProjectRoot)).rejects.toThrow(
      /untracked files require an explicit declaration/,
    );

    const nonJsonSpawn: SpawnFn = async () => ({
      status: 1,
      stdout: "not JSON",
      stderr: "Error: review status failed: bad contract",
      timedOut: false,
    });
    await expect(makeExecutor(nonJsonSpawn).status(configuredProjectRoot)).rejects.toThrow(
      /review status failed/,
    );

    const hugeSpawn: SpawnFn = async () => ({
      status: 1,
      stdout: "",
      stderr: "x".repeat(10_000),
      timedOut: false,
    });
    try {
      await makeExecutor(hugeSpawn).status(configuredProjectRoot);
      throw new Error("expected rejection");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("stderr:");
      expect(Buffer.byteLength(message, "utf8")).toBeLessThan(5 * 1024);
    }
  });

describe("host-side review lifecycle argv", () => {
  const rev = `sha256:${revision}`;
  const base = { binary: "gentle-ai", projectRoot };

  test("review start emits the exact fixed argv with verbatim provider tokens", () => {
    const digest = `sha256:${"b".repeat(64)}`;
    const argv = buildReviewStartArgv({
      ...base,
      agent: "opencode",
      contract: "Contract-TOKEN.:v2",
      target: "Target-TOKEN.:/x",
      projection: "workspace",
      focus: "risk",
      untrackedScope: "select",
      expectedUntrackedInventory: digest,
      intendedUntracked: ["b.ts", "a.ts"],
      baseRef: "refs/heads/main",
      committedOnly: true,
      workspaceOverlay: true,
      lineage: "Lineage-TOKEN:abc",
      consent: "relay",
      locale: "es",
      policy: "Policy-TOKEN!",
      trace: "Trace-TOKEN#1",
    });
    expect(argv).toEqual([
      "gentle-ai", "review", "start", "--cwd", projectRoot,
      "--agent", "opencode",
      "--contract", "Contract-TOKEN.:v2",
      "--target", "Target-TOKEN.:/x",
      "--projection", "workspace",
      "--focus", "risk",
      "--untracked-scope", "select",
      "--expected-untracked-inventory", digest,
      "--intended-untracked", "b.ts",
      "--intended-untracked", "a.ts",
      "--base-ref", "refs/heads/main",
      "--committed-only",
      "--workspace-overlay",
      "--lineage", "Lineage-TOKEN:abc",
      "--consent", "relay",
      "--locale", "es",
      "--policy", "Policy-TOKEN!",
      "--trace", "Trace-TOKEN#1",
    ]);
    expect(argv[argv.indexOf("--contract") + 1]).toBe("Contract-TOKEN.:v2");
    expect(argv[argv.indexOf("--target") + 1]).toBe("Target-TOKEN.:/x");
    expect(argv[argv.indexOf("--policy") + 1]).toBe("Policy-TOKEN!");
  });

  test("review start rejects invalid enums, flags, and untracked coupling", () => {
    const digest = `sha256:${"b".repeat(64)}`;
    for (const payload of [
      { ...base, projection: "nope" },
      { ...base, focus: "smartness" },
      { ...base, consent: "maybe" },
      { ...base, locale: "fr" },
      { ...base, committedOnly: "yes" },
      { ...base, workspaceOverlay: 1 },
      { ...base, untrackedScope: "select", expectedUntrackedInventory: digest },
      { ...base, expectedUntrackedInventory: digest },
      { ...base, untrackedScope: "select", expectedUntrackedInventory: digest, intendedUntracked: ["x", "x"] },
      { ...base, untrackedScope: "exclude", expectedUntrackedInventory: digest, intendedUntracked: ["x"] },
      { ...base, baseRef: "-x" },
      { ...base, baseRef: "refs/../evil" },
      { ...base, target: "-flag" },
      { ...base, extra: true },
    ]) {
      expect(() => buildReviewStartArgv(payload as never)).toThrow(ValidationError);
    }
  });

  test("review capture-result emits the staged input and optional flags", () => {
    const argv = buildReviewCaptureResultArgv({
      ...base,
      agent: "opencode",
      input: "/var/lib/broker/review-input/abc.input",
      lens: "Lens-TOKEN:./x",
      order: 3,
      target: "Target-TOKEN",
      lineage: "Lineage-TOKEN",
      expectedRevision: rev,
      repositoryContext: "Repo-Context!",
      subjectHash: `sha256:${"d".repeat(64)}`,
      materialize: true,
      preflight: true,
    });
    expect(argv).toEqual([
      "gentle-ai", "review", "capture-result", "--cwd", projectRoot,
      "--agent", "opencode",
      "--input", "/var/lib/broker/review-input/abc.input",
      "--lens", "Lens-TOKEN:./x",
      "--order", "3",
      "--target", "Target-TOKEN",
      "--lineage", "Lineage-TOKEN",
      "--expected-revision", rev,
      "--repository-context", "Repo-Context!",
      "--subject-hash", `sha256:${"d".repeat(64)}`,
      "--materialize",
      "--preflight",
    ]);
    expect(buildReviewCaptureResultArgv({ ...base, input: "-" })).toEqual([
      "gentle-ai", "review", "capture-result", "--cwd", projectRoot, "--input", "-",
    ]);
    expect(buildReviewCaptureResultArgv({ ...base, order: 0 }).slice(-2)).toEqual(["--order", "0"]);
    for (const payload of [
      { ...base, order: -1 },
      { ...base, order: 33 },
      { ...base, input: "relative.md" },
      { ...base, subjectHash: "deadbeef" },
      { ...base, materialize: "yes" },
      { ...base, extra: 1 },
    ]) {
      expect(() => buildReviewCaptureResultArgv(payload as never)).toThrow(ValidationError);
    }
  });

  test("review capture-unachievable and correction-plan emit exact argv with bounds", () => {
    expect(buildReviewCaptureUnachievableArgv({
      ...base,
      target: "T",
      lineage: "L",
      expectedRevision: rev,
      repositoryContext: "R",
      requestHash: rev,
      reason: "r",
      detail: "d",
      withdraw: true,
    })).toEqual([
      "gentle-ai", "review", "capture-unachievable", "--cwd", projectRoot,
      "--target", "T",
      "--lineage", "L",
      "--expected-revision", rev,
      "--repository-context", "R",
      "--request-hash", rev,
      "--reason", "r",
      "--detail", "d",
      "--withdraw",
    ]);
    expect(() => buildReviewCaptureUnachievableArgv({ ...base, reason: "x".repeat(4097) })).toThrow(ValidationError);
    expect(() => buildReviewCaptureUnachievableArgv({ ...base, detail: "x".repeat(16385) })).toThrow(ValidationError);
    expect(() => buildReviewCaptureUnachievableArgv({ ...base, reason: "-flag" })).toThrow(ValidationError);
    expect(buildReviewCaptureCorrectionPlanArgv({
      ...base,
      target: "T",
      lineage: "L",
      expectedRevision: rev,
      repositoryContext: "R",
      requestHash: rev,
      correctionLines: 7,
    })).toEqual([
      "gentle-ai", "review", "capture-correction-plan", "--cwd", projectRoot,
      "--target", "T",
      "--lineage", "L",
      "--expected-revision", rev,
      "--repository-context", "R",
      "--request-hash", rev,
      "--correction-lines", "7",
    ]);
    expect(() => buildReviewCaptureCorrectionPlanArgv({ ...base, correctionLines: 0 })).toThrow(ValidationError);
  });

  test("review acknowledge-approved is flag-less and runs in the canonical root", async () => {
    const calls: Array<{ argv: string[]; cwd: string | undefined }> = [];
    const spawn: SpawnFn = async (argv, options) => {
      calls.push({ argv: [...argv], cwd: options.cwd });
      return { status: 0, stdout: JSON.stringify({ approved: true }), stderr: "", timedOut: false };
    };
    await makeExecutor(spawn).reviewAcknowledgeApproved({ projectDir: configuredProjectRoot });
    expect(calls).toEqual([
      { argv: ["gentle-ai", "review", "acknowledge-approved"], cwd: projectRoot },
    ]);
    expect(() => buildReviewAcknowledgeApprovedArgv({ binary: "gentle-ai", extra: 1 } as never)).toThrow(ValidationError);
  });

  test("review refuter and validation emit materialize/execute only when requested", () => {
    expect(buildReviewCaptureRefuterArgv({
      ...base,
      agent: "opencode",
      target: "T",
      lineage: "L",
      expectedRevision: rev,
      repositoryContext: "R",
      materialize: true,
    })).toEqual([
      "gentle-ai", "review", "capture-refuter", "--cwd", projectRoot,
      "--agent", "opencode",
      "--target", "T",
      "--lineage", "L",
      "--expected-revision", rev,
      "--repository-context", "R",
      "--materialize",
    ]);
    expect(buildReviewCaptureValidationArgv({
      ...base,
      target: "T",
      expectedRevision: rev,
      requestHash: rev,
      execute: true,
    })).toEqual([
      "gentle-ai", "review", "capture-validation", "--cwd", projectRoot,
      "--target", "T",
      "--expected-revision", rev,
      "--request-hash", rev,
      "--execute",
    ]);
    for (const payload of [
      { ...base, execute: "yes" },
      { ...base, materialize: "no" },
      { ...base, extra: true },
    ]) {
      expect(() => buildReviewCaptureRefuterArgv(payload as never)).toThrow(ValidationError);
    }
  });

  test("review validate emits the exact gate and release tokens", () => {
    expect(buildReviewValidateArgv({
      ...base,
      contract: "Contract-TOKEN",
      gate: "pre-pr",
      baseRef: "main",
      lineage: "L",
      policy: "P",
      prePrCiAttestation: "Attest-TOKEN",
      releaseConfiguration: "RC",
      releaseEvidenceFreshness: "Fresh",
      releaseGenerated: "Gen",
      releaseProvenance: "Prov",
      releasePublicationBoundary: "Bound",
    })).toEqual([
      "gentle-ai", "review", "validate", "--cwd", projectRoot,
      "--contract", "Contract-TOKEN",
      "--gate", "pre-pr",
      "--base-ref", "main",
      "--lineage", "L",
      "--policy", "P",
      "--pre-pr-ci-attestation", "Attest-TOKEN",
      "--release-configuration", "RC",
      "--release-evidence-freshness", "Fresh",
      "--release-generated", "Gen",
      "--release-provenance", "Prov",
      "--release-publication-boundary", "Bound",
    ]);
    expect(() => buildReviewValidateArgv({ ...base, gate: "whenever" } as never)).toThrow(ValidationError);
  });

  test("review recover preserves maintainerAuthorization bytes and the opaque focus", () => {
    const auth = '{\n  "approve": true,\n  "note": "line1\\nline2"\n}';
    const digest = `sha256:${"e".repeat(64)}`;
    const argv = buildReviewRecoverArgv({
      ...base,
      actor: "gentle-orchestrator",
      disposition: "scope_changed",
      expectedPredecessorRevision: rev,
      predecessorLineage: "Pred",
      successorLineage: "Succ",
      reason: "why",
      maintainerAuthorization: auth,
      baseRef: "main",
      committedOnly: true,
      workspaceOverlay: true,
      releaseScope: true,
      projection: "staged",
      untrackedScope: "exclude",
      expectedUntrackedInventory: digest,
      focus: "Opaque-Focus:1",
      policy: "Pol",
    });
    expect(argv).toEqual([
      "gentle-ai", "review", "recover", "--cwd", projectRoot,
      "--actor", "gentle-orchestrator",
      "--disposition", "scope_changed",
      "--expected-predecessor-revision", rev,
      "--predecessor-lineage", "Pred",
      "--successor-lineage", "Succ",
      "--reason", "why",
      "--maintainer-authorization", auth,
      "--base-ref", "main",
      "--committed-only",
      "--workspace-overlay",
      "--release-scope",
      "--projection", "staged",
      "--untracked-scope", "exclude",
      "--expected-untracked-inventory", digest,
      "--focus", "Opaque-Focus:1",
      "--policy", "Pol",
    ]);
    expect(argv[argv.indexOf("--maintainer-authorization") + 1]).toBe(auth);
    for (const payload of [
      { ...base, disposition: "nope" },
      { ...base, maintainerAuthorization: "{\r\n}" },
      { ...base, maintainerAuthorization: "not json" },
      { ...base, maintainerAuthorization: "{}" + " ".repeat(65536) },
      { ...base, focus: "f".repeat(129) },
      { ...base, expectedPredecessorRevision: "nope" },
    ]) {
      expect(() => buildReviewRecoverArgv(payload as never)).toThrow(ValidationError);
    }
  });

describe("host-side review capture-result staging", () => {
  function tempDirs() {
    return {
      root: mkdtempSync(join(tmpdir(), "review-proj-")),
      inputDir: mkdtempSync(join(tmpdir(), "review-in-")),
    };
  }

  test("stages a private 0600 snapshot and deletes it after the run", async () => {
    const { root, inputDir } = tempDirs();
    try {
      writeFileSync(join(root, "result.json"), '{"reviewer":"x"}');
      let observed: { path: string; mode: number; content: string } | null = null;
      const spawn: SpawnFn = async (argv) => {
        const staged = argv[argv.indexOf("--input") + 1]!;
        const stat = statSync(staged);
        observed = { path: staged, mode: stat.mode & 0o777, content: readFileSync(staged, "utf8") };
        return { status: 0, stdout: JSON.stringify({ ok: true }), stderr: "", timedOut: false };
      };
      const executor = new SddRuntimeExecutor({
        binary: "gentle-ai",
        projects: [{ id: "tmp", path: root }],
        spawn,
        reviewInputDir: inputDir,
      });
      await executor.reviewCaptureResult({ projectDir: root, input: "result.json" });
      expect(observed).not.toBeNull();
      expect(observed!.path.startsWith(inputDir)).toBe(true);
      expect(observed!.mode).toBe(0o600);
      expect(observed!.content).toBe('{"reviewer":"x"}');
      expect(existsSync(observed!.path)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(inputDir, { recursive: true, force: true });
    }
  });

  test("forwards the literal '-' without staging and leaves the input dir empty", async () => {
    const { root, inputDir } = tempDirs();
    try {
      writeFileSync(join(root, "result.json"), "x");
      let staged = "";
      const spawn: SpawnFn = async (argv) => {
        staged = argv[argv.indexOf("--input") + 1]!;
        return { status: 0, stdout: JSON.stringify({ ok: true }), stderr: "", timedOut: false };
      };
      const executor = new SddRuntimeExecutor({
        binary: "gentle-ai",
        projects: [{ id: "tmp", path: root }],
        spawn,
        reviewInputDir: inputDir,
      });
      await executor.reviewCaptureResult({ projectDir: root, input: "-" });
      expect(staged).toBe("-");
      expect(readdirSync(inputDir)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(inputDir, { recursive: true, force: true });
    }
  });

  test("rejects absolute, escaping, oversized, and non-regular inputs before spawn", async () => {
    const { root, inputDir } = tempDirs();
    try {
      writeFileSync(join(root, "big.json"), "x".repeat(512 * 1024 + 1));
      let spawned = 0;
      const spawn: SpawnFn = async () => {
        spawned += 1;
        return { status: 0, stdout: JSON.stringify({ ok: true }), stderr: "", timedOut: false };
      };
      const executor = new SddRuntimeExecutor({
        binary: "gentle-ai",
        projects: [{ id: "tmp", path: root }],
        spawn,
        reviewInputDir: inputDir,
      });
      for (const input of ["/etc/passwd", "../escape.json", "big.json", "."]) {
        await expect(executor.reviewCaptureResult({ projectDir: root, input })).rejects.toThrow(
          ValidationError,
        );
      }
      expect(spawned).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(inputDir, { recursive: true, force: true });
    }
  });

  test("rejects an in-project symlink that resolves outside the approved root", async () => {
    const { root, inputDir } = tempDirs();
    const outsideDir = mkdtempSync(join(tmpdir(), "review-outside-"));
    try {
      writeFileSync(join(outsideDir, "secret.json"), '{"secret":true}');
      try {
        symlinkSync(join(outsideDir, "secret.json"), join(root, "link.json"));
      } catch {
        return; // symlinks unsupported on this filesystem
      }
      let spawned = 0;
      const spawn: SpawnFn = async () => {
        spawned += 1;
        return { status: 0, stdout: JSON.stringify({ ok: true }), stderr: "", timedOut: false };
      };
      const executor = new SddRuntimeExecutor({
        binary: "gentle-ai",
        projects: [{ id: "tmp", path: root }],
        spawn,
        reviewInputDir: inputDir,
      });
      await expect(
        executor.reviewCaptureResult({ projectDir: root, input: "link.json" }),
      ).rejects.toThrow(ValidationError);
      expect(spawned).toBe(0);
      expect(readdirSync(inputDir)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
      rmSync(inputDir, { recursive: true, force: true });
    }
  });

  test("cleanupStaleReviewInputs removes leftover snapshots", () => {
    const inputDir = mkdtempSync(join(tmpdir(), "review-stale-"));
    try {
      const stale = join(inputDir, "stale.input");
      writeFileSync(stale, "x");
      cleanupStaleReviewInputs(inputDir);
      expect(existsSync(stale)).toBe(false);
    } finally {
      rmSync(inputDir, { recursive: true, force: true });
    }
  });

  test("review mutations preserve stdout verbatim, redact stderr, surface timeouts, and enforce the root", async () => {
    const redactSpawn: SpawnFn = async () => ({
      status: 0,
      stdout: JSON.stringify({ ok: true, note: "token=abc123" }),
      stderr: "secret=hunter2",
      timedOut: false,
    });
    const result = await makeExecutor(redactSpawn).reviewValidate({ projectDir: configuredProjectRoot });
    expect(result.json).toEqual({ ok: true, note: "token=abc123" });
    expect(result.stderr).toBe("secret=REDACTED");

    const timeoutSpawn: SpawnFn = async () => ({ status: null, stdout: "", stderr: "", timedOut: true });
    await expect(
      makeExecutor(timeoutSpawn).reviewValidate({ projectDir: configuredProjectRoot }),
    ).rejects.toThrow(/timed out/);
    await expect(
      makeExecutor(redactSpawn).reviewValidate({ projectDir: "/etc" }),
    ).rejects.toThrow(ValidationError);
  });

  test("review stdout JSON with a provider token is returned byte-for-byte", async () => {
    const stdout = JSON.stringify({ next_transition: { lineage: "authorization=abc123" } });
    const verbatimSpawn: SpawnFn = async () => ({
      status: 0,
      stdout,
      stderr: "",
      timedOut: false,
    });
    const result = await makeExecutor(verbatimSpawn).reviewValidate({
      projectDir: configuredProjectRoot,
    });
    expect(JSON.stringify(result.json)).toBe(stdout);
    expect(result.json).toEqual({ next_transition: { lineage: "authorization=abc123" } });
  });

  test("review stderr is still redacted and capped at 512 KiB", async () => {
    const redactSpawn: SpawnFn = async () => ({
      status: 0,
      stdout: JSON.stringify({ ok: true }),
      stderr: `secret=hunter2\n${"y".repeat(600_000)}`,
      timedOut: false,
    });
    const result = await makeExecutor(redactSpawn).reviewValidate({
      projectDir: configuredProjectRoot,
    });
    expect(result.json).toEqual({ ok: true });
    expect(result.stderr).toContain("secret=REDACTED");
    expect(Buffer.byteLength(result.stderr, "utf8")).toBe(512 * 1024);
  });
});
});
});

describe("host-side review lens-context and inline capture", () => {
  const rev = `sha256:${revision}`;
  const lensBase = { binary: "gentle-ai", projectRoot };

  test("review lens-context builds the exact fixed argv with verbatim tokens", () => {
    const argv = buildReviewLensContextArgv({
      ...lensBase,
      repositoryContext: "Repo-Context!:/x",
      lineage: "Lineage-TOKEN:abc",
      target: "Target-TOKEN./y",
      expectedRevision: rev,
      lens: "review-risk",
    });
    expect(argv).toEqual([
      "gentle-ai", "review", "lens-context", "--cwd", projectRoot,
      "--repository-context", "Repo-Context!:/x",
      "--lineage", "Lineage-TOKEN:abc",
      "--target", "Target-TOKEN./y",
      "--expected-revision", rev,
      "--lens", "review-risk",
    ]);
    expect(argv[argv.indexOf("--repository-context") + 1]).toBe("Repo-Context!:/x");
  });

  test("review lens-context rejects bad lens, revision, flag tokens, and extra keys", () => {
    for (const payload of [
      { ...lensBase, repositoryContext: "R", lineage: "L", target: "T", expectedRevision: rev, lens: "review-nonsense" },
      { ...lensBase, repositoryContext: "R", lineage: "L", target: "T", expectedRevision: "sha256:short", lens: "review-risk" },
      { ...lensBase, repositoryContext: "-flag", lineage: "L", target: "T", expectedRevision: rev, lens: "review-risk" },
      { ...lensBase, repositoryContext: "R", lineage: "L", target: "T", expectedRevision: rev, lens: "review-risk", extra: 1 },
    ]) {
      expect(() => buildReviewLensContextArgv(payload as never)).toThrow(ValidationError);
    }
    for (const lens of ["review-risk", "review-resilience", "review-readability", "review-reliability"]) {
      expect(() =>
        buildReviewLensContextArgv({ ...lensBase, repositoryContext: "R", lineage: "L", target: "T", expectedRevision: rev, lens: lens as never }),
      ).not.toThrow();
    }
  });

  test("review lens-context executor returns the plain-text block without JSON parsing", async () => {
    const block = "repository binding: repo\nGENTLE_AI_REVIEW_CONTEXT\nline A\nline B\nEND\n";
    const calls: Array<{ argv: string[]; cwd: string | undefined }> = [];
    const spawn: SpawnFn = async (argv, options) => {
      calls.push({ argv: [...argv], cwd: options.cwd });
      return { status: 0, stdout: block, stderr: "", timedOut: false };
    };
    const result = await makeExecutor(spawn).reviewLensContext({
      projectDir: configuredProjectRoot,
      repositoryContext: "Repo-Context!:/x",
      lineage: "Lineage-TOKEN:abc",
      target: "Target-TOKEN./y",
      expectedRevision: rev,
      lens: "review-resilience",
    });
    expect(result.text).toBe(block);
    expect(result.json).toBeUndefined();
    expect(calls).toEqual([
      {
        argv: [
          "gentle-ai", "review", "lens-context", "--cwd", projectRoot,
          "--repository-context", "Repo-Context!:/x",
          "--lineage", "Lineage-TOKEN:abc",
          "--target", "Target-TOKEN./y",
          "--expected-revision", rev,
          "--lens", "review-resilience",
        ],
        cwd: projectRoot,
      },
    ]);
  });

  test("inline inputJson stages private bytes, supports LF, and deletes them after the run", async () => {
    const root = mkdtempSync(join(tmpdir(), "review-json-proj-"));
    const inputDir = mkdtempSync(join(tmpdir(), "review-json-in-"));
    try {
      const body = '{\n  "reviewer": "x",\n  "verdict": "pass"\n}';
      let observed: { path: string; mode: number; content: string } | null = null;
      const spawn: SpawnFn = async (argv) => {
        const staged = argv[argv.indexOf("--input") + 1]!;
        const stat = statSync(staged);
        observed = { path: staged, mode: stat.mode & 0o777, content: readFileSync(staged, "utf8") };
        return { status: 0, stdout: JSON.stringify({ ok: true }), stderr: "", timedOut: false };
      };
      const executor = new SddRuntimeExecutor({
        binary: "gentle-ai",
        projects: [{ id: "tmp", path: root }],
        spawn,
        reviewInputDir: inputDir,
      });
      await executor.reviewCaptureResult({ projectDir: root, inputJson: body });
      expect(observed).not.toBeNull();
      expect(observed!.path.startsWith(inputDir)).toBe(true);
      expect(observed!.mode).toBe(0o600);
      expect(observed!.content).toBe(body);
      expect(existsSync(observed!.path)).toBe(false);
      expect(readdirSync(inputDir)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(inputDir, { recursive: true, force: true });
    }
  });

  test("inline inputJson rejects both-present, empty, non-JSON, NUL, and oversized bodies before spawn", async () => {
    const root = mkdtempSync(join(tmpdir(), "review-json-proj-"));
    const inputDir = mkdtempSync(join(tmpdir(), "review-json-in-"));
    try {
      writeFileSync(join(root, "result.json"), "{}");
      let spawned = 0;
      const spawn: SpawnFn = async () => {
        spawned += 1;
        return { status: 0, stdout: JSON.stringify({ ok: true }), stderr: "", timedOut: false };
      };
      const executor = new SddRuntimeExecutor({
        binary: "gentle-ai",
        projects: [{ id: "tmp", path: root }],
        spawn,
        reviewInputDir: inputDir,
      });
      const bad: Array<Record<string, unknown>> = [
        { projectDir: root, input: "result.json", inputJson: "{}" },
        { projectDir: root, inputJson: "" },
        { projectDir: root, inputJson: "not json" },
        { projectDir: root, inputJson: '{a:' + String.fromCharCode(0) + '}' },
        { projectDir: root, inputJson: '"' + "a".repeat(512 * 1024) + '"' },
      ];
      for (const payload of bad) {
        await expect(executor.reviewCaptureResult(payload)).rejects.toThrow(ValidationError);
      }
      expect(spawned).toBe(0);
      expect(readdirSync(inputDir)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(inputDir, { recursive: true, force: true });
    }
  });
});
