/**
 * Delivery tests for the reviewer relay prompt placement.
 *
 * The provider materializes the reviewer payload as the Task (user) message.
 * This host ignores the relay's `output.args.prompt` replacement, so the relay
 * delivers the materialized prompt as the reviewer child session's LAST USER
 * message through `experimental.chat.messages.transform`, mirroring the
 * installed transport's task-prompt replacement. The child's system slot keeps
 * only the small transport boundary via `experimental.chat.system.transform`,
 * so the multi-hundred-KB prompt never lands outside the provider's
 * user-message contract. These tests drive the hooks through injected fakes:
 * no real `gentle-ai` child, no real OpenCode client, and no real broker socket.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTEXT_END,
  CONTEXT_START,
  TRANSPORT_ISOLATION_SYSTEM,
  TRANSPORT_SCHEMA,
  createReviewerRelayHooks,
  type MessagesTransformOutput,
  type ReviewerRelayHooks,
  type TransportChild,
  type TransportHandlers,
  type TransportSpawn,
  type TransportSpawnSpec,
} from "../../opencode/plugins/lib/reviewer-relay-core.ts";

const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "reviewer-relay-delivery-")));
const repoRoot = join(fixtureRoot, "repo");
const otherRoot = join(fixtureRoot, "other");
mkdirSync(repoRoot);
mkdirSync(otherRoot);
const canonicalRepo = realpathSync(repoRoot);
const canonicalOther = realpathSync(otherRoot);

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

const projectPath = (path: string) => ({ id: path.split("/").pop() ?? "project", path });

const BINDING_PROMPT =
  'GENTLE_AI_REVIEW_BINDING {"repository_context":"rctx2_example","target":"T","lineage":"L"}';
/** The lens provider content block carried after the Go materialization header. */
const MATERIALIZED_CONTENT = `${CONTEXT_START}\nreview body\n${CONTEXT_END}`;
/** A full Go envelope: the materialization header, JSON, and the lens content. */
const MATERIALIZED_PROMPT = `GENTLE_AI_REVIEW_PROVIDER_MATERIALIZATION ${JSON.stringify({
  task_prompt: BINDING_PROMPT,
})}\n${MATERIALIZED_CONTENT}`;

/** A transport child that answers only the start frame with a prompt frame. */
class PromptOnlyChild implements TransportChild {
  killed = false;
  private readonly handlers: TransportHandlers;
  private readonly promptBody: string;

  constructor(handlers: TransportHandlers, promptBody: string) {
    this.handlers = handlers;
    this.promptBody = promptBody;
  }

  write(data: string): void {
    const frame = JSON.parse(data) as { operation?: unknown };
    if (frame.operation !== "start") return;
    const line = `${JSON.stringify({
      schema: TRANSPORT_SCHEMA,
      operation: "prompt",
      nonce: "nonce-1",
      prompt: this.promptBody,
    })}\n`;
    queueMicrotask(() => this.handlers.stdout(Buffer.from(line, "utf8")));
  }

  end(): void {}

  kill(): void {
    this.killed = true;
  }
}

interface DeliveryHarness {
  hooks: ReviewerRelayHooks;
  specs: TransportSpawnSpec[];
}

/** Build hooks whose spawned children answer with the given prompt bodies. */
function deliveryHarness(promptBodies: readonly string[]): DeliveryHarness {
  const specs: TransportSpawnSpec[] = [];
  let spawned = 0;
  const spawn: TransportSpawn = (spec, handlers) => {
    const body = promptBodies[spawned] ?? promptBodies[promptBodies.length - 1];
    spawned += 1;
    specs.push(spec);
    return new PromptOnlyChild(handlers, body ?? MATERIALIZED_PROMPT);
  };
  const hooks = createReviewerRelayHooks({
    directory: canonicalOther,
    worktree: canonicalOther,
    client: { session: { get: async () => ({ data: { directory: canonicalRepo } }) } },
    brokerRequest: async () => ({ projects: [projectPath(canonicalRepo)] }),
    spawn,
    realpath: realpathSync,
    env: { HOME: "/home/reviewer", XDG_RUNTIME_DIR: "/run/user/1000", LANG: "C" },
    registry: new Map(),
  });
  return { hooks, specs };
}

const taskInput = (sessionID: string, callID: string) => ({ tool: "task", sessionID, callID });

const sessionCreated = (info: Record<string, unknown>) => ({
  event: { type: "session.created", properties: { info } },
});
const sessionDeleted = (id: string) => ({
  event: { type: "session.deleted", properties: { info: { id } } },
});

/** The last-user-message shape the messages transform receives for one session. */
function chatMessage(sessionID: string, text: string): MessagesTransformOutput {
  return {
    messages: [{ info: { sessionID, role: "user" }, parts: [{ type: "text", text }] }],
  };
}

describe("reviewer relay materialized prompt delivery", () => {
  test("a bound reviewer session receives the provider-materialized prompt as its last user message", async () => {
    const { hooks } = deliveryHarness([MATERIALIZED_PROMPT]);
    await hooks["tool.execute.before"](taskInput("s-deliver", "c1"), {
      args: { subagent_type: "asi-review-risk", prompt: BINDING_PROMPT },
    });
    await hooks.event(sessionCreated({ id: "child-deliver", parentID: "s-deliver", agent: "asi-review-risk" }));

    const chat = chatMessage("child-deliver", BINDING_PROMPT);
    await hooks["experimental.chat.messages.transform"]({}, chat);
    expect(chat.messages[0]?.parts?.[0]?.text).toBe(MATERIALIZED_PROMPT);

    const reviewerSystem = { system: ["inherited live agent instructions"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "child-deliver" }, reviewerSystem);
    expect(reviewerSystem.system).toEqual([TRANSPORT_ISOLATION_SYSTEM]);
  });

  test("a session with no binding is untouched by the messages transform", async () => {
    const { hooks } = deliveryHarness([MATERIALIZED_PROMPT]);
    await hooks.event(sessionCreated({ id: "child-unbound", parentID: "s-none", agent: "asi-review-refuter" }));

    const tracked = chatMessage("child-unbound", "original tracked text");
    await hooks["experimental.chat.messages.transform"]({}, tracked);
    expect(tracked.messages[0]?.parts?.[0]?.text).toBe("original tracked text");

    const stranger = chatMessage("child-not-tracked", "stranger text");
    await hooks["experimental.chat.messages.transform"]({}, stranger);
    expect(stranger.messages[0]?.parts?.[0]?.text).toBe("stranger text");

    const system = { system: ["inherited instructions"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "child-unbound" }, system);
    expect(system.system).toEqual([TRANSPORT_ISOLATION_SYSTEM]);

    const strangerSystem = { system: ["inherited instructions"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "child-not-tracked" }, strangerSystem);
    expect(strangerSystem.system).toEqual(["inherited instructions"]);
  });

  test("only the last user message is replaced when a session carries history", async () => {
    const { hooks } = deliveryHarness([MATERIALIZED_PROMPT]);
    await hooks["tool.execute.before"](taskInput("s-history", "c1"), {
      args: { subagent_type: "asi-review-reliability", prompt: BINDING_PROMPT },
    });
    await hooks.event(sessionCreated({ id: "child-history", parentID: "s-history", agent: "asi-review-reliability" }));

    const chat: MessagesTransformOutput = {
      messages: [
        { info: { sessionID: "child-history", role: "user" }, parts: [{ type: "text", text: "earlier user" }] },
        {
          info: { sessionID: "child-history", role: "assistant" },
          parts: [{ type: "text", text: "assistant reply" }],
        },
        { info: { sessionID: "child-history", role: "user" }, parts: [{ type: "text", text: BINDING_PROMPT }] },
      ],
    };
    await hooks["experimental.chat.messages.transform"]({}, chat);
    expect(chat.messages[0]?.parts?.[0]?.text).toBe("earlier user");
    expect(chat.messages[1]?.parts?.[0]?.text).toBe("assistant reply");
    expect(chat.messages[2]?.parts?.[0]?.text).toBe(MATERIALIZED_PROMPT);
  });

  test("concurrent lens reviewers each receive their own materialized prompt", async () => {
    const reliabilityMaterialized = `GENTLE_AI_REVIEW_PROVIDER_MATERIALIZATION ${JSON.stringify({
      task_prompt: BINDING_PROMPT,
    })}\n${CONTEXT_START}\nreliability body\n${CONTEXT_END}`;
    const { hooks, specs } = deliveryHarness([MATERIALIZED_PROMPT, reliabilityMaterialized]);

    await hooks["tool.execute.before"](taskInput("s-lenses", "c-risk"), {
      args: { subagent_type: "asi-review-risk", prompt: BINDING_PROMPT },
    });
    await hooks["tool.execute.before"](taskInput("s-lenses", "c-resilience"), {
      args: { subagent_type: "asi-review-resilience", prompt: BINDING_PROMPT },
    });
    expect(specs).toHaveLength(2);

    await hooks.event(sessionCreated({ id: "child-risk", parentID: "s-lenses", agent: "asi-review-risk" }));
    await hooks.event(
      sessionCreated({
        id: "child-resilience",
        parentID: "s-lenses",
        title: "review (@asi-review-resilience subagent)",
      }),
    );

    const riskChat = chatMessage("child-risk", BINDING_PROMPT);
    await hooks["experimental.chat.messages.transform"]({}, riskChat);
    expect(riskChat.messages[0]?.parts?.[0]?.text).toBe(MATERIALIZED_PROMPT);

    const resilienceChat = chatMessage("child-resilience", BINDING_PROMPT);
    await hooks["experimental.chat.messages.transform"]({}, resilienceChat);
    expect(resilienceChat.messages[0]?.parts?.[0]?.text).toBe(reliabilityMaterialized);
  });

  test("session.deleted clears the tracked child so a later transform leaves it untouched", async () => {
    const { hooks } = deliveryHarness([MATERIALIZED_PROMPT]);
    await hooks["tool.execute.before"](taskInput("s-delete", "c1"), {
      args: { subagent_type: "asi-review-validator", prompt: BINDING_PROMPT },
    });
    await hooks.event(sessionCreated({ id: "child-delete", parentID: "s-delete", agent: "asi-review-validator" }));

    const beforeDelete = chatMessage("child-delete", "original before delete");
    await hooks["experimental.chat.messages.transform"]({}, beforeDelete);
    expect(beforeDelete.messages[0]?.parts?.[0]?.text).toBe(MATERIALIZED_PROMPT);

    await hooks.event(sessionDeleted("child-delete"));

    const afterDelete = chatMessage("child-delete", "original after delete");
    await hooks["experimental.chat.messages.transform"]({}, afterDelete);
    expect(afterDelete.messages[0]?.parts?.[0]?.text).toBe("original after delete");

    const afterDeleteSystem = { system: ["inherited"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "child-delete" }, afterDeleteSystem);
    expect(afterDeleteSystem.system).toEqual(["inherited"]);
  });
});
