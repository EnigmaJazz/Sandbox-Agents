/**
 * Host git execution hardening (SYSTEM_PROMPT.md §30 security style; S17).
 *
 * The confined OpenCode process can write `<project>/.git` read-write, and the
 * unconfined broker runs host `git` against that repository. Repository-local
 * git config is therefore agent-writable and can execute commands: hooks,
 * clean/smudge/process filters, diff drivers/textconv, fsmonitor, credential
 * helpers, and ssh/editor/proxy commands. Path scoping does NOT mitigate this:
 * those keys are repository-global, independent of which paths are staged.
 *
 * Two mechanisms, both applied at the single choke point (`spawnArgv`):
 *
 *  1. NEUTRALIZE with command-line `-c` the keys that `-c` CAN override
 *     (`core.hooksPath`, `core.fsmonitor`, `core.pager`). Command-line config
 *     has the highest precedence, so a repository-local value cannot win.
 *
 *  2. REFUSE (fail closed) execution-bearing subcommands when the
 *     repository-local config defines a key `-c` cannot remove: filters, diff
 *     drivers/textconv, include chains, and ssh/editor/proxy/helper/merge
 *     drivers. Git has no command-line "unset", so the only safe action is to
 *     not spawn at all.
 *
 *  3. REFUSE (fail closed) a remote-touching subcommand (`push`, `fetch`) whose
 *     repository-local config carries a remote-helper/shell transport
 *     (`ext::`, `!cmd`), a non-allowlisted transport, a remote
 *     `receivepack`/`uploadpack`/`vcs`, or a `url.*.insteadOf` rewrite.
 *
 * A caller-supplied `-c`/`-C` in the global-option region that would defeat the
 * neutralization or desync the guard is itself refused.
 *
 * Scoped posture: the user's global/system config is trusted and NOT
 * agent-writable, so `GIT_CONFIG_NOSYSTEM`/`GIT_CONFIG_GLOBAL` are deliberately
 * NOT used. Globally configured `credential.helper`, `url.*.insteadOf`,
 * `core.sshCommand` and `commit.gpgsign` keep working.
 *
 * The LFS claim needs care: a filter driver keeps working ONLY when it is
 * GLOBALLY scoped (for example `git lfs install` writes `filter.lfs.clean` /
 * `filter.lfs.process` to the user's global config). A REPOSITORY-LOCAL
 * `filter.<name>.clean`/`smudge`/`process` is not neutralizable by `-c` and is
 * refused, so a repository whose own tooling wrote a local filter driver (or a
 * local `diff.<name>.command`, `credential.helper`, editor, ...) now refuses
 * every guarded subcommand. That refusal is the INTENDED fail-closed posture,
 * not a regression. Two remediation paths: move the driver to the trusted
 * global config (`git config --global <key> <value>`), or remove the local key
 * (`git config --local --unset <key>`). There is no per-invocation override,
 * deliberately: an override would reopen the vector.
 *
 * The guard never invokes git: it reads the repository-local config as text so
 * it cannot itself become a vector.
 */
import { readFileSync, statSync, type Stats } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

/** Named refusal raised when an execution-bearing git command would read a
 *  repository-local config key that command-line `-c` cannot neutralize. */
export class GitGuardError extends Error {
  readonly code = "git-guard";
  constructor(
    message: string,
    readonly key?: string,
    readonly source?: string,
  ) {
    super(message);
    this.name = "GitGuardError";
  }
}

/**
 * Command-line `-c` flags spliced before the git subcommand. They close the
 * repository-local vectors that command-line config CAN override:
 *  - `core.hooksPath=/dev/null` disables the hook directory (pre-commit,
 *    commit-msg, post-commit, post-index-change, fsmonitor-watchman, ...).
 *  - `core.fsmonitor=false` disables the repository-local fsmonitor command.
 *  - `core.pager=cat` prevents a repository-local pager command from running.
 */
export const GIT_NEUTRALIZE_FLAGS: readonly string[] = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.pager=cat",
];

/**
 * Keys the splice neutralizes with `-c`. A caller argv carrying `-c <key>`
 * would land AFTER the spliced flags (later `-c` wins), defeating the
 * neutralization, so it is refused before spawn (native review R4-004).
 */
const GIT_NEUTRALIZED_KEYS: ReadonlySet<string> = new Set([
  "core.hookspath",
  "core.fsmonitor",
  "core.pager",
]);

/**
 * Repository-local keys with no command-line "unset". A caller `-c <key>`
 * could supply a benign value that masks a refused local key (the guard reads
 * the file, git reads the last `-c`), so it is refused too (R4-004).
 */
const GIT_UNSETTABLE_KEYS: ReadonlySet<string> = new Set([
  "core.attributesfile",
  "core.excludesfile",
]);

/** Subcommands whose git process reads remote configuration (O3 guard). */
const GIT_REMOTE_SUBCOMMANDS: ReadonlySet<string> = new Set(["push", "fetch"]);

/**
 * Subcommands that can execute a repository-local command (hooks, filters,
 * diff drivers, ssh/proxy commands). Read-only plumbing needs no guard.
 */
const GIT_EXECUTION_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "add",
  "commit",
  "push",
  "restore",
  "checkout",
  "diff",
  "fetch",
  "update-ref",
  "apply",
  "merge",
  "rebase",
  "reset",
]);

/** Git global options that consume the following argv token as their value. */
const GIT_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-c",
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
  "--exec-path",
]);

/** Legacy `[section.subsection]` fallback; a quoted subsection wins. */
const GIT_SECTION_RE = /^\[([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/;
/** Git config keys are alphanumeric plus `-`; never `.`. */
const GIT_KEY_RE = /^([A-Za-z][A-Za-z0-9-]*)$/;

/** True only for the git executable itself (`git-lfs`, `git-annex`, ... excluded). */
export function isGitBinary(binary: string): boolean {
  return basename(binary) === "git";
}

export interface GitSubcommand {
  /** argv index of the subcommand, or -1 when none is present. */
  index: number;
  subcommand: string | null;
}

/**
 * Locate the git subcommand by SKIPPING leading global options. Callers pass
 * options already (`-c`, `-C`, `--git-dir=...`), so the subcommand is not
 * necessarily at index 1; this never assumes it.
 */
export function findGitSubcommand(argv: readonly string[]): GitSubcommand {
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--" || !token.startsWith("-")) {
      return token === "--"
        ? { index: -1, subcommand: null }
        : { index, subcommand: token };
    }
    if (GIT_OPTIONS_WITH_VALUE.has(token)) index += 1;
  }
  return { index: -1, subcommand: null };
}

/** Convenience wrapper returning only the subcommand name (or null). */
export function gitSubcommand(argv: readonly string[]): string | null {
  return findGitSubcommand(argv).subcommand;
}

/**
 * Harden a host argv vector for the git choke point: refuse an unsafe
 * repository-local config for execution-bearing subcommands, then splice the
 * `-c` neutralization before the subcommand. Non-git binaries and argv without
 * an identifiable subcommand are returned unchanged.
 *
 * Pure except for the config read; throws {@link GitGuardError} on refusal.
 */
export function hardenGitArgv(
  argv: readonly string[],
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): readonly string[] {
  const binary = argv[0];
  if (binary === undefined || !isGitBinary(binary)) return argv;
  const { index, subcommand } = findGitSubcommand(argv);
  if (subcommand === null) return argv;
  // A caller `-c <neutralized-key>` would land after our spliced flags (later
  // `-c` wins) and a caller `-C` would desync the guard from the repository git
  // reads: refuse both before spawn (R4-004).
  assertNoCallerConfigOverride(argv, index, subcommand);
  if (GIT_EXECUTION_SUBCOMMANDS.has(subcommand)) {
    assertRepositoryLocalConfigSafe(opts.cwd, opts.env);
  }
  if (GIT_REMOTE_SUBCOMMANDS.has(subcommand)) {
    assertRemoteTransportSafe(opts.cwd, opts.env);
  }
  return [binary, ...GIT_NEUTRALIZE_FLAGS, ...argv.slice(1)];
}

/**
 * Refuse a caller-supplied global override that could defeat the `-c`
 * neutralization (R4-004). Only the GLOBAL-OPTION region before the subcommand
 * is inspected, so `git commit -C <commit>` (a subcommand option, not a global
 * chdir) is never misfired on. `-c user.name`/`-c user.email` are not
 * neutralized keys and keep working.
 */
export function assertNoCallerConfigOverride(
  argv: readonly string[],
  subcommandIndex: number,
  subcommand: string,
): void {
  for (let index = 1; index < subcommandIndex; index += 1) {
    const token = argv[index];
    if (token === "-C") {
      throw new GitGuardError(
        `refusing caller-supplied '-C' on git subcommand '${subcommand}': it can redirect the guard away from the repository git will read`,
      );
    }
    if (token === "-c") {
      const pair = argv[index + 1];
      if (pair === undefined) break;
      const eq = pair.indexOf("=");
      const key = (eq < 0 ? pair : pair.slice(0, eq)).toLowerCase();
      if (GIT_NEUTRALIZED_KEYS.has(key) || GIT_UNSETTABLE_KEYS.has(key)) {
        throw new GitGuardError(
          `refusing caller-supplied '-c ${key}=...' on git subcommand '${subcommand}': it would override the broker's neutralization or mask a refused repository-local key`,
          key,
        );
      }
      index += 1;
    }
  }
}

/**
 * Refuse when the repository-local config defines an execution-bearing key.
 * Fail closed when the git directory cannot be resolved.
 */
export function assertRepositoryLocalConfigSafe(
  cwd: string | undefined,
  env: Record<string, string | undefined> | undefined,
): void {
  const gitDir = resolveGitDir(cwd, env);
  if (gitDir === null) {
    throw new GitGuardError(
      "refusing execution-bearing git command: repository git directory could not be resolved",
    );
  }
  const commonDir = resolveCommonDir(gitDir, cwd ?? process.cwd(), env);
  for (const file of localConfigFiles(commonDir, gitDir)) {
    const text = readConfigText(file);
    if (text === null) continue;
    const key = findExecutionBearingLocalKey(text);
    if (key !== null) {
      throw new GitGuardError(
        `refusing execution-bearing git command: repository-local config defines '${key}' in ${file}`,
        key,
        file,
      );
    }
  }
}

/**
 * Value-aware remote-transport guard (O3). `-c` cannot unset a remote URL and
 * every real repository stores one, so instead of neutralizing, this REFUSES
 * before an execution-bearing remote subcommand when the repository-local
 * config defines a remote-helper/shell transport, a non-allowlisted transport,
 * a remote `receivepack`/`uploadpack`/`vcs`, or a `url.*.insteadOf` rewrite.
 * Plain `https`/`ssh`/`file` remotes (this repo's own origin) pass.
 */
export function assertRemoteTransportSafe(
  cwd: string | undefined,
  env: Record<string, string | undefined> | undefined,
): void {
  const gitDir = resolveGitDir(cwd, env);
  if (gitDir === null) {
    throw new GitGuardError(
      "refusing remote-transport git command: repository git directory could not be resolved",
    );
  }
  const commonDir = resolveCommonDir(gitDir, cwd ?? process.cwd(), env);
  for (const file of localConfigFiles(commonDir, gitDir)) {
    const text = readConfigText(file);
    if (text === null) continue;
    const key = findUnsafeRemoteKey(text);
    if (key !== null) {
      throw new GitGuardError(
        `refusing remote-transport git command: repository-local config defines '${key}' in ${file}`,
        key,
        file,
      );
    }
  }
}

/**
 * True when `section.subsection.key` names a repository-local key whose value
 * is a command git would execute and that command-line `-c` cannot remove.
 */
export function isExecutionBearingLocalKey(
  section: string,
  subsection: string | null,
  key: string,
): boolean {
  switch (section) {
    case "filter":
      return (
        subsection !== null &&
        (key === "clean" ||
          key === "smudge" ||
          key === "process" ||
          key === "required")
      );
    case "diff":
      return (
        key === "external" ||
        (subsection !== null && (key === "command" || key === "textconv"))
      );
    case "include":
      return subsection === null && key === "path";
    case "includeif":
      return subsection !== null && key === "path";
    case "core":
      return (
        key === "gitproxy" ||
        key === "sshcommand" ||
        key === "editor" ||
        key === "askpass"
      );
    case "credential":
      return key === "helper";
    case "merge":
      return subsection !== null && key === "driver";
    case "gpg":
      return subsection === null && key === "program";
    case "submodule":
      return subsection !== null && key === "command";
    case "sequence":
      return subsection === null && key === "editor";
    default:
      return false;
  }
}

/** First execution-bearing key in a config text, or null. Pure. */
export function findExecutionBearingLocalKey(text: string): string | null {
  for (const entry of parseLocalConfigKeys(text)) {
    if (isExecutionBearingLocalKey(entry.section, entry.subsection, entry.key)) {
      const sub = entry.subsection === null ? "" : `"${entry.subsection}"`;
      return `${entry.section}${sub.length > 0 ? ` ${sub}` : ""}.${entry.key}`;
    }
  }
  return null;
}

export interface GitConfigKey {
  section: string;
  subsection: string | null;
  key: string;
}

/**
 * Parse the subset of git-config the guard must inspect: section headers
 * (including the legacy dotted form), `key` / `key = value`, `#`/`;` comments,
 * quoting and line continuation. Section and key names are lowercased;
 * subsections are lowercased too so a case variant cannot evade the match.
 */
export function parseLocalConfigKeys(text: string): GitConfigKey[] {
  return parseLocalConfigValues(text).map(({ section, subsection, key }) => ({
    section,
    subsection,
    key,
  }));
}

export interface GitConfigEntry extends GitConfigKey {
  /** Raw value after `=`, trimmed with one layer of outer quotes removed. */
  value: string;
}

/**
 * Like {@link parseLocalConfigKeys} but also captures each key's value. Used by
 * the value-aware remote-transport guard, which must inspect URLs.
 */
export function parseLocalConfigValues(text: string): GitConfigEntry[] {
  const entries: GitConfigEntry[] = [];
  let section = "";
  let subsection: string | null = null;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    let line = stripComment(lines[index]!);
    while (line.endsWith("\\") && index + 1 < lines.length) {
      index += 1;
      line = `${line.slice(0, -1)}\n${stripComment(lines[index]!)}`;
    }
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("[")) {
      const header = parseSectionHeader(trimmed);
      if (header !== null) {
        section = header.section;
        subsection = header.subsection;
      }
      continue;
    }
    if (section.length === 0) continue;
    const key = parseKeyLine(trimmed);
    if (key === null) continue;
    const eq = indexOfUnquoted(trimmed, "=");
    const raw = eq < 0 ? "" : trimmed.slice(eq + 1).trim();
    entries.push({ section, subsection, key, value: unquote(raw) });
  }
  return entries;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return unescape(value.slice(1, -1));
  }
  return value;
}

/** Benign transports: an explicit allowlisted scheme, or scp-style `host:path`. */
const GIT_ALLOWED_TRANSPORT_RE = /^(?:https?|ssh|git|file):\/\//i;

/**
 * True when `value` is a remote URL using an explicitly allowlisted transport
 * (`https://`, `http://`, `ssh://`, `git://`, `file://`) or scp-style
 * `[user@]host:path`. Anything else — the `ext::` remote-helper form, a `!cmd`
 * shell form, or an unknown scheme — is refused.
 */
export function isAllowedRemoteTransport(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return false;
  if (GIT_ALLOWED_TRANSPORT_RE.test(v)) return true;
  if (v.startsWith("!")) return false;
  const colon = v.indexOf(":");
  if (colon <= 0) return false;
  const host = v.slice(0, colon);
  const rest = v.slice(colon + 1);
  if (rest.length === 0 || rest.startsWith(":") || rest.startsWith("//") || v.includes("::")) {
    return false;
  }
  if (host.includes("/") || host.includes(" ") || host.includes("\\")) return false;
  return true;
}

/**
 * First unsafe remote-transport key in a config text, or null. Pure. Matches
 * every occurrence: git uses the last value, so matching ANY is fail-closed.
 */
export function findUnsafeRemoteKey(text: string): string | null {
  for (const entry of parseLocalConfigValues(text)) {
    const { section, subsection, key, value } = entry;
    if (subsection === null) continue;
    if (section === "url" && (key === "insteadof" || key === "pushinsteadof")) {
      return `url.${subsection}.${key}`;
    }
    if (section === "remote") {
      if (key === "receivepack" || key === "uploadpack" || key === "vcs") {
        return `remote.${subsection}.${key}`;
      }
      if ((key === "url" || key === "pushurl") && !isAllowedRemoteTransport(value)) {
        return `remote.${subsection}.${key} (${bounded(value)})`;
      }
    }
  }
  return null;
}

function bounded(value: string): string {
  const v = value.trim();
  return v.length > 60 ? `${v.slice(0, 60)}…` : v;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function stripComment(line: string): string {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index]!;
    if (ch === "\\") {
      index += 1;
      continue;
    }
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && (ch === "#" || ch === ";")) return line.slice(0, index);
  }
  return line;
}

function parseSectionHeader(
  line: string,
): { section: string; subsection: string | null } | null {
  const match = GIT_SECTION_RE.exec(line);
  if (match === null) return null;
  const rawSection = match[1]!.toLowerCase();
  let section = rawSection;
  let subsection: string | null =
    match[2] === undefined ? null : unescape(match[2]).toLowerCase();
  if (subsection === null) {
    const dot = section.indexOf(".");
    if (dot >= 0) {
      subsection = section.slice(dot + 1);
      section = section.slice(0, dot);
    }
  }
  if (section.length === 0) return null;
  return { section, subsection };
}

function parseKeyLine(line: string): string | null {
  const eq = indexOfUnquoted(line, "=");
  const head = (eq < 0 ? line : line.slice(0, eq)).trim();
  const match = GIT_KEY_RE.exec(head);
  return match === null ? null : match[1]!.toLowerCase();
}

function indexOfUnquoted(line: string, target: string): number {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index]!;
    if (ch === "\\") {
      index += 1;
      continue;
    }
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && ch === target) return index;
  }
  return -1;
}

function unescape(value: string): string {
  return value.replace(/\\(.)/g, "$1");
}

function resolveGitDir(
  cwd: string | undefined,
  env: Record<string, string | undefined> | undefined,
): string | null {
  const base = cwd ?? process.cwd();
  const fromEnv = env?.GIT_DIR;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    const dir = isAbsolute(fromEnv) ? fromEnv : resolve(base, fromEnv);
    return isDirectory(dir) ? dir : null;
  }
  const dotGit = join(base, ".git");
  const stats = statForGuard(dotGit);
  if (stats === null) return null;
  if (stats.isDirectory()) return dotGit;
  if (!stats.isFile()) return null;
  const pointer = readFileSync(dotGit, "utf8").split("\n", 1)[0]?.trim() ?? "";
  const match = /^gitdir:\s*(.+)$/.exec(pointer);
  if (match === null) return null;
  const target = match[1]!.trim();
  const dir = isAbsolute(target) ? target : resolve(base, target);
  return isDirectory(dir) ? dir : null;
}

function resolveCommonDir(
  gitDir: string,
  base: string,
  env: Record<string, string | undefined> | undefined,
): string {
  const fromEnv = env?.GIT_COMMON_DIR;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    const dir = isAbsolute(fromEnv) ? fromEnv : resolve(base, fromEnv);
    return isDirectory(dir) ? dir : gitDir;
  }
  const pointer = join(gitDir, "commondir");
  const stats = statForGuard(pointer);
  if (stats === null || !stats.isFile()) return gitDir;
  const raw = readFileSync(pointer, "utf8").trim();
  if (raw.length === 0) return gitDir;
  const dir = isAbsolute(raw) ? raw : resolve(gitDir, raw);
  return isDirectory(dir) ? dir : gitDir;
}

function localConfigFiles(commonDir: string, gitDir: string): string[] {
  return [
    ...new Set([
      join(commonDir, "config"),
      join(gitDir, "config"),
      join(gitDir, "config.worktree"),
    ]),
  ];
}

function readConfigText(file: string): string | null {
  const stats = statForGuard(file);
  if (stats === null) return null;
  if (!stats.isFile()) {
    throw new GitGuardError(
      `refusing execution-bearing git command: repository-local config ${file} is not a regular file`,
      undefined,
      file,
    );
  }
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    throw new GitGuardError(
      `refusing execution-bearing git command: cannot read repository-local config ${file}: ${errorMessage(err)}`,
      undefined,
      file,
    );
  }
}

function isDirectory(path: string): boolean {
  const stats = statForGuard(path);
  return stats !== null && stats.isDirectory();
}

function statForGuard(path: string): Stats | null {
  try {
    return statSync(path);
  } catch (err) {
    if (errorCode(err) === "ENOENT") return null;
    throw new GitGuardError(
      `refusing execution-bearing git command: cannot stat ${path}: ${errorMessage(err)}`,
    );
  }
}

function errorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
