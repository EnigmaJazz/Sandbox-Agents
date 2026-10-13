# ODD Tasks — artifacts-durability-gate

- **Feature:** `artifacts-durability-gate`
- **Project:** `sandbox-integration` (`/home/james/agent-sandbox-integration`)
- **Status:** COMPLETE
- **Implementation commit:** `682065e` on `feat/review-and-state-hardening`

## Objective

Make the artifact-removal predicate honest: a terminal record with no `resultRef` must not be assumed to have produced no result. Where a bundle was produced but never imported, the bundle is the only copy of the work and must not be deleted without proof of a durable ref.

## Problem and verified evidence

- `broker/src/artifacts.ts:154-165`: `RemovableRecord` contains `state` and `resultRef`; the original `removalNeedsDurableRef` returned `false` for `REJECTED` and for `FAILED_CLOSED` when `resultRef == null`.
- `broker/src/artifacts.ts:167-183`: the original `shouldRemoveSessionArtifacts` returned `true` for `REJECTED`; for `FAILED_CLOSED`, it returned `record.resultRef == null || durable`; otherwise it returned `durable`. Thus a failed-closed record without a ref was treated as safe to remove without proving that no bundle existed.
- `broker/src/service.ts:1471+` (`runPrepare`; inspected body around lines 1585-1614): in real mode, after bundle preparation, `git bundle verify` and then host `git fetch` are attempted. Either unsuccessful command throws. The successful import path then calls `gcSessionArtifacts(..., { durable: true })`; a failure before that point does not establish a durable host ref in this path.
- `broker/src/reaper.ts:151-190`: terminal-record artifact sweeping honors `graceMs` and checks the durability rule before removal. Direct cleanup through `gcSessionArtifacts` at `broker/src/service.ts:763-784` does not apply that reaper grace period.

A `FAILED_CLOSED` record could therefore reach the result-less removal branch after a bundle was written but before a durable `resultRef` was persisted; immediate terminal cleanup could remove the bundle, the only copy, without a grace period.

## Scope note

The earlier reaper fix narrowed the issue: idle sweeps are release-only rather than transitioning to `FAILED_CLOSED`, and GC prunes only terminal records. The implemented change closes the remaining failed-closed-with-bundle case. The reaper's release-only idle behaviour and `durableHostRefResolves` remain unchanged.

## Implemented shape

Callers supply whether the bundle exists (shape 2), avoiding a new state marker. A `FAILED_CLOSED` record requires a durable ref when `resultRef != null || bundleExists`, and is removable only when `(resultRef == null && !bundleExists) || durable`. The three documented removal cases remain the only ones.

The grace period was deliberately **not** extended to direct terminal cleanup. This was a judgement call: the targeted fix addresses the false no-bundle assumption without changing the separately documented direct-cleanup timing behavior.

## Constraints and non-goals

- Do not change the reaper's release-only idle behaviour.
- Do not weaken `durableHostRefResolves`; it fails closed and only ever keeps artifacts.
- `broker/src/**` is S17 and the result is retained for manual install.
- Direct terminal cleanup continues not to apply the reaper grace period, by the recorded judgement call above.

## Stable tasks

- **T1 — Predicate and input:** Complete. Corrected the removal predicate and its input so absence of `resultRef` does not imply absence of a produced bundle.
- **T2 — Bundle-presence fact:** Complete. Callers supply bundle presence; no state marker was added and release-only idle behavior is unchanged.
- **T3 — Tests:** Complete. Covered bundle-present `FAILED_CLOSED`, genuine no-bundle failure, and the documented three removal cases.
- **T4 — Checks, commit and reviewability receipt:** Complete. Commit `682065e`; check and receipt details below.

## Acceptance criteria

- A `FAILED_CLOSED` record whose bundle exists is not pruned without a durable ref: complete.
- A genuine no-bundle failure is still pruned: complete; this behavior already passed before the fix, so it is not claimed as RED.
- The documented three removal cases remain the only removal cases: complete.
- The full suite is green and the build succeeds: complete.

## Authorized scope and delivery

The implementation was committed as `682065e` on `feat/review-and-state-hardening`. No push, PR, merge, or release is recorded here.

## Checks and TDD evidence

- `bun --cwd broker test`: **550 pass, 0 fail**, 2,738 assertions across 35 files.
- Build: green; output was written outside the repository.
- RED, stated honestly: the bundle-present case failed before the fix (expected 0 removals, received 2). The no-bundle case passed beforehand, so it is not claimed as RED; that behavior was already correct.

## Review and reviewability receipt

- Native review: **APPROVED, authority burned** on the first pass; no correction was required.
- Lineage: `review-9070428dfe159687`.
- Candidate: 5 files / 80 lines.
- Consumed revision: `sha256:eae2b607e6174f93ee1b66b13193ae2721e26b8d243526424f26838f60e8860a`.
- Acknowledgement: `review-acknowledged/v1`; `authority: burned`.
- Reviewability receipt: **75 authored lines** (59 additions + 16 deletions) / **7,871 bytes**; no generated paths.
- The reviewed range also included `nono/profile/opencode-secure.json`, which adds `huggingface.co` to the domain list. The risk lens inspected it and found no reachable exposure. This records the range and finding without judging authorship.

## Non-blocking advisory findings — separate later work

1. **`R3-test-vacuous-assertion` — SUGGESTION.** `broker/tests/state-artifacts.test.ts:619`: the test deletes the bundle with `rmSync` before the sweep runs, so its final absence assertion cannot demonstrate sweep behaviour.
2. **`R3-svc-gc-uncovered` — WARNING.** `broker/src/service.ts:777-779`: `gcSessionArtifacts` passes `bundleExists`, but no test exercises that integration.
3. **`R3-bundle-toctou` — SUGGESTION.** `broker/src/reaper.ts:123`: `bundleExists` is sampled before asynchronous durable-ref resolution and removal.

The provider designated all three as separate later work; they are non-blocking and did not require correction for this approved candidate.

## Progress

- **T1–T4:** Complete.
- The fix is committed, checks are green, the first-pass review is approved and acknowledged, and its authority is burned.
- Three advisory findings remain separately queued in `docs/TODO.md`; they do not reopen this completed task.

## Next step

No further work is required to close this tracker. Track the three advisory findings as separate Tier 4 units.
