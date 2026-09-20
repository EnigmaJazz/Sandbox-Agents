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
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import {
  createBrokerClient,
  brokerSocketPath,
  type BrokerClient,
} from "./lib/broker-client.ts";
import {
  BIND_SESSION_AGENT_OPERATION,
  hostSessionBinding,
} from "./lib/session-agent-binding.ts";
import {
  buildGhIssueCreateAsk,
  buildGitCommitAsk,
  buildPlanDocAppendAsk,
  buildReviewAcknowledgeApprovedAsk,
  buildReviewCaptureCorrectionPlanAsk,
  buildReviewCaptureRefuterAsk,
  buildReviewCaptureResultAsk,
  buildReviewCaptureUnachievableAsk,
  buildReviewCaptureValidationAsk,
  buildReviewRecoverAsk,
  buildReviewStartAsk,
  buildReviewValidateAsk,
  buildRegisterProjectAsk,
  buildGitPushAsk,
  buildSddArchiveComposeAsk,
  buildSddAttemptGrantAsk,
} from "./lib/host-tool-approval.ts";

const READ_ONLY_AGENTS: readonly string[] = ["gentle-orchestrator"];

function assertNotOrchestrator(agent: string | undefined, toolName: string): void {
  if (agent && READ_ONLY_AGENTS.includes(agent)) {
    throw new Error(`orchestrator agent "${agent}" is not allowed to use sandbox operation "${toolName}" (orchestrator-readonly)`);
  }
}

let clientPromise: Promise<BrokerClient> | null = null;

function client(): Promise<BrokerClient> {
  if (!clientPromise) {
    clientPromise = createBrokerClient({ socketPath: brokerSocketPath() }).catch((err) => {
      clientPromise = null; // allow retry on the next call
      throw err;
    });
  }
  return clientPromise;
}

/** Map an opencode session to a worker; reuses an existing one (§13, §28). */
async function ensureWorker(sessionID: string, directory: string | undefined): Promise<unknown> {
  const c = await client();
  return await c.request("ensureWorker", sessionID, { projectDir: directory ?? process.cwd() });
}

function notActiveError(): Error {
  return new Error(
    "This session has no active sandbox worker yet. The FIRST sandbox mutation (sandbox_write / sandbox_edit / sandbox_apply_patch / sandbox_bash) opens the worker automatically - no separate activation step. Until then use the host read/grep tools. All sandbox_* file paths are RELATIVE to the project root (e.g. broker/src/service.ts) - never absolute.",
  );
}

/**
 * Minimal, safe command tokenizer: splits on whitespace and honors
 * single/double quotes. NO shell semantics — no expansion, globbing,
 * redirection, pipes or environment interpolation. The resulting argv is
 * validated broker-side (shell metacharacters rejected).
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (quote) {
    throw new Error("unterminated quote in command");
  }
  if (current.length > 0) tokens.push(current);
  if (tokens.length === 0) {
    throw new Error("empty command");
  }
  return tokens;
}

const pathArg = z.string().min(1).max(4096);
const sessionIdArg = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const contentArg = z.string().max(1024 * 1024);
const sddIdentifierArg = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).refine((value) => !value.includes(".."));
const sddLowercaseRequestIdArg = z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/);
const sddContractArg = z.enum(["gentle-ai.sdd-status/v2"]);
const untrackedInventoryArg = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const reviewAgentArg = z.string().regex(/^[a-z0-9_-]{1,64}$/);
const sddPathArg = z.string().min(1).max(4096);

function currentProjectDirectory(directory: string | undefined): string {
  if (!directory) throw new Error("host-side SDD runtime requires the current project directory");
  return directory;
}

/**
 * Format a broker response as an opencode ToolResult string.
 *
 * opencode 1.18 tool.execute MUST return a string (or {output: string});
 * returning the raw broker object crashed the plugin runtime with
 * "undefined is not an object (evaluating 'c.split')" (Gate 5 live finding).
 */
function formatResult(operation: string, result: unknown): string {
  const r = (result ?? {}) as Record<string, unknown>;
  switch (operation) {
    case "readFile":
      return String(r.content ?? "");
    case "exec": {
      const stdout = String(r.stdout ?? "");
      const stderr = String(r.stderr ?? "");
      const status = Number(r.status ?? 0);
      const body = stderr.length > 0 ? `${stdout}\n${stderr}`.trim() : stdout;
      return status === 0 ? body : `exit ${status}\n${body}`.trim();
    }
    case "listDir":
      return String(r.listing ?? "");
    case "grep": {
      const m = r.matches;
      return typeof m === "string" ? m : JSON.stringify(m ?? [], null, 2);
    }
    case "diff": {
      const diff = r.diff;
      const stat = r.stat;
      if (typeof diff === "string" && diff.length > 0) return diff;
      if (typeof stat === "string" && stat.length > 0) return stat;
      return JSON.stringify(r, null, 2);
    }
    case "writeFile":
      return `wrote ${String(r.path ?? "?")}`;
    case "applyPatch":
      return `patch applied${r.changedLines !== undefined ? ` (${String(r.changedLines)} lines changed)` : ""}`;
    case "ensureWorker":
      return `worker ${String(r.worker ?? "?")} ${r.reused ? "reused" : "created"} (state ${String(r.state ?? "?")})`;
    case "workerStatus":
      return `state: ${String(r.state ?? "?")}`;
    case "prepareResult":
      return `result ready: ${String(r.resultRef ?? "?")}`;
    case "applyResult":
      return `applied to host: ${String(r.resultRef ?? "?")}`;
    case "discardResult":
      return `discarded; worker ${String(r.state ?? "?")}`;
    case "copyOutInfo":
      return JSON.stringify(r, null, 2);
    case "copyOut":
      return `copied to host: ${String(r.target ?? "?")}`;
    case "copyInInfo":
      return JSON.stringify(r, null, 2);
    case "copyIn":
      return `copied to worker: ${String(r.path ?? "?")}`;
    default:
      return JSON.stringify(r, null, 2);
  }
}

export default function sandboxToolsPlugin() {
  return {
    tool: {
      sandbox_read: tool({
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

      sandbox_list: tool({
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

      sandbox_grep: tool({
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

      sandbox_write: tool({
        description:
          "Create or overwrite a file in the worker-only sandbox. The first useful mutation " +
          "activates the worker naturally—no dummy sandbox_bash; no approval is required and the " +
          "host stays unchanged. path is relative to the sandbox project root, never absolute or " +
          "traversal. The broker appends a final newline when absent.",
        args: { path: pathArg, content: contentArg },
        execute: async (args, ctx) => {
          assertNotOrchestrator(ctx.agent, "sandbox_write");
          await ensureWorker(ctx.sessionID, ctx.directory);
          const c = await client();
          return formatResult("writeFile", await c.request("writeFile", ctx.sessionID, { path: args.path, content: args.content }, ctx.agent));
        },
      }),

      sandbox_edit: tool({
        description:
          "Replace the full contents of a file in the worker-only sandbox. The first useful " +
          "mutation activates the worker naturally—no dummy sandbox_bash; no approval is required " +
          "and the host stays unchanged until sandbox_apply. path is relative to the sandbox " +
          "project root, never absolute or traversal. The broker appends a final newline when absent.",
        args: { path: pathArg, content: contentArg },
        execute: async (args, ctx) => {
          assertNotOrchestrator(ctx.agent, "sandbox_edit");
          await ensureWorker(ctx.sessionID, ctx.directory);
          const c = await client();
          return formatResult("writeFile", await c.request("writeFile", ctx.sessionID, { path: args.path, content: args.content }, ctx.agent));
        },
      }),

      sandbox_apply_patch: tool({
        description:
          "Apply ONLY a complete plain-text Git unified diff in the worker-only sandbox. No Markdown " +
          "fences, *** Begin Patch envelopes, shell commands, or code snippets. Patch paths are " +
          "relative to the sandbox project root, never /work or absolute/traversal, and must match " +
          "the current worker checkout. git apply --check runs first. The first useful mutation " +
          "activates the worker naturally—no dummy sandbox_bash; no approval is required and the " +
          "host stays unchanged.",
        args: { patch: z.string().min(1).max(4 * 1024 * 1024) },
        execute: async (args, ctx) => {
          assertNotOrchestrator(ctx.agent, "sandbox_apply_patch");
          await ensureWorker(ctx.sessionID, ctx.directory);
          const c = await client();
          return formatResult("applyPatch", await c.request("applyPatch", ctx.sessionID, { patch: args.patch }, ctx.agent));
        },
      }),

      sandbox_bash: tool({
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

      sandbox_diff: tool({
        description:
          "Show the committed baseline-to-worker HEAD diff (B→C). Requires an ACTIVE worker and " +
          "never activates one. Run sandbox_finish first if current uncommitted edits must be included.",
        args: {},
        execute: async (_args, ctx) => {
          assertNotOrchestrator(ctx.agent, "sandbox_diff");
          const c = await client();
          return formatResult("diff", await c.request("diff", ctx.sessionID, {}, ctx.agent));
        },
      }),

      sandbox_finish: tool({
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

      sandbox_apply: tool({
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
          const metadata = bounded
            ? {
                summary,
                files: bounded.files,
                addedLines: bounded.addedLines,
                removedLines: bounded.removedLines,
                totalLines: bounded.totalLines,
                previewTruncated: bounded.previewTruncated,
                preview: bounded.preview,
                previewFile: previewFiles?.plain,
                previewAnsiFile: previewFiles?.ansi,
              }
            : {
                summary,
                totalLines: rawPreview.split("\n").length,
                previewTruncated: true,
                previewFile: previewFiles?.plain,
                previewAnsiFile: previewFiles?.ansi,
              };
          await ctx.ask({
            permission: "sandbox_apply",
            patterns: ["*"],
            always: [],
            metadata,
          });
          return formatResult("applyResult", await c.request("applyResult", ctx.sessionID, { confirm: "APPLY" }, ctx.agent));
        },
      }),

      sandbox_copy_out: tool({
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

      sandbox_copy_in: tool({
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

      sandbox_discard: tool({
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

      host_sdd_status: tool({
        description:
          "Run a host-side, allowlisted SDD runtime status operation (read-only; no approval). The " +
          "broker uses the current canonical project root and exact operation-specific argv, never " +
          "sandbox_bash; this tool never accepts arbitrary cwd, binary, or argv and does not activate " +
          "a worker. Returns JSON.",
        args: {
          change: sddIdentifierArg.optional(),
          contract: sddContractArg.optional(),
        },
        execute: async (args, ctx) => {
          const c = await client();
          const result = await c.request("sddStatus", ctx.sessionID, {
            projectDir: currentProjectDirectory(ctx.directory),
            ...(args.change ? { change: args.change } : {}),
            ...(args.contract ? { contract: args.contract } : {}),
          }, ctx.agent);
          return JSON.stringify(result, null, 2);
        },
      }),

      host_sdd_continue: tool({
        description:
          "Run a host-side, allowlisted SDD continue operation (read-only; no approval). Exact " +
          "frozen argv, canonical project root, no worker activation. Returns JSON.",
        args: { change: sddIdentifierArg.optional() },
        execute: async (args, ctx) => {
          const c = await client();
          const result = await c.request("sddContinue", ctx.sessionID, {
            projectDir: currentProjectDirectory(ctx.directory),
            ...(args.change ? { change: args.change } : {}),
          }, ctx.agent);
          return JSON.stringify(result, null, 2);
        },
      }),

      host_sdd_task_result: tool({
        description:
          "Validate a per-phase SDD task result (read-only; no approval). phase is " +
          "the SDD phase id; input is a project-relative path or '-'. Returns JSON.",
        args: { phase: sddIdentifierArg, input: sddPathArg },
        execute: async (args, ctx) => {
          const c = await client();
          const result = await c.request("sddTaskResult", ctx.sessionID, {
            projectDir: currentProjectDirectory(ctx.directory),
            phase: args.phase,
            input: args.input,
          }, ctx.agent);
          return JSON.stringify(result, null, 2);
        },
      }),

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

      host_sdd_attempt_grant: tool({
        description:
          "Grant canonical host roots to a caller change instance (orchestrator-only " +
          "mutation; requires human approval). Roots are forwarded in order; an " +
          "initial grant may omit the CAS revision. Returns JSON.",
        args: {
          change: sddIdentifierArg,
          expectedRevision: untrackedInventoryArg.optional(),
          roots: z.array(z.string().min(1).max(4096)).min(1).max(32),
          changeInstance: z.string().min(1).max(128),
          requestId: sddLowercaseRequestIdArg,
          actor: z.string().min(1).max(128),
          reason: z.string().min(1).max(500),
        },
        execute: async (args, ctx) => {
          await ctx.ask(buildSddAttemptGrantAsk(args));
          const c = await client();
          const payload: Record<string, unknown> = {
            projectDir: currentProjectDirectory(ctx.directory),
            change: args.change,
            roots: args.roots,
            changeInstance: args.changeInstance,
            requestId: args.requestId,
            actor: args.actor,
            reason: args.reason,
          };
          if (args.expectedRevision) payload.expectedRevision = args.expectedRevision;
          const result = await c.request("sddAttemptGrant", ctx.sessionID, payload, ctx.agent);
          return JSON.stringify(result, null, 2);
        },
      }),

      host_sdd_archive_compose: tool({
        description:
          "Compose an SDD archive delta into the canonical spec (orchestrator-only " +
          "mutation; requires human approval). canonical/delta/output are " +
          "project-relative paths. Returns JSON.",
        args: { canonical: sddPathArg, delta: sddPathArg, output: sddPathArg },
        execute: async (args, ctx) => {
          await ctx.ask(buildSddArchiveComposeAsk(args));
          const c = await client();
          const result = await c.request("sddArchiveCompose", ctx.sessionID, {
            projectDir: currentProjectDirectory(ctx.directory),
            canonical: args.canonical,
            delta: args.delta,
            output: args.output,
          }, ctx.agent);
          return JSON.stringify(result, null, 2);
        },
      }),

      host_git_commit: tool({
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

      host_git_push: tool({
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

      host_gh_issue_create: tool({
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

      host_plan_append: tool({
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
    },
    "chat.params": async (input: unknown) => {
      // Host-authoritative session->agent binding: only a host-resolved
      // orchestrator identity is recorded, and only via this plugin hook (the
      // operation is never a host_* / sandbox_* tool). Best-effort failure
      // leaves host mutations failing closed rather than blocking the chat.
      const binding = hostSessionBinding(input, READ_ONLY_AGENTS);
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

const reviewTokenArg = z.string().min(1).max(4096);
const reviewShaArg = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const reviewProjectionArg = z.enum(["workspace", "staged"]);
const reviewFocusArg = z.enum(["risk", "resilience", "readability", "reliability"]);
const reviewConsentArg = z.enum(["relay", "granted", "declined"]);
const reviewLocaleArg = z.enum(["en", "es"]);
const reviewGateArg = z.enum(["post-apply", "pre-commit", "pre-push", "pre-pr", "release"]);
const reviewDispositionArg = z.enum(["scope_changed", "invalidated", "escalated"]);
const reviewOrderArg = z.number().int().min(0).max(32);
const reviewReasonArg = z.string().min(1).max(4096);
const reviewDetailArg = z.string().min(1).max(16384);
const reviewActorArg = z.string().min(1).max(128);
const reviewBaseRefArg = z.string().min(1).max(1024);
const reviewCorrectionLinesArg = z.number().int().positive();

/** Is `child` equal to or beneath `parent`? Mirrors broker validation.isWithin. */
function isWithinPath(parent: string, child: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** Best-effort host-side size/digest preview for a review-capture input file. */
function describeReviewInput(
  projectDir: string,
  input: string | undefined,
): { inputBytes?: number; inputDigest?: string } {
  if (input === undefined || input === "-") return {};
  try {
    // Canonicalize before reading: the project-relative resolver is lexical
    // only, so a symlink inside the project could still resolve outside it.
    const root = realpathSync(projectDir);
    const candidate = resolve(root, input);
    if (!isWithinPath(root, candidate)) return {};
    const real = realpathSync(candidate);
    if (!isWithinPath(root, real)) return {};
    const stat = statSync(real);
    if (!stat.isFile()) return {};
    const digest = createHash("sha256")
      .update(readFileSync(real))
      .digest("hex")
      .slice(0, 16);
    return { inputBytes: stat.size, inputDigest: digest };
  } catch {
    return {};
  }
}

/** Best-effort size/digest preview for an inline review-capture JSON body. */
function describeInlineReviewInput(
  inputJson: string | undefined,
): { inputJsonBytes?: number; inputJsonDigest?: string } {
  if (inputJson === undefined) return {};
  return {
    inputJsonBytes: Buffer.byteLength(inputJson, "utf8"),
    inputJsonDigest: createHash("sha256").update(inputJson).digest("hex").slice(0, 16),
  };
}
