# Worker release gaps — commit path leak, terminal-state sweep, disconnect reap

## Objective
Every path that ends a session's need for its worker releases the worker and its pool
allocation, and no reaper path destroys unexported edits without trying to export them.

## Problem (observed 2026-10-10)
Three `oc-sandbox-*` workers stayed running after their results were committed, holding three
of the four pool slots (`maxWorkers: 4`). Other sessions queued and `ensureWorker` timed out
after 600 s.

- `buildGitCommitOp` transitions the result session to `RETAINED` without releasing its worker
  (`keepResult` does release). Added in `1f651eb`.
- `sweepIdle` handles only `RESULT_READY` and `SANDBOX_ACTIVE`, so a terminal-state record that
  still holds a worker is never released.
- `reapOnDisconnect` releases an idle `SANDBOX_ACTIVE` worker after 30 s with no dirty check and
  no export, while `sweepUnfinished` exports only after 60 s. A socket close in that window
  discards uncommitted edits. It also ignores `activeLocks` and the pool queue.

## Scope
- `broker/src/service.ts` — `buildGitCommitOp`.
- `broker/src/reaper.ts` — `sweepIdle`, `sweepUnfinished`, `reapOnDisconnect`.
- `broker/tests/service-git-commit-session.test.ts`, `broker/tests/reaper.test.ts`.
- `docs/TODO.md`, this record.

## Constraints
- `broker/src/**` is S17: the user reviews the diff and restarts the broker.
- A failed worker release must never fail or undo a commit that already landed.
- TDD: on (repository convention, AGENTS.md). Runner: `cd broker && bun test`.

## Tasks

- [x] **T1 — release the worker when `gitCommit` retains the result.** Route: inline (one
  source file, one test file). Commit `4fbc94c`.
- [x] **T2 — `sweepIdle` releases a live worker held by a terminal-state session.** Route: inline.
  Commit `d65518b`.
- [x] **T3 — `reapOnDisconnect` exports before releasing, shares one policy with
  `sweepUnfinished`, and honours locks and the queue; `sweepIdle`'s unexported release logs a
  distinct action.** Route: inline. Commit `d65518b` (same file as T2, so one commit).
- [x] **T4 — records:** `docs/TODO.md` entry.

## Acceptance
- After `gitCommit`, the result record has no `workerName`, the adapter saw stop and remove,
  and the pool allocation is gone.
- A `RETAINED`/`APPLIED`/`REJECTED`/`FAILED_CLOSED` record with a live worker is released on
  the next sweep; `CREATING_SANDBOX` and `APPLY_PENDING` are untouched.
- A disconnect with a dirty worker ends in `RESULT_READY` with a `resultRef`; a failed export
  leaves the worker in place.
- `cd broker && bun test` green; `bun build src/main.ts --target=bun` succeeds.

## Progress

### 2026-10-10
- RED observed first for each task: 2 failing tests for T1, 9 for T2/T3 (including the existing
  `sweepIdle` test whose expected action changed to `reaped_active_unsaved`).
- `broker/tests/server-reaper-log-seam.test.ts` needed a clean-tree `exec` stub: with no status
  the reap now treats the worker as dirty and tries to export, which is the intended behaviour.
- `cd broker && bun test`: 836 pass, 0 fail. `bun build src/main.ts --target=bun`: succeeded.
- Native review (2026-10-12): lineage `review-48beb715f4f69712`, base `9604d30` to HEAD
  `43a0395`, committed only, untracked files excluded; 10 files, 796 lines, high risk. Approved
  by all four lenses with no blocking finding, then acknowledged (authority burned). The
  reviewed boundary for this tail is `43a0395`.
- `R4-001` WARNING (review `review-48beb715f4f69712`): fixed by adding the failed-release
  log in the commit after `0398843`; it remained unreviewed at that boundary.
- Remaining advisories from that review, not fixed (fixing would move the boundary):
  - `R1-001` SUGGESTION, `broker/src/reaper.ts:384-399`: the terminal-state release has no age
    check; no reachable data loss, a short race window remains.
  - `R2-001` SUGGESTION, `broker/src/reaper.ts:395-404`: the release/touch/`reapedAt` sequence
    is repeated in several branches and in `releaseRetainedWorker`; a shared helper would help.
  - `R2-002` SUGGESTION, `broker/src/reaper.ts:458-475`: say explicitly that an unknown git
    status is treated as dirty.
- `R3-001` CRITICAL (lineage `review-3a285dbad4589d87`): independently verified against source
  and fixed by guarding the release-error log in commit `c6bff59`. It is covered by the approved
  review `review-263b7dd739be9b2b` (zero findings). The earlier review escalated as
  `unknown_causality` with `R3-001` downgraded to informational; the fresh approval supersedes it.
- Not covered by that review: commits between `bf3c792` and `9604d30` other than the
  socket-lifecycle unit (lineage `review-0789e564b02b5363`). A review of the whole range from
  `bf3c792` was refused with `lens_context_budget_exceeded`, and the CLI reviews only up to
  HEAD, so earlier slices cannot be reviewed in place.

### 2026-10-13 — `R3-001` (lineage `review-3a285dbad4589d87`)
- Baseline before edits: `bun --cwd broker test --reporter=dot` — 837 pass, 0 fail,
  3800 `expect()` calls across 53 files.
- RED against the pre-fix source: the new throwing-logger test failed with
  `Expected promise that resolves` / `Received promise that rejected: Promise { <rejected> }`.
- GREEN focused run: `bun --cwd broker test --reporter=dot tests/service-git-commit-session.test.ts`
  — 27 pass, 0 fail, 92 `expect()` calls.
- Full suite after fix: `bun --cwd broker test --reporter=dot` — 838 pass, 0 fail,
  3802 `expect()` calls across 53 files.
- Build: `bun build --target=bun src/main.ts` from `broker` succeeded.
- `releaseRetainedWorker` now catches only synchronous logger throws; the regression test proves
  the git commit resolves and the session remains `RETAINED` after the release bookkeeping fails.
- `git diff --check` succeeded. The diff contains 52 additions and 16 deletions (70 authored
  changed lines); patch-byte measurement was refused by the sandbox.

## Not verified
- Live behavior: the broker has not been restarted with this change; owner restart is required.

## Known gap, not fixed here
- The pool is created empty at startup (`server.ts`, `pool: { allocations: [] }`) and is not
  rebuilt from session records, so workers that survive a restart are not counted.

## Next step
Owner restarts the broker for the fixes to go live.

## Finding while fixing `R4-001`
`releaseWorker` itself swallows a failed `stop` or `remove` (a retry loop that ignores the
error), so it almost never throws. After it returns, `releaseRetainedWorker` still clears
`workerName` and marks the worker `DESTROYED`. If `msb remove` really fails, the VM stays and
the record no longer points at it, so neither this path nor `sweepIdle` will find it again. The
new log line covers only a throw from the bookkeeping, not a silent remove failure. Not fixed
here: the same pattern is in every release path, so it needs its own unit (report the remove
failure from `releaseWorker`, keep `workerName` when it fails).
