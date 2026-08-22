/**
 * Shared protocol and domain types for the sandbox broker.
 *
 * Security notes:
 * - The broker API is deliberately narrow (SYSTEM_PROMPT.md §7). Requests that
 *   carry worker policy fields (image, mounts, privileged, device, network,
 *   security profile) are REJECTED by validation.ts — those are server-side
 *   policy owned by the trusted broker (§11).
 * - `agent` is free-form human-supplied context from OpenCode and is used for
 *   LOGGING ONLY. It is never used for authorization decisions.
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
  | "sddAttemptAcquire"
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
  | "policy";

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
  "sddAttemptAcquire",
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
  /** Agent name, if supplied. Logged only — never trusted for authorization. */
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
    | "protocol";
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
}

export interface SddAttemptAcquirePayload {
  projectDir: string;
  change: string;
  requestId: string;
  workUnit: string;
  evidenceGoal: string;
  maxAttempts: number;
  maxChangedLines: number;
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
}
