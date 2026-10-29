/**
 * Host-neutral tool table: sandboxToolSpecs (P0, docs/upgrades/opencode-v2.md).
 * Plain tool specs, no OpenCode plugin API. The V1 adapter (sandbox-tools.ts) wraps them with tool().
 */
import { z } from "zod";
import {
  requestApplyApproval,
} from "./apply-preview-guard.ts";
import {
  applyTargetedEdit,
} from "./sandbox-edit-core.ts";
import {
  defineTool,
  assertNotOrchestrator,
  client,
  ensureWorker,
  tokenizeCommand,
  pathArg,
  contentArg,
  formatResult,
} from "./tool-runtime.ts";

export const sandboxToolSpecs = {
  sandbox_read: defineTool({
    description:
      "Read a file from the ACTIVE sandbox workspace. Requires an ACTIVE worker and never " +
      "creates one; before activation, use host read/grep tools. path is relative to the " +
      "sandbox project root, never absolute or traversal.",
    args: { path: pathArg },
    execute: async (args, ctx) => {
      assertNotOrchestrator(ctx.agent, "sandbox_read");
      const c = await client();
      return formatResult("readFile", await c.request("readFile", ctx.sessionID, { path: args.path }, ctx.agent));
    },
  }),

  sandbox_list: defineTool({
    description:
      "List a directory inside the ACTIVE sandbox workspace. Requires an ACTIVE worker and " +
      "never creates one; before activation, use host read/grep tools. path is relative to " +
      "the sandbox project root, never absolute or traversal.",
    args: { path: pathArg },
    execute: async (args, ctx) => {
      assertNotOrchestrator(ctx.agent, "sandbox_list");
      const c = await client();
      return formatResult("listDir", await c.request("listDir", ctx.sessionID, { path: args.path }, ctx.agent));
    },
  }),

  sandbox_grep: defineTool({
    description:
      "Search inside the ACTIVE sandbox workspace. Requires an ACTIVE worker and never creates " +
      "one; before activation, use host grep. query is a grep pattern, not shell syntax. path " +
      "is relative to the sandbox project root, never absolute or traversal.",
    args: { query: z.string().min(1).max(1024), path: pathArg },
    execute: async (args, ctx) => {
      assertNotOrchestrator(ctx.agent, "sandbox_grep");
      const c = await client();
      return formatResult("grep", await c.request("grep", ctx.sessionID, { query: args.query, path: args.path }, ctx.agent));
    },
  }),

  sandbox_write: defineTool({
    description:
      "Create or overwrite a file (replace the entire file contents) in the worker-only sandbox. The first useful mutation " +
      "activates the worker naturally—no dummy sandbox_bash; no approval is required and the " +
      "host stays unchanged. Use sandbox_edit for targeted text changes that preserve the rest " +
      "of the file. path is relative to the sandbox project root, never absolute or traversal. " +
      "The broker appends a final newline when absent.",
    args: { path: pathArg, content: contentArg },
    execute: async (args, ctx) => {
      assertNotOrchestrator(ctx.agent, "sandbox_write");
      await ensureWorker(ctx.sessionID, ctx.directory);
      const c = await client();
      return formatResult("writeFile", await c.request("writeFile", ctx.sessionID, { path: args.path, content: args.content }, ctx.agent));
    },
  }),

  sandbox_edit: defineTool({
    description:
      "Edit a file in the worker-only sandbox by replacing only the specified text. oldString " +
      "must occur exactly once unless replaceAll is true. Refuses an empty oldString, no match, " +
      "multiple matches without replaceAll, or a result that would leave the file empty. For " +
      "whole-file replacement, use sandbox_write. The first useful mutation activates the worker " +
      "naturally—no dummy sandbox_bash; no approval is required and the host stays unchanged " +
      "until sandbox_apply. path is relative to the sandbox project root, never absolute or " +
      "traversal. The broker appends a final newline when absent.",
    args: {
      path: pathArg,
      oldString: z.string().max(1024 * 1024),
      newString: z.string().max(1024 * 1024),
      replaceAll: z.boolean().optional(),
    },
    execute: async (args, ctx) => {
      assertNotOrchestrator(ctx.agent, "sandbox_edit");
      await ensureWorker(ctx.sessionID, ctx.directory);
      const c = await client();
      const file = (await c.request("readFile", ctx.sessionID, { path: args.path }, ctx.agent)) as {
        content?: unknown;
      };
      if (typeof file.content !== "string") {
        throw new Error("sandbox_edit: broker read returned no file content");
      }
      const content = applyTargetedEdit(
        file.content,
        args.oldString,
        args.newString,
        args.replaceAll,
      );
      return formatResult(
        "writeFile",
        await c.request("writeFile", ctx.sessionID, { path: args.path, content }, ctx.agent),
      );
    },
  }),

  sandbox_apply_patch: defineTool({
    description:
      "Apply ONLY a complete plain-text Git unified diff in the worker-only sandbox. No Markdown " +
      "fences, *** Begin Patch envelopes, shell commands, or code snippets. Patch paths are " +
      "relative to the sandbox project root, never /work or absolute/traversal, and must match " +
      "the current worker checkout. git apply --check runs first. If rejected, check hunk line " +
      "counts and context: changed-line hunks need unchanged context; EOF append-only hunks may " +
      "end on added lines. Include a final newline. The first useful mutation " +
      "activates the worker naturally—no dummy sandbox_bash; no approval is required and the " +
      "host stays unchanged.",
    args: { patch: z.string().min(1).max(4 * 1024 * 1024) },
    execute: async (args, ctx) => {
      assertNotOrchestrator(ctx.agent, "sandbox_apply_patch");
      try {
        await ensureWorker(ctx.sessionID, ctx.directory);
        const c = await client();
        return formatResult("applyPatch", await c.request("applyPatch", ctx.sessionID, { patch: args.patch }, ctx.agent));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`sandbox_apply_patch failed: ${detail}. Provide a complete Git unified diff; check hunk line counts and include unchanged context for changed lines. Append-only EOF hunks may end on additions. Include a final newline.`);
      }
    },
  }),

  sandbox_bash: defineTool({
    description:
      "Run a read-only command in the isolated worker only. The command becomes an argv vector, " +
      "never a shell: no pipes, redirection, globbing, or expansion. Do not edit files or run " +
      "git apply/reset/checkout. Optional cwd is relative to the sandbox project root, never " +
      "absolute. The first useful execution activates the worker naturally—no dummy activation.",
    args: {
      command: z.string().min(1).max(64 * 1024),
      cwd: pathArg.optional(),
      timeoutMs: z.number().int().min(1).max(600_000).optional(),
    },
    execute: async (args, ctx) => {
      assertNotOrchestrator(ctx.agent, "sandbox_bash");
      await ensureWorker(ctx.sessionID, ctx.directory);
      const argv = tokenizeCommand(args.command);
      const c = await client();
      return formatResult(
        "exec",
        await c.request(
          "exec",
          ctx.sessionID,
          { argv, ...(args.cwd ? { cwd: args.cwd } : {}), ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}) },
          ctx.agent,
        ),
      );
    },
  }),

  sandbox_diff: defineTool({
    description:
      "Show the active worker diff, including uncommitted changes, or the prepared/retained " +
      "result diff. Active mode requires a live worker; retained mode reads the exported result.",
    args: {},
    execute: async (_args, ctx) => {
      assertNotOrchestrator(ctx.agent, "sandbox_diff");
      const c = await client();
      return formatResult("diff", await c.request("diff", ctx.sessionID, {}, ctx.agent));
    },
  }),

  sandbox_finish: defineTool({
    description:
      "Prepare and export the sandbox result bundle. The host working tree stays unchanged and " +
      "no approval is required. Host ref import occurs only in real Git mode. Transitions to " +
      "RESULT_READY and retains the worker until sandbox_apply, sandbox_discard, or keep.",
    args: {},
    execute: async (_args, ctx) => {
      assertNotOrchestrator(ctx.agent, "sandbox_finish");
      const c = await client();
      return formatResult("prepareResult", await c.request("prepareResult", ctx.sessionID, {}, ctx.agent));
    },
  }),

  sandbox_apply: defineTool({
    description:
      "Ask the user to approve applying the finished sandbox result (B->C delta) to the host " +
      "project; requires explicit human approval (S15, §19). The result is prepared automatically " +
      "when needed and previewed first. On approval, the broker re-checks host divergence (S16) " +
      "and protected paths before applying. Success is APPLIED, releases the worker, and ends " +
      "this session's worker lifecycle; denial or failure retains the result.",
    args: {},
    execute: async (_args, ctx) => {
      assertNotOrchestrator(ctx.agent, "sandbox_apply");
      const c = await client();
      const workerStatus = (await c.request("workerStatus", ctx.sessionID, {}, ctx.agent)) as { state?: string };
      if (workerStatus.state !== "RESULT_READY") {
        await c.request("prepareResult", ctx.sessionID, {}, ctx.agent);
      }
      const diff = await c.request("diff", ctx.sessionID, { mode: "active" }, ctx.agent);
      const summary = (diff as { stat?: string }).stat ?? "";
      const diffRes = diff as {
        stat?: string;
        diff?: string;
        compare?: string;
        applyPreview?: {
          files: number;
          addedLines: number;
          removedLines: number;
          totalLines: number;
          preview: string;
          previewTruncated: boolean;
        };
        applyPreviewFiles?: { plain?: string; ansi?: string };
      };
      const rawPreview = ((diffRes.compare ?? "").trim() ? diffRes.compare : diffRes.diff) ?? "";
      // The broker owns both preview artifacts under its state dir (outside
      // the worktree): previewFile is the plain, escape-free diff for
      // editors and previewAnsiFile is the coloured copy for terminals.
      // The plugin no longer writes a temp file.
      const previewFiles = diffRes.applyPreviewFiles;
      // The approval boundary must never depend on the unbounded raw diff:
      // embed the broker's bounded preview plus exact counts, and fall back
      // to a no-preview bounded shape if an older broker omits it.
      const bounded = diffRes.applyPreview;
      // Fail closed (review finding R1-blind-version-skew-apply): a
      // truncated preview without the broker's complete plain artifact must
      // never reach the approval prompt, where the approver could only see
      // a prefix of the diff.
      await requestApplyApproval(
        {
          previewTruncated: bounded ? bounded.previewTruncated : true,
          applyPreviewFiles: previewFiles,
        },
        async (paths) => {
          const metadata = bounded
            ? {
                summary,
                files: bounded.files,
                addedLines: bounded.addedLines,
                removedLines: bounded.removedLines,
                totalLines: bounded.totalLines,
                previewTruncated: bounded.previewTruncated,
                preview: bounded.preview,
                previewFile: paths.previewFile,
                previewAnsiFile: paths.previewAnsiFile,
              }
            : {
                summary,
                totalLines: rawPreview.split("\n").length,
                previewTruncated: true,
                previewFile: paths.previewFile,
                previewAnsiFile: paths.previewAnsiFile,
              };
          await ctx.ask({
            permission: "sandbox_apply",
            patterns: ["*"],
            always: [],
            metadata,
          });
        },
      );
      return formatResult("applyResult", await c.request("applyResult", ctx.sessionID, { confirm: "APPLY" }, ctx.agent));
    },
  }),

  sandbox_copy_out: defineTool({
    description:
      "Copy a file from the ACTIVE sandbox workspace to a host file. Requires an ACTIVE worker " +
      "and never activates one. workerPath is relative to the sandbox project root, never " +
      "absolute or traversal; hostTarget must be absolute and in BROKER_EXTERNAL_COPY_TARGETS. " +
      "Shows a preview and asks for explicit human approval (S15). Source-code targets are bounded " +
      "by the fully visible review limit (maxApplyDiffLines); large code changes must use " +
      "sandbox_apply or be split. If the target exists, the broker creates <target>.bak before " +
      "atomic replacement.",
    args: { workerPath: pathArg, hostTarget: z.string().min(1).max(4096) },
    execute: async (args, ctx) => {
      assertNotOrchestrator(ctx.agent, "sandbox_copy_out");
      const c = await client();
      const info = (await c.request("copyOutInfo", ctx.sessionID, { workerPath: args.workerPath, hostTarget: args.hostTarget }, ctx.agent)) as {
        target?: string;
        totalLines?: number;
        preview?: string;
      };
      await ctx.ask({
        permission: "sandbox_copy_out",
        patterns: ["*"],
        always: [],
        metadata: {
          target: info.target ?? args.hostTarget,
          totalLines: info.totalLines ?? 0,
          preview: info.preview ?? "",
        },
      });
      return formatResult("copyOut", await c.request("copyOut", ctx.sessionID, { workerPath: args.workerPath, hostTarget: args.hostTarget, confirm: "COPY" }, ctx.agent));
    },
  }),

  sandbox_copy_in: defineTool({
    description:
      "Copy a host file into the sandbox workspace. The first useful copy-in activates the " +
      "worker naturally; no dummy sandbox_bash needed. hostSource must be absolute, existing, " +
      "regular, and in BROKER_EXTERNAL_COPY_TARGETS; workerPath is relative to the sandbox " +
      "project root, never absolute or traversal. Shows file info and asks for explicit human " +
      "approval (S15). The host is not modified; the worker destination is overwritten.",
    args: { hostSource: z.string().min(1).max(4096), workerPath: pathArg },
    execute: async (args, ctx) => {
      assertNotOrchestrator(ctx.agent, "sandbox_copy_in");
      await ensureWorker(ctx.sessionID, ctx.directory);
      const c = await client();
      const info = (await c.request("copyInInfo", ctx.sessionID, { hostSource: args.hostSource, workerPath: args.workerPath }, ctx.agent)) as {
        source?: string;
        bytes?: number;
      };
      await ctx.ask({
        permission: "sandbox_copy_in",
        patterns: ["*"],
        always: [],
        metadata: { source: info.source ?? args.hostSource, bytes: info.bytes ?? 0 },
      });
      return formatResult("copyIn", await c.request("copyIn", ctx.sessionID, { hostSource: args.hostSource, workerPath: args.workerPath, confirm: "COPY" }, ctx.agent));
    },
  }),

  sandbox_discard: defineTool({
    description:
      "Discard only a prepared or retained sandbox result. No approval is required; destroys the " +
      "result and worker, leaves the host unchanged, and ends in terminal REJECTED.",
    args: {},
    execute: async (_args, ctx) => {
      assertNotOrchestrator(ctx.agent, "sandbox_discard");
      const c = await client();
      return formatResult("discardResult", await c.request("discardResult", ctx.sessionID, { confirm: "REJECT" }, ctx.agent));
    },
  }),
};
