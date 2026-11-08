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

## 2026-11-08 — Q114: prompt slot release, pressure sweep, occupancy visibility

**Problem (observed).** Broker journal 2026-11-07 15:00–17:46 with `maxWorkers: 4`: three
`ensureWorker` calls failed with `queued ... timed out after 600000ms` (17:29, 17:39, 17:41);
two more waited 576 s and 77 s. Each wait ended only when the reaper logged
`reaped_result_ready`. `sweepIdle` released a `RESULT_READY` worker only after `reapIdleMs`
(default 3,600,000 ms, `broker/src/config.ts:510`), although the result was already host-side.
With `sandbox_apply` unused, a finished worker held a slot for up to an hour. `d65518b` already
releases on terminal states, so this is a different path; which states held the slots was not
confirmed, so the occupancy log now records it. Host sample 17:45: 16 cores, load 1.4, 29 GiB
RAM with 6.5 GiB available, live sandbox VMs 139–458 MiB each; per-worker peak under test
runners is unmeasured.

**Route / trigger.** ROUTE: bug investigation + bounded behaviour change | intent: authorized
change | route: ODD secure | specialist: pm-odd, writer odd-apply | basis: WORKFLOW.md.
Trigger: secure always-delegate (every mutation); S17 review by the owner.
Units: `q114-worker-release-u1` (PM `ses_e46079d08ffeCJOJP3V3wC76Z7`, writer `odd-apply`
`ses_e4606fc85ffe3Nh0FeDfaR2qes`, result `ac2df8c`); `u2` (PM `ses_e45ec8c94ffe5QnmLuWJ9poOun`,
writer `ses_e45ebb83cffe5uJcmCUo1CvNEO`, result `6c6a82f`); `u3` correction (PM
`ses_e45ba63bcffevvDF1wX58M7zit`, writer `ses_e45b9e365ffeeNTGQ1SYuTfBrY`, result `82ed211`).

### T5 — release at `RESULT_READY` + pool-occupancy observability  [installed, uncommitted]
- `buildPrepareResultOp` releases the worker after a successful export, keeping state
  `RESULT_READY` and `resultRef`, so apply/preview/retain/discard are unaffected (in u1; u2
  corrected the re-finish shape to `imported: false`).
- `sweepIdle` releases a `RESULT_READY` record without the `idleMs` age gate (safety net).
- `describePoolOccupancy` logs `queue_wait` / `queue_timeout` with queue depth, pool allocations
  and every held session's `sessionID`, state, `workerState`, age and `workerName`; the
  `QueuedTimedOutError` message carries the same snapshot and tells the delegating session to
  report blocked to its coordinator.
- Observed (u1 writer): focused `tests/reaper.test.ts tests/queue.test.ts
  tests/service-apply.test.ts` — 48 pass, 0 fail, 274 `expect()` calls.

### T6 — `sandbox_finish` idempotency + staging test  [installed, uncommitted]
- A re-finish on `RESULT_READY` with no live worker returns the existing `resultRef` with
  `imported: false` and makes no adapter call; a live worker still re-exports.
- `broker/tests/staging-chain.test.ts` re-ensures a worker before the second finish and before
  the changed-content write, keeping the same-stage-commit, `already pinned` and
  `nextSnapshot === null` assertions.
- Observed (u2 writer): focused 70 pass, 0 fail, 403 `expect()`; full suite 1974 tests, 5
  failures, all the pre-existing set; build succeeded.

### T7 — pressure-aware release  [installed, uncommitted]
- `releaseUnderPressure(ctx, exceptSessionID?)` runs best-effort from `parkAndWait` before
  parking. `RESULT_READY` and clean `SANDBOX_ACTIVE` workers are released; a dirty or unreadable
  status is skipped as `pressure_skipped_dirty`. Skips the requester, `APPLY_PENDING`,
  `CREATING_SANDBOX`, queued, locked and finishing records.
- `sweepIdle`'s blind `reaped_active_unsaved` branch is gone: `SANDBOX_ACTIVE` goes through the
  export-first policy, with a `prepare` seam threaded from `runReaperSweeps`.

### T8 — sizing input
- `BROKER_MAX_WORKERS` added as `positiveIntEnv("BROKER_MAX_WORKERS", 4)`; aggregates untouched.
- Per-worker peak: NOT MEASURED. `/usr/bin/time`, `/bin/time`, busybox `time` and `gtime` are
  all absent inside the worker, so no figure exists and none was invented.
- Recommendation: keep 4. `computeBudget` takes the minimum of `maxWorkers` and the CPU/RAM
  caps, so `maxWorkers` alone cannot raise the effective pool; with `perWorkerCpu: 2` and
  `perWorkerMemBytes: 2 GiB` against `maxAggregateCpu: 8` / `maxAggregateMemBytes: 8 GiB`, the
  effective cap is 4. Raising it needs the aggregates raised in step (5 → 10/10 GiB,
  6 → 12/12 GiB) plus at least 12 GiB genuinely free at peak; the 2026-11-07 sample had 6.5 GiB.

### T9 — correction: no release without an export decision, and mutual exclusion  [installed]
Findings came from an independent verifier pass (static only: its own worker was queued out
after 600 s, the defect under repair).
- Every live-worker release in `sweepIdle` and `releaseUnderPressure` runs through
  `guardedRelease`, which takes `withFinishGuard` and re-checks `releasableRecord` after the
  claim; a rejected claim or a changed record is a quiet `release_skipped_busy`, never a throw.
- A live `RESULT_READY` worker is released only through the export-before-release policy
  (`finishOrReleaseGuarded` with `fromState: "RESULT_READY"`): clean → release, dirty →
  `runPrepare` re-export then release, unreadable status or failed export →
  `release_skipped_dirty` and the worker is kept.
- `opencode/plugins/lib/tool-specs-sandbox.ts`: the `sandbox_finish` description no longer
  promises to retain the worker until apply/discard/keep; it retains the result and may release
  the transient worker, re-created on demand. `broker/tests/fixtures/sandbox-tools-surface.json`
  was regenerated through the sanctioned `SANDBOX_TOOLS_SURFACE_WRITE=1` path (one line).
- Observed (u3 writer): focused 75 pass, 0 fail, 445 `expect()`; full suite 1979 tests, 5
  failures (the known set); build succeeded.

### Independent check of the installed candidate (`host_test_run runner=broker-unit`)
Observed 2026-11-08T08:46Z against `gitHead b4ec8f1` with the ten dirty paths listed below:
`1968 pass, 9 skip, 2 fail, 9023 expect() calls, 1979 tests across 107 files`, exit code 1.
Both failures are `tests/v2-launch.test.ts` profile drift, pre-existing at base `4d32ff7`:
- `grants write access to the same project .git directories as V1` — V2 profile has the extra
  `$HOME/ai-workspace/worktrees/*/*/.git` grant.
- `reaches the same hosts and project roots as V1` — V2 profile has the extra
  `platform.claude.com` host.
The three EACCES `mkdir /nonexistent` failures recorded earlier did not reproduce in this
runner. No candidate-attributable failure was observed. `bun build --target=bun src/main.ts`
was reported green by all three writers; this orchestrator could not re-run it (no build
runner is registered for `host_test_run`).

### Residual findings, not fixed (next unit)
1. **Stale clean probe.** `releaseResultReadyWorker` takes the `git status` probe before
   acquiring the finish claim (deliberate: a client finish already holding the claim wins). A
   write that completes between the probe and the claim can leave unexported edits that a
   `clean === true` decision then releases. Closing it needs the probe inside the claim plus a
   write-generation check, or an exported-tip comparison; size it as its own unit.
2. **Clean status does not prove export durability.** A worker-side `git commit` leaves a clean
   status while the host result ref lacks that commit (pre-existing in `finishOrReleaseActive`
   since `d65518b`). A committed-tip comparison would be required.
3. **Direct-admission TOCTOU.** Allocations are inserted only after creation, so two concurrent
   direct `ensureWorker` creations can briefly oversubscribe the pool. Pre-existing; the queue's
   `inFlight` reservation covers drained creations only.
4. **Silent remove failure.** `releaseWorker` returns `released: false` but callers historically
   cleared `workerName` anyway; the current paths check the outcome. The `releaseRetainedWorker`
   variant noted above still needs its own unit.

### Owner landing steps (S17 — the owner reviews and commits, then restarts)
The installed candidate touches these paths, all uncommitted on `fix/q114-worker-release` at
HEAD `b4ec8f1`:
- `broker/src/config.ts`
- `broker/src/reaper.ts`
- `broker/src/service.ts`
- `broker/tests/config.test.ts`
- `broker/tests/fixtures/sandbox-tools-surface.json`
- `broker/tests/queue.test.ts`
- `broker/tests/reaper.test.ts`
- `broker/tests/service-apply.test.ts`
- `broker/tests/staging-chain.test.ts`
- `opencode/plugins/lib/tool-specs-sandbox.ts`

Reviewability: 495 + 668 + 571 authored changed lines across the three results, over the local
400-line per-commit guard. Split into coherent commits (source vs tests, and by unit) or record
a `review-size-exception` with its reason. Then restart the broker for the change to take effect.


## Revisions
- r1 2026-11-08T07:32:38Z gentle-orchestrator: Record Q114 T5 installed candidate, T6-T8 plan and route evidence
- r2 2026-11-08T08:48:06Z gentle-orchestrator: Record T6-T9 installed candidates, the independent broker-unit run, residual findings and owner landing steps
