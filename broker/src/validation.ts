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
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
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
// Host tool (SDD runtime / review) canonical validators
// ---------------------------------------------------------------------------

/** Max bytes for a host-tool path argument. */
export const MAX_HOST_PATH_BYTES = 4096;
/** Inclusive upper bound for `--requirements` / `--scenarios` counts. */
export const MAX_HOST_TOOL_COUNT = 100_000;

/** SDD identifiers (change, work unit, evidence goal, phase): conservative charset. */
export const SDD_IDENTIFIER_RE = /^[A-Za-z0-9._-]{1,128}$/;
/** Allowlisted `sdd-status` contracts (fail closed on anything else). */
export const SDD_STATUS_CONTRACTS: readonly string[] = ["gentle-ai.sdd-status/v2"];
/** Lowercase sha256 hex digest for `--evidence-revision`. */
export const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
/** Lowercase runtime identifier for `review status --agent`. */
export const REVIEW_RUNTIME_AGENT_RE = /^[a-z0-9_-]{1,64}$/;
/** Upper bound for `sdd-attempt acquire --intended-untracked` entries. */
export const MAX_INTENDED_UNTRACKED = 256;
/** Opaque acquire token: URL-safe, no shell metacharacters, never flag-like. */
export const SDD_TOKEN_RE = /^[A-Za-z0-9._:+/=-]{1,512}$/;

export function assertSddIdentifier(value: unknown, what: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !SDD_IDENTIFIER_RE.test(value) ||
    value.includes("..") ||
    value.startsWith("-")
  ) {
    throw new ValidationError(`invalid ${what}`);
  }
  assertNoControlChars(value, what);
  assertNoShellMetachars(value, what);
}

/** Allowlisted `sdd-status --contract` value. */
export function assertSddContract(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !(SDD_STATUS_CONTRACTS as readonly string[]).includes(value)
  ) {
    throw new ValidationError(`unsupported SDD status contract: ${JSON.stringify(value)}`);
  }
}

export function assertSddOutcome(
  value: unknown,
): asserts value is "passed" | "failed" | "interrupted" {
  if (value !== "passed" && value !== "failed" && value !== "interrupted") {
    throw new ValidationError("outcome must be passed, failed, or interrupted");
  }
}

export function assertHarnessDisposition(
  value: unknown,
): asserts value is "reused" | "invalidated" {
  if (value !== "reused" && value !== "invalidated") {
    throw new ValidationError("harnessDisposition must be reused or invalidated");
  }
}

/** Lowercase runtime identifier for `review status --agent` (default applied by the builder). */
export function assertReviewRuntimeAgent(value: unknown): asserts value is string {
  if (typeof value !== "string" || !REVIEW_RUNTIME_AGENT_RE.test(value)) {
    throw new ValidationError("agent must match ^[a-z0-9_-]{1,64}$");
  }
}

/** Attempt-acquire untracked scope; only the two contract values are accepted. */
export function assertUntrackedScope(value: unknown): asserts value is "exclude" | "select" {
  if (value !== "exclude" && value !== "select") {
    throw new ValidationError("untrackedScope must be exclude or select");
  }
}

/** `expectedUntrackedInventory`: `sha256:` + 64 lowercase hex characters. */
export function assertExpectedUntrackedInventory(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.startsWith("sha256:") ||
    !SHA256_HEX_RE.test(value.slice("sha256:".length))
  ) {
    throw new ValidationError("expectedUntrackedInventory must be sha256:<64 lowercase hex>");
  }
}

/**
 * `intendedUntracked`: a bounded array of repo-relative paths, each validated
 * lexically (relative, no traversal, no control chars, at most 4096 bytes). The
 * argv builder resolves every entry beneath the canonical project root.
 */
export function assertIntendedUntracked(value: unknown): asserts value is string[] {
  if (!Array.isArray(value)) {
    throw new ValidationError("intendedUntracked must be an array of repo-relative paths");
  }
  if (value.length > MAX_INTENDED_UNTRACKED) {
    throw new ValidationError(`intendedUntracked exceeds ${MAX_INTENDED_UNTRACKED} entries`);
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry === "-") {
      throw new ValidationError("intendedUntracked entries must be repo-relative paths");
    }
    assertProjectRelativePath(entry, "intendedUntracked path");
  }
}

export function assertEvidenceRevision(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SHA256_HEX_RE.test(value)) {
    throw new ValidationError("evidenceRevision must be a lowercase sha256 hex digest");
  }
}

/** `expectedRevision`: `sha256:` plus exactly 64 lowercase hex characters. */
export function assertExpectedRevision(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.startsWith("sha256:") ||
    !SHA256_HEX_RE.test(value.slice("sha256:".length))
  ) {
    throw new ValidationError("expectedRevision must be sha256:<64 lowercase hex>");
  }
}

/** Ledger request ids: lowercase start, then lowercase alphanumerics or dashes. */
export const LOWERCASE_REQUEST_ID_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;

export function assertLowercaseRequestId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !LOWERCASE_REQUEST_ID_RE.test(value)) {
    throw new ValidationError("requestId must match ^[a-z0-9][a-z0-9-]{0,127}$");
  }
}

/** Allowlisted `sdd-attempt reset --objective-relation` value. */
export function assertObjectiveRelation(
  value: unknown,
): asserts value is "remediation" | "independent" {
  if (value !== "remediation" && value !== "independent") {
    throw new ValidationError("objectiveRelation must be remediation or independent");
  }
}

/** Upper bound for `sdd-attempt grant --root` entries. */
export const MAX_GRANT_ROOTS = 32;

/**
 * `sdd-attempt grant` roots: 1..32 unique canonical absolute paths, each at
 * most 4096 UTF-8 bytes. `resolve` equality rejects trailing slashes, `.`/`..`
 * segments, and doubled separators, so only canonical lexical forms pass.
 */
export function assertCanonicalRoots(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_GRANT_ROOTS) {
    throw new ValidationError(`roots must contain 1..${MAX_GRANT_ROOTS} canonical absolute paths`);
  }
  const seen = new Set<string>();
  for (const root of value) {
    if (typeof root !== "string" || root.length === 0 || !isAbsolute(root)) {
      throw new ValidationError("each root must be a canonical absolute path");
    }
    assertMaxBytes(root, MAX_HOST_PATH_BYTES, "root");
    assertNoControlChars(root, "root");
    if (root.startsWith("-") || resolve(root) !== root) {
      throw new ValidationError("each root must be a canonical absolute path");
    }
    if (seen.has(root)) {
      throw new ValidationError("roots must be unique");
    }
    seen.add(root);
  }
}

export function assertOpaqueToken(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SDD_TOKEN_RE.test(value) || value.startsWith("-")) {
    throw new ValidationError("invalid settle token");
  }
  assertNoControlChars(value, "token");
}

/**
 * Free-form evidence text passed as a `--flag <value>` argument. Never
 * shell-interpreted (argv spawn), but it must not look like another flag and
 * must stay bounded and control-character free.
 */
export function assertEvidenceText(value: unknown, what: string, maxBytes = 4096): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`${what} must be a non-empty string`);
  }
  assertMaxBytes(value, maxBytes, what);
  assertNoControlChars(value, what);
  if (value.startsWith("-")) {
    throw new ValidationError(`${what} must not start with '-'`);
  }
}

/** Non-negative bounded integer for requirement/scenario counts. */
export function assertCount(value: unknown, max: number, what: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    throw new ValidationError(`${what} must be an integer in [0, ${max}]`);
  }
}

/**
 * A project-relative host-tool path (or the literal `-` for stdin/stdout).
 * Lexical only: existence is not required because archive outputs are new
 * files. Absolute paths, `~`, drive letters, backslashes, and traversal are
 * rejected. Use {@link resolveProjectRelativePath} to bind it beneath a root.
 */
export function assertProjectRelativePath(
  value: unknown,
  what: string,
  maxBytes = MAX_HOST_PATH_BYTES,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`${what} must be a non-empty project-relative path`);
  }
  assertMaxBytes(value, maxBytes, what);
  assertNoControlChars(value, what);
  if (value === "-") return;
  if (value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new ValidationError(`${what} must be relative to the project root`);
  }
  if (value.includes("\\")) {
    throw new ValidationError(`${what} must not contain a backslash`);
  }
  const normalized = normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${sep}`) || isAbsolute(normalized)) {
    throw new ValidationError(`${what} escapes the project root`);
  }
}

/** Resolve a validated project-relative path beneath the canonical root. */
export function resolveProjectRelativePath(
  projectRoot: string,
  value: string,
  what: string,
): string {
  if (value === "-") return "-";
  const resolved = resolve(projectRoot, value);
  if (!isWithin(projectRoot, resolved)) {
    throw new ValidationError(`${what} escapes the approved project root`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Plan-document mutation validators (append-only, allowlisted destinations)
// ---------------------------------------------------------------------------

/** Allowlisted plan-document enum -> project-relative destination. */
export const PLAN_DOC_TARGETS: Readonly<Record<"todo" | "plan", string>> = {
  todo: "docs/TODO.md",
  plan: "docs/PLAN.md",
};

/** Maximum trimmed UTF-8 bytes for one appended plan-document block. */
export const PLAN_DOC_CONTENT_MAX_BYTES = 16 * 1024;
/** Maximum UTF-8 bytes for an optional plan-document heading selector. */
export const PLAN_DOC_HEADING_MAX_BYTES = 256;

/** Controls other than LF (`\u000a`) are rejected in plan-document content. */
const PLAN_DOC_CONTENT_CONTROL_RE = /[\u0000-\u0009\u000b-\u001f\u007f]/;

/**
 * `doc` is an enum only: every other value — including absolute paths,
 * traversal, and arbitrary repository paths — is rejected.
 */
export function assertPlanDocName(value: unknown): asserts value is "todo" | "plan" {
  if (value !== "todo" && value !== "plan") {
    throw new ValidationError("doc must be one of: todo, plan");
  }
}

/**
 * Validate and normalize appended content: no control character other than LF
 * in the original input, then a non-empty block of at most 16 KiB after
 * trimming leading and trailing whitespace.
 */
export function normalizePlanDocContent(value: unknown): string {
  if (typeof value !== "string") {
    throw new ValidationError("content must be a string");
  }
  if (PLAN_DOC_CONTENT_CONTROL_RE.test(value)) {
    throw new ValidationError("content contains a control character other than LF");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ValidationError("content must be a non-empty block after trimming");
  }
  assertMaxBytes(trimmed, PLAN_DOC_CONTENT_MAX_BYTES, "content");
  return trimmed;
}

/** Optional heading selector: bounded, control-free, and never a marker line. */
export function assertPlanDocHeading(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError("heading must be a non-empty string");
  }
  assertMaxBytes(value, PLAN_DOC_HEADING_MAX_BYTES, "heading");
  assertNoControlChars(value, "heading");
  if (value.startsWith("#")) {
    throw new ValidationError("heading must be the heading text without '#' markers");
  }
}

// ---------------------------------------------------------------------------
// Project-registration validators (`host_register_project`)
// ---------------------------------------------------------------------------

/** Maximum UTF-8 bytes for a registration target path. */
export const REGISTER_PROJECT_PATH_MAX_BYTES = 4096;

/** System roots a registration target must never be or sit beneath. */
export const REGISTER_PROJECT_BANNED_SYSTEM_ROOTS: readonly string[] = [
  "/etc",
  "/usr",
  "/var",
  "/tmp",
];

/** Per-user credential roots (joined under `$HOME`) that are never registrable. */
export const REGISTER_PROJECT_BANNED_HOME_DIRS: readonly string[] = [
  ".ssh",
  ".config",
  ".local",
  ".cache",
  ".gnupg",
  ".aws",
  ".kube",
];

/**
 * Shell-active bytes a registration target must never contain: the accepted
 * canonical path is written into `scripts/secure-launcher.conf` as
 * `  "${path}"` — a double-quoted assignment in a file BOTH launchers source —
 * so `$`, backticks, `\`, `"`, and `!` would be evaluated by the shell
 * (expansion, command substitution, escaping, history) at launcher start.
 */
export const REGISTER_PROJECT_SHELL_UNSAFE_RE = /[$`\\"!]/;

/** Refuse the filesystem root, `$HOME` itself, and every banned root. */
function assertRegistrationRootAllowed(value: string, home: string): void {
  if (value === "/" || (home.length > 0 && value === home)) {
    throw new ValidationError("refusing to register the filesystem root or $HOME itself");
  }
  const banned = [...REGISTER_PROJECT_BANNED_SYSTEM_ROOTS];
  if (home.length > 0) {
    for (const dir of REGISTER_PROJECT_BANNED_HOME_DIRS) banned.push(join(home, dir));
  }
  for (const root of banned) {
    if (isWithin(root, value)) {
      throw new ValidationError(`refusing to register a path under ${root}`);
    }
  }
}

/**
 * `host_register_project` target: an existing absolute directory that is
 * neither the filesystem root, `$HOME`, nor beneath a credential or system
 * root. Every rejection happens BEFORE the registration script can spawn.
 *
 * The lexical value is checked as defence in depth, then the path is resolved
 * with `realpathSync` and the same bans plus the directory check run again on
 * the canonical target, so a symlink alias cannot smuggle a banned directory
 * past the lexical check. The canonical path is returned because that is the
 * value the registration script must receive and append to the sourced
 * launcher conf — never the caller's lexical alias.
 */
export function assertRegisterableProjectPath(
  value: unknown,
  home: string = process.env.HOME ?? "",
): string {
  if (typeof value !== "string" || value.length === 0 || !isAbsolute(value)) {
    throw new ValidationError("path must be an absolute string");
  }
  assertMaxBytes(value, REGISTER_PROJECT_PATH_MAX_BYTES, "path");
  assertNoControlChars(value, "path");
  assertRegistrationRootAllowed(value, home);
  let canonical: string;
  try {
    canonical = realpathSync(value);
  } catch {
    throw new ValidationError("path does not exist on the host");
  }
  // Only a canonical absolute path may be forwarded into the sourced conf.
  if (!isAbsolute(canonical) || resolve(canonical) !== canonical) {
    throw new ValidationError("path must resolve to a canonical absolute path");
  }
  assertRegistrationRootAllowed(canonical, home);
  if (REGISTER_PROJECT_SHELL_UNSAFE_RE.test(canonical)) {
    throw new ValidationError("path must not contain shell-active characters");
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(canonical).isDirectory();
  } catch {
    throw new ValidationError("path does not exist on the host");
  }
  if (!isDirectory) {
    throw new ValidationError("path is not a directory");
  }
  return canonical;
}

// ---------------------------------------------------------------------------
// Host git/GH tool canonical validators (fixed argv, §31)
// ---------------------------------------------------------------------------

/** One `-m` commit message: 1..4096 bytes, never flag-like, no control chars. */
export const GIT_COMMIT_MESSAGE_MAX_BYTES = 4096;
/** `gh` value caps: repository slug, title, and body bytes. */
export const GH_REPO_MAX_BYTES = 256;
export const GH_TITLE_MAX_BYTES = 256;
export const GH_BODY_MAX_BYTES = 65536;
/** Allowlisted git remote short name (no refspec/flag/`..` syntax). */
export const GIT_REMOTE_RE = /^(?!.*\.\.)[A-Za-z0-9._][A-Za-z0-9._-]{0,254}$/;
/** Allowlisted git branch (no refspec/flag/`..` syntax). */
export const GIT_BRANCH_RE = /^(?!.*\.\.)[A-Za-z0-9._/][A-Za-z0-9._/-]{0,254}$/;
/** Allowlisted `owner/name` GitHub repository slug. */
export const GH_REPO_RE = /^(?!-)[A-Za-z0-9._-]{1,100}\/(?!-)[A-Za-z0-9._-]{1,100}$/;
/** Body control characters that remain rejected while tab/newline/CR are kept. */
const BODY_UNSAFE_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function assertGitCommitMessage(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError("message must be a non-empty string");
  }
  assertMaxBytes(value, GIT_COMMIT_MESSAGE_MAX_BYTES, "message");
  assertNoControlChars(value, "message");
  if (value.startsWith("-")) {
    throw new ValidationError("message must not start with '-'");
  }
}

/** Repo-relative paths committed verbatim: no flags, traversal, or git magic. */
export function assertGitPathList(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError("paths must be a non-empty array");
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new ValidationError("path entries must be non-empty strings");
    }
    assertMaxBytes(entry, MAX_HOST_PATH_BYTES, "path");
    assertNoControlChars(entry, "path");
    if (entry.startsWith("-")) {
      throw new ValidationError("path must not start with '-'");
    }
    if (entry.startsWith("/") || entry.startsWith("~") || /^[A-Za-z]:[\\/]/.test(entry)) {
      throw new ValidationError("path must be repo-relative");
    }
    if (entry.includes("\\") || entry.includes("..") || entry.includes(":(") || entry.includes(":!")) {
      throw new ValidationError("path contains unsafe traversal or git magic");
    }
  }
}

export function assertGitRemote(value: unknown): asserts value is string {
  if (typeof value !== "string" || !GIT_REMOTE_RE.test(value)) {
    throw new ValidationError("invalid git remote");
  }
}

export function assertGitBranch(value: unknown): asserts value is string {
  if (typeof value !== "string" || !GIT_BRANCH_RE.test(value)) {
    throw new ValidationError("invalid git branch");
  }
}

export function assertGhRepo(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError("repo must be a non-empty string");
  }
  assertMaxBytes(value, GH_REPO_MAX_BYTES, "repo");
  if (!GH_REPO_RE.test(value)) {
    throw new ValidationError("repo must be an owner/name slug");
  }
}

export function assertGhTitle(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError("title must be a non-empty string");
  }
  assertMaxBytes(value, GH_TITLE_MAX_BYTES, "title");
  assertNoControlChars(value, "title");
  if (value.startsWith("-")) {
    throw new ValidationError("title must not start with '-'");
  }
}

export function assertGhBody(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new ValidationError("body must be a string");
  }
  assertMaxBytes(value, GH_BODY_MAX_BYTES, "body");
  if (BODY_UNSAFE_CONTROL_RE.test(value)) {
    throw new ValidationError("body contains control characters or NUL");
  }
  if (value.startsWith("-")) {
    throw new ValidationError("body must not start with '-'");
  }
}

// ---------------------------------------------------------------------------
// Host tool authorization (per-tool read/mutation policy)
// ---------------------------------------------------------------------------

export type HostToolAccess = "read" | "mutation";

/** Read-only host tools: open to every agent, never prompt. */
export const HOST_READ_OPERATIONS: readonly string[] = [
  "sddStatus",
  "sddContinue",
  "sddTaskResult",
  "reviewAssess",
  "reviewModeStatus",
  "reviewStatus",
  "reviewLensContext",
];

/** Host mutations: `gentle-orchestrator` only, fragment `ask` + in-tool `ctx.ask`. */
export const HOST_MUTATION_OPERATIONS: readonly string[] = [
  "sddArchiveCompose",
  "gitCommit",
  "gitPush",
  "ghIssueCreate",
  "registerProject",
  "sddAttemptGrant",
  "planDocAppend",
  "reviewStart",
  "reviewCaptureResult",
  "reviewCaptureUnachievable",
  "reviewAcknowledgeApproved",
  "reviewCaptureCorrectionPlan",
  "reviewCaptureRefuter",
  "reviewCaptureValidation",
  "reviewValidate",
  "reviewRecover",
];

export function hostToolAccess(operation: unknown): HostToolAccess {
  if (typeof operation === "string") {
    if ((HOST_READ_OPERATIONS as readonly string[]).includes(operation)) return "read";
    if ((HOST_MUTATION_OPERATIONS as readonly string[]).includes(operation)) return "mutation";
  }
  throw new ValidationError(`unknown host tool operation: ${String(operation)}`);
}

export interface HostToolDecision {
  allowed: boolean;
  access: HostToolAccess;
  reasonCode: string;
}

/**
 * Broker-authoritative host-tool authorization. The orchestrator identities are
 * the trusted `readOnlyAgents` allowlist (config); the caller passes the
 * broker-derived trusted agent, never a raw envelope claim.
 */
export class HostToolPolicy {
  private readonly orchestratorAgents: readonly string[];

  constructor(orchestratorAgents: readonly string[]) {
    if (!Array.isArray(orchestratorAgents)) {
      throw new ValidationError("host tool policy requires an orchestrator agent allowlist");
    }
    this.orchestratorAgents = [...orchestratorAgents];
  }

  access(operation: unknown): HostToolAccess {
    return hostToolAccess(operation);
  }

  decide(operation: unknown, trustedAgent: string | undefined): HostToolDecision {
    const access = hostToolAccess(operation);
    if (access === "read") {
      return { allowed: true, access, reasonCode: "HOST_READ_OPEN" };
    }
    if (typeof trustedAgent === "string" && this.orchestratorAgents.includes(trustedAgent)) {
      return { allowed: true, access, reasonCode: "HOST_MUTATION_ORCHESTRATOR" };
    }
    return {
      allowed: false,
      access,
      reasonCode: trustedAgent ? "HOST_MUTATION_NOT_ORCHESTRATOR" : "HOST_MUTATION_UNKNOWN_AGENT",
    };
  }
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
  sddStatus: ["projectDir", "change", "contract"],
  sddContinue: ["projectDir", "change"],
  sddArchiveCompose: ["projectDir", "canonical", "delta", "output"],
  sddTaskResult: ["projectDir", "phase", "input"],
  reviewAssess: ["projectDir", "baseRef", "committedOnly"],
  reviewModeStatus: ["projectDir"],
  reviewStatus: [
    "projectDir",
    "agent",
    "lineage",
    "repositoryContext",
    "projection",
    "baseRef",
    "committedOnly",
    "intendedUntrackedSelection",
  ],
  reviewLensContext: [
    "projectDir",
    "repositoryContext",
    "lineage",
    "target",
    "expectedRevision",
    "lens",
  ],
  sddAttemptGrant: [
    "projectDir",
    "change",
    "expectedRevision",
    "roots",
    "changeInstance",
    "requestId",
    "actor",
    "reason",
  ],
  planDocAppend: ["projectDir", "doc", "content", "heading"],
  reviewStart: [
    "projectDir", "agent", "contract", "target", "projection", "focus",
    "untrackedScope", "expectedUntrackedInventory", "intendedUntracked",
    "baseRef", "committedOnly", "workspaceOverlay", "lineage", "consent",
    "locale", "policy", "trace",
  ],
  reviewCaptureResult: [
    "projectDir", "agent", "input", "inputJson", "lens", "order", "target", "lineage",
    "expectedRevision", "repositoryContext", "subjectHash", "materialize", "preflight",
  ],
  reviewCaptureUnachievable: [
    "projectDir", "target", "lineage", "expectedRevision", "repositoryContext",
    "requestHash", "reason", "detail", "withdraw",
  ],
  reviewAcknowledgeApproved: ["projectDir"],
  reviewCaptureCorrectionPlan: [
    "projectDir", "target", "lineage", "expectedRevision", "repositoryContext",
    "requestHash", "correctionLines",
  ],
  reviewCaptureRefuter: [
    "projectDir", "agent", "target", "lineage", "expectedRevision",
    "repositoryContext", "materialize", "execute",
  ],
  reviewCaptureValidation: [
    "projectDir", "agent", "target", "lineage", "expectedRevision",
    "repositoryContext", "requestHash", "materialize", "execute",
  ],
  reviewValidate: [
    "projectDir", "contract", "gate", "baseRef", "lineage", "policy",
    "prePrCiAttestation", "releaseConfiguration", "releaseEvidenceFreshness",
    "releaseGenerated", "releaseProvenance", "releasePublicationBoundary",
  ],
  reviewRecover: [
    "projectDir", "actor", "disposition", "expectedPredecessorRevision",
    "predecessorLineage", "successorLineage", "reason", "maintainerAuthorization",
    "baseRef", "committedOnly", "workspaceOverlay", "releaseScope", "projection",
    "untrackedScope", "expectedUntrackedInventory", "intendedUntracked", "focus", "policy",
  ],
  gitCommit: ["projectDir", "message", "sandboxSessionID"],
  gitPush: ["projectDir", "remote", "setUpstream", "allowProtectedBranch"],
  ghIssueCreate: ["projectDir", "repo", "title", "body"],
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
// ---------------------------------------------------------------------------
// Host review lifecycle validators (fixed argv, provider tokens verbatim)
// ---------------------------------------------------------------------------

/** Allowlisted `review start`/`review recover` projection. */
export function assertReviewProjection(value: unknown): asserts value is "workspace" | "staged" {
  if (value !== "workspace" && value !== "staged") {
    throw new ValidationError("projection must be workspace or staged");
  }
}


/** Allowlisted `review start` focus. */
export function assertReviewFocus(
  value: unknown,
): asserts value is "risk" | "resilience" | "readability" | "reliability" {
  if (
    value !== "risk" &&
    value !== "resilience" &&
    value !== "readability" &&
    value !== "reliability"
  ) {
    throw new ValidationError("focus must be risk, resilience, readability, or reliability");
  }
}

/** Allowlisted `review start` consent. */
export function assertReviewConsent(value: unknown): asserts value is "relay" | "granted" | "declined" {
  if (value !== "relay" && value !== "granted" && value !== "declined") {
    throw new ValidationError("consent must be relay, granted, or declined");
  }
}

/** Allowlisted `review start` locale. */
export function assertReviewLocale(value: unknown): asserts value is "en" | "es" {
  if (value !== "en" && value !== "es") {
    throw new ValidationError("locale must be en or es");
  }
}

/** Allowlisted `review validate` gate. */
export function assertReviewGate(
  value: unknown,
): asserts value is "post-apply" | "pre-commit" | "pre-push" | "pre-pr" | "release" {
  if (
    value !== "post-apply" &&
    value !== "pre-commit" &&
    value !== "pre-push" &&
    value !== "pre-pr" &&
    value !== "release"
  ) {
    throw new ValidationError("gate must be post-apply, pre-commit, pre-push, pre-pr, or release");
  }
}

/** Allowlisted `review recover` disposition. */
export function assertReviewDisposition(
  value: unknown,
): asserts value is "scope_changed" | "invalidated" | "escalated" {
  if (value !== "scope_changed" && value !== "invalidated" && value !== "escalated") {
    throw new ValidationError("disposition must be scope_changed, invalidated, or escalated");
  }
}

/** Maximum bytes for a provider-issued opaque review token. */
export const REVIEW_TOKEN_MAX_BYTES = 4096;
/** Maximum bytes for `reviewRecover.focus`. */
export const REVIEW_FOCUS_MAX_BYTES = 128;
/** Maximum bytes for a review base ref. */
export const REVIEW_BASE_REF_MAX_BYTES = 1024;
/** Maximum bytes for the schema-bound review intended-untracked selection JSON. */
export const REVIEW_INTENDED_UNTRACKED_SELECTION_MAX_BYTES = 65536;

/**
 * The provider's schema-bound `intended-untracked-selection` JSON value
 * (`gentle-ai.review-intended-untracked-selection/v1`), forwarded byte-for-byte.
 *
 * Fail closed: non-empty, valid JSON, within 65536 UTF-8 bytes, free of NUL and
 * control characters, and never flag-like. The JSON shape stays opaque; the
 * broker validates well-formedness and bounds only.
 */
export function assertIntendedUntrackedSelection(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError("intendedUntrackedSelection must be a non-empty string");
  }
  if (value.startsWith("-")) {
    throw new ValidationError("intendedUntrackedSelection must not start with '-'");
  }
  assertMaxBytes(
    value,
    REVIEW_INTENDED_UNTRACKED_SELECTION_MAX_BYTES,
    "intendedUntrackedSelection",
  );
  assertNoControlChars(value, "intendedUntrackedSelection");
  try {
    JSON.parse(value);
  } catch {
    throw new ValidationError("intendedUntrackedSelection must be valid JSON");
  }
}

/**
 * A provider-issued opaque token (target, lineage, lens, contract, policy,
 * trace, attestation, release values): preserved byte-for-byte, bounded, and
 * never flag-like.
 */
export function assertReviewToken(value: unknown, what: string, maxBytes = REVIEW_TOKEN_MAX_BYTES): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`${what} must be a non-empty string`);
  }
  assertMaxBytes(value, maxBytes, what);
  assertNoControlChars(value, what);
  if (value.startsWith("-")) {
    throw new ValidationError(`${what} must not start with '-'`);
  }
}

/**
 * A base ref: bounded, control-free, not flag-like, and free of traversal and
 * git revision magic (`..`, `@{`, `~`, `^`, `:`, `?`, `*`, `[`, `\`).
 */
export function assertReviewBaseRef(value: unknown): asserts value is string {
  assertReviewToken(value, "baseRef", REVIEW_BASE_REF_MAX_BYTES);
  if (value.includes("..") || value.includes("@{")) {
    throw new ValidationError("baseRef must not contain revision traversal");
  }
  if (/[~^:?*[\]\\]/.test(value)) {
    throw new ValidationError("baseRef must not contain git revision magic");
  }
}

/** `review capture-result --order`: integer 0..32. */
export function assertReviewOrder(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 32) {
    throw new ValidationError("order must be an integer in [0, 32]");
  }
}

/** `review capture-correction-plan --correction-lines`: positive 32-bit int. */
export function assertReviewCorrectionLines(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new ValidationError("correctionLines must be a positive 32-bit integer");
  }
}

/** Provider-issued `sha256:<64 lowercase hex>` token. */
export function assertReviewSha256(value: unknown, what: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.startsWith("sha256:") ||
    !SHA256_HEX_RE.test(value.slice("sha256:".length))
  ) {
    throw new ValidationError(`${what} must be sha256:<64 lowercase hex>`);
  }
}

/** Strict boolean flag: `undefined` is allowed, anything else must be boolean. */
export function assertOptionalBoolean(value: unknown, what: string): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "boolean") {
    throw new ValidationError(`${what} must be a boolean`);
  }
}

/** Maximum bytes for the `review recover` maintainer authorization JSON. */
export const MAINTAINER_AUTHORIZATION_MAX_BYTES = 65536;

/**
 * `review recover --maintainer-authorization`: valid JSON, 1..65536 UTF-8
 * bytes, LF-only line endings, no CR or NUL. Forwarded byte-for-byte.
 */
export function assertMaintainerAuthorization(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError("maintainerAuthorization must be a non-empty JSON string");
  }
  assertMaxBytes(value, MAINTAINER_AUTHORIZATION_MAX_BYTES, "maintainerAuthorization");
  if (value.includes("\r") || value.includes("\u0000")) {
    throw new ValidationError("maintainerAuthorization must not contain CR or NUL");
  }
  try {
    JSON.parse(value);
  } catch {
    throw new ValidationError("maintainerAuthorization must be valid JSON");
  }
}

/** `review` intendedUntracked: 1..256 unique project-relative paths. */
export function assertReviewIntendedUntracked(value: unknown): asserts value is string[] {
  assertIntendedUntracked(value);
  const seen = new Set<string>();
  for (const entry of value) {
    if (seen.has(entry)) {
      throw new ValidationError("intendedUntracked paths must be unique");
    }
    seen.add(entry);
  }
}

/** Allowlisted per-lens reviewer-step identifier (`review lens-context --lens`). */
export function assertReviewLens(
  value: unknown,
): asserts value is
  | "review-risk"
  | "review-resilience"
  | "review-readability"
  | "review-reliability" {
  if (
    value !== "review-risk" &&
    value !== "review-resilience" &&
    value !== "review-readability" &&
    value !== "review-reliability"
  ) {
    throw new ValidationError(
      "lens must be review-risk, review-resilience, review-readability, or review-reliability",
    );
  }
}

/**
 * Inline review-capture body (`inputJson`): a non-empty, bounded, NUL-free
 * string that parses as JSON. LF is allowed inside the body (pretty-printed
 * JSON); the broker stages the exact bytes as a private immutable file.
 */
export function assertReviewInputJson(value: unknown, maxBytes: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError("inputJson must be a non-empty string");
  }
  assertMaxBytes(value, maxBytes, "inputJson");
  if (value.includes("\u0000")) {
    throw new ValidationError("inputJson must not contain NUL");
  }
  try {
    JSON.parse(value);
  } catch {
    throw new ValidationError("inputJson must be valid JSON");
  }
}
