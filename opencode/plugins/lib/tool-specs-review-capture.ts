/**
 * Host-neutral tool table: reviewCaptureToolSpecs (P0, docs/upgrades/opencode-v2.md).
 * Plain tool specs, no OpenCode plugin API. The V1 adapter (sandbox-tools.ts) wraps them with tool().
 */
import { z } from "zod";
import {
  buildReviewAcknowledgeApprovedAsk,
  buildReviewCaptureCorrectionPlanAsk,
  buildReviewCaptureRefuterAsk,
  buildReviewCaptureResultAsk,
  buildReviewCaptureUnachievableAsk,
  buildReviewCaptureValidationAsk,
  buildReviewRecoverAsk,
  buildReviewStartAsk,
  buildReviewValidateAsk,
} from "./host-tool-approval.ts";
import {
  defineTool,
  client,
  untrackedInventoryArg,
  reviewAgentArg,
  currentProjectDirectory,
  reviewTokenArg,
  reviewShaArg,
  reviewProjectionArg,
  reviewFocusArg,
  reviewConsentArg,
  reviewLocaleArg,
  reviewGateArg,
  reviewDispositionArg,
  reviewOrderArg,
  reviewReasonArg,
  reviewDetailArg,
  reviewActorArg,
  reviewBaseRefArg,
  reviewCorrectionLinesArg,
  describeReviewInput,
  describeInlineReviewInput,
} from "./tool-runtime.ts";

export const reviewCaptureToolSpecs = {
  host_review_start: defineTool({
    description:
      "Start a review lifecycle run (orchestrator-only mutation; requires human " +
      "approval). Provider-issued tokens are forwarded verbatim. Returns JSON.",
    args: {
      agent: reviewAgentArg.optional(),
      contract: reviewTokenArg.optional(),
      target: reviewTokenArg.optional(),
      projection: reviewProjectionArg.optional(),
      focus: reviewFocusArg.optional(),
      untrackedScope: z.enum(["exclude", "select"]).optional(),
      expectedUntrackedInventory: untrackedInventoryArg.optional(),
      intendedUntracked: z.array(z.string().min(1).max(4096)).max(256).optional(),
      baseRef: reviewBaseRefArg.optional(),
      committedOnly: z.boolean().optional(),
      workspaceOverlay: z.boolean().optional(),
      lineage: reviewTokenArg.optional(),
      consent: reviewConsentArg.optional(),
      locale: reviewLocaleArg.optional(),
      policy: reviewTokenArg.optional(),
      trace: reviewTokenArg.optional(),
    },
    execute: async (args, ctx) => {
      await ctx.ask(buildReviewStartAsk(args));
      const c = await client();
      const result = await c.request("reviewStart", ctx.sessionID, {
        projectDir: currentProjectDirectory(ctx.directory),
        ...args,
      }, ctx.agent);
      return JSON.stringify(result, null, 2);
    },
  }),

  host_review_capture_result: defineTool({
    description:
      "Capture a review result (orchestrator-only mutation; requires human approval). " +
      "Provide exactly one of input (a project-relative path or '-') or inputJson " +
      "(an inline JSON body); the broker stages a private immutable snapshot " +
      "outside the project tree. Returns JSON.",
    args: {
      agent: reviewAgentArg.optional(),
      input: z.string().min(1).max(4096).optional(),
      inputJson: z.string().min(1).optional(),
      lens: reviewTokenArg.optional(),
      order: reviewOrderArg.optional(),
      target: reviewTokenArg.optional(),
      lineage: reviewTokenArg.optional(),
      expectedRevision: reviewShaArg.optional(),
      repositoryContext: reviewTokenArg.optional(),
      subjectHash: reviewShaArg.optional(),
      materialize: z.boolean().optional(),
      preflight: z.boolean().optional(),
    },
    execute: async (args, ctx) => {
      const projectDir = currentProjectDirectory(ctx.directory);
      const { inputJson, ...askArgs } = args;
      await ctx.ask(buildReviewCaptureResultAsk({
        ...askArgs,
        ...describeReviewInput(projectDir, args.input),
        ...describeInlineReviewInput(inputJson),
      }));
      const c = await client();
      const result = await c.request("reviewCaptureResult", ctx.sessionID, {
        projectDir,
        ...args,
      }, ctx.agent);
      return JSON.stringify(result, null, 2);
    },
  }),

  host_review_capture_unachievable: defineTool({
    description:
      "Record an unachievable review outcome (orchestrator-only mutation; requires " +
      "human approval). Returns JSON.",
    args: {
      target: reviewTokenArg.optional(),
      lineage: reviewTokenArg.optional(),
      expectedRevision: reviewShaArg.optional(),
      repositoryContext: reviewTokenArg.optional(),
      requestHash: reviewShaArg.optional(),
      reason: reviewReasonArg.optional(),
      detail: reviewDetailArg.optional(),
      withdraw: z.boolean().optional(),
    },
    execute: async (args, ctx) => {
      await ctx.ask(buildReviewCaptureUnachievableAsk(args));
      const c = await client();
      const result = await c.request("reviewCaptureUnachievable", ctx.sessionID, {
        projectDir: currentProjectDirectory(ctx.directory),
        ...args,
      }, ctx.agent);
      return JSON.stringify(result, null, 2);
    },
  }),

  host_review_acknowledge_approved: defineTool({
    description:
      "Acknowledge the approved review authority (orchestrator-only mutation; requires " +
      "human approval). The four provider-issued continuation values are forwarded " +
      "verbatim. Returns JSON.",
    args: {
      lineage: reviewTokenArg,
      target: reviewTokenArg,
      expectedRevision: reviewShaArg,
      token: reviewTokenArg,
    },
    execute: async (args, ctx) => {
      await ctx.ask(buildReviewAcknowledgeApprovedAsk(args));
      const c = await client();
      const result = await c.request("reviewAcknowledgeApproved", ctx.sessionID, {
        projectDir: currentProjectDirectory(ctx.directory),
        ...args,
      }, ctx.agent);
      return JSON.stringify(result, null, 2);
    },
  }),

  host_review_capture_correction_plan: defineTool({
    description:
      "Capture a review correction plan (orchestrator-only mutation; requires human " +
      "approval). Returns JSON.",
    args: {
      target: reviewTokenArg.optional(),
      lineage: reviewTokenArg.optional(),
      expectedRevision: reviewShaArg.optional(),
      repositoryContext: reviewTokenArg.optional(),
      requestHash: reviewShaArg.optional(),
      correctionLines: reviewCorrectionLinesArg.optional(),
    },
    execute: async (args, ctx) => {
      await ctx.ask(buildReviewCaptureCorrectionPlanAsk(args));
      const c = await client();
      const result = await c.request("reviewCaptureCorrectionPlan", ctx.sessionID, {
        projectDir: currentProjectDirectory(ctx.directory),
        ...args,
      }, ctx.agent);
      return JSON.stringify(result, null, 2);
    },
  }),

  host_review_capture_refuter: defineTool({
    description:
      "Capture a refuter result (orchestrator-only mutation; requires human approval). " +
      "materialize/execute are emitted only from the provider-returned continuation. " +
      "Returns JSON.",
    args: {
      agent: reviewAgentArg.optional(),
      target: reviewTokenArg.optional(),
      lineage: reviewTokenArg.optional(),
      expectedRevision: reviewShaArg.optional(),
      repositoryContext: reviewTokenArg.optional(),
      materialize: z.boolean().optional(),
      execute: z.boolean().optional(),
    },
    execute: async (args, ctx) => {
      await ctx.ask(buildReviewCaptureRefuterAsk(args));
      const c = await client();
      const result = await c.request("reviewCaptureRefuter", ctx.sessionID, {
        projectDir: currentProjectDirectory(ctx.directory),
        ...args,
      }, ctx.agent);
      return JSON.stringify(result, null, 2);
    },
  }),

  host_review_capture_validation: defineTool({
    description:
      "Capture a validation result (orchestrator-only mutation; requires human " +
      "approval). materialize/execute are emitted only from the provider-returned " +
      "continuation. Returns JSON.",
    args: {
      agent: reviewAgentArg.optional(),
      target: reviewTokenArg.optional(),
      lineage: reviewTokenArg.optional(),
      expectedRevision: reviewShaArg.optional(),
      repositoryContext: reviewTokenArg.optional(),
      requestHash: reviewShaArg.optional(),
      materialize: z.boolean().optional(),
      execute: z.boolean().optional(),
    },
    execute: async (args, ctx) => {
      await ctx.ask(buildReviewCaptureValidationAsk(args));
      const c = await client();
      const result = await c.request("reviewCaptureValidation", ctx.sessionID, {
        projectDir: currentProjectDirectory(ctx.directory),
        ...args,
      }, ctx.agent);
      return JSON.stringify(result, null, 2);
    },
  }),

  host_review_validate: defineTool({
    description:
      "Validate the review lifecycle (orchestrator-only mutation; requires human " +
      "approval). gate is an allowlisted enum; release/attestation values are passed " +
      "verbatim. Returns JSON.",
    args: {
      contract: reviewTokenArg.optional(),
      gate: reviewGateArg.optional(),
      baseRef: reviewBaseRefArg.optional(),
      lineage: reviewTokenArg.optional(),
      policy: reviewTokenArg.optional(),
      prePrCiAttestation: reviewTokenArg.optional(),
      releaseConfiguration: reviewTokenArg.optional(),
      releaseEvidenceFreshness: reviewTokenArg.optional(),
      releaseGenerated: reviewTokenArg.optional(),
      releaseProvenance: reviewTokenArg.optional(),
      releasePublicationBoundary: reviewTokenArg.optional(),
    },
    execute: async (args, ctx) => {
      await ctx.ask(buildReviewValidateAsk(args));
      const c = await client();
      const result = await c.request("reviewValidate", ctx.sessionID, {
        projectDir: currentProjectDirectory(ctx.directory),
        ...args,
      }, ctx.agent);
      return JSON.stringify(result, null, 2);
    },
  }),

  host_review_recover: defineTool({
    description:
      "Recover the review lifecycle (orchestrator-only mutation; requires human " +
      "approval). maintainerAuthorization is forwarded byte-for-byte and never shown in " +
      "the approval metadata. Returns JSON.",
    args: {
      actor: reviewActorArg.optional(),
      disposition: reviewDispositionArg.optional(),
      expectedPredecessorRevision: reviewShaArg.optional(),
      predecessorLineage: reviewTokenArg.optional(),
      successorLineage: reviewTokenArg.optional(),
      reason: reviewReasonArg.optional(),
      maintainerAuthorization: z.string().min(1).max(65536).optional(),
      baseRef: reviewBaseRefArg.optional(),
      committedOnly: z.boolean().optional(),
      workspaceOverlay: z.boolean().optional(),
      releaseScope: z.boolean().optional(),
      projection: reviewProjectionArg.optional(),
      untrackedScope: z.enum(["exclude", "select"]).optional(),
      expectedUntrackedInventory: untrackedInventoryArg.optional(),
      intendedUntracked: z.array(z.string().min(1).max(4096)).max(256).optional(),
      focus: z.string().min(1).max(128).optional(),
      policy: reviewTokenArg.optional(),
    },
    execute: async (args, ctx) => {
      await ctx.ask(buildReviewRecoverAsk(args));
      const c = await client();
      const result = await c.request("reviewRecover", ctx.sessionID, {
        projectDir: currentProjectDirectory(ctx.directory),
        ...args,
      }, ctx.agent);
      return JSON.stringify(result, null, 2);
    },
  }),
};
