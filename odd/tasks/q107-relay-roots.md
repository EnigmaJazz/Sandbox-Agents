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

- [x] T1 — RED tests: linked worktree of a registered project accepted;
  unregistered repo, symlinked path, and path-prefix lookalike refused; forged
  back-link and forged `commondir` refused; existing relay tests unchanged.
- [x] T2 — implementation in `reviewer-relay-core.ts`: default
  `gitCommonDirectory` probe plus optional injection through
  `RootSelectionInput` and `SessionRootResolutionDeps`.
- [x] T3 — spec requirement/scenarios plus the module header comment.
- [ ] T4 — closure: owner commit of the S17 bytes, then the committed-candidate
  native review assessment.

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
specialist: pm-odd, writer odd-apply | basis: WORKFLOW.md
Trigger: secure always-delegate (any mutation) plus the two-step substantial
test (implementation + tests + normative spec).
Actual dispatch: pm-odd unit `q107-relay-roots-u1` (session
`ses_e493c0d0bffeyutbM4t2uFfUEF`), writer `odd-apply` session
`ses_e49399f23ffeFjdK88RXKmhzV3`.

## Authorized scope

- `opencode/plugins/lib/reviewer-relay-core.ts`
- `broker/tests/reviewer-relay-transport.test.ts`
- `openspec/specs/reviewer-relay-transport/spec.md`

## Observed evidence

Writer checks (sandbox, foreground):

- `bun --cwd broker test tests/reviewer-relay-transport.test.ts` before the
  implementation: 89 pass, 2 fail — exactly the two new acceptance tests, with
  `reviewer_relay_root_refused` from the old exact-match rule.
- Same file after the implementation: 91 pass, 0 fail, 411 `expect()` calls.
- `bun --cwd broker test` (full): 1934 pass, 10 skip, 4 fail across 107 files.
  The four: `tests/v2-launch.test.ts:94` (the known owner nono-profile drift)
  and three `EACCES mkdir /nonexistent` environmental failures in
  `tests/staging-stage-ops.test.ts:229,251` and
  `tests/gate-verdict-auto.test.ts:318`, files that do not import relay code.

Reviewability receipt: 303 authored changed lines, 18,477 authored patch bytes,
no generated or binary paths.

Install: `host_sandbox_result_install` restored the three paths from result
`ef912c34d54e9f1754fa864484fc06afc5755380`; the result preview was reviewed
before install (`patchTruncated: false`).

## Advisories and verification

- Planner and `advisor-*-pre` / `advisor-*-post` are not in the PM subagent
  catalog, so the pre-code and post-code advisory phases were recorded as
  missing opinions, never approvals. `ce:review` was not selected on this
  route.
- `aft_inspect` scoped diagnostics reported PARTIAL (no workspace root marker);
  the candidate is transpiled by `bun test` without typecheck.
- Independent verifier: attempt 1 blocked on sandbox-git access (0 checks);
  attempt 2 returned FAIL-incomplete on evidence availability plus inferred
  F2/F3/F4. Adjudication: F2 (symlink-swap TOCTOU) refuted as an acceptance
  bypass because acceptance still requires a registered project's common
  directory; F3 (FIFO `openSync`) is DoS-only and out of the unauthorized-
  acceptance threat model; F4 (forged-backlink fixture also fails the
  common-dir check) is a valid test-hardening note. No correction round was
  consumed; F2-F4 are non-blocking follow-ups.

## Progress

- 2026-11-07: tracker created; exploration complete (design note below).
- 2026-11-07: implemented and installed; checks observed. Bytes are uncommitted
  in the worktree because `opencode/plugins/**` is S17 and `host_git_commit`
  refuses protected paths. Owner commit is the next step.

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

Owner reviews and commits the three installed S17 paths. Then assess the
committed candidate with `base-ref` = the last reviewed boundary (`4d32ff7`,
the branch point) and run the due native review; record the outcome here.


## Revisions
- r1 2026-11-07T16:06:30Z gentle-orchestrator: Create Q107 tracker: reviewer relay accepts verified linked worktrees by git common dir
- r2 2026-11-07T16:43:55Z gentle-orchestrator: Record Q107 dispatch, checks, receipt, install and advisories
