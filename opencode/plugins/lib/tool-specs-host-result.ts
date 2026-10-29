/**
 * Host-neutral tool table: hostResultToolSpecs (P0, docs/upgrades/opencode-v2.md).
 * Plain tool specs, no OpenCode plugin API. The V1 adapter (sandbox-tools.ts) wraps them with tool().
 */
import {
  requestApplyApproval,
} from "./apply-preview-guard.ts";
import {
  buildSandboxResultInstallAsk,
} from "./host-tool-approval.ts";
import {
  defineTool,
  client,
  sessionIdArg,
  currentProjectDirectory,
} from "./tool-runtime.ts";

export const hostResultToolSpecs = {
  host_sandbox_result: defineTool({
    description:
      "Read a sandbox result ref (read-only; no approval). Resolves the ref from a " +
      "sandbox session id, returns the commit identity and timestamp, the changed paths " +
      "with per-file added/removed counts, and a bounded/redacted patch. Set " +
      "compareSandboxSessionID to diff two result refs. Never accepts a raw ref or a " +
      "path list. Returns JSON.",
    args: {
      sandboxSessionID: sessionIdArg.optional(),
      compareSandboxSessionID: sessionIdArg.optional(),
    },
    execute: async (args, ctx) => {
      const c = await client();
      const result = await c.request("sandboxResult", ctx.sessionID, {
        projectDir: currentProjectDirectory(ctx.directory),
        ...(args.sandboxSessionID ? { sandboxSessionID: args.sandboxSessionID } : {}),
        ...(args.compareSandboxSessionID
          ? { compareSandboxSessionID: args.compareSandboxSessionID }
          : {}),
      }, ctx.agent);
      return JSON.stringify(result, null, 2);
    },
  }),

  host_sandbox_result_install: defineTool({
    description:
      "Install a sandbox result ref into the working tree (orchestrator-only mutation; " +
      "requires human approval). Reads the result first and binds the install to the exact " +
      "previewed commit: if the ref moves between preview and install the broker refuses " +
      "(result-commit-mismatch). The broker derives every path from the result's own diff; " +
      "deleted paths are removed and present paths are restored, and the index is never " +
      "staged. Never accepts a raw ref or a path list. Returns JSON.",
    args: {
      sandboxSessionID: sessionIdArg.optional(),
    },
    execute: async (args, ctx) => {
      const c = await client();
      const preview = (await c.request("sandboxResult", ctx.sessionID, {
        projectDir: currentProjectDirectory(ctx.directory),
        ...(args.sandboxSessionID ? { sandboxSessionID: args.sandboxSessionID } : {}),
      }, ctx.agent)) as {
        result: { ref: string; commit: string };
        changedPaths: Array<{ path: string }>;
        patch: string;
        patchTruncated: boolean;
        applyPreviewFiles?: { plain?: string; ansi?: string };
      };
      const boundedPreview = preview.patch.length > 12_000
        ? `${preview.patch.slice(0, 12_000)}\n(... approval preview truncated; inspect previewFile)`
        : preview.patch;
      const previewTruncated = preview.patchTruncated || preview.patch.length > 12_000;
      await requestApplyApproval(
        { previewTruncated, applyPreviewFiles: preview.applyPreviewFiles },
        async (paths) => ctx.ask(
          buildSandboxResultInstallAsk({
            resultRef: preview.result.ref,
            resultCommit: preview.result.commit,
            changedPaths: preview.changedPaths.map((entry) => entry.path),
            preview: boundedPreview,
            previewTruncated,
            ...(paths.previewFile ? { previewFile: paths.previewFile } : {}),
            ...(args.sandboxSessionID !== undefined
              ? { sandboxSessionID: args.sandboxSessionID }
              : {}),
          }),
        ),
      );
      const result = await c.request("sandboxResultInstall", ctx.sessionID, {
        projectDir: currentProjectDirectory(ctx.directory),
        expectedResultCommit: preview.result.commit,
        ...(args.sandboxSessionID !== undefined
          ? { sandboxSessionID: args.sandboxSessionID }
          : {}),
      }, ctx.agent);
      return JSON.stringify(result, null, 2);
    },
  }),
};
