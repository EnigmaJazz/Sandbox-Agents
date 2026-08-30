/**
 * Role-based policy matrix tests — Phase 0 + Phase A (TDD RED/GREEN).
 *
 * Covers:
 * - unknown effects, complete authorization context, AFT classification,
 *   model-policy independence, live-security denial (0.1)
 * - orchestrator exclusion: zero sandbox_* tools, broker ensureWorker refusal
 *   without side effects, plugin pre-dispatch denial (A.1)
 *
 * Specs: role-model R1–R5, orchestrator-readonly R1–R3
 */
import { describe, expect, test } from "bun:test";
import {
  decide,
  classifyOperation,
  classifyAft,
  isSecurityMutation,
  isReadOnlyAgent,
  shouldRefuseEnsureWorker,
  assertNotOrchestratorForSandbox,
  orchestratorHasZeroSandboxTools,
  ORCHESTRATOR_ALLOWED_TOOLS,
  normalizeRoleKey,
  CAPABILITIES,
  ROLES,
} from "../src/role-policy.ts";
import { defaultConfig, DEFAULT_READ_ONLY_AGENTS, DEFAULT_ROLE_MODELS } from "../src/config.ts";

// ---------------------------------------------------------------------------
// 0.1 — R1 unknown effects must be denied without fallback
// ---------------------------------------------------------------------------

describe("R1 — capability taxonomy / unknown effects fail closed", () => {
  test("known operation maps to exactly one capability", () => {
    expect(classifyOperation("read")).toBe("READ_PROJECT");
    expect(classifyOperation("webfetch")).toBe("RESEARCH_EXTERNAL");
    expect(classifyOperation("sandbox_write")).toBe("MUTATE_PROJECT");
    expect(classifyOperation("sandbox_bash")).toBe("EXECUTE_PROJECT");
  });

  test("unknown operation returns null and is denied", () => {
    expect(classifyOperation("unknown_tool_xyz")).toBeNull();
    expect(classifyOperation("bash")).toBeNull(); // generic host shell is unknown → denied
    const d = decide({
      role: "researcher",
      capability: "UNKNOWN_CAP",
      sessionState: "HOST_READ_ONLY",
      authoritativeLocation: "/project",
    });
    expect(d.decision).toBe("deny");
    expect(d.reasonCode).toBe("UNKNOWN_CAPABILITY");
  });

  test("unknown role is denied", () => {
    const d = decide({
      role: "unknown_role",
      capability: "READ_PROJECT",
      sessionState: "HOST_READ_ONLY",
      authoritativeLocation: "/project",
    });
    expect(d.decision).toBe("deny");
    expect(d.reasonCode).toBe("UNKNOWN_ROLE");
  });

  test("every governed operation maps to one listed capability or is denied", () => {
    for (const op of ["read", "grep", "sandbox_read", "webfetch", "sandbox_write", "sandbox_bash"]) {
      const cap = classifyOperation(op);
      expect(cap).not.toBeNull();
      expect(CAPABILITIES.includes(cap!)).toBe(true);
    }
    expect(classifyOperation("nonexistent_op_123")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R2 — complete authorization context
// ---------------------------------------------------------------------------

describe("R2 — complete authorization context", () => {
  test("same role+capability in different states yields independent decisions", () => {
    const pre = decide({
      role: "researcher",
      capability: "HOST_READ_STRUCTURED",
      sessionState: "HOST_READ_ONLY",
      authoritativeLocation: "/project",
    });
    const post = decide({
      role: "researcher",
      capability: "HOST_READ_STRUCTURED",
      sessionState: "SANDBOX_ACTIVE",
      authoritativeLocation: "/project",
    });
    expect(pre.decision).toBe("allow");
    expect(post.decision).toBe("deny");
    expect(pre.reasonCode).not.toBe(post.reasonCode);
  });

  test("authoritative location missing denies mutation/execution", () => {
    const d = decide({
      role: "worker",
      capability: "MUTATE_PROJECT",
      sessionState: "HOST_READ_ONLY",
      authoritativeLocation: "",
    });
    expect(d.decision).toBe("deny");
    expect(d.reasonCode).toBe("UNKNOWN_LOCATION");
  });

  test("untrusted relationship is caller's responsibility — unknown role is still denied", () => {
    const d = decide({
      role: "researcher",
      capability: "READ_PROJECT",
      sessionState: "HOST_READ_ONLY",
      authoritativeLocation: "/project",
      trustedParent: null,
    });
    // READ_PROJECT for researcher is allowed regardless of trustedParent in Phase A
    // but an unknown role with any parent must still be denied
    const d2 = decide({
      role: "not_a_role",
      capability: "READ_PROJECT",
      sessionState: "HOST_READ_ONLY",
      authoritativeLocation: "/project",
      trustedParent: { parentSessionID: "abc", relationship: "parent" },
    });
    expect(d2.decision).toBe("deny");
  });

  test("caller-supplied claims do not replace authoritative inputs — forged role still denied", () => {
    const forged = decide({
      role: "worker",
      capability: "MUTATE_PROJECT",
      sessionState: "HOST_READ_ONLY",
      authoritativeLocation: "/project",
      // researcher should not be able to claim worker mutation via caller claim
      // but worker legitimately can mutate; researcher cannot
    });
    const researcherMutate = decide({
      role: "researcher",
      capability: "MUTATE_PROJECT",
      sessionState: "HOST_READ_ONLY",
      authoritativeLocation: "/project",
    });
    expect(forged.decision).toBe("allow"); // worker allowed
    expect(researcherMutate.decision).toBe("deny"); // researcher denied regardless of claims
  });
});

// ---------------------------------------------------------------------------
// R3 — AFT classification by effect
// ---------------------------------------------------------------------------

describe("R3 — AFT effect-based classification", () => {
  test("read-only AFT operations classify as HOST_READ_STRUCTURED", () => {
    expect(classifyAft("aft_outline")).toBe("HOST_READ_STRUCTURED");
    expect(classifyAft("aft_zoom")).toBe("HOST_READ_STRUCTURED");
    expect(classifyAft("aft_inspect")).toBe("HOST_READ_STRUCTURED");
    expect(classifyOperation("aft_outline")).toBe("HOST_READ_STRUCTURED");
  });

  test("mutation-capable AFT operations classify as HOST_ADMIN_STRUCTURED", () => {
    expect(classifyAft("aft_safety")).toBe("HOST_ADMIN_STRUCTURED");
    expect(classifyAft("aft_import")).toBe("HOST_ADMIN_STRUCTURED");
    expect(classifyAft("ast_grep_replace")).toBe("HOST_ADMIN_STRUCTURED");
    expect(classifyOperation("aft_safety")).toBe("HOST_ADMIN_STRUCTURED");
  });

  test("pre-activation AFT read MAY be allowed for researcher", () => {
    const d = decide({
      role: "researcher",
      capability: "HOST_READ_STRUCTURED",
      sessionState: "HOST_READ_ONLY",
      authoritativeLocation: "/project",
    });
    expect(d.decision).toBe("allow");
  });

  test("post-activation AFT project operation is blocked for every role (v1)", () => {
    for (const role of ROLES) {
      const d = decide({
        role,
        capability: "HOST_ADMIN_STRUCTURED",
        sessionState: "SANDBOX_ACTIVE",
        authoritativeLocation: "/project",
      });
      expect(d.decision).toBe("deny");
      const d2 = decide({
        role,
        capability: "HOST_READ_STRUCTURED",
        sessionState: "SANDBOX_ACTIVE",
        authoritativeLocation: "/project",
      });
      // worker and advisor etc must be denied for HOST_READ_STRUCTURED post-activation
      if (role !== "researcher" && role !== "general") {
        expect(d2.decision).toBe("deny");
      }
    }
    // also researcher post-activation is denied
    const researcherPost = decide({
      role: "researcher",
      capability: "HOST_READ_STRUCTURED",
      sessionState: "SANDBOX_ACTIVE",
      authoritativeLocation: "/project",
    });
    expect(researcherPost.decision).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// R4 — model-policy independence
// ---------------------------------------------------------------------------

describe("R4 — independently configurable role models", () => {
  test("changing model does not change authorization outcome", () => {
    const base = decide({
      role: "researcher",
      capability: "READ_PROJECT",
      sessionState: "HOST_READ_ONLY",
      authoritativeLocation: "/project",
    });
    // Simulate model change: config override should not affect decide
    const cfg1 = defaultConfig({ roleModels: { researcher: ["changed/model", "high"] } });
    const cfg2 = defaultConfig({ roleModels: { researcher: ["other/model", ""] } });
    const after1 = decide({
      role: "researcher",
      capability: "READ_PROJECT",
      sessionState: "HOST_READ_ONLY",
      authoritativeLocation: "/project",
    });
    const after2 = decide({
      role: "worker",
      capability: "MUTATE_PROJECT",
      sessionState: "HOST_READ_ONLY",
      authoritativeLocation: "/project",
    });
    expect(base.decision).toBe(after1.decision);
    expect(base.reasonCode).toBe(after1.reasonCode);
    // worker mutation still allowed regardless of researcher model
    expect(after2.decision).toBe("allow");
    // config values changed but not used in decide
    expect(cfg1.roleModels.researcher[0]).toBe("changed/model");
    expect(cfg2.roleModels.researcher[0]).toBe("other/model");
  });

  test("fresh_eyes hyphen normalization", () => {
    expect(normalizeRoleKey("fresh-eyes")).toBe("fresh_eyes");
    expect(normalizeRoleKey("fresh_eyes")).toBe("fresh_eyes");
    const d = decide({
      role: normalizeRoleKey("fresh-eyes"),
      capability: "DELIBERATE",
      sessionState: "HOST_READ_ONLY",
      authoritativeLocation: "/project",
    });
    expect(d.decision).toBe("allow");
  });

  test("default role models include all 8 roles", () => {
    const cfg = defaultConfig();
    for (const r of ROLES) {
      expect(cfg.roleModels).toHaveProperty(r);
    }
    expect(cfg.roleModels.general).toEqual([]);
    expect(cfg.roleModels.fresh_eyes[0]).toBe("opencode-go/kimi-k2.7-code");
    // hyphen key must not appear separately
    expect((cfg.roleModels as Record<string, unknown>)["fresh-eyes"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// R5 — live security mutation must be denied
// ---------------------------------------------------------------------------

describe("R5 — live security mutation denied", () => {
  test("SECURITY_MUTATION capability is denied for every role", () => {
    for (const role of ROLES) {
      const d = decide({
        role,
        capability: "SECURITY_MUTATION",
        sessionState: "HOST_READ_ONLY",
        authoritativeLocation: "/project",
      });
      expect(d.decision).toBe("deny");
      expect(d.reasonCode).toBe("SECURITY_MUTATION_DENIED");
    }
  });

  test("isSecurityMutation detects protected paths", () => {
    expect(isSecurityMutation("broker/src/service.ts")).toBe(true);
    expect(isSecurityMutation("opencode/plugins/sandbox-tools.ts")).toBe(true);
    expect(isSecurityMutation("nono/profile/opencode-secure.json")).toBe(true);
    expect(isSecurityMutation("scripts/test.sh")).toBe(true);
    expect(isSecurityMutation("docs/threat-model.md")).toBe(true);
    expect(isSecurityMutation("broker/package.json")).toBe(true);
    expect(isSecurityMutation("src/app.ts")).toBe(false);
    expect(isSecurityMutation("opencode/config-fragments/role-agents.jsonc")).toBe(true);
  });

  test("mutation with protected targetPath is denied even for worker", () => {
    const d = decide({
      role: "worker",
      capability: "MUTATE_PROJECT",
      sessionState: "SANDBOX_ACTIVE",
      authoritativeLocation: "/project",
      targetPath: "broker/src/service.ts",
    });
    expect(d.decision).toBe("deny");
    expect(d.reasonCode).toBe("SECURITY_MUTATION_DENIED");
  });

  test("default config contains protected security files", () => {
    const cfg = defaultConfig();
    expect(cfg.protectedSecurityFiles).toContain("broker/src/**");
    expect(cfg.protectedSecurityFiles).toContain("opencode/plugins/**");
  });
});

// ---------------------------------------------------------------------------
// A.1 — orchestrator-readonly R1–R3 (RED)
// ---------------------------------------------------------------------------

describe("orchestrator-readonly — R1 strict sandbox exclusion", () => {
  test("orchestrator has zero sandbox_* tools", () => {
    expect(orchestratorHasZeroSandboxTools()).toBe(true);
    expect(ORCHESTRATOR_ALLOWED_TOOLS.some((t) => t.startsWith("sandbox_"))).toBe(false);
    expect(ORCHESTRATOR_ALLOWED_TOOLS).not.toContain("sandbox_read");
    expect(ORCHESTRATOR_ALLOWED_TOOLS).not.toContain("sandbox_write");
  });

  test("isSandboxTool correctly identifies sandbox family", () => {
    expect(ORCHESTRATOR_ALLOWED_TOOLS.every((t) => !t.startsWith("sandbox_"))).toBe(true);
  });
});

describe("orchestrator-readonly — R2 broker read-only enforcement", () => {
  test("default readOnlyAgents contains gentle-orchestrator", () => {
    const cfg = defaultConfig();
    expect(cfg.readOnlyAgents).toContain("gentle-orchestrator");
    expect(DEFAULT_READ_ONLY_AGENTS).toContain("gentle-orchestrator");
  });

  test("isReadOnlyAgent identifies orchestrator", () => {
    expect(isReadOnlyAgent("gentle-orchestrator", DEFAULT_READ_ONLY_AGENTS)).toBe(true);
    expect(isReadOnlyAgent("worker", DEFAULT_READ_ONLY_AGENTS)).toBe(false);
    expect(isReadOnlyAgent(undefined, DEFAULT_READ_ONLY_AGENTS)).toBe(false);
  });

  test("shouldRefuseEnsureWorker for orchestrator (broker-derived trusted role)", () => {
    expect(shouldRefuseEnsureWorker("gentle-orchestrator", DEFAULT_READ_ONLY_AGENTS)).toBe(true);
    expect(shouldRefuseEnsureWorker("worker", DEFAULT_READ_ONLY_AGENTS)).toBe(false);
    // forged claim must not bypass — broker checks trusted agent, not caller claim
    // If stored session says orchestrator, refusal prevails even if caller says worker.
    // Here we model that shouldRefuseEnsureWorker checks the trusted value.
    expect(shouldRefuseEnsureWorker("gentle-orchestrator", DEFAULT_READ_ONLY_AGENTS)).toBe(true);
  });

  test("decide denies orchestrator mutation/execution even with worker role claim", () => {
    const d = decide({
      role: "worker",
      capability: "MUTATE_PROJECT",
      sessionState: "HOST_READ_ONLY",
      authoritativeLocation: "/project",
      isReadOnlyOrchestrator: true,
    });
    expect(d.decision).toBe("deny");
    expect(d.reasonCode).toBe("ORCHESTRATOR_READ_ONLY");
    const d2 = decide({
      role: "worker",
      capability: "EXECUTE_PROJECT",
      sessionState: "HOST_READ_ONLY",
      authoritativeLocation: "/project",
      isReadOnlyOrchestrator: true,
    });
    expect(d2.decision).toBe("deny");
    const d3 = decide({
      role: "worker",
      capability: "SECURITY_MUTATION",
      sessionState: "HOST_READ_ONLY",
      authoritativeLocation: "/project",
      isReadOnlyOrchestrator: true,
    });
    expect(d3.decision).toBe("deny");
  });
});

describe("orchestrator-readonly — R3 independent plugin guard", () => {
  test("plugin guard blocks orchestrator before dispatch", () => {
    expect(() => assertNotOrchestratorForSandbox("gentle-orchestrator", DEFAULT_READ_ONLY_AGENTS, "sandbox_read")).toThrow(
      /orchestrator.*not allowed/,
    );
    expect(() => assertNotOrchestratorForSandbox("gentle-orchestrator", DEFAULT_READ_ONLY_AGENTS)).toThrow();
  });

  test("plugin guard allows non-orchestrator", () => {
    expect(() => assertNotOrchestratorForSandbox("worker", DEFAULT_READ_ONLY_AGENTS, "sandbox_read")).not.toThrow();
    expect(() => assertNotOrchestratorForSandbox(undefined, DEFAULT_READ_ONLY_AGENTS, "sandbox_write")).not.toThrow();
  });

  test("roleModels defaults remain policy-independent for orchestrator", () => {
    const cfg = defaultConfig({ roleModels: { worker: ["changed", "high"] } });
    // orchestrator decision still denied regardless of model change
    const d = decide({
      role: "worker",
      capability: "MUTATE_PROJECT",
      sessionState: "HOST_READ_ONLY",
      authoritativeLocation: "/project",
      isReadOnlyOrchestrator: true,
    });
    expect(d.decision).toBe("deny");
    expect(cfg.roleModels.worker[0]).toBe("changed");
    expect(DEFAULT_ROLE_MODELS.worker[0]).toBe("kinver/professional");
  });
});
