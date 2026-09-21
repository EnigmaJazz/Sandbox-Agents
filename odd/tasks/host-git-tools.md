# ODD Tasks — host-git-tools

- **Feature:** `host-git-tools`
- **Project:** `sandbox-integration` (`/home/james/agent-sandbox-integration`)
- **Status:** planned — tracker only; no implementation started
- **Created:** 2026-09-18
- **Delivery strategy:** `ask-on-risk`
- **Chain strategy:** `stacked-to-main` (the user's standing choice)

## Objective

Extend the host git surface beyond `host_git_commit` and `host_git_push` with a
read tier (`status`, `diff`, `log`, `show`, branch list) open to every agent and
never prompting — mirroring the existing read tier — plus orchestrator-only,
fragment-`ask`, metadata-rich mutations for explicit-path staging, unstage/reset,
branch checkout/switch, and stash. Every operation runs on a fixed argv vector
with bounded, redacted output, and the existing S17 protected-path rejection and
exact-payload-key validation are preserved.

## Problem

The host git surface today is only two mutations (`host_git_commit`,
`host_git_push`), and those two alone are not usable.

There is **no read path**: an agent cannot run `git status`, `git diff`,
`git log`, `git show`, or list branches, so it cannot inspect repository state at
all. This was hit directly: the orchestrator had to ask the user to run
`git status --porcelain` by hand before a commit plan could be assembled.
(Reported evidence — not reproduced here.)

A sandbox worker cannot substitute for a host read path because its repository is
a synthetic snapshot. Empirically observed in this session inside the worker:
`git branch --show-current` returned `work` — not the host branch — and
`git status --porcelain` listed only the broker's synthetic
`ses_<id>.bundle` artifact. The worker's git view is therefore not the host's.

Likewise, **staging is only reachable through `host_git_commit`'s derived B→C
paths**: there is no way to stage an explicit path set, inspect what is staged,
or manage branches.

## Verified current surface (file:line)

Read-only observations from this session. The manifest's cited line numbers are
stale relative to the current files; the observed values are below.

### Plugin declarations — `opencode/plugins/sandbox-tools.ts`

- `:672-702` — `host_git_commit` tool: `ctx.ask(buildGitCommitAsk(...))` at
  `:684`, brokers operation `gitCommit` at `:693`.
- `:704-733` — `host_git_push` tool: `ctx.ask(buildGitPushAsk(...))` at `:717`,
  brokers operation `gitPush` at `:725`.
- `:57` — `READ_ONLY_AGENTS = ["gentle-orchestrator"]`; used **only** by
  `assertNotOrchestrator` (`:59-63`) for `sandbox_*` tools, not host tools.
- No `host_git_status`/`diff`/`log`/`show`/`branch` tool exists anywhere in the
  plugin.

### Broker handlers — `broker/src/service.ts`

- `:1883-1925` — `buildGitCommitOp`: `authorizeHostDispatch(ctx, "gitCommit", …)`
  at `:1890`; resolves the persisted B→C refs (`resolveCommitResult`,
  `:1831-1873`); derives paths via `changedPathsBetween` (`:1501`); refuses an
  empty result (`:1899`); rejects protected paths with `checkProtectedPaths`
  (`:1902-1910`); then runs `buildGitCommitArgv` (`:1911`).
- `:1931-2001` — `buildGitPushOp`: `authorizeHostDispatch(ctx, "gitPush", …)` at
  `:1939`; resolves branch via `git symbolic-ref --short -q HEAD` (`:1956`),
  upstream (`:1965`), ahead count (`:1975`); then `buildGitPushArgv` (`:1981`).
- `:147` — `authorizeHostDispatch` (broker-side read/mutation policy).
- `broker/src/server.ts:394-397` — dispatch cases for `gitCommit`/`gitPush`.
- `broker/src/types.ts:75-76` — `"gitCommit" | "gitPush"` in the `Operation`
  union.

### Payload allowlists — `broker/src/validation.ts`

- `:922` — `gitCommit: ["projectDir", "message", "sandboxSessionID"]`.
- `:923` — `gitPush: ["projectDir", "remote", "setUpstream", "allowProtectedBranch"]`.
- `:943-962` — `assertPayloadKeys`: exact-key allowlist; unknown keys rejected,
  broker-policy `FORBIDDEN_WORKER_FIELDS` rejected with a distinct message.

### Fixed-argv builders — `broker/src/gitops.ts`

- `:352-360` — `buildGitCommitArgv` emits exactly
  `["git","add","--",...paths]` then
  `["git","commit","-m",message,"--",...paths]`. Never `git add -A`, never `-a`,
  never a bare `git commit`.
- `:380-405` — `buildGitPushArgv` emits `["git","push", ["--set-upstream"],
  remote, branch]`; refuses detached HEAD, missing upstream without `setUpstream`,
  direct `main`/`master` without `allowProtectedBranch`, and force/delete/refspec
  forms.
- `:333` — `GIT_OUTPUT_MAX_BYTES = 512 * 1024`; `:336-340` — `capAndRedact`
  (redact first, then truncate to the byte cap).
- Validators: `assertGitCommitMessage` `validation.ts:663-672`;
  `assertGitPathList` `:675-695`; `assertGitRemote` `:697-701`;
  `assertGitBranch` `:703-707`.
- No status/diff/log/show/branch builder exists. `buildDiffArgv` (`:104`) and
  `buildSnapshotPlan` (`:63`) are baseline↔result internals, not host-read tools.

### Authorization split — `broker/src/validation.ts`

- `:750-758` — `HOST_READ_OPERATIONS` (7): `sddStatus`, `sddContinue`,
  `sddTaskResult`, `reviewAssess`, `reviewModeStatus`, `reviewStatus`,
  `reviewLensContext`. **No git operation.**
- `:761-778` — `HOST_MUTATION_OPERATIONS` (16): includes `gitCommit` `:763` and
  `gitPush` `:764`.
- `:813-826` — `HostToolPolicy.decide`: `read` → `HOST_READ_OPEN`, allowed to
  every agent (`:815-817`); `mutation` → allowed only when the broker-derived
  trusted agent is in the configured `readOnlyAgents` allowlist (`:818-820`),
  otherwise `HOST_MUTATION_NOT_ORCHESTRATOR` / `HOST_MUTATION_UNKNOWN_AGENT`.
- `opencode/config-fragments/sandbox-permissions.jsonc:90-91` —
  `"host_git_commit": "ask"`, `"host_git_push": "ask"`. Existing read-tier
  entries at `:74-81`; the mutation ask block spans `:88-104`.

### Manifest — `docs/config-manifest-host-tools.md`

- `:269-274` — §5a "host git" inventory lists exactly `host_git_commit` and
  `host_git_push`, both mutation / fragment `ask` / orchestrator-only.
- `:241-244` — inventory claims "31 host tools (2 `host_git_*`, …)", "9 read
  operations (`validation.ts:750-760`) and 22 mutation operations
  (`validation.ts:763-786`)". Observed current code is **7 read + 16 mutation =
  23**; the counts and the cited line ranges are stale.
- `:273-274` — the table's evidence refs are stale: plugin
  `sandbox-tools.ts:931`/`:949` (actual `:672`/`:704`); `service.ts:1826`/`:1874`
  (actual `buildGitCommitOp` `:1883` / `buildGitPushOp` `:1931`);
  `validation.ts:767`/`:768` (actual `:763`/`:764`). T5 must correct these.
- `:214`, `:795-796` — fragment permission lists that must gain every new tool.

## Scope

### Reads — available to all agents, never prompting (existing read tier)

- `status` — working-tree/branch status (porcelain, NUL-delimited).
- `diff` — worktree, staged, or against an explicit revision.
- `log` — bounded recent history.
- `show` — one commit/ref, bounded.
- branch list.

### Mutations — orchestrator-only, fragment `ask`, metadata-rich `ctx.ask`

- stage an explicit path set (`git add -- <paths>`), never `-A` / `--all`.
- unstage / reset an explicit path set.
- checkout / switch an existing branch.
- stash (exact bounded subset fixed in T2).

### Out of scope

Force pushes, branch deletion, history rewriting, remote management.

## Constraints

- **Fixed argv vectors only, never a shell string.** Every operation is an argv
  array built by a pure helper in the `gitops.ts` style (`:352-405`).
- **Explicit paths only** — never `git add -A`, `--all`, or a bare `git add`.
- **Preserve S17 protected-path rejection** (`checkProtectedPaths`,
  `gitops.ts:242-256`, applied at `service.ts:1902`) for any new mutation that
  can change tracked content.
- **Preserve exact-payload-key validation** (`assertPayloadKeys`,
  `validation.ts:943-962`); add a precise allowlist per new operation.
- **Bounded output with an explicit cap** — reuse `GIT_OUTPUT_MAX_BYTES`
  (512 KiB) and `capAndRedact` (`gitops.ts:333-340`).
- **No new credentials, no network.** Reads are local; no remote management or
  fetch/pull in scope.
- **Reads never prompt and are open to every agent**, mirroring
  `HOST_READ_OPERATIONS` / `HOST_READ_OPEN` (`validation.ts:750-758`, `:815-817`)
  and the fragment read tier.
- **Mutations are orchestrator-only, fragment `ask`, with an in-tool metadata
  `ctx.ask`** (the two-layer gate used by the existing host mutations).
- **Every new operation must be added to the fragment and the manifest in the
  same change unit** — never one without the other.
- **S17.** `broker/src/**`, `opencode/plugins/**`,
  `opencode/config-fragments/**`, and `docs/threat-model.md` are S17:
  agent-authored changes are reviewed and installed by the user, never
  auto-applied.
- **No deploy, mirror to `~/.config`, service restart, or commit by the agent.**
- Broker code stays dependency-free (`bun:test` + node builtins only).

## Tasks

Stable IDs; each task is a reviewable change unit.

### T1 — Read tools: status, diff, log, show, branch list

Add the five read tools: plugin declarations, broker operations, handlers,
classification as `read`, payload allowlists, and fixed argv builders. Every
operation returns bounded, redacted output.

- Files: `opencode/plugins/sandbox-tools.ts`, `broker/src/service.ts`,
  `broker/src/validation.ts`, `broker/src/gitops.ts`, `broker/src/types.ts`,
  `broker/src/server.ts` (S17 where applicable).
- Done when: each read tool returns host state on a fixed argv with a 512-KiB
  capped/redacted body, and is in `HOST_READ_OPERATIONS` with no `ctx.ask`.

### T2 — Staging and branch mutations

Add explicit-path `add`, unstage/reset, checkout/switch, and stash.

- Files: same set as T1.
- Done when: each mutation emits a fixed argv, refuses `-A`/`--all`, is classified
  `mutation`, and calls a metadata `ctx.ask`.

### T3 — Validation and authorization

Payload allowlists per new operation; read/mutation classification; orchestrator-
only enforcement via the broker `readOnlyAgents` policy; S17 preservation on any
content-changing mutation.

- Files: `broker/src/validation.ts`, `broker/src/service.ts`, `broker/src/gitops.ts`.
- Done when: no new operation can be reached with an undeclared payload key, a
  non-orchestrator caller is refused for every mutation, and the protected-path
  check still fires before any content change.

### T4 — Tests

Fixed argv per operation; refusal cases (banned flags such as `-A`/`--all`/force/
delete, protected paths, undeclared payload keys, non-orchestrator callers); and
read-tier no-prompt behaviour.

- Files: `broker/tests/gitops.test.ts`, `broker/tests/validation.test.ts`,
  `broker/tests/service-host-tools.test.ts`, plus any new git-read test file.
- Done when: RED→GREEN evidence is captured for the new assertions and the
  existing suite stays green.

### T5 — Docs and configuration

- `opencode/config-fragments/sandbox-permissions.jsonc`: add every new tool
  (reads `allow`, mutations `ask`).
- `docs/config-manifest-host-tools.md`: update §5a and the tool inventory counts,
  and correct the stale line refs noted above.
- `docs/threat-model.md`: update the host-git surface boundary if the change
  warrants it (S17).

Done when all three documents match the implemented surface.

## Acceptance criteria

1. An agent can read host `git status`, `git diff`, `git log`, `git show`, and
   the branch list, with no prompt, from a fixed argv and bounded/redacted output.
2. An orchestrator can stage an explicit path set, unstage/reset, checkout/switch
   a branch, and stash — each through a fragment-`ask`, metadata `ctx.ask` mutation
   that is orchestrator-only broker-side.
3. No new operation accepts `-A`/`--all`, a shell string, or an undeclared
   payload key.
4. The S17 protected-path rejection still fires before any content-changing
   mutation.
5. A non-orchestrator caller is refused every new mutation.
6. Every new operation appears in both the fragment and the manifest in the same
   change unit.
7. Tests cover the fixed argv, the refusal cases, and the read-tier no-prompt
   behaviour; the existing suite is green.
8. No read tool calls `ctx.ask`; no read operation is added to
   `HOST_MUTATION_OPERATIONS`.

## Checks

- `cd broker && bun test` (all suites green; RED→GREEN captured for new
  assertions).
- `cd broker && bun build src/main.ts` (compiles; dependency-free constraint
  holds).
- Argv-vector inspection for every new operation (no shell string, no `-A`/
  `--all`).
- Readback of the fragment and manifest entries against the implemented tool set.
- A read-tier no-prompt check: every read tool runs without `ctx.ask`.
- S17 files are reviewed and installed by the user; the agent does not apply them.

## Authorized scope

Authorized: implement T1–T5 as reviewable change units under the ODD work-unit
rule, with sandbox-only mutation, after a separate apply phase is explicitly
launched.

Not authorized by this tracker: deployment, mirroring to `~/.config`, service
restart, or commit/push/PR/merge/release; and any change that weakens a
permission. S17 files (`broker/src/**`, `opencode/plugins/**`,
`opencode/config-fragments/**`, `docs/threat-model.md`) are reviewed and
installed by the user, never auto-applied.

This tracker's creation is the only authorized output of the creating session;
no feature code, deploy, mirror, restart, or commit was performed.

## Delivery strategy

- Delivery strategy: `ask-on-risk`. Forecast at tracker creation: the change
  spans five read operations, four mutation operations, validation, a test
  suite, and three documents — plausibly 400–700 authored lines across units.
  Recompute from work-unit commits; when the running total crosses ~400 authored
  lines, apply the chosen strategy before the next commit.
- Chain strategy: `stacked-to-main` (the user's standing choice). Each unit lands
  on the default branch in order as its own reviewable slice.
- Likely slices (confirm at implementation time): Slice 1 = T1 read tools +
  their T3/T4/T5 parts; Slice 2 = T2 mutations + their T3/T4/T5 parts.

## Progress

| Task | Status  | Notes |
|------|---------|-------|
| T1   | pending | Not started. Read tools (status/diff/log/show/branch). |
| T2   | pending | Not started. Staging and branch mutations. |
| T3   | pending | Not started. Validation and authorization. |
| T4   | pending | Not started. Tests. |
| T5   | pending | Not started. Fragment, manifest, threat model. |

## Evidence

- Tracker created: `odd/tasks/host-git-tools.md` (this file).
- Verified read-only in this session (current file contents; the manifest's cited
  line numbers are stale, see below):
  - `opencode/plugins/sandbox-tools.ts:672-702` — `host_git_commit`.
  - `opencode/plugins/sandbox-tools.ts:704-733` — `host_git_push`.
  - `opencode/plugins/sandbox-tools.ts:57-63` — `READ_ONLY_AGENTS` used only by
    `assertNotOrchestrator` for `sandbox_*` tools.
  - `broker/src/service.ts:1883` — `buildGitCommitOp`; `:1890` authorize;
    `:1899` empty-result refusal; `:1902` protected-path rejection.
  - `broker/src/service.ts:1931` — `buildGitPushOp`; `:1939` authorize;
    `:1956`/`:1965`/`:1975` broker-resolved branch/upstream/ahead.
  - `broker/src/service.ts:147` — `authorizeHostDispatch`.
  - `broker/src/server.ts:394-397` — `gitCommit`/`gitPush` dispatch.
  - `broker/src/types.ts:75-76` — operation union.
  - `broker/src/validation.ts:922-923` — payload allowlists for
    `gitCommit`/`gitPush`.
  - `broker/src/validation.ts:943-962` — `assertPayloadKeys`.
  - `broker/src/validation.ts:750-758` — `HOST_READ_OPERATIONS` (7, no git).
  - `broker/src/validation.ts:761-778` — `HOST_MUTATION_OPERATIONS` (16; git at
    `:763-764`).
  - `broker/src/validation.ts:813-826` — `HostToolPolicy.decide`.
  - `broker/src/gitops.ts:352-360` — `buildGitCommitArgv`.
  - `broker/src/gitops.ts:380-405` — `buildGitPushArgv`.
  - `broker/src/gitops.ts:333-340` — output cap + `capAndRedact`.
  - `broker/src/gitops.ts:242-256` — `checkProtectedPaths`.
  - `broker/src/validation.ts:663-707` — git message/path/remote/branch
    validators.
  - `opencode/config-fragments/sandbox-permissions.jsonc:90-91` — git
    permissions; `:74-81` read tier; `:88-104` mutation ask block.
  - `docs/config-manifest-host-tools.md:269-274` — §5a host git inventory;
    `:241-244` — stale counts (claims 31 host tools / 9 read / 22 mutation;
    observed 23 / 7 / 16); `:273-274` — stale plugin/service/validation line
    refs; `:214`, `:795-796` — permission lists.
- Observed empirically in the sandbox worker (this session):
  - `git branch --show-current` → `work` (synthetic snapshot branch).
  - `git status --porcelain` → only `?? ses_<id>.bundle` (the broker's synthetic
    artifact). The worker's git view is not the host's.
- Reported by the user (not reproduced here): the orchestrator had to ask the
  user to run `git status --porcelain` by hand before a commit plan could be
  assembled.

## Next step

T1 — add the five read tools (status/diff/log/show/branch) with broker
handlers, read classification, payload allowlists, and fixed argv builders,
mirroring the existing host-tool shape. Confirm the S17 review path before any
apply.
