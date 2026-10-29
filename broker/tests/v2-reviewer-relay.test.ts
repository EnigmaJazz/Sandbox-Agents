import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTEXT_END,
  CONTEXT_START,
  RELAY_AGENTS,
  TRANSPORT_ISOLATION_SYSTEM,
  TRANSPORT_SCHEMA,
  createReviewerRelayHooks,
  type TransportChild,
  type TransportHandlers,
  type TransportSpawn,
} from "../../opencode/plugins/lib/reviewer-relay-core.ts";
import { createRelayV2Handlers } from "../../opencode/plugins-v2/lib/relay-v2.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "relay-v2-test-")));
const repo = join(root, "repo");
mkdirSync(repo);
mkdirSync(join(root, "other"));
const canonicalRepo = realpathSync(repo);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const BINDING_PROMPT = 'GENTLE_AI_REVIEW_BINDING {"repository_context":"rctx2_example","target":"T","lineage":"L"}';
const LENS_CONTENT = `${CONTEXT_START}\r\nline with "quotes"\r\n${CONTEXT_END}`;
const MATERIALIZED = `GENTLE_AI_REVIEW_PROVIDER_MATERIALIZATION ${JSON.stringify({ task_prompt: BINDING_PROMPT })}\n${LENS_CONTENT}`;
const ENV = { HOME: "/home/reviewer", XDG_RUNTIME_DIR: "/run/user/1000", LANG: "C" };

class ScriptedChild implements TransportChild {
  frames: any[] = [];
  killed = false;
  constructor(private handlers: TransportHandlers, private resultOutput: string) {}
  write(data: string) { this.reply(data); }
  end(data: string) { this.reply(data); }
  kill() { this.killed = true; }
  private reply(data: string) {
    const frame = JSON.parse(data);
    this.frames.push(frame);
    if (frame.operation === "start") {
      const line = `${JSON.stringify({ schema: TRANSPORT_SCHEMA, operation: "prompt", nonce: "n1", prompt: MATERIALIZED })}\n`;
      queueMicrotask(() => this.handlers.stdout(Buffer.from(line, "utf8")));
    } else if (frame.operation === "complete") {
      const line = `${JSON.stringify({ schema: TRANSPORT_SCHEMA, operation: "result", output: this.resultOutput })}\n`;
      queueMicrotask(() => {
        this.handlers.stdout(Buffer.from(line, "utf8"));
        this.handlers.close(0, null);
      });
    }
  }
}

function harness(options: { resultOutput?: string; sessionDirectory?: string } = {}) {
  const children: ScriptedChild[] = [];
  const spawn: TransportSpawn = (_spec, handlers) => {
    const child = new ScriptedChild(handlers, options.resultOutput ?? '{"admitted":true}');
    children.push(child);
    return child;
  };
  const core = createReviewerRelayHooks({
    directory: join(root, "other"),
    worktree: join(root, "other"),
    client: { session: { get: async () => ({ data: { directory: options.sessionDirectory ?? canonicalRepo } }) } },
    brokerRequest: async () => ({ projects: [{ id: "repo", path: canonicalRepo }] }),
    spawn,
    realpath: realpathSync,
    env: ENV,
    registry: new Map(),
    rootCache: new Map(),
  });
  const handlers = createRelayV2Handlers(core, { childBindWaitMs: 0 });
  return { handlers, children };
}

const PARENT = "ses_parent1";
const CHILD = "ses_child1";
const before = (input: Record<string, unknown>, id = "call_1") => ({ tool: "subagent", id, sessionID: PARENT, agent: "gentle-orchestrator", input });
const created = (agent: string, sessionID = CHILD, parentID = PARENT) => ({ type: "session.created", data: { sessionID, parentID, agent, title: "t" } });

describe("before hook (subagent -> provider prompt)", () => {
  test("replaces the Task prompt of a relay agent with the provider-materialized prompt", async () => {
    const h = harness();
    const input = { agent: "asi-review-risk", description: "review", prompt: BINDING_PROMPT };
    await h.handlers.before(before(input));
    expect(input.prompt).toBe(MATERIALIZED);
    expect(h.children).toHaveLength(1);
  });

  test("a non-relay subagent, the installed review-* names and other tools are untouched", async () => {
    const h = harness();
    for (const agent of ["general", "explore", "review-risk"]) {
      const input = { agent, description: "d", prompt: "ORIGINAL" };
      await h.handlers.before(before(input, `c-${agent}`));
      expect(input.prompt).toBe("ORIGINAL");
    }
    const other = { agent: "asi-review-risk", prompt: "ORIGINAL" };
    await h.handlers.before({ tool: "shell", id: "c-shell", sessionID: PARENT, agent: "x", input: other });
    expect(other.prompt).toBe("ORIGINAL");
    expect(h.children).toHaveLength(0);
  });

  test("a refusal is thrown so the model sees the typed text, and nothing is spawned for an unbound session root", async () => {
    const h = harness({ sessionDirectory: join(root, "elsewhere") });
    const input = { agent: "asi-review-risk", description: "d", prompt: BINDING_PROMPT };
    const error = await h.handlers.before(before(input)).catch((e) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toMatch(/relay|root|allowlist/i);
    expect(h.children).toHaveLength(0);
  });

  test("an input with no prompt is refused", async () => {
    const h = harness();
    await expect(h.handlers.before(before({ agent: "asi-review-risk" }))).rejects.toThrow(/prompt/);
  });

  test("every relay agent is handled", async () => {
    for (const agent of RELAY_AGENTS) {
      const h = harness();
      const input = { agent, description: "d", prompt: BINDING_PROMPT };
      await h.handlers.before(before(input));
      expect(input.prompt).toBe(MATERIALIZED);
    }
  });
});

describe("child session context", () => {
  async function started() {
    const h = harness();
    const input = { agent: "asi-review-risk", description: "d", prompt: BINDING_PROMPT };
    await h.handlers.before(before(input));
    await h.handlers.event(created("asi-review-risk"));
    return h;
  }

  test("a bound child gets only the transport boundary as system and the provider payload as its user message", async () => {
    const h = await started();
    const event = {
      sessionID: CHILD,
      agent: "asi-review-risk",
      system: [{ type: "text", text: "inherited agent prompt" }, { type: "text", text: "project rules" }],
      messages: [{ id: "m1", role: "user", content: [{ type: "text", text: `You are a subagent spawned by another session.\n${MATERIALIZED}` }], metadata: {} }],
    };
    await h.handlers.context(event as any);
    expect(event.system).toEqual([{ type: "text", text: TRANSPORT_ISOLATION_SYSTEM }]);
    expect(event.messages[0]!.content[0]!.text).toBe(MATERIALIZED);
  });

  test("the V2 'You are a subagent' prefix never reaches the reviewer", async () => {
    const h = await started();
    const event = {
      sessionID: CHILD, agent: "asi-review-risk", system: [{ type: "text", text: "x" }],
      messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "You are a subagent spawned by another session.\nOTHER" }], metadata: {} }],
    };
    await h.handlers.context(event as any);
    expect(event.messages[0]!.content[0]!.text).not.toContain("You are a subagent");
  });

  test("a session that is not a relay child is left alone", async () => {
    const h = await started();
    const event = { sessionID: "ses_other", agent: "build", system: [{ type: "text", text: "keep" }], messages: [{ id: "m", role: "user", content: [{ type: "text", text: "hi" }], metadata: {} }] };
    await h.handlers.context(event as any);
    expect(event.system).toEqual([{ type: "text", text: "keep" }]);
    expect(event.messages[0]!.content[0]!.text).toBe("hi");
  });

  test("a context that arrives before the session.created event still binds the child", async () => {
    const h = harness();
    await h.handlers.before(before({ agent: "asi-review-risk", description: "d", prompt: BINDING_PROMPT }));
    const event = {
      sessionID: CHILD, agent: "asi-review-risk", system: [{ type: "text", text: "x" }],
      messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "prefix\nX" }], metadata: {} }],
    };
    await h.handlers.context(event as any);
    expect(event.system).toEqual([{ type: "text", text: TRANSPORT_ISOLATION_SYSTEM }]);
    expect(event.messages[0]!.content[0]!.text).toBe(MATERIALIZED);
  });
});

describe("after hook (provider result replaces the reviewer's prose)", () => {
  const completed = (text: string, id = "call_1", agent = "asi-review-risk") => ({
    tool: "subagent", id, sessionID: PARENT, agent: "gentle-orchestrator", input: { agent, description: "d", prompt: "x" }, status: "completed" as const,
    result: { output: { sessionID: CHILD, status: "completed", output: text }, content: [{ type: "text", text: `<subagent sessionID="${CHILD}" state="completed">\n${text}\n</subagent>` }], metadata: {} },
  });

  test("returns the provider result unchanged in both projections", async () => {
    const h = harness({ resultOutput: '{"admitted":true}' });
    await h.handlers.before(before({ agent: "asi-review-risk", description: "d", prompt: BINDING_PROMPT }));
    const event = completed('{"verdict":"pass"}');
    await h.handlers.after(event as any);
    expect(event.result.content).toBe('{"admitted":true}');
    expect((event.result.output as any).output).toBe('{"admitted":true}');
    expect(h.children[0]!.frames.map((f) => f.operation)).toEqual(["start", "complete"]);
  });

  test("the reviewer's own words are what the provider is given to complete", async () => {
    const h = harness();
    await h.handlers.before(before({ agent: "asi-review-risk", description: "d", prompt: BINDING_PROMPT }));
    await h.handlers.after(completed("REVIEWER_JSON") as any);
    expect(h.children[0]!.frames.find((f) => f.operation === "complete")!.output).toBe("REVIEWER_JSON");
  });

  test("a completion with no matching before hook is refused, never passed through as success", async () => {
    const h = harness();
    const event = completed("raw reviewer prose", "call_orphan");
    await h.handlers.after(event as any);
    expect(String(event.result.content)).not.toContain("raw reviewer prose");
    expect(String(event.result.content)).toMatch(/relay|before hook/i);
  });

  test("a non-relay subagent completion is untouched", async () => {
    const h = harness();
    const event = completed("plain", "call_x", "general");
    const original = JSON.stringify(event.result);
    await h.handlers.after(event as any);
    expect(JSON.stringify(event.result)).toBe(original);
  });

  test("a failed reviewer Task still closes the relay child", async () => {
    const h = harness();
    await h.handlers.before(before({ agent: "asi-review-risk", description: "d", prompt: BINDING_PROMPT }));
    await h.handlers.after({
      tool: "subagent", id: "call_1", sessionID: PARENT, agent: "gentle-orchestrator",
      input: { agent: "asi-review-risk", description: "d", prompt: "x" }, status: "error", error: { message: "boom" },
    } as any);
    expect(h.children[0]!.killed || h.children[0]!.frames.some((f) => f.operation === "complete")).toBe(true);
  });
});

describe("events", () => {
  test("session.deleted releases the relay for that parent", async () => {
    const h = harness();
    await h.handlers.before(before({ agent: "asi-review-risk", description: "d", prompt: BINDING_PROMPT }));
    await h.handlers.event({ type: "session.deleted", data: { sessionID: PARENT } });
    expect(h.children[0]!.killed).toBe(true);
  });

  test("unrelated and malformed events are ignored", async () => {
    const h = harness();
    await h.handlers.event({ type: "session.updated", data: {} });
    await h.handlers.event({ type: "session.created", data: null } as any);
    await h.handlers.event({ type: "session.created", data: { sessionID: 5 } } as any);
  });

  test("dispose closes everything it owns", async () => {
    const h = harness();
    await h.handlers.before(before({ agent: "asi-review-risk", description: "d", prompt: BINDING_PROMPT }));
    await h.handlers.dispose();
    expect(h.children[0]!.killed).toBe(true);
  });
});

describe("V2 reviewer relay agent fragment", () => {
  const strip = (path: string) =>
    JSON.parse(readFileSync(path, "utf8").split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n"));
  const v1 = strip(join(import.meta.dir, "../../opencode/config-fragments/reviewer-relay-agents.jsonc"));
  const v2 = strip(join(import.meta.dir, "../../opencode/plugins-v2/config-fragments/reviewer-relay-agents.jsonc"));

  test("declares the same six agents as V1", () => {
    expect(Object.keys(v2.agent).sort()).toEqual([...RELAY_AGENTS].sort());
    expect(v2.agent).toEqual(v1.agent);
  });

  test("every agent is a hidden, tool-less subagent that cannot spawn subagents", () => {
    for (const [name, agent] of Object.entries<any>(v2.agent)) {
      expect([name, agent.hidden, agent.mode, agent.tools["*"]]).toEqual([name, true, "subagent", false]);
      expect(agent.permission.task).toEqual({ "*": "deny" });
      expect(agent.permission.edit).toBe("deny");
    }
  });
});
