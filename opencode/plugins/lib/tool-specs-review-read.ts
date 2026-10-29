/**
 * Host-neutral tool table: reviewReadToolSpecs (P0, docs/upgrades/opencode-v2.md).
 * Plain tool specs, no OpenCode plugin API. The V1 adapter (sandbox-tools.ts) wraps them with tool().
 */
import { z } from "zod";
import {
  assertReviewPersistPreflightClear,
  buildReviewPersistAsk,
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
  reviewPipelineEnvelopeArg,
  reviewBaseRefArg,
} from "./tool-runtime.ts";

export const reviewReadToolSpecs = {
  host_review_assess: defineTool({
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

  host_review_mode_status: defineTool({
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

  host_review_status: defineTool({
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

  host_review_lens_context: defineTool({
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

  host_review_pipeline_run: defineTool({
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

  host_review_persist: defineTool({
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

  host_review_diff_read: defineTool({
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

  host_review_materialize: defineTool({
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
};
