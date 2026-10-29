/**
 * Stage A sandbox tools plugin (SYSTEM_PROMPT.md §12, §11, §28).
 *
 * Exposes the explicit `sandbox_*` tool family through the opencode 1.18.x
 * `tool` hook. Custom tools are declared by plugins in this version; there
 * are no .ts files under opencode/tools/ (see plugins/README.md).
 *
 * Lazy activation (§11): mutation tools (sandbox_write / sandbox_edit /
 * sandbox_apply_patch / sandbox_bash) call ensureWorker first; read tools do
 * NOT create a worker and fail with a clear error when none exists.
 *
 * sandbox_bash is NOT a shell: the command string is tokenized (whitespace +
 * quotes only) and every token is re-validated broker-side against the
 * §28 attack table. No globbing, expansion, redirection or pipes.
 *
 * sandbox_apply normally requires human approval via ctx.ask() before the
 * broker may apply the B->C delta (S15, §19.9).
 * sandbox_copy_out / sandbox_copy_in move
 * single files between the worker and the host under the same approval gate
 * (S15): the broker verifies the host path against the
 * BROKER_EXTERNAL_COPY_TARGETS allowlist before showing a preview and
 * requesting confirmation.
 *
 * Gate 1: NOT installed. Wiring is verified at Gate 4 against the installed
 * opencode 1.18.x plugin API (typings at ~/.opencode/node_modules/@opencode-ai/plugin).
 */
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import {
  type HostToolSpec,
  client,
  pathArg,
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
  reviewPipelineEnvelopeArg,
  reviewActorArg,
  reviewBaseRefArg,
  reviewCorrectionLinesArg,
  describeReviewInput,
  describeInlineReviewInput,
} from "./lib/tool-runtime.ts";
import { hostOpsToolSpecs } from "./lib/tool-specs-host-ops.ts";
import {
  hostResultToolSpecs,
} from "./lib/tool-specs-host-result.ts";
import {
  sandboxToolSpecs,
} from "./lib/tool-specs-sandbox.ts";
import {
  BIND_SESSION_AGENT_OPERATION,
  hostSessionBinding,
} from "./lib/session-agent-binding.ts";
import {
  buildReviewAcknowledgeApprovedAsk,
  buildReviewCaptureCorrectionPlanAsk,
  buildReviewCaptureRefuterAsk,
  buildReviewCaptureResultAsk,
  buildReviewCaptureUnachievableAsk,
  buildReviewCaptureValidationAsk,
  buildReviewRecoverAsk,
  assertReviewPersistPreflightClear,
  buildReviewPersistAsk,
  buildReviewStartAsk,
  buildReviewValidateAsk,
  buildRegisterProjectAsk,
} from "./lib/host-tool-approval.ts";
import {
  buildLegacySddTools,
  legacySddToolsEnabled,
} from "./lib/legacy-sdd-tools.ts";

/** V1 adapter: wrap each host-neutral spec with opencode's tool(). */
function toV1Tools(specs: Record<string, HostToolSpec>) {
  return Object.fromEntries(Object.entries(specs).map(([name, spec]) => [name, tool(spec as any)]));
}

export default function sandboxToolsPlugin() {
  return {
    tool: {
      ...toV1Tools(sandboxToolSpecs),

      ...toV1Tools(hostResultToolSpecs),

      host_review_assess: tool({
        description:
          "Run the read-only review risk assessment (no approval). baseRef selects an " +
          "immutable base-to-HEAD candidate; committedOnly acknowledges a committed-only " +
          "scope; untrackedScope/expectedUntrackedInventory/intendedUntracked forward the " +
          "provider's explicit untracked declaration verbatim. Returns JSON.",
        args: {
          baseRef: reviewBaseRefArg.optional(),
          committedOnly: z.boolean().optional(),
          untrackedScope: z.enum(["exclude", "select"]).optional(),
          expectedUntrackedInventory: untrackedInventoryArg.optional(),
          intendedUntracked: z.array(z.string().min(1).max(4096)).max(256).optional(),
        },
        execute: async (args, ctx) => {
          const c = await client();
          const result = await c.request("reviewAssess", ctx.sessionID, {
            projectDir: currentProjectDirectory(ctx.directory),
            ...(args.baseRef !== undefined ? { baseRef: args.baseRef } : {}),
            ...(args.committedOnly !== undefined
              ? { committedOnly: args.committedOnly }
              : {}),
            ...(args.untrackedScope !== undefined
              ? { untrackedScope: args.untrackedScope }
              : {}),
            ...(args.expectedUntrackedInventory !== undefined
              ? { expectedUntrackedInventory: args.expectedUntrackedInventory }
              : {}),
            ...(args.intendedUntracked !== undefined
              ? { intendedUntracked: args.intendedUntracked }
              : {}),
          }, ctx.agent);
          return JSON.stringify(result, null, 2);
        },
      }),

      host_review_mode_status: tool({
        description:
          "Read the review mode status (read-only; no approval). stdout may be " +
          "non-JSON; returned as text/json. Returns JSON.",
        args: {},
        execute: async (_args, ctx) => {
          const c = await client();
          const result = await c.request("reviewModeStatus", ctx.sessionID, {
            projectDir: currentProjectDirectory(ctx.directory),
          }, ctx.agent);
          return JSON.stringify(result, null, 2);
        },
      }),

      host_review_status: tool({
        description:
          "Read the review integration status envelope (read-only; no approval). " +
          "The broker returns the raw envelope unchanged. Returns JSON.",
        args: {
          agent: reviewAgentArg.optional(),
          lineage: reviewTokenArg.optional(),
          repositoryContext: reviewTokenArg.optional(),
          projection: reviewProjectionArg.optional(),
          baseRef: reviewBaseRefArg.optional(),
          committedOnly: z.boolean().optional(),
          intendedUntrackedSelection: z.string().min(1).max(65536).optional(),
        },
        execute: async (args, ctx) => {
          const c = await client();
          const result = await c.request("reviewStatus", ctx.sessionID, {
            projectDir: currentProjectDirectory(ctx.directory),
            ...(args.agent ? { agent: args.agent } : {}),
            ...(args.lineage !== undefined ? { lineage: args.lineage } : {}),
            ...(args.repositoryContext !== undefined
              ? { repositoryContext: args.repositoryContext }
              : {}),
            ...(args.projection !== undefined ? { projection: args.projection } : {}),
            ...(args.baseRef !== undefined ? { baseRef: args.baseRef } : {}),
            ...(args.committedOnly !== undefined
              ? { committedOnly: args.committedOnly }
              : {}),
            ...(args.intendedUntrackedSelection !== undefined
              ? { intendedUntrackedSelection: args.intendedUntrackedSelection }
              : {}),
          }, ctx.agent);
          return JSON.stringify(result, null, 2);
        },
      }),

      host_review_lens_context: tool({
        description:
          "Read the raw per-lens reviewer context block (read-only; no approval). " +
          "Returns the multi-line plain-text block (binding line plus " +
          "GENTLE_AI_REVIEW_CONTEXT ... END); it is never parsed as JSON. " +
          "Returns JSON.",
        args: {
          repositoryContext: reviewTokenArg,
          lineage: reviewTokenArg,
          target: reviewTokenArg,
          expectedRevision: reviewShaArg,
          lens: z.enum([
            "review-risk",
            "review-resilience",
            "review-readability",
            "review-reliability",
          ]),
        },
        execute: async (args, ctx) => {
          const c = await client();
          const result = await c.request("reviewLensContext", ctx.sessionID, {
            projectDir: currentProjectDirectory(ctx.directory),
            repositoryContext: args.repositoryContext,
            lineage: args.lineage,
            target: args.target,
            expectedRevision: args.expectedRevision,
            lens: args.lens,
          }, ctx.agent);
          return JSON.stringify(result, null, 2);
        },
      }),

      host_review_pipeline_run: tool({
        description:
          "Run one review pipeline phase using the pinned helper and publish its output only into the " +
          "broker-owned run store. Requires a runId from a prior host_review_materialize (or from a " +
          "prior pipeline phase for inputRef); the run directory must already exist. The helper and " +
          "interpreter are trusted; this operation does not write project content and does not require " +
          "approval. Returns JSON.",
        args: {
          phase: z.enum(["screen", "prepare", "merge", "finalize"]),
          reviewer: z.enum(["correctness", "testing", "project-standards", "maintainability", "security", "performance", "api-contract", "data-migrations", "reliability", "adversarial", "cli-readiness", "previous-comments", "kieran-typescript"]).optional(),
          stdin: z.union([
            z.string().max(256 * 1024),
            z.array(z.number().int().min(0).max(255)).max(256 * 1024),
          ]).optional(),
          inputRef: z.string().min(1).max(255).optional(),
          inputRefs: z.array(z.string().min(1).max(255)).max(16).optional(),
          adjudication: reviewPipelineEnvelopeArg,
          preparedRef: z.string().min(1).max(255).optional(),
          mergeRef: z.string().min(1).max(255).optional(),
          dispatch_records: reviewPipelineEnvelopeArg,
          validator_lifecycle_results: reviewPipelineEnvelopeArg,
          plan_assessment: reviewPipelineEnvelopeArg,
          parent_run_metadata: reviewPipelineEnvelopeArg,
          prepared: z.unknown().optional(),
          merge: z.unknown().optional(),
          screen_results: z.unknown().optional(),
          selected_dispatches: reviewPipelineEnvelopeArg.optional(),
          runId: z.string().regex(/^[a-f0-9]{32}$/),
        },
        execute: async (args, ctx) => {
          try {
            const c = await client();
            const payload = { projectDir: currentProjectDirectory(ctx.directory), ...args };
            const result = await c.request("reviewPipelineRun", ctx.sessionID, payload, ctx.agent);
            return JSON.stringify(result, null, 2);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const code = typeof error === "object" && error !== null && "code" in error
              ? (error as { code?: unknown }).code
              : undefined;
            throw new Error(
              `host_review_pipeline_run failed${typeof code === "string" ? ` [${code}]` : ""}: ${detail}`,
            );
          }
        },
      }),

      host_review_persist: tool({
        description:
          "Publish the recorded finalize artifact as review-summary.json in the canonical project run " +
          "directory, then validate it. Requires explicit approval because publication may replace " +
          "an existing summary and may create or change .context/.gitignore. Returns JSON.",
        args: {
          runId: z.string().regex(/^[a-f0-9]{32}$/),
          finalizeRef: z.string().min(1).max(255),
          mode: z.enum(["write", "report_only"]).optional(),
        },
        execute: async (args, ctx) => {
          const projectDir = currentProjectDirectory(ctx.directory);
          try {
            const c = await client();
            const payload = { projectDir, ...args };
            const preflight = await c.request("reviewPersistPreflight", ctx.sessionID, payload, ctx.agent) as {
              finalize: { name: string | null; bytes: number | null; sha256: string | null };
              baseObjectId: string | null; headObjectId: string | null; changedPaths: number;
              verdict: string | null; verdictSource: string | null; counts: Record<string, number>;
              finalizeInput: "stdin" | "inputRef" | "inputRefs" | "unknown";
              blockers: Array<{ code: string; message: string }>;
            };
            assertReviewPersistPreflightClear(preflight.blockers);
            await ctx.ask(buildReviewPersistAsk({ projectDir, runId: args.runId, finalizeRef: args.finalizeRef, mode: args.mode, preflight }));
            const result = await c.request("reviewPersist", ctx.sessionID, payload, ctx.agent);
            return JSON.stringify(result, null, 2);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const code = typeof error === "object" && error !== null && "code" in error
              ? (error as { code?: unknown }).code
              : undefined;
            throw new Error(
              `host_review_persist failed${typeof code === "string" ? ` [${code}]` : ""}: ${detail}`,
            );
          }
        },
      }),

      host_review_diff_read: tool({
        description:
          "Read a bounded diff for a review run owned by the caller. A text diff returns `text` " +
          "with `sha256` and `bytes` and no `data`; a binary diff returns `data` with " +
          "`binary: true` and no `text`. Never forward `data` into a prompt." ,
        args: {
          runId: z.string().regex(/^[a-f0-9]{32}$/),
          slice: z.string().regex(/^slice-[0-9]{4}\.diff$/).optional(),
        },
        execute: async (args, ctx) => {
          try {
            const c = await client();
            const result = await c.request("reviewDiffRead", ctx.sessionID, {
              projectDir: currentProjectDirectory(ctx.directory),
              runId: args.runId,
              ...(args.slice !== undefined ? { slice: args.slice } : {}),
            }, ctx.agent);
            return JSON.stringify(result, null, 2);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const code = typeof error === "object" && error !== null && "code" in error
              ? (error as { code?: unknown }).code
              : undefined;
            const errorCode = typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : undefined;
            const wrapped = new Error(`host_review_diff_read failed${errorCode ? ` [${errorCode}]` : ""}: ${detail}`);
            if (errorCode) Object.assign(wrapped, { code: errorCode });
            throw wrapped;
          }
        },
      }),

      host_review_materialize: tool({
        description:
          "This tool materializes a git range into the broker-owned run store, writes nothing into the " +
          "project, and returns only a bounded index (never diff text). reviewers are expected " +
          "to fetch slices separately.",
        args: {
          baseRef: z.string().min(1).max(4096),
          headRef: z.string().min(1).max(4096).optional(),
          contextLines: z.number().int().min(0).max(100).optional(),
          paths: z.array(z.string().min(1).max(4096)).max(256).optional(),
        },
        execute: async (args, ctx) => {
          try {
            const c = await client();
            const payload = {
              projectDir: currentProjectDirectory(ctx.directory),
              ...args,
            };
            const result = await c.request("reviewMaterialize", ctx.sessionID, payload, ctx.agent);
            return JSON.stringify(result, null, 2);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const code = typeof error === "object" && error !== null && "code" in error
              ? (error as { code?: unknown }).code
              : undefined;
            throw new Error(
              `host_review_materialize failed${typeof code === "string" ? ` [${code}]` : ""}: ${detail}`,
            );
          }
        },
      }),

      ...toV1Tools(hostOpsToolSpecs),

      host_review_start: tool({
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

      host_review_capture_result: tool({
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

      host_review_capture_unachievable: tool({
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

      host_review_acknowledge_approved: tool({
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

      host_review_capture_correction_plan: tool({
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

      host_review_capture_refuter: tool({
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

      host_review_capture_validation: tool({
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

      host_review_validate: tool({
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

      host_review_recover: tool({
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

      host_register_project: tool({
        description: "Register a new project with the agentic sandbox system (host-side, creates .atl, updates profile/broker/launcher). Path must be absolute.",
        args: { path: pathArg, dryRun: z.boolean().optional(), createRemote: z.boolean().optional(), makePublic: z.boolean().optional() },
        execute: async (args, ctx) => {
          await ctx.ask(
            buildRegisterProjectAsk({
              path: args.path,
              dryRun: !!args.dryRun,
              createRemote: !!args.createRemote,
              makePublic: !!args.makePublic,
            }),
          );
          const c = await client();
          const result = await c.request("registerProject", ctx.sessionID, { path: args.path, dryRun: !!args.dryRun, createRemote: !!args.createRemote, makePublic: !!args.makePublic }, ctx.agent);
          return JSON.stringify(result, null, 2);
        },
      }),

      // gentle-ai 4 retired SDD: the five host_sdd_* tools are dormant unless
      // OPENCODE_SANDBOX_LEGACY_SDD=1 (rollback to 3.x). See lib/legacy-sdd-tools.ts.
      ...(legacySddToolsEnabled()
        ? buildLegacySddTools({
            client,
            projectDirectory: currentProjectDirectory,
            revisionArg: untrackedInventoryArg,
          })
        : {}),
    },
    "chat.params": async (input: unknown) => {
      // Host-authoritative session->agent binding: the broker records who the
      // host says the session is. Authorization remains in the role matrix, so
      // an unknown identity binds and is then denied. Best-effort failure
      // leaves host mutations failing closed rather than blocking the chat.
      const binding = hostSessionBinding(
        input,
        [typeof input === "object" && input !== null && "agent" in input && typeof input.agent === "string" ? input.agent : ""],
      );
      if (!binding) return;
      try {
        const c = await client();
        await c.request(BIND_SESSION_AGENT_OPERATION, binding.sessionID, {
          agent: binding.agent,
        });
      } catch {
        /* unbound sessions cannot run host mutations (fail closed) */
      }
    },
  };
}
