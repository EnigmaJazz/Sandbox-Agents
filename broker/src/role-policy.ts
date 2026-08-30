/**
 * Capability model — Phase 0 central policy (role-model spec R1–R5).
 *
 * Central capability taxonomy + fail-closed decision function.
 * The broker is authoritative for every stateful decision; the envelope
 * `agent` field is logging-only and never replaces broker-derived inputs.
 *
 * Security style (spec §30): explicit types, allowlists, no implicit fallback.
 */

export type SessionState =
  | "HOST_READ_ONLY"
  | "CREATING_SANDBOX"
  | "SANDBOX_ACTIVE"
  | "RESULT_READY"
  | "APPLY_PENDING"
  | "APPLIED"
  | "REJECTED"
  | "RETAINED"
  | "FAILED_CLOSED";

// ---------------------------------------------------------------------------
// Capability taxonomy (R1)
// ---------------------------------------------------------------------------

export type Capability =
  | "READ_PROJECT"
  | "RESEARCH_EXTERNAL"
  | "MUTATE_PROJECT"
  | "EXECUTE_PROJECT"
  | "HOST_READ_STRUCTURED"
  | "HOST_ADMIN_STRUCTURED"
  | "SECURITY_MUTATION"
  | "CONSULT"
  | "DELIBERATE";

export const CAPABILITIES: readonly Capability[] = [
  "READ_PROJECT",
  "RESEARCH_EXTERNAL",
  "MUTATE_PROJECT",
  "EXECUTE_PROJECT",
  "HOST_READ_STRUCTURED",
  "HOST_ADMIN_STRUCTURED",
  "SECURITY_MUTATION",
  "CONSULT",
  "DELIBERATE",
] as const;

export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && (CAPABILITIES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Role taxonomy (delegation-roles R5, role-model R4)
// ---------------------------------------------------------------------------

export type Role =
  | "general"
  | "researcher"
  | "worker"
  | "advisor"
  | "solver"
  | "challenger"
  | "judge"
  | "fresh_eyes";

export const ROLES: readonly Role[] = [
  "general",
  "researcher",
  "worker",
  "advisor",
  "solver",
  "challenger",
  "judge",
  "fresh_eyes",
] as const;

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/**
 * Normalize a role key that may use hyphen (fresh-eyes) to the canonical
 * underscore form (fresh_eyes) per spec R4. Unknown keys are returned as-is
 * and will be denied by the decision function (fail closed).
 */
export function normalizeRoleKey(raw: string): string {
  if (raw === "fresh-eyes") return "fresh_eyes";
  return raw;
}

// ---------------------------------------------------------------------------
// Operation → capability classification (R1, R3)
// ---------------------------------------------------------------------------

/**
 * Known operation → capability mapping. Every governed operation maps to
 * exactly one capability. Unknown or ambiguous effects MUST be denied
 * (return null, caller must deny without fallback).
 */
const OPERATION_CAPABILITY: Readonly<Record<string, Capability>> = {
  // READ_PROJECT
  read: "READ_PROJECT",
  grep: "READ_PROJECT",
  glob: "READ_PROJECT",
  codegraph_codegraph_explore: "READ_PROJECT",
  sandbox_read: "READ_PROJECT",
  sandbox_list: "READ_PROJECT",
  sandbox_grep: "READ_PROJECT",
  sandbox_diff: "READ_PROJECT",
  // RESEARCH_EXTERNAL
  webfetch: "RESEARCH_EXTERNAL",
  // MUTATE_PROJECT
  sandbox_write: "MUTATE_PROJECT",
  sandbox_edit: "MUTATE_PROJECT",
  sandbox_apply_patch: "MUTATE_PROJECT",
  sandbox_finish: "MUTATE_PROJECT",
  sandbox_apply: "MUTATE_PROJECT",
  sandbox_copy_in: "MUTATE_PROJECT",
  sandbox_copy_out: "MUTATE_PROJECT",
  sandbox_discard: "MUTATE_PROJECT",
  // EXECUTE_PROJECT
  sandbox_bash: "EXECUTE_PROJECT",
};

const READ_ONLY_AFT_OPERATIONS: readonly string[] = [
  "aft_outline",
  "aft_zoom",
  "aft_search",
  "aft_callgraph",
  "aft_inspect",
];

const MUTATION_AFT_OPERATIONS: readonly string[] = [
  "aft_safety",
  "aft_import",
  "ast_grep_replace",
];

/**
 * Classify a tool/operation by effect. Returns the capability or null for
 * unknown/ambiguous effects (caller must deny).
 */
export function classifyOperation(operation: string): Capability | null {
  const direct = OPERATION_CAPABILITY[operation];
  if (direct) return direct;
  if ((READ_ONLY_AFT_OPERATIONS as readonly string[]).includes(operation)) {
    return "HOST_READ_STRUCTURED";
  }
  if ((MUTATION_AFT_OPERATIONS as readonly string[]).includes(operation)) {
    return "HOST_ADMIN_STRUCTURED";
  }
  return null;
}

/**
 * AFT effect classification helper for tests: returns the AFT class or null
 * if the operation is not an AFT tool.
 */
export function classifyAft(operation: string): Capability | null {
  if ((READ_ONLY_AFT_OPERATIONS as readonly string[]).includes(operation)) return "HOST_READ_STRUCTURED";
  if ((MUTATION_AFT_OPERATIONS as readonly string[]).includes(operation)) return "HOST_ADMIN_STRUCTURED";
  return null;
}

// ---------------------------------------------------------------------------
// Orchestrator tool surface (orchestrator-readonly R1)
// ---------------------------------------------------------------------------

/**
 * Orchestrator's allowed tools — explicitly zero sandbox_*.
 * Mirrors the orchestrator config in opencode.json / plugin guard.
 */
export const ORCHESTRATOR_ALLOWED_TOOLS: readonly string[] = [
  "read",
  "grep",
  "glob",
  "codegraph_codegraph_explore",
  "question",
  "task",
] as const;

export function orchestratorHasZeroSandboxTools(): boolean {
  return !ORCHESTRATOR_ALLOWED_TOOLS.some((t) => t.startsWith("sandbox_"));
}

export function isSandboxTool(toolName: string): boolean {
  return toolName.startsWith("sandbox_");
}

// ---------------------------------------------------------------------------
// Live security mutation check (R5, S17)
// ---------------------------------------------------------------------------

const PROTECTED_SECURITY_PREFIXES: readonly string[] = [
  "broker/src/",
  "nono/profile/",
  "opencode/plugins/",
  "opencode/config-fragments/",
  "systemd-user/",
  "scripts/",
  "tests/security/",
  "tests/acceptance/",
  "docs/threat-model.md",
  "broker/package.json",
  "broker/tsconfig.json",
];

export function isSecurityMutation(targetPath: string | null | undefined): boolean {
  if (!targetPath || typeof targetPath !== "string") return false;
  const normalized = targetPath.replace(/^\.\//, "");
  for (const prefix of PROTECTED_SECURITY_PREFIXES) {
    if (prefix.endsWith("/")) {
      if (normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)) return true;
    } else {
      if (normalized === prefix || normalized.startsWith(prefix + "/")) return true;
    }
  }
  if (normalized === "docs/threat-model.md") return true;
  return false;
}

// ---------------------------------------------------------------------------
// Decision function (R2) — pure, fail-closed
// ---------------------------------------------------------------------------

export interface TrustedParent {
  parentSessionID: string;
  relationship: string;
}

export interface AuthorizationContext {
  role: string;
  capability: string;
  sessionState: SessionState;
  /** Canonical project location (e.g. projectID or absolute path). Empty means unknown. */
  authoritativeLocation: string;
  /** Broker-derived trusted parent; null/undefined means no proven relationship. */
  trustedParent?: TrustedParent | null;
  /** Whether the session is via a read-only orchestrator agent (from readOnlyAgents). */
  isReadOnlyOrchestrator?: boolean;
  /** Optional target path for SECURITY_MUTATION checks. */
  targetPath?: string;
}

export interface DecisionResult {
  decision: "allow" | "deny";
  reasonCode: string;
}

/**
 * Role × capability matrix.
 */
const ROLE_CAPABILITY_MATRIX: Readonly<Record<Role, Readonly<Record<Capability, boolean>>>> = {
  general: {
    READ_PROJECT: true,
    RESEARCH_EXTERNAL: false,
    MUTATE_PROJECT: false,
    EXECUTE_PROJECT: false,
    HOST_READ_STRUCTURED: true,
    HOST_ADMIN_STRUCTURED: false,
    SECURITY_MUTATION: false,
    CONSULT: true,
    DELIBERATE: true,
  },
  researcher: {
    READ_PROJECT: true,
    RESEARCH_EXTERNAL: true,
    MUTATE_PROJECT: false,
    EXECUTE_PROJECT: false,
    HOST_READ_STRUCTURED: true,
    HOST_ADMIN_STRUCTURED: false,
    SECURITY_MUTATION: false,
    CONSULT: true,
    DELIBERATE: true,
  },
  worker: {
    READ_PROJECT: true,
    RESEARCH_EXTERNAL: false,
    MUTATE_PROJECT: true,
    EXECUTE_PROJECT: true,
    HOST_READ_STRUCTURED: false,
    HOST_ADMIN_STRUCTURED: false,
    SECURITY_MUTATION: false,
    CONSULT: true,
    DELIBERATE: true,
  },
  advisor: {
    READ_PROJECT: false,
    RESEARCH_EXTERNAL: true,
    MUTATE_PROJECT: false,
    EXECUTE_PROJECT: false,
    HOST_READ_STRUCTURED: false,
    HOST_ADMIN_STRUCTURED: false,
    SECURITY_MUTATION: false,
    CONSULT: true,
    DELIBERATE: false,
  },
  solver: {
    READ_PROJECT: false,
    RESEARCH_EXTERNAL: false,
    MUTATE_PROJECT: false,
    EXECUTE_PROJECT: false,
    HOST_READ_STRUCTURED: false,
    HOST_ADMIN_STRUCTURED: false,
    SECURITY_MUTATION: false,
    CONSULT: false,
    DELIBERATE: true,
  },
  challenger: {
    READ_PROJECT: false,
    RESEARCH_EXTERNAL: false,
    MUTATE_PROJECT: false,
    EXECUTE_PROJECT: false,
    HOST_READ_STRUCTURED: false,
    HOST_ADMIN_STRUCTURED: false,
    SECURITY_MUTATION: false,
    CONSULT: false,
    DELIBERATE: true,
  },
  judge: {
    READ_PROJECT: false,
    RESEARCH_EXTERNAL: false,
    MUTATE_PROJECT: false,
    EXECUTE_PROJECT: false,
    HOST_READ_STRUCTURED: false,
    HOST_ADMIN_STRUCTURED: false,
    SECURITY_MUTATION: false,
    CONSULT: false,
    DELIBERATE: true,
  },
  fresh_eyes: {
    READ_PROJECT: false,
    RESEARCH_EXTERNAL: false,
    MUTATE_PROJECT: false,
    EXECUTE_PROJECT: false,
    HOST_READ_STRUCTURED: false,
    HOST_ADMIN_STRUCTURED: false,
    SECURITY_MUTATION: false,
    CONSULT: false,
    DELIBERATE: true,
  },
};

/**
 * Fail-closed decision function.
 */
export function decide(ctx: AuthorizationContext): DecisionResult {
  if (ctx.isReadOnlyOrchestrator) {
    const cap = ctx.capability;
    if (cap === "MUTATE_PROJECT" || cap === "EXECUTE_PROJECT" || cap === "SECURITY_MUTATION" || cap === "HOST_ADMIN_STRUCTURED") {
      return { decision: "deny", reasonCode: "ORCHESTRATOR_READ_ONLY" };
    }
  }

  if (!isRole(ctx.role)) {
    return { decision: "deny", reasonCode: "UNKNOWN_ROLE" };
  }
  const role = ctx.role as Role;

  if (!isCapability(ctx.capability)) {
    return { decision: "deny", reasonCode: "UNKNOWN_CAPABILITY" };
  }
  const capability = ctx.capability as Capability;

  if (capability === "SECURITY_MUTATION") {
    return { decision: "deny", reasonCode: "SECURITY_MUTATION_DENIED" };
  }
  if (ctx.targetPath && isSecurityMutation(ctx.targetPath) && (capability === "MUTATE_PROJECT" || capability === "EXECUTE_PROJECT")) {
    return { decision: "deny", reasonCode: "SECURITY_MUTATION_DENIED" };
  }

  if (capability === "HOST_ADMIN_STRUCTURED") {
    return { decision: "deny", reasonCode: "HOST_ADMIN_DENIED" };
  }

  if (!ctx.authoritativeLocation || ctx.authoritativeLocation.length === 0) {
    if (capability === "MUTATE_PROJECT" || capability === "EXECUTE_PROJECT") {
      return { decision: "deny", reasonCode: "UNKNOWN_LOCATION" };
    }
  }

  if (capability === "HOST_READ_STRUCTURED") {
    const preActivationStates: SessionState[] = ["HOST_READ_ONLY"];
    if (role === "researcher" || role === "general") {
      if (preActivationStates.includes(ctx.sessionState)) {
        return { decision: "allow", reasonCode: "PRE_ACTIVATION_AFT_READ_ALLOWED" };
      }
      return { decision: "deny", reasonCode: "POST_ACTIVATION_AFT_DENIED" };
    }
    return { decision: "deny", reasonCode: "ROLE_DENIED_FOR_AFT_READ" };
  }

  const allowed = ROLE_CAPABILITY_MATRIX[role][capability];
  if (!allowed) {
    return { decision: "deny", reasonCode: "ROLE_CAPABILITY_DENIED" };
  }

  return { decision: "allow", reasonCode: "ALLOWED" };
}

/**
 * Helper for orchestrator sandbox exclusion: returns true when the agent is
 * listed in the broker readOnlyAgents allowlist.
 */
export function isReadOnlyAgent(agent: string | undefined, readOnlyAgents: readonly string[]): boolean {
  if (!agent) return false;
  return readOnlyAgents.includes(agent);
}

/**
 * Broker helper: whether ensureWorker must be refused for this agent.
 * Uses the trusted agent identity (broker-derived), never caller-supplied claims.
 */
export function shouldRefuseEnsureWorker(trustedAgent: string | undefined, readOnlyAgents: readonly string[]): boolean {
  return isReadOnlyAgent(trustedAgent, readOnlyAgents);
}

/**
 * Plugin guard: throws when an orchestrator attempts a sandbox operation before dispatch.
 */
export function assertNotOrchestratorForSandbox(
  agent: string | undefined,
  readOnlyAgents: readonly string[],
  toolName?: string,
): void {
  if (isReadOnlyAgent(agent, readOnlyAgents)) {
    throw new Error(
      `orchestrator agent "${agent ?? "unknown"}" is not allowed to use sandbox operation${toolName ? ` "${toolName}"` : ""} (orchestrator-readonly)`,
    );
  }
}
