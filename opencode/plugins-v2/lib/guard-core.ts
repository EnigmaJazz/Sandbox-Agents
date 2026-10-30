/**
 * Read-routing guard core for OpenCode V2 (docs/upgrades/opencode-v2.md, workstream V3).
 *
 * Port of opencode/plugins/routing-guard.ts. Dependency-free (the broker is injected), so broker/tests/ can
 * exercise it with fakes. Behaviour kept from V1 (SYSTEM_PROMPT.md §13, S5, §14):
 *  - once a worker is active, host reads of PROJECT paths are refused and the model is sent to sandbox_read /
 *    sandbox_grep / sandbox_list; approved external read roots stay readable (S6);
 *  - every other non-sandbox tool is admitted by the broker (toolAdmission); a denied, unclassified or malformed
 *    answer blocks the call;
 *  - fail closed: a broker that cannot be reached blocks the call.
 *
 * What differs on V2 (each verified on OpenCode V2 2.2.0, opencode-v2-probe FINDINGS.md / FINDINGS-2.md):
 *  - tool ids: the host shell is `shell` and the Task tool is `subagent`; the broker inventory
 *    (broker/src/role-policy.ts TOOL_CLASSIFICATION_INVENTORY) still uses `bash` and `task`, so they are translated
 *    before asking. Anything the inventory does not know, notably Code Mode's `execute`, comes back unclassified and
 *    is denied: Code Mode must not become a way around the guard.
 *  - input keys: read takes `path` (V1: filePath); grep takes `pattern` and `path`; glob takes `pattern`.
 *  - external-root matching resolves `..` first. V1 compared the raw string, so `<root>/../project` passed.
 *  - the denial reason is flattened with /[\r\n]+/ (V1's regex literal matched a backslash and the letters r and n).
 *  - session identity: V1 bound each session to its agent in a chat.params hook on every turn. V2 has no such hook and its
 *    plugin tools bind a session only inside their own execute, which runs AFTER this guard. A session that had not yet run a
 *    plugin tool therefore reached the broker unbound, was refused (UNBOUND_SESSION_MUTATION_DENIED), and the guard cached the
 *    refusal for the rest of the session. The guard now binds the session with the host-supplied agent before asking for
 *    admission, and never caches an answer that depended on the session being unbound. Authorization stays in the broker's
 *    role matrix: an unknown agent binds and is then denied there.
 *
 * Gate 1: NOT installed. Delivery is manual (S17): the USER reviews this diff and installs the exact bytes by hand.
 */
import { isAbsolute, resolve, sep } from "node:path";
import { BIND_SESSION_AGENT_OPERATION, hostSessionBinding } from "../../plugins/lib/session-agent-binding.ts";

export interface GuardBroker {
  request(operation: string, sessionID: string, payload?: unknown, agent?: string): Promise<unknown>;
}

export interface GuardEvent {
  tool: string;
  sessionID: string;
  input?: unknown;
  /** The host supplies the calling agent on every V2 tool call; the model cannot set it. */
  agent?: string;
}

export interface GuardDeps {
  /** Resolves the broker client; rejecting means "unreachable" and blocks the call. */
  broker: () => Promise<GuardBroker>;
}

const V2_TO_INVENTORY: Readonly<Record<string, string>> = { shell: "bash", subagent: "task" };

/**
 * Every answer the broker gives a session that has no bound agent starts with this. An answer like that says nothing about the
 * session once it is bound, so the guard never caches it. broker/tests/v2-routing-guard.test.ts checks the broker's real
 * admission function against this prefix, so a reworded reason fails a test instead of silently bringing the stale-cache bug back.
 */
export const UNBOUND_REASON_PREFIX = "UNBOUND_SESSION_";

const oneLine = (value: unknown): string => String(value instanceof Error ? value.message : value).replace(/[\r\n]+/g, " ");

export function toBrokerToolName(tool: string): string {
  return V2_TO_INVENTORY[tool] ?? tool;
}

const REDIRECT_MSG =
  "This session has an active isolated workspace. " +
  "Use sandbox_read/sandbox_grep/sandbox_list so you see the modified sandbox state.";

const APPLY_PREVIEW_TOOLS = new Set(["applyPreview", "sandbox_apply_preview", "hostApplyPreview"]);
const READ_TOOLS = new Set(["read", "grep", "glob", "list"]);
const STATE_CHANGING_TOOLS = new Set([
  "sandbox_write", "sandbox_edit", "sandbox_apply_patch", "sandbox_bash", "sandbox_finish",
  "sandbox_apply", "sandbox_discard", "sandbox_copy_in", "sandbox_copy_out",
]);
/** Input fields that carry path or pattern targets, per V2 tool. */
const READ_PATH_ARGS: Record<string, string[]> = {
  read: ["path"],
  grep: ["path", "pattern"],
  glob: ["pattern"],
  list: ["path"],
};

interface Admission {
  classification: string;
  decision: "allow" | "deny";
  reason: string;
}

function isExternalApproved(target: string, roots: string[]): boolean {
  if (!isAbsolute(target)) return false;
  const resolved = resolve(target);
  for (const root of roots) {
    const base = resolve(root);
    const prefix = base.endsWith(sep) ? base : `${base}${sep}`;
    if (resolved === base || resolved.startsWith(prefix)) return true;
  }
  return false;
}

function pathTargets(tool: string, input: unknown): string[] {
  const record = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return (READ_PATH_ARGS[tool] ?? []).filter((key) => typeof record[key] === "string").map((key) => String(record[key]));
}

export function createRoutingGuard(deps: GuardDeps) {
  const admissionCache = new Map<string, Admission>();
  let rootsCache: string[] | null = null;

  const boundAgents = new Map<string, string>();

  /**
   * Tell the broker who the host says this session is. Returns the cause when a first binding fails (the session stays unbound,
   * so admission refuses mutations: fail closed). When the session is already bound to another agent and the re-binding fails,
   * the call is refused outright: the broker still holds the old identity and a cached decision belongs to it.
   *
   * The allow-list handed to hostSessionBinding is the host-supplied agent itself, exactly as the sandbox-tools adapter does:
   * V2 agents bind as themselves and authorization is the broker's role matrix (an unknown agent binds and is then denied
   * there). What the helper checks here is only that the session id and agent are well formed.
   */
  async function ensureBound(broker: GuardBroker, sessionID: string, agent: string | undefined, tool: string): Promise<string | undefined> {
    const binding = hostSessionBinding({ sessionID, agent }, [agent ?? ""]);
    const current = binding ? boundAgents.get(binding.sessionID) : undefined;
    if (!binding || current === binding.agent) return undefined;
    try {
      await broker.request(BIND_SESSION_AGENT_OPERATION, binding.sessionID, { agent: binding.agent }, undefined);
    } catch (error) {
      if (current !== undefined) {
        throw new Error(
          `Tool "${tool}" is refused: the session could not be re-bound to "${binding.agent}" (${oneLine(error)}), ` +
            `and it is not decided under the previous identity "${current}".`,
        );
      }
      return oneLine(error);
    }
    boundAgents.set(binding.sessionID, binding.agent);
    clearAdmissionCache(binding.sessionID); // decisions made for another identity (or for none) no longer apply
    return undefined;
  }

  const clearAdmissionCache = (sessionID: string) => {
    const prefix = `${sessionID}\u0000`;
    for (const key of admissionCache.keys()) if (key.startsWith(prefix)) admissionCache.delete(key);
  };

  async function approvedRoots(broker: GuardBroker): Promise<string[]> {
    if (!rootsCache) {
      const policy = (await broker.request("policy", "guard", undefined, undefined)) as { approvedExternalReadRoots?: string[] };
      rootsCache = policy.approvedExternalReadRoots ?? [];
    }
    return rootsCache;
  }

  async function admit(broker: GuardBroker, sessionID: string, tool: string): Promise<Admission> {
    const name = toBrokerToolName(tool);
    const key = `${sessionID}\u0000${tool}`;
    const cached = admissionCache.get(key);
    if (cached) return cached;
    const reply = (await broker.request("toolAdmission", sessionID, { tool: name }, undefined)) as Record<string, unknown> | null;
    if (
      reply === null || typeof reply !== "object" || Array.isArray(reply) ||
      reply.schema !== "opencode-sandbox.tool-admission/v1" ||
      reply.tool !== name ||
      typeof reply.classification !== "string" ||
      (reply.decision !== "allow" && reply.decision !== "deny") ||
      typeof reply.reason !== "string"
    ) {
      throw new Error(`Tool "${tool}" broker admission returned a malformed reply.`);
    }
    const admission = { classification: reply.classification, decision: reply.decision, reason: reply.reason };
    // An answer given to an unbound session says nothing about the session once it is bound, so it is never remembered.
    if (!admission.reason.startsWith(UNBOUND_REASON_PREFIX)) admissionCache.set(key, admission);
    return admission;
  }

  return {
    /** Runs before every tool call; throwing refuses the call. */
    async before(event: GuardEvent): Promise<void> {
      const { tool, sessionID } = event;
      if (APPLY_PREVIEW_TOOLS.has(tool)) return;

      if (READ_TOOLS.has(tool)) {
        const broker = await deps.broker(); // rejects when unreachable: the call fails (fail closed)
        let status: { state: string };
        try {
          status = (await broker.request("workerStatus", sessionID, undefined, undefined)) as { state: string };
        } catch {
          return; // unknown session: host reads are the intended pre-activation mode (S3)
        }
        if (status.state !== "SANDBOX_ACTIVE" && status.state !== "RESULT_READY") return;
        const roots = await approvedRoots(broker);
        const targets = pathTargets(tool, event.input);
        if (targets.length > 0 && targets.every((target) => isExternalApproved(target, roots))) return; // S6
        throw new Error(REDIRECT_MSG);
      }

      if (tool.startsWith("sandbox_")) {
        if (STATE_CHANGING_TOOLS.has(tool)) clearAdmissionCache(sessionID);
        return;
      }

      const broker = await deps.broker();
      const bindFailure = await ensureBound(broker, sessionID, event.agent, tool);
      const admission = await admit(broker, sessionID, tool);
      if (admission.decision === "deny" || admission.classification === "unclassified") {
        const reason = admission.reason.replace(/[\r\n]+/g, " ");
        const hint = bindFailure && admission.reason.startsWith(UNBOUND_REASON_PREFIX) ? `; the session binding also failed: ${bindFailure}` : "";
        throw new Error(
          `Tool "${tool}" is denied by broker admission (${reason}${hint}). Legitimate tools are classified in TOOL_CLASSIFICATION_INVENTORY (broker/src/role-policy.ts); sandbox tools are not affected.`,
        );
      }
    },
  };
}

export const SYSTEM_RULE = [
  "",
  "## Sandbox routing rule (enforced by the routing guard plugin)",
  "- Before any project modification or execution, you may READ the host project freely (HOST_READ_ONLY).",
  "- The FIRST sandbox tool use (read, write, edit, patch, or command) activates this session's isolated sandbox worker.",
  "- After activation, ALL project reads must use sandbox_read / sandbox_list / sandbox_grep. Ordinary read/grep/glob/list on project paths are blocked.",
  "- All project edits and arbitrary commands run inside the sandbox worker. The host working tree remains unchanged.",
  "- You may still read approved external reference roots on the host (S6).",
  "- NEVER attempt host mutation (shell/edit/write outside the sandbox). Host changes require explicit user action.",
  "- To finish: sandbox_finish, then sandbox_apply (requires user approval). sandbox_discard abandons the result.",
  "",
  "## Sandbox tool contract",
  "- Reads: use the PLAIN host read/grep tools BEFORE activation (HOST_READ_ONLY). sandbox_read / sandbox_list / sandbox_grep need an ACTIVE worker and fail pre-activation - never call them first.",
  "- All sandbox_* file paths are RELATIVE to the project root (e.g. broker/src/service.ts) - never absolute (/work/...).",
  "- The FIRST mutation or execution (sandbox_write / sandbox_edit / sandbox_apply_patch / sandbox_bash) activates the worker. After activation, ALL project reads, writes and execution use the sandbox tools.",
  "- sandbox_bash is NOT a shell: argv only - no pipes, redirects, globs, &&, ;, or $(). Use it ONLY for read-only commands; never for file modification or git apply/reset/checkout.",
  "- sandbox_finish exports the result; sandbox_apply presents the diff, REQUIRES human approval, blocks until the user responds (expected), then applies. One apply per session.",
  "- sandbox_discard abandons the result. Host shell/edit/write are guard-blocked (S1/S10) - never attempt them.",
  "",
].join("\n");
