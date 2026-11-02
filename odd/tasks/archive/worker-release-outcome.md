# Worker release outcome — silent stop/remove failure leaves an untracked VM

## Objective
A worker that fails to be removed must never be silently forgotten. The session record
keeps pointing at the worker (workerName + pool allocation) so a later sweep retries, the
failure is logged, and no path records `workerState: "DESTROYED"` without a confirmed
removal.

## Problem (observed)
Two silent leak paths (docs/TODO.md Tier 2 item 15):

- `releaseWorker` (`broker/src/service.ts:3193-3218`) swallows `stop` errors
  (`.catch(() => undefined)`) and runs a 2-attempt `remove` loop whose final error is
  discarded; it then unconditionally calls `removePoolAllocation` and `drainQueue`. Every
  caller then clears `workerName` and sets `workerState: "DESTROYED"`, so a VM that really
  failed to remove is untracked — no release path and no sweep can find it again.
- `buildDiscardResultOp` (`broker/src/service.ts:2262-2290`) calls
  `ctx.adapter.remove(...).catch(() => undefined)` directly (no stop-first; `msb remove`
  fails while a guest is still running), then transitions to `REJECTED` and marks
  `DESTROYED`.

Evidence: 22 `REJECTED` sessions (2026-08-18..09-30) hold `DESTROYED` records while their
VMs remain in `msb ls` (~450 MB each, `~/.local/state/opencode-sandbox/workers`).

Two adjacent pre-existing defects, confirmed against source during pre-code advice:

- **X** — `buildDiscardResultOp` accepts `RETAINED`, but `RETAINED -> REJECTED` is illegal
  (`broker/src/state.ts:54`). The op mutates (worker remove, `git update-ref -d`) BEFORE the
  throwing transition, so a discard from `RETAINED` partially succeeds and then fails,
  leaving the session `RETAINED` with its result ref already deleted.
- **Y** — `removePoolAllocation` (`broker/src/service.ts:3176-3184`) matches an allocation
  by cpu/mem VALUES, not worker identity. `buildApplyResultOp:2046` never clears
  `workerName`, so the next `sweepIdle` releases the same session again and the second
  value-match debits a DIFFERENT session's allocation (aggregate undercount ->
  oversubscription).

## Scope
- `broker/src/service.ts` — `releaseWorker`, `buildApplyResultOp`, `buildKeepResultOp`,
  `buildDestroyWorkerOp`, `buildDiscardResultOp`, `removePoolAllocation`.
- `broker/src/reaper.ts` — `sweepIdle` (3 branches), `finishOrReleaseActive`.
- `broker/src/policy.ts` — `WorkerAllocation` gains an identity field.
- Tests: `broker/tests/queue.test.ts`, `broker/tests/state-artifacts.test.ts`,
  `broker/tests/reaper.test.ts`; a focused new failure-injection test file if clearer.
- `docs/TODO.md` (item 15), this record.

## Constraints
- `broker/src/**` is S17: agent results land via approval-gated
  `host_sandbox_result_install`; the USER commits by hand.
- A failed worker release must never fail or undo an operation that already landed
  (apply/keep/commit).
- On a failed removal: keep `workerName`, the pool allocation, and the config dir; log via
  `ctx.logger?.log?.` (several test contexts pass `logger: {}`); do NOT `drainQueue`.
- TDD on. Runner: `bun --cwd broker test --reporter=dot` (baseline 854 pass / 0 fail).
  Build: from `broker`, `bun build --target=bun src/main.ts` (bare `bun build src/main.ts`
  now defaults to the browser target and fails).
- Fakes must model the real boundary: a throwing `adapter.remove` must be exercised and
  asserted. This repo has shipped four vacuous-test bugs; a new test must fail if the fake
  is reverted.

## Tasks

- [ ] **T1 — `releaseWorker` returns a typed outcome.** `{ released: true, reason:
  "removed" | "no-worker" }` or `{ released: false, reason: "remove-failed", error }`.
  `released: true` also covers the no-live-worker case so leaked allocations are still
  freed. On success: free the allocation, `removeConfigDir`, `drainQueue`. On failure: log
  `release_worker_failed` and retain ownership/allocation/config dir; no drain. Route:
  delegated — triggers: mutation rule + writer rule (multi-file). Specialist: odd-apply.
- [ ] **T2 — callers branch on the outcome.** `buildApplyResultOp` (currently never clears
  `workerName`: clear `workerName` + set `DESTROYED` on success, non-fatal on failure),
  `buildKeepResultOp` (currently clears only `workerState`: clear both on success),
  `buildDestroyWorkerOp` (explicit op: surface the failure, state untouched),
  `releaseRetainedWorker`, `sweepIdle` (skip clear/log/count on failure),
  `finishOrReleaseActive` (export branch keeps `workerName` + `ACTIVE` while still yielding
  `RESULT_READY`). Destruction derives from confirmed removal, not the old `ACTIVE`-only
  guard (a `PAUSED` worker is currently never released but is still marked `DESTROYED`).
  Route: delegated.
- [ ] **T3 — route `buildDiscardResultOp` through `releaseWorker`** (stop-first, retry,
  report); record `DESTROYED` only on confirmed release. Route: delegated.
- [ ] **T4 — X: restrict `buildDiscardResultOp` to `RESULT_READY`**, failing before any
  mutation, and check the `git update-ref -d` status before acknowledging rejection.
  Alternative NOT taken (changes the §10 graph; needs owner sign-off): add `REJECTED` to
  `RETAINED`'s legal transitions. Route: delegated.
- [ ] **T5 — Y: identity-keyed allocation removal.** `WorkerAllocation` gains
  `sessionID?: string`; the push at `broker/src/service.ts:503` sets it;
  `removePoolAllocation` matches `a.sessionID === record.sessionID` and is idempotent (no
  value fallback). Route: delegated.
- [ ] **T6 — failure-injection tests** proving each path retains ownership and logs, and
  that reverting the fake re-breaks them. Route: delegated.
- [ ] **T7 — records:** `docs/TODO.md` item 15 and this record. Route: delegated.
- [x] **T8 — resolve the post-code advisory test gaps (M1–M5).** Strengthened the vacuous `applyResult` test; added the retry-success, PAUSED-state, `finishOrReleaseActive` export-failure, `sweepIdle` RESULT_READY/SANDBOX_ACTIVE failure, throwing `stop` and throwing `removeConfigDir` tests; added allocation-retention assertions to every failure-path test. Route: delegated. Result `8f54c68`.
- [x] **T9 — resolve the post-code code should-fix (S1–S3).** `buildDestroyWorkerOp` reconciles a stray allocation on a DESTROYED/FAILED record; `sweepUnfinished` counts only non-error actions; a retained worker after export reports `auto_finished_retained`. Route: delegated. Result `8f54c68`.
- [ ] **T10 — post-code advisories recorded; S4 deferred.** `WorkerAllocation.sessionID` made required ripples into `broker/tests/policy.test.ts:79,86,92`, outside this unit's surfaces, so it stays optional. Route: delegated.

## Acceptance
- `releaseWorker` returns `released: false` and retains `workerName` + allocation when
  `remove` throws after the retry loop; the logger receives a `release_worker_failed` entry.
- No caller records `workerState: "DESTROYED"` or clears `workerName` without a confirmed
  release.
- `discardResult` from `RESULT_READY` still succeeds; from `RETAINED` it fails before any
  mutation.
- A double release does not debit another session's allocation.
- Full suite green (`bun --cwd broker test --reporter=dot`); build succeeds.

## Pre-code advice (recorded)
Classified `pre-code`. Two first-pass advisors, dispatched independently (no cross-visibility), both returned source-cited findings; the plan was revised before implementation.
- `advisor-security-pre`: state guards can still record a false `DESTROYED` — destroy releases only ACTIVE/CREATING and keep/discard only ACTIVE, then mark any named worker DESTROYED, while `PAUSED` is a valid worker state; `RETAINED -> REJECTED` is illegal while discard accepts `RETAINED` and mutates before throwing; retaining an allocation can starve capacity; a cleanup-pending worker must not be reused; prefer a typed outcome over a throw; treat config-dir cleanup separately from VM removal.
- `advisor-integration-pre`: all 13 `releaseWorker` call sites and their required failure behavior; on failure do not free the allocation or drain the queue; log inside the helper via `ctx.logger?.log?.`; `removeConfigDir` only after success; `released: true` must also cover the no-worker case; the existing fakes are vacuous, so the tests must exercise a throwing `remove`.
Advisory answers are evidence only, not a review, and do not approve the unit.

## Verification (2026-10-14, writer-observed)
- Focused: `bun --cwd broker test --reporter=dot` on the changed files — 109 pass / 0 fail.
- Full: `bun --cwd broker test --reporter=dot` — 865 pass / 0 fail (baseline 854; +11).
- RED before the fix: the new test file ran 1 pass / 10 fail.
- Build from `broker`: `bun build --target=bun src/main.ts` — bundled 26 modules.

## Review-size exception (recorded before commit)
674 authored changed lines (614 added, 60 removed), 422 of them the new failure-injection test file `broker/tests/worker-release-outcome.test.ts`. This exceeds the 400-line per-commit cap. Recorded because the change is one coherent behavior fix (a single release-outcome contract every caller must branch on), the production delta is about 250 lines across three files, the bulk is test coverage that must ship with the behavior, and 674 lines is far below the 200 KiB native serialized review-input budget. `authored_patch_bytes` is unmeasurable in this sandbox (Tier 3 item 7: `sandbox_bash` rejects the metacharacters a byte-count script needs).

## Advisory-layer gap
`ce:review`'s helper pipeline (`screen`/`prepare`/`merge`/`finalize` via `scripts/validate-review.mjs`) is stdin-only by contract and its artifact step needs redirection; `sandbox_bash` is argv-only and rejects `; & | < > $ backtick ' " backslash`. The `ce:review` advisory layer therefore cannot run in this environment, and its output must not be hand-synthesized. The available independent check is the native RDD review.

## Post-code advice (recorded)
Classified `post-code`. Three first-pass advisors reviewed the installed implementation before the commit.
- `advisor-security-post`: production logic verified — all five invariants hold (no caller records `DESTROYED` without a confirmed release; a failed release never undoes a landed operation; the allocation/config dir/record are retained with no drain and a log; identity-keyed removal; both discard guards). Pre-code concerns 1–3 closed; concern 4 partial (config-dir cleanup remains tied to VM removal). Advisories: `sweepUnfinished` counted a failed finish as `finished`; `removeConfigDir` failures swallowed; the adapter type assertion.
- `advisor-integration-post`: no must-fix blocker. should-fix: broker restart does not seed `pool.allocations` from persisted records (pre-existing known gap); `buildDestroyWorkerOp`'s DESTROYED/FAILED early return skipped allocation reconciliation. Advisories: `sessionID` optional with no value fallback; `keepResult` unreachable; the apply test's permissive git fake; config-dir cleanup swallowed plus the type cast; telemetry reporting success on a failed release; indefinite 60s retries hold one slot; discard deletes the ref before worker removal.
- `advisor-testing-post`: the `applyResult` test was VACUOUS — it passed with the fix reverted; the retry-success path, PAUSED handling, the `finishOrReleaseActive` export branch and the `stop`/`removeConfigDir` throws were unproven; several tests did not assert allocation retention. The five modified existing fakes are interface adaptations, not boundary models.

Resolved before the commit (refinement result `8f54c68`, installed):
- M1 strengthened the `applyResult` test so it asserts allocation retention and the `release_worker_failed` log (both false under the old code); M2 added a retry-success test; M3 added PAUSED coverage on keep and destroy; M4 added the `finishOrReleaseActive` export-failure and the `sweepIdle` RESULT_READY/SANDBOX_ACTIVE failure tests; M5 added throwing `stop` / throwing `removeConfigDir` tests and allocation-retention assertions to every failure-path test.
- S1 `buildDestroyWorkerOp` reconciles a stray allocation on a DESTROYED/FAILED record; S2 `sweepUnfinished` counts only non-error actions; S3 a retained worker after export reports `auto_finished_retained`.
- Revert evidence: the pre-fix `releaseWorker` fails 13 of 21 tests; reverting S1, S2 or S3 each fails exactly its own test; restoring value-keyed allocation removal fails 2.

Deferred (recorded, not fixed here): config-dir cleanup separation and its swallowed errors; the `removeConfigDir` type assertion; `WorkerAllocation.sessionID` made required; restart pool seeding from records; discard ref-deletion ordering; `keepResult` dead code; the permissive git fake in the apply test.

## Progress
- 2026-10-14 — T1–T6 implemented; installed as result `ses_ec3c43ab7ffdmpzqSZVk3OBmjQ` (commit `7190c1a`, baseline `0425e99`), 10 paths. T7 partial: `docs/TODO.md` item 15 updated in the same result.
- 2026-10-14 — post-code advisory resolved and installed as result `ses_ec395c89affdP3JE0hwfkKq6hc` (commit `8f54c68`): 338 authored changed lines, 20,993 authored patch bytes, 3 files (`broker/src/reaper.ts`, `broker/src/service.ts`, `broker/tests/worker-release-outcome.test.ts`). Full suite `bun --cwd broker test --reporter=dot` → 875 pass / 0 fail (baseline 865; +10); build `bun build --target=bun src/main.ts` bundled 26 modules.
- 2026-10-14 — committed as `b85e3bc` on master: 11 files, +1030 / −61. T7 complete (TODO entry, tracker, Magic Context mirror, route evidence).
- Related finding, not fixed here: `keepResult` is unreachable at runtime — it is absent from `ALLOWED_PAYLOAD_KEYS` (`broker/src/validation.ts:909-924`), so a real `keepResult` request is rejected before the handler. Needs its own unit.

## Review outcome
Native RDD review `review-e2650ddc3d12daca` — **approved, 0 findings**, acknowledged, authority burned.
- Candidate: base-diff from `c8ffaa89a2f01bfb04ab0c8a81cbf45d31c77cb6` to `079b42ac396051dcec3f58adf5ef0feba8c8307c`, committed-only, workspace projection, target `sha256:68176e945f19a29422cee16dc46551759e4cd023a2dc377f178772951614aa89`.
- Risk: medium (`executable_change` at `broker/src/policy.ts`); 13 paths, 1101 changed lines; correction budget 200.
- Lens: `review-reliability` (selected order 0, subject `sha256:fc856e9f69c6d0bcc94896c7c4657c2f83c00c161261caaebbcc227187922e35`), dispatched through the relay lane `asi-review-reliability` with the provider-issued prompt verbatim. Reported no reachable regression across the 13 changed paths.
- Consumed revision `sha256:3ebdd4a43325eabb14fadfd8acb1c51267f76ce19d9f46e66209709bea5f6852`.
- `review assess` before the start: medium / `under_budget` / `review_due: false`; the slice was reviewed on the owner's explicit decision.

## Status
COMPLETE — implemented, tested, committed and reviewed.

## Next step
None for this unit. The deferred advisories and the `keepResult` finding are recorded above for separate units.
