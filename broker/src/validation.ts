/**
 * Broker-side input validation — the front line against §28 argument attacks.
 *
 * Rules enforced here:
 * - allowlist regexes for session/project IDs (never free-form strings);
 * - canonical-path checks (realpath) with symlink-escape rejection (S6, §30);
 * - NUL / control-character rejection everywhere;
 * - size caps on every field;
 * - argv must be an ARRAY of plain strings (never a shell string);
 * - exact-key allowlist on payloads: worker policy fields (image, mounts,
 *   privileged, devices, network, security profile, ...) are REJECTED (§7);
 * - shell metacharacters rejected in argv (defence-in-depth: we spawn without
 *   a shell, but no payload may be safe to pipe through one either).
 */
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";
import { FORBIDDEN_WORKER_FIELDS, type BrokerResponseEnvelope, OPERATIONS } from "./types.ts";

export class ValidationError extends Error {
  readonly code = "validation" as const;
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

// ---------------------------------------------------------------------------
// Identifiers (allowlists only — §30)
// ---------------------------------------------------------------------------

/** OpenCode session IDs seen on this host are short base62-ish strings. */
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Project IDs: lowercase start, then word chars/dot/dash/underscore. */
export const PROJECT_ID_RE = /^[a-z][a-z0-9._-]{0,63}$/;
/** Agent names: conservative charset, length-capped. */
export const AGENT_NAME_RE = /^[A-Za-z0-9_.-]{0,128}$/;
export const REQUEST_ID_RE = /^[A-Za-z0-9-]{1,128}$/;

export function assertSessionID(id: unknown): asserts id is string {
  if (typeof id !== "string" || !SESSION_ID_RE.test(id)) {
    throw new ValidationError(
      `invalid sessionID: must match ${SESSION_ID_RE}, got ${JSON.stringify(id)}`,
    );
  }
}

export function assertProjectID(id: unknown): asserts id is string {
  if (typeof id !== "string" || !PROJECT_ID_RE.test(id)) {
    throw new ValidationError(
      `invalid projectID: must match ${PROJECT_ID_RE}, got ${JSON.stringify(id)}`,
    );
  }
}

export function assertAgentName(agent: unknown): void {
  if (agent === undefined || agent === null) return;
  if (typeof agent !== "string" || !AGENT_NAME_RE.test(agent) || agent.length > 128) {
    throw new ValidationError("invalid agent name (logging field only)");
  }
}

export function assertRequestID(id: unknown): asserts id is string {
  if (typeof id !== "string" || !REQUEST_ID_RE.test(id)) {
    throw new ValidationError("invalid request id");
  }
}

/** Session ID must also be safe as a git ref component and directory name. */
export function assertRefComponent(id: string): void {
  assertSessionID(id);
  if (
    id.includes("..") ||
    id.startsWith(".") ||
    id.endsWith(".") ||
    id.startsWith("-") ||
    id.includes("@{") ||
    id.includes("/")
  ) {
    throw new ValidationError("sessionID not safe as a git ref component");
  }
}

// ---------------------------------------------------------------------------
// Strings, sizes, control characters
// ---------------------------------------------------------------------------

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function assertNoControlChars(value: string, what: string): void {
  if (CONTROL_CHARS.test(value)) {
    throw new ValidationError(`${what} contains control characters or NUL`);
  }
}

export function assertMaxBytes(value: string, max: number, what: string): void {
  if (Buffer.byteLength(value, "utf8") > max) {
    throw new ValidationError(`${what} exceeds ${max} bytes`);
  }
}

// ---------------------------------------------------------------------------
// Shell metacharacter rejection (argv, query, service/container names)
// ---------------------------------------------------------------------------

/**
 * Conservative rejection set. We spawn directly with argv vectors (no shell),
 * so these characters are rejected only where they could become dangerous if
 * a value were ever spliced into a shell — defence in depth (spec §28, §30).
 * Regular-expression metacharacters ( ) [ ] * ? { } are ALLOWED: they are
 * harmless in argv positions and required for grep patterns.
 */
export const SHELL_METACHARS = /[;&|<>$`'"\\\n\r]/;

export function assertNoShellMetachars(value: string, what: string): void {
  if (SHELL_METACHARS.test(value)) {
    throw new ValidationError(`${what} contains shell metacharacters`);
  }
}

// ---------------------------------------------------------------------------
// argv (exec payload)
// ---------------------------------------------------------------------------

export interface ArgvLimits {
  itemMaxBytes: number;
  maxItems: number;
  totalMaxBytes: number;
}

export function assertArgv(argv: unknown, limits: ArgvLimits): asserts argv is string[] {
  if (!Array.isArray(argv)) {
    throw new ValidationError("argv must be an array of strings (never a shell string)");
  }
  if (argv.length === 0) {
    throw new ValidationError("argv must not be empty");
  }
  if (argv.length > limits.maxItems) {
    throw new ValidationError(`argv exceeds ${limits.maxItems} items`);
  }
  let total = 0;
  for (const item of argv) {
    if (typeof item !== "string") {
      throw new ValidationError("argv items must be strings");
    }
    assertMaxBytes(item, limits.itemMaxBytes, "argv item");
    assertNoControlChars(item, "argv item");
    assertNoShellMetachars(item, "argv item");
    total += Buffer.byteLength(item, "utf8");
    if (total > limits.totalMaxBytes) {
      throw new ValidationError(`argv exceeds ${limits.totalMaxBytes} bytes total`);
    }
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Validate a path that is interpreted INSIDE the worker sandbox.
 * Relative only; no traversal; no absolute escapes; no symlink tricks the
 * broker can check from the host (the worker itself is isolated).
 */
export function assertSandboxPath(path: unknown, maxBytes = 4096): asserts path is string {
  if (typeof path !== "string" || path.length === 0) {
    throw new ValidationError("path must be a non-empty string");
  }
  assertMaxBytes(path, maxBytes, "path");
  assertNoControlChars(path, "path");
  if (path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:[\\/]/.test(path)) {
    throw new ValidationError("path must be relative to the sandbox project root");
  }
  if (path.includes("\\")) {
    throw new ValidationError("path contains a backslash");
  }
  const normalized = normalize(path);
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) {
    throw new ValidationError("path escapes the sandbox project root (..)");
  }
}

/** Length + charset guard for `since` values passed to journalctl. */
export function assertSince(since: unknown): asserts since is string | undefined {
  if (since === undefined || since === null) return;
  if (typeof since !== "string" || !/^[0-9A-Za-z :.+-]{1,64}$/.test(since)) {
    throw new ValidationError("invalid 'since' value");
  }
}

export function assertPositiveInt(value: unknown, max: number, what: string): void {
  if (value === undefined || value === null) return;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > max
  ) {
    throw new ValidationError(`${what} must be an integer in [1, ${max}]`);
  }
}

export function assertServiceOrContainerName(value: unknown, what: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:@-]{1,128}$/.test(value)) {
    throw new ValidationError(`invalid ${what} name`);
  }
  if (value.startsWith("-")) {
    throw new ValidationError(`${what} name must not start with '-'`);
  }
  assertNoShellMetachars(value, what);
}

export function assertProcessFilter(filter: unknown): asserts filter is string | undefined {
  if (filter === undefined || filter === null) return;
  if (typeof filter !== "string") {
    throw new ValidationError("filter must be a string");
  }
  assertMaxBytes(filter, 256, "filter");
  assertNoControlChars(filter, "filter");
  if (filter.includes("/")) {
    throw new ValidationError("filter must not contain '/'");
  }
}

export function assertGrepQuery(query: unknown, maxBytes: number): asserts query is string {
  if (typeof query !== "string" || query.length === 0) {
    throw new ValidationError("query must be a non-empty string");
  }
  assertMaxBytes(query, maxBytes, "query");
  assertNoControlChars(query, "query");
  if (SHELL_METACHARS.test(query)) {
    throw new ValidationError("query contains shell metacharacters");
  }
}

export function assertContent(content: unknown, maxBytes: number): asserts content is string {
  if (typeof content !== "string") {
    throw new ValidationError("content must be a string");
  }
  assertMaxBytes(content, maxBytes, "content");
}

// ---------------------------------------------------------------------------
// Payload key allowlists (§7: reject resource-request fields)
// ---------------------------------------------------------------------------

export const ALLOWED_PAYLOAD_KEYS: Record<string, readonly string[]> = {
  ensureWorker: ["projectDir"],
  exec: ["argv", "cwd", "timeoutMs", "env"],
  readFile: ["path"],
  writeFile: ["path", "content"],
  applyPatch: ["patch"],
  listDir: ["path"],
  grep: ["query", "path"],
  diff: ["mode"],
  applyResult: ["confirm"],
  discardResult: ["confirm"],
  destroyWorker: [],
  listWorkers: [],
  metrics: [],
  prepareResult: [],
  workerStatus: [],
  sddStatus: ["projectDir"],
  sddAttemptAcquire: [
    "projectDir",
    "change",
    "requestId",
    "workUnit",
    "evidenceGoal",
    "maxAttempts",
    "maxChangedLines",
  ],
  hostSystemSummary: [],
  hostMemory: [],
  hostNetworkListeners: [],
  hostTailscaleStatus: [],
  hostDockerList: [],
  hostDiskUsage: ["path"],
  hostProcessList: ["filter"],
  hostServiceStatus: ["service"],
  hostServiceLogs: ["service", "lines", "since"],
  hostDockerLogs: ["container", "lines"],
  copyOutInfo: ["workerPath", "hostTarget"],
  copyOut: ["workerPath", "hostTarget", "confirm"],
  copyInInfo: ["hostSource", "workerPath"],
  copyIn: ["hostSource", "workerPath", "confirm"],
  policy: [],
  registerProject: ["path", "dryRun", "createRemote", "makePublic"],
};

export function assertPayloadKeys(operation: string, payload: unknown): void {
  if (payload === undefined || payload === null) return;
  if (typeof payload !== "object" || Array.isArray(payload)) {
    throw new ValidationError("payload must be a JSON object");
  }
  const allowed = ALLOWED_PAYLOAD_KEYS[operation];
  if (!allowed) {
    throw new ValidationError(`unknown operation: ${operation}`);
  }
  for (const key of Object.keys(payload as Record<string, unknown>)) {
    if (!allowed.includes(key)) {
      const isForbidden = (FORBIDDEN_WORKER_FIELDS as readonly string[]).includes(key);
      throw new ValidationError(
        isForbidden
          ? `field '${key}' is broker-side policy and cannot be supplied by a request (§7)`
          : `unexpected field '${key}' in ${operation} payload`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Host read path canonicalization (S6): approved roots + symlink escape
// ---------------------------------------------------------------------------

/** Canonicalize an absolute host path and verify it stays inside an approved root. */
export function canonicalizeWithinRoots(
  path: unknown,
  approvedRoots: readonly string[],
  maxBytes = 4096,
): string {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) {
    throw new ValidationError("host read path must be an absolute path");
  }
  assertMaxBytes(path, maxBytes, "path");
  assertNoControlChars(path, "path");
  if (path.includes("\u0000")) {
    throw new ValidationError("path contains NUL");
  }
  const canonicalRoots = approvedRoots.map((root) => {
    try {
      return realpathSync(root);
    } catch {
      throw new ValidationError(`approved read root does not exist: ${root}`);
    }
  });
  if (canonicalRoots.length === 0) {
    throw new ValidationError("no approved external read roots configured (S6)");
  }
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch {
    throw new ValidationError("path does not resolve to a real file on the host");
  }
  for (const root of canonicalRoots) {
    if (canonical === root || canonical.startsWith(root + sep)) {
      return canonical;
    }
  }
  throw new ValidationError(`path escapes approved read roots (S6): ${canonical}`);
}

/** Validate an absolute host FILE target against an exact allowlist. */
export function assertExternalCopyTarget(target: unknown, allowlist: readonly string[]): string {
  if (typeof target !== "string" || target.length === 0 || !isAbsolute(target)) {
    throw new ValidationError("copy target must be an absolute path");
  }
  assertMaxBytes(target, 4096, "target");
  assertNoControlChars(target, "target");
  const canonicalTarget = (() => {
    try {
      return join(realpathSync(dirname(target)), basename(target));
    } catch {
      throw new ValidationError("copy target parent does not resolve: " + target);
    }
  })();
  const canonicalAllowlist = allowlist.map((entry) => {
    try {
      return join(realpathSync(dirname(entry)), basename(entry));
    } catch {
      throw new ValidationError("copy allowlist entry does not resolve: " + entry);
    }
  });
  if (!canonicalAllowlist.includes(canonicalTarget)) {
    throw new ValidationError("copy target is not in the external copy allowlist (S15)");
  }
  return canonicalTarget;
}

/** Divergence-only helper used by gitops: is `child` inside `parent`? */
export function isWithin(parent: string, child: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** Resolve the allowed project for a directory the agent claims to work in. */
export function resolveProjectID(
  projectDir: unknown,
  projects: readonly { id: string; path: string }[],
): string {
  if (typeof projectDir !== "string" || projectDir.length === 0) {
    throw new ValidationError("projectDir must be a non-empty absolute path");
  }
  assertMaxBytes(projectDir, 4096, "projectDir");
  if (!isAbsolute(projectDir)) {
    throw new ValidationError("projectDir must be absolute");
  }
  let canonical: string;
  try {
    canonical = realpathSync(projectDir);
  } catch {
    throw new ValidationError("projectDir does not resolve on the host");
  }
  for (const project of projects) {
    const root = realpathSync(project.path);
    if (isWithin(root, canonical)) {
      return project.id;
    }
  }
  throw new ValidationError(`directory is not an approved project root: ${projectDir}`);
}

// ---------------------------------------------------------------------------
// Envelope / protocol validation (server.ts)
// ---------------------------------------------------------------------------

export function validateEnvelope(raw: unknown): {
  version: 1;
  id: string;
  operation: string;
  sessionID: string;
  agent?: string;
  payload?: unknown;
} {
  if (typeof raw !== "object" || raw === null) {
    throw new ValidationError("request must be a JSON object");
  }
  const req = raw as Record<string, unknown>;
  if (req.version !== 1) {
    throw new ValidationError("unsupported protocol version");
  }
  assertRequestID(req.id);
  if (typeof req.operation !== "string" || !OPERATIONS.includes(req.operation as never)) {
    throw new ValidationError(`unknown operation: ${String(req.operation)}`);
  }
  assertSessionID(req.sessionID);
  assertAgentName(req.agent);
  assertPayloadKeys(req.operation, req.payload);
  return {
    version: 1,
    id: req.id as string,
    operation: req.operation,
    sessionID: req.sessionID as string,
    agent: req.agent as string | undefined,
    payload: req.payload,
  };
}

/** True when the response is an error (used by tests + client). */
export function isErrorResponse(resp: BrokerResponseEnvelope): boolean {
  return !resp.ok;
}
