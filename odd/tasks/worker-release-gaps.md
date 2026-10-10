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
- Native review: not run from this session, so `4fbc94c` and `d65518b` are unreviewed. The
  current reviewed boundary was not re-checked here.

## Not verified
- Live behaviour. The running broker still has the old code until the owner restarts it.
  Expected after restart: three `reaped_terminal` log lines within a minute and the three
  `RETAINED` workers gone from `msb ls`.

## Known gap, not fixed here
- The pool is created empty at startup (`server.ts`, `pool: { allocations: [] }`) and is not
  rebuilt from session records, so workers that survive a restart are not counted.

## Next step
Owner reviews `4fbc94c` and `d65518b`, then restarts the broker.
