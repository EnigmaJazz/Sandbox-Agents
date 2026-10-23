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
  | "HOST_APPROVED_MUTATION"
  | "EXECUTE_PROJECT"
  | "TEST_EXECUTION"
  | "HOST_READ_STRUCTURED"
  | "HOST_ADMIN_STRUCTURED"
  | "SECURITY_MUTATION"
  | "CONSULT"
  | "DELIBERATE";

export const CAPABILITIES: readonly Capability[] = [
  "READ_PROJECT",
  "RESEARCH_EXTERNAL",
  "MUTATE_PROJECT",
  "HOST_APPROVED_MUTATION",
  "EXECUTE_PROJECT",
  "TEST_EXECUTION",
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
  | "fresh_eyes"
  | "planner"
  | "pm";

export const ROLES: readonly Role[] = [
  "general",
  "researcher",
  "worker",
  "advisor",
  "solver",
  "challenger",
  "judge",
  "fresh_eyes",
  "planner",
  "pm",
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
  if (raw === "pm-odd" || raw === "pm-systematic") return "pm";
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
export const TOOL_CLASSIFICATION_INVENTORY: Readonly<Record<string, Capability>> = {
  // READ_PROJECT
  read: "READ_PROJECT",
  list: "READ_PROJECT",
  bash: "HOST_ADMIN_STRUCTURED",
  edit: "HOST_ADMIN_STRUCTURED",
  write: "HOST_ADMIN_STRUCTURED",
  apply_patch: "HOST_ADMIN_STRUCTURED",
  patch: "HOST_ADMIN_STRUCTURED",
  grep: "READ_PROJECT",
  glob: "READ_PROJECT",
  codegraph_codegraph_explore: "READ_PROJECT",
  sandbox_read: "READ_PROJECT",
  sandbox_list: "READ_PROJECT",
  sandbox_grep: "READ_PROJECT",
  sandbox_diff: "READ_PROJECT",
  // RESEARCH_EXTERNAL
  webfetch: "RESEARCH_EXTERNAL",
  websearch: "RESEARCH_EXTERNAL",
  "context7_resolve-library-id": "RESEARCH_EXTERNAL",
  "context7_query-docs": "RESEARCH_EXTERNAL",
  github_ro_get_commit: "RESEARCH_EXTERNAL",
  github_ro_get_file_contents: "RESEARCH_EXTERNAL",
  github_ro_get_label: "RESEARCH_EXTERNAL",
  github_ro_get_latest_release: "RESEARCH_EXTERNAL",
  github_ro_get_release_by_tag: "RESEARCH_EXTERNAL",
  github_ro_get_tag: "RESEARCH_EXTERNAL",
  github_ro_issue_read: "RESEARCH_EXTERNAL",
  github_ro_list_branches: "RESEARCH_EXTERNAL",
  github_ro_list_commits: "RESEARCH_EXTERNAL",
  github_ro_list_issue_fields: "RESEARCH_EXTERNAL",
  github_ro_list_issue_types: "RESEARCH_EXTERNAL",
  github_ro_list_issues: "RESEARCH_EXTERNAL",
  github_ro_list_pull_requests: "RESEARCH_EXTERNAL",
  github_ro_list_releases: "RESEARCH_EXTERNAL",
  github_ro_list_repository_collaborators: "RESEARCH_EXTERNAL",
  github_ro_list_tags: "RESEARCH_EXTERNAL",
  github_ro_pull_request_read: "RESEARCH_EXTERNAL",
  github_ro_search_code: "RESEARCH_EXTERNAL",
  github_ro_search_commits: "RESEARCH_EXTERNAL",
  github_ro_search_issues: "RESEARCH_EXTERNAL",
  github_ro_search_pull_requests: "RESEARCH_EXTERNAL",
  github_ro_search_repositories: "RESEARCH_EXTERNAL",
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
  // Host read and host mutation tool names.
  host_test_run: "TEST_EXECUTION",
  host_sandbox_result: "HOST_READ_STRUCTURED", host_review_assess: "HOST_READ_STRUCTURED",
  host_review_mode_status: "HOST_READ_STRUCTURED", host_review_status: "HOST_READ_STRUCTURED",
  host_review_lens_context: "HOST_READ_STRUCTURED", host_review_diff_read: "HOST_READ_STRUCTURED",
  host_review_materialize: "HOST_READ_STRUCTURED", host_review_pipeline_run: "HOST_APPROVED_MUTATION",
  host_review_persist: "HOST_APPROVED_MUTATION", host_sandbox_result_install: "HOST_APPROVED_MUTATION",
  host_git_commit: "HOST_APPROVED_MUTATION", host_git_clear_commit_intent: "HOST_APPROVED_MUTATION",
  host_git_push: "HOST_APPROVED_MUTATION", host_gh_issue_create: "HOST_APPROVED_MUTATION", host_plan_append: "HOST_APPROVED_MUTATION", host_plan_write: "HOST_APPROVED_MUTATION", host_gate_verdict: "HOST_APPROVED_MUTATION",
  host_review_start: "HOST_APPROVED_MUTATION", host_review_capture_result: "HOST_APPROVED_MUTATION",
  host_review_capture_unachievable: "HOST_APPROVED_MUTATION", host_review_acknowledge_approved: "HOST_APPROVED_MUTATION",
  host_review_capture_correction_plan: "HOST_APPROVED_MUTATION", host_review_capture_refuter: "HOST_APPROVED_MUTATION",
  host_review_capture_validation: "HOST_APPROVED_MUTATION", host_review_validate: "HOST_APPROVED_MUTATION",
  host_review_recover: "HOST_APPROVED_MUTATION", host_register_project: "HOST_APPROVED_MUTATION",
  host_sdd_status: "HOST_READ_STRUCTURED", host_sdd_continue: "HOST_READ_STRUCTURED",
  host_sdd_task_result: "HOST_READ_STRUCTURED", host_sdd_archive_compose: "HOST_APPROVED_MUTATION",
  host_sdd_attempt_grant: "HOST_APPROVED_MUTATION",
  sddArchiveCompose: "MUTATE_PROJECT", sddAttemptGrant: "MUTATE_PROJECT", planDocAppend: "MUTATE_PROJECT",
  reviewStart: "MUTATE_PROJECT", reviewCaptureResult: "MUTATE_PROJECT", reviewCaptureUnachievable: "MUTATE_PROJECT",
  reviewAcknowledgeApproved: "MUTATE_PROJECT", reviewCaptureCorrectionPlan: "MUTATE_PROJECT", reviewCaptureRefuter: "MUTATE_PROJECT",
  reviewCaptureValidation: "MUTATE_PROJECT", reviewValidate: "MUTATE_PROJECT", reviewRecover: "MUTATE_PROJECT",
  reviewMaterialize: "MUTATE_PROJECT", reviewPipelineRun: "MUTATE_PROJECT", reviewPersist: "MUTATE_PROJECT",
  sandboxResultInstall: "MUTATE_PROJECT", resultDiff: "HOST_READ_STRUCTURED", metrics: "HOST_READ_STRUCTURED",
  workerStatus: "READ_PROJECT", exec: "EXECUTE_PROJECT", readFile: "READ_PROJECT", writeFile: "MUTATE_PROJECT",
  applyPatch: "MUTATE_PROJECT", listDir: "READ_PROJECT", prepareResult: "MUTATE_PROJECT", applyResult: "MUTATE_PROJECT",
  discardResult: "MUTATE_PROJECT", keepResult: "MUTATE_PROJECT", destroyWorker: "MUTATE_PROJECT", listWorkers: "HOST_READ_STRUCTURED",
  ast_grep_search: "READ_PROJECT", codegraph_aft_callgraph: "READ_PROJECT",
  sddStatus: "HOST_READ_STRUCTURED", sddContinue: "HOST_READ_STRUCTURED", sddTaskResult: "HOST_READ_STRUCTURED",
  reviewAssess: "HOST_READ_STRUCTURED", reviewModeStatus: "HOST_READ_STRUCTURED", reviewStatus: "HOST_READ_STRUCTURED",
  reviewLensContext: "HOST_READ_STRUCTURED", reviewDiffRead: "HOST_READ_STRUCTURED", reviewPersistPreflight: "HOST_READ_STRUCTURED",
  sandboxResult: "HOST_READ_STRUCTURED", advisorGet: "HOST_READ_STRUCTURED", advisorList: "HOST_READ_STRUCTURED",
  hostSystemSummary: "HOST_READ_STRUCTURED", hostMemory: "HOST_READ_STRUCTURED", hostDiskUsage: "HOST_READ_STRUCTURED",
  hostNetworkListeners: "HOST_READ_STRUCTURED", hostProcessList: "HOST_READ_STRUCTURED", hostServiceStatus: "HOST_READ_STRUCTURED",
  hostServiceLogs: "HOST_READ_STRUCTURED", hostTailscaleStatus: "HOST_READ_STRUCTURED", hostDockerList: "HOST_READ_STRUCTURED", hostDockerLogs: "HOST_READ_STRUCTURED",
  gitCommit: "MUTATE_PROJECT", gitClearCommitIntent: "MUTATE_PROJECT", gitPush: "MUTATE_PROJECT", ghIssueCreate: "MUTATE_PROJECT",
  copyOutInfo: "HOST_READ_STRUCTURED", copyInInfo: "HOST_READ_STRUCTURED", copyOut: "MUTATE_PROJECT", copyIn: "MUTATE_PROJECT",
  policy: "HOST_READ_STRUCTURED", registerProject: "MUTATE_PROJECT", advisorAsk: "CONSULT", advisorRead: "CONSULT",
  advisorRespond: "CONSULT", evidenceKeep: "CONSULT",
  task: "DELIBERATE", question: "CONSULT", skill: "CONSULT", systematic_skill: "CONSULT",
  todowrite: "CONSULT",
  list_mcp_resources: "CONSULT",
  read_mcp_resource: "CONSULT",
  ctx_search: "CONSULT", ctx_expand: "CONSULT", ctx_reduce: "CONSULT", ctx_memory: "CONSULT", ctx_note: "CONSULT",
  systematic_workflow_start: "CONSULT", systematic_workflow_status: "CONSULT", systematic_workflow_complete: "CONSULT",
  codegraph_codegraph_explore: "READ_PROJECT", vision_bridge_describe_image: "READ_PROJECT", "vision-bridge_describe_image": "READ_PROJECT",
  github: "RESEARCH_EXTERNAL",
  aft_outline: "HOST_READ_STRUCTURED", aft_zoom: "HOST_READ_STRUCTURED", aft_search: "HOST_READ_STRUCTURED",
  aft_callgraph: "HOST_READ_STRUCTURED", aft_inspect: "HOST_READ_STRUCTURED",
  aft_safety: "HOST_ADMIN_STRUCTURED", aft_import: "HOST_ADMIN_STRUCTURED", ast_grep_replace: "HOST_ADMIN_STRUCTURED",
};

/**
 * Classify a tool/operation by effect. Returns the capability or null for
 * unknown/ambiguous effects (caller must deny).
 */
export function classifyOperation(operation: string): Capability | null {
  return TOOL_CLASSIFICATION_INVENTORY[operation] ?? null;
}

/**
 * AFT effect classification helper for tests: returns the AFT class or null
 * if the operation is not an AFT tool.
 */
export function classifyAft(operation: string): Capability | null {
  if (!operation.startsWith("aft_") && operation !== "ast_grep_replace") return null;
  const capability = TOOL_CLASSIFICATION_INVENTORY[operation];
  return capability === "HOST_READ_STRUCTURED" || capability === "HOST_ADMIN_STRUCTURED" ? capability : null;
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
    HOST_APPROVED_MUTATION: false,
    EXECUTE_PROJECT: false,
    TEST_EXECUTION: false,
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
    HOST_APPROVED_MUTATION: false,
    EXECUTE_PROJECT: false,
    TEST_EXECUTION: false,
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
    HOST_APPROVED_MUTATION: false,
    EXECUTE_PROJECT: true,
    TEST_EXECUTION: false,
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
    HOST_APPROVED_MUTATION: false,
    EXECUTE_PROJECT: false,
    TEST_EXECUTION: false,
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
    HOST_APPROVED_MUTATION: false,
    EXECUTE_PROJECT: false,
    TEST_EXECUTION: false,
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
    HOST_APPROVED_MUTATION: false,
    EXECUTE_PROJECT: false,
    TEST_EXECUTION: false,
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
    HOST_APPROVED_MUTATION: false,
    EXECUTE_PROJECT: false,
    TEST_EXECUTION: false,
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
    HOST_APPROVED_MUTATION: false,
    EXECUTE_PROJECT: false,
    TEST_EXECUTION: false,
    HOST_READ_STRUCTURED: false,
    HOST_ADMIN_STRUCTURED: false,
    SECURITY_MUTATION: false,
    CONSULT: false,
    DELIBERATE: true,
  },
  planner: {
    READ_PROJECT: true,
    RESEARCH_EXTERNAL: true,
    MUTATE_PROJECT: false,
    HOST_APPROVED_MUTATION: true,
    EXECUTE_PROJECT: false,
    TEST_EXECUTION: false,
    HOST_READ_STRUCTURED: true,
    HOST_ADMIN_STRUCTURED: false,
    SECURITY_MUTATION: false,
    CONSULT: true,
    DELIBERATE: true,
  },
  pm: {
    READ_PROJECT: true,
    RESEARCH_EXTERNAL: false,
    MUTATE_PROJECT: false,
    HOST_APPROVED_MUTATION: true,
    EXECUTE_PROJECT: false,
    TEST_EXECUTION: false,
    HOST_READ_STRUCTURED: true,
    HOST_ADMIN_STRUCTURED: false,
    SECURITY_MUTATION: false,
    CONSULT: true,
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
    // Approval-gated host operations are the orchestrator's sanctioned surface; project mutation and execution stay denied.
    if (!isCapability(ctx.capability)) {
      return { decision: "deny", reasonCode: "UNKNOWN_CAPABILITY" };
    }
    // Read-only orchestrator identities are not role keys, so role validation must not be reached.
    return { decision: "allow", reasonCode: "ORCHESTRATOR_READ_ONLY_ALLOWED" };
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
