import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { SddRuntimeExecutor } from "./sdd-runtime.ts";
import type { BrokerRequestEnvelope } from "./types.ts";
import { assertPayloadKeys, resolveProjectID, ValidationError } from "./validation.ts";
import { authorizeHostDispatch, type OpContext } from "./service.ts";
import { assertLegacySddEnabled } from "./legacy-sdd.ts";
import { markExternalLensLineage } from "./advisor-lineages.ts";
import { guardExternalLensCapture, relayAdvisorResponse } from "./advisor-relay.ts";
import { PolicyError } from "./policy.ts";

export interface SddOpContext extends OpContext {
  sddRuntime: SddRuntimeExecutor;
}

type SddPayload = Record<string, unknown>;

function payloadOf(req: BrokerRequestEnvelope): SddPayload {
  assertPayloadKeys(req.operation, req.payload);
  return (req.payload ?? {}) as SddPayload;
}

function requireProjectDir(payload: SddPayload): string {
  if (typeof payload.projectDir !== "string" || payload.projectDir.length === 0) {
    throw new ValidationError("projectDir must be a non-empty string");
  }
  return payload.projectDir;
}

function requireString(payload: SddPayload, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(payload: SddPayload, key: string): string | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`${key} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(payload: SddPayload, key: string): string[] {
  const value = payload[key];
  if (!Array.isArray(value)) {
    throw new ValidationError(`${key} must be an array`);
  }
  return value as string[];
}

// ---------------------------------------------------------------------------
// Reads (open to every agent, no approval prompt)
// ---------------------------------------------------------------------------

/** Host-side SDD status; deliberately has no worker/session dependency. */
export function buildSddStatusOp(ctx: SddOpContext) {
  return async (req: BrokerRequestEnvelope): Promise<unknown> => {
    assertLegacySddEnabled(ctx.config);
    const payload = payloadOf(req);
    authorizeHostDispatch(ctx, "sddStatus", req.sessionID, req.agent);
    return ctx.sddRuntime.status(requireProjectDir(payload), {
      change: optionalString(payload, "change"),
      contract: optionalString(payload, "contract"),
    });
  };
}

/** Host-side SDD continue; exact frozen argv without `--json`. */
export function buildSddContinueOp(ctx: SddOpContext) {
  return async (req: BrokerRequestEnvelope): Promise<unknown> => {
    assertLegacySddEnabled(ctx.config);
    const payload = payloadOf(req);
    authorizeHostDispatch(ctx, "sddContinue", req.sessionID, req.agent);
    return ctx.sddRuntime.sddContinue({
      projectDir: requireProjectDir(payload),
      change: optionalString(payload, "change"),
    });
  };
}

/** Read-only per-phase task-result validation. */
export function buildSddTaskResultOp(ctx: SddOpContext) {
  return async (req: BrokerRequestEnvelope): Promise<unknown> => {
    assertLegacySddEnabled(ctx.config);
    const payload = payloadOf(req);
    authorizeHostDispatch(ctx, "sddTaskResult", req.sessionID, req.agent);
    return ctx.sddRuntime.taskResult({
      projectDir: requireProjectDir(payload),
      phase: requireString(payload, "phase"),
      input: requireString(payload, "input"),
    });
  };
}

/** Read-only risk assessment (`review assess [--base-ref <ref>] --json`). */
export function buildReviewAssessOp(ctx: SddOpContext) {
  return async (req: BrokerRequestEnvelope): Promise<unknown> => {
    const payload = payloadOf(req);
    authorizeHostDispatch(ctx, "reviewAssess", req.sessionID, req.agent);
    return ctx.sddRuntime.reviewAssess({
      projectDir: requireProjectDir(payload),
      ...reviewOptional(payload, [
        "baseRef",
        "committedOnly",
        "untrackedScope",
        "expectedUntrackedInventory",
        "intendedUntracked",
      ]),
    });
  };
}

/** Read-only review mode status; tolerant of non-JSON stdout. */
export function buildReviewModeStatusOp(ctx: SddOpContext) {
  return async (req: BrokerRequestEnvelope): Promise<unknown> => {
    const payload = payloadOf(req);
    authorizeHostDispatch(ctx, "reviewModeStatus", req.sessionID, req.agent);
    return ctx.sddRuntime.reviewModeStatus({ projectDir: requireProjectDir(payload) });
  };
}

/**
 * Read-only review status envelope
 * (`review status --cwd <root> --contract gentle-ai.review-integration/v2
 * --agent <agent> --next-transition`); returned unchanged, never reshaped.
 */
export function buildReviewStatusOp(ctx: SddOpContext) {
  return async (req: BrokerRequestEnvelope): Promise<unknown> => {
    const payload = payloadOf(req);
    authorizeHostDispatch(ctx, "reviewStatus", req.sessionID, req.agent);
    return ctx.sddRuntime.reviewStatus({
      projectDir: requireProjectDir(payload),
      agent: optionalString(payload, "agent"),
      lineage: optionalString(payload, "lineage"),
      repositoryContext: optionalString(payload, "repositoryContext"),
      intendedUntrackedSelection: optionalString(payload, "intendedUntrackedSelection"),
      ...reviewOptional(payload, ["baseRef", "committedOnly"]),
      ...(payload.projection !== undefined
        ? { projection: payload.projection as "workspace" | "staged" }
        : {}),
    });
  };
}

/**
 * Read-only per-lens reviewer context. The broker returns the raw multi-line
 * reviewer block; it is plain text, never parsed as JSON.
 */
export function buildReviewLensContextOp(ctx: SddOpContext) {
  return async (req: BrokerRequestEnvelope): Promise<unknown> => {
    const payload = payloadOf(req);
    authorizeHostDispatch(ctx, "reviewLensContext", req.sessionID, req.agent);
    return ctx.sddRuntime.reviewLensContext({
      projectDir: requireProjectDir(payload),
      repositoryContext: requireString(payload, "repositoryContext"),
      lineage: requireString(payload, "lineage"),
      target: requireString(payload, "target"),
      expectedRevision: requireString(payload, "expectedRevision"),
      lens: requireString(payload, "lens"),
    });
  };
}

// ---------------------------------------------------------------------------
// Mutations (gentle-orchestrator only, fragment `ask` + in-tool `ctx.ask`)
// ---------------------------------------------------------------------------

/** Host-side attempt grant: registers canonical host roots for a caller token. */
export function buildSddAttemptGrantOp(ctx: SddOpContext) {
  return async (req: BrokerRequestEnvelope): Promise<unknown> => {
    assertLegacySddEnabled(ctx.config);
    const payload = payloadOf(req);
    authorizeHostDispatch(ctx, "sddAttemptGrant", req.sessionID, req.agent);
    return ctx.sddRuntime.attemptGrant({
      projectDir: requireProjectDir(payload),
      change: requireString(payload, "change"),
      ...(payload.expectedRevision !== undefined
        ? { expectedRevision: payload.expectedRevision as string }
        : {}),
      roots: requireStringArray(payload, "roots"),
      changeInstance: requireString(payload, "changeInstance"),
      requestId: requireString(payload, "requestId"),
      actor: requireString(payload, "actor"),
      reason: requireString(payload, "reason"),
    });
  };
}

/** Host-side deterministic archive-delta composition. */
export function buildSddArchiveComposeOp(ctx: SddOpContext) {
  return async (req: BrokerRequestEnvelope): Promise<unknown> => {
    assertLegacySddEnabled(ctx.config);
    const payload = payloadOf(req);
    authorizeHostDispatch(ctx, "sddArchiveCompose", req.sessionID, req.agent);
    return ctx.sddRuntime.archiveCompose({
      projectDir: requireProjectDir(payload),
      canonical: requireString(payload, "canonical"),
      delta: requireString(payload, "delta"),
      output: requireString(payload, "output"),
    });
  };
}

/** Optional review passthrough: only declared keys, never reconstructed. */
function reviewOptional(payload: SddPayload, keys: readonly string[]): SddPayload {
  const out: SddPayload = {};
  for (const key of keys) {
    if (payload[key] !== undefined) out[key] = payload[key];
  }
  return out;
}

const REVIEW_TRACE_REFUSAL =
  "reviewStart trace must resolve unambiguously outside the project root";

function assertTraceOutsideProject(projectDir: string, trace: unknown): void {
  if (typeof trace !== "string") throw new ValidationError(REVIEW_TRACE_REFUSAL);

  let projectRoot: string;
  try {
    projectRoot = realpathSync(projectDir);
  } catch {
    throw new ValidationError(REVIEW_TRACE_REFUSAL);
  }

  let candidate = resolve(projectRoot, trace);
  const missingParts: string[] = [];
  while (true) {
    try {
      candidate = resolve(realpathSync(candidate), ...[...missingParts].reverse());
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw new ValidationError(REVIEW_TRACE_REFUSAL);
      try {
        lstatSync(candidate);
        throw new ValidationError(REVIEW_TRACE_REFUSAL);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new ValidationError(REVIEW_TRACE_REFUSAL);
        }
      }
      const parent = dirname(candidate);
      if (parent === candidate) throw new ValidationError(REVIEW_TRACE_REFUSAL);
      missingParts.push(basename(candidate));
      candidate = parent;
    }
  }

  const fromRoot = relative(projectRoot, candidate);
  if (
    fromRoot === "" ||
    (!isAbsolute(fromRoot) &&
      fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`))
  ) {
    throw new ValidationError(REVIEW_TRACE_REFUSAL);
  }
}

/** Review start validates trace at the broker boundary, then preserves the provider token verbatim. */
export function buildReviewStartOp(ctx: SddOpContext) {
  return async (req: BrokerRequestEnvelope): Promise<unknown> => {
    const payload = payloadOf(req);
    authorizeHostDispatch(ctx, "reviewStart", req.sessionID, req.agent);
    const projectDir = requireProjectDir(payload);
    if (payload.trace !== undefined) assertTraceOutsideProject(projectDir, payload.trace);
    // External advisors (A4): an external-lens lineage starts WITHOUT a runtime
    // agent, so gentle-ai asks for reviewer results as files; the broker then
    // records the lineage so only stored advisor responses can fill it.
    const externalLenses = payload.externalLenses;
    if (externalLenses !== undefined && externalLenses !== true) {
      throw new ValidationError("externalLenses must be true when present");
    }
    if (externalLenses === true && payload.agent !== undefined) {
      throw new PolicyError("externalLenses starts a review without a runtime agent; do not pass agent");
    }
    const started = await ctx.sddRuntime.reviewStart({
      projectDir,
      ...reviewOptional(payload, [
        "agent",
        "contract",
        "target",
        "projection",
        "focus",
        "untrackedScope",
        "expectedUntrackedInventory",
        "intendedUntracked",
        "baseRef",
        "committedOnly",
        "workspaceOverlay",
        "lineage",
        "consent",
        "locale",
        "policy",
        "trace",
      ]),
    });
    if (externalLenses === true && started.status === 0) {
      const lineage = (started.json as { lineage_id?: unknown } | null)?.lineage_id;
      if (typeof lineage === "string") {
        markExternalLensLineage(ctx, resolveProjectID(projectDir, ctx.config.projects), lineage);
      }
    }
    return started;
  };
}

/**
 * Review capture-result. `input` (project-relative path or `-`) and
 * `inputJson` (inline body staged privately) are mutually exclusive; the
 * broker stages whichever is present as the private `--input` snapshot.
 */
export function buildReviewCaptureResultOp(ctx: SddOpContext) {
  return async (req: BrokerRequestEnvelope): Promise<unknown> => {
    const payload = payloadOf(req);
    authorizeHostDispatch(ctx, "reviewCaptureResult", req.sessionID, req.agent);
    const projectDir = requireProjectDir(payload);
    if (payload.inputFromAdvisorResponse !== undefined) {
      return relayAdvisorResponse(ctx, projectDir, payload);
    }
    guardExternalLensCapture(ctx, projectDir, payload);
    return ctx.sddRuntime.reviewCaptureResult({
      projectDir,
      ...reviewOptional(payload, [
        "agent",
        "input",
        "inputJson",
        "lens",
        "order",
        "target",
        "lineage",
        "expectedRevision",
        "repositoryContext",
        "subjectHash",
        "materialize",
        "preflight",
      ]),
    });
  };
}

/** Review capture-unachievable. */
export function buildReviewCaptureUnachievableOp(ctx: SddOpContext) {
  return async (req: BrokerRequestEnvelope): Promise<unknown> => {
    const payload = payloadOf(req);
    authorizeHostDispatch(ctx, "reviewCaptureUnachievable", req.sessionID, req.agent);
    return ctx.sddRuntime.reviewCaptureUnachievable({
      projectDir: requireProjectDir(payload),
      ...reviewOptional(payload, [
        "target",
        "lineage",
        "expectedRevision",
        "repositoryContext",
        "requestHash",
        "reason",
        "detail",
        "withdraw",
      ]),
    });
  };
}

/** Review acknowledge-approved: the four provider-issued values are forwarded verbatim. */
export function buildReviewAcknowledgeApprovedOp(ctx: SddOpContext) {
  return async (req: BrokerRequestEnvelope): Promise<unknown> => {
    const payload = payloadOf(req);
    authorizeHostDispatch(ctx, "reviewAcknowledgeApproved", req.sessionID, req.agent);
    return ctx.sddRuntime.reviewAcknowledgeApproved({
      projectDir: requireProjectDir(payload),
      ...reviewOptional(payload, ["lineage", "target", "expectedRevision", "token"]),
    });
  };
}

/** Review capture-correction-plan. */
export function buildReviewCaptureCorrectionPlanOp(ctx: SddOpContext) {
  return async (req: BrokerRequestEnvelope): Promise<unknown> => {
    const payload = payloadOf(req);
    authorizeHostDispatch(ctx, "reviewCaptureCorrectionPlan", req.sessionID, req.agent);
    return ctx.sddRuntime.reviewCaptureCorrectionPlan({
      projectDir: requireProjectDir(payload),
      ...reviewOptional(payload, [
        "target",
        "lineage",
        "expectedRevision",
        "repositoryContext",
        "requestHash",
        "correctionLines",
      ]),
    });
  };
}

/** Review capture-refuter. */
export function buildReviewCaptureRefuterOp(ctx: SddOpContext) {
  return async (req: BrokerRequestEnvelope): Promise<unknown> => {
    const payload = payloadOf(req);
    authorizeHostDispatch(ctx, "reviewCaptureRefuter", req.sessionID, req.agent);
    return ctx.sddRuntime.reviewCaptureRefuter({
      projectDir: requireProjectDir(payload),
      ...reviewOptional(payload, [
        "agent",
        "target",
        "lineage",
        "expectedRevision",
        "repositoryContext",
        "materialize",
        "execute",
      ]),
    });
  };
}

/** Review capture-validation. */
export function buildReviewCaptureValidationOp(ctx: SddOpContext) {
  return async (req: BrokerRequestEnvelope): Promise<unknown> => {
    const payload = payloadOf(req);
    authorizeHostDispatch(ctx, "reviewCaptureValidation", req.sessionID, req.agent);
    return ctx.sddRuntime.reviewCaptureValidation({
      projectDir: requireProjectDir(payload),
      ...reviewOptional(payload, [
        "agent",
        "target",
        "lineage",
        "expectedRevision",
        "repositoryContext",
        "requestHash",
        "materialize",
        "execute",
      ]),
    });
  };
}

/** Review validate. */
export function buildReviewValidateOp(ctx: SddOpContext) {
  return async (req: BrokerRequestEnvelope): Promise<unknown> => {
    const payload = payloadOf(req);
    authorizeHostDispatch(ctx, "reviewValidate", req.sessionID, req.agent);
    return ctx.sddRuntime.reviewValidate({
      projectDir: requireProjectDir(payload),
      ...reviewOptional(payload, [
        "contract",
        "gate",
        "baseRef",
        "lineage",
        "policy",
        "prePrCiAttestation",
        "releaseConfiguration",
        "releaseEvidenceFreshness",
        "releaseGenerated",
        "releaseProvenance",
        "releasePublicationBoundary",
      ]),
    });
  };
}

/** Review recover: maintainer authorization JSON is forwarded byte-for-byte. */
export function buildReviewRecoverOp(ctx: SddOpContext) {
  return async (req: BrokerRequestEnvelope): Promise<unknown> => {
    const payload = payloadOf(req);
    authorizeHostDispatch(ctx, "reviewRecover", req.sessionID, req.agent);
    return ctx.sddRuntime.reviewRecover({
      projectDir: requireProjectDir(payload),
      ...reviewOptional(payload, [
        "actor",
        "disposition",
        "expectedPredecessorRevision",
        "predecessorLineage",
        "successorLineage",
        "reason",
        "maintainerAuthorization",
        "baseRef",
        "committedOnly",
        "workspaceOverlay",
        "releaseScope",
        "projection",
        "untrackedScope",
        "expectedUntrackedInventory",
        "intendedUntracked",
        "focus",
        "policy",
      ]),
    });
  };
}
