# ODD Tasks — register-project-profile-grants

- **Feature:** `register-project-profile-grants`
- **Project:** `sandbox-integration` (`/home/james/agent-sandbox-integration`)
- **Status:** planned — tracker only; no implementation started
- **Created:** 2026-09-18
- **Delivery strategy:** `ask-on-risk` (default)
- **Chain strategy:** `stacked-to-main` (the user's standing choice)

## Objective

Make project registration grant the per-project nono profile entries that project
types actually need, and migrate the existing registered projects. Concretely:
`scripts/register-project.ts` must add a read-write `<project>/.git` grant and the
pending `.codegraph` create+grant (`docs/TODO.md` item 27) through the same idempotent
profile-writer path that already writes `.atl`, then the existing projects must be
migrated to gain the `.git` grant.

## Problem

`scripts/register-project.ts` today grants each project: the project tree `read`
(`filesystem.read`), and `<project>/.atl` read-write (`filesystem.allow`), plus the
parent auto-update history file. It does **not** grant `<project>/.git` read-write,
and it does not create+grant `<project>/.codegraph` (TODO #27).

The native reviewer relay spawns `gentle-ai review opencode-transport` inside the
secure server's nono sandbox. The transport resolves the opaque repository-context
handle "only through Git's registered sibling worktrees" and then keeps "all
authority, materialization, and capture operations" on that root
(`.sandbox-state/gentle-ai-3.1.0/internal/cli/review_opencode_transport.go:328-334`).
A read-only project grant fails it: with no grant the child exits `binding_invalid`;
with `<project>/.git/gentle-ai` `readwrite` it gets further but stops at
`materialization_unavailable`; with `<project>/.git` `readwrite` it materializes the
provider prompt successfully. The identical command outside the sandbox also
materializes. So `<project>/.git` read-write is required.

The `.git` grant is deliberately broader than the `.atl`/`.codegraph` grants: `.git`
is refs, index, and history, not a tool cache. That boundary must be recorded
explicitly in this tracker and in the threat model, not treated as incidental.

Evidence attribution: the three-state sandbox probe (no grant → `binding_invalid`;
`.git/gentle-ai` → `materialization_unavailable`; `.git` → materializes) was reported
by the user and is recorded as reported evidence. The code path at
`review_opencode_transport.go:328-334` was independently read in this session. The
live probe was not re-run (it would require mutating the live profile, which is out of
scope for this tracker).

## Scope

In-repo only. Files expected to change:

- `scripts/register-project.ts` — the profile-grant writer (S17).
- `nono/profile/opencode-secure.json` — resulting grants, written by the script at
  registration time (S17).
- the test file(s) covering the script's profile-grant behavior (runner to confirm).
- `docs/threat-model.md` — record the `.git` read-write boundary and why it is earned
  (S17).
- `docs/config-manifest-host-tools.md` — update the profile-grant inventory if this
  document records it (not S17).

Out of scope: any deployment, mirror to `~/.config`, service restart, or commit.

## Constraints

- **Idempotent.** Re-registration must be safe: dedupe by path and report
  `already registered`/`skipped`, never duplicate a grant. Mirror the existing
  `updateSkillRegistryGrant` shape (`scripts/register-project.ts:234-277`).
- **`.git` read-write only, never the tree.** Add `<project>/.git` to
  `filesystem.allow`. Do not grant the project tree read-write; the tree stays
  `filesystem.read`. Do not grant `.git`'s contents selectively — the transport needs
  the `.git` root.
- **No directory creation for `.git`.** The script's own `setupGit` runs `git init -b
  main` before the profile grants are written (`scripts/register-project.ts:606` then
  `:619-623`), so `<project>/.git` is guaranteed to exist at grant time. nono binds
  grants to paths that exist at sandbox start; `.git` is already bound by `git init`.
- **Directory creation IS required for `.codegraph`.** Nothing guarantees it exists;
  mirror the `.atl` helper, which `mkdirSync`s the dir after granting
  (`scripts/register-project.ts:269-276`).
- **Existing projects' other grants untouched.** Never rewrite or reorder unrelated
  profile entries; only append the new grant when absent.
- **S17.** `scripts/**` and `docs/threat-model.md` are S17. Agent-authored changes to
  them are reviewed and installed by the user; they are never auto-applied or mirrored
  by an agent.
- **No deploy, mirror, restart, or commit** by the agent.
- Broker code stays dependency-free where touched (`bun:test` + node builtins).

## Tasks

Stable IDs; each task is a reviewable change unit.

### T1 — Add the `<project>/.git` read-write grant (idempotent)

Add `<project>/.git` to `filesystem.allow` through the same code path that writes
`.atl` (`updateSkillRegistryGrant`, `scripts/register-project.ts:234-277`), deduped by
path and appended only when absent. No directory creation (see constraints).

- Files: `scripts/register-project.ts`.
- Done when: a fresh registration adds exactly one `<project>/.git` entry to
  `filesystem.allow`; a repeat registration adds nothing and reports
  already-registered.

### T2 — Add the `.codegraph` create+grant (pending `docs/TODO.md` item 27)

Create + grant `<project>/.codegraph` in `filesystem.allow`, mirroring the `.atl`
create+grant helper, through the same code path. Pair the grant with directory
creation because nono binds grants to existing paths at sandbox start.

- Files: `scripts/register-project.ts`.
- Done when: a fresh registration creates `<project>/.codegraph` and adds exactly one
  `filesystem.allow` entry for it; a repeat registration is a no-op for both.

### T3 — Tests covering the profile-grant behavior

Cover: T1 and T2 add the grants; repeat runs are idempotent; `filesystem.read` still
carries the project tree and is unchanged; unrelated grants (`.atl`, auto-update
history) are preserved; `--dry-run` performs no write and no directory creation.

- Files: whichever test runner owns script tests; verify the existing convention
  before choosing (`broker/tests/**` uses `bun:test`).
- Done when: RED→GREEN evidence is captured for the new assertions and the existing
  suite stays green.

### T4 — Migrate the nine existing registered projects

Run the updated registration path (idempotent) so each existing registered project
gains the `<project>/.git` grant. Existing entries are untouched.

- Target set: the nine `PROJECT_ROOTS` in `scripts/secure-launcher.conf:32-42`.
  Count corroboration: `nono/profile/opencode-secure.json` `filesystem.read` lists 10
  roots (`:67-78`) because it additionally includes this repository
  (`$HOME/agent-sandbox-integration`), which is not in `PROJECT_ROOTS`; the
  authoritative `BROKER_PROJECTS` in `~/.config/opencode-sandbox/broker.env` could not
  be read in this session (permission denied), so the migration set must be resolved
  against it at execution time.
- Files: `nono/profile/opencode-secure.json` (S17; written idempotently by the script).
- Done when: all migrated projects show the `.git` grant exactly once and every other
  grant is byte-preserved.

### T5 — Documentation

- `docs/threat-model.md`: record the `<project>/.git` read-write boundary and why it
  is earned (native reviewer relay materialization), and note it is broader than
  `.atl`/`.codegraph` because `.git` is refs, index, and history. S17.
- `docs/config-manifest-host-tools.md`: update its profile-grant inventory (section 7
  references the `.atl`/`.codegraph` write roots at `:435-442`) if it inventories
  per-project grants. Not S17.

Done when both documents match the implemented grants.

## Acceptance criteria

1. A fresh project registration adds exactly one `<project>/.git` entry to
   `filesystem.allow` and never grants the project tree read-write.
2. A fresh project registration creates `<project>/.codegraph` and adds exactly one
   matching `filesystem.allow` entry (TODO #27).
3. Repeat registration of the same project is a no-op for both new grants.
4. Existing `.atl`, auto-update history, `filesystem.read`, `broker.env`, and
   `secure-launcher.conf` behavior is unchanged.
5. The nine existing projects each carry the `.git` grant exactly once after
   migration.
6. Tests cover the new behavior and the existing suite is green.
7. `docs/threat-model.md` records the `.git` boundary and rationale.

## Checks

- `bun --cwd broker test` (or the runner owning the new script tests — confirm first).
- A dry-run registration (`bun scripts/register-project.ts --dry-run <path>`) reports
  the intended `.git` and `.codegraph` grants without writing.
- Manual diff readback of the S17 profile before/after the migration.
- No live probe of the reviewer transport is claimed as a check; the sandbox probe
  results are recorded evidence from the user, not reproduced here.

## Authorized scope

Authorized: implement T1–T5 and the tracker's own bookkeeping as reviewable change
units under the ODD work-unit rule, with sandbox-only mutation.

Not authorized by this tracker: deployment, mirroring to `~/.config`, service restart,
commit/push/PR/merge/release, or any change that weakens a permission. T4 is a live
host migration against an S17 profile — the user applies it.

## Delivery strategy

- Delivery strategy: `ask-on-risk`. Forecast at tracker creation: the change is small
  (one profile-writer helper, one test file, two docs). Recompute from work-unit
  commits; when the running total crosses ~400 authored lines, apply the chosen
  strategy before the next commit.
- Chain strategy: `stacked-to-main` (the user's standing choice). Each unit lands on
  the default branch in order as its own reviewable slice.
- Slice boundaries to confirm at implementation time; likely Slice 1 = T1+T2+T3
  (script + tests), Slice 2 = T4 (profile migration), Slice 3 = T5 (docs).

## Progress

| Task | Status  | Notes |
|------|---------|-------|
| T1   | pending | Not started. |
| T2   | pending | Not started. |
| T3   | pending | Not started. |
| T4   | pending | Not started. Depends on T1 + user-applied S17 changes. |
| T5   | pending | Not started. Depends on T1/T2 final shape. |

## Evidence

- Tracker created: `odd/tasks/register-project-profile-grants.md` (this file).
- Verified read-only in this session:
  - `scripts/register-project.ts:9-15` — header lists the three outputs: nono profile,
    `broker.env`, `secure-launcher.conf` PROJECT_ROOTS.
  - `scripts/register-project.ts:162-177` — `updateProfile` writes the project tree
    into `filesystem.read`; dedupe at `:171`, push at `:173`, `atomicWrite` at `:174`.
  - `scripts/register-project.ts:234-277` — `updateSkillRegistryGrant` writes
    `<project>/.atl` into `filesystem.allow` (read-write); dedupe at `:260`, push at
    `:265`, `atomicWrite` at `:266`; creates the directory at `:275`. This is the code
    path T1/T2 must mirror.
  - `scripts/register-project.ts:189-233` — `updateAutoUpdateGrant` writes the parent
    `.auto-update-history.json` into `filesystem.allow_file` and seeds the file
    (`:231`).
  - `scripts/register-project.ts:606` then `:619-623` — `setupGit` (which runs
    `git init -b main`, `:441-449`) executes before the profile-grant writers, so
    `<project>/.git` exists by grant time.
  - `docs/TODO.md:38` — pending item 27: create + grant `<project>/.codegraph`
    mirroring the `.atl` helper, paired with directory creation because nono binds
    grants to existing paths at sandbox start.
  - `nono/profile/opencode-secure.json:67-78` — project trees are `filesystem.read`
    (10 roots). `:22-56` — `.atl` and `.codegraph` per project are
    `filesystem.allow` (read-write). No `.git` entry exists.
  - `docs/config-manifest-host-tools.md:435-442` — documents the profile's
    `.atl`/`.codegraph` write roots (section 7).
  - `.sandbox-state/gentle-ai-3.1.0/internal/cli/review_opencode_transport.go:328-334`
    — "Resolve the opaque binding only through Git's registered sibling worktrees,
    then keep all authority, materialization, and capture operations on that root";
    `binding_invalid` returned at `:333`.
  - `scripts/secure-launcher.conf:32-42` — 9 `PROJECT_ROOTS` entries.
  - `~/.config/opencode-sandbox/broker.env` — **unreadable** in this session
    (permission denied), consistent with `docs/config-manifest-host-tools.md:477-480`.
    The authoritative registered set could not be read directly.
- Reported by the user (not re-run here; recorded as reported evidence):
  - No `.git` grant → child exits `binding_invalid`.
  - `<project>/.git/gentle-ai` read-write → stops at `materialization_unavailable`.
  - `<project>/.git` read-write → provider prompt materializes successfully; the
    identical command outside the sandbox also materializes.

## Next step

T1 — add the idempotent `<project>/.git` read-write grant to the profile writer in
`scripts/register-project.ts`, mirroring `updateSkillRegistryGrant`
(`scripts/register-project.ts:234-277`). Confirm the S17 review path before any apply.
