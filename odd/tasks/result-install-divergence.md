# ODD Tasks — result-install-divergence

- **Feature:** `result-install-divergence`
- **Project:** `sandbox-integration` (`/home/james/agent-sandbox-integration`)
- **Status:** COMPLETE

## Objective

Installing a sandbox result must not silently overwrite a change made to a target path after the result's baseline was captured. Where the host's current bytes differ from what the result started from, the install must refuse (or require an explicit override) and name the divergent paths.

## Problem, with verified evidence

`broker/src/service.ts:2457-2466` — `buildSandboxResultInstallOp` runs `git restore --source=<resultRef> --worktree -- <restorePaths>` with no check that the working tree still matches the result's baseline. Any later edit to one of those paths is overwritten, and the operation still returns `installed: true`. The same hazard exists inverted for `deletePaths` (`:2468-2476`): a result that deletes a path will delete a file that has since changed.

**Code evidence verified:** the current implementation resolves the `baseline` and `result` refs (`:2407-2413`), verifies the result commit and compares baseline-to-result changed/raw paths (`:2414-2445`), then runs restore and delete steps (`:2457-2476`). Those checks concern the result ref and B→C metadata; no working-tree-versus-baseline divergence check occurs before mutation. The operation uses the existing `runHostStep` wrapper around `ctx.git.spawn(argv, { cwd, ... })` (`:2128-2153`), so a fixed argv check can use the existing host git runner. The source line ranges above were verified by reading the current indexed source.

**Reported observed incident (user-provided):** an install returned `installed: true` while silently reverting a later change to a path the result also touched. This incident report was provided with the task; no separate incident log was supplied for independent verification.

## Implemented mechanism

The result's baseline ref (`refs/opencode-sandbox/baseline/<sessionID>`) is checked before any mutation. The check covers the union of `restorePaths` and `deletePaths`, uses fixed argv with `git diff --quiet <baseline> -- <paths>` for divergence and `git diff --name-only -z` to name divergent paths, and refuses if the baseline/check fails. `git diff --quiet` does not report untracked files; see the separate follow-up.

## Scope

Original implementation scope: `broker/src/service.ts` and any helper it needs, plus tests. Do not restructure the operation beyond what the divergence check requires. The task is now closed with the recorded commit below.

## Shape — implemented

The implementation adds a fail-closed baseline-divergence check over the union of restore and delete paths before either mutation. It uses `git diff --quiet <baseline> -- <paths>` to detect divergence and `git diff --name-only -z` to identify paths. Refusals are `cannot install result: working tree diverged from baseline at: <paths>` and `cannot install result: baseline check failed (<stderr>)`.

Existing guards remain unchanged: result-commit mismatch, empty-result rejection, raw/changed-path agreement, symlink and submodule rejection, and delete-target containment.

**Known limitation:** `git diff --quiet` does not report untracked files; an untracked file at a target path is not covered by this check and is tracked separately in `docs/TODO.md`.

## Stable task IDs

- **T1 — Divergence check:** Add a fixed-argv baseline-versus-working-tree check that identifies divergent target paths and fails closed if the baseline/check cannot be resolved.
- **T2 — Restore/delete wiring:** Run the check before any mutation and cover both `restorePaths` and `deletePaths`, preserving all existing guards.
- **T3 — Tests:** Cover divergent restore path refusal and path naming, divergent delete path refusal, no-divergence success, unresolved-baseline refusal, and preservation of existing guard behavior as appropriate.
- **T4 — Checks and receipt:** Run the exact test/build checks below, record actual results and exact test totals, and return the staged reviewability receipt (authored additions plus deletions, raw authored patch bytes, and generated/binary paths).

## Acceptance criteria

- An install whose target paths diverged since the baseline does not mutate them silently.
- An install with no divergence still succeeds.
- A divergence on a delete path is likewise caught before deletion.
- An unresolvable baseline refuses installation.
- Existing guards remain in force.
- The full suite is green; the build succeeds.

## Authorized scope

The implementation was scoped to `broker/src/service.ts`, any helper it needed, and tests for this behavior only. No other paths were authorized for implementation. Commit `1407a78` and its review acknowledgement are recorded below as supplied closure evidence; no push, PR, merge, or release is claimed.

## Checks and TDD

- RED: 15 pass / 3 fail, covering divergent restore, divergent delete, and unresolvable baseline. The no-divergence case passed before the fix and is not claimed as RED.
- `bun --cwd broker test` — 553 pass, 0 fail across 35 files.
- Build: green; output was written outside the repository.
- Reviewability receipt: 87 authored changed lines (86 additions + 1 deletion); no generated paths. `authored_patch_bytes` could not be measured because the sandbox rejected the byte-counting invocation; no byte estimate is claimed.

## Route and trigger evidence

- `route: delegated`
- Specialist: `general` (sandbox writer, per the user's coding-model decision for this project/session: "Linked directly to OpenCode").
- Trigger: the two-or-more-non-trivial-files writer trigger.
- The implementation was completed and committed as `1407a78`; this update records the user-supplied commit, check, receipt, and review evidence.

## Delivery strategy

- **Forecast:** approximately 80–160 authored changed lines total (additions plus deletions, excluding generated files) for the narrowly scoped implementation and tests; this is a planning estimate, not measured work.
- **Selected strategy:** `ask-on-risk` (default). Reassess against actual work before any commit; if forecast or running total approaches/exceeds about 400 authored lines, pause and obtain the required delivery-strategy choice. The completed commit and native review acknowledgement are recorded below; no push, PR, merge, or release is claimed.

## Progress

- T1 — COMPLETE: fail-closed check detects baseline divergence and names affected paths.
- T2 — COMPLETE: one check runs over restore and delete paths before either mutation; existing guards remain unchanged.
- T3 — COMPLETE: RED evidence covers divergent restore, divergent delete, and unresolved baseline. No-divergence passed before the fix and is not claimed as RED.
- T4 — COMPLETE: full test suite and build are green; receipt recorded above.

## Commit and review

- Commit: `1407a78` on `feat/review-and-state-hardening`.
- Native review: APPROVED with zero findings from all four lenses; no advisories were raised. Lineage `review-5de9d2f7cbc97ce3`; 2 files / 87 lines; consumed revision `sha256:4c9bcf29d632538f43d6d5c66f58a7bdd187015be0f5038260ec02aa9cbf777e`; acknowledgement returned `authority: burned`.

## Closure

This task is complete. The untracked-target-path limitation is carried forward as a separate follow-up in `docs/TODO.md`.
