/**
 * Pure mapping from the host-neutral tool table (opencode/plugins/lib/tool-specs-*.ts) to OpenCode V2 tool
 * definitions (docs/upgrades/opencode-v2.md, workstream V2).
 *
 * Dependency-free on purpose: no zod, no V2 SDK, no broker. The entry file (../sandbox-tools.ts) injects those, which
 * keeps this logic testable from broker/tests/ with fakes.
 *
 * What the V2 host changes, and how it is covered here:
 *  - the tool context has no `ask`: `ctx.ask(request)` becomes `ctx.permission.assert(...)` for the calling session and
 *    agent. A rejection throws, so the handler never gets past its approval. V2 approvals are per call, so the V1
 *    `always` list is dropped.
 *  - the tool context has no `directory`: it is looked up from the session (`sessionDirectory`).
 *  - the host supplies the calling agent on every tool call, so the broker session->agent binding (V1 `chat.params`)
 *    is made from the tool context before the handler runs. A failed bind never blocks the tool: host mutations then
 *    fail closed broker-side.
 *  - Code Mode could call a plugin tool from a script: every tool is registered with `codemode: false`.
 *
 * Gate 1: NOT installed. Delivery is manual (S17): the USER reviews this diff and installs the exact bytes by hand.
 */

/** Structural twin of HostToolSpec (opencode/plugins/lib/tool-runtime.ts), without importing its zod dependency. */
export interface HostToolSpecLike {
  description: string;
  args: Record<string, unknown>;
  execute: (args: any, ctx: HostToolContextLike) => Promise<any>;
}

export interface HostToolContextLike {
  sessionID: string;
  agent?: string;
  directory?: string;
  ask: (request: any) => Promise<unknown>;
}

/** The V2 tool context fields this adapter reads. */
export interface V2ToolContext {
  readonly sessionID: string;
  readonly agent: string;
}

export interface V2PermissionRequest {
  action: string;
  resources: string[];
  metadata: Record<string, unknown>;
  sessionID: string;
  agent?: string;
}

export interface V2AdapterDeps {
  /** zod's z.object, supplied by the entry file. */
  toInputSchema: (args: Record<string, unknown>) => unknown;
  bindSessionAgent: (sessionID: string, agent: string) => Promise<void>;
  assertPermission: (request: V2PermissionRequest) => Promise<unknown>;
  sessionDirectory: (sessionID: string) => Promise<string | undefined>;
}

export interface V2ToolDefinition {
  name: string;
  description: string;
  input: unknown;
  options: { codemode: false };
  execute: (input: any, context: V2ToolContext) => Promise<{ content: string }>;
}

export function askToPermission(ask: any, sessionID: string, agent: string | undefined): V2PermissionRequest {
  if (!ask || typeof ask.permission !== "string" || ask.permission.length === 0) {
    throw new Error("approval request has no permission name; refusing to assert an unnamed permission");
  }
  return {
    action: ask.permission,
    resources: Array.isArray(ask.patterns) && ask.patterns.length > 0 ? ask.patterns : ["*"],
    metadata: ask.metadata && typeof ask.metadata === "object" ? ask.metadata : {},
    sessionID,
    ...(agent ? { agent } : {}),
  };
}

export function resultToV2(value: unknown): { content: string } {
  if (typeof value === "string") return { content: value };
  if (value === undefined || value === null) return { content: "" };
  return { content: JSON.stringify(value, null, 2) };
}

export function adaptToolSpec(name: string, spec: HostToolSpecLike, deps: V2AdapterDeps): V2ToolDefinition {
  return {
    name,
    description: spec.description,
    input: deps.toInputSchema(spec.args),
    options: { codemode: false },
    execute: async (input, context) => {
      const { sessionID, agent } = context;
      try {
        await deps.bindSessionAgent(sessionID, agent);
      } catch {
        /* unbound sessions cannot run host mutations (fail closed) */
      }
      const directory = await deps.sessionDirectory(sessionID);
      const result = await spec.execute(input, {
        sessionID,
        agent,
        directory,
        ask: (request) => deps.assertPermission(askToPermission(request, sessionID, agent)),
      });
      return resultToV2(result);
    },
  };
}
