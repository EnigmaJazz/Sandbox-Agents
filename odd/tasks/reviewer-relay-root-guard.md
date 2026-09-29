# ODD Tasks — reviewer-relay-root-guard

- **Feature:** `reviewer-relay-root-guard`
- **Project:** `sandbox-integration` (`/home/james/agent-sandbox-integration`)
- **Status:** Implementation, checks and commit complete; scoped native assessment against boundary `2d92f331` remains pending canonical untracked inventory

## Objective

Let the reviewer relay work for a session whose repository **is** the secure OpenCode server's own working directory, while preserving fail-closed behaviour when the session lookup genuinely fails.

## Problem and verified evidence

`opencode/plugins/lib/reviewer-relay-core.ts:256` refuses when `serverRoot === sessionRoot`; the cached-root path at `:296-297` does the same. The transport supplies `serverRoot: process.cwd()` in `opencode/plugins/reviewer-relay-transport.ts:39`, because `PluginInput.directory` follows the request and cannot identify the server's own root (comment at `:1257-1261`).

Observed effect: `opencode_reviewer_relay_refused: reviewer_relay_root_refused: session repository equals the plugin server root`, preventing a review in the repository the service runs in (`/home/james/ai-workspace/workflow_optimisation`), while other repositories work.

CodeGraph inspection confirmed the transport's `process.cwd()` wiring, the plugin-input comment explaining why request-following `directory` cannot serve as server root, and the cached path's equality refusal. The source contains a typed `sessionLookupFailed` refusal at `reviewer-relay-core.ts:164-165`.

## Why the guard exists

The session-root resolver falls back to `serverRoot` when the session lookup fails, so equality was used as evidence of a collapsed resolution rather than a genuine answer. There is already a path for the real failure: `sessionLookupFailed` at `:1266`.

## Scope

- `opencode/plugins/lib/reviewer-relay-core.ts`
- Its tests

Expected shape: make session-root resolution fail closed on a failed lookup, then relax the equality guard so a resolved session in the server root relays normally. Preserve every other refusal path.

## Constraints and non-goals

- The security property must survive: a failed or unavailable session lookup must still refuse. Do not simply delete the guard without the fail-closed replacement.
- Do not change the transport's `serverRoot: process.cwd()` wiring.
- Do not alter unrelated relay behaviour.
- `opencode/plugins/**` is S17; the result will be retained for manual install.

## Stable tasks

- **T1 — fail-closed session-root resolution:** distinguish failed/unavailable lookup from a genuine session root and refuse on failure.
- **T2 — relax the equality guard:** allow a resolved session root equal to the server root on fresh and cached paths, retaining other refusals.
- **T3 — tests:** add RED-first coverage for fresh equality, failed lookup refusal, and cached-root equality; run the suite after GREEN.
- **T4 — checks and reviewability receipt:** run the required checks and return `authored_changed_lines`, `authored_patch_bytes`, and `generated_or_binary_paths`.

## Acceptance criteria

- A session whose resolved repository equals the server root relays instead of refusing.
- A failed session lookup still refuses.
- The cached-root path behaves identically to the fresh path.
- The full suite is green.
- The build succeeds.

## Authorized scope

Only `opencode/plugins/lib/reviewer-relay-core.ts` and its tests. No other paths.

## Checks and TDD

TDD is active as RED-first test coverage: record observed RED before GREEN, or state plainly that a genuine RED could not be produced.

- `bun --cwd broker test` — **546 pass, 0 fail**, 2,729 assertions, 35 files.
- `bun build broker/src/main.ts --outfile /tmp/relay-verify.js` — succeeded, 1.15 MB. Build output was written outside the repository.
- **Observed RED against pre-fix source recovered from commit `337f1fb`:**
  - `accepts the plugin server root when it is allowlisted` — `RelayRefusal: reviewer_relay_root_refused: session repository equals the plugin server root`.
  - `a fresh session resolved to the server root relays successfully` — received `{ error: "reviewer_relay_root_refused: ..." }`.
  - `a cached session root equal to the server root relays successfully` — received `{ error: "reviewer_relay_root_refused: cached session repository equals the plugin server root" }`.
  - `an unusable session directory refuses as a lookup failure` — expected `reviewer_relay_session_lookup_failed`, received `reviewer_relay_root_refused`.
- The synthetic baseline commit contained the already-fixed source and could not be used for RED; pre-fix source was recovered from `337f1fb`.

## Route and trigger evidence

- **Route:** `delegated`
- **Specialist:** `general` (sandbox writer, selected by the user's coding-model decision for this project/session: “Linked directly to OpenCode”)
- **Trigger:** two-or-more-non-trivial-files writer trigger
- **Task dispatch:** `general` sandbox writer; implementation result retained as `refs/opencode-sandbox/result/ses_f15e94c60ffeekX4aNWe9lIFoU` at commit `63467d2f`. The plugin source was restored into the working tree by hand because `opencode/plugins/**` is S17.

## Delivery strategy

- **Forecast:** approximately 120 authored changed lines (additions plus deletions), excluding generated files.
- **Reviewability receipt:** `authored_changed_lines`: **83** (9+11 in `opencode/plugins/lib/reviewer-relay-core.ts`; 59+4 in `broker/tests/reviewer-relay-transport.test.ts`). `authored_patch_bytes`: not directly measured, but far below 100 KiB at 83 lines. `generated_or_binary_paths`: `broker/.reviewer-relay-build.tmp.js` (24,790 lines, produced by an early build run inside the repository; excluded from the restore and absent from the working tree).
- Within the 400-line/100 KiB per-commit cap; no `review-size-exception` needed.
- **Selected strategy:** `ask-on-risk` (default); no strategy escalation indicated.

## Progress

- T1 complete: session lookup failures and unusable directory results refuse as `reviewer_relay_session_lookup_failed`.
- T2 complete: equality guard removed from fresh path (`:254-257`) and cached path (`:296-297`); canonical validation and root-check log remain; `serverRoot: process.cwd()` wiring is unchanged.
- T3 complete: five tests added or updated in `broker/tests/reviewer-relay-transport.test.ts` (+59/-4).
- T4 checks complete; exact test/build outcomes and observed RED are recorded above.
- Source state: retained result `refs/opencode-sandbox/result/ses_f15e94c60ffeekX4aNWe9lIFoU` at commit `63467d2f`; restored into the working tree by hand because `opencode/plugins/**` is S17. `opencode/plugins/lib/reviewer-relay-core.ts` hash: `b3b1832cce24c078c43ebdfd392aa683e3c1bee4`.
- The generated in-repository build artifact is absent from the working tree.

## Work-unit commit and scoped assessment

- Work-unit commit: `8469d32` on `feat/review-and-state-hardening`, subject `fix(reviewer-relay): fail closed on session lookup instead of refusing the server root`; 3 files changed, 162 insertions(+), 15 deletions(−).
- This tracker update is the follow-up metadata work unit required when the commit identity is known only after committing.
- Scoped native assessment requested with `--base-ref 2d92f331 --committed-only`: `status: 1`; `risk: high`; `review_due: true`; `review_due_reason: high_risk`; `candidate.consumed: false`.
- Assessment reason: `unassessable` because untracked files require an explicit declaration. The returned detail directs obtaining the canonical inventory through scoped review STATUS before rerunning the assessment. No review was started or consumed.

## Next step

Obtain the canonical untracked inventory through the returned scoped review STATUS continuation, then rerun the assessment with the same base and committed-only selectors and an explicit untracked declaration.
