/**
 * OpenCode V2 mapping for the reviewer relay (docs/upgrades/opencode-v2.md, workstream V4).
 *
 * The relay stays: sandboxed agents have no shell by design, so the host-side plugin is what runs the provider
 * transport child (`gentle-ai review opencode-transport`) for the `asi-review-*` reviewer Tasks. All relay logic
 * (session-root selection, framing, spawn discipline, registry, refusals) is the host-neutral
 * opencode/plugins/lib/reviewer-relay-core.ts, shared with V1 and untouched. This module only translates V2 hook
 * shapes to the V1-shaped hooks that core exposes. Each V2 fact below was verified on OpenCode V2 2.2.0
 * (opencode-v2-probe, probe-relay fixture):
 *  - the Task tool is `subagent` with input {agent, description, prompt}; a before-hook may rewrite `input.prompt`
 *    and the child receives it, but V2 prepends "You are a subagent spawned by another session." to it;
 *  - the child's `context` hook event carries {sessionID, agent, system, messages}: system entries are
 *    {type:"text", text}, messages are {role, content:[{type:"text", text}]}; both can be rewritten in place, which
 *    replaces V1's two transform hooks and removes that prefix, so the reviewer sees the provider bytes only;
 *  - the after-hook gets `result` = {output:{sessionID,status,output}, content, metadata}; writing `result.content`
 *    replaces what the parent model sees;
 *  - `session.created` carries data {sessionID, parentID, agent, title}, `session.deleted` data {sessionID};
 *  - a thrown before-hook error reaches the model with its text intact (V1 swallowed it, so V1 returned refusals).
 *
 * Gate 1: NOT installed. Delivery is manual (S17): the USER reviews this diff and installs the exact bytes by hand.
 */
import { RELAY_AGENTS, type ReviewerRelayHooks } from "../../plugins/lib/reviewer-relay-core.ts";

export type RelayCore = Pick<
  ReviewerRelayHooks,
  | "dispose"
  | "event"
  | "experimental.chat.system.transform"
  | "experimental.chat.messages.transform"
  | "tool.execute.before"
  | "tool.execute.after"
>;

const RELAY_AGENT_SET = new Set<string>(RELAY_AGENTS);
const isRelayAgent = (value: unknown): value is string => typeof value === "string" && RELAY_AGENT_SET.has(value);

export interface RelayV2Options {
  /** How long a child's context hook waits for its session.created event before binding without the parent id. */
  childBindWaitMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function reviewerText(result: any): string | undefined {
  const structured = result?.output?.output;
  if (typeof structured === "string") return structured;
  const content = result?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("");
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

export function createRelayV2Handlers(core: RelayCore, options: RelayV2Options = {}) {
  const waitMs = options.childBindWaitMs ?? 1000;
  const known = new Set<string>();

  async function created(sessionID: string, agent: unknown, parentID: unknown, title: unknown) {
    if (isRelayAgent(agent)) known.add(sessionID);
    await core.event({
      event: {
        type: "session.created",
        properties: { info: { id: sessionID, agent, title, ...(typeof parentID === "string" ? { parentID } : {}) } },
      },
    });
  }

  return {
    async before(event: { tool: string; id: string; sessionID: string; input?: any }): Promise<void> {
      if (event.tool !== "subagent") return;
      const input = event.input;
      if (input === null || typeof input !== "object" || !isRelayAgent(input.agent)) return;
      const args: Record<string, unknown> = { subagent_type: input.agent, prompt: input.prompt };
      const refusal = await core["tool.execute.before"]({ tool: "task", sessionID: event.sessionID, callID: event.id }, { args });
      if (typeof args.prompt === "string") input.prompt = args.prompt;
      if (refusal && typeof refusal === "object" && "error" in refusal) throw new Error(String((refusal as { error: unknown }).error));
    },

    async after(event: { tool: string; id: string; sessionID: string; input?: any; status: string; result?: any; error?: unknown }): Promise<void> {
      if (event.tool !== "subagent") return;
      const agent = event.input?.agent;
      if (!isRelayAgent(agent)) return;
      const args = { subagent_type: agent };
      const hookInput = { tool: "task", sessionID: event.sessionID, callID: event.id, args };
      if (event.status !== "completed") {
        // The Task failed: let the core close its relay child. The failure itself stays what the host reported.
        await core["tool.execute.after"](hookInput, { args, output: undefined }).catch(() => undefined);
        return;
      }
      const output: { args: typeof args; output: unknown } = { args, output: reviewerText(event.result) };
      await core["tool.execute.after"](hookInput, output);
      const text = typeof output.output === "string" ? output.output : JSON.stringify(output.output ?? "");
      event.result.content = text;
      if (event.result.output && typeof event.result.output === "object") event.result.output.output = text;
    },

    async context(event: { sessionID: string; agent?: string; system: any[]; messages: any[] }): Promise<void> {
      const { sessionID } = event;
      if (isRelayAgent(event.agent) && !known.has(sessionID)) {
        for (let waited = 0; waited < waitMs && !known.has(sessionID); waited += 25) await sleep(25);
        if (!known.has(sessionID)) await created(sessionID, event.agent, undefined, undefined);
      }

      const before = event.system.map((entry) => (typeof entry === "string" ? entry : String(entry?.text ?? "")));
      const system = { system: [...before] };
      await core["experimental.chat.system.transform"]({ sessionID }, system);
      if (system.system.length !== before.length || system.system.some((text, index) => text !== before[index])) {
        event.system.splice(0, event.system.length, ...system.system.map((text) => ({ type: "text", text })));
      }

      // The core replaces text parts in place, so hand it the live part objects.
      const entries = event.messages.map((message) => ({
        info: { sessionID, role: message?.role },
        parts: Array.isArray(message?.content) ? message.content : [],
      }));
      await core["experimental.chat.messages.transform"]({ sessionID }, { messages: entries });
    },

    async event(event: { type: string; data?: any }): Promise<void> {
      const data = event?.data;
      if (data === null || typeof data !== "object" || typeof data.sessionID !== "string") return;
      if (event.type === "session.created") {
        await created(data.sessionID, data.agent, data.parentID, data.title);
      } else if (event.type === "session.deleted") {
        known.delete(data.sessionID);
        await core.event({ event: { type: "session.deleted", properties: { info: { id: data.sessionID } } } });
      }
    },

    dispose: () => core.dispose(),
  };
}
