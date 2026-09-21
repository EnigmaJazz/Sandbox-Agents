# Config manifest — host tools, plugins, agents, and permissions

## 1. Purpose

This document is a **handover manifest** for the workspace that manages the
OpenCode configuration (`~/.config/opencode/opencode.json`, the plugins
directory, and the nono profile). That workspace runs a config verifier that
**reverts any `opencode.json` change it does not recognise**, so every plugin
file, agent definition, and permission entry that the `agent-host-tools` and
`reviewer-relay-transport` changes require must be listed here precisely, with
its source. It is a description of the required surface, not an installer:
**nothing in this document is to be applied automatically**, and the
`opencode/config-fragments/**` files it describes are still `NOT INSTALLED`
manual-merge fragments (`opencode/config-fragments/sandbox-permissions.jsonc:5-7`,
`opencode/config-fragments/reviewer-relay-agents.jsonc:4-6`). Only the plugin
files in section 2 are plain copy installs; everything else is a manual merge
reviewed by the user.

Scope of verification: every claim below cites a repo `file:line` or quotes the
exact source text. Where the live host state could not be read, the item is
marked **unconfirmed** in section 8 rather than guessed.

**Apply-ready appendix:** Appendix A at the end of this document holds paste-ready
merge blocks for the six relay agents and the global permission map (A.1-A.6).

---

## 2. Plugin files

OpenCode 1.18.x loads **every top-level `.ts`/`.js` file directly inside
`~/.config/opencode/plugins/`** without a `plugin`-array entry. The live config
confirms this: its `plugin` array lists only npm packages, one directory-index
`file://` entry, and an auto-update dist — it does **not** list
`sandbox-tools.ts`, `routing-guard.ts`, `reviewer-relay-transport.ts`,
`opencode-review-transport.ts`, or `sdd-task-result-artifacts.ts`, all of which
are present in the plugins directory
(`~/.config/opencode/opencode.json:1622-1629`). The only local plugin that needs
an explicit `file://` entry is `opencode-rate-limit-fallback-mapped/index.ts`
because it is a **directory** index, not a top-level file
(`~/.config/opencode/opencode.json:1626`). So the five files below need **no
`plugin`-array entry**; they need to be present at the installed path.

| Repo path | Installed path | State |
|---|---|---|
| `opencode/plugins/sandbox-tools.ts` | `~/.config/opencode/plugins/sandbox-tools.ts` | Already installed (present on host; covered by `scripts/install-user-files:110`) |
| `opencode/plugins/routing-guard.ts` | `~/.config/opencode/plugins/routing-guard.ts` | Already installed (present on host; covered by `scripts/install-user-files:110`) |
| `opencode/plugins/reviewer-relay-transport.ts` | `~/.config/opencode/plugins/reviewer-relay-transport.ts` | Present on host, but **not covered** by `scripts/install-user-files` step 4 (`scripts/install-user-files:110`) or `scripts/rollback:37` — new relative to the installer |
| `opencode/plugins/lib/broker-client.ts` | `~/.config/opencode/plugins/lib/broker-client.ts` | Already installed (present on host; covered by `scripts/install-user-files:110`) |
| `opencode/plugins/lib/host-tool-approval.ts` | `~/.config/opencode/plugins/lib/host-tool-approval.ts` | Present on host, but **not covered** by `scripts/install-user-files` step 4 (`scripts/install-user-files:110`) or `scripts/rollback:37` — new relative to the installer |

`lib/host-tool-approval.ts` is a pure helper imported by `sandbox-tools.ts`
(`opencode/plugins/sandbox-tools.ts:38-61`); `lib/broker-client.ts` is the shared
NDJSON client for the broker Unix socket
(`opencode/plugins/README.md:10`). Both must be copied to the matching `lib/`
sub-path or `sandbox-tools.ts` fails to import.

**What the manager must do.** The config manager must (a) treat the five
installed paths above as recognised so the verifier does not revert them, and
(b) extend `scripts/install-user-files` step 4 and `scripts/rollback` to include
`reviewer-relay-transport.ts` and `lib/host-tool-approval.ts` so install and
rollback stay in sync — both are currently absent from those lists
(`scripts/install-user-files:110`, `scripts/rollback:37`). The nono secure
profile already allows `$HOME/.config/opencode`
(`nono/profile/opencode-secure.json:28`), so no profile change is needed for the
plugin directory itself.

---

## 3. The six new agents

Source: `opencode/config-fragments/reviewer-relay-agents.jsonc` (fragment,
**NOT INSTALLED**; host `opencode.json` contains no `asi-review-*` key as of this
reading — the only `asi-review` occurrences in `~/.config/opencode` are the
`RELAY_AGENTS` literal inside the installed relay plugin,
`~/.config/opencode/plugins/reviewer-relay-transport.ts:61-66`).

### Key / model / variant

| Agent key | Model | Variant | Evidence |
|---|---|---|---|
| `asi-review-risk` | `openai/gpt-5.6-sol` | `high` | `reviewer-relay-agents.jsonc:26-31` |
| `asi-review-resilience` | `openai/gpt-5.6-luna` | `high` | `reviewer-relay-agents.jsonc:56-61` |
| `asi-review-readability` | `openai/gpt-5.6-luna` | `""` (empty string) | `reviewer-relay-agents.jsonc:86-91` |
| `asi-review-reliability` | `opencode-go/glm-5.3-flash` | `high` | `reviewer-relay-agents.jsonc:116-121` |
| `asi-review-refuter` | `opencode-go/qwen3.7-plus` | `high` | `reviewer-relay-agents.jsonc:146-151` |
| `asi-review-validator` | `opencode-go/glm-5.3-flash` | `max` | `reviewer-relay-agents.jsonc:176-181` |

All six are `"hidden": true`, `"mode": "subagent"`.

### Identical tools + permission block (byte-identical on all six)

`tools` (at lines 33, 63, 93, 123, 153, 183):

```jsonc
"tools": { "*": false, "bash": false, "edit": false, "read": false, "task": false, "write": false },
```

`permission` (at lines 34-54, 64-84, 94-114, 124-144, 154-174, 184-204):

```jsonc
"permission": {
  "bash": "deny",
  "edit": "deny",
  "write": "deny",
  "webfetch": "deny",
  "task": { "*": "deny" },
  "ctx_memory": "deny",
  "sandbox_bash": "deny",
  "sandbox_edit": "deny",
  "sandbox_write": "deny",
  "sandbox_apply_patch": "deny",
  "sandbox_apply": "deny",
  "sandbox_copy_in": "deny",
  "sandbox_copy_out": "deny",
  "sandbox_discard": "deny",
  "sandbox_finish": "deny",
  "sandbox_read": "deny",
  "sandbox_list": "deny",
  "sandbox_grep": "deny",
  "sandbox_diff": "deny"
}
```

### Per-agent `prompt` wording difference

Four agents (risk, resilience, readability, reliability) share one wording
(lines 32, 62, 92, 122):

> `Follow only the provider-materialized review prompt. Do not inspect the live worktree, delegate, or edit anything.`

The refuter differs (`reviewer-relay-agents.jsonc:152`):

> `Follow only the provider-materialized refutation prompt. Do not add findings, modify anything, or delegate.`

The validator differs (`reviewer-relay-agents.jsonc:182`):

> `Follow only the provider-materialized validation prompt. Do not edit files or delegate.`

### Why they are tool-less and permission-denied

The relay deliberately replaces the child session's system prompt with a
transport boundary and injects the provider-materialized user prompt, so the
agent's own prompt carries none of the review contract, evidence, or
result-schema semantics (`opencode/config-fragments/reviewer-relay-agents.jsonc:18-22`).
The plugin enforces this at runtime with
`"experimental.chat.system.transform"`, replacing `output.system` in place with
the single nonempty instruction `TRANSPORT_ISOLATION_SYSTEM` for relay sessions
(`opencode/plugins/reviewer-relay-transport.ts:1051-1056`,
`opencode/plugins/reviewer-relay-transport.ts:94-95`). The six names are
strictly disjoint from the installed transport's `review-*` names so each Task
is handled by exactly one transport (`reviewer-relay-agents.jsonc:12-16`,
`opencode/plugins/reviewer-relay-transport.ts:60-80`,
`opencode/plugins/reviewer-relay-transport.ts:1057-1060`).

---

## 4. Global permission map

Source: `opencode/config-fragments/sandbox-permissions.jsonc` (fragment,
**NOT INSTALLED**; it says so at lines 5-7 and is merged manually).

The fragment's own intent note (`sandbox-permissions.jsonc:9-18`):

```
// Intent (spec §14):
//   ordinary host bash           deny
//   ordinary host edit/write     deny
//   sandbox execution tools      allow
//   sandbox editing tools        allow
//   sandbox result apply         ask
//   sandbox discard              allow
//   host read-only tools         allow
//   host mutation                absent (no generic host mutation in v1)
//   protected secret reads       deny
```

The explicit warning about `bash` (`sandbox-permissions.jsonc:20-23`):

```
// WARNING: the "bash": "deny" rule REPLACES any existing bash rule (e.g.
// the current "bash *: allow") — that is the point of this fragment, but it
// must be applied knowingly and only for sessions protected by the sandbox
// stack. It never weakens existing permissions (spec §14: "Do not weaken").
```

`"bash": "deny"` is a whole-key replacement: the live config currently holds a
large `bash` **rule map** whose catch-all is `"*": "ask"`
(`~/.config/opencode/opencode.json:1484-1565`). Merging this fragment knowingly
collapses that map to a single `deny`.

### ALLOW (read-only tools)

- Sandbox read/inspect: `sandbox_read`, `sandbox_list`, `sandbox_grep`,
  `sandbox_diff` (`sandbox-permissions.jsonc:53-55,60`)
- Sandbox content/work (non-approval): `sandbox_write`, `sandbox_edit`,
  `sandbox_apply_patch`, `sandbox_bash`, `sandbox_finish`, `sandbox_discard`
  (`sandbox-permissions.jsonc:56-59,61,63`)
- Host read-only system tools: `host_system`, `host_service_status`,
  `host_service_logs`, `host_tailscale_status`, `host_memory`,
  `host_disk_usage`, `host_network_listeners`, `host_process_list`,
  `host_docker_list`, `host_docker_logs` (`sandbox-permissions.jsonc:64-73`)
- Host read-only SDD/review tools: `host_sdd_status`, `host_sdd_continue`,
  `host_sdd_verify_validate`, `host_sdd_task_result`, `host_review_assess`,
  `host_review_mode_status`, `host_review_status`, `host_review_lens_context`,
  `host_sdd_attempt_status` (`sandbox-permissions.jsonc:74-81,83`)

### ASK (mutations)

- `sandbox_apply` (`sandbox-permissions.jsonc:62`)
- Host mutations: `host_sdd_attempt_acquire`, `host_sdd_attempt_begin`,
  `host_sdd_attempt_rescope`, `host_sdd_attempt_finish`,
  `host_sdd_attempt_reset`, `host_sdd_attempt_grant`,
  `host_sdd_attempt_settle`, `host_sdd_archive_compose`,
  `host_git_commit`, `host_git_push`, `host_gh_issue_create`,
  `host_plan_append`, `host_register_project`, `host_review_start`,
  `host_review_capture_result`, `host_review_capture_unachievable`,
  `host_review_acknowledge_approved`, `host_review_capture_correction_plan`,
  `host_review_capture_refuter`, `host_review_capture_validation`,
  `host_review_validate`, `host_review_recover`
  (`sandbox-permissions.jsonc:82,84-104`)

### DENY (globals + protected secret reads)

- Global host tools: `bash`, `edit`, `write`, `apply_patch`
  (`sandbox-permissions.jsonc:32-35`)
- Protected secret reads (`read.deny`, `sandbox-permissions.jsonc:36-52`):
  `**/.local/share/opencode/auth.json`, `**/.ssh/**`, `**/.gnupg/**`,
  `**/.aws/**`, `**/.kube/**`, `**/.config/gcloud/**`,
  `**/.config/gh/hosts.yml`, `**/.git-credentials`, `**/.netrc`, `**/.env*`,
  `**/*.key`, `**/*.pem`

> Note: the fragment has **no** `sandbox_copy_in` / `sandbox_copy_out` entries
> even though both tools exist in code (see section 5). This is a real gap and
> is flagged there.

---

## 5. Tool inventory + authority matrix

`opencode/plugins/sandbox-tools.ts` registers **44 tools**: **13 `sandbox_*`**
and **31 host tools** (2 `host_git_*`, 13 `host_review_*`, 13 `host_sdd_*`,
3 other host mutations). The 31 host tools map exactly to the broker's 31 host
operations: **9 read operations** (`broker/src/validation.ts:750-760`) and
**22 mutation operations** (`broker/src/validation.ts:763-786`).

### Authority model (read this first)

- The plugin's local `READ_ONLY_AGENTS` list contains only
  `"gentle-orchestrator"` and is used **only** by `assertNotOrchestrator` for
  the `sandbox_*` tools (`opencode/plugins/sandbox-tools.ts:63-69`). **It does
  not gate any host tool.** No host tool calls `assertNotOrchestrator`.
- Host tools are authorized **broker-side** by `authorizeHostDispatch`
  (`broker/src/service.ts:145-161`): reads are `HOST_READ_OPEN` (every agent);
  mutations require the broker-derived trusted agent to be in the configured
  `readOnlyAgents` allowlist (`broker/src/service.ts:151-159`,
  `broker/src/validation.ts:821-834`). The default allowlist is
  `["gentle-orchestrator"]` (`broker/src/config.ts:219`,
  `broker/src/config.ts:307`), so **mutations are `gentle-orchestrator`-only**.
- Every mutation host tool additionally calls `ctx.ask(build…Ask(...))` in
  `execute` (in-tool human approval), giving the documented two-layer gate:
  fragment `ask` + in-tool `ctx.ask` (`opencode/plugins/lib/host-tool-approval.ts:5-16`,
  `broker/src/validation.ts:762`).
- Read-only host tools call **no** `ctx.ask` and have no plugin-level agent
  check; they rely solely on the broker's read policy.
- The envelope `agent` field is logging-only / fallback only; the broker
  resolves the trusted agent from the session record first
  (`broker/src/service.ts:152-153`, `broker/src/server.ts:343`).

### 5a. host git

| Tool | Read-only / mutation | Fragment permission | Agent(s) permitted per code | Evidence (file:line) |
|---|---|---|---|---|
| `host_git_commit` | mutation | ask | `gentle-orchestrator` only (broker `readOnlyAgents`) | plugin `sandbox-tools.ts:931`; op `gitCommit` `service.ts:1826`; mutation list `validation.ts:767`; fragment `sandbox-permissions.jsonc:90` |
| `host_git_push` | mutation | ask | `gentle-orchestrator` only | plugin `sandbox-tools.ts:949`; op `gitPush` `service.ts:1874`; `validation.ts:768`; fragment `sandbox-permissions.jsonc:91` |

### 5b. host review

| Tool | Read-only / mutation | Fragment permission | Agent(s) permitted per code | Evidence (file:line) |
|---|---|---|---|---|
| `host_review_assess` | read-only | allow | every agent | plugin `sandbox-tools.ts:549`; op `reviewAssess` `sdd-service.ts:116`; read list `validation.ts:755`; fragment `:78` |
| `host_review_mode_status` | read-only | allow | every agent | plugin `sandbox-tools.ts:562`; `sdd-service.ts:125`; `validation.ts:756`; fragment `:79` |
| `host_review_status` | read-only | allow | every agent | plugin `sandbox-tools.ts:576`; `sdd-service.ts:138`; `validation.ts:757`; fragment `:80` |
| `host_review_lens_context` | read-only | allow | every agent | plugin `sandbox-tools.ts:605`; `sdd-service.ts:159`; `validation.ts:758`; fragment `:81` |
| `host_review_start` | mutation | ask | `gentle-orchestrator` only | plugin `sandbox-tools.ts:1032`; `sdd-service.ts:394`; `validation.ts:777`; fragment `:95` |
| `host_review_capture_result` | mutation | ask | `gentle-orchestrator` only | plugin `sandbox-tools.ts:1065`; `sdd-service.ts:427`; `validation.ts:778`; fragment `:96` |
| `host_review_capture_unachievable` | mutation | ask | `gentle-orchestrator` only | plugin `sandbox-tools.ts:1102`; `sdd-service.ts:452`; `validation.ts:779`; fragment `:97` |
| `host_review_capture_correction_plan` | mutation | ask | `gentle-orchestrator` only | plugin `sandbox-tools.ts:1142`; `sdd-service.ts:482`; `validation.ts:781`; fragment `:99` |
| `host_review_capture_refuter` | mutation | ask | `gentle-orchestrator` only | plugin `sandbox-tools.ts:1165`; `sdd-service.ts:501`; `validation.ts:782`; fragment `:100` |
| `host_review_capture_validation` | mutation | ask | `gentle-orchestrator` only | plugin `sandbox-tools.ts:1190`; `sdd-service.ts:521`; `validation.ts:783`; fragment `:101` |
| `host_review_validate` | mutation | ask | `gentle-orchestrator` only | plugin `sandbox-tools.ts:1216`; `sdd-service.ts:542`; `validation.ts:784`; fragment `:102` |
| `host_review_recover` | mutation | ask | `gentle-orchestrator` only | plugin `sandbox-tools.ts:1245`; `sdd-service.ts:566`; `validation.ts:785`; fragment `:103` |
| `host_review_acknowledge_approved` | mutation | ask | `gentle-orchestrator` only | plugin `sandbox-tools.ts:1127`; `sdd-service.ts:473`; `validation.ts:780`; fragment `:98` |

### 5c. host sdd

| Tool | Read-only / mutation | Fragment permission | Agent(s) permitted per code | Evidence (file:line) |
|---|---|---|---|---|
| `host_sdd_status` | read-only | allow | every agent | plugin `sandbox-tools.ts:476`; op `sddStatus` `sdd-service.ts:65`; `validation.ts:751`; fragment `:74` |
| `host_sdd_continue` | read-only | allow | every agent | plugin `sandbox-tools.ts:497`; `sdd-service.ts:77`; `validation.ts:752`; fragment `:75` |
| `host_sdd_verify_validate` | read-only | allow | every agent | plugin `sandbox-tools.ts:512`; `sdd-service.ts:89`; `validation.ts:753`; fragment `:76` |
| `host_sdd_task_result` | read-only | allow | every agent | plugin `sandbox-tools.ts:533`; `sdd-service.ts:103`; `validation.ts:754`; fragment `:77` |
| `host_sdd_attempt_status` | read-only | allow | every agent | plugin `sandbox-tools.ts:637`; `sdd-service.ts:178`; `validation.ts:759`; fragment `:83` |
| `host_sdd_attempt_acquire` | mutation | ask | `gentle-orchestrator` only | plugin `sandbox-tools.ts:653`; `sdd-service.ts:194`; `validation.ts:764`; fragment `:82` |
| `host_sdd_attempt_settle` | mutation | ask | `gentle-orchestrator` only | plugin `sandbox-tools.ts:681`; `sdd-service.ts:224`; `validation.ts:765`; fragment `:89` |
| `host_sdd_attempt_begin` | mutation | ask | `gentle-orchestrator` only | plugin `sandbox-tools.ts:742`; `sdd-service.ts:267`; `validation.ts:771`; fragment `:84` |
| `host_sdd_attempt_rescope` | mutation | ask | `gentle-orchestrator` only | plugin `sandbox-tools.ts:769`; `sdd-service.ts:287`; `validation.ts:772`; fragment `:85` |
| `host_sdd_attempt_finish` | mutation | ask | `gentle-orchestrator` only | plugin `sandbox-tools.ts:796`; `sdd-service.ts:300`; `validation.ts:773`; fragment `:86` |
| `host_sdd_attempt_reset` | mutation | ask | `gentle-orchestrator` only | plugin `sandbox-tools.ts:850`; `sdd-service.ts:332`; `validation.ts:774`; fragment `:87` |
| `host_sdd_attempt_grant` | mutation | ask | `gentle-orchestrator` only | plugin `sandbox-tools.ts:880`; `sdd-service.ts:351`; `validation.ts:775`; fragment `:88` |
| `host_sdd_archive_compose` | mutation | ask | `gentle-orchestrator` only | plugin `sandbox-tools.ts:912`; `sdd-service.ts:371`; `validation.ts:766`; fragment `:104` |

### 5d. other host mutations

| Tool | Read-only / mutation | Fragment permission | Agent(s) permitted per code | Evidence (file:line) |
|---|---|---|---|---|
| `host_gh_issue_create` | mutation | ask | `gentle-orchestrator` only | plugin `sandbox-tools.ts:980`; op `ghIssueCreate` `service.ts:1947`; `validation.ts:769`; fragment `:92` |
| `host_plan_append` | mutation | ask | `gentle-orchestrator` only | plugin `sandbox-tools.ts:1003`; `service.ts:2270`; `validation.ts:776`; fragment `:93` |
| `host_register_project` | mutation | ask | `gentle-orchestrator` only | plugin `sandbox-tools.ts:1280`; `service.ts:2038`; `validation.ts:770`; fragment `:94` |

### 5e. Side table — `sandbox_*` family (same plugin)

These are not host tools but are registered by the same plugin and complete the
research inventory. All 13 call `assertNotOrchestrator`, which throws **only**
for `gentle-orchestrator`; every other agent passes this check
(`opencode/plugins/sandbox-tools.ts:63-69`). Beyond that exclusion there is no
per-agent allowlist in the plugin; worker lifecycle/state is enforced
broker-side (e.g. `ensureWorker` refuses orchestrator,
`broker/src/service.ts:197-211`).

| Tool | Read-only / mutation | Fragment permission | Gating found | Evidence |
|---|---|---|---|---|
| `sandbox_read` | read | allow | orchestrator-denied only | `sandbox-tools.ts:236,243` |
| `sandbox_list` | read | allow | orchestrator-denied only | `sandbox-tools.ts:249,256` |
| `sandbox_grep` | read | allow | orchestrator-denied only | `sandbox-tools.ts:262,269` |
| `sandbox_write` | mutation (worker-local) | allow | orchestrator-denied only | `sandbox-tools.ts:275,283` |
| `sandbox_edit` | mutation (worker-local) | allow | orchestrator-denied only | `sandbox-tools.ts:290,298` |
| `sandbox_apply_patch` | mutation (worker-local) | allow | orchestrator-denied only | `sandbox-tools.ts:305,315` |
| `sandbox_bash` | mutation (worker-local) | allow | orchestrator-denied only | `sandbox-tools.ts:322,334` |
| `sandbox_diff` | read | allow | orchestrator-denied only | `sandbox-tools.ts:350,356` |
| `sandbox_finish` | mutation (worker-local) | allow | orchestrator-denied only | `sandbox-tools.ts:362,369` |
| `sandbox_apply` | host mutation | ask | orchestrator-denied only + `ctx.ask` + broker S16/§19 | `sandbox-tools.ts:375,384,396-401` |
| `sandbox_copy_out` | host mutation | **MISSING from fragment** | orchestrator-denied only + `ctx.ask` | `sandbox-tools.ts:406,417,424-433` |
| `sandbox_copy_in` | host mutation | **MISSING from fragment** | orchestrator-denied only + `ctx.ask` | `sandbox-tools.ts:438,447,454-459` |
| `sandbox_discard` | mutation (worker-local) | allow | orchestrator-denied only | `sandbox-tools.ts:464,470` |

### Discrepancies (explicitly flagged)

1. **In code, missing from the permission fragment:** `sandbox_copy_in` and
   `sandbox_copy_out` are registered (`sandbox-tools.ts:406,438`) and are
   host-boundary operations that call `ctx.ask`
   (`sandbox-tools.ts:424-433,454-459`), but `sandbox-permissions.jsonc` has no
   entry for either. Without explicit entries they fall to whatever the installed
   config defaults to — a genuine configuration gap to close when the fragment is
   merged.
2. **In the permission fragment, no registering plugin found in this repo:**
   `host_system`, `host_service_status`, `host_service_logs`,
   `host_tailscale_status`, `host_memory`, `host_disk_usage`,
   `host_network_listeners`, `host_process_list`, `host_docker_list`,
   `host_docker_logs` (`sandbox-permissions.jsonc:64-73`). A repo-wide search
   finds these names only in that fragment and in `SYSTEM_PROMPT.md:648-651`;
   they do not appear in `opencode/plugins/**` or in the installed
   `~/.config/opencode/plugins/**`. Their broker read config exists
   (`broker/src/config.ts:247-259`, `DEFAULT_HOST_READ_CONFIG`), but the
   registering plugin was not found — see section 8.
3. No host tool is missing from the fragment and no fragment host tool is
   missing from code: the 31 fragment host entries match the 31 host tools
   one-for-one. The only host/review names absent from the fragment code path
   are the ten `host_*` read tools in item 2.

---

## 6. Rate-limit fallback exclusion

Required change (external file, **not in this repo**):
`~/.config/opencode/plugins/opencode-rate-limit-fallback-mapped/src/config.ts`.
Add all six `asi-review-*` names to `DEFAULT_EXCLUDE_AGENTS` (currently
`config.ts:169-174`).

Reason, verbatim from that file's comment (`config.ts:160-168`):

```
 * Bound review-agent sessions are never replayed. The fallback replay goes
 * through session.abort -> session.revert -> session.promptAsync with the
 * same agent, which bypasses the review plugin's task-tool context injection
 * (execute.before interception), so a replayed reviewer would refuse or emit
 * a malformed envelope. Receipt-driven reviews therefore stay reliable when
 * the primary provider is rate-limited: opencode's own retry and the native
 * review flow's STATUS-driven relaunch are the designed recovery.
```

Required resulting list (add the six `asi-review-*` names):

```ts
export const DEFAULT_EXCLUDE_AGENTS = [
  "review-risk",
  "review-resilience",
  "review-readability",
  "review-reliability",
  "asi-review-risk",
  "asi-review-resilience",
  "asi-review-readability",
  "asi-review-reliability",
  "asi-review-refuter",
  "asi-review-validator",
]
```

Note: the installed list currently omits `review-refuter` and `review-validator`
too — it contains only the four lens names (`config.ts:169-174`), whereas the
installed transport handles six names
(`opencode/plugins/reviewer-relay-transport.ts:73-80`). If the intent is "every
bound review agent is excluded", those two installed names must be added
alongside the six relay names.

---

## 7. Host items to verify or restore

### Profile write-root inventory (`scripts/register-project.ts`)

Registration creates and grants each registered project's `.codegraph` and
grants its `.git` read-write (the `.git` grant is written only when
`git init -b main` has already created it; see `docs/threat-model.md`).

### `BROKER_PROTECTED_SECURITY_FILES`

The repository template holds the full S17 list
(`systemd-user/broker.env:22`, listing `broker/src/**`, `broker/package.json`,
`broker/tsconfig.json`, `nono/profile/**`, `opencode/plugins/**`,
`opencode/config-fragments/**`, `systemd-user/**`, `scripts/**`,
`tests/security/**`, `tests/acceptance/**`, `docs/threat-model.md`). The
authoritative broker default is the same list
(`broker/src/config.ts:204-216`). The live file
(`~/.config/opencode-sandbox/broker.env`) is documented as **temporarily
relaxed to `[]`** during the bootstrap window and must be restored before final
acceptance: `openspec/changes/agent-host-tools/tasks.md:71` ("currently
temporarily `[]` … must be restored before final acceptance"), echoed in
`docs/TODO.md:9`. **Action:** restore the full list and restart
`sandbox-broker`.

### `nono/profile/opencode-secure.json` (in sync?)

Repo copy: `nono/profile/opencode-secure.json` (meta version `0.1.2`). Installed
target: `~/.config/nono/profiles/opencode-secure.json`
(`scripts/install-user-files:71`, `:76`). The repo profile already allows
`$HOME/.config/opencode` (line 28) and grants read access to
`$HOME/agent-sandbox-integration` plus the repo `.atl`/`.codegraph` write roots
(lines 38-39, 68). **Sync state unconfirmed** — see section 8.

### `opencode/config-fragments/sandbox-permissions.jsonc` (merged or not)

**Not merged.** The live `~/.config/opencode/opencode.json` differs from the
fragment in every material respect:

- `bash` is a rule map with catch-all `"*": "ask"` — not a single `"deny"`
  (`~/.config/opencode/opencode.json:1484-1565`).
- The only host tool present is `host_sdd_status: allow`
  (`~/.config/opencode/opencode.json:1599`); none of the `host_review_*`,
  `host_git_*`, `host_gh_*`, `host_plan_*`, or `host_sdd_attempt_*` mutation
  entries exist in the live global permission block.
- `sandbox_copy_in` / `sandbox_copy_out` are `deny`, and the other `sandbox_*`
  entries do not match the fragment's allow/ask split
  (`~/.config/opencode/opencode.json:1603-1615`).
- The live `read.deny` list is the older, shorter set
  (`~/.config/opencode/opencode.json:1566-1581`) and lacks the fragment's
  `.gnupg`, `.kube`, `.config/gcloud`, `.git-credentials`, and `.netrc` entries.

This matches the installer's design: step 2 explicitly does **not** merge JSON
and only emits a review diff (`scripts/install-user-files:82-91`). The six
`asi-review-*` agents are likewise **not merged** (host `opencode.json` has no
`asi-review-*` key; the only occurrences under `~/.config/opencode` are the
relay plugin's own `RELAY_AGENTS` constant). **Action:** the user manually
merges `sandbox-permissions.jsonc` and `reviewer-relay-agents.jsonc` after
review, then restarts secured OpenCode.

---

## 8. Unverified-by-design

Everything below was **not** confirmable from the repository or from readable
host files in this session. It is stated as unconfirmed, not guessed.

1. **Live `BROKER_PROTECTED_SECURITY_FILES` value.** `~/.config/opencode-sandbox/`
   is not readable from this session (permission denied). The relax-to-`[]`
   statement is taken from `openspec/changes/agent-host-tools/tasks.md:71`, not
   from a direct read of the live file.
2. **Live nono profile sync.** `~/.config/nono/profiles/` is not readable from
   this session (permission denied), so repo copy vs installed copy parity is
   unconfirmed. Compare with `cmp` at restore time.
3. **Byte parity of installed plugin files.** The five files in section 2 are
   present at their installed paths, but whether those bytes equal the repo
   copies was not verified. The host directory also contains multiple
   `sandbox-tools.ts.bak-*` backups, so the active file's provenance is
   unconfirmed.
4. **Registering plugin for the ten `host_*` read tools.** No plugin in this
   repo or in the readable installed plugins directory registers `host_system`,
   `host_service_status`, `host_service_logs`, `host_tailscale_status`,
   `host_memory`, `host_disk_usage`, `host_network_listeners`,
   `host_process_list`, `host_docker_list`, or `host_docker_logs`. They appear
   only in `sandbox-permissions.jsonc:64-73` and `SYSTEM_PROMPT.md:648-651`.
   Whether a separate (unreadable or uninstalled) plugin provides them is
   unconfirmed.
5. **`BROKER_REAP_INTERVAL_MS=3600000` removal.** Referenced as a live carry-
   forward (`openspec/changes/agent-host-tools/tasks.md:71`), but the live
   `broker.env` could not be read to confirm its current presence.
6. **Whether the installed `reviewer-relay-transport.ts` matches repo bytes.**
   It is present on host; the change's own apply-progress recorded it as *not*
   installed at that time (`openspec/changes/reviewer-relay-transport/apply-progress.md:97`),
   so the current installed bytes are unconfirmed.
7. **Test results.** No test suite was run for this document (no code changed),
   so no pass/fail count is claimed here. Existing counts cited elsewhere in the
   repo are the change artifacts' claims, not re-verified here.
8. **Git commit state.** The work is described as uncommitted
   (`docs/TODO.md:7-9`), but the working-tree state was not inspected directly
   (no git command surface in this session).

---

## Appendix A — apply-ready config blocks

Target: the live global config `~/.config/opencode/opencode.json`. Every block below is
copied verbatim from a cited repo source; where a live value was not read in the cited
range it is marked **unconfirmed**. **Nothing here is applied automatically** — this is the
manual merge the user reviews and applies (section 1), then restarts secured OpenCode.

### A.1 — The six agent objects, verbatim

Source: `opencode/config-fragments/reviewer-relay-agents.jsonc:26-205`. Insert these six
keys **inside** the existing top-level `"agent": { … }` object (live line 3) — never as a
second top-level `"agent"` key (see A.3). All eight fields are carried verbatim:
`description`, `hidden`, `mode`, `model`, `variant`, `prompt`, `tools`, `permission`.

```jsonc
"asi-review-risk": {
  "description": "Relay reviewer (R1 risk lens). Provider-materialized prompt only.",
  "hidden": true,
  "mode": "subagent",
  "model": "openai/gpt-5.6-sol",
  "variant": "high",
  "prompt": "Follow only the provider-materialized review prompt. Do not inspect the live worktree, delegate, or edit anything.",
  "tools": { "*": false, "bash": false, "edit": false, "read": false, "task": false, "write": false },
  "permission": {
    "bash": "deny",
    "edit": "deny",
    "write": "deny",
    "webfetch": "deny",
    "task": { "*": "deny" },
    "ctx_memory": "deny",
    "sandbox_bash": "deny",
    "sandbox_edit": "deny",
    "sandbox_write": "deny",
    "sandbox_apply_patch": "deny",
    "sandbox_apply": "deny",
    "sandbox_copy_in": "deny",
    "sandbox_copy_out": "deny",
    "sandbox_discard": "deny",
    "sandbox_finish": "deny",
    "sandbox_read": "deny",
    "sandbox_list": "deny",
    "sandbox_grep": "deny",
    "sandbox_diff": "deny"
  }
},
"asi-review-resilience": {
  "description": "Relay reviewer (R4 resilience lens). Provider-materialized prompt only.",
  "hidden": true,
  "mode": "subagent",
  "model": "openai/gpt-5.6-luna",
  "variant": "high",
  "prompt": "Follow only the provider-materialized review prompt. Do not inspect the live worktree, delegate, or edit anything.",
  "tools": { "*": false, "bash": false, "edit": false, "read": false, "task": false, "write": false },
  "permission": {
    "bash": "deny",
    "edit": "deny",
    "write": "deny",
    "webfetch": "deny",
    "task": { "*": "deny" },
    "ctx_memory": "deny",
    "sandbox_bash": "deny",
    "sandbox_edit": "deny",
    "sandbox_write": "deny",
    "sandbox_apply_patch": "deny",
    "sandbox_apply": "deny",
    "sandbox_copy_in": "deny",
    "sandbox_copy_out": "deny",
    "sandbox_discard": "deny",
    "sandbox_finish": "deny",
    "sandbox_read": "deny",
    "sandbox_list": "deny",
    "sandbox_grep": "deny",
    "sandbox_diff": "deny"
  }
},
"asi-review-readability": {
  "description": "Relay reviewer (R2 readability lens). Provider-materialized prompt only.",
  "hidden": true,
  "mode": "subagent",
  "model": "openai/gpt-5.6-luna",
  "variant": "",
  "prompt": "Follow only the provider-materialized review prompt. Do not inspect the live worktree, delegate, or edit anything.",
  "tools": { "*": false, "bash": false, "edit": false, "read": false, "task": false, "write": false },
  "permission": {
    "bash": "deny",
    "edit": "deny",
    "write": "deny",
    "webfetch": "deny",
    "task": { "*": "deny" },
    "ctx_memory": "deny",
    "sandbox_bash": "deny",
    "sandbox_edit": "deny",
    "sandbox_write": "deny",
    "sandbox_apply_patch": "deny",
    "sandbox_apply": "deny",
    "sandbox_copy_in": "deny",
    "sandbox_copy_out": "deny",
    "sandbox_discard": "deny",
    "sandbox_finish": "deny",
    "sandbox_read": "deny",
    "sandbox_list": "deny",
    "sandbox_grep": "deny",
    "sandbox_diff": "deny"
  }
},
"asi-review-reliability": {
  "description": "Relay reviewer (R3 reliability lens). Provider-materialized prompt only.",
  "hidden": true,
  "mode": "subagent",
  "model": "opencode-go/glm-5.3-flash",
  "variant": "high",
  "prompt": "Follow only the provider-materialized review prompt. Do not inspect the live worktree, delegate, or edit anything.",
  "tools": { "*": false, "bash": false, "edit": false, "read": false, "task": false, "write": false },
  "permission": {
    "bash": "deny",
    "edit": "deny",
    "write": "deny",
    "webfetch": "deny",
    "task": { "*": "deny" },
    "ctx_memory": "deny",
    "sandbox_bash": "deny",
    "sandbox_edit": "deny",
    "sandbox_write": "deny",
    "sandbox_apply_patch": "deny",
    "sandbox_apply": "deny",
    "sandbox_copy_in": "deny",
    "sandbox_copy_out": "deny",
    "sandbox_discard": "deny",
    "sandbox_finish": "deny",
    "sandbox_read": "deny",
    "sandbox_list": "deny",
    "sandbox_grep": "deny",
    "sandbox_diff": "deny"
  }
},
"asi-review-refuter": {
  "description": "Relay refuter. Provider-materialized prompt only.",
  "hidden": true,
  "mode": "subagent",
  "model": "opencode-go/qwen3.7-plus",
  "variant": "high",
  "prompt": "Follow only the provider-materialized refutation prompt. Do not add findings, modify anything, or delegate.",
  "tools": { "*": false, "bash": false, "edit": false, "read": false, "task": false, "write": false },
  "permission": {
    "bash": "deny",
    "edit": "deny",
    "write": "deny",
    "webfetch": "deny",
    "task": { "*": "deny" },
    "ctx_memory": "deny",
    "sandbox_bash": "deny",
    "sandbox_edit": "deny",
    "sandbox_write": "deny",
    "sandbox_apply_patch": "deny",
    "sandbox_apply": "deny",
    "sandbox_copy_in": "deny",
    "sandbox_copy_out": "deny",
    "sandbox_discard": "deny",
    "sandbox_finish": "deny",
    "sandbox_read": "deny",
    "sandbox_list": "deny",
    "sandbox_grep": "deny",
    "sandbox_diff": "deny"
  }
},
"asi-review-validator": {
  "description": "Relay targeted validator. Provider-materialized prompt only.",
  "hidden": true,
  "mode": "subagent",
  "model": "opencode-go/glm-5.3-flash",
  "variant": "max",
  "prompt": "Follow only the provider-materialized validation prompt. Do not edit files or delegate.",
  "tools": { "*": false, "bash": false, "edit": false, "read": false, "task": false, "write": false },
  "permission": {
    "bash": "deny",
    "edit": "deny",
    "write": "deny",
    "webfetch": "deny",
    "task": { "*": "deny" },
    "ctx_memory": "deny",
    "sandbox_bash": "deny",
    "sandbox_edit": "deny",
    "sandbox_write": "deny",
    "sandbox_apply_patch": "deny",
    "sandbox_apply": "deny",
    "sandbox_copy_in": "deny",
    "sandbox_copy_out": "deny",
    "sandbox_discard": "deny",
    "sandbox_finish": "deny",
    "sandbox_read": "deny",
    "sandbox_list": "deny",
    "sandbox_grep": "deny",
    "sandbox_diff": "deny"
  }
}
```

### A.2 — The global `permission` object to merge

Source: `opencode/config-fragments/sandbox-permissions.jsonc:31-105`. Merge these entries
**inside** the existing top-level `"permission": { … }` object — never as a second top-level
`"permission"` key (see A.3). Do **not** carry over the fragment's top-level `"$schema"`
(fragment line 30). `"bash": "deny"` is a deliberate **whole-key replacement** of the live
bash rule map (`~/.config/opencode/opencode.json:1484-1565`); `"read"` keeps the live
**rule-map** shape and the **union** of both deny sets (never a replacement — the fragment
says "Do not weaken"; the fragment's own `{ "allow": [], "deny": [ … ] }` shape is defective
— see the resolution note below).

```jsonc
"bash": "deny",
"edit": "deny",
"write": "deny",
"apply_patch": "deny",
"read": {
  "*": "allow",
  "**/.local/share/opencode/auth.json": "deny",
  "**/.ssh/**": "deny",
  "**/.gnupg/**": "deny",
  "**/.aws/**": "deny",
  "**/.kube/**": "deny",
  "**/.config/gcloud/**": "deny",
  "**/.config/gh/hosts.yml": "deny",
  "**/.git-credentials": "deny",
  "**/.netrc": "deny",
  "**/.env*": "deny",
  "**/*.key": "deny",
  "**/*.pem": "deny",
  "**/.aws/credentials": "deny",
  "**/.credentials/**": "deny",
  "**/.env": "deny",
  "**/.env.*": "deny",
  "**/Library/Keychains/**": "deny",
  "**/credentials.json": "deny",
  "**/secrets/**": "deny",
  "*.env": "deny",
  "*.env.*": "deny"
},
"sandbox_read": "allow",
"sandbox_list": "allow",
"sandbox_grep": "allow",
"sandbox_write": "allow",
"sandbox_edit": "allow",
"sandbox_apply_patch": "allow",
"sandbox_bash": "allow",
"sandbox_diff": "allow",
"sandbox_finish": "allow",
"sandbox_apply": "ask",
"sandbox_discard": "allow",
"sandbox_copy_in": "ask",
"sandbox_copy_out": "ask",
"host_system": "allow",
"host_service_status": "allow",
"host_service_logs": "allow",
"host_tailscale_status": "allow",
"host_memory": "allow",
"host_disk_usage": "allow",
"host_network_listeners": "allow",
"host_process_list": "allow",
"host_docker_list": "allow",
"host_docker_logs": "allow",
"host_sdd_status": "allow",
"host_sdd_continue": "allow",
"host_sdd_verify_validate": "allow",
"host_sdd_task_result": "allow",
"host_review_assess": "allow",
"host_review_mode_status": "allow",
"host_review_status": "allow",
"host_review_lens_context": "allow",
"host_sdd_attempt_acquire": "ask",
"host_sdd_attempt_status": "allow",
"host_sdd_attempt_begin": "ask",
"host_sdd_attempt_rescope": "ask",
"host_sdd_attempt_finish": "ask",
"host_sdd_attempt_reset": "ask",
"host_sdd_attempt_grant": "ask",
"host_sdd_attempt_settle": "ask",
"host_git_commit": "ask",
"host_git_push": "ask",
"host_gh_issue_create": "ask",
"host_plan_append": "ask",
"host_register_project": "ask",
"host_review_start": "ask",
"host_review_capture_result": "ask",
"host_review_capture_unachievable": "ask",
"host_review_acknowledge_approved": "ask",
"host_review_capture_correction_plan": "ask",
"host_review_capture_refuter": "ask",
"host_review_capture_validation": "ask",
"host_review_validate": "ask",
"host_review_recover": "ask",
"host_sdd_archive_compose": "ask"
```

**`read` deny-pattern union (shown explicitly).** Live list
(`~/.config/opencode/opencode.json:1568-1580`; 13 patterns):

`**/*.key`, `**/*.pem`, `**/.aws/credentials`, `**/.config/gh/hosts.yml`,
`**/.credentials/**`, `**/.env`, `**/.env.*`, `**/.ssh/**`, `**/Library/Keychains/**`,
`**/credentials.json`, `**/secrets/**`, `*.env`, `*.env.*`

Fragment list (`opencode/config-fragments/sandbox-permissions.jsonc:39-50`; 12 patterns):

`**/.local/share/opencode/auth.json`, `**/.ssh/**`, `**/.gnupg/**`, `**/.aws/**`,
`**/.kube/**`, `**/.config/gcloud/**`, `**/.config/gh/hosts.yml`,
`**/.git-credentials`, `**/.netrc`, `**/.env*`, `**/*.key`, `**/*.pem`

Union (21 unique patterns; shared entries are `**/*.key`, `**/*.pem`,
`**/.config/gh/hosts.yml`, `**/.ssh/**`):

`**/.local/share/opencode/auth.json`, `**/.ssh/**`, `**/.gnupg/**`, `**/.aws/**`,
`**/.kube/**`, `**/.config/gcloud/**`, `**/.config/gh/hosts.yml`,
`**/.git-credentials`, `**/.netrc`, `**/.env*`, `**/*.key`, `**/*.pem`,
`**/.aws/credentials`, `**/.credentials/**`, `**/.env`, `**/.env.*`,
`**/Library/Keychains/**`, `**/credentials.json`, `**/secrets/**`, `*.env`, `*.env.*`

Merge order: in a rule map the **last matching rule wins**, so emit the catch-all
`"*": "allow"` **first**, then the 21 deny patterns above. A catch-all placed last would
neutralise every deny before it.

> **RESOLVED (2026-09-14): `read` is a rule map, not an `allow`/`deny` object.** Per the
> official permissions documentation (`opencode.ai/docs/permissions`, page updated
> 2026-09-14), permissions are keyed by tool name, and every permission that takes tool
> input — `read` (matches the file path), `bash` (matches the parsed command), `glob` (the
> pattern), `grep` (the regex), `webfetch` (the URL), `task` (the subagent type), `skill`
> (the skill name) — uses the **rule-map** object syntax
> `{ "<pattern>": "allow" | "ask" | "deny", … }`. Rules are evaluated by pattern match with
> the **last matching rule winning**, so the catch-all `"*"` must come **first** and the
> specific rules after it. The documented default for `read` is itself a rule map:
> `{"*": "allow", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow"}`.
> **There is no `{ "allow": [], "deny": [ … ] }` shape in the documented config.** The
> fragment (`opencode/config-fragments/sandbox-permissions.jsonc`) expresses `read` that
> way; merged literally it becomes a rule map whose `allow` and `deny` keys match no file
> path, so the fragment's protected-secret denies would **silently not apply**. That is a
> real defect in the fragment, and the fragment is S17
> (`opencode/config-fragments/**`), so fixing it is a user-reviewed change. The merge shown
> above therefore keeps the live **rule-map** shape with `"*": "allow"` first, followed by
> the 21-pattern union. The same rule-map + last-match-wins semantics apply to every other
> input-matching permission in this manifest, so no entry in A.2 may use an `allow`/`deny`
> sub-object.

**Other fragment-level keys that must not be duplicated.** `reviewer-relay-agents.jsonc`
has exactly one top-level key, `"agent"` (line 25); `sandbox-permissions.jsonc` has
`"$schema"` (line 30) and `"permission"` (line 31). Only the permission object above is
taken from `sandbox-permissions.jsonc` — never its `"$schema"` — and no **second** top-level
`"agent"` / `"permission"` / `"$schema"` key may be introduced (see A.3).

### A.3 — Insertion points and hazards

- **The six agents** go inside the existing top-level `"agent": { … }` object (live line 3),
  as six new keys alongside the existing agent keys.
- **The permission entries** go inside the existing top-level `"permission": { … }` object
  (the live block holding `bash` at 1484-1565 and `read` at 1566-1581; closes at line 1621).
- **Most damaging failure mode:** a repeated JSON key is **valid JSON**, and OpenCode is
  **last-key-wins**. A **second** top-level `"agent"`, `"permission"`, or `"$schema"` key
  therefore **silently discards** every existing agent (a second `"agent"`) or the entire
  permission block (a second `"permission"`) with no parse error and no warning. The edit
  must **extend** the existing objects, never append new top-level ones.
- Keep the top-level `"plugin"` array (starts at live line 1622) untouched.

### A.4 — Live before-state for self-check

Diff before/after to prove nothing was lost.

- **`agent` key list:** **unconfirmed** — only live lines 1-6 were read (line 3 is
  `"agent": {`; first key `"explore"` at line 4). Section 7 records that the live config
  has **no** `asi-review-*` key (`docs/config-manifest-host-tools.md:460-462`).
- **`permission` block shape** (ranges cited in section 7):
  - `bash`: rule map, catch-all `"*": "ask"` (live 1484-1565).
  - `read`: rule map, `"*": "allow"` + 13 deny patterns (live 1566-1581).
  - `grep` `"ask"`, `glob` `"allow"`, `edit` `"deny"`, `write` `"deny"`,
    `external_directory` `"allow"` (live 1582-1586).
  - Only host tool present: `host_sdd_status` = `"allow"` (live 1599).
  - `sandbox_*` (live 1603-1615): `sandbox_diff`, `sandbox_grep`, `sandbox_list`,
    `sandbox_read` = `"allow"`; `sandbox_apply`, `sandbox_apply_patch`,
    `sandbox_copy_in`, `sandbox_copy_out`, `sandbox_discard`, `sandbox_edit`,
    `sandbox_finish`, `sandbox_write` = `"deny"`; `sandbox_bash` = `"ask"`.
  - Tail: `ctx_memory` `"deny"` (1619), `host_register_project` `"deny"` (1620); the
    permission object **closes at line 1621**, then `"plugin"` at 1622.
  - The line where the `permission` key **opens** was not read — **unconfirmed**.
  - The live `read` rule map is the correct shape — only the fragment's patterns need
    unioning in (A.2, RESOLVED note).

### A.5 — Ownership split

**Config-manager owned:** the six `asi-review-*` agent objects (A.1) and the global
permission map (A.2). These are the manual merges the config verifier must recognise.

**User-reviewed:** the S17 plugin files (`opencode/plugins/**`) and any change to the
security boundary itself. The fragment carries its own "applied knowingly" warning
(`opencode/config-fragments/sandbox-permissions.jsonc:20-23`): the `"bash": "deny"` rule
replaces the existing bash rule and "must be applied knowingly and only for sessions
protected by the sandbox stack". Plugin bytes are installed by hand (section 2).

### A.6 — Post-apply checklist

1. Six `asi-review-*` keys present in the `"agent"` object.
2. No duplicate top-level `"agent"`, `"permission"`, or `"$schema"` key.
3. `"bash"` is `"deny"`.
4. `sandbox_copy_in` and `sandbox_copy_out` are `"ask"`.
5. `read` is a **rule map** — first entry `"*": "allow"`, then all 21 union deny patterns from A.2.
6. The five plugin files exist at their installed paths (section 2).
7. Restart secured OpenCode, then confirm one `asi-review-risk` Task is recognised as an
   agent type. **This recognition is the observable proof the merge took** — the relay
   only routes a Task whose `subagent_type` resolves to an installed `asi-review-*` agent.

