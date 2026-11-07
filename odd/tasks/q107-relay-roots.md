# Q107 — reviewer relay roots for linked worktrees

## Objective

Make the reviewer relay accept a canonical linked git worktree whose git common
directory is the common directory of a broker-registered project, so a new
worktree needs no `BROKER_PROJECTS` edit and no broker restart for the
`asi-review-*` lanes. The decision is by git common directory, never by path
prefix, and anything that does not resolve to a registered project refuses
before any child spawns.

## Problem

`opencode/plugins/lib/reviewer-relay-core.ts:240 selectCanonicalSessionRoot`
accepts a session root only when it is exactly equal to a `policy.projects`
path. The broker reads `BROKER_PROJECTS` once at startup, so every linked
worktree under `~/ai-workspace/worktrees/...` is refused
(`reviewer_relay_root_refused`) even though it belongs to a registered
repository. First observed on the pm-only-clone review.

## Scope

In scope:

- `opencode/plugins/lib/reviewer-relay-core.ts` — verified linked-worktree
  acceptance by git common directory, using git's own `gitdir` back-link and a
  pinned `commondir`; exact allowlist equality is unchanged.
- `broker/tests/reviewer-relay-transport.test.ts` — RED-first contract tests.
- `openspec/specs/reviewer-relay-transport/spec.md` — normative requirement.

Out of scope:

- The `.git` write grant in `nono/profile/**`.
- `systemd-user/broker.env` / `BROKER_PROJECTS` changes.

## Constraints

- Fail closed: relative, symlinked, non-canonical, unregistered,
  prefix-lookalike, forged back-link, and forged `commondir` roots refuse with
  `reviewer_relay_root_refused` before any child exists.
- Acceptance is common-directory equality. A path-prefix comparison may only
  refuse a git directory contained inside the worktree; it never accepts.
- Exact allowlisted-root behavior and every existing relay test stay unchanged.
- S17: `opencode/plugins/**` is owner-installed. The sandbox result is installed
  by the orchestrator; the owner commits.

## Tasks

- T1 — RED tests: linked worktree of a registered project accepted; unregistered
  repo, symlinked path, and path-prefix lookalike refused; forged back-link and
  forged `commondir` refused; existing relay tests unchanged.
- T2 — implementation in `reviewer-relay-core.ts`: default
  `gitCommonDirectory` probe plus optional injection through
  `RootSelectionInput` and `SessionRootResolutionDeps`.
- T3 — spec requirement/scenarios plus the module header comment.
- T4 — checks: focused relay test file, full broker suite, reviewability
  receipt.

## Acceptance criteria

- `selectCanonicalSessionRoot` accepts a verified linked worktree of a
  registered project and still accepts an exact allowlisted root.
- Unregistered repo/worktree, symlink alias, `<root>-lookalike` prefix path,
  forged `gitdir` back-link, and forged `commondir` all refuse.
- Focused relay tests green; the full broker suite shows no new failure.

## Checks

- `bun --cwd broker test tests/reviewer-relay-transport.test.ts`
- `bun --cwd broker test` (known pre-existing failure `tests/v2-launch.test.ts:94`
  when the owner's uncommitted nono profile edit is present)

## Route / trigger

ROUTE: small feature | intent: authorized change | route: ODD secure (pm-odd) |
specialist: pm-odd (writer odd-apply) | basis: WORKFLOW.md
Trigger: secure always-delegate (any mutation) plus the two-step substantial
test (implementation + tests + normative spec).
Actual dispatch: pending.

## Authorized scope

- `opencode/plugins/lib/reviewer-relay-core.ts`
- `broker/tests/reviewer-relay-transport.test.ts`
- `openspec/specs/reviewer-relay-transport/spec.md`

## Progress

- 2026-11-07: tracker created; exploration complete (design note below).

## Design note

Verified linked-worktree probe (`gitCommonDirectory`):

1. `<root>/.git` must be a directory (plain checkout root) or a regular file
   (linked-worktree pointer). A symlink or any other type refuses.
2. File pointer: `gitdir: <path>` must resolve to a canonical directory,
   structured as `<repo>/.git/worktrees/<name>`, outside `<root>`, and its
   `gitdir` file must name this worktree's `.git` (git's own back-link).
3. `commondir` must exist, resolve to a canonical directory, and equal
   `<gitdir>/../..`, so a worktree cannot forge a foreign common directory.
4. Accept only when the session common directory equals the common directory of
   an allowlisted project root.

## Next step

Dispatch the implementation unit; fill in actual dispatch and check evidence.


## Revisions
- r1 2026-11-07T16:06:30Z gentle-orchestrator: Create Q107 tracker: reviewer relay accepts verified linked worktrees by git common dir
