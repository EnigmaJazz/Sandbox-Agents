/**
 * register-project.ts — register a project with the agentic sandbox system.
 *
 * NOT INSTALLED — this is a manual operator tool (delivered at Gate 2 review,
 * runs on the host only). Registration takes effect when the operator runs this
 * script; the script prints the restart commands but performs no service
 * restarts itself.
 *
 * Updates THREE locations idempotently (dedupe by path; skip when present):
 *   1. nono/profile/opencode-secure.json         -> filesystem.read entry
 *      plus a filesystem.allow_file entry granting each project's parent-dir
 *      .auto-update-history.json (the auto-update history grant; the file is
 *      seeded when absent — nono grants are inode-bound at sandbox start)
 *   2. $HOME/.config/opencode-sandbox/broker.env -> BROKER_PROJECTS entry
 *   3. scripts/secure-launcher.conf              -> PROJECT_ROOTS entry
 *
 * Per project it also performs idempotent git/gh setup (all steps local-only
 * except --create-remote, which is an explicit opt-in network mutation):
 *   - git init -b main when the directory is not yet a repository
 *   - local git identity (user.name / user.email) derived from gh, only when
 *     no identity is configured; an existing identity is never overridden
 *   - origin remote (git@github.com:<owner>/<basename>.git) when the GitHub
 *     repo already exists
 *   - gh repo create (private by default, --public overrides) followed by
 *     git push -u origin main when the repo has commits
 *
 * Dependency-free (node stdlib only: node:fs, node:path, node:child_process),
 * so it runs offline with bun; git and gh must exist at runtime for the git
 * steps. Credentials are never printed: gh is used only to derive the login
 * and numeric id, and only the login appears in the summary line.
 *
 * Usage: bun scripts/register-project.ts [--dry-run] [--create-remote] [--public] <path> [path...]
 */

import { execFileSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, isAbsolute, join } from "node:path"

const HOME = process.env.HOME ?? ""
const PROFILE_PATH = join(import.meta.dir, "..", "nono", "profile", "opencode-secure.json")
const LAUNCHER_PATH = join(import.meta.dir, "..", "scripts", "secure-launcher.conf")
const BROKER_ENV_PATH = join(HOME, ".config", "opencode-sandbox", "broker.env")

const FLAGS = new Set(["--dry-run", "--create-remote", "--public"])
const DRY_RUN = process.argv.includes("--dry-run")
const CREATE_REMOTE = process.argv.includes("--create-remote")
const PUBLIC_REPO = process.argv.includes("--public")
const TARGETS = [...new Set(process.argv.slice(2).filter((a) => !FLAGS.has(a)))]

// Broker PROJECT_ID_RE: /^[a-z][a-z0-9._-]{0,63}$/
const PROJECT_ID_RE = /^[a-z][a-z0-9._-]{0,63}$/

type LocationStatus = "added" | "already registered" | "skipped"

type GitStatus = "ok" | "init" | "failed" | "would init"
type IdentityStatus = "existing" | "skipped" | `set ${string}` | `would set ${string}`
type OriginStatus = "exists" | "added" | "none" | "would add"
type GhRemoteStatus = "exists" | "created" | "skipped" | "would create"

interface Report {
  path: string
  id: string
  profile: LocationStatus | string
  autoUpdate: LocationStatus | string
  brokerEnv: LocationStatus | string
  launcher: LocationStatus | string
  git: GitStatus
  identity: IdentityStatus
  origin: OriginStatus
  ghRemote: GhRemoteStatus
  warnings: string[]
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root + "/")
}

function validateProject(path: string): string | null {
  if (!isAbsolute(path)) return `not an absolute path: ${path}`
  if (!existsSync(path)) return `does not exist: ${path}`
  if (!statSync(path).isDirectory()) return `not a directory: ${path}`
  if (path === "/" || path === HOME) {
    return `refusing to register the filesystem root or $HOME itself: ${path}`
  }
  const banned = [
    join(HOME, ".ssh"),
    join(HOME, ".config"),
    join(HOME, ".local"),
    join(HOME, ".cache"),
    join(HOME, ".gnupg"),
    join(HOME, ".aws"),
    join(HOME, ".kube"),
    "/etc",
    "/usr",
    "/var",
    "/tmp",
  ]
  for (const root of banned) {
    if (isUnder(path, root)) {
      return `refusing to register a path under ${root}: ${path}`
    }
  }
  // /mnt is not in the banned list, so any existing directory there is
  // accepted (e.g. /mnt/ai_storage/kinver-hub/proxy). A directory without a
  // .git is fine too: git init runs during registration.
  return null
}

function deriveProjectId(path: string, used: Set<string>): string {
  const base = basename(path).toLowerCase().replace(/[^a-z0-9._-]/g, "")
  if (PROJECT_ID_RE.test(base) && !used.has(base)) {
    used.add(base)
    return base
  }
  let n = 1
  while (used.has(`project-${n}`)) n++
  used.add(`project-${n}`)
  return `project-${n}`
}

function atomicWrite(file: string, content: string, mode?: number): void {
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, content, mode === undefined ? undefined : { mode })
  if (mode !== undefined) chmodSync(tmp, mode)
  renameSync(tmp, file)
}

// --- location 1: nono profile -------------------------------------------------

interface Profile {
  filesystem?: { read?: string[]; allow_file?: string[] }
}

function updateProfile(path: string): LocationStatus | string {
  let profile: Profile
  try {
    profile = JSON.parse(readFileSync(PROFILE_PATH, "utf8")) as Profile
  } catch {
    return "skipped (profile is not valid JSON)"
  }
  const read = profile.filesystem?.read
  if (!Array.isArray(read)) return "skipped (profile has no filesystem.read)"
  if (read.includes(path)) return "already registered"
  if (!DRY_RUN) {
    read.push(path)
    atomicWrite(PROFILE_PATH, JSON.stringify(profile, null, 2) + "\n")
  }
  return "added"
}

// --- location 1b: nono profile allow_file (auto-update history grant) ---------

/** Grant the auto-update history file that lives in each project's parent
 *  directory: parent = dirname(path), historyFile = parent/.auto-update-history.json.
 *  The array is created when absent; entries are deduped by path.
 *
 *  nono file grants are inode-bound at sandbox start: a grant for a file that
 *  does not exist yet cannot bind, so the auto-update plugin's first write
 *  would still fail with EACCES. The history file is therefore also created
 *  (seed content {"entries":[]}) when absent, except in --dry-run. */
function updateAutoUpdateGrant(path: string): LocationStatus | string {
  let profile: Profile
  try {
    profile = JSON.parse(readFileSync(PROFILE_PATH, "utf8")) as Profile
  } catch {
    return "skipped (profile is not valid JSON)"
  }
  const historyFile = join(dirname(path), ".auto-update-history.json")
  let filesystem = profile.filesystem
  if (filesystem === undefined) {
    filesystem = {}
    profile.filesystem = filesystem
  }
  const allowFile = filesystem.allow_file
  let grantStatus: string
  if (!Array.isArray(allowFile)) {
    if (DRY_RUN) {
      grantStatus = `would add ${historyFile}`
    } else {
      filesystem.allow_file = [historyFile]
      atomicWrite(PROFILE_PATH, JSON.stringify(profile, null, 2) + "\n")
      grantStatus = "added"
    }
  } else if (allowFile.includes(historyFile)) {
    grantStatus = "skipped"
  } else if (DRY_RUN) {
    grantStatus = `would add ${historyFile}`
  } else {
    allowFile.push(historyFile)
    atomicWrite(PROFILE_PATH, JSON.stringify(profile, null, 2) + "\n")
    grantStatus = "added"
  }
  // nono file grants are inode-bound at sandbox start: a grant for a file
  // that does not exist yet cannot bind, so the auto-update plugin's first
  // write would still fail with EACCES. The file must physically exist.
  if (existsSync(historyFile)) {
    return `${grantStatus}; exists`
  }
  if (DRY_RUN) {
    return `${grantStatus}; would create ${historyFile}`
  }
  mkdirSync(dirname(historyFile), { recursive: true })
  writeFileSync(historyFile, '{"entries":[]}\n', { mode: 0o644 })
  return `${grantStatus}; created`
}

// --- location 2: live broker env ----------------------------------------------

function existingBrokerEnvEntries(): { id: string; path: string }[] {
  const entries: { id: string; path: string }[] = []
  if (!HOME || !existsSync(BROKER_ENV_PATH)) return entries
  try {
    const match = readFileSync(BROKER_ENV_PATH, "utf8").match(/^BROKER_PROJECTS=(.*)$/m)
    if (!match) return entries
    let body = match[1].trim()
    if (body.length >= 2 && body.startsWith("'") && body.endsWith("'")) body = body.slice(1, -1)
    else if (body.length >= 2 && body.startsWith('"') && body.endsWith('"')) body = body.slice(1, -1)
    const parsed = JSON.parse(body)
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (typeof entry?.id === "string") entries.push({ id: entry.id, path: entry.path })
      }
    }
  } catch {
    // unreadable/unparseable env: entries stay empty, derivation falls back safely
  }
  return entries
}

function updateBrokerEnv(path: string, id: string): LocationStatus | string {
  if (!HOME) return "skipped (HOME unset)"
  if (!existsSync(BROKER_ENV_PATH)) return "skipped (broker.env missing; not created)"
  const raw = readFileSync(BROKER_ENV_PATH, "utf8")
  const match = raw.match(/^BROKER_PROJECTS=(.*)$/m)
  if (!match) return "skipped (no BROKER_PROJECTS line found)"
  let quote: string | null = null
  let body = match[1].trim()
  if (body.length >= 2 && body.startsWith("'") && body.endsWith("'")) {
    quote = "'"
    body = body.slice(1, -1)
  } else if (body.length >= 2 && body.startsWith('"') && body.endsWith('"')) {
    quote = '"'
    body = body.slice(1, -1)
  }
  let projects: { id: string; path: string }[]
  try {
    const parsed = JSON.parse(body)
    if (!Array.isArray(parsed)) return "skipped (BROKER_PROJECTS is not a JSON array)"
    projects = parsed
  } catch {
    return "skipped (BROKER_PROJECTS is not valid JSON)"
  }
  if (projects.some((p) => p.path === path)) return "already registered"
  if (!DRY_RUN) {
    projects.push({ id, path })
    const json = JSON.stringify(projects)
    const line = quote === null ? `BROKER_PROJECTS=${json}` : `BROKER_PROJECTS=${quote}${json}${quote}`
    const next = raw.replace(/^BROKER_PROJECTS=.*$/m, line)
    const mode = statSync(BROKER_ENV_PATH).mode & 0o777
    atomicWrite(BROKER_ENV_PATH, next, mode)
  }
  return "added"
}

// --- location 3: launcher conf -------------------------------------------------

function updateLauncher(path: string): LocationStatus | string {
  const lines = readFileSync(LAUNCHER_PATH, "utf8").split("\n")
  const start = lines.findIndex((l) => /^PROJECT_ROOTS=\(/.test(l.trim()))
  if (start === -1) return "skipped (no PROJECT_ROOTS=( array found)"
  let end = -1
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === ")") {
      end = i
      break
    }
  }
  if (end === -1) return "skipped (unterminated PROJECT_ROOTS array)"
  const tokens = lines
    .slice(start + 1, end)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((l) => l.replace(/^['"]|['"]$/g, ""))
  if (tokens.includes(path)) return "already registered"
  if (!DRY_RUN) {
    lines.splice(end, 0, `  "${path}"`)
    atomicWrite(LAUNCHER_PATH, lines.join("\n"))
  }
  return "added"
}

// --- git/gh setup -------------------------------------------------------------

interface ExecResult {
  ok: boolean
  stdout: string
}

/** Run a command as an argv vector (never a shell string). Non-zero exit or a
 *  missing binary is a soft failure; stderr is captured and never echoed, so
 *  credentials can never leak into the terminal. */
function execOk(cmd: string, args: string[], cwd: string, timeoutMs = 60_000): ExecResult {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    })
    return { ok: true, stdout }
  } catch {
    return { ok: false, stdout: "" }
  }
}

/** Read-only gh identity lookup; null when gh is not authed or the lookup
 *  fails (the caller skips silently with a warning). */
function ghUser(project: string): { login: string; id: string } | null {
  const login = execOk("gh", ["api", "user", "--jq", ".login"], project)
  if (!login.ok) return null
  const id = execOk("gh", ["api", "user", "--jq", ".id"], project)
  if (!id.ok) return null
  const l = login.stdout.trim()
  const i = id.stdout.trim()
  if (l === "" || i === "") return null
  return { login: l, id: i }
}

interface GitPlan {
  git: GitStatus
  identity: IdentityStatus
  origin: OriginStatus
  ghRemote: GhRemoteStatus
  warnings: string[]
  ghError: string | null
}

function setupGit(project: string, createRemote: boolean, publicRepo: boolean): GitPlan {
  const plan: GitPlan = {
    git: "ok",
    identity: "existing",
    origin: "exists",
    ghRemote: "skipped",
    warnings: [],
    ghError: null,
  }
  const base = basename(project)
  const user = ghUser(project)

  // 1. init when the directory is not yet a repository
  if (!existsSync(join(project, ".git"))) {
    if (DRY_RUN) {
      plan.git = "would init"
    } else {
      const init = execOk("git", ["init", "-b", "main"], project)
      plan.git = init.ok ? "init" : "failed"
      if (!init.ok) plan.warnings.push(`git init failed for ${base}`)
    }
  }

  // 2. local identity from gh, only when none is configured
  const hasName = execOk("git", ["config", "--get", "user.name"], project)
  if (hasName.ok) {
    plan.identity = "existing"
  } else if (user === null) {
    plan.identity = "skipped"
    plan.warnings.push("skipped identity (gh not authed)")
  } else if (DRY_RUN) {
    plan.identity = `would set ${user.login}`
  } else {
    const setName = execOk("git", ["config", "--local", "user.name", user.login], project)
    const setEmail = execOk(
      "git",
      ["config", "--local", "user.email", `${user.id}+${user.login}@users.noreply.github.com`],
      project,
    )
    if (setName.ok && setEmail.ok) plan.identity = `set ${user.login}`
    else {
      plan.identity = "skipped"
      plan.warnings.push(`failed to set git identity for ${base}`)
    }
  }

  // 3. origin remote when the GitHub repo already exists
  const hasOrigin = execOk("git", ["remote", "get-url", "origin"], project)
  if (hasOrigin.ok) {
    plan.origin = "exists"
  } else if (user === null) {
    plan.origin = "none"
    plan.warnings.push("skipped origin check (gh not authed)")
  } else {
    const repoExists = execOk(
      "gh",
      ["repo", "view", `${user.login}/${base}`, "--json", "urlWithOwner"],
      project,
    )
    if (!repoExists.ok) {
      plan.origin = "none"
    } else if (DRY_RUN) {
      plan.origin = "would add"
    } else {
      const add = execOk("git", ["remote", "add", "origin", `git@github.com:${user.login}/${base}.git`], project)
      plan.origin = add.ok ? "added" : "none"
      if (!add.ok) plan.warnings.push(`failed to add origin for ${base}`)
    }
  }

  // 4. gh remote creation — explicit opt-in, network mutation
  if (!createRemote) return plan
  const authed = execOk("gh", ["auth", "status"], project)
  if (!authed.ok) {
    plan.ghRemote = "skipped"
    plan.ghError = "--create-remote requires gh authentication (run gh auth login)"
    return plan
  }
  if (user === null) {
    plan.ghRemote = "skipped"
    plan.ghError = `could not determine gh login for ${base}; --create-remote skipped`
    return plan
  }
  const repoExists = execOk("gh", ["repo", "view", `${user.login}/${base}`, "--json", "urlWithOwner"], project)
  if (repoExists.ok) {
    plan.ghRemote = "exists"
    return plan
  }
  if (DRY_RUN) {
    plan.ghRemote = "would create"
    return plan
  }
  const visibility = publicRepo ? "--public" : "--private"
  const created = execOk(
    "gh",
    ["repo", "create", base, visibility, `--source=${project}`, "--remote=origin"],
    project,
    120_000,
  )
  if (!created.ok) {
    plan.ghRemote = "skipped"
    plan.warnings.push(`gh repo create failed for ${base}`)
    return plan
  }
  plan.ghRemote = "created"
  const hasHead = execOk("git", ["rev-parse", "--verify", "HEAD"], project)
  if (hasHead.ok) {
    const pushed = execOk("git", ["push", "-u", "origin", "main"], project, 300_000)
    if (!pushed.ok) plan.warnings.push(`git push -u origin main failed for ${base} (remote was created)`)
  }
  return plan
}

// --- main ---------------------------------------------------------------------

if (TARGETS.length === 0) {
  console.error("usage: bun scripts/register-project.ts [--dry-run] [--create-remote] [--public] <path> [path...]")
  process.exit(2)
}

if (PUBLIC_REPO && !CREATE_REMOTE) {
  console.error("warning: --public has no effect without --create-remote")
}

const brokerEntries = existingBrokerEnvEntries()
const usedIds = new Set(brokerEntries.map((e) => e.id))
const reports: Report[] = []
let failed = false

for (const path of TARGETS) {
  const invalid = validateProject(path)
  if (invalid !== null) {
    console.error(`error: ${invalid}`)
    failed = true
    continue
  }
  // Reuse the id of an already-registered broker entry (matched by path) so the
  // summary shows the real id instead of a project-N collision fallback.
  const existingEntry = brokerEntries.find((e) => e.path === path)
  const id = existingEntry !== undefined ? existingEntry.id : deriveProjectId(path, usedIds)
  const gitPlan = setupGit(path, CREATE_REMOTE, PUBLIC_REPO)
  if (gitPlan.ghError !== null) {
    console.error(`error: ${path}: ${gitPlan.ghError}`)
    failed = true
  }
  reports.push({
    path,
    id,
    git: gitPlan.git,
    identity: gitPlan.identity,
    origin: gitPlan.origin,
    ghRemote: gitPlan.ghRemote,
    warnings: gitPlan.warnings,
    profile: updateProfile(path),
    autoUpdate: updateAutoUpdateGrant(path),
    brokerEnv: updateBrokerEnv(path, id),
    launcher: updateLauncher(path),
  })
}

for (const r of reports) {
  console.log(`\n${r.path}`)
  console.log(`  id: ${r.id}`)
  console.log(`  git:           ${r.git}`)
  console.log(`  identity:      ${r.identity}`)
  console.log(`  origin:        ${r.origin}`)
  console.log(`  gh remote:     ${r.ghRemote}`)
  console.log(`  profile read:  ${r.profile}`)
  console.log(`  auto-update grant: ${r.autoUpdate}`)
  console.log(`  broker env:    ${r.brokerEnv}`)
  console.log(`  launcher root: ${r.launcher}`)
  for (const w of r.warnings) {
    console.error(`  warning: ${w}`)
  }
}

console.log("\nNext steps:")
console.log(
  "  systemctl --user daemon-reload && systemctl --user restart sandbox-broker.service secure-opencode.service",
)
console.log("  Note: openchamber-secure.service needs no restart for project registration.")

process.exit(failed ? 1 : 0)
