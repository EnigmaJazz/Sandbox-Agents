/**
 * Reviewer relay transport plugin (change: reviewer-relay-transport).
 *
 * Ports the provider review relay into this repository with ONE changed input:
 * the child process cwd is the *Task session's* broker-allowlisted repository
 * root, never the OpenCode server/plugin-instance project. The installed
 * `~/.config/opencode/plugins/opencode-review-transport.ts` resolves
 * `cwd = worktree || directory`, which on a multi-repo host selects the server
 * project and fails every reviewer Task with
 * `opencode_review_transport_binding_invalid`.
 *
 * Boundaries enforced here, all fail closed with typed refusals:
 * - root: canonical, absolute, exactly equal to one broker-allowlisted project
 *   root, and never equal to the plugin server root. Refusal happens BEFORE any
 *   child spawn; there is no fallback to `directory`, `worktree`,
 *   `process.cwd()`, or a handler registry.
 * - hooks: only the dedicated `asi-review-*` names. The installed
 *   `REVIEW_AGENTS` names are disjoint and pass through untouched.
 * - spawn: fixed binary + argv vector, `shell: false`, piped stdio, and a
 *   constructed allowlist-only HOME/XDG/locale environment.
 * - framing: `gentle-ai.provider-transport/v1` NDJSON with exact keys and
 *   state, verbatim prompt/result bytes, a 4 MiB stdout frame bound, a 64 KiB
 *   stderr bound, and fail-closed handling of a missing
 *   GENTLE_AI_REVIEW_CONTEXT_END.
 * - lifecycle: a versioned process-global owner/deferred/refused registry, a
 *   four-concurrent cap, a finite 600-second end-to-end deadline, and kill on
 *   crash, abort, duplicate completion, or disposal.
 *
 * The relay never synthesizes provider tokens, lineage, subject identity, or
 * authority: it forwards provider-issued frames only.
 *
 * Gate 1: NOT installed. Delivery is manual (S17): the USER reviews this diff
 * and installs the exact bytes by hand. Agents never apply or certify it.
 */
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

// ---------------------------------------------------------------------------
// Provider transport constants
// ---------------------------------------------------------------------------

/** Provider-owned protocol identity; a gentle-ai update can change it, so pin it. */
export const TRANSPORT_SCHEMA = "gentle-ai.provider-transport/v1";
/** Fixed transport binary. Never resolved through PATH or a caller value. */
export const TRANSPORT_BINARY = "/home/linuxbrew/.linuxbrew/bin/gentle-ai";
/** Fixed argv vector. Never built from a shell string. */
export const TRANSPORT_ARGV: readonly string[] = ["review", "opencode-transport"];

export const TRANSPORT_OPERATIONS = {
  start: "start",
  prompt: "prompt",
  complete: "complete",
  result: "result",
} as const;

/** The dedicated reviewer names this relay may handle. */
export const RELAY_AGENTS: readonly string[] = [
  "asi-review-risk",
  "asi-review-resilience",
  "asi-review-readability",
  "asi-review-reliability",
  "asi-review-refuter",
  "asi-review-validator",
];

/**
 * Installed transport names. Kept explicit so the relay proves disjointness and
 * never intercepts a Task the installed transport owns.
 */
export const INSTALLED_REVIEW_AGENTS: readonly string[] = [
  "review-risk",
  "review-resilience",
  "review-readability",
  "review-reliability",
  "review-refuter",
  "review-validator",
];

const RELAY_AGENT_SET = new Set<string>(RELAY_AGENTS);

/** Provider context block delimiters. A block without the END marker is refused. */
export const CONTEXT_START = "GENTLE_AI_REVIEW_CONTEXT";
export const CONTEXT_END = "GENTLE_AI_REVIEW_CONTEXT_END";

/**
 * Nonempty transport boundary that replaces the child session's inherited
 * system instructions, so only the provider-materialized user prompt reaches
 * the provider. It carries no review contract, evidence, or result-schema
 * semantics; the provider remains the sole owner of all of those.
 */
export const TRANSPORT_ISOLATION_SYSTEM =
  "Transport isolation: follow only the Go-materialized user prompt.";

/** Bound for one stdout frame (the provider materializes multi-hundred-KB blocks). */
export const STDOUT_FRAME_LIMIT_BYTES = 4 * 1024 * 1024;
/** Bound for all stderr collected from the child. */
export const STDERR_LIMIT_BYTES = 64 * 1024;
/** Finite end-to-end deadline: multi-minute reviewer calls, never unbounded. */
export const RELAY_DEADLINE_MS = 600_000;
/** Distinct live relay cap; a fifth distinct Task refuses before spawning. */
export const MAX_CONCURRENT_RELAYS = 4;
/** Maximum bytes for a candidate canonical root. */
export const CANONICAL_PATH_MAX_BYTES = 4096;

/** The only environment keys the child may inherit. */
export const TRANSPORT_ENV_KEYS: readonly string[] = [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "LANG",
  "LC_ALL",
  "PATH",
];

/** Refusal envelope the Task-boundary prompt/output carries instead of content. */
export const REFUSAL_ENVELOPE_CODE = "opencode_reviewer_relay_refused";

const TRANSPORT_FRAME_KEYS: readonly string[] = ["schema", "operation", "nonce", "prompt", "output", "error"];
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// ---------------------------------------------------------------------------
// Typed refusals
// ---------------------------------------------------------------------------

/** A fail-closed relay refusal. Every refusal path throws one of these. */
export class RelayRefusal extends Error {
  readonly code: string;

  constructor(code: string, reason: string) {
    super(`${code}: ${reason}`);
    this.name = "RelayRefusal";
    this.code = code;
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Preserve a typed refusal, or wrap an unexpected failure in the supplied typed
 * refusal so a session/broker fault can never escape untyped.
 */
function refusalOr(cause: unknown, make: (reason: string) => RelayRefusal): RelayRefusal {
  return cause instanceof RelayRefusal ? cause : make(messageOf(cause));
}

const rootRefused = (reason: string) => new RelayRefusal("reviewer_relay_root_refused", reason);
const policyRefused = (reason: string) => new RelayRefusal("reviewer_relay_policy_refused", reason);
const sessionLookupFailed = (reason: string) =>
  new RelayRefusal("reviewer_relay_session_lookup_failed", reason);
const environmentRefused = (reason: string) =>
  new RelayRefusal("reviewer_relay_environment_refused", reason);
const frameMalformed = (reason: string) => new RelayRefusal("reviewer_relay_frame_malformed", reason);
const frameOversized = (reason: string) => new RelayRefusal("reviewer_relay_frame_oversized", reason);
const frameRefused = (reason: string) => new RelayRefusal("reviewer_relay_frame_refused", reason);
const stderrOversized = (reason: string) =>
  new RelayRefusal("reviewer_relay_stderr_oversized", reason);
const deadlineExpired = (reason: string) =>
  new RelayRefusal("reviewer_relay_deadline_expired", reason);
const childExited = (reason: string) => new RelayRefusal("reviewer_relay_child_exited", reason);
const spawnFailed = (reason: string) => new RelayRefusal("reviewer_relay_spawn_failed", reason);
const abortedRefusal = (reason: string) => new RelayRefusal("reviewer_relay_aborted", reason);
const disposedRefusal = (reason: string) => new RelayRefusal("reviewer_relay_disposed", reason);
const duplicateCompletion = (reason: string) =>
  new RelayRefusal("reviewer_relay_completion_duplicate", reason);
const concurrencyRefused = (reason: string) =>
  new RelayRefusal("reviewer_relay_concurrency_refused", reason);
const taskRefused = (reason: string) => new RelayRefusal("reviewer_relay_task_refused", reason);

// ---------------------------------------------------------------------------
// Canonical allowlisted root resolution
// ---------------------------------------------------------------------------

/**
 * Require an already-canonical absolute root. Relative paths, symlink aliases,
 * lexical aliases (`a/../b`, doubled separators, trailing slashes), selector
 * text, and control characters all refuse, so a caller can never smuggle a
 * `git -C`-like value or a noncanonical alias into a child spawn.
 */
export function requireCanonicalAbsoluteRoot(value: unknown, realpath: (path: string) => string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw rootRefused("root must be a non-empty absolute path");
  }
  if (Buffer.byteLength(value, "utf8") > CANONICAL_PATH_MAX_BYTES) {
    throw rootRefused(`root exceeds ${CANONICAL_PATH_MAX_BYTES} bytes`);
  }
  if (CONTROL_CHARS.test(value)) {
    throw rootRefused("root contains control characters or NUL");
  }
  if (!isAbsolute(value)) {
    throw rootRefused("root must be an absolute path");
  }
  let canonical: string;
  try {
    canonical = realpath(value);
  } catch {
    throw rootRefused("root does not resolve on the host");
  }
  if (canonical !== value) {
    throw rootRefused("root is not the canonical path");
  }
  return canonical;
}

export interface RootSelectionInput {
  /** The Task session's repository directory, as reported by `client.session.get`. */
  sessionDirectory: unknown;
  /** The plugin instance's project root (`worktree || directory`). */
  serverRoot: unknown;
  /** Broker `policy.projects` entries (objects with `path`, or raw path strings). */
  projectPaths: readonly unknown[];
  realpath: (path: string) => string;
}

/**
 * Select the reviewer Task's canonical repository root.
 *
 * The session repository must be a canonical absolute path, exactly equal to
 * one broker-allowlisted project root, and different from the plugin server
 * root. Every failure refuses before any child process exists.
 */
export function selectCanonicalSessionRoot(input: RootSelectionInput): string {
  const sessionRoot = requireCanonicalAbsoluteRoot(input.sessionDirectory, input.realpath);
  const entries = input.projectPaths;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw rootRefused("broker policy carries no allowlisted project roots");
  }
  const allowlist: string[] = [];
  for (const entry of entries) {
    const candidate =
      entry !== null && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as { path?: unknown }).path
        : entry;
    allowlist.push(requireCanonicalAbsoluteRoot(candidate, input.realpath));
  }
  if (!allowlist.includes(sessionRoot)) {
    throw rootRefused("session repository is not an exact allowlisted project root");
  }
  const serverRoot = requireCanonicalAbsoluteRoot(input.serverRoot, input.realpath);
  console.log(`[reviewer-relay] root check sessionRoot=${sessionRoot} serverRoot=${serverRoot}`);
  if (serverRoot === sessionRoot) {
    throw rootRefused("session repository equals the plugin server root");
  }
  return sessionRoot;
}

const ROOT_CACHE_KEY = "__gentleAiReviewerRelayTransportRootsV1" as const;

/**
 * Versioned process-global cache of validated session roots. Only successful
 * resolutions are stored; a miss re-queries the session client and the broker
 * instead of falling back to any ambient directory.
 */
export function sessionRootCache(): Map<string, string> {
  const runtime = globalThis as typeof globalThis & { [ROOT_CACHE_KEY]?: Map<string, string> };
  if (runtime[ROOT_CACHE_KEY] === undefined) runtime[ROOT_CACHE_KEY] = new Map<string, string>();
  return runtime[ROOT_CACHE_KEY];
}

export interface SessionRootResolutionDeps {
  lookupSessionDirectory: (sessionID: string) => Promise<unknown>;
  loadAllowlistedPaths: () => Promise<readonly unknown[]>;
  realpath: (path: string) => string;
  serverRoot: unknown;
  cache?: Map<string, string>;
}

/** Resolve (and cache) the canonical allowlisted root for a reviewer Task session. */
export function createSessionRootResolver(
  deps: SessionRootResolutionDeps,
): (sessionID: string) => Promise<string> {
  const cache = deps.cache ?? sessionRootCache();
  return async (sessionID: string): Promise<string> => {
    if (typeof sessionID !== "string" || sessionID.length === 0) {
      throw rootRefused("session id is unavailable");
    }
    const cached = cache.get(sessionID);
    if (cached !== undefined) {
      // Re-check the server-root inequality on a hit so a cache shared with
      // another plugin instance can never bypass this instance's guard.
      if (requireCanonicalAbsoluteRoot(deps.serverRoot, deps.realpath) === cached) {
        throw rootRefused("cached session repository equals the plugin server root");
      }
      return cached;
    }
    let sessionDirectory: unknown;
    try {
      sessionDirectory = await deps.lookupSessionDirectory(sessionID);
    } catch (cause) {
      throw refusalOr(cause, sessionLookupFailed);
    }
    let projectPaths: readonly unknown[];
    try {
      projectPaths = await deps.loadAllowlistedPaths();
    } catch (cause) {
      throw refusalOr(cause, policyRefused);
    }
    const root = selectCanonicalSessionRoot({
      sessionDirectory,
      serverRoot: deps.serverRoot,
      projectPaths,
      realpath: deps.realpath,
    });
    cache.set(sessionID, root);
    return root;
  };
}

/** Minimal structural view of the OpenCode client this relay needs. */
export interface SessionLookupClient {
  session: {
    get: (options: { path: { id: string } }) => Promise<unknown>;
  };
}

/** Read a session's repository directory through the OpenCode client. */
export function createSessionDirectoryLookup(
  client: SessionLookupClient,
): (sessionID: string) => Promise<unknown> {
  return async (sessionID: string): Promise<unknown> => {
    let response: unknown;
    try {
      response = await client.session.get({ path: { id: sessionID } });
    } catch (cause) {
      throw sessionLookupFailed(messageOf(cause));
    }
    const session = (response as { data?: unknown } | null | undefined)?.data;
    if (session === null || typeof session !== "object" || Array.isArray(session)) {
      throw sessionLookupFailed("session.get returned no session record");
    }
    return (session as { directory?: unknown }).directory;
  };
}

export type BrokerRequestFn = (
  operation: string,
  sessionID: string,
  payload?: unknown,
) => Promise<unknown>;

/** Read the broker's allowlisted project roots (`policy.projects`). */
export function createAllowlistedRootLoader(
  brokerRequest: BrokerRequestFn,
): () => Promise<readonly unknown[]> {
  return async (): Promise<readonly unknown[]> => {
    let result: unknown;
    try {
      result = await brokerRequest("policy", "reviewer-relay", undefined);
    } catch (cause) {
      throw policyRefused(messageOf(cause));
    }
    if (result === null || typeof result !== "object" || Array.isArray(result)) {
      throw policyRefused("broker policy is not an object");
    }
    const projects = (result as { projects?: unknown }).projects;
    if (!Array.isArray(projects)) {
      throw policyRefused("broker policy carries no projects list");
    }
    return projects.map((entry) =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as { path?: unknown }).path
        : entry,
    );
  };
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Known git install directories, probed in order. The secure server runs under
 * systemd, whose default PATH need not include the Linuxbrew directory where
 * git may live, so the first existing git binary's directory is prepended to
 * the child PATH. PATH is not credential-shaped: it is the one non-secret
 * addition to the allowlist, and the probe reads directories only.
 */
const GIT_PROBE_DIRECTORIES: readonly string[] = [
  "/home/linuxbrew/.linuxbrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];

/** The first known directory on this host that actually contains a git binary. */
function hostGitDirectory(): string | undefined {
  for (const directory of GIT_PROBE_DIRECTORIES) {
    if (existsSync(`${directory}/git`)) return directory;
  }
  return undefined;
}

/** Construct the allowlist-only child environment. HOME is required. */
export function buildTransportEnv(source: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of TRANSPORT_ENV_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  if (env.HOME === undefined) {
    throw environmentRefused("the constructed transport environment requires HOME");
  }
  // Ensure the child can resolve git even when the inherited PATH lacks the
  // directory git lives in. Prepend the probed directory once, de-duplicating;
  // when no known location exists, leave the inherited PATH untouched rather
  // than inventing a value.
  const gitDirectory = hostGitDirectory();
  if (gitDirectory !== undefined) {
    const segments = env.PATH === undefined ? [] : env.PATH.split(":");
    env.PATH = [gitDirectory, ...segments.filter((segment) => segment !== gitDirectory)].join(":");
  }
  return env;
}

// ---------------------------------------------------------------------------
// Provider framing
// ---------------------------------------------------------------------------

export interface TransportFrame {
  schema: string;
  operation: string;
  nonce?: string;
  prompt?: string;
  output?: string;
  error?: string;
}

/**
 * Decode one NDJSON frame strictly: a JSON object with the pinned schema, a
 * string operation, and no keys outside the provider contract. Strings are
 * returned exactly as parsed so they can be forwarded byte-for-byte.
 */
export function decodeTransportFrame(line: string): TransportFrame {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw frameMalformed("transport frame is not JSON");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw frameMalformed("transport frame is not a JSON object");
  }
  const frame = raw as Record<string, unknown>;
  for (const key of Object.keys(frame)) {
    if (!TRANSPORT_FRAME_KEYS.includes(key)) {
      throw frameMalformed(`transport frame has an unexpected key: ${key}`);
    }
  }
  if (frame.schema !== TRANSPORT_SCHEMA) {
    throw frameMalformed(`transport frame schema is not ${TRANSPORT_SCHEMA}`);
  }
  if (typeof frame.operation !== "string" || frame.operation.length === 0) {
    throw frameMalformed("transport frame has no operation");
  }
  for (const key of ["nonce", "prompt", "output", "error"]) {
    if (frame[key] !== undefined && typeof frame[key] !== "string") {
      throw frameMalformed(`transport frame field '${key}' is not a string`);
    }
  }
  return frame as unknown as TransportFrame;
}

/**
 * Locate the real, line-anchored provider context-block start marker.
 *
 * The provider writes the start marker at the beginning of its own line —
 * `strings.CutPrefix(lines[1], "GENTLE_AI_REVIEW_CONTEXT ")` — so the marker is
 * line-anchored and followed by whitespace. The lens prompt itself also carries
 * the bare token in prose, so a mid-line occurrence is not a block and must not
 * satisfy the framing check. A bare END marker is skipped as well.
 *
 * Returns the character offset of the start marker, or -1 when there is none.
 */
function materializedContextStart(prompt: string): number {
  for (
    let index = prompt.indexOf(CONTEXT_START);
    index >= 0;
    index = prompt.indexOf(CONTEXT_START, index + 1)
  ) {
    if (index !== 0 && prompt.charAt(index - 1) !== "\n") continue;
    // The start delimiter is a prefix of the END delimiter, so a bare END
    // marker must not satisfy the start check.
    if (prompt.startsWith(CONTEXT_END, index)) continue;
    const following = prompt.charAt(index + CONTEXT_START.length);
    if (!/\s/.test(following)) continue;
    return index;
  }
  return -1;
}

/**
 * Require a complete provider-materialized context block: it must contain the
 * start delimiter and end with the END delimiter. A truncated block has no END
 * marker, so it is refused rather than prompted as partial context.
 *
 * The provider concatenates its own prompt after the materialization header, so
 * the materialized string can carry trailing whitespace after the final END
 * delimiter; only whitespace is tolerated there, and any other trailing content
 * is refused.
 */
export function validateMaterializedPrompt(prompt: unknown): string {
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw frameRefused("prompt frame carries no materialized prompt");
  }
  if (materializedContextStart(prompt) < 0) {
    throw frameRefused(`materialized prompt has no ${CONTEXT_START} block`);
  }
  if (prompt.endsWith(CONTEXT_END)) return prompt;
  // The provider appends its own prompt after the materialization header, so
  // the final END delimiter can be followed by trailing whitespace. Accept
  // only whitespace there, and check the tail in place without copying.
  const endIndex = prompt.lastIndexOf(CONTEXT_END);
  if (endIndex < 0) {
    throw frameRefused(`materialized prompt does not end with ${CONTEXT_END}`);
  }
  for (let index = endIndex + CONTEXT_END.length; index < prompt.length; index += 1) {
    if (!/\s/.test(prompt.charAt(index))) {
      throw frameRefused(`materialized prompt does not end with ${CONTEXT_END}`);
    }
  }
  return prompt;
}

/** The binding-only start frame: schema, operation, and the verbatim prompt. */
export function buildStartFrame(prompt: string): string {
  return `${JSON.stringify({ schema: TRANSPORT_SCHEMA, operation: TRANSPORT_OPERATIONS.start, prompt })}\n`;
}

/**
 * The completion frame. It echoes the provider-issued nonce and carries either
 * the Task host's output or an explicit unavailability token; it never invents
 * a token, lineage, subject hash, or authority value.
 */
export function buildCompleteFrame(nonce: string, output: unknown): string {
  const frame: TransportFrame = {
    schema: TRANSPORT_SCHEMA,
    operation: TRANSPORT_OPERATIONS.complete,
    nonce,
  };
  if (typeof output === "string") frame.output = output;
  else frame.error = "opencode_task_host_output_unavailable";
  return `${JSON.stringify(frame)}\n`;
}

/**
 * Extract the reviewer text from the Task host's after-hook output.
 *
 * The installed hook contract types the result as
 * `{ title: string; output: string; metadata: unknown }`, so the text normally
 * arrives on `output.output`. A host can also hand the relay the structured
 * result record or a rendered message part; read the text field one level down
 * so the reviewer's output still reaches the completion frame. No text means no
 * completion content: the caller keeps the fail-closed unavailability error.
 */
export function reviewerOutputText(output: unknown): string | undefined {
  if (typeof output === "string") return output;
  if (output === null || typeof output !== "object" || Array.isArray(output)) return undefined;
  const record = output as Record<string, unknown>;
  for (const key of ["output", "text", "content"]) {
    const candidate = record[key];
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Bounded transport child process
// ---------------------------------------------------------------------------

export interface TransportSpawnSpec {
  command: string;
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
}

export interface TransportChild {
  write(data: string, onError?: (cause: unknown) => void): void;
  end(data: string): void;
  kill(): void;
}

export interface TransportHandlers {
  stdout: (chunk: Buffer) => void;
  stderr: (chunk: Buffer) => void;
  error: (cause: unknown) => void;
  close: (code: number | null, signal: string | null) => void;
}

export type TransportSpawn = (spec: TransportSpawnSpec, handlers: TransportHandlers) => TransportChild;

export interface NodeChildLike {
  stdout: { on: (event: "data", handler: (chunk: Buffer) => void) => void };
  stderr: { on: (event: "data", handler: (chunk: Buffer) => void) => void };
  stdin: {
    write: (data: string, cb?: (err?: Error | null) => void) => void;
    end: (data: string) => void;
  };
  on: {
    (event: "error", handler: (cause: unknown) => void): void;
    (event: "close", handler: (code: number | null, signal: string | null) => void): void;
  };
  kill: () => void;
}

export interface NodeSpawnOptions {
  cwd: string;
  env: Record<string, string>;
  stdio: ["pipe", "pipe", "pipe"];
  shell: false;
}

export type RawNodeSpawn = (command: string, argv: string[], options: NodeSpawnOptions) => NodeChildLike;

/**
 * Node adapter: no shell, piped stdio, the validated cwd, and the constructed
 * allowlist-only environment. Nothing else from the host process is inherited.
 */
export function createNodeTransportSpawn(
  rawSpawn: RawNodeSpawn = spawn as unknown as RawNodeSpawn,
): TransportSpawn {
  return (spec, handlers) => {
    const child = rawSpawn(spec.command, [...spec.argv], {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    child.stdout.on("data", handlers.stdout);
    child.stderr.on("data", handlers.stderr);
    child.on("error", handlers.error);
    child.on("close", handlers.close);
    return {
      write: (data, onError) =>
        child.stdin.write(data, (err) => {
          if (err) onError?.(err);
        }),
      end: (data) => child.stdin.end(data),
      kill: () => {
        try {
          child.kill();
        } catch {
          /* the child is already gone */
        }
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Relay lifecycle
// ---------------------------------------------------------------------------

export interface Relay {
  prompt: Promise<{ nonce: string; prompt: string }>;
  complete: (output: unknown) => Promise<string>;
  close: () => void;
}

export interface RelayStartOptions {
  cwd: unknown;
  prompt: string;
  env?: Record<string, string | undefined>;
  spawn?: TransportSpawn;
  realpath?: (path: string) => string;
  deadlineMs?: number;
  stdoutFrameLimitBytes?: number;
  stderrLimitBytes?: number;
  signal?: AbortSignal;
}

const realpathDefault = (path: string): string => realpathSync(path);

/**
 * Start one bounded provider relay child.
 *
 * The canonical-root check and the environment construction both run BEFORE
 * the spawn, so a refusal never leaves a child behind. Framing is bounded, the
 * deadline is finite, and every terminal path (result, crash, abort, duplicate
 * completion, disposal, deadline) is a typed refusal or a provider value.
 */
export function startRelay(options: RelayStartOptions): Relay {
  const realpath = options.realpath ?? realpathDefault;
  const spawnFn = options.spawn ?? createNodeTransportSpawn();
  const deadlineMs = options.deadlineMs ?? RELAY_DEADLINE_MS;
  const stdoutLimit = options.stdoutFrameLimitBytes ?? STDOUT_FRAME_LIMIT_BYTES;
  const stderrLimit = options.stderrLimitBytes ?? STDERR_LIMIT_BYTES;

  // Refusals before spawn: root, then abort, then environment.
  const cwd = requireCanonicalAbsoluteRoot(options.cwd, realpath);
  if (options.signal?.aborted === true) {
    throw abortedRefusal("review relay was aborted before it started");
  }
  const env = buildTransportEnv(options.env ?? process.env);

  let buffered: Buffer = Buffer.alloc(0);
  let bufferedBytes = 0;
  let stderrBytes = 0;
  let closed = false;
  let resultSeen = false;
  let admittedResult: string | null = null;
  let promptSeen = false;
  let disposed = false;
  let completionClaimed = false;
  const stderrChunks: Buffer[] = [];

  let resolvePrompt!: (value: { nonce: string; prompt: string }) => void;
  let rejectPrompt!: (reason: unknown) => void;
  let resolveResult!: (value: string) => void;
  let rejectResult!: (reason: unknown) => void;
  const promptFrame = new Promise<{ nonce: string; prompt: string }>((resolve, reject) => {
    resolvePrompt = resolve;
    rejectPrompt = reject;
  });
  const resultFrame = new Promise<string>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  void promptFrame.catch(() => {});
  void resultFrame.catch(() => {});

  function fail(cause: unknown): void {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    rejectPrompt(cause);
    rejectResult(cause);
    child.kill();
  }

  function onStdout(chunk: Buffer): void {
    if (closed) return;
    // Assemble raw bytes and decode a line only once it is complete. Decoding
    // each chunk independently would corrupt a multibyte UTF-8 code point that
    // is split across two stdout chunks, breaking the verbatim-frame rule.
    buffered = Buffer.concat([buffered, chunk]);
    bufferedBytes += chunk.length;
    if (bufferedBytes > stdoutLimit) {
      fail(frameOversized(`stdout frame exceeds ${stdoutLimit} bytes`));
      return;
    }
    for (;;) {
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      const line = buffered.subarray(0, newline).toString("utf8");
      buffered = buffered.subarray(newline + 1);
      bufferedBytes = buffered.length;
      let frame: TransportFrame;
      try {
        frame = decodeTransportFrame(line);
      } catch (cause) {
        fail(cause);
        return;
      }
      if (resultSeen) {
        fail(frameRefused("extra frame after the result frame"));
        return;
      }
      if (frame.operation === TRANSPORT_OPERATIONS.prompt) {
        if (promptSeen) {
          fail(frameRefused("duplicate prompt frame"));
          return;
        }
        if (typeof frame.nonce !== "string" || frame.nonce.length === 0) {
          fail(frameMalformed("prompt frame carries no nonce"));
          return;
        }
        let materialized: string;
        try {
          materialized = validateMaterializedPrompt(frame.prompt);
        } catch (cause) {
          fail(cause);
          return;
        }
        promptSeen = true;
        resolvePrompt({ nonce: frame.nonce, prompt: materialized });
        continue;
      }
      if (frame.operation === TRANSPORT_OPERATIONS.result) {
        if (!promptSeen) {
          fail(frameRefused("result frame before the prompt frame"));
          return;
        }
        if (typeof frame.output !== "string" || frame.output.length === 0) {
          fail(frameRefused("result frame carries no output"));
          return;
        }
        // The result frame is terminal for the protocol, but a further frame
        // can still legitimately arrive until the child's stdout ends. Hold
        // the admitted output here, keep the stdout reader and the deadline
        // live, and admit only in onClose once stdout has reached EOF, so a
        // later complete frame reaches the extra-frame refusal instead of
        // being dropped by an already-settled completion.
        resultSeen = true;
        admittedResult = frame.output;
        continue;
      }
      fail(frameRefused(`unexpected transport operation '${frame.operation}'`));
      return;
    }
  }

  function onStderr(chunk: Buffer): void {
    if (closed || resultSeen) return;
    if (stderrBytes + chunk.length > stderrLimit) {
      fail(stderrOversized(`stderr exceeds ${stderrLimit} bytes`));
      return;
    }
    stderrBytes += chunk.length;
    stderrChunks.push(chunk);
  }

  function onError(cause: unknown): void {
    if (closed || resultSeen) return;
    fail(spawnFailed(messageOf(cause)));
  }

  function onClose(code: number | null, signal: string | null): void {
    if (closed) return;
    if (resultSeen) {
      // stdout ended, so no further frame can arrive. A partial line left
      // after the result is an incomplete extra frame and fails closed.
      if (buffered.length > 0) {
        fail(frameRefused("partial frame after the result frame"));
        return;
      }
      const admitted = admittedResult;
      if (admitted === null) {
        fail(frameRefused("result frame carried no admitted output"));
        return;
      }
      closed = true;
      clearTimeout(timer);
      resolveResult(admitted);
      return;
    }
    const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();
    const partial = buffered.length > 0 ? "partial frame at transport EOF; " : "";
    const status = code ?? signal ?? "signal";
    fail(childExited(`${partial}transport exited before completion (${status})${stderrText ? `: ${stderrText}` : ""}`));
  }

  const handlers: TransportHandlers = { stdout: onStdout, stderr: onStderr, error: onError, close: onClose };

  const child = spawnFn({ command: TRANSPORT_BINARY, argv: TRANSPORT_ARGV, cwd, env }, handlers);

  const timer = setTimeout(() => {
    if (closed) return;
    child.kill();
    fail(deadlineExpired(`review relay deadline of ${deadlineMs} ms expired`));
  }, deadlineMs);
  (timer as unknown as { unref?: () => void }).unref?.();

  const onAbort = () => {
    if (closed || resultSeen) return;
    child.kill();
    fail(abortedRefusal("review relay was aborted"));
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  child.write(buildStartFrame(options.prompt), (cause) => fail(spawnFailed(messageOf(cause))));

  return {
    prompt: promptFrame,
    complete: async (output: unknown): Promise<string> => {
      if (disposed) throw disposedRefusal("review relay was disposed before completion");
      if (completionClaimed) {
        throw duplicateCompletion("review relay completion was already requested for this Task");
      }
      completionClaimed = true;
      const materialized = await promptFrame;
      child.end(buildCompleteFrame(materialized.nonce, output));
      return await resultFrame;
    },
    close: () => {
      if (disposed) return;
      disposed = true;
      options.signal?.removeEventListener("abort", onAbort);
      if (!closed) {
        closed = true;
        clearTimeout(timer);
        rejectPrompt(disposedRefusal("review relay was disposed"));
        rejectResult(disposedRefusal("review relay was disposed"));
      }
      child.kill();
    },
  };
}

// ---------------------------------------------------------------------------
// Hook scope, refusal projection, and the process-global registry
// ---------------------------------------------------------------------------

const RELAY_REGISTRY_KEY = "__gentleAiReviewerRelayTransportRelays" as const;

export interface RelayRegistration {
  owner: symbol;
  relay: Relay;
  completing: boolean;
  /** Parent (caller) session id of the Task that started this relay. */
  parentSessionID: string;
  /** Relay reviewer agent this registration serves. */
  subagentType: string;
  /**
   * Provider-materialized prompt resolved by the before hook once its frame is
   * admitted. The child session created for this Task is bound to it so the
   * system transform can deliver it without cross-contaminating a sibling lens.
   */
  materialized?: string;
  /** Reviewer child session bound to this registration, if one exists. */
  childSessionID?: string;
}

export type RelayRegistry = Map<string, RelayRegistration>;

/**
 * The relay registry is deliberately process-global so duplicate plugin
 * instances (for example one loaded from global config and one from project
 * config) share one view of live review Task relays instead of spawning
 * duplicate provider children for the same Task.
 *
 * Owner invariant: only the instance whose before hook spawned a relay may
 * complete, delete, or close it. An instance that observes an already
 * registered key defers to the owner and passes the Task through untouched.
 */
export function relayRegistry(): RelayRegistry {
  const runtime = globalThis as typeof globalThis & { [RELAY_REGISTRY_KEY]?: RelayRegistry };
  if (runtime[RELAY_REGISTRY_KEY] === undefined) runtime[RELAY_REGISTRY_KEY] = new Map();
  return runtime[RELAY_REGISTRY_KEY];
}

/** Task identity for relay ownership: session, call, and reviewer agent. */
export function taskKey(sessionID: string, callID: string, subagentType: string): string {
  return `${sessionID}:${callID}:${subagentType}`;
}

/**
 * Resolve the reviewer child session id and relay agent from a
 * `session.created` event. OpenCode emits the runtime `agent` field for Task
 * child sessions but omits it from the published event type, so accept a
 * matching `(@<agent> subagent)` title too. The agent is returned so a child
 * session can be bound to the relay that owns its Task.
 */
export function decodeReviewSession(info: unknown): { id: string; agent: string } | undefined {
  if (info === null || typeof info !== "object" || Array.isArray(info)) return undefined;
  const id = Reflect.get(info, "id");
  if (typeof id !== "string") return undefined;
  const agent = Reflect.get(info, "agent");
  if (agent !== undefined) {
    return typeof agent === "string" && RELAY_AGENT_SET.has(agent) ? { id, agent } : undefined;
  }
  const title = Reflect.get(info, "title");
  if (typeof title !== "string") return undefined;
  for (const relayAgent of RELAY_AGENTS) {
    const suffix = ` (@${relayAgent} subagent)`;
    if (title.endsWith(suffix) && title.length > suffix.length) return { id, agent: relayAgent };
  }
  return undefined;
}

/** Backward-compatible projection of `decodeReviewSession` to the child id. */
export function decodeReviewSessionID(info: unknown): string | undefined {
  return decodeReviewSession(info)?.id;
}

/**
 * First characters of a session id for content-free relay diagnostics. Never
 * emits the full identifier and never carries prompt or candidate content.
 */
function shortSessionID(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 8) : "<none>";
}

/** The refusal prompt an unbound Task receives instead of semi-bound content. */
export function refusalPrompt(reason: string): string {
  return (
    `${REFUSAL_ENVELOPE_CODE}: the reviewer relay refused this Task before launch: ${reason}\n` +
    "You have no review binding and no frozen candidate evidence. Do not inspect anything, " +
    "do not fabricate findings, and do not return a review result. " +
    `Reply with exactly: ${REFUSAL_ENVELOPE_CODE}`
  );
}

/** The refusal output that replaces raw prose from an unbound child. */
export function refusalOutput(reason: string): string {
  return `${REFUSAL_ENVELOPE_CODE}: ${reason}`;
}

/**
 * A fail-closed Task boundary result. This host surfaces a hook's returned
 * `error` field to the model verbatim, while a throw from `tool.execute.before`
 * collapses into a generic "tool execution aborted" that drops the typed
 * refusal. Every relay refusal returns one of these instead of throwing.
 */
export interface ToolRefusalResult {
  readonly error: string;
}

/** Wrap a typed refusal as the hook's verbatim tool-error result. */
export function toolRefusalResult(refusal: RelayRefusal): ToolRefusalResult {
  return { error: refusal.message };
}

// ---------------------------------------------------------------------------
// Plugin hooks
// ---------------------------------------------------------------------------

export interface ToolBeforeInput {
  tool: string;
  sessionID: string;
  callID: string;
}

export interface ToolBeforeOutput {
  args?: Record<string, unknown>;
}

export interface ToolAfterInput extends ToolBeforeInput {
  args?: Record<string, unknown>;
}

export interface ToolAfterOutput {
  args?: Record<string, unknown>;
  output?: unknown;
}

export type RelayEvent =
  | { type: "session.created"; properties?: { info?: unknown } }
  | { type: "session.deleted"; properties: { info: { id: string } } }
  | { type: string; properties?: unknown };

export interface SystemTransformOutput {
  system: string[];
}

/** One part of a chat message as the messages transform exposes it. */
export interface ChatMessagePart {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

/** The identifying fields of a chat message entry's `info`. */
export interface ChatMessageInfo {
  sessionID?: string;
  role?: string;
  agent?: string;
}

/** A chat message entry: the message `info` plus its ordered parts. */
export interface ChatMessageEntry {
  info?: ChatMessageInfo;
  parts?: ChatMessagePart[];
}

/**
 * The installed `experimental.chat.messages.transform` hook carries no input
 * fields, so the session id is derived from the last user message. An
 * optional `sessionID` is tolerated for hosts that pass one.
 */
export interface MessagesTransformInput {
  sessionID?: string;
}

export interface MessagesTransformOutput {
  messages: ChatMessageEntry[];
}

export interface ReviewerRelayHooks {
  dispose: () => Promise<void>;
  event: (input: { event: RelayEvent }) => Promise<void>;
  "experimental.chat.system.transform": (
    input: { sessionID?: string },
    output: SystemTransformOutput,
  ) => Promise<void>;
  "experimental.chat.messages.transform": (
    input: MessagesTransformInput,
    output: MessagesTransformOutput,
  ) => Promise<void>;
  "tool.execute.before": (
    input: ToolBeforeInput,
    output: ToolBeforeOutput,
  ) => Promise<void | ToolRefusalResult>;
  "tool.execute.after": (
    input: ToolAfterInput,
    output: ToolAfterOutput,
  ) => Promise<void | ToolRefusalResult>;
}

export interface ReviewerRelayConfig {
  client?: SessionLookupClient;
  directory?: string;
  worktree?: string;
  /**
   * The stable plugin-process boot root, not the per-request instance
   * directory. `PluginInput.directory` follows the request and equals the
   * session's project, so it must never be the server-root inequality guard.
   * When omitted, the historical `worktree || directory` fallback is used.
   */
  serverRoot?: string;
  brokerRequest?: BrokerRequestFn;
  spawn?: TransportSpawn;
  realpath?: (path: string) => string;
  env?: Record<string, string | undefined>;
  rootCache?: Map<string, string>;
  registry?: RelayRegistry;
  deadlineMs?: number;
  stdoutFrameLimitBytes?: number;
  stderrLimitBytes?: number;
}

/**
 * Wire the relay into the OpenCode Task lifecycle.
 *
 * `tool.execute.before` resolves the Task session's allowlisted canonical root,
 * spawns the single fixed transport child with it, and replaces the Task prompt
 * with the provider-materialized block. `tool.execute.after` returns the
 * provider result frame unchanged. Anything the relay refuses leaves a typed
 * refusal in both projections so an unbound child can never masquerade as a
 * captured reviewer result.
 */
export function createReviewerRelayHooks(config: ReviewerRelayConfig): ReviewerRelayHooks {
  const owner = Symbol("gentle-ai-reviewer-relay-transport");
  const realpath = config.realpath ?? realpathDefault;
  const spawnFn = config.spawn;
  const relays = config.registry ?? relayRegistry();
  // Child sessions inherit the live agent, project, and skill system blocks
  // unless this pre-provider transform strips them. This is per plugin
  // instance, like relay ownership; duplicate instances safely converge on the
  // same one-element system array.
  const reviewSessions = new Set<string>();
  // Provider-materialized prompts bound to a reviewer child session. Kept per
  // plugin instance for the transform; the child->prompt binding itself lives
  // on the shared registration so duplicate instances resolve it identically.
  const materializedBySession = new Map<string, string>();
  // Keys this instance observed at before time whose registration another
  // instance owns. That owner's after hook delivers the completion, so this
  // instance passes those Tasks through untouched. This deferral is the only
  // tolerated silent completion path; every other unmatched completion refuses.
  const deferred = new Map<string, RelayRegistration>();
  // Keys whose relay start this instance refused. Their Tasks must never
  // deliver child output as a completion, even if the host runtime swallowed
  // the before hook's thrown refusal and launched the Task anyway.
  const refused = new Map<string, string>();

  const directory = config.directory ?? "";
  const worktree = config.worktree ?? "";
  // PluginInput directories follow the request, so they cannot identify the
  // server's own root. Prefer the explicit stable boot root when supplied;
  // without it, keep the historical worktree-or-directory fallback so existing
  // callers and tests behave exactly as before.
  const serverRoot = config.serverRoot ?? (worktree.length > 0 ? worktree : directory);

  const lookupSessionDirectory = (sessionID: string): Promise<unknown> => {
    const client = config.client;
    if (client === undefined) {
      return Promise.reject(sessionLookupFailed("the plugin has no OpenCode session client"));
    }
    return createSessionDirectoryLookup(client)(sessionID);
  };
  const loadAllowlistedPaths = (): Promise<readonly unknown[]> => {
    const brokerRequest = config.brokerRequest;
    if (brokerRequest === undefined) {
      return Promise.reject(policyRefused("the plugin has no broker policy client"));
    }
    return createAllowlistedRootLoader(brokerRequest)();
  };

  const resolveSessionRoot = createSessionRootResolver({
    lookupSessionDirectory,
    loadAllowlistedPaths,
    realpath,
    serverRoot,
    cache: config.rootCache,
  });

  const startRelayFor = (cwd: string, prompt: string): Relay =>
    startRelay({
      cwd,
      prompt,
      ...(spawnFn ? { spawn: spawnFn } : {}),
      ...(config.env ? { env: config.env } : {}),
      realpath,
      ...(config.deadlineMs !== undefined ? { deadlineMs: config.deadlineMs } : {}),
      ...(config.stdoutFrameLimitBytes !== undefined
        ? { stdoutFrameLimitBytes: config.stdoutFrameLimitBytes }
        : {}),
      ...(config.stderrLimitBytes !== undefined ? { stderrLimitBytes: config.stderrLimitBytes } : {}),
    });

  /**
   * Project a typed refusal into the Task prompt as defense in depth and record
   * it so a host that ignores the returned tool error still cannot deliver raw
   * child output as a completion. Delivery itself is the returned tool-error
   * result, never a thrown hook error the host converts into a generic abort.
   */
  const refuseTaskBoundary = (
    output: ToolBeforeOutput,
    key: string,
    refusal: RelayRefusal,
  ): void => {
    refused.set(key, refusal.message);
    if (output.args !== undefined) output.args.prompt = refusalPrompt(refusal.message);
  };

  /** Project a completion refusal into the Task output and return the typed error. */
  const refuseCompletion = (
    output: ToolAfterOutput,
    refusal: RelayRefusal,
  ): ToolRefusalResult => {
    output.output = refusalOutput(refusal.message);
    return toolRefusalResult(refusal);
  };

  const clearOwned = (key: string): void => {
    const registration = relays.get(key);
    if (!registration || registration.owner !== owner) return;
    relays.delete(key);
    registration.relay.close();
  };

  const clearSession = (prefix: string): void => {
    // Owner-scoped on purpose: every live instance receives session.deleted and
    // clears only its own registrations, so no instance closes a relay it does
    // not own. A disposed instance is cleared by its dispose hook instead.
    for (const [key, registration] of [...relays]) {
      if (!key.startsWith(prefix) || registration.owner !== owner) continue;
      relays.delete(key);
      registration.relay.close();
    }
    for (const key of [...deferred.keys()]) if (key.startsWith(prefix)) deferred.delete(key);
    for (const key of [...refused.keys()]) if (key.startsWith(prefix)) refused.delete(key);
  };

  const isRelayAgent = (value: unknown): value is string =>
    typeof value === "string" && RELAY_AGENT_SET.has(value);

  /**
   * Bind the provider-materialized prompt to the reviewer child session created
   * for a Task. The child carries its parent session and relay agent; match the
   * pending registration for that pair. An exact child binding is honored first
   * so a duplicate plugin instance reuses the shared decision instead of
   * replaying its own guess. Scanning stops at the first unbound registration,
   * and the binding lives on the registration, so every instance observes the
   * same session -> prompt mapping.
   */
  const bindMaterializedToChild = (
    childSessionID: string,
    parentSessionID: string | undefined,
    agent: string,
  ): string | undefined => {
    for (const registration of relays.values()) {
      if (registration.childSessionID === childSessionID) return registration.materialized;
    }
    for (const registration of relays.values()) {
      if (registration.subagentType !== agent) continue;
      if (registration.childSessionID !== undefined) continue;
      if (registration.materialized === undefined) continue;
      if (parentSessionID !== undefined && registration.parentSessionID !== parentSessionID) continue;
      registration.childSessionID = childSessionID;
      return registration.materialized;
    }
    return undefined;
  };

  return {
    dispose: async () => {
      reviewSessions.clear();
      materializedBySession.clear();
      deferred.clear();
      refused.clear();
      for (const [key, registration] of [...relays]) {
        if (registration.owner === owner) clearOwned(key);
      }
    },
    event: async ({ event }) => {
      if (event.type === "session.created") {
        const info = (event.properties as { info?: unknown } | undefined)?.info;
        const decoded = decodeReviewSession(info);
        const parentID =
          info !== null && typeof info === "object" && !Array.isArray(info)
            ? Reflect.get(info, "parentID")
            : undefined;
        const parentSessionID = typeof parentID === "string" ? parentID : undefined;
        console.warn(
          `[reviewer-relay] event: session.created child=${shortSessionID(decoded?.id)}` +
            ` relayAgent=${decoded?.agent ?? "<none-decoded>"}` +
            ` parentPresent=${parentSessionID !== undefined}` +
            ` parentLength=${parentSessionID?.length ?? 0}`,
        );
        if (decoded === undefined) return;
        reviewSessions.add(decoded.id);
        const materialized = bindMaterializedToChild(decoded.id, parentSessionID, decoded.agent);
        if (materialized !== undefined) materializedBySession.set(decoded.id, materialized);
        return;
      }
      if (event.type !== "session.deleted") return;
      const deleted = (event.properties as { info?: { id?: unknown } } | undefined)?.info?.id;
      if (typeof deleted !== "string") return;
      reviewSessions.delete(deleted);
      materializedBySession.delete(deleted);
      clearSession(`${deleted}:`);
    },
    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = typeof input.sessionID === "string" ? input.sessionID : undefined;
      const tracked = sessionID !== undefined && reviewSessions.has(sessionID);
      const materialized = sessionID === undefined ? undefined : materializedBySession.get(sessionID);
      let replaced = false;
      if (tracked) {
        // The provider materializes the reviewer payload as the Task (user)
        // message, and `experimental.chat.messages.transform` below delivers it
        // as the child's last user message. The system slot therefore keeps only
        // the small transport boundary: a multi-hundred-KB system message sits
        // outside the provider's user-message contract and is plausibly
        // truncated or discounted. OpenCode restores its fallback system prompt
        // for an empty array, so replace in place with one nonempty entry.
        output.system.splice(0, output.system.length, TRANSPORT_ISOLATION_SYSTEM);
        replaced = true;
      }
      console.warn(
        `[reviewer-relay] experimental.chat.system.transform: session=${shortSessionID(sessionID)}` +
          ` tracked=${tracked}` +
          ` materializedBound=${materialized !== undefined}` +
          ` systemReplaced=${replaced}`,
      );
    },
    "experimental.chat.messages.transform": async (input, output) => {
      const messages = Array.isArray(output.messages) ? output.messages : [];
      let target: ChatMessageEntry | undefined;
      let sessionID = typeof input.sessionID === "string" ? input.sessionID : undefined;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const entry = messages[index];
        if (entry === null || typeof entry !== "object") continue;
        const info = entry.info;
        if (info === null || typeof info !== "object") continue;
        if (Reflect.get(info, "role") !== "user") continue;
        target = entry;
        if (sessionID === undefined) {
          const candidate = Reflect.get(info, "sessionID");
          if (typeof candidate === "string") sessionID = candidate;
        }
        break;
      }
      const materialized = sessionID === undefined ? undefined : materializedBySession.get(sessionID);
      let textPartCount = 0;
      let messageReplaced = false;
      if (target !== undefined && materialized !== undefined) {
        const parts = Array.isArray(target.parts) ? target.parts : [];
        for (const part of parts) {
          if (part === null || typeof part !== "object") continue;
          if (Reflect.get(part, "type") !== "text") continue;
          // Keep exactly one text part: the first carries the materialized
          // prompt and any additional text parts are blanked so the message
          // content is the provider payload, mirroring the installed
          // transport's task-prompt replacement.
          if (textPartCount === 0) {
            part.text = materialized;
            messageReplaced = true;
          } else {
            part.text = "";
          }
          textPartCount += 1;
        }
      }
      console.warn(
        `[reviewer-relay] experimental.chat.messages.transform: session=${shortSessionID(sessionID)}` +
          ` materializedBound=${materialized !== undefined}` +
          ` userMessageFound=${target !== undefined}` +
          ` textPartCount=${textPartCount}` +
          ` messageReplaced=${messageReplaced}` +
          (materialized !== undefined ? ` promptLength=${materialized.length}` : ""),
      );
    },
    "tool.execute.before": async (input, output) => {
      console.warn(`[reviewer-relay] tool.execute.before: tool=${input.tool}`);
      if (input.tool !== "task") return;
      const subagentType = output.args?.subagent_type;
      const relayAgent = isRelayAgent(subagentType);
      const observed = typeof subagentType === "string" ? subagentType : "<missing>";
      console.warn(
        `[reviewer-relay] tool.execute.before: subagent_type=${observed} relayAgent=${relayAgent}`,
      );
      if (!relayAgent) return;
      if (typeof output.args?.prompt !== "string") {
        return toolRefusalResult(
          taskRefused("review task prompt is unavailable for provider materialization"),
        );
      }
      const key = taskKey(input.sessionID, input.callID, subagentType);
      const existing = relays.get(key);
      if (existing) {
        // Another instance already owns this Task's relay: defer the
        // completion to that owner and pass this instance's hooks through
        // untouched. A re-fired before hook for a registration this instance
        // already owns keeps the live registration and defers nothing.
        if (existing.owner !== owner) deferred.set(key, existing);
        return;
      }
      if (relays.size >= MAX_CONCURRENT_RELAYS) {
        const refusal = concurrencyRefused(
          `the concurrent review relay cap (${MAX_CONCURRENT_RELAYS}) is already reached`,
        );
        refuseTaskBoundary(output, key, refusal);
        return toolRefusalResult(refusal);
      }
      const bindingPrompt = output.args.prompt;
      let root: string;
      try {
        root = await resolveSessionRoot(input.sessionID);
      } catch (cause) {
        // A returned tool error is surfaced verbatim; a throw collapses into
        // a generic abort and silently loses the typed refusal.
        const refusal = refusalOr(cause, rootRefused);
        refuseTaskBoundary(output, key, refusal);
        return toolRefusalResult(refusal);
      }
      let relay: Relay;
      try {
        relay = startRelayFor(root, bindingPrompt);
      } catch (cause) {
        const refusal = refusalOr(cause, spawnFailed);
        refuseTaskBoundary(output, key, refusal);
        return toolRefusalResult(refusal);
      }
      const registration: RelayRegistration = {
        owner,
        relay,
        completing: false,
        parentSessionID: input.sessionID,
        subagentType,
      };
      relays.set(key, registration);
      try {
        const materialized = (await relay.prompt).prompt;
        const blockStart = materializedContextStart(materialized);
        console.warn(
          `[reviewer-relay] tool.execute.before: materialized prompt length=${materialized.length}` +
            ` blockFound=${blockStart >= 0}` +
            (blockStart >= 0 ? ` blockStart=${blockStart}` : ""),
        );
        registration.materialized = materialized;
        output.args.prompt = materialized;
      } catch (cause) {
        clearOwned(key);
        const refusal = refusalOr(cause, frameRefused);
        refuseTaskBoundary(output, key, refusal);
        return toolRefusalResult(refusal);
      }
    },
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "task") return;
      // The verified host carries the Task arguments on the after-hook INPUT;
      // fall back to the mirrored output args so a host shape change can never
      // silently pass raw reviewer prose through as a completion.
      const subagentType = input.args?.subagent_type ?? output.args?.subagent_type;
      if (!isRelayAgent(subagentType)) return;
      const key = taskKey(input.sessionID, input.callID, subagentType);
      const refusal = refused.get(key);
      if (refusal !== undefined) {
        refused.delete(key);
        output.output = refusalOutput(refusal);
        return toolRefusalResult(taskRefused(refusalOutput(refusal)));
      }
      // Owner-scoped dedup tolerance: a deferred key whose owner is still live
      // or has delivered its own completion passes through untouched; a
      // deferred key whose owner vanished falls through to the loud orphan
      // refusal below instead of returning raw reviewer output as success.
      const deferredTo = deferred.get(key);
      if (deferredTo !== undefined) {
        deferred.delete(key);
        if (relays.get(key) === deferredTo || deferredTo.completing) return;
      }
      const registration = relays.get(key);
      if (!registration) {
        return refuseCompletion(
          output,
          taskRefused("review Task relay completion has no matching live before hook"),
        );
      }
      if (registration.owner !== owner) {
        return refuseCompletion(
          output,
          taskRefused("review Task relay completion is owned by another plugin instance"),
        );
      }
      if (registration.completing) {
        return refuseCompletion(
          output,
          duplicateCompletion("review Task relay completion is already in flight for this task"),
        );
      }
      registration.completing = true;
      try {
        const rawOutput = output.output;
        const extracted = reviewerOutputText(rawOutput);
        console.warn(
          `[reviewer-relay] tool.execute.after: output.output typeof=${typeof rawOutput}` +
            (typeof rawOutput === "string" ? ` length=${rawOutput.length}` : "") +
            (rawOutput !== null && typeof rawOutput === "object"
              ? ` keys=[${Object.keys(rawOutput).sort().join(",")}]`
              : "") +
            ` extracted typeof=${typeof extracted}` +
            (typeof extracted === "string" ? ` length=${extracted.length}` : ""),
        );
        output.output = await registration.relay.complete(reviewerOutputText(output.output));
      } finally {
        if (relays.get(key) === registration) relays.delete(key);
        registration.relay.close();
      }
    },
  };
}
