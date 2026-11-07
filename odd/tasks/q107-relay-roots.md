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
- Post-review corrections F1 and F2 (see that section) and the worktreeRoot
  documentation update.

Out of scope:

- The `.git` write grant in `nono/profile/**`.
- `systemd-user/broker.env` / `BROKER_PROJECTS` changes.
- H-S1 / H-S2 (broader tracker scope, not regressions).

## Constraints

- Fail closed: relative, symlinked, non-canonical, unregistered,
  prefix-lookalike, forged back-link, and forged `commondir` roots refuse with
  `reviewer_relay_root_refused` before any child exists.
- Acceptance is common-directory equality. A path-prefix comparison may only
  refuse a git directory contained inside the worktree; it never accepts.
- Metadata reads must never block: a FIFO or other non-regular file at
  `.git`, `gitdir`, or `commondir` refuses promptly.
- Exact allowlisted-root behavior and every existing relay test stay unchanged.
- S17: `opencode/plugins/**`, `scripts/**` and `docs/threat-model.md` are
  owner-installed. The orchestrator installs results; the owner commits.

## Tasks

- [x] T1 — RED tests: linked worktree of a registered project accepted;
  unregistered repo, symlinked path, and path-prefix lookalike refused; forged
  back-link and forged `commondir` refused; existing relay tests unchanged.
- [x] T2 — implementation in `reviewer-relay-core.ts`: default
  `gitCommonDirectory` probe plus optional injection through
  `RootSelectionInput` and `SessionRootResolutionDeps`.
- [x] T3 — spec requirement/scenarios plus the module header comment.
- [x] T4 — post-review F1: non-blocking metadata opens and the FIFO tests.
- [x] T5 — post-review F2: canonical worktree-root validation in
  `scripts/register-project.ts` (separate commit from Q107).
- [x] T6 — post-review docs: worktreeRoot payload and argv in
  `docs/threat-model.md`.
- [x] T7 — closure: owner committed the three groups (3a847ca, 35ac5cb,
  5bc893c); native review of the committed range is APPROVED and acknowledged.

## Acceptance criteria

- `selectCanonicalSessionRoot` accepts a verified linked worktree of a
  registered project and still accepts an exact allowlisted root.
- Unregistered repo/worktree, symlink alias, `<root>-lookalike` prefix path,
  forged `gitdir` back-link, forged `commondir`, and FIFO metadata files all
  refuse.
- `resolveWorktreeTarget` validates the canonical root before any write and
  refuses a symlink alias to a banned directory.
- Focused relay and worktree-root tests green; the full broker suite shows no
  new failure beyond the four that also fail at base `4d32ff7`.

## Checks

- `bun --cwd broker test tests/reviewer-relay-transport.test.ts`
- `bun --cwd broker test tests/register-worktree-root.test.ts`
- `bun --cwd broker test`

## Route / trigger

ROUTE: small feature + post-review fix | intent: authorized change | route: ODD
secure | specialist: pm-odd plus sandbox writers | basis: WORKFLOW.md
Trigger: secure always-delegate (any mutation); F2 is an independent fix unit
that must land as its own commit.
Actual dispatch: pm-odd unit `q107-relay-roots-u1` (session
`ses_e493c0d0bffeyutbM4t2uFfUEF`), writer `odd-apply` session
`ses_e49399f23ffeFjdK88RXKmhzV3`; corrections in sessions
`ses_e49076466ffeFcK7BXj4LUdYYF` (F1), `ses_e49076467ffejXiJK2h3OvMQka` (F2),
`ses_e48f0cf9affeKFQ0AVdJZ8vOsi` (docs), with a read-only seam check in
`ses_e48f0cf9bffeF9sO0MSZm3bf6T`.

## Authorized scope

- `opencode/plugins/lib/reviewer-relay-core.ts`
- `broker/tests/reviewer-relay-transport.test.ts`
- `openspec/specs/reviewer-relay-transport/spec.md`
- `scripts/register-project.ts`
- `broker/tests/register-worktree-root.test.ts`
- `docs/threat-model.md`

## Observed evidence

Writer checks (sandbox, foreground):

- `bun --cwd broker test tests/reviewer-relay-transport.test.ts` before the
  implementation: 89 pass, 2 fail — exactly the two new acceptance tests, with
  `reviewer_relay_root_refused` from the old exact-match rule.
- Same file after the implementation: 91 pass, 0 fail, 411 `expect()` calls.
- `bun --cwd broker test` (full): 1934 pass, 10 skip, 4 fail across 107 files.
  The four: `tests/v2-launch.test.ts:94` and three `EACCES mkdir /nonexistent`
  failures in `tests/staging-stage-ops.test.ts:229,251` and
  `tests/gate-verdict-auto.test.ts:318`.

Reviewability receipt (initial unit): 303 authored changed lines, 18,477 patch
bytes, no generated or binary paths. Result `ef912c34d54e9f1754fa864484fc06afc5755380`.

## Advisories and verification

- Planner and `advisor-*-pre` / `advisor-*-post` are not in the PM subagent
  catalog, so the pre-code and post-code advisory phases were recorded as
  missing opinions, never approvals. `ce:review` was not selected on this
  route.
- `aft_inspect` scoped diagnostics reported PARTIAL (no workspace root marker);
  the candidate is transpiled by `bun test` without typecheck.
- Independent verifier (initial unit): F1 evidence availability failed; F2/F3/F4
  adjudicated as non-blocking. Tier 4 (Codex) then found the two real defects
  fixed below.
- Integrity observation from a Tier 4-adjacent review of the first verifier:
  the earlier "no code defect" adjudication was wrong about FIFO blocking, which
  is why F1 is now a code change, not an advisory.

## Post-review corrections (Tier 4, Codex — verdict FLAWS_FOUND)

### F1 — non-blocking, no-follow metadata reads

`readBoundedFirstLine` opened `.git`, `gitdir` and `commondir` with
`O_RDONLY | O_NOFOLLOW`. Opening a FIFO read-only without `O_NONBLOCK` blocks
until a writer appears, so a FIFO at `gitdir` or `commondir` wedged the relay
before the `fstatSync(...).isFile()` guard ran.

Fix: `GIT_DIRECTORY_FILE_FLAGS` is now
`O_RDONLY | O_NOFOLLOW | O_NONBLOCK`; the existing regular-file guard refuses a
FIFO immediately, returning null. Result
`a98ecd6668ba04fe109f3a15ccc1c75477228b86`, installed (48 authored lines).

Observed:

- RED-FIFO before the fix: `timeout 25 bun --cwd broker test ... -t "FIFO"` ran
  the full budget and the runner reported `terminated by signal SIGTERM` — the
  pre-fix open blocks. The sandbox surface does not expose an exit code, so the
  signal message is the evidence, not a `124`.
- RED-fixture before the fix: the corrected forged-back-link test already passed
  (2 pass). The fixture was wrong, not the code: the produced refusal came from
  the back-link check once the git dir lived in the registered repo, so there is
  no behavioural RED for that fixture change. Recorded rather than invented.
- GREEN focused: 94 pass, 0 fail (both FIFO tests ran, `mkfifo` available).

Tests added: a FIFO `gitdir`, a FIFO `commondir`, both refused promptly; the
forged back-link fixture moved inside the registered repo
(`<gitProjectRoot>/.git/worktrees/forged-backlink`) so only the back-link check
can refuse it; positive control `control-worktree` accepted.

### F2 — canonical worktree-root validation (`scripts/register-project.ts`)

`planWorktreeTarget` checked bans lexically, `ensureWorktreeProjectDir` created
directories before `validateProject` ran, the raw root was registered, and
`--worktree-root` silently ignored `--create-remote` / `--public`.

Fix, delivered as its own change set (separate commit): exported
`canonicalRootForRegistration`, `resolveWorktreeTarget` and
`worktreeFlagConflict`. The canonical root and canonical target are banned
before any `mkdir` or config write; an existing symlink target is resolved,
banned-checked and required to stay strictly under the root (dangling symlinks
refuse); only `<root>/<project>` is created; the canonical root is what gets
written to the profile, `BROKER_PROJECTS` and the launcher; the flag
combination exits 2 before any write. Result
`ed66a804aa074d9310256ef5047f77deafe1786b`, installed (202 authored lines).

Observed:

- RED: the first run failed on the missing exports (compile-level), then the
  dangling-symlink test failed against the implementation and drove a
  correction; the behavioural RED is that case, not the export error.
- GREEN focused: 28 pass, 0 fail.
- The broker independently performs the same canonical validation
  (`assertRegisterableWorktreeTarget`) and rejects the flag combination before
  spawn; the script fix is the defence for direct CLI use.

### Base-commit evidence for the four suite failures

Run from a detached worktree of `4d32ff7f824ab90e9f9cf4db063c44b15fa71f8e`
(outside the feature worktree), all four fail at base:

- `tests/v2-launch.test.ts:94` FAIL — the received V2 host list additionally
  contains `platform.claude.com`, so this is NOT caused by a local uncommitted
  profile edit; it reproduces on committed base content.
- `tests/staging-stage-ops.test.ts:229` and `:251` FAIL — `EACCES mkdir
  '/nonexistent'`.
- `tests/gate-verdict-auto.test.ts:318` FAIL — `EACCES mkdir '/nonexistent'`.

Caveat: the base run executed from `/tmp`, which additionally fails seven
registration tests on the `/tmp` ban (environmental to that location, absent
from this worktree). The base full-suite totals were truncated in the captured
output; the four target tests were each run individually and observed failing.

### Docs

`docs/threat-model.md` section "Host project registration
(`host_register_project`) and S17 rollout" now documents
`[--worktree-root]`, the exact payload `{path,dryRun,createRemote,makePublic,worktreeRoot}`,
canonical lexical+canonical validation before spawn, canonical-root
registration by the script, and the rejected flag combination. Result
`43827a9ebb49efda8943aebd8b0419b6c1da9416`.

### Seam check after both installs

- `tests/reviewer-relay-transport.test.ts`: 94 pass, 0 fail (FIFO tests ran).
- `tests/register-worktree-root.test.ts`: 28 pass, 0 fail.
- Full suite: the same four failures, no new ones.

## Native review — committed range 4d32ff7..5bc893c

- Mode: receipt-driven development `on`, decided by `global`.
- Candidate: lineage `review-8c4dac912bf43c8b`, target
  `sha256:dd4b20be3382e61ec3f2e9f89184ad0e7031781c9f8520f86971b3ea9f524e28`,
  base tree `9daa38d5df4dcf481601619007202f20ee5cf2b2`, candidate tree
  `3996e47d4cb1f061d7b973adb0426500861a57ae`, projection `workspace`,
  committed-only, 9 changed files, 870 changed lines.
- Consent: the provider returned `review-integration.consent/v3`; the exact
  envelope was presented to the owner, who chose "Review this change". The
  agent never granted, answered or bypassed consent.
- Lenses: `review-risk`, `review-resilience`, `review-reliability`, dispatched
  in one wave to the relay lanes `asi-review-risk`, `asi-review-resilience`,
  `asi-review-reliability` with the provider-issued binding line forwarded
  unchanged.
- Outcome: **APPROVED**. Three lens captures admitted (risk
  `rart1_b13deb72aa18b5678d430b247c42d00820996dbd7ec2070e4a4179c70205f10f`,
  reliability
  `rart1_c91b3ba5b18c397659b3edb7209830897effef1927fa73f24ad27d4156127d9a`,
  resilience completed the set). Closure
  `review-last-event-closure/v1` state `approved`; acknowledged with the
  provider token as `review-acknowledged/v1`, consumed revision
  `sha256:1a19d69d2d156c131755d35b0f6a81aef53a2f86a82cc9507de301c6a7491d2b`,
  authority `burned`.
- Risk lens: no findings.
- Resilience lens (3, all non-blocking, `informational`):
  - `R4-probe-cost` WARNING — worktree acceptance adds an un-memoized
    O(allowlist) synchronous probe per selection, because the cached root is
    revalidated through the full check and each probe does realpath plus lstat
    plus bounded opens. Grows with `BROKER_PROJECTS` on a slow backing store.
  - `R4-error-class-blend` SUGGESTION — `resolveWorktreeTarget` returns
    unexpected filesystem errors in the same `{error}` shape as policy
    refusals, so a transient I/O failure reads like a banned-root refusal.
  - `R4-fifo-boundary` SUGGESTION — a first line spanning the 4096-byte read
    window, or a multi-byte character split at the edge, fails closed as null;
    no realistic git file reaches it today.
- Reliability lens (6, all non-blocking, `informational`):
  - `R3-001` WARNING — the FIFO fixtures ignore `makeFifo`'s boolean, so a
    failed `mkfifo` makes the test pass on ENOENT without a FIFO.
  - `R3-002` WARNING — the new worktree-root test block hard-wires `/dev/shm`
    as its base, a Linux-only dependency, although `tmpdir()` is already
    imported.
  - `R3-003` WARNING — acceptance does not require the session root to be a
    linked worktree, so a plain checkout can be accepted when an allowlisted
    linked worktree of the same repository exists; no test refuses that case.
  - `R3-004` WARNING — `canonicalRootForRegistration` uses `existsSync`, which
    is false for a dangling symlink, so the walk can treat the symlink name as
    a missing segment and return a lexical root.
  - `R3-005` WARNING — the canonical ban check passes the lexical `home`;
    `home` is never canonicalised, so a symlinked `$HOME` weakens the canonical
    ban.
  - `R3-006` SUGGESTION — the "canonical target into a banned directory" test
    reuses the previous fixture and adds no independent coverage.
- No refuter or validator was part of the provider's plan, so none was
  dispatched; no correction was opened, and none of the above may reopen this
  candidate. Claims are recorded as the lenses reported them; they were not
  re-verified after acknowledgement, because the candidate is frozen and the
  authority is burned.
- Follow-ups for later work (never a re-run of this candidate): `R3-003` and
  `R3-004` deserve a real check before the guard is relied on outside this
  repository; `R3-001`, `R3-002` and `R3-006` are test-quality fixes;
  `R4-probe-cost` needs a cache or short-circuit if `BROKER_PROJECTS` grows.

## Progress

- 2026-11-07: tracker created; exploration complete (design note below).
- 2026-11-07: initial implementation installed; checks observed.
- 2026-11-07: Tier 4 corrections F1 and F2 implemented, installed and checked;
  docs updated; base-commit evidence collected.
- 2026-11-07: owner committed the three groups (3a847ca relay, 35ac5cb
  registration, 5bc893c docs).
- 2026-11-07: native review of `4d32ff7..5bc893c` APPROVED and acknowledged;
  advisory findings recorded above.

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
5. Every metadata read is `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` and requires a
   regular file on the descriptor, so a FIFO or device cannot block or be read.

## Next step

The reviewed candidate is approved and its authority burned. Delivery is
owner-owned: push, PR and merge are separate decisions. Later, non-blocking
follow-ups are the reliability and resilience advisories listed above; none of
them reopens this candidate.


## Revisions
- r1 2026-11-07T16:06:30Z gentle-orchestrator: Create Q107 tracker: reviewer relay accepts verified linked worktrees by git common dir
- r2 2026-11-07T16:43:55Z gentle-orchestrator: Record Q107 dispatch, checks, receipt, install and advisories
- r3 2026-11-07T17:55:08Z gentle-orchestrator: Record Tier 4 corrections F1 (O_NONBLOCK/FIFO), F2 (canonical worktree root), docs, base-commit evidence and the seam check
- r4 2026-11-07T21:38:54Z gentle-orchestrator: Record the native review outcome for 4d32ff7..5bc893c: APPROVED, acknowledged, with advisory findings
