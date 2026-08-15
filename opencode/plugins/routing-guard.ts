/**
 * Read-routing guard plugin (SYSTEM_PROMPT.md §13, S5, §14).
 *
 * - After a session becomes SANDBOX_ACTIVE, ordinary host read tools
 *   (read/grep/glob/list) on PROJECT paths are blocked with a clear error
 *   telling the model to use sandbox_read/sandbox_grep/sandbox_list, so the
 *   agent never sees stale host contents (S5). Approved EXTERNAL read roots
 *   (S6) remain readable and are not blocked.
 * - Ordinary host mutation/execution tools (bash/edit/write/apply_patch) are
 *   blocked for every session under this secured stack (S1, S10, §14) with an
 *   error pointing at the sandbox_* tools. The permission fragment enforces
 *   the same at config level; this hook is defence in depth.
 * - The routing rule is injected into the model-facing system prompt via
 *   experimental.chat.system.transform.
 *
 * Fail closed: if the broker is unreachable, the guard BLOCKS the tool call —
 * it never assumes host reads are safe (S5, S14).
 *
 * Gate 1: NOT installed. Load order and hook shapes are verified at Gate 4
 * against the installed opencode 1.18.x plugin API.
 */
import type { Plugin } from "@opencode-ai/plugin";
import { isAbsolute, resolve, sep } from "node:path";
import {
  createBrokerClient,
  brokerSocketPath,
  type BrokerClient,
} from "./lib/broker-client.ts";

const REDIRECT_MSG =
  "This session has an active isolated workspace. " +
  "Use sandbox_read/sandbox_grep/sandbox_list so you see the modified sandbox state.";

const MUTATION_BLOCK_MSG =
  "Ordinary host mutation/execution tools are disabled in this secured environment (S1/S10). " +
  "Use sandbox_write / sandbox_edit / sandbox_apply_patch / sandbox_bash to work inside your isolated worker.";

/** Tools the guard routes or blocks. */
const READ_TOOLS = new Set(["read", "grep", "glob", "list"]);
const MUTATION_TOOLS = new Set(["bash", "edit", "write", "apply_patch", "patch"]);
/** args fields that carry path/pattern targets, per tool. */
const READ_PATH_ARGS: Record<string, string[]> = {
  read: ["filePath"],
  grep: ["path", "pattern"],
  glob: ["pattern"],
  list: ["path"],
};

let clientPromise: Promise<BrokerClient> | null = null;
let policyCache: { roots: string[]; protectedPaths: string[] } | null = null;

async function broker(): Promise<BrokerClient> {
  if (!clientPromise) {
    clientPromise = createBrokerClient({ socketPath: brokerSocketPath() }).catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

/** Cache the broker policy (approved external read roots) for the session. */
async function approvedRoots(): Promise<string[]> {
  if (!policyCache) {
    const c = await broker();
    const policy = (await c.request("policy", "guard", undefined, undefined)) as {
      approvedExternalReadRoots: string[];
    };
    policyCache = { roots: policy.approvedExternalReadRoots ?? [], protectedPaths: [] };
  }
  return policyCache.roots;
}

/** Best-effort: is this absolute path under an approved external root? */
function isExternalApproved(argPath: string, roots: string[]): boolean {
  if (!isAbsolute(argPath)) return false;
  for (const root of roots) {
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    if (argPath === root || argPath.startsWith(prefix)) return true;
  }
  return false;
}

function pathArgsFor(toolName: string, args: Record<string, unknown> | undefined): string[] {
  const keys = READ_PATH_ARGS[toolName] ?? [];
  return keys
    .filter((k) => typeof args?.[k] === "string")
    .map((k) => String(args![k]));
}

export default function routingGuardPlugin(): Plugin {
  return {
    "tool.execute.before": async (input, output) => {
      const toolName = input.tool;
      const sessionID = input.sessionID;
      if (READ_TOOLS.has(toolName)) {
        const c = await broker(); // throws if broker down → tool call fails (fail closed)
        const status = (await c.request("workerStatus", sessionID, undefined, undefined)) as {
          state: string;
        };
        if (status.state === "SANDBOX_ACTIVE" || status.state === "RESULT_READY") {
          const roots = await approvedRoots();
          const args = (output?.args ?? {}) as Record<string, unknown>;
          const targets = pathArgsFor(toolName, args);
          // External approved reads remain allowed (S6); project reads are blocked.
          const anyExternal = targets.length === 0 ? false : targets.every((t) => isExternalApproved(t, roots));
          if (targets.length > 0 && anyExternal) {
            return; // external approved read root — allowed
          }
          throw new Error(REDIRECT_MSG);
        }
        return; // HOST_READ_ONLY: host reads are the intended mode (S3)
      }
      if (MUTATION_TOOLS.has(toolName)) {
        throw new Error(MUTATION_BLOCK_MSG);
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      void input;
      const rule = [
        "",
        "## Sandbox routing rule (enforced by the routing guard plugin)",
        "- Before any project modification or execution, you may READ the host project freely (HOST_READ_ONLY).",
        "- The FIRST write/edit/patch/bash/install/test action activates this session's isolated sandbox worker.",
        "- After activation, ALL project reads must use sandbox_read / sandbox_list / sandbox_grep. Ordinary read/grep/glob/list on project paths are blocked.",
        "- All project edits and arbitrary commands run inside the sandbox worker. The host working tree remains unchanged.",
        "- You may still read approved external reference roots on the host (S6).",
        "- NEVER attempt host mutation (bash/edit/write outside the sandbox). Host changes require explicit user action.",
        "- To finish: sandbox_finish, then sandbox_apply (requires user approval). sandbox_discard abandons the result.",
        "",
      ].join("\n");
      output.system = `${output.system}${rule}`;
    },
  };
}
