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
 * sandbox_apply requires human approval via ctx.ask() before the broker may
 * apply the B->C delta (S15, §19.9).
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

async function requireWorkerState(sessionID: string): Promise<string> {
  const c = await client();
  const status = (await c.request("workerStatus", sessionID)) as { state: string };
  return status.state;
}

function notActiveError(): Error {
  return new Error(
    "This session has no active sandbox worker yet. " +
      "Use sandbox_write / sandbox_bash / sandbox_edit / sandbox_apply_patch to create one (§11), " +
      "or sandbox_read / sandbox_list / sandbox_grep to read host project state before activation.",
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
      return JSON.stringify(r.entries ?? [], null, 2);
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
    default:
      return JSON.stringify(r, null, 2);
  }
}

export default function sandboxToolsPlugin() {
  return {
    tool: {
      sandbox_read: tool({
        description:
          "Read a file from the ACTIVE sandbox workspace of this session. " +
          "Fails if no worker exists yet (use host reads before activation).",
        args: { path: pathArg },
        execute: async (args, ctx) => {
          const c = await client();
          return formatResult("readFile", await c.request("readFile", ctx.sessionID, { path: args.path }, ctx.agent));
        },
      }),

      sandbox_list: tool({
        description: "List a directory inside the ACTIVE sandbox workspace of this session.",
        args: { path: pathArg },
        execute: async (args, ctx) => {
          const c = await client();
          return formatResult("listDir", await c.request("listDir", ctx.sessionID, { path: args.path }, ctx.agent));
        },
      }),

      sandbox_grep: tool({
        description:
          "Search inside the ACTIVE sandbox workspace of this session. " +
          "The query is a plain substring/pattern passed to grep -e; no shell expansion.",
        args: { query: z.string().min(1).max(1024), path: pathArg },
        execute: async (args, ctx) => {
          const c = await client();
          return formatResult("grep", await c.request("grep", ctx.sessionID, { query: args.query, path: args.path }, ctx.agent));
        },
      }),

      sandbox_write: tool({
        description:
          "Create or overwrite a file inside this session's isolated sandbox workspace. " +
          "The first call activates the worker (lazy creation). The host project is untouched.",
        args: { path: pathArg, content: contentArg },
        execute: async (args, ctx) => {
          await ensureWorker(ctx.sessionID, ctx.directory);
          const c = await client();
          return formatResult("writeFile", await c.request("writeFile", ctx.sessionID, { path: args.path, content: args.content }, ctx.agent));
        },
      }),

      sandbox_edit: tool({
        description:
          "Replace the full contents of a file inside this session's sandbox workspace. " +
          "Activates the worker on first use; the host project is untouched until approved apply.",
        args: { path: pathArg, content: contentArg },
        execute: async (args, ctx) => {
          await ensureWorker(ctx.sessionID, ctx.directory);
          const c = await client();
          return formatResult("writeFile", await c.request("writeFile", ctx.sessionID, { path: args.path, content: args.content }, ctx.agent));
        },
      }),

      sandbox_apply_patch: tool({
        description:
          "Apply a unified diff patch inside this session's sandbox workspace. " +
          "Validated with git apply --check first. Activates the worker on first use.",
        args: { patch: z.string().min(1).max(4 * 1024 * 1024) },
        execute: async (args, ctx) => {
          await ensureWorker(ctx.sessionID, ctx.directory);
          const c = await client();
          return formatResult("applyPatch", await c.request("applyPatch", ctx.sessionID, { patch: args.patch }, ctx.agent));
        },
      }),

      sandbox_bash: tool({
        description:
          "Run a command inside this session's sandbox workspace. NOT a host shell: the " +
          "command is tokenized (no pipes, redirection, globs or variable expansion) and " +
          "executed in the isolated worker. Use sandbox_write / sandbox_apply_patch for edits. " +
          "The first call activates the worker.",
        args: {
          command: z.string().min(1).max(64 * 1024),
          cwd: pathArg.optional(),
          timeoutMs: z.number().int().min(1).max(600_000).optional(),
        },
        execute: async (args, ctx) => {
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
        description: "Show the diff between the session's baseline and the sandbox HEAD (B..C).",
        args: {},
        execute: async (_args, ctx) => {
          const c = await client();
          return formatResult("diff", await c.request("diff", ctx.sessionID, {}, ctx.agent));
        },
      }),

      sandbox_finish: tool({
        description:
          "Finalize the sandbox work: export the worker result bundle and import it under " +
          "refs/opencode-sandbox/result/<sessionID>. The host working tree stays unchanged (S15).",
        args: {},
        execute: async (_args, ctx) => {
          const c = await client();
          return formatResult("prepareResult", await c.request("prepareResult", ctx.sessionID, {}, ctx.agent));
        },
      }),

      sandbox_apply: tool({
        description:
          "Ask the user to approve applying the finished sandbox result (B->C delta) to the " +
          "host project. Requires sandbox_finish first; requires explicit human approval " +
          "(S15, §19). The broker re-checks host divergence (S16) before applying.",
        args: {},
        execute: async (_args, ctx) => {
          const c = await client();
          const status = (await c.request("workerStatus", ctx.sessionID)) as { state: string };
          if (status.state !== "RESULT_READY") {
            const prepared = await c.request("prepareResult", ctx.sessionID, {}, ctx.agent);
            void prepared;
          }
          const diff = await c.request("diff", ctx.sessionID, { mode: "active" }, ctx.agent);
          const summary = (diff as { stat?: string }).stat ?? "";
          // opencode 1.18.x: ctx.ask takes {permission, patterns, always,
          // metadata} and resolves void on approval; a denial REJECTS the
          // promise (verified against @opencode-ai/plugin typings at Gate 4).
          await ctx.ask({
            permission: "sandbox_apply",
            patterns: ["*"],
            always: [],
            metadata: { summary },
          });
          return formatResult("applyResult", await c.request("applyResult", ctx.sessionID, { confirm: "APPLY" }, ctx.agent));
        },
      }),

      sandbox_discard: tool({
        description:
          "Discard this session's sandbox result and destroy its worker (REJECT semantics, §20).",
        args: {},
        execute: async (_args, ctx) => {
          const c = await client();
          return formatResult("discardResult", await c.request("discardResult", ctx.sessionID, { confirm: "REJECT" }, ctx.agent));
        },
      }),
    },
  };
}
