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
  createBrokerClient,
  brokerSocketPath,
  type BrokerClient,
} from "./lib/broker-client.ts";

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
  return c.request("ensureWorker", sessionID, { projectDir: directory ?? process.cwd() });
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
const contentArg = z.string().max(1024 * 1024);
const sddIdentifierArg = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).refine((value) => !value.includes(".."));
const sddRequestIdArg = z.string().regex(/^[A-Za-z0-9-]{1,128}$/);
const sddPositiveIntArg = z.number().int().positive();

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
          const diffRes = diff as { stat?: string; diff?: string; compare?: string };
          const rawPreview = (diffRes.compare ?? "").trim() ? diffRes.compare : diffRes.diff;
          const pol = (await c.request("policy", ctx.sessionID, {}, ctx.agent)) as {
            resourceCaps?: { maxApplyDiffLines?: number };
          };
          const previewCap = pol.resourceCaps?.maxApplyDiffLines ?? 200;
          const diffPreview = (rawPreview ?? "").split("\n").slice(0, previewCap).join("\n");
          await ctx.ask({
            permission: "sandbox_apply",
            patterns: ["*"],
            always: [],
            metadata: { summary, diff: diffPreview },
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
          "Run a host-side, allowlisted SDD runtime status operation. The broker uses the current " +
          "canonical project root and exact operation-specific argv, never sandbox_bash; this tool " +
          "never accepts arbitrary cwd, binary, or argv and does not activate a worker. Returns JSON.",
        args: {},
        execute: async (_args, ctx) => {
          const c = await client();
          const result = await c.request("sddStatus", ctx.sessionID, {
            projectDir: currentProjectDirectory(ctx.directory),
          }, ctx.agent);
          return JSON.stringify(result, null, 2);
        },
      }),

      host_sdd_attempt_acquire: tool({
        description:
          "Run a host-side, allowlisted SDD runtime attempt-acquire operation. The broker uses the " +
          "current canonical project root and exact operation-specific argv, never sandbox_bash; " +
          "this tool never accepts arbitrary cwd, binary, or argv and does not activate a worker. Returns JSON.",
        args: {
          change: sddIdentifierArg,
          requestId: sddRequestIdArg,
          workUnit: sddIdentifierArg,
          evidenceGoal: sddIdentifierArg,
          maxAttempts: sddPositiveIntArg,
          maxChangedLines: sddPositiveIntArg,
        },
        execute: async (args, ctx) => {
          const c = await client();
          const result = await c.request("sddAttemptAcquire", ctx.sessionID, {
            projectDir: currentProjectDirectory(ctx.directory),
            ...args,
          }, ctx.agent);
          return JSON.stringify(result, null, 2);
        },
      }),

      host_register_project: tool({
        description: "Register a new project with the agentic sandbox system (host-side, creates .atl, updates profile/broker/launcher). Path must be absolute.",
        args: { path: pathArg },
        execute: async (args, ctx) => {
          const c = await client();
          const result = await c.request("registerProject", ctx.sessionID, { path: args.path }, ctx.agent);
          return JSON.stringify(result, null, 2);
        },
      }),
    },
  };
}
