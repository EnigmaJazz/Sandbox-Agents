/**
 * Quiet-by-default logging contract for the in-repo reviewer relay transport.
 *
 * The relay must not write journal lines for activity it has nothing to do
 * with: an unrelated tool call, an unrelated session's transform hooks, or a
 * non-relay Task. Per-call traces are opt-in behind GENTLE_AI_RELAY_DEBUG=1.
 * Diagnostics still log only types, lengths, counts, and classification, never
 * prompt content, tokens, or paths.
 *
 * These tests drive the plugin hooks through injected fakes: no real
 * `gentle-ai` child, no real OpenCode client, and no real broker socket.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTEXT_END,
  CONTEXT_START,
  TRANSPORT_SCHEMA,
  createReviewerRelayHooks,
  type ReviewerRelayHooks,
  type TransportChild,
  type TransportHandlers,
  type TransportSpawn,
} from "../../opencode/plugins/lib/reviewer-relay-core.ts";

const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "reviewer-relay-quiet-")));
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
const MATERIALIZED_CONTENT = `${CONTEXT_START}\nreview body\n${CONTEXT_END}`;
const MATERIALIZED_PROMPT = `GENTLE_AI_REVIEW_PROVIDER_MATERIALIZATION ${JSON.stringify({
  task_prompt: BINDING_PROMPT,
})}\n${MATERIALIZED_CONTENT}`;

/** A transport child that answers only the start frame with a prompt frame. */
class QuietScriptedChild implements TransportChild {
  killed = false;
  private readonly handlers: TransportHandlers;

  constructor(handlers: TransportHandlers) {
    this.handlers = handlers;
  }

  write(data: string): void {
    const frame = JSON.parse(data) as { operation?: unknown };
    if (frame.operation !== "start") return;
    const line = `${JSON.stringify({
      schema: TRANSPORT_SCHEMA,
      operation: "prompt",
      nonce: "nonce-1",
      prompt: MATERIALIZED_PROMPT,
    })}\n`;
    queueMicrotask(() => this.handlers.stdout(Buffer.from(line, "utf8")));
  }

  end(): void {}

  kill(): void {
    this.killed = true;
  }
}

function relayHooks(): ReviewerRelayHooks {
  const spawn: TransportSpawn = (_spec, handlers) => new QuietScriptedChild(handlers);
  return createReviewerRelayHooks({
    directory: canonicalOther,
    worktree: canonicalOther,
    client: { session: { get: async () => ({ data: { directory: canonicalRepo } }) } },
    brokerRequest: async () => ({ projects: [projectPath(canonicalRepo)] }),
    spawn,
    realpath: realpathSync,
    env: { HOME: "/home/reviewer", XDG_RUNTIME_DIR: "/run/user/1000", LANG: "C" },
    rootCache: new Map(),
    registry: new Map(),
  });
}

const taskInput = (sessionID: string, callID: string) => ({ tool: "task", sessionID, callID });

/** Run `body` while capturing every console.warn/console.error line. */
async function captureConsole<T>(body: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  const record = (...args: unknown[]) => {
    lines.push(args.map((value) => String(value)).join(" "));
  };
  console.warn = record;
  console.error = record;
  try {
    const result = await body();
    return { result, lines };
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
}

const relayLines = (lines: readonly string[]) => lines.filter((line) => line.includes("[reviewer-relay]"));

describe("reviewer relay quiet-by-default logging", () => {
  test("an unrelated tool call emits no reviewer-relay line", async () => {
    const hooks = relayHooks();
    const { lines } = await captureConsole(async () => {
      await hooks["tool.execute.before"]({ tool: "read", sessionID: "s-quiet", callID: "c-read" }, { args: {} });
      await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s-quiet", callID: "c-bash" }, { args: {} });
    });
    expect(relayLines(lines)).toEqual([]);
  });

  test("an unrelated session's transform hooks emit no reviewer-relay line", async () => {
    const hooks = relayHooks();
    const { lines } = await captureConsole(async () => {
      const system = { system: ["inherited instructions"] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "stranger" }, system);
      expect(system.system).toEqual(["inherited instructions"]);

      const messages = {
        messages: [{ info: { sessionID: "stranger", role: "user" }, parts: [{ type: "text", text: "hello" }] }],
      };
      await hooks["experimental.chat.messages.transform"]({}, messages);
      expect(messages.messages[0]?.parts?.[0]?.text).toBe("hello");
    });
    expect(relayLines(lines)).toEqual([]);
  });

  test("an unrelated task call emits no reviewer-relay line", async () => {
    const hooks = relayHooks();
    const { lines } = await captureConsole(async () => {
      const unrelated = { args: { subagent_type: "general", prompt: "unrelated" } };
      await hooks["tool.execute.before"](taskInput("s-quiet", "c-general"), unrelated);
      expect(unrelated.args.prompt).toBe("unrelated");
    });
    expect(relayLines(lines)).toEqual([]);
  });

  test("a relay-agent Task still logs its engagement and materializes the prompt", async () => {
    const hooks = relayHooks();
    const { lines } = await captureConsole(async () => {
      const before = { args: { subagent_type: "asi-review-risk", prompt: BINDING_PROMPT } };
      await hooks["tool.execute.before"](taskInput("s-relay-quiet", "c1"), before);
      expect(before.args.prompt).toBe(MATERIALIZED_PROMPT);
    });
    const engaged = relayLines(lines);
    expect(engaged.length).toBeGreaterThan(0);
    expect(engaged.some((line) => line.includes("asi-review-risk"))).toBe(true);
  });

  test("a relay-agent Task with no injectable prompt still refuses", async () => {
    const hooks = relayHooks();
    const before = { args: { subagent_type: "asi-review-risk", prompt: 42 } };
    const refusal = (await hooks["tool.execute.before"](taskInput("s-relay-quiet", "c1"), before)) as
      | { error?: unknown }
      | undefined;
    const message = typeof refusal?.error === "string" ? refusal.error : "";
    expect(message).toContain("reviewer_relay_task_refused");
  });

  test("GENTLE_AI_RELAY_DEBUG=1 restores the verbose per-call traces", async () => {
    const previous = process.env.GENTLE_AI_RELAY_DEBUG;
    process.env.GENTLE_AI_RELAY_DEBUG = "1";
    try {
      const hooks = relayHooks();
      const { lines } = await captureConsole(async () => {
        await hooks["tool.execute.before"]({ tool: "read", sessionID: "s-quiet", callID: "c-read" }, { args: {} });
        await hooks["tool.execute.before"](taskInput("s-quiet", "c-general"), {
          args: { subagent_type: "general", prompt: "unrelated" },
        });
        const system = { system: ["inherited"] };
        await hooks["experimental.chat.system.transform"]({ sessionID: "stranger" }, system);
        const messages = {
          messages: [{ info: { sessionID: "stranger", role: "user" }, parts: [{ type: "text", text: "hello" }] }],
        };
        await hooks["experimental.chat.messages.transform"]({}, messages);
      });
      const verbose = lines.join("\n");
      expect(verbose).toContain("tool.execute.before: tool=read");
      expect(verbose).toContain("subagent_type=general");
      expect(verbose).toContain("experimental.chat.system.transform");
      expect(verbose).toContain("experimental.chat.messages.transform");
    } finally {
      if (previous === undefined) delete process.env.GENTLE_AI_RELAY_DEBUG;
      else process.env.GENTLE_AI_RELAY_DEBUG = previous;
    }
  });
});
