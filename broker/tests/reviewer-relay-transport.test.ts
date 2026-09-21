/**
 * RED contract and security tests for the in-repo reviewer relay transport.
 *
 * These tests drive the plugin module through injected fakes: no real
 * `gentle-ai` child, no real OpenCode client, and no real broker socket is
 * touched. They prove the boundaries that make the relay safe to install:
 * session-root selection, hook scope, provider framing fidelity, spawn
 * discipline, output bounds, deadline, lifecycle refusals, and the reviewed
 * agent fragment plus Task-name mapping.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CONTEXT_END,
  CONTEXT_START,
  INSTALLED_REVIEW_AGENTS,
  MAX_CONCURRENT_RELAYS,
  RELAY_AGENTS,
  RELAY_DEADLINE_MS,
  STDERR_LIMIT_BYTES,
  STDOUT_FRAME_LIMIT_BYTES,
  TRANSPORT_ARGV,
  TRANSPORT_BINARY,
  TRANSPORT_ISOLATION_SYSTEM,
  TRANSPORT_SCHEMA,
  buildCompleteFrame,
  buildStartFrame,
  buildTransportEnv,
  createNodeTransportSpawn,
  createReviewerRelayHooks,
  createSessionRootResolver,
  decodeTransportFrame,
  selectCanonicalSessionRoot,
  startRelay,
  validateMaterializedPrompt,
  type RawNodeSpawn,
  type Relay,
  type RelayRegistry,
  type ReviewerRelayHooks,
  type TransportChild,
  type TransportHandlers,
  type TransportSpawn,
  type TransportSpawnSpec,
} from "../../opencode/plugins/lib/reviewer-relay-core.ts";
import * as reviewerRelayPlugin from "../../opencode/plugins/reviewer-relay-transport.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "reviewer-relay-test-")));
const repoRoot = join(fixtureRoot, "repo");
const otherRoot = join(fixtureRoot, "other");
mkdirSync(repoRoot);
mkdirSync(otherRoot);
const canonicalRepo = realpathSync(repoRoot);
const canonicalOther = realpathSync(otherRoot);
const symlinkRoot = join(fixtureRoot, "repo-link");
symlinkSync(canonicalRepo, symlinkRoot);

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

const projectPath = (path: string) => ({ id: path.split("/").pop() ?? "project", path });

/** The fixed environment the relay is allowed to forward to the child. */
const ENV = { HOME: "/home/reviewer", XDG_RUNTIME_DIR: "/run/user/1000", LANG: "C" };

/**
 * Known git install directories, mirroring buildTransportEnv's ordered probe.
 * The first one that actually contains a git binary on this host is what the
 * relay prepends to the child PATH.
 */
const PROBE_DIRECTORIES = [
  "/home/linuxbrew/.linuxbrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
] as const;
const HOST_GIT_DIRECTORY = PROBE_DIRECTORIES.find((directory) => existsSync(`${directory}/git`));

/**
 * The relay's own runtime directory, mirroring buildTransportEnv: the
 * directory of the binary executing this test run (`process.execPath`).
 */
const RUNTIME_DIRECTORY = dirname(process.execPath);

/** A binding-only Task prompt: the small provider-issued line the Task carries. */
const BINDING_PROMPT =
  'GENTLE_AI_REVIEW_BINDING {"repository_context":"rctx2_example","target":"T","lineage":"L"}';

/** A provider-role binding Task prompt (refuter/validator). */
const ROLE_TASK_PROMPT =
  'GENTLE_AI_REVIEW_PROVIDER_TASK {"repository_context":"rctx2_example","target":"T","lineage":"L","role":"refuter"}';

/** Wrap Go materialization bytes: the JSON task prompt plus the provider content. */
function goEnvelope(taskPrompt: string, providerContent: string): string {
  return `GENTLE_AI_REVIEW_PROVIDER_MATERIALIZATION ${JSON.stringify({ task_prompt: taskPrompt })}\n${providerContent}`;
}

/** The lens provider content block, byte-preserved through the relay. */
const LENS_CONTENT = `${CONTEXT_START}\r\nline\twith "quotes" and unicode \u2705\r\n  trailing  spaces  \n${CONTEXT_END}`;

/** A full Go envelope around the lens content. */
const MATERIALIZED_PROMPT = goEnvelope(BINDING_PROMPT, LENS_CONTENT);

const REFUSAL_ENVELOPE = "opencode_reviewer_relay_refused";

/** Capture a typed refusal instead of asserting on an opaque throw. */
async function refusalOf(run: () => unknown): Promise<{ code: string; message: string }> {
  try {
    await run();
  } catch (cause) {
    const error = cause as { code?: unknown; message?: unknown };
    return {
      code: typeof error.code === "string" ? error.code : "",
      message: String(error.message ?? ""),
    };
  }
  throw new Error("expected a typed refusal but the call resolved");
}

/**
 * Read the typed refusal a hook delivers as a tool-error result. The refusal
 * must be returned, not thrown: this host turns a throw from a hook into a
 * generic abort, which drops the typed text before the model can see it.
 */
function deliveredError(result: unknown): string {
  const value = result as { error?: unknown } | undefined;
  return typeof value?.error === "string" ? value.error : "";
}

interface FrameRecord {
  schema: string;
  operation: string;
  [key: string]: unknown;
}

function promptFrame(nonce: string, prompt: string): string {
  return `${JSON.stringify({ schema: TRANSPORT_SCHEMA, operation: "prompt", nonce, prompt })}\n`;
}

function resultFrame(output: string): string {
  return `${JSON.stringify({ schema: TRANSPORT_SCHEMA, operation: "result", output })}\n`;
}

class FakeTransportChild implements TransportChild {
  readonly written: string[] = [];
  readonly ended: string[] = [];
  killed = false;
  private readonly handlers: TransportHandlers;

  constructor(handlers: TransportHandlers) {
    this.handlers = handlers;
  }

  write(data: string): void {
    this.written.push(data);
  }

  end(data: string): void {
    this.ended.push(data);
  }

  kill(): void {
    this.killed = true;
  }

  emitStdout(text: string): void {
    this.handlers.stdout(Buffer.from(text, "utf8"));
  }

  /** Emit raw stdout bytes so a test can split a multibyte code point. */
  emitStdoutBytes(bytes: Buffer): void {
    this.handlers.stdout(bytes);
  }

  emitStderr(text: string): void {
    this.handlers.stderr(Buffer.from(text, "utf8"));
  }

  emitError(cause: unknown): void {
    this.handlers.error(cause);
  }

  emitClose(code: number | null = 1, signal: string | null = null): void {
    this.handlers.close(code, signal);
  }
}

interface SpawnRecorder {
  spawn: TransportSpawn;
  child: () => FakeTransportChild;
  specs: TransportSpawnSpec[];
}

function recordingSpawn(): SpawnRecorder {
  const specs: TransportSpawnSpec[] = [];
  let last: FakeTransportChild | null = null;
  const spawn: TransportSpawn = (spec, handlers) => {
    specs.push(spec);
    last = new FakeTransportChild(handlers);
    return last;
  };
  return {
    spawn,
    specs,
    child: () => {
      if (last === null) throw new Error("transport was never spawned");
      return last;
    },
  };
}

interface RawSpawnRecorder {
  rawSpawn: RawNodeSpawn;
  calls: { command: string; argv: string[]; options: Record<string, unknown> }[];
}

function recordingRawSpawn(): RawSpawnRecorder {
  const calls: RawSpawnRecorder["calls"] = [];
  const noop = () => {};
  const rawSpawn = ((command: string, argv: string[], options: Record<string, unknown>) => {
    calls.push({ command, argv, options });
    return {
      stdout: { on: noop },
      stderr: { on: noop },
      stdin: { write: noop, end: noop },
      on: noop,
      kill: noop,
    };
  }) as unknown as RawNodeSpawn;
  return { rawSpawn, calls };
}

// ---------------------------------------------------------------------------
// Requirement: session-repository root resolution
// ---------------------------------------------------------------------------

describe("reviewer relay session root selection", () => {
  test("accepts the exact canonical allowlisted root", () => {
    const selected = selectCanonicalSessionRoot({
      sessionDirectory: canonicalRepo,
      serverRoot: canonicalOther,
      projectPaths: [projectPath(canonicalRepo)],
      realpath: realpathSync,
    });
    expect(selected).toBe(canonicalRepo);
  });

  test("refuses a relative root", () => {
    expect(() =>
      selectCanonicalSessionRoot({
        sessionDirectory: "repo",
        serverRoot: canonicalOther,
        projectPaths: [projectPath(canonicalRepo)],
        realpath: realpathSync,
      }),
    ).toThrow("reviewer_relay_root_refused");
  });

  test("refuses a symlinked noncanonical root", () => {
    const refusal = () =>
      selectCanonicalSessionRoot({
        sessionDirectory: symlinkRoot,
        serverRoot: canonicalOther,
        projectPaths: [projectPath(canonicalRepo)],
        realpath: realpathSync,
      });
    expect(refusal).toThrow("reviewer_relay_root_refused");
    expect(refusal).toThrow("canonical");
  });

  test("refuses the plugin server root even when it is allowlisted", () => {
    expect(() =>
      selectCanonicalSessionRoot({
        sessionDirectory: canonicalRepo,
        serverRoot: canonicalRepo,
        projectPaths: [projectPath(canonicalRepo)],
        realpath: realpathSync,
      }),
    ).toThrow("reviewer_relay_root_refused");
  });

  test("refuses a root outside the broker allowlist", () => {
    expect(() =>
      selectCanonicalSessionRoot({
        sessionDirectory: canonicalOther,
        serverRoot: canonicalRepo,
        projectPaths: [projectPath(canonicalRepo)],
        realpath: realpathSync,
      }),
    ).toThrow("reviewer_relay_root_refused");
  });

  test("refuses git -C-like selector roots", () => {
    for (const selector of [`${canonicalRepo} -C ${canonicalOther}`, "-C", `--git-dir=${canonicalRepo}`]) {
      expect(() =>
        selectCanonicalSessionRoot({
          sessionDirectory: selector,
          serverRoot: canonicalOther,
          projectPaths: [projectPath(canonicalRepo)],
          realpath: realpathSync,
        }),
      ).toThrow("reviewer_relay_root_refused");
    }
  });

  test("refuses control characters and NUL in a candidate root", () => {
    for (const candidate of [`${canonicalRepo}\n`, `${canonicalRepo}\u0000`, `${canonicalRepo}\u001b[31m`]) {
      expect(() =>
        selectCanonicalSessionRoot({
          sessionDirectory: candidate,
          serverRoot: canonicalOther,
          projectPaths: [projectPath(canonicalRepo)],
          realpath: realpathSync,
        }),
      ).toThrow("reviewer_relay_root_refused");
    }
  });

  test("refuses a missing or malformed session directory", () => {
    for (const candidate of [undefined, "", 7, { directory: canonicalRepo }, `${canonicalRepo}/absent`]) {
      expect(() =>
        selectCanonicalSessionRoot({
          sessionDirectory: candidate,
          serverRoot: canonicalOther,
          projectPaths: [projectPath(canonicalRepo)],
          realpath: realpathSync,
        }),
      ).toThrow("reviewer_relay_root_refused");
    }
  });

  test("refuses an allowlist entry that is not a canonical absolute project path", () => {
    for (const paths of [[], ["repo"], [{ id: "p" }], [projectPath(`${canonicalRepo}/absent`)]]) {
      expect(() =>
        selectCanonicalSessionRoot({
          sessionDirectory: canonicalRepo,
          serverRoot: canonicalOther,
          projectPaths: paths as readonly unknown[],
          realpath: realpathSync,
        }),
      ).toThrow("reviewer_relay_root_refused");
    }
  });

  test("resolver queries the session and the broker once, then serves the immutable cache", async () => {
    const cache = new Map<string, string>();
    let sessionLookups = 0;
    let policyLookups = 0;
    const resolve = createSessionRootResolver({
      lookupSessionDirectory: async () => {
        sessionLookups += 1;
        return canonicalRepo;
      },
      loadAllowlistedPaths: async () => {
        policyLookups += 1;
        return [canonicalRepo];
      },
      realpath: realpathSync,
      serverRoot: canonicalOther,
      cache,
    });

    expect(await resolve("session-1")).toBe(canonicalRepo);
    expect(await resolve("session-1")).toBe(canonicalRepo);
    expect(sessionLookups).toBe(1);
    expect(policyLookups).toBe(1);
    expect(cache.get("session-1")).toBe(canonicalRepo);
  });

  test("resolver never falls back to the server project when lookup fails", async () => {
    const resolve = createSessionRootResolver({
      lookupSessionDirectory: async () => {
        throw new Error("session.get unavailable");
      },
      loadAllowlistedPaths: async () => [canonicalRepo],
      realpath: realpathSync,
      serverRoot: canonicalOther,
      cache: new Map<string, string>(),
    });
    const refusal = await refusalOf(() => resolve("session-2"));
    expect(refusal.code).toBe("reviewer_relay_session_lookup_failed");
  });

  test("resolver refuses a broker policy without a usable projects list", async () => {
    const resolve = createSessionRootResolver({
      lookupSessionDirectory: async () => canonicalRepo,
      loadAllowlistedPaths: async () => {
        throw new Error("broker unavailable");
      },
      realpath: realpathSync,
      serverRoot: canonicalOther,
      cache: new Map<string, string>(),
    });
    const refusal = await refusalOf(() => resolve("session-3"));
    expect(refusal.code).toBe("reviewer_relay_policy_refused");
  });
});

// ---------------------------------------------------------------------------
// Requirement: verbatim and complete provider framing
// ---------------------------------------------------------------------------

describe("reviewer relay provider framing", () => {
  test("pins the provider transport schema", () => {
    expect(TRANSPORT_SCHEMA).toBe("gentle-ai.provider-transport/v1");
    expect(decodeTransportFrame(JSON.stringify({ schema: TRANSPORT_SCHEMA, operation: "prompt" }))).toEqual({
      schema: TRANSPORT_SCHEMA,
      operation: "prompt",
    });
  });

  test("refuses malformed, non-object, and unexpected-key frames", () => {
    const lines = [
      "not json",
      "[]",
      "null",
      JSON.stringify({ schema: "other/v1", operation: "prompt" }),
      JSON.stringify({ schema: TRANSPORT_SCHEMA, operation: "prompt", extra: 1 }),
      JSON.stringify({ schema: TRANSPORT_SCHEMA, operation: 7 }),
      JSON.stringify({ schema: TRANSPORT_SCHEMA, operation: "prompt", nonce: 1 }),
    ];
    for (const line of lines) {
      expect(() => decodeTransportFrame(line)).toThrow("reviewer_relay_frame_malformed");
    }
  });

  test("valid frame is preserved byte-for-byte", async () => {
    const recorder = recordingSpawn();
    const relay = startRelay({
      cwd: canonicalRepo,
      prompt: BINDING_PROMPT,
      spawn: recorder.spawn,
      realpath: realpathSync,
      env: ENV,
    });
    recorder.child().emitStdout(promptFrame("nonce-bytes", MATERIALIZED_PROMPT));
    const materialized = await relay.prompt;
    expect(materialized.nonce).toBe("nonce-bytes");
    expect(materialized.prompt).toBe(MATERIALIZED_PROMPT);
    expect(materialized.prompt.endsWith(CONTEXT_END)).toBe(true);
  });

  test("preserves a multibyte code point split across two stdout chunks", async () => {
    const recorder = recordingSpawn();
    const relay = startRelay({
      cwd: canonicalRepo,
      prompt: BINDING_PROMPT,
      spawn: recorder.spawn,
      realpath: realpathSync,
      env: ENV,
    });
    const body = goEnvelope(
      BINDING_PROMPT,
      `${CONTEXT_START}\nemoji \u{1F600} plus \u2705 check\n${CONTEXT_END}`,
    );
    const frameBytes = Buffer.from(promptFrame("nonce-split", body), "utf8");
    const emojiStart = frameBytes.indexOf(Buffer.from("\u{1F600}", "utf8"));
    expect(emojiStart).toBeGreaterThan(-1);
    // Split inside the four-byte code point, not on a byte boundary.
    const splitAt = emojiStart + 2;
    const child = recorder.child();
    child.emitStdoutBytes(frameBytes.subarray(0, splitAt));
    child.emitStdoutBytes(frameBytes.subarray(splitAt));

    const materialized = await relay.prompt;
    expect(materialized.nonce).toBe("nonce-split");
    expect(materialized.prompt).toBe(body);
    expect(materialized.prompt.includes("\uFFFD")).toBe(false);
    expect(Buffer.from(materialized.prompt, "utf8")).toEqual(Buffer.from(body, "utf8"));
  });

  test("refuses an extra frame delivered in a later stdout event after the result", async () => {
    const recorder = recordingSpawn();
    const relay = startRelay({
      cwd: canonicalRepo,
      prompt: BINDING_PROMPT,
      spawn: recorder.spawn,
      realpath: realpathSync,
      env: ENV,
    });
    const completion = relay.complete('{"verdict":"pass"}');
    const child = recorder.child();
    child.emitStdout(promptFrame("nonce-late", MATERIALIZED_PROMPT));
    await relay.prompt;
    child.emitStdout(resultFrame('{"admitted":true}'));
    // A separate data event after the terminal result must not slip through.
    child.emitStdout(resultFrame('{"admitted":true}'));

    const refusal = await refusalOf(() => completion);
    expect(refusal.code).toBe("reviewer_relay_frame_refused");
    expect(child.killed).toBe(true);
  });

  test("refuses a complete frame delivered in a later event-loop turn after the result", async () => {
    const recorder = recordingSpawn();
    const relay = startRelay({
      cwd: canonicalRepo,
      prompt: BINDING_PROMPT,
      spawn: recorder.spawn,
      realpath: realpathSync,
      env: ENV,
    });
    let settled = false;
    const completion = relay.complete('{"verdict":"pass"}');
    void completion.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const child = recorder.child();
    child.emitStdout(promptFrame("nonce-turn", MATERIALIZED_PROMPT));
    await relay.prompt;
    child.emitStdout(resultFrame('{"admitted":true}'));
    // Yield a genuine event-loop turn. The previous terminal ordering admitted
    // the result on a queued microtask, so the completion had already settled
    // (and the relay would close) before this later frame could arrive.
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    child.emitStdout(resultFrame('{"extra":true}'));
    const refusal = await refusalOf(() => completion);
    expect(refusal.code).toBe("reviewer_relay_frame_refused");
    expect(child.killed).toBe(true);
  });

  test("refuses a materialized prompt without the CONTEXT_END delimiter", async () => {
    const recorder = recordingSpawn();
    const relay = startRelay({
      cwd: canonicalRepo,
      prompt: BINDING_PROMPT,
      spawn: recorder.spawn,
      realpath: realpathSync,
      env: ENV,
    });
    recorder.child().emitStdout(
      promptFrame("nonce-partial", goEnvelope(BINDING_PROMPT, `${CONTEXT_START}\ntruncated patch`)),
    );
    const refusal = await refusalOf(() => relay.prompt);
    expect(refusal.code).toBe("reviewer_relay_frame_refused");
    expect(refusal.message).toContain(CONTEXT_END);
  });

  test("refuses a materialized prompt without the CONTEXT_START delimiter", () => {
    expect(() =>
      validateMaterializedPrompt(goEnvelope(BINDING_PROMPT, `body only\n${CONTEXT_END}`), "lens"),
    ).toThrow("reviewer_relay_frame_refused");
    expect(() => validateMaterializedPrompt("", "lens")).toThrow("reviewer_relay_frame_refused");
    expect(() =>
      validateMaterializedPrompt(goEnvelope(BINDING_PROMPT, `${CONTEXT_START}\n${CONTEXT_END}`), "lens"),
    ).not.toThrow();
  });

  test("accepts the provider-materialized prompt with trailing whitespace after the final CONTEXT_END", () => {
    const providerPrompt = `${CONTEXT_START}\nreview body\n${CONTEXT_END}`;
    const prompt = `GENTLE_AI_REVIEW_PROVIDER_MATERIALIZATION ${JSON.stringify({ task_prompt: "review this" })}\n${providerPrompt}\n`;
    expect(validateMaterializedPrompt(prompt, "lens")).toBe(prompt);
  });

  test("accepts trailing whitespace of any kind after the final CONTEXT_END", () => {
    const prompt = goEnvelope(BINDING_PROMPT, `${CONTEXT_START}\nreview body\n${CONTEXT_END} \t\r\n`);
    expect(validateMaterializedPrompt(prompt, "lens")).toBe(prompt);
  });

  test("refuses non-whitespace content after the last CONTEXT_END", () => {
    expect(() =>
      validateMaterializedPrompt(
        goEnvelope(BINDING_PROMPT, `${CONTEXT_START}\nreview body\n${CONTEXT_END}\ntrailing text`),
        "lens",
      ),
    ).toThrow("reviewer_relay_frame_refused");
    expect(() =>
      validateMaterializedPrompt(
        goEnvelope(BINDING_PROMPT, `${CONTEXT_START}\nreview body\n${CONTEXT_END}${CONTEXT_START}`),
        "lens",
      ),
    ).toThrow("reviewer_relay_frame_refused");
  });

  test("refuses a materialized prompt that only mentions the markers in lens-prompt prose", () => {
    // The provider's lens prompt carries the bare markers as prose, so a
    // bare-token match must not satisfy the framing check: this prompt has no
    // real, line-anchored block start.
    const lensProse =
      "The task begins with GENTLE_AI_REVIEW_BINDING and its exact one-line JSON. " +
      "Immediately after it, the OpenCode host process supplies one block from " +
      "GENTLE_AI_REVIEW_CONTEXT through GENTLE_AI_REVIEW_CONTEXT_END";
    expect(() => validateMaterializedPrompt(goEnvelope(BINDING_PROMPT, lensProse), "lens")).toThrow(
      "reviewer_relay_frame_refused",
    );
  });

  test("refuses a prompt whose only start marker is a mid-line prose mention", () => {
    // A real END marker is not enough when the start token appears only
    // mid-line inside prose.
    expect(() =>
      validateMaterializedPrompt(
        goEnvelope(BINDING_PROMPT, `prose mentions ${CONTEXT_START} here\n${CONTEXT_END}`),
        "lens",
      ),
    ).toThrow("reviewer_relay_frame_refused");
  });

  test("refuses an unexpected operation frame", async () => {
    const recorder = recordingSpawn();
    const relay = startRelay({
      cwd: canonicalRepo,
      prompt: BINDING_PROMPT,
      spawn: recorder.spawn,
      realpath: realpathSync,
      env: ENV,
    });
    recorder.child().emitStdout(`${JSON.stringify({ schema: TRANSPORT_SCHEMA, operation: "inject", output: "x" })}\n`);
    const refusal = await refusalOf(() => relay.prompt);
    expect(refusal.code).toBe("reviewer_relay_frame_refused");
  });

  test("refuses a result frame that arrives before the prompt frame", async () => {
    const recorder = recordingSpawn();
    const relay = startRelay({
      cwd: canonicalRepo,
      prompt: BINDING_PROMPT,
      spawn: recorder.spawn,
      realpath: realpathSync,
      env: ENV,
    });
    recorder.child().emitStdout(resultFrame("{}"));
    const refusal = await refusalOf(() => relay.prompt);
    expect(refusal.code).toBe("reviewer_relay_frame_refused");
  });

  test("refuses an extra duplicate prompt frame instead of admitting its output", async () => {
    const recorder = recordingSpawn();
    const relay = startRelay({
      cwd: canonicalRepo,
      prompt: BINDING_PROMPT,
      spawn: recorder.spawn,
      realpath: realpathSync,
      env: ENV,
    });
    recorder.child().emitStdout(promptFrame("nonce-1", MATERIALIZED_PROMPT));
    await relay.prompt;
    recorder.child().emitStdout(promptFrame("nonce-2", MATERIALIZED_PROMPT));
    const refusal = await refusalOf(() => relay.complete("{}"));
    expect(refusal.code).toBe("reviewer_relay_frame_refused");
  });

  test("refuses a partial frame left at transport EOF", async () => {
    const recorder = recordingSpawn();
    const relay = startRelay({
      cwd: canonicalRepo,
      prompt: BINDING_PROMPT,
      spawn: recorder.spawn,
      realpath: realpathSync,
      env: ENV,
    });
    recorder.child().emitStdout('{"schema":"gentle-ai.provider-transport/v1","operation":"pro');
    recorder.child().emitClose(0, null);
    const refusal = await refusalOf(() => relay.prompt);
    expect(refusal.code).toBe("reviewer_relay_child_exited");
  });

  test("bounds the stdout frame at 4 MiB and stderr at 64 KiB", async () => {
    expect(STDOUT_FRAME_LIMIT_BYTES).toBe(4 * 1024 * 1024);
    expect(STDERR_LIMIT_BYTES).toBe(64 * 1024);

    const oversizedStdout = recordingSpawn();
    const stdoutRelay = startRelay({
      cwd: canonicalRepo,
      prompt: BINDING_PROMPT,
      spawn: oversizedStdout.spawn,
      realpath: realpathSync,
      env: ENV,
      stdoutFrameLimitBytes: 64,
    });
    oversizedStdout.child().emitStdout("x".repeat(200));
    const stdoutRefusal = await refusalOf(() => stdoutRelay.prompt);
    expect(stdoutRefusal.code).toBe("reviewer_relay_frame_oversized");

    const oversizedStderr = recordingSpawn();
    const stderrRelay = startRelay({
      cwd: canonicalRepo,
      prompt: BINDING_PROMPT,
      spawn: oversizedStderr.spawn,
      realpath: realpathSync,
      env: ENV,
      stderrLimitBytes: 32,
    });
    oversizedStderr.child().emitStderr("e".repeat(100));
    const stderrRefusal = await refusalOf(() => stderrRelay.prompt);
    expect(stderrRefusal.code).toBe("reviewer_relay_stderr_oversized");
  });
});

// ---------------------------------------------------------------------------
// Requirement: provider-role Task classification and the Go envelope
// ---------------------------------------------------------------------------

describe("reviewer relay task classification and materialization envelope", () => {
  test("accepts a provider-role materialization without a context block and injects it", async () => {
    const roleContent = "Refute the candidate findings in this batch. Batch: []";
    const roleMaterialized = goEnvelope(ROLE_TASK_PROMPT, roleContent);
    const harness = relayHarness({ promptBody: roleMaterialized });
    const before = { args: { subagent_type: "asi-review-refuter", prompt: ROLE_TASK_PROMPT } };
    const refusal = await harness.hooks["tool.execute.before"](taskInput("s-role", "c1"), before);
    expect(deliveredError(refusal)).toBe("");
    expect(harness.specs).toHaveLength(1);
    expect(harness.children[0]!.frames[0]!.prompt).toBe(ROLE_TASK_PROMPT);
    expect(before.args.prompt).toBe(roleMaterialized);
    expect(before.args.prompt).not.toContain(CONTEXT_START);
  });

  test("a lens-shaped materialization still requires the context block", () => {
    const lensMaterialized = goEnvelope(BINDING_PROMPT, `${CONTEXT_START}\nreview body\n${CONTEXT_END}`);
    expect(validateMaterializedPrompt(lensMaterialized, "lens")).toBe(lensMaterialized);
    const noBlock = goEnvelope(BINDING_PROMPT, "provider content without a block");
    expect(() => validateMaterializedPrompt(noBlock, "lens")).toThrow("reviewer_relay_frame_refused");
  });

  test("refuses a materialization whose first line lacks the Go envelope header", () => {
    const bareBlock = `${CONTEXT_START}\nreview body\n${CONTEXT_END}`;
    const otherHeader = `TASK_BINDING ${JSON.stringify({ task_prompt: "x" })}\n${bareBlock}`;
    expect(() => validateMaterializedPrompt(bareBlock, "lens")).toThrow("reviewer_relay_frame_refused");
    expect(() => validateMaterializedPrompt(otherHeader, "lens")).toThrow("reviewer_relay_frame_refused");
  });

  test("refuses a malformed or extended Go envelope", () => {
    const nonJson = "GENTLE_AI_REVIEW_PROVIDER_MATERIALIZATION not-json\nprovider content";
    const unknownKey = `GENTLE_AI_REVIEW_PROVIDER_MATERIALIZATION ${JSON.stringify({ task_prompt: "x", note: "extra" })}\nprovider content`;
    const wrongType = `GENTLE_AI_REVIEW_PROVIDER_MATERIALIZATION ${JSON.stringify({ task_prompt: 7 })}\nprovider content`;
    for (const prompt of [nonJson, unknownKey, wrongType]) {
      expect(() => validateMaterializedPrompt(prompt, "provider-role")).toThrow("reviewer_relay_frame_refused");
    }
  });

  test("refuses a materialization with an empty task prompt or empty provider content", () => {
    const emptyTaskPrompt = `GENTLE_AI_REVIEW_PROVIDER_MATERIALIZATION ${JSON.stringify({ task_prompt: "" })}\nprovider content`;
    const emptyContent = `GENTLE_AI_REVIEW_PROVIDER_MATERIALIZATION ${JSON.stringify({ task_prompt: ROLE_TASK_PROMPT })}\n`;
    expect(() => validateMaterializedPrompt(emptyTaskPrompt, "provider-role")).toThrow("reviewer_relay_frame_refused");
    expect(() => validateMaterializedPrompt(emptyContent, "provider-role")).toThrow("reviewer_relay_frame_refused");
  });

  test("refuses a Task prompt that carries neither binding header before spawning", async () => {
    const harness = relayHarness();
    const before = { args: { subagent_type: "asi-review-refuter", prompt: "plain host prose" } };
    const refusal = await harness.hooks["tool.execute.before"](taskInput("s-unbound", "c1"), before);
    expect(deliveredError(refusal)).toContain("reviewer_relay_frame_refused");
    expect(harness.specs).toHaveLength(0);
    expect(String(before.args.prompt)).toContain(REFUSAL_ENVELOPE);
  });
});

// ---------------------------------------------------------------------------
// Requirement: bounded host process
// ---------------------------------------------------------------------------

describe("reviewer relay spawn discipline", () => {
  test("uses the fixed binary and argv with piped stdio and shell disabled", () => {
    expect(TRANSPORT_BINARY).toBe("/home/linuxbrew/.linuxbrew/bin/gentle-ai");
    expect(TRANSPORT_ARGV).toEqual(["review", "opencode-transport"]);

    const recorder = recordingRawSpawn();
    const transportSpawn = createNodeTransportSpawn(recorder.rawSpawn);
    const handlers: TransportHandlers = {
      stdout: () => {},
      stderr: () => {},
      error: () => {},
      close: () => {},
    };
    transportSpawn({ command: TRANSPORT_BINARY, argv: TRANSPORT_ARGV, cwd: canonicalRepo, env: { HOME: "/home/reviewer" } }, handlers);

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]!.command).toBe(TRANSPORT_BINARY);
    expect(recorder.calls[0]!.argv).toEqual(["review", "opencode-transport"]);
    expect(recorder.calls[0]!.options.cwd).toBe(canonicalRepo);
    expect(recorder.calls[0]!.options.shell).toBe(false);
    expect(recorder.calls[0]!.options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(recorder.calls[0]!.options.env).toEqual({ HOME: "/home/reviewer" });
  });

  test("startRelay passes only the fixed spec and the allowlisted root", () => {
    const recorder = recordingSpawn();
    startRelay({
      cwd: canonicalRepo,
      prompt: BINDING_PROMPT,
      spawn: recorder.spawn,
      realpath: realpathSync,
      env: { ...ENV, PATH: "/usr/bin", OPENAI_API_KEY: "not-a-real-secret" },
    });
    expect(recorder.specs).toHaveLength(1);
    expect(recorder.specs[0]!.command).toBe(TRANSPORT_BINARY);
    expect(recorder.specs[0]!.argv).toEqual(TRANSPORT_ARGV);
    expect(recorder.specs[0]!.cwd).toBe(canonicalRepo);
    const spawnedEnv = recorder.specs[0]!.env;
    expect(spawnedEnv).toMatchObject(ENV);
    // PATH is allowed through; the relay runtime directory is prepended first,
    // then the resolving git directory; secret-shaped keys are still stripped.
    const spawnedSegments = spawnedEnv.PATH!.split(":");
    expect(spawnedSegments[0]).toBe(RUNTIME_DIRECTORY);
    expect(spawnedSegments).toContain(HOST_GIT_DIRECTORY);
    expect(Object.keys(spawnedEnv)).not.toContain("OPENAI_API_KEY");
  });

  test("refuses a relative, symlinked, or control-bearing cwd before spawning", async () => {
    for (const cwd of ["repo", symlinkRoot, `${canonicalRepo}\n`]) {
      const recorder = recordingSpawn();
      const refusal = await refusalOf(() =>
        startRelay({
          cwd,
          prompt: BINDING_PROMPT,
          spawn: recorder.spawn,
          realpath: realpathSync,
          env: ENV,
        }),
      );
      expect(refusal.code).toBe("reviewer_relay_root_refused");
      expect(recorder.specs).toHaveLength(0);
    }
  });

  test("environment is allowlist-only and HOME is required", () => {
    const env = buildTransportEnv({
      HOME: "/home/reviewer",
      XDG_CONFIG_HOME: "/home/reviewer/.config",
      XDG_DATA_HOME: "/home/reviewer/.local/share",
      XDG_STATE_HOME: "/home/reviewer/.local/state",
      XDG_CACHE_HOME: "/home/reviewer/.cache",
      XDG_RUNTIME_DIR: "/run/user/1000",
      LANG: "C",
      LC_ALL: "C.UTF-8",
      PATH: "/usr/bin",
      SHELL: "/bin/bash",
      GENTLE_AI_TOKEN: "not-a-real-secret",
    });
    expect(env).toMatchObject({
      HOME: "/home/reviewer",
      XDG_CONFIG_HOME: "/home/reviewer/.config",
      XDG_DATA_HOME: "/home/reviewer/.local/share",
      XDG_STATE_HOME: "/home/reviewer/.local/state",
      XDG_CACHE_HOME: "/home/reviewer/.cache",
      XDG_RUNTIME_DIR: "/run/user/1000",
      LANG: "C",
      LC_ALL: "C.UTF-8",
    });
    // PATH is the one non-secret addition, so it is carried through; the
    // credential-shaped SHELL/TOKEN values are still stripped.
    expect(env.PATH).toBeDefined();
    expect(env.PATH!.split(":")).toContain("/usr/bin");
    expect(env.SHELL).toBeUndefined();
    expect(env.GENTLE_AI_TOKEN).toBeUndefined();
    expect(() => buildTransportEnv({ PATH: "/usr/bin" })).toThrow("reviewer_relay_environment_refused");
    expect(() => buildTransportEnv({ HOME: "" })).toThrow("reviewer_relay_environment_refused");
  });

  test("the constructed environment carries a PATH that resolves git", () => {
    // The child resolves the relay's own runtime and git from PATH, so the
    // constructed env must carry both directories in order.
    expect(HOST_GIT_DIRECTORY).toBeDefined();

    // An inherited PATH is preserved, with the runtime and resolving
    // directories prepended exactly once even when already present.
    const inherited = buildTransportEnv({ HOME: "/home/x", PATH: "/custom/bin:/usr/bin" });
    const segments = inherited.PATH!.split(":");
    expect(segments[0]).toBe(RUNTIME_DIRECTORY);
    expect(segments[1]).toBe(HOST_GIT_DIRECTORY);
    expect(segments).toContain("/custom/bin");
    expect(segments.filter((segment) => segment === RUNTIME_DIRECTORY)).toHaveLength(1);
    expect(segments.filter((segment) => segment === HOST_GIT_DIRECTORY)).toHaveLength(1);

    // Without an inherited PATH, both directories are still provided.
    const bare = buildTransportEnv({ HOME: "/home/x" });
    const bareSegments = bare.PATH!.split(":");
    expect(bareSegments[0]).toBe(RUNTIME_DIRECTORY);
    expect(bareSegments[1]).toBe(HOST_GIT_DIRECTORY);
  });

  test("prepends the relay runtime directory when the ambient PATH omits it", () => {
    // A systemd user service starts with a default PATH that need not include
    // the directory holding the running runtime, so the constructed child PATH
    // must lead with the relay's own runtime directory regardless of what the
    // parent inherited.
    expect(RUNTIME_DIRECTORY).not.toBe(HOST_GIT_DIRECTORY);

    const ambient = `${HOST_GIT_DIRECTORY}:/opt/other/bin:/custom/bin`;
    const built = buildTransportEnv({ HOME: "/home/x", PATH: ambient });
    const segments = built.PATH!.split(":");
    // The runtime directory leads, with the git directory immediately after it.
    expect(segments[0]).toBe(RUNTIME_DIRECTORY);
    expect(segments[1]).toBe(HOST_GIT_DIRECTORY);
    // The remaining inherited order is preserved.
    expect(segments.slice(2)).toEqual(["/opt/other/bin", "/custom/bin"]);
    expect(segments.filter((segment) => segment === RUNTIME_DIRECTORY)).toHaveLength(1);
    expect(segments.filter((segment) => segment === HOST_GIT_DIRECTORY)).toHaveLength(1);

    // When the ambient PATH already carries the runtime directory it is
    // promoted to the front exactly once, never duplicated.
    const alreadyInherited = buildTransportEnv({
      HOME: "/home/x",
      PATH: `${RUNTIME_DIRECTORY}:/custom/bin:${HOST_GIT_DIRECTORY}`,
    });
    const inheritedSegments = alreadyInherited.PATH!.split(":");
    expect(inheritedSegments[0]).toBe(RUNTIME_DIRECTORY);
    expect(inheritedSegments[1]).toBe(HOST_GIT_DIRECTORY);
    expect(inheritedSegments.filter((segment) => segment === RUNTIME_DIRECTORY)).toHaveLength(1);
    expect(inheritedSegments).toContain("/custom/bin");
  });

  test("the deadline is finite and supports multi-minute reviewer calls", async () => {
    expect(RELAY_DEADLINE_MS).toBe(600_000);

    const recorder = recordingSpawn();
    const relay = startRelay({
      cwd: canonicalRepo,
      prompt: BINDING_PROMPT,
      spawn: recorder.spawn,
      realpath: realpathSync,
      env: ENV,
      deadlineMs: 20,
    });
    const refusal = await refusalOf(() => relay.prompt);
    expect(refusal.code).toBe("reviewer_relay_deadline_expired");
    expect(recorder.child().killed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Requirement: no synthesized authority
// ---------------------------------------------------------------------------

describe("reviewer relay authority boundary", () => {
  test("the start frame carries only schema, operation, and the verbatim prompt", () => {
    const frame = JSON.parse(buildStartFrame(BINDING_PROMPT)) as FrameRecord;
    expect(Object.keys(frame)).toEqual(["schema", "operation", "prompt"]);
    expect(frame.schema).toBe(TRANSPORT_SCHEMA);
    expect(frame.operation).toBe("start");
    expect(frame.prompt).toBe(BINDING_PROMPT);
  });

  test("the complete frame echoes the provider nonce and never invents tokens", () => {
    const frame = JSON.parse(buildCompleteFrame("nonce-provider", '{"verdict":"pass"}')) as FrameRecord;
    expect(Object.keys(frame)).toEqual(["schema", "operation", "nonce", "output"]);
    expect(frame.operation).toBe("complete");
    expect(frame.nonce).toBe("nonce-provider");
    expect(frame.output).toBe('{"verdict":"pass"}');

    const unavailable = JSON.parse(buildCompleteFrame("nonce-provider", undefined)) as FrameRecord;
    expect(Object.keys(unavailable)).toEqual(["schema", "operation", "nonce", "error"]);
    expect(unavailable.error).toBe("opencode_task_host_output_unavailable");
  });

  test("completion half-closes stdin with the single complete frame", async () => {
    const recorder = recordingSpawn();
    const relay: Relay = startRelay({
      cwd: canonicalRepo,
      prompt: BINDING_PROMPT,
      spawn: recorder.spawn,
      realpath: realpathSync,
      env: ENV,
    });
    recorder.child().emitStdout(promptFrame("nonce-1", MATERIALIZED_PROMPT));
    await relay.prompt;

    const completion = relay.complete('{"verdict":"pass"}');
    recorder.child().emitStdout(resultFrame('{"admitted":true}'));
    // The provider transport child closes stdout after emitting the result;
    // admission is gated on that EOF, so the close must precede the await.
    recorder.child().emitClose(0, null);
    expect(await completion).toBe('{"admitted":true}');

    const child = recorder.child();
    expect(child.written).toHaveLength(1);
    expect(child.ended).toHaveLength(1);
    const start = JSON.parse(child.written[0]!) as FrameRecord;
    expect(start.prompt).toBe(BINDING_PROMPT);
    expect(start.prompt).not.toContain(CONTEXT_START);
    expect(JSON.parse(child.ended[0]!) as unknown).toEqual({
      schema: TRANSPORT_SCHEMA,
      operation: "complete",
      nonce: "nonce-1",
      output: '{"verdict":"pass"}',
    });
  });
});

// ---------------------------------------------------------------------------
// Requirement: lifecycle refusals
// ---------------------------------------------------------------------------

describe("reviewer relay lifecycle", () => {
  test("the relay hook scope is disjoint from the installed reviewer agents", () => {
    expect([...RELAY_AGENTS].sort()).toEqual(
      [
        "asi-review-readability",
        "asi-review-refuter",
        "asi-review-reliability",
        "asi-review-resilience",
        "asi-review-risk",
        "asi-review-validator",
      ].sort(),
    );
    expect([...INSTALLED_REVIEW_AGENTS].sort()).toEqual(
      [
        "review-readability",
        "review-refuter",
        "review-reliability",
        "review-resilience",
        "review-risk",
        "review-validator",
      ].sort(),
    );
    const overlap = RELAY_AGENTS.filter((agent) => INSTALLED_REVIEW_AGENTS.includes(agent));
    expect(overlap).toEqual([]);
    expect(MAX_CONCURRENT_RELAYS).toBe(4);
  });

  test("a crash before completion refuses and reports the child failure", async () => {
    const recorder = recordingSpawn();
    const relay = startRelay({
      cwd: canonicalRepo,
      prompt: BINDING_PROMPT,
      spawn: recorder.spawn,
      realpath: realpathSync,
      env: ENV,
    });
    recorder.child().emitStderr("binding_invalid\n");
    recorder.child().emitClose(1, null);
    const refusal = await refusalOf(() => relay.prompt);
    expect(refusal.code).toBe("reviewer_relay_child_exited");
    expect(refusal.message).toContain("binding_invalid");
  });

  test("a spawn error refuses closed", async () => {
    const recorder = recordingSpawn();
    const relay = startRelay({
      cwd: canonicalRepo,
      prompt: BINDING_PROMPT,
      spawn: recorder.spawn,
      realpath: realpathSync,
      env: ENV,
    });
    recorder.child().emitError(new Error("ENOENT"));
    const refusal = await refusalOf(() => relay.prompt);
    expect(refusal.code).toBe("reviewer_relay_spawn_failed");
  });

  test("abort refuses before spawn and kills a live child", async () => {
    const controller = new AbortController();
    controller.abort();
    const preSpawn = recordingSpawn();
    const preSpawnRefusal = await refusalOf(() =>
      startRelay({
        cwd: canonicalRepo,
        prompt: BINDING_PROMPT,
        spawn: preSpawn.spawn,
        realpath: realpathSync,
        env: ENV,
        signal: controller.signal,
      }),
    );
    expect(preSpawnRefusal.code).toBe("reviewer_relay_aborted");
    expect(preSpawn.specs).toHaveLength(0);

    const live = recordingSpawn();
    const liveController = new AbortController();
    const relay = startRelay({
      cwd: canonicalRepo,
      prompt: BINDING_PROMPT,
      spawn: live.spawn,
      realpath: realpathSync,
      env: ENV,
      signal: liveController.signal,
    });
    liveController.abort();
    const liveRefusal = await refusalOf(() => relay.prompt);
    expect(liveRefusal.code).toBe("reviewer_relay_aborted");
    expect(live.child().killed).toBe(true);
  });

  test("duplicate completion refuses instead of double-reporting a result", async () => {
    const recorder = recordingSpawn();
    const relay = startRelay({
      cwd: canonicalRepo,
      prompt: BINDING_PROMPT,
      spawn: recorder.spawn,
      realpath: realpathSync,
      env: ENV,
    });
    const first = relay.complete('{"verdict":"pass"}');
    const duplicate = await refusalOf(() => relay.complete('{"verdict":"pass"}'));
    expect(duplicate.code).toBe("reviewer_relay_completion_duplicate");

    recorder.child().emitStdout(promptFrame("nonce-1", MATERIALIZED_PROMPT));
    recorder.child().emitStdout(resultFrame('{"admitted":true}'));
    recorder.child().emitClose(0, null);
    expect(await first).toBe('{"admitted":true}');
  });

  test("disposal refuses pending waits and later completion, and kills the child", async () => {
    const recorder = recordingSpawn();
    const relay = startRelay({
      cwd: canonicalRepo,
      prompt: BINDING_PROMPT,
      spawn: recorder.spawn,
      realpath: realpathSync,
      env: ENV,
    });
    const pending = refusalOf(() => relay.prompt);
    relay.close();
    expect((await pending).code).toBe("reviewer_relay_disposed");
    expect(recorder.child().killed).toBe(true);

    const late = await refusalOf(() => relay.complete('{"verdict":"pass"}'));
    expect(late.code).toBe("reviewer_relay_disposed");
  });
});

// ---------------------------------------------------------------------------
// Requirement: disjoint reviewer hook scope and binding-only Task boundary
// ---------------------------------------------------------------------------

interface ScriptedChildOptions {
  promptNonce?: string;
  promptBody?: string;
  resultOutput?: string;
}

/** A transport child that answers the relay protocol the way the provider does. */
class ScriptedTransportChild implements TransportChild {
  readonly frames: FrameRecord[] = [];
  readonly ended: string[] = [];
  killed = false;
  private readonly handlers: TransportHandlers;
  private readonly options: ScriptedChildOptions;

  constructor(handlers: TransportHandlers, options: ScriptedChildOptions) {
    this.handlers = handlers;
    this.options = options;
  }

  write(data: string): void {
    this.reply(data);
  }

  end(data: string): void {
    this.ended.push(data);
    this.reply(data);
  }

  kill(): void {
    this.killed = true;
  }

  private reply(data: string): void {
    let frame: FrameRecord;
    try {
      frame = JSON.parse(data) as FrameRecord;
    } catch {
      return;
    }
    this.frames.push(frame);
    if (frame.operation === "start") {
      const body = this.options.promptBody ?? MATERIALIZED_PROMPT;
      queueMicrotask(() => this.handlers.stdout(Buffer.from(promptFrame(this.options.promptNonce ?? "nonce-1", body), "utf8")));
      return;
    }
    if (frame.operation === "complete") {
      const output = this.options.resultOutput ?? '{"admitted":true}';
      // The provider transport child emits the result and then exits, closing
      // stdout. Admission is gated on that EOF, so the scripted child must
      // close after the result.
      queueMicrotask(() => {
        this.handlers.stdout(Buffer.from(resultFrame(output), "utf8"));
        this.handlers.close(0, null);
      });
    }
  }
}

interface RelayHarnessOptions {
  sessionDirectory?: unknown;
  projectPaths?: readonly unknown[];
  serverRoot?: string;
  registry?: RelayRegistry;
  promptBody?: string;
  resultOutput?: string;
}

interface RelayHarness {
  hooks: ReviewerRelayHooks;
  specs: TransportSpawnSpec[];
  children: ScriptedTransportChild[];
}

const taskInput = (sessionID: string, callID: string) => ({ tool: "task", sessionID, callID });

function relayHarness(options: RelayHarnessOptions = {}): RelayHarness {
  const specs: TransportSpawnSpec[] = [];
  const children: ScriptedTransportChild[] = [];
  const spawn: TransportSpawn = (spec, handlers) => {
    specs.push(spec);
    const child = new ScriptedTransportChild(handlers, {
      promptBody: options.promptBody,
      resultOutput: options.resultOutput,
    });
    children.push(child);
    return child;
  };
  const hooks = createReviewerRelayHooks({
    directory: options.serverRoot ?? canonicalOther,
    worktree: options.serverRoot ?? canonicalOther,
    client: {
      session: {
        get: async () => ({ data: { directory: options.sessionDirectory ?? canonicalRepo } }),
      },
    },
    brokerRequest: async () => ({ projects: options.projectPaths ?? [projectPath(canonicalRepo)] }),
    spawn,
    realpath: realpathSync,
    env: ENV,
    registry: options.registry,
  });
  return { hooks, specs, children };
}

describe("reviewer relay hook scope", () => {
  test("installed reviewer agents and unrelated tools bypass the relay untouched", async () => {
    const harness = relayHarness();
    let call = 0;
    for (const agent of INSTALLED_REVIEW_AGENTS) {
      call += 1;
      const before = { args: { subagent_type: agent, prompt: "installed reviewer prompt" } };
      await harness.hooks["tool.execute.before"](taskInput("s-installed", `c${call}`), before);
      expect(before.args.prompt).toBe("installed reviewer prompt");

      const after = { args: { subagent_type: agent }, output: "installed reviewer output" };
      await harness.hooks["tool.execute.after"](taskInput("s-installed", `c${call}`), after);
      expect(after.output).toBe("installed reviewer output");
    }

    const otherTool = { args: { subagent_type: "asi-review-risk", prompt: "unrelated" } };
    await harness.hooks["tool.execute.before"](
      { tool: "read", sessionID: "s-installed", callID: "c-other" },
      otherTool,
    );
    expect(otherTool.args.prompt).toBe("unrelated");

    const otherAgent = { args: { subagent_type: "general", prompt: "unrelated" } };
    await harness.hooks["tool.execute.before"](taskInput("s-installed", "c-general"), otherAgent);
    expect(otherAgent.args.prompt).toBe("unrelated");

    expect(harness.specs).toHaveLength(0);
  });

  test("asi-review-* resolves the session repository and materializes the block", async () => {
    const harness = relayHarness();
    const before = { args: { subagent_type: "asi-review-risk", prompt: BINDING_PROMPT } };
    await harness.hooks["tool.execute.before"](taskInput("s-relay", "c1"), before);

    expect(harness.specs).toHaveLength(1);
    expect(harness.specs[0]!.cwd).toBe(canonicalRepo);
    expect(harness.specs[0]!.command).toBe(TRANSPORT_BINARY);
    expect(harness.specs[0]!.argv).toEqual(TRANSPORT_ARGV);
    const spawnedEnv = harness.specs[0]!.env;
    expect(spawnedEnv).toMatchObject(ENV);
    const spawnedSegments = spawnedEnv.PATH!.split(":");
    expect(spawnedSegments[0]).toBe(RUNTIME_DIRECTORY);
    expect(spawnedSegments).toContain(HOST_GIT_DIRECTORY);

    const startFrame = harness.children[0]!.frames[0]!;
    expect(startFrame.operation).toBe("start");
    expect(startFrame.prompt).toBe(BINDING_PROMPT);
    expect(startFrame.prompt).not.toContain(CONTEXT_START);

    expect(before.args.prompt).toBe(MATERIALIZED_PROMPT);
    expect(before.args.prompt).toContain(CONTEXT_START);
    expect(before.args.prompt.endsWith(CONTEXT_END)).toBe(true);

    const after = { args: { subagent_type: "asi-review-risk" }, output: '{"verdict":"pass"}' };
    await harness.hooks["tool.execute.after"](
      { ...taskInput("s-relay", "c1"), args: { subagent_type: "asi-review-risk" } },
      after,
    );
    expect(after.output).toBe('{"admitted":true}');
    expect(harness.children[0]!.killed).toBe(true);
  });

  test("a structured Task result yields the reviewer text in the completion frame", async () => {
    const harness = relayHarness();
    const input = taskInput("s-structured", "c1");
    await harness.hooks["tool.execute.before"](input, {
      args: { subagent_type: "asi-review-reliability", prompt: BINDING_PROMPT },
    });

    const reviewerText = '{"verdict":"pass"}';
    const after = {
      args: { subagent_type: "asi-review-reliability" },
      output: { title: "Task", output: reviewerText, metadata: { sessionId: "child" } },
    };
    await harness.hooks["tool.execute.after"](input, after);

    const completion = JSON.parse(harness.children[0]!.ended[0]!) as FrameRecord;
    expect(completion.operation).toBe("complete");
    expect(completion.nonce).toBe("nonce-1");
    expect(completion.output).toBe(reviewerText);
    expect(completion.error).toBeUndefined();
    expect(after.output).toBe('{"admitted":true}');
  });

  test("a message-part Task result yields its text in the completion frame", async () => {
    const harness = relayHarness();
    const input = taskInput("s-part", "c1");
    await harness.hooks["tool.execute.before"](input, {
      args: { subagent_type: "asi-review-risk", prompt: BINDING_PROMPT },
    });
    const reviewerText = '{"verdict":"pass"}';
    const after = {
      args: { subagent_type: "asi-review-risk" },
      output: { type: "text", text: reviewerText },
    };
    await harness.hooks["tool.execute.after"](input, after);
    const completion = JSON.parse(harness.children[0]!.ended[0]!) as FrameRecord;
    expect(completion.output).toBe(reviewerText);
    expect(completion.error).toBeUndefined();
    expect(after.output).toBe('{"admitted":true}');
  });

  test("a Task result without text keeps the fail-closed unavailability error", async () => {
    const harness = relayHarness();
    const input = taskInput("s-notext", "c1");
    await harness.hooks["tool.execute.before"](input, {
      args: { subagent_type: "asi-review-validator", prompt: BINDING_PROMPT },
    });
    const after = {
      args: { subagent_type: "asi-review-validator" },
      output: { title: "Task", metadata: {} },
    };
    await harness.hooks["tool.execute.after"](input, after);
    const completion = JSON.parse(harness.children[0]!.ended[0]!) as FrameRecord;
    expect(completion.output).toBeUndefined();
    expect(completion.error).toBe("opencode_task_host_output_unavailable");
    expect(after.output).toBe('{"admitted":true}');
  });

  test("the completion diagnostic does not change the extracted completion text", async () => {
    const cases: Array<{ key: string; output: unknown; expected?: string }> = [
      {
        key: "s-diag-record",
        output: { title: "Task", output: '{"verdict":"pass"}', metadata: {} },
        expected: '{"verdict":"pass"}',
      },
      { key: "s-diag-string", output: '{"verdict":"pass"}', expected: '{"verdict":"pass"}' },
      { key: "s-diag-empty", output: { title: "Task", metadata: {} } },
    ];
    for (const testCase of cases) {
      const harness = relayHarness();
      const input = taskInput(testCase.key, "c1");
      await harness.hooks["tool.execute.before"](input, {
        args: { subagent_type: "asi-review-risk", prompt: BINDING_PROMPT },
      });
      const after = { args: { subagent_type: "asi-review-risk" }, output: testCase.output };
      await harness.hooks["tool.execute.after"](input, after);
      const completion = JSON.parse(harness.children[0]!.ended[0]!) as FrameRecord;
      if (testCase.expected !== undefined) {
        expect(completion.output).toBe(testCase.expected);
        expect(completion.error).toBeUndefined();
      } else {
        expect(completion.output).toBeUndefined();
        expect(completion.error).toBe("opencode_task_host_output_unavailable");
      }
      expect(after.output).toBe('{"admitted":true}');
    }
  });

  test("a root refusal is delivered to the caller before spawn, not lost to a throw", async () => {
    const harness = relayHarness({ sessionDirectory: canonicalOther });
    const before = { args: { subagent_type: "asi-review-risk", prompt: BINDING_PROMPT } };
    // The refusal must resolve as a tool-error result. A throw would be
    // converted by the host into a generic "tool execution aborted", which
    // drops the typed refusal before the model can see it.
    const refusal = await harness.hooks["tool.execute.before"](taskInput("s-root", "c1"), before);
    expect(deliveredError(refusal)).toContain("reviewer_relay_root_refused");
    expect(harness.specs).toHaveLength(0);
    expect(String(before.args.prompt)).toContain(REFUSAL_ENVELOPE);
    expect(String(before.args.prompt)).not.toContain(BINDING_PROMPT);

    const after = { args: { subagent_type: "asi-review-risk" }, output: "unbound reviewer prose" };
    const completionRefusal = await harness.hooks["tool.execute.after"](taskInput("s-root", "c1"), after);
    expect(deliveredError(completionRefusal)).toContain("reviewer_relay_task_refused");
    expect(String(after.output)).toContain(REFUSAL_ENVELOPE);
    expect(String(after.output)).not.toContain("unbound reviewer prose");
  });

  test("the concurrency cap refuses a fifth distinct relay before spawning", async () => {
    const specs: TransportSpawnSpec[] = [];
    const hanging: TransportSpawn = (spec) => {
      specs.push(spec);
      return { write: () => {}, end: () => {}, kill: () => {} };
    };
    const hooks = createReviewerRelayHooks({
      directory: canonicalOther,
      worktree: canonicalOther,
      client: { session: { get: async () => ({ data: { directory: canonicalRepo } }) } },
      brokerRequest: async () => ({ projects: [projectPath(canonicalRepo)] }),
      spawn: hanging,
      realpath: realpathSync,
      env: ENV,
      registry: new Map(),
    });

    const pending = [0, 1, 2, 3].map((index) =>
      hooks["tool.execute.before"](taskInput("s-cap", `c${index}`), {
        args: { subagent_type: "asi-review-risk", prompt: BINDING_PROMPT },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(specs).toHaveLength(MAX_CONCURRENT_RELAYS);

    const fifth = await hooks["tool.execute.before"](taskInput("s-cap", "c4"), {
      args: { subagent_type: "asi-review-risk", prompt: BINDING_PROMPT },
    });
    expect(deliveredError(fifth)).toContain("reviewer_relay_concurrency_refused");
    expect(specs).toHaveLength(MAX_CONCURRENT_RELAYS);

    await hooks.dispose();
    await Promise.allSettled(pending);
  });

  test("a duplicate hook defers to the owning plugin instance", async () => {
    const registry: RelayRegistry = new Map();
    const owner = relayHarness({ registry });
    const duplicate = relayHarness({ registry });
    const input = taskInput("s-defer", "c1");

    const ownerBefore = { args: { subagent_type: "asi-review-readability", prompt: BINDING_PROMPT } };
    await owner.hooks["tool.execute.before"](input, ownerBefore);
    expect(owner.specs).toHaveLength(1);
    expect(ownerBefore.args.prompt).toBe(MATERIALIZED_PROMPT);

    const duplicateBefore = { args: { subagent_type: "asi-review-readability", prompt: "untouched" } };
    await duplicate.hooks["tool.execute.before"](input, duplicateBefore);
    expect(duplicate.specs).toHaveLength(0);
    expect(duplicateBefore.args.prompt).toBe("untouched");

    const duplicateAfter = { args: { subagent_type: "asi-review-readability" }, output: "raw duplicate prose" };
    await duplicate.hooks["tool.execute.after"](input, duplicateAfter);
    expect(duplicateAfter.output).toBe("raw duplicate prose");

    const ownerAfter = { args: { subagent_type: "asi-review-readability" }, output: '{"verdict":"pass"}' };
    await owner.hooks["tool.execute.after"](input, ownerAfter);
    expect(ownerAfter.output).toBe('{"admitted":true}');
  });

  test("session.created registers only asi-review-* sessions for isolation", async () => {
    const harness = relayHarness();

    await harness.hooks.event({
      event: { type: "session.created", properties: { info: { id: "child-agent", agent: "asi-review-risk" } } },
    });
    const agentSystem = { system: ["inherited instructions"] };
    await harness.hooks["experimental.chat.system.transform"]({ sessionID: "child-agent" }, agentSystem);
    expect(agentSystem.system).toEqual([TRANSPORT_ISOLATION_SYSTEM]);

    await harness.hooks.event({
      event: {
        type: "session.created",
        properties: { info: { id: "child-title", title: "review task (@asi-review-readability subagent)" } },
      },
    });
    const titleSystem = { system: ["inherited instructions"] };
    await harness.hooks["experimental.chat.system.transform"]({ sessionID: "child-title" }, titleSystem);
    expect(titleSystem.system).toEqual([TRANSPORT_ISOLATION_SYSTEM]);

    await harness.hooks.event({
      event: { type: "session.created", properties: { info: { id: "child-installed", agent: "review-risk" } } },
    });
    const installedSystem = { system: ["inherited instructions"] };
    await harness.hooks["experimental.chat.system.transform"]({ sessionID: "child-installed" }, installedSystem);
    expect(installedSystem.system).toEqual(["inherited instructions"]);

    const strangerSystem = { system: ["inherited instructions"] };
    await harness.hooks["experimental.chat.system.transform"]({ sessionID: "child-unrelated" }, strangerSystem);
    expect(strangerSystem.system).toEqual(["inherited instructions"]);

    await harness.hooks.event({
      event: { type: "session.created", properties: { info: { id: "asi-review-reliability", title: "asi-review-reliability" } } },
    });
    const titledSystem = { system: ["inherited instructions"] };
    await harness.hooks["experimental.chat.system.transform"]({ sessionID: "asi-review-reliability" }, titledSystem);
    expect(titledSystem.system).toEqual(["inherited instructions"]);
  });

  test("a completion without a live before hook delivers a typed refusal, not raw prose", async () => {
    const harness = relayHarness();
    const after = { args: { subagent_type: "asi-review-validator" }, output: "orphan prose" };
    const refusal = await harness.hooks["tool.execute.after"](taskInput("s-orphan", "c1"), after);
    expect(deliveredError(refusal)).toContain("reviewer_relay_task_refused");
    expect(String(after.output)).toContain(REFUSAL_ENVELOPE);
    expect(String(after.output)).not.toContain("orphan prose");
  });

  test("a Task with no injectable prompt delivers the typed refusal", async () => {
    const harness = relayHarness();
    const before = { args: { subagent_type: "asi-review-risk", prompt: 42 } };
    const refusal = await harness.hooks["tool.execute.before"](taskInput("s-noprompt", "c1"), before);
    expect(deliveredError(refusal)).toContain("reviewer_relay_task_refused");
    expect(harness.specs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Requirement: manual security-boundary delivery assets
// ---------------------------------------------------------------------------

/** Strip whole-line `//` comments so the JSONC fragment can be parsed strictly. */
function stripJsoncComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

const COUNTERPART_MODELS: Record<string, readonly [string, string]> = {
  "asi-review-risk": ["openai/gpt-5.6-sol", "high"],
  "asi-review-resilience": ["openai/gpt-5.6-luna", "high"],
  "asi-review-readability": ["openai/gpt-5.6-luna", ""],
  "asi-review-reliability": ["opencode-go/glm-5.3-flash", "high"],
  "asi-review-refuter": ["opencode-go/qwen3.7-plus", "high"],
  "asi-review-validator": ["opencode-go/glm-5.3-flash", "max"],
};

const LENS_TASK_NAMES: Record<string, string> = {
  "review-risk": "asi-review-risk",
  "review-resilience": "asi-review-resilience",
  "review-readability": "asi-review-readability",
  "review-reliability": "asi-review-reliability",
  "review-refuter": "asi-review-refuter",
  "review-validator": "asi-review-validator",
};

describe("reviewer relay agent fragment", () => {
  const fragmentText = readFileSync(
    new URL("../../opencode/config-fragments/reviewer-relay-agents.jsonc", import.meta.url),
    "utf8",
  );
  const fragment = JSON.parse(stripJsoncComments(fragmentText)) as {
    agent: Record<string, Record<string, unknown>>;
  };

  test("declares exactly the six tool-less hidden subagent asi-review-* agents", () => {
    expect(Object.keys(fragment.agent).sort()).toEqual([...RELAY_AGENTS].sort());
    for (const name of RELAY_AGENTS) {
      const agent = fragment.agent[name]!;
      expect(agent.hidden).toBe(true);
      expect(agent.mode).toBe("subagent");
      const tools = agent.tools as Record<string, unknown>;
      expect(tools["*"]).toBe(false);
      for (const granted of Object.values(tools)) expect(granted).toBe(false);
      const permission = agent.permission as Record<string, unknown>;
      expect(permission.task).toEqual({ "*": "deny" });
      expect(permission.edit).toBe("deny");
      expect(permission.write).toBe("deny");
    }
  });

  test("mirrors the installed reviewer counterpart models", () => {
    for (const [name, [model, variant]] of Object.entries(COUNTERPART_MODELS)) {
      const agent = fragment.agent[name]!;
      expect(agent.model).toBe(model);
      expect(agent.variant).toBe(variant);
    }
  });

  test("marks the fragment as not installed and manually merged", () => {
    expect(fragmentText).toContain("NOT INSTALLED");
    expect(fragmentText).toContain("MANUAL");
  });
});

describe("reviewer relay Task-name mapping", () => {
  const agentsDoc = readFileSync(new URL("../../AGENTS.md", import.meta.url), "utf8");
  const hostToolsDesign = readFileSync(
    new URL("../../openspec/changes/agent-host-tools/design.md", import.meta.url),
    "utf8",
  );
  const sandboxToolsSource = readFileSync(
    new URL("../../opencode/plugins/sandbox-tools.ts", import.meta.url),
    "utf8",
  );

  test("AGENTS.md maps every provider lens to its asi-review-* Task name", () => {
    for (const [lens, taskName] of Object.entries(LENS_TASK_NAMES)) {
      expect(agentsDoc).toContain(`| \`${lens}\` | \`${taskName}\` |`);
    }
  });

  test("provider lens values and capture fields remain unchanged", () => {
    for (const lens of ["review-risk", "review-resilience", "review-readability", "review-reliability"]) {
      expect(agentsDoc).toContain(lens);
    }
    expect(agentsDoc).toContain("byte-for-byte");
    expect(agentsDoc).toContain("subject hash");
  });

  test("reviewLensContext stays diagnostic and transport stays separate", () => {
    expect(sandboxToolsSource).toContain("host_review_lens_context");
    expect(sandboxToolsSource).toContain("reviewLensContext");
    expect(sandboxToolsSource).toContain("GENTLE_AI_REVIEW_CONTEXT");
    expect(sandboxToolsSource).not.toContain("asi-review-");
    expect(hostToolsDesign).toContain("Amendment (reviewer-relay-transport)");
    expect(hostToolsDesign).toContain("diagnostic");
  });
});

// ---------------------------------------------------------------------------
// Regression: the plugin module must export only the plugin function
// ---------------------------------------------------------------------------

describe("reviewer relay plugin export surface", () => {
  test("exports only the plugin function and its default", () => {
    const exported = Object.entries(reviewerRelayPlugin);
    expect(exported).toHaveLength(2);
    expect(exported.map(([name]) => name).sort()).toEqual([
      "ReviewerRelayTransportPlugin",
      "default",
    ]);
    const plugin = reviewerRelayPlugin.ReviewerRelayTransportPlugin;
    expect(typeof plugin).toBe("function");
    for (const [, value] of exported) {
      expect(typeof value).toBe("function");
      expect(value).toBe(plugin);
    }
    expect(reviewerRelayPlugin.default).toBe(plugin);
  });
});
