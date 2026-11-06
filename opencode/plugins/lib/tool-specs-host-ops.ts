/**
 * Host-neutral tool table: hostOpsToolSpecs (P0, docs/upgrades/opencode-v2.md).
 * Plain tool specs, no OpenCode plugin API. The V1 adapter (sandbox-tools.ts) wraps them with tool().
 */
import { z } from "zod";
import {
  buildGhIssueCreateAsk,
  buildGitCommitAsk,
  buildPlanDocAppendAsk,
  buildGitPushAsk,
} from "./host-tool-approval.ts";
import {
  defineTool,
  client,
  sessionIdArg,
  currentProjectDirectory,
} from "./tool-runtime.ts";

const stageIdArgs = {
  chainID: z.string().regex(/^c[0-9a-f]{12}$/),
  n: z.number().int().min(1).max(99),
  result: z.string().regex(/^[0-9a-f]{40}$/),
};

/** The approval prompt for a stage decision: names the stage, the exact commit and the broker's own view of it (never the agent's summary). */
async function stageDecisionAsk(
  ctx: { sessionID: string; agent?: string },
  permission: "host_stage_approve" | "host_stage_reject" | "host_stage_apply",
  args: { chainID: string; n: number; result: string },
  extra: Record<string, unknown> = {},
) {
  const c = await client();
  const { stage } = (await c.request("stageShow", ctx.sessionID, { chainID: args.chainID, n: args.n }, ctx.agent)) as {
    stage: { changedPaths?: string[]; touchesProtected?: boolean };
  };
  return {
    permission,
    patterns: ["*"],
    always: [],
    metadata: {
      summary: `${permission.replace("host_stage_", "")} stage ${args.n} of chain ${args.chainID} at commit ${args.result}${stage.touchesProtected ? " (touches protected S17 paths)" : ""}`,
      ...args,
      changedPaths: stage.changedPaths ?? [],
      touchesProtected: stage.touchesProtected === true,
      ...extra,
    },
  };
}

export const hostOpsToolSpecs = {
  host_git_commit: defineTool({
    description:
      "Commit exactly an applied B→C result's paths (orchestrator-only mutation; " +
      "requires human approval). The broker derives paths from the persisted baseline/result " +
      "refs, rejects protected paths (S17) and an empty result, and never uses `git add -A`. " +
      "By default the caller's own applied result is committed; sandboxSessionID commits " +
      "the applied result of that delegated sandbox session instead. Returns JSON.",
    args: {
      message: z.string().min(1).max(4096),
      sandboxSessionID: sessionIdArg.optional(),
    },
    execute: async (args, ctx) => {
      await ctx.ask(
        buildGitCommitAsk({
          message: args.message,
          ...(args.sandboxSessionID !== undefined
            ? { sandboxSessionID: args.sandboxSessionID }
            : {}),
        }),
      );
      const c = await client();
      const result = await c.request("gitCommit", ctx.sessionID, {
        projectDir: currentProjectDirectory(ctx.directory),
        message: args.message,
        ...(args.sandboxSessionID !== undefined
          ? { sandboxSessionID: args.sandboxSessionID }
          : {}),
      }, ctx.agent);
      return JSON.stringify(result, null, 2);
    },
  }),

  host_git_clear_commit_intent: defineTool({
    description:
      "Clear only a pending host-commit intent for the current session or the selected delegated session (orchestrator-only; requires human approval). " +
      "Refuses when no intent exists, and reports the result commit and recorded parent that were cleared. " +
      "Does not alter the session state, installed/committed markers, working tree, index, or refs. Returns JSON.",
    args: { sandboxSessionID: sessionIdArg.optional() },
    execute: async (args, ctx) => {
      await ctx.ask({
        permission: "host_git_clear_commit_intent",
        patterns: ["*"],
        always: [],
        metadata: {
          summary: `Clear the pending host-commit intent for session ${args.sandboxSessionID ?? ctx.sessionID}`,
          sessionID: args.sandboxSessionID ?? ctx.sessionID,
        },
      });
      const c = await client();
      const result = await c.request("gitClearCommitIntent", ctx.sessionID, {
        projectDir: currentProjectDirectory(ctx.directory),
        ...(args.sandboxSessionID !== undefined ? { sandboxSessionID: args.sandboxSessionID } : {}),
      }, ctx.agent);
      return JSON.stringify(result, null, 2);
    },
  }),

  host_git_push: defineTool({
    description:
      "Push the current branch with the broker-resolved remote/branch (orchestrator-only " +
      "mutation; requires human approval). Refuses detached HEAD, missing upstream without " +
      "setUpstream, main/master without allowProtectedBranch, and force/delete/refspec forms. " +
      "Returns JSON.",
    args: {
      remote: z.string().regex(/^[A-Za-z0-9._-]{1,255}$/).optional(),
      setUpstream: z.boolean().optional(),
      allowProtectedBranch: z.boolean().optional(),
    },
    execute: async (args, ctx) => {
      const remote = args.remote ?? "origin";
      await ctx.ask(buildGitPushAsk({
        remote,
        branch: "(broker-resolved)",
        ahead: 0,
        upstream: null,
        setUpstream: args.setUpstream === true,
      }));
      const c = await client();
      const result = await c.request("gitPush", ctx.sessionID, {
        projectDir: currentProjectDirectory(ctx.directory),
        remote,
        ...(args.setUpstream !== undefined ? { setUpstream: args.setUpstream } : {}),
        ...(args.allowProtectedBranch !== undefined ? { allowProtectedBranch: args.allowProtectedBranch } : {}),
      }, ctx.agent);
      return JSON.stringify(result, null, 2);
    },
  }),

  host_gh_issue_create: defineTool({
    description:
      "Create a GitHub issue with fixed argv (orchestrator-only mutation; requires human " +
      "approval). Only `gh issue create --repo <repo> --title <title> --body <body>` runs; " +
      "values are capped (repo/title 256 bytes, body 65536 bytes). Returns JSON.",
    args: {
      repo: z.string().min(1).max(256),
      title: z.string().min(1).max(256),
      body: z.string().max(65536),
    },
    execute: async (args, ctx) => {
      await ctx.ask(buildGhIssueCreateAsk({ repo: args.repo, title: args.title, body: args.body }));
      const c = await client();
      const result = await c.request("ghIssueCreate", ctx.sessionID, {
        projectDir: currentProjectDirectory(ctx.directory),
        repo: args.repo,
        title: args.title,
        body: args.body,
      }, ctx.agent);
      return JSON.stringify(result, null, 2);
    },
  }),

  host_test_run: defineTool({
    description:
      "Run one broker-configured test runner against the current working tree of a registered project, including uncommitted changes. " +
      "The result reports gitHead, dirtyPaths, and worktreeDigest so the caller knows which bytes ran. " +
      "The broker owns the fixed executable, argv, environment, timeout, output cap, and log artifact; no command text is accepted. Returns JSON.",
    args: { runner: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/) },
    execute: async (args, ctx) => {
      // The broker records pre-run provenance for the current working tree, including uncommitted changes.
      const c = await client();
      const result = await c.request("testRun", ctx.sessionID, {
        projectDir: currentProjectDirectory(ctx.directory),
        runner: args.runner,
      }, ctx.agent);
      return JSON.stringify(result, null, 2);
    },
  }),

  host_plan_write: defineTool({
    description:
      "Replace one allowlisted odd/tasks or odd/mini plan document using an expected revision. " +
      "Plan text is not authority; trust decisions remain in host_gate_verdict and host_task_mark. " +
      "No approval is requested because the revision log is the compensating control. Returns JSON.",
    args: {
      target: z.enum(["tasks", "mini"]),
      name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
      content: z.string().min(1).max(256 * 1024),
      expectedRevision: z.number().int().min(0),
      note: z.string().min(1).max(200),
    },
    execute: async (args, ctx) => {
      // Plan text is not authority: trust is decided by host_gate_verdict and host_task_mark;
      // the append-only revision log is the compensating control for this no-approval write.
      const c = await client();
      const result = await c.request("planDocWrite", ctx.sessionID, {
        projectDir: currentProjectDirectory(ctx.directory),
        ...args,
        agent: ctx.agent,
      }, ctx.agent);
      return JSON.stringify(result, null, 2);
    },
  }),

  host_task_mark: defineTool({
    description:
      "Record a PM-authored task mark with broker-derived review tier from evidenceCommit. " +
      "Assessment failure means high tier. Only PM identities may call this tool. A gated tick " +
      "requires gateRef: the verdictHash returned by host_gate_verdict for the latest PASS on " +
      "this task, required by the broker whenever the document has a `## Gates` section; " +
      "omitting it fails with TASK_MARK_GATE_REF_REQUIRED. evidenceBaseRef is the base commit " +
      "for the review assessment; omit it to let the broker use the evidence commit's first " +
      "parent. Returns JSON.",
    args: {
      target: z.enum(["tasks", "mini"]),
      name: z.string().min(1).max(64),
      taskId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
      status: z.enum(["passed", "failed"]),
      evidenceCommit: z.string().length(40),
      gateRef: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
      evidenceBaseRef: z.string().length(40).optional(),
      note: z.string().max(200).optional(),
    },
    execute: async (args, ctx) => {
      const c = await client();
      const result = await c.request("taskMark", ctx.sessionID, {
        projectDir: currentProjectDirectory(ctx.directory),
        ...args,
      }, ctx.agent);
      return JSON.stringify(result, null, 2);
    },
  }),

  host_gate_verdict: defineTool({
    description:
      "Record a planner gate verdict in the append-only gate log at the end of an existing task document. " +
      "Plan text is not authority; the broker validates the planner identity and preserves every prior verdict. " +
      "No approval is requested because the append-only gate log is the compensating control. Returns JSON.",
    args: {
      name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
      taskId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
      verdict: z.enum(["PASS", "REFINE", "ESCALATE"]),
      refinementPlan: z.string().max(600).optional(),
      evidenceRef: z.string().max(200).optional(),
    },
    execute: async (args, ctx) => {
      // The append-only gate log is the compensating control for this no-approval verdict write.
      const c = await client();
      const result = await c.request("gateVerdict", ctx.sessionID, {
        projectDir: currentProjectDirectory(ctx.directory),
        ...args,
        agent: ctx.agent,
      }, ctx.agent);
      return JSON.stringify(result, null, 2);
    },
  }),

  host_plan_append: defineTool({
    description:
      "Append approved content to an allowlisted plan document (orchestrator-only mutation; " +
      "requires human approval). doc is an enum: todo -> docs/TODO.md, plan -> docs/PLAN.md. " +
      "The broker preserves existing bytes, creates the document when absent, and writes " +
      "atomically; optional heading inserts before the next heading of equal or higher level. " +
      "Returns JSON.",
    args: {
      doc: z.enum(["todo", "plan"]),
      content: z.string().min(1).max(16384),
      heading: z.string().min(1).max(256).optional(),
    },
    execute: async (args, ctx) => {
      await ctx.ask(buildPlanDocAppendAsk({
        doc: args.doc,
        content: args.content,
        ...(args.heading !== undefined ? { heading: args.heading } : {}),
      }));
      const c = await client();
      const result = await c.request("planDocAppend", ctx.sessionID, {
        projectDir: currentProjectDirectory(ctx.directory),
        doc: args.doc,
        content: args.content,
        ...(args.heading !== undefined ? { heading: args.heading } : {}),
      }, ctx.agent);
      return JSON.stringify(result, null, 2);
    },
  }),

  host_orca_report: defineTool({
    description:
      "Report back to the Orca coordinator that dispatched this worker (no human approval; " +
      "low impact). One fixed Orca CLI runs with a fixed argv: only worker_done, ask and " +
      "heartbeat are allowed, the recipient is the terminal handle you supply, and no other " +
      "flag can be passed. The broker validates every field (terminal ^term_[0-9a-f-]{36}$, " +
      "taskId ^task_[0-9a-f]{12}$, dispatchId ^ctx_[0-9a-f]{12}$, outcome " +
      "succeeded|failed|blocked, subject <= 120 chars, body <= 4096 bytes, no control " +
      "characters) and refuses unless the dispatch is live for that terminal handle. " +
      "worker_done needs subject, body and outcome; ask needs body (the question) and optional " +
      "options; heartbeat needs subject and phase. Returns JSON.",
    args: {
      terminal: z.string().regex(/^term_[0-9a-f-]{36}$/),
      taskId: z.string().regex(/^task_[0-9a-f]{12}$/),
      dispatchId: z.string().regex(/^ctx_[0-9a-f]{12}$/),
      type: z.enum(["worker_done", "ask", "heartbeat"]),
      subject: z.string().min(1).max(120).optional(),
      body: z.string().min(1).max(4096).optional(),
      outcome: z.enum(["succeeded", "failed", "blocked"]).optional(),
      options: z.array(z.string().min(1).max(120)).max(8).optional(),
      phase: z.string().min(1).max(40).optional(),
    },
    execute: async (args, ctx) => {
      // Fixed binary/argv and a live-dispatch probe are broker-side; the caller
      // cannot choose the recipient or add a flag, so no approval is requested.
      const c = await client();
      const result = await c.request("orcaReport", ctx.sessionID, { ...args }, ctx.agent);
      return JSON.stringify(result, null, 2);
    },
  }),

  host_stage_list: defineTool({
    description:
      "List the stages of one staging chain (stage-review agent only; read-only, no approval). " +
      "Each stage reports its number, state (BUILDING or READY), baseline, result commit, " +
      "changed paths and whether it touches a protected (S17) path. The broker reads the " +
      "pinned stage refs, never a session result ref. Returns JSON.",
    args: { chainID: z.string().regex(/^c[0-9a-f]{12}$/) },
    execute: async (args, ctx) => {
      const c = await client();
      const result = await c.request("stageList", ctx.sessionID, { chainID: args.chainID }, ctx.agent);
      return JSON.stringify(result, null, 2);
    },
  }),

  host_stage_show: defineTool({
    description:
      "Show one stage of a staging chain (stage-review agent only; read-only, no approval): " +
      "the chain header plus the stage's state, baseline, result commit, changed paths and " +
      "protected-path (S17) flag, from the pinned stage ref. Returns JSON.",
    args: {
      chainID: z.string().regex(/^c[0-9a-f]{12}$/),
      n: z.number().int().min(1).max(99),
    },
    execute: async (args, ctx) => {
      const c = await client();
      const result = await c.request("stageShow", ctx.sessionID, { chainID: args.chainID, n: args.n }, ctx.agent);
      return JSON.stringify(result, null, 2);
    },
  }),

  host_stage_approve: defineTool({
    description:
      "Approve one READY stage of a staging chain (stage-review agent only; owner decision, requires human approval). " +
      "Name the stage's result commit from host_stage_show; the broker refuses if it no longer matches. " +
      "A stage touching protected (S17) paths needs confirmProtected: true, per stage. Approving applies nothing. Returns JSON.",
    args: { ...stageIdArgs, confirmProtected: z.boolean().optional() },
    execute: async (args, ctx) => {
      await ctx.ask(await stageDecisionAsk(ctx, "host_stage_approve", args));
      const c = await client();
      const result = await c.request("stageApprove", ctx.sessionID, args, ctx.agent);
      return JSON.stringify(result, null, 2);
    },
  }),

  host_stage_reject: defineTool({
    description:
      "Reject one READY or APPROVED stage of a staging chain with a revision note (stage-review agent only; owner decision, " +
      "requires human approval). Records REJECTED and the note; nothing is applied or replayed. Returns JSON.",
    args: { ...stageIdArgs, note: z.string().min(1).max(4000) },
    execute: async (args, ctx) => {
      await ctx.ask(await stageDecisionAsk(ctx, "host_stage_reject", args, { note: args.note }));
      const c = await client();
      const result = await c.request("stageReject", ctx.sessionID, args, ctx.agent);
      return JSON.stringify(result, null, 2);
    },
  }),

  host_stage_apply: defineTool({
    description:
      "Apply one APPROVED stage to the host working tree (stage-review agent only; owner decision, requires human approval). " +
      "Stages apply strictly in order, from the pinned stage commit, after the divergence and symlink checks. A stage touching " +
      "protected (S17) paths is refused: the owner applies it by hand. Working tree only: no commit, no index change. Returns JSON.",
    args: stageIdArgs,
    execute: async (args, ctx) => {
      await ctx.ask(await stageDecisionAsk(ctx, "host_stage_apply", args));
      const c = await client();
      const result = await c.request("stageApply", ctx.sessionID, { ...args, confirm: "APPLY" }, ctx.agent);
      return JSON.stringify(result, null, 2);
    },
  }),
};
