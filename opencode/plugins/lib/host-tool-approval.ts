/**
 * Pure, dependency-free ask-metadata builders for host mutation tools.
 *
 * Host mutations (`host_sdd_attempt_grant`, `host_sdd_archive_compose`, and the
 * git/GH tools) require TWO approval layers, mirroring the `sandbox_apply`
 * precedent:
 *
 *   1. `opencode/config-fragments/sandbox-permissions.jsonc` marks the tool
 *      `ask`, so opencode prompts before the tool runs at all;
 *   2. the tool calls `ctx.ask(buildHostToolAsk(...))` with a human-readable
 *      summary and the exact arguments that materially affect the host.
 *
 * This module is intentionally PURE: it performs no I/O, imports no runtime
 * dependency, and never touches the broker. Keeping it dependency-free lets the
 * broker test suite (`broker/tests/host-tool-approval.test.ts`) exercise the
 * approval metadata without loading the opencode plugin runtime.
 */

/** Host mutation operations that require explicit human approval. */
export type HostMutationOperation =
  | "sddAttemptGrant"
  | "gitCommit"
  | "gitPush"
  | "ghIssueCreate"
  | "planDocAppend"
  | "reviewStart"
  | "reviewCaptureResult"
  | "reviewCaptureUnachievable"
  | "reviewAcknowledgeApproved"
  | "reviewCaptureCorrectionPlan"
  | "reviewCaptureRefuter"
  | "reviewCaptureValidation"
  | "reviewValidate"
  | "reviewRecover"
  | "sddArchiveCompose"
  | "registerProject";

export interface HostToolAskMetadata {
  operation: HostMutationOperation;
  /** One-line human summary of the host mutation. */
  summary: string;
  /** Exact, human-auditable arguments that drive the mutation. */
  details: Record<string, string | number>;
}

export interface HostToolAsk {
  /** Permission key; must match the config-fragment tool entry. */
  permission: string;
  patterns: string[];
  always: string[];
  metadata: HostToolAskMetadata;
}

export class HostToolAskError extends Error {
  readonly code = "validation" as const;

  constructor(message: string) {
    super(message);
    this.name = "HostToolAskError";
  }
}

function assertNonEmpty(value: unknown, what: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HostToolAskError(`${what} must be a non-empty string`);
  }
}

/**
 * Base builder. `always` is deliberately empty: a metadata-rich ask must never
 * be silently auto-approved for the session (`sandbox_apply` uses the same
 * shape). `patterns: ["*"]` matches the existing sandbox ask contract.
 */
export function buildHostToolAsk(input: {
  permission: string;
  operation: HostMutationOperation;
  summary: string;
  details: Record<string, string | number>;
}): HostToolAsk {
  assertNonEmpty(input.permission, "permission");
  assertNonEmpty(input.operation, "operation");
  assertNonEmpty(input.summary, "summary");
  if (
    input.details === null ||
    typeof input.details !== "object" ||
    Array.isArray(input.details)
  ) {
    throw new HostToolAskError("details must be an object");
  }
  return {
    permission: input.permission,
    patterns: ["*"],
    always: [],
    metadata: {
      operation: input.operation,
      summary: input.summary,
      details: { ...input.details },
    },
  };
}

export interface SddAttemptGrantAskArgs {
  change: string;
  roots: readonly string[];
  changeInstance: string;
  requestId: string;
  actor: string;
  reason: string;
}

/** Approval metadata for `host_sdd_attempt_grant`. */
export function buildSddAttemptGrantAsk(args: SddAttemptGrantAskArgs): HostToolAsk {
  assertNonEmpty(args.change, "change");
  assertRepoRelativePaths(args.roots, "roots");
  assertNonEmpty(args.changeInstance, "changeInstance");
  assertNonEmpty(args.requestId, "requestId");
  assertNonEmpty(args.actor, "actor");
  assertNonEmpty(args.reason, "reason");
  return buildHostToolAsk({
    permission: "host_sdd_attempt_grant",
    operation: "sddAttemptGrant",
    summary: `Grant ${args.roots.length} canonical host root(s) for change ${args.change}`,
    details: {
      change: args.change,
      rootCount: args.roots.length,
      roots: args.roots.join(", "),
      changeInstance: args.changeInstance,
      requestId: args.requestId,
      actor: args.actor,
      reason: args.reason,
    },
  });
}

function assertRepoRelativePaths(value: unknown, what: string): asserts value is string[] {
  if (!Array.isArray(value)) {
    throw new HostToolAskError(`${what} must be an array of paths`);
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new HostToolAskError(`${what} entries must be non-empty strings`);
    }
  }
}

export interface GitCommitAskArgs {
  message: string;
  sandboxSessionID?: string;
  branch?: string;
  subject?: string;
  paths?: readonly string[];
  protectedPaths?: readonly string[];
}

/** Approval metadata for `host_git_commit` (branch/subject/path preview/protected). */
export function buildGitCommitAsk(args: GitCommitAskArgs): HostToolAsk {
  assertNonEmpty(args.message, "message");
  const details: Record<string, string | number> = { message: args.message };
  if (args.sandboxSessionID !== undefined) {
    assertNonEmpty(args.sandboxSessionID, "sandboxSessionID");
    details.sandboxSessionID = args.sandboxSessionID;
  }
  if (args.branch !== undefined) {
    assertNonEmpty(args.branch, "branch");
    details.branch = args.branch;
  }
  if (args.subject !== undefined) {
    assertNonEmpty(args.subject, "subject");
    details.subject = args.subject;
  }
  if (args.paths !== undefined) {
    assertRepoRelativePaths(args.paths, "paths");
    details.pathCount = args.paths.length;
    details.pathPreview = args.paths.slice(0, 20).join(", ");
  }
  if (args.protectedPaths !== undefined) {
    assertRepoRelativePaths(args.protectedPaths, "protectedPaths");
    details.protectedRejected =
      args.protectedPaths.length > 0 ? args.protectedPaths.join(", ") : "none";
  }
  return buildHostToolAsk({
    permission: "host_git_commit",
    operation: "gitCommit",
    summary: `Commit ${details.pathCount ?? 0} result path(s) on ${args.branch ?? "the current branch"}`,
    details,
  });
}

export interface GitPushAskArgs {
  remote: string;
  branch: string;
  ahead: number;
  upstream: string | null;
  setUpstream: boolean;
  warning?: string;
}

/** Approval metadata for `host_git_push` (remote/branch/ahead/upstream/warning). */
export function buildGitPushAsk(args: GitPushAskArgs): HostToolAsk {
  assertNonEmpty(args.remote, "remote");
  assertNonEmpty(args.branch, "branch");
  if (!Number.isInteger(args.ahead) || args.ahead < 0) {
    throw new HostToolAskError("ahead must be a non-negative integer");
  }
  const details: Record<string, string | number> = {
    remote: args.remote,
    branch: args.branch,
    ahead: args.ahead,
    upstream: args.upstream ?? "none",
    setUpstream: args.setUpstream ? "yes" : "no",
  };
  if (args.warning !== undefined) {
    assertNonEmpty(args.warning, "warning");
    details.warning = args.warning;
  }
  return buildHostToolAsk({
    permission: "host_git_push",
    operation: "gitPush",
    summary: `Push ${args.branch} to ${args.remote} (+${args.ahead})`,
    details,
  });
}

export interface GhIssueCreateAskArgs {
  repo: string;
  title: string;
  body: string;
}

/** Approval metadata for `host_gh_issue_create` (repo/title/body preview). */
export function buildGhIssueCreateAsk(args: GhIssueCreateAskArgs): HostToolAsk {
  assertNonEmpty(args.repo, "repo");
  assertNonEmpty(args.title, "title");
  if (typeof args.body !== "string") {
    throw new HostToolAskError("body must be a string");
  }
  const preview = args.body.length > 280 ? `${args.body.slice(0, 280)}…` : args.body;
  return buildHostToolAsk({
    permission: "host_gh_issue_create",
    operation: "ghIssueCreate",
    summary: `Create issue in ${args.repo}: ${args.title}`,
    details: {
      repo: args.repo,
      title: args.title,
      bodyPreview: preview,
      bodyBytes: Buffer.byteLength(args.body, "utf8"),
    },
  });
}

export interface PlanDocAppendAskArgs {
  doc: "todo" | "plan";
  content: string;
  heading?: string;
}

/** Approval metadata for `host_plan_append` (document, heading, byte count). */
export function buildPlanDocAppendAsk(args: PlanDocAppendAskArgs): HostToolAsk {
  if (args.doc !== "todo" && args.doc !== "plan") {
    throw new HostToolAskError("doc must be one of: todo, plan");
  }
  assertNonEmpty(args.content, "content");
  if (args.heading !== undefined) {
    assertNonEmpty(args.heading, "heading");
  }
  const details: Record<string, string | number> = {
    doc: args.doc,
    contentBytes: Buffer.byteLength(args.content, "utf8"),
  };
  if (args.heading !== undefined) details.heading = args.heading;
  const headingNote = args.heading !== undefined ? ` under heading "${args.heading}"` : "";
  return buildHostToolAsk({
    permission: "host_plan_append",
    operation: "planDocAppend",
    summary: `Append ${details.contentBytes} byte(s) to the ${args.doc} plan document${headingNote}`,
    details,
  });
}

export interface RegisterProjectAskArgs {
  path: string;
  dryRun?: boolean;
  createRemote?: boolean;
  makePublic?: boolean;
}

/** Approval metadata for `host_register_project` (path + yes/no flag summary). */
export function buildRegisterProjectAsk(args: RegisterProjectAskArgs): HostToolAsk {
  assertNonEmpty(args.path, "path");
  const details: Record<string, string | number> = {
    path: args.path,
    dryRun: args.dryRun ? "yes" : "no",
    createRemote: args.createRemote ? "yes" : "no",
    makePublic: args.makePublic ? "yes" : "no",
  };
  return buildHostToolAsk({
    permission: "host_register_project",
    operation: "registerProject",
    summary: `Register project ${args.path} (dryRun=${details.dryRun}, createRemote=${details.createRemote}, makePublic=${details.makePublic})`,
    details,
  });
}

export interface SddArchiveComposeAskArgs {
  canonical: string;
  delta: string;
  output: string;
}

/** Approval metadata for `host_sdd_archive_compose`. */
export function buildSddArchiveComposeAsk(args: SddArchiveComposeAskArgs): HostToolAsk {
  assertNonEmpty(args.canonical, "canonical");
  assertNonEmpty(args.delta, "delta");
  assertNonEmpty(args.output, "output");
  return buildHostToolAsk({
    permission: "host_sdd_archive_compose",
    operation: "sddArchiveCompose",
    summary: `Compose archive delta ${args.delta} into ${args.canonical} -> ${args.output}`,
    details: {
      canonical: args.canonical,
      delta: args.delta,
      output: args.output,
    },
  });
}

/** Short non-cryptographic digest so opaque provider tokens are never echoed. */
function reviewTokenDigest(values: readonly (string | undefined)[]): string {
  const input = values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\u0000");
  if (input.length === 0) return "";
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function assertReviewEnum(value: unknown, values: readonly string[], what: string): void {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new HostToolAskError(`${what} must be one of: ${values.join(", ")}`);
  }
}

function reviewAskDetails(
  fields: Record<string, string | number | boolean | undefined>,
): Record<string, string | number> {
  const details: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    details[key] = typeof value === "boolean" ? (value ? "yes" : "no") : value;
  }
  return details;
}

export interface ReviewStartAskArgs {
  agent?: string;
  contract?: string;
  target?: string;
  projection?: string;
  focus?: string;
  untrackedScope?: string;
  intendedUntracked?: string[];
  baseRef?: string;
  lineage?: string;
  consent?: string;
  locale?: string;
  policy?: string;
  trace?: string;
  committedOnly?: boolean;
  workspaceOverlay?: boolean;
}

/** Approval metadata for `host_review_start`. */
export function buildReviewStartAsk(args: ReviewStartAskArgs = {}): HostToolAsk {
  if (args.projection !== undefined) assertReviewEnum(args.projection, ["workspace", "staged"], "projection");
  if (args.focus !== undefined) assertReviewEnum(args.focus, ["risk", "resilience", "readability", "reliability"], "focus");
  if (args.consent !== undefined) assertReviewEnum(args.consent, ["relay", "granted", "declined"], "consent");
  if (args.locale !== undefined) assertReviewEnum(args.locale, ["en", "es"], "locale");
  if (args.untrackedScope !== undefined) assertReviewEnum(args.untrackedScope, ["exclude", "select"], "untrackedScope");
  return buildHostToolAsk({
    permission: "host_review_start",
    operation: "reviewStart",
    summary: `Start a review lifecycle${args.focus ? ` (focus ${args.focus})` : ""}${args.projection ? ` [${args.projection}]` : ""}`,
    details: reviewAskDetails({
      projection: args.projection,
      focus: args.focus,
      consent: args.consent,
      locale: args.locale,
      untrackedScope: args.untrackedScope,
      untrackedCount: args.intendedUntracked?.length,
      committedOnly: args.committedOnly,
      workspaceOverlay: args.workspaceOverlay,
      tokenDigest: reviewTokenDigest([args.agent, args.contract, args.target, args.baseRef, args.lineage, args.policy, args.trace]) || undefined,
    }),
  });
}

export interface ReviewCaptureResultAskArgs {
  agent?: string;
  input?: string;
  inputBytes?: number;
  inputDigest?: string;
  inputJsonBytes?: number;
  inputJsonDigest?: string;
  lens?: string;
  order?: number;
  target?: string;
  lineage?: string;
  repositoryContext?: string;
  materialize?: boolean;
  preflight?: boolean;
}

/** Approval metadata for `host_review_capture_result`. */
export function buildReviewCaptureResultAsk(args: ReviewCaptureResultAskArgs = {}): HostToolAsk {
  if (args.order !== undefined && (!Number.isInteger(args.order) || args.order < 0 || args.order > 32)) {
    throw new HostToolAskError("order must be an integer in [0, 32]");
  }
  return buildHostToolAsk({
    permission: "host_review_capture_result",
    operation: "reviewCaptureResult",
    summary: `Capture a review result${args.lens ? ` (lens ${args.lens})` : ""}${args.order !== undefined ? ` #${args.order}` : ""}`,
    details: reviewAskDetails({
      lens: args.lens,
      order: args.order,
      input: args.input,
      inputBytes: args.inputBytes,
      inputDigest: args.inputDigest,
      inputJsonBytes: args.inputJsonBytes,
      inputJsonDigest: args.inputJsonDigest,
      materialize: args.materialize,
      preflight: args.preflight,
      tokenDigest: reviewTokenDigest([args.agent, args.target, args.lineage, args.repositoryContext]) || undefined,
    }),
  });
}

export interface ReviewCaptureUnachievableAskArgs {
  target?: string;
  lineage?: string;
  repositoryContext?: string;
  reason?: string;
  withdraw?: boolean;
}

/** Approval metadata for `host_review_capture_unachievable`. */
export function buildReviewCaptureUnachievableAsk(args: ReviewCaptureUnachievableAskArgs = {}): HostToolAsk {
  return buildHostToolAsk({
    permission: "host_review_capture_unachievable",
    operation: "reviewCaptureUnachievable",
    summary: `Record an unachievable review outcome${args.withdraw ? " (withdraw)" : ""}`,
    details: reviewAskDetails({
      reason: args.reason,
      withdraw: args.withdraw,
      tokenDigest: reviewTokenDigest([args.target, args.lineage, args.repositoryContext]) || undefined,
    }),
  });
}

export interface ReviewAcknowledgeApprovedAskArgs {
  target?: string;
  lineage?: string;
  expectedRevision?: string;
  token?: string;
}

/** Approval metadata for `host_review_acknowledge_approved`. */
export function buildReviewAcknowledgeApprovedAsk(args: ReviewAcknowledgeApprovedAskArgs = {}): HostToolAsk {
  return buildHostToolAsk({
    permission: "host_review_acknowledge_approved",
    operation: "reviewAcknowledgeApproved",
    summary: "Acknowledge the approved review authority",
    details: reviewAskDetails({
      tokenDigest: reviewTokenDigest([args.target, args.lineage, args.expectedRevision, args.token]) || undefined,
    }),
  });
}

export interface ReviewCaptureCorrectionPlanAskArgs {
  target?: string;
  lineage?: string;
  repositoryContext?: string;
  correctionLines?: number;
}

/** Approval metadata for `host_review_capture_correction_plan`. */
export function buildReviewCaptureCorrectionPlanAsk(args: ReviewCaptureCorrectionPlanAskArgs = {}): HostToolAsk {
  if (args.correctionLines !== undefined && (!Number.isInteger(args.correctionLines) || args.correctionLines < 1)) {
    throw new HostToolAskError("correctionLines must be a positive integer");
  }
  return buildHostToolAsk({
    permission: "host_review_capture_correction_plan",
    operation: "reviewCaptureCorrectionPlan",
    summary: `Capture a review correction plan${args.correctionLines !== undefined ? ` (${args.correctionLines} lines)` : ""}`,
    details: reviewAskDetails({
      correctionLines: args.correctionLines,
      tokenDigest: reviewTokenDigest([args.target, args.lineage, args.repositoryContext]) || undefined,
    }),
  });
}

export interface ReviewCaptureRefuterAskArgs {
  agent?: string;
  target?: string;
  lineage?: string;
  repositoryContext?: string;
  materialize?: boolean;
  execute?: boolean;
}

/** Approval metadata for `host_review_capture_refuter`. */
export function buildReviewCaptureRefuterAsk(args: ReviewCaptureRefuterAskArgs = {}): HostToolAsk {
  const mode = args.execute ? "execute" : args.materialize ? "materialize" : "capture";
  return buildHostToolAsk({
    permission: "host_review_capture_refuter",
    operation: "reviewCaptureRefuter",
    summary: `Capture a refuter result (${mode})`,
    details: reviewAskDetails({
      mode,
      tokenDigest: reviewTokenDigest([args.agent, args.target, args.lineage, args.repositoryContext]) || undefined,
    }),
  });
}

export interface ReviewCaptureValidationAskArgs extends ReviewCaptureRefuterAskArgs {
  requestHash?: string;
}

/** Approval metadata for `host_review_capture_validation`. */
export function buildReviewCaptureValidationAsk(args: ReviewCaptureValidationAskArgs = {}): HostToolAsk {
  const mode = args.execute ? "execute" : args.materialize ? "materialize" : "capture";
  return buildHostToolAsk({
    permission: "host_review_capture_validation",
    operation: "reviewCaptureValidation",
    summary: `Capture a validation result (${mode})`,
    details: reviewAskDetails({
      mode,
      tokenDigest: reviewTokenDigest([args.agent, args.target, args.lineage, args.repositoryContext, args.requestHash]) || undefined,
    }),
  });
}

export interface ReviewValidateAskArgs {
  contract?: string;
  gate?: string;
  baseRef?: string;
  lineage?: string;
  policy?: string;
}

/** Approval metadata for `host_review_validate`. */
export function buildReviewValidateAsk(args: ReviewValidateAskArgs = {}): HostToolAsk {
  if (args.gate !== undefined) {
    assertReviewEnum(args.gate, ["post-apply", "pre-commit", "pre-push", "pre-pr", "release"], "gate");
  }
  return buildHostToolAsk({
    permission: "host_review_validate",
    operation: "reviewValidate",
    summary: `Validate the review lifecycle${args.gate ? ` (gate ${args.gate})` : ""}`,
    details: reviewAskDetails({
      gate: args.gate,
      tokenDigest: reviewTokenDigest([args.contract, args.baseRef, args.lineage, args.policy]) || undefined,
    }),
  });
}

export interface ReviewRecoverAskArgs {
  actor?: string;
  disposition?: string;
  reason?: string;
  maintainerAuthorization?: string;
}

/** Approval metadata for `host_review_recover` (authorization JSON is redacted). */
export function buildReviewRecoverAsk(args: ReviewRecoverAskArgs = {}): HostToolAsk {
  if (args.disposition !== undefined) {
    assertReviewEnum(args.disposition, ["scope_changed", "invalidated", "escalated"], "disposition");
  }
  return buildHostToolAsk({
    permission: "host_review_recover",
    operation: "reviewRecover",
    summary: `Recover the review lifecycle${args.disposition ? ` (${args.disposition})` : ""}`,
    details: reviewAskDetails({
      actor: args.actor,
      disposition: args.disposition,
      reason: args.reason,
      maintainerAuthorization: args.maintainerAuthorization !== undefined ? "present (redacted)" : undefined,
    }),
  });
}
