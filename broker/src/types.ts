/**
 * Shared protocol and domain types for the sandbox broker.
 *
 * Security notes:
 * - The broker API is deliberately narrow (SYSTEM_PROMPT.md §7). Requests that
 *   carry worker policy fields (image, mounts, privileged, device, network,
 *   security profile) are REJECTED by validation.ts — those are server-side
 *   policy owned by the trusted broker (§11).
 * - `agent` is free-form human-supplied context from OpenCode and is used for
 *   LOGGING ONLY, except where the broker derives a trusted role from its
 *   allowlisted role/session registry (role-based subagents).
 */

/** Session lifecycle states (SYSTEM_PROMPT.md §10). */
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

/** Lifecycle of the underlying msb worker, when one exists. */
export type WorkerState =
  | "CREATING"
  | "ACTIVE"
  | "PAUSED"
  | "DESTROYED"
  | "FAILED";

/** Narrow operation surface exposed over the Unix socket. */
export type Operation =
  // §7 worker lifecycle / project ops
  | "ensureWorker"
  | "workerStatus"
  | "exec"
  | "readFile"
  | "writeFile"
  | "applyPatch"
  | "listDir"
  | "grep"
  | "diff"
  | "prepareResult"
  | "applyResult"
  | "discardResult"
  | "keepResult"
  | "destroyWorker"
  | "listWorkers"
  | "metrics"
  // Host-side SDD runtime: fixed argv and trusted project roots only.
  | "sddStatus"
  | "sddContinue"
  | "sddArchiveCompose"
  | "sddTaskResult"
  | "reviewAssess"
  | "reviewModeStatus"
  | "reviewStatus"
  | "reviewLensContext"
  | "sddAttemptGrant"
  | "planDocAppend"
  // Host-authoritative session→agent binding (plugin-only; never exposed as a
  // `host_*` or `sandbox_*` tool).
  | "bindSessionAgent"
  // Host review lifecycle: fixed argv, orchestrator-only (§31).
  | "reviewStart"
  | "reviewCaptureResult"
  | "reviewCaptureUnachievable"
  | "reviewAcknowledgeApproved"
  | "reviewCaptureCorrectionPlan"
  | "reviewCaptureRefuter"
  | "reviewCaptureValidation"
  | "reviewValidate"
  | "reviewRecover"
  // Host git/GH mutations: fixed argv, orchestrator-only (§31).
  | "gitCommit"
  | "gitPush"
  | "ghIssueCreate"
  // §8 structured read-only host API (never mutation)
  | "hostSystemSummary"
  | "hostMemory"
  | "hostDiskUsage"
  | "hostNetworkListeners"
  | "hostProcessList"
  | "hostServiceStatus"
  | "hostServiceLogs"
  | "hostTailscaleStatus"
  | "hostDockerList"
  | "hostDockerLogs"
  // copy tool: worker <-> allowlisted host file transfer (S15)
  | "copyOutInfo"
  | "copyOut"
  | "copyInInfo"
  | "copyIn"
  // read-only policy/introspection (used by the routing guard plugin)
  | "policy"
  | "registerProject";

/** Every Operation that exists in the protocol. Immutable; unknown ops fail closed. */
export const OPERATIONS: readonly Operation[] = [
  "ensureWorker",
  "workerStatus",
  "exec",
  "readFile",
  "writeFile",
  "applyPatch",
  "listDir",
  "grep",
  "diff",
  "prepareResult",
  "applyResult",
  "discardResult",
  "keepResult",
  "destroyWorker",
  "listWorkers",
  "metrics",
  "sddStatus",
  "sddContinue",
  "sddArchiveCompose",
  "sddTaskResult",
  "reviewAssess",
  "reviewModeStatus",
  "reviewStatus",
  "reviewLensContext",
  "sddAttemptGrant",
  "planDocAppend",
  "bindSessionAgent",
  "reviewStart",
  "reviewCaptureResult",
  "reviewCaptureUnachievable",
  "reviewAcknowledgeApproved",
  "reviewCaptureCorrectionPlan",
  "reviewCaptureRefuter",
  "reviewCaptureValidation",
  "reviewValidate",
  "reviewRecover",
  "hostSystemSummary",
  "hostMemory",
  "hostDiskUsage",
  "hostNetworkListeners",
  "hostProcessList",
  "hostServiceStatus",
  "hostServiceLogs",
  "hostTailscaleStatus",
  "hostDockerList",
  "hostDockerLogs",
  "copyOutInfo",
  "copyOut",
  "copyInInfo",
  "copyIn",
  "policy",
  "registerProject",
];

/** Worker policy fields the LLM must NEVER be able to supply (§7, §11). */
export const FORBIDDEN_WORKER_FIELDS = [
  "image",
  "hostMount",
  "mounts",
  "privileged",
  "device",
  "devices",
  "hostNetwork",
  "network",
  "securityProfile",
  "security_profile",
  "fsConf",
  "runtimeConf",
  "secretConf",
  "rawMsbConfig",
] as const;

export interface BrokerRequestEnvelope {
  version: 1;
  /** Client-generated request id, echoed in the response. */
  id: string;
  operation: Operation;
  sessionID: string;
  /** Agent name, if supplied. Logged only — never trusted for authorization except via readOnlyAgents allowlist. */
  agent?: string;
  payload?: unknown;
}

export interface BrokerError {
  code:
    | "validation"
    | "state"
    | "policy"
    | "worker"
    | "snapshot"
    | "divergence"
    | "not_found"
    | "internal"
    | "protocol"
    | "queued_timed_out";
  message: string;
}

export interface BrokerResponseEnvelope {
  version: 1;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: BrokerError;
}

// ---------------------------------------------------------------------------
// Per-operation payloads (validated by validation.ts against exact key sets)
// ---------------------------------------------------------------------------

export interface EnsureWorkerPayload {
  /** Project directory (from ToolContext.directory); mapped to a projectID via the trusted allowlist. */
  projectDir: string;
}

export interface SddStatusPayload {
  projectDir: string;
  change?: string;
  contract?: string;
}

export interface SddContinuePayload {
  projectDir: string;
  change?: string;
}

/** `grant` registers canonical host roots for a caller token. */
export interface SddAttemptGrantPayload {
  projectDir: string;
  change: string;
  expectedRevision?: string;
  roots: string[];
  changeInstance: string;
  requestId: string;
  actor: string;
  reason: string;
}

/** Orchestrator-only, append-only plan-document mutation. */
export interface PlanDocAppendPayload {
  projectDir: string;
  doc: "todo" | "plan";
  content: string;
  heading?: string;
}

export type ReviewProjection = "workspace" | "staged";
export type ReviewFocus = "risk" | "resilience" | "readability" | "reliability";
export type ReviewConsent = "relay" | "granted" | "declined";
export type ReviewLocale = "en" | "es";
export type ReviewGate = "post-apply" | "pre-commit" | "pre-push" | "pre-pr" | "release";
export type ReviewDisposition = "scope_changed" | "invalidated" | "escalated";

/** Provider-issued per-lens reviewer-step identifiers (read-only lens context). */
export type ReviewLens =
  | "review-risk"
  | "review-resilience"
  | "review-readability"
  | "review-reliability";

export interface ReviewStartPayload {
  projectDir: string;
  agent?: string;
  contract?: string;
  target?: string;
  projection?: ReviewProjection;
  focus?: ReviewFocus;
  untrackedScope?: "exclude" | "select";
  expectedUntrackedInventory?: string;
  intendedUntracked?: string[];
  baseRef?: string;
  committedOnly?: boolean;
  workspaceOverlay?: boolean;
  lineage?: string;
  consent?: ReviewConsent;
  locale?: ReviewLocale;
  policy?: string;
  trace?: string;
}

export interface ReviewCaptureResultPayload {
  projectDir: string;
  agent?: string;
  input?: string;
  inputJson?: string;
  lens?: string;
  order?: number;
  target?: string;
  lineage?: string;
  expectedRevision?: string;
  repositoryContext?: string;
  subjectHash?: string;
  materialize?: boolean;
  preflight?: boolean;
}

export interface ReviewCaptureUnachievablePayload {
  projectDir: string;
  target?: string;
  lineage?: string;
  expectedRevision?: string;
  repositoryContext?: string;
  requestHash?: string;
  reason?: string;
  detail?: string;
  withdraw?: boolean;
}

export interface ReviewAcknowledgeApprovedPayload {
  projectDir: string;
  lineage: string;
  target: string;
  expectedRevision: string;
  token: string;
}

export interface ReviewCaptureCorrectionPlanPayload {
  projectDir: string;
  target?: string;
  lineage?: string;
  expectedRevision?: string;
  repositoryContext?: string;
  requestHash?: string;
  correctionLines?: number;
}

export interface ReviewCaptureRefuterPayload {
  projectDir: string;
  agent?: string;
  target?: string;
  lineage?: string;
  expectedRevision?: string;
  repositoryContext?: string;
  materialize?: boolean;
  execute?: boolean;
}

export interface ReviewCaptureValidationPayload extends ReviewCaptureRefuterPayload {
  requestHash?: string;
}

export interface ReviewValidatePayload {
  projectDir: string;
  contract?: string;
  gate?: ReviewGate;
  baseRef?: string;
  lineage?: string;
  policy?: string;
  prePrCiAttestation?: string;
  releaseConfiguration?: string;
  releaseEvidenceFreshness?: string;
  releaseGenerated?: string;
  releaseProvenance?: string;
  releasePublicationBoundary?: string;
}

export interface ReviewRecoverPayload {
  projectDir: string;
  actor?: string;
  disposition?: ReviewDisposition;
  expectedPredecessorRevision?: string;
  predecessorLineage?: string;
  successorLineage?: string;
  reason?: string;
  maintainerAuthorization?: string;
  baseRef?: string;
  committedOnly?: boolean;
  workspaceOverlay?: boolean;
  releaseScope?: boolean;
  projection?: ReviewProjection;
  untrackedScope?: "exclude" | "select";
  expectedUntrackedInventory?: string;
  intendedUntracked?: string[];
  focus?: string;
  policy?: string;
}

export interface SddArchiveComposePayload {
  projectDir: string;
  canonical: string;
  delta: string;
  output: string;
}

export interface SddTaskResultPayload {
  projectDir: string;
  phase: string;
  input: string;
}

export interface ReviewAssessPayload {
  projectDir: string;
  baseRef?: string;
  committedOnly?: boolean;
  untrackedScope?: "exclude" | "select";
  expectedUntrackedInventory?: string;
  intendedUntracked?: string[];
}

export interface ReviewModeStatusPayload {
  projectDir: string;
}

export interface ReviewStatusPayload {
  projectDir: string;
  agent?: string;
  lineage?: string;
  repositoryContext?: string;
  projection?: ReviewProjection;
  baseRef?: string;
  committedOnly?: boolean;
  intendedUntrackedSelection?: string;
}

/** Read-only per-lens reviewer context; the broker returns a plain-text block. */
export interface ReviewLensContextPayload {
  projectDir: string;
  repositoryContext: string;
  lineage: string;
  target: string;
  expectedRevision: string;
  lens: ReviewLens;
}

/** Ref-scoped host commit: exactly the session's persisted B→C paths. */
export interface GitCommitPayload {
  projectDir: string;
  message: string;
  /**
   * Optional sandbox session id whose APPLIED result should be committed
   * instead of the caller's own. Omitted preserves the caller's own applied
   * result (existing behaviour). The broker resolves the refs from its own
   * persisted record; this is never an arbitrary commit/tree/branch/path.
   */
  sandboxSessionID?: string;
}

/** Guarded host push: the broker resolves branch/upstream/ahead itself. */
export interface GitPushPayload {
  projectDir: string;
  remote?: string;
  setUpstream?: boolean;
  allowProtectedBranch?: boolean;
}

/** Fixed-argv host GitHub issue creation. */
export interface GhIssueCreatePayload {
  projectDir: string;
  repo: string;
  title: string;
  body: string;
}

export interface ExecPayload {
  argv: string[];
  cwd?: string;
  timeoutMs?: number;
  /** Restrictive env allowlist only — never tokens/keys (S8/S9). */
  env?: Record<string, string>;
}

export interface ReadFilePayload {
  path: string;
}

export interface WriteFilePayload {
  path: string;
  content: string;
}

export interface ApplyPatchPayload {
  patch: string;
}

export interface ListDirPayload {
  path: string;
}

export interface GrepPayload {
  query: string;
  path: string;
}

export interface DiffPayload {
  /** Empty for the active diff; set for a retained result. */
  mode?: "active" | "retained";
}

export interface ApplyResultPayload {
  /** Must be the literal "APPLY"; presence of any other value is rejected. */
  confirm: "APPLY";
}

export interface DiscardResultPayload {
  /** Must be the literal "REJECT" (mirrors §20 REJECT semantics). */
  confirm: "REJECT";
}

export interface KeepResultPayload {
  /** Must be the literal "KEEP" (§20 KEEP semantics). */
  confirm: "KEEP";
}

export interface HostServiceStatusPayload {
  service: string;
}

export interface HostServiceLogsPayload {
  service: string;
  lines?: number;
  since?: string;
}

export interface HostDiskUsagePayload {
  path: string;
}

export interface HostProcessListPayload {
  filter?: string;
}

export interface HostDockerLogsPayload {
  container: string;
  lines?: number;
}

export interface RegisterProjectPayload {
  path: string;
  dryRun?: boolean;
  createRemote?: boolean;
  makePublic?: boolean;
}

// ---------------------------------------------------------------------------
// Records returned by the broker
// ---------------------------------------------------------------------------

export interface SessionRecord {
  sessionID: string;
  state: SessionState;
  projectID?: string;
  workerName?: string;
  workerState?: WorkerState;
  agent?: string;
  baselineRef?: string;
  resultRef?: string;
  error?: string;
  /** Set by the idle reaper when it released this session's worker. */
  reapedAt?: string;
  lastOperation?: string;
  resources?: { cpu?: number; memBytes?: number };
  createdAt: string;
  updatedAt: string;
}

export interface WorkerRecord {
  workerName: string;
  sessionID: string;
  projectID: string;
  state: WorkerState;
  cpu: number;
  memBytes: number;
  createdAt: string;
}

export interface MetricsRecord {
  totalCpu: number;
  totalMemBytes: number;
  reservedCpu: number;
  reservedMemBytes: number;
  aggregateCpuInUse: number;
  aggregateMemBytesInUse: number;
  workersActive: number;
  workersMax: number;
  sessionsByState: Record<string, number>;
  budgetExhausted: boolean;
}

export interface PolicyRecord {
  socketPath: string;
  projects: { id: string; path: string }[];
  approvedExternalReadRoots: string[];
  protectedPaths: string[];
  workerImage: string;
  resourceCaps: {
    perWorkerCpu: number;
    perWorkerMemBytes: number;
    maxWorkers: number;
    maxAggregateCpu: number;
    maxAggregateMemBytes: number;
  };
  network: { mode: "deny-by-default" | "allowlist"; note: string };
  /** Orchestrator read-only agents — authoritative broker view. */
  readOnlyAgents: string[];
  /** Per-role model mapping (policy-independent). */
  roleModels: Record<string, unknown>;
}
