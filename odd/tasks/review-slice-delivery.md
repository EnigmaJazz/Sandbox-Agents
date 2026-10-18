# ODD task — review-slice-delivery

## Objective
Let an owning orchestrator or PM read exact, bounded diff bytes from a materialized review run, then inline those bytes into each reviewer prompt as the `ce:review` skill prescribes.

## Problem (verified 2026-10-18, by live experiment)
`host_review_materialize` stores bounded, hashed artifacts in the broker-owned run store and returns only an index. The owning caller has no shell or direct store path, so it cannot obtain the exact delta to inline. The run identifier and slice names alone are insufficient; callers need a broker-mediated read bound to their owning session.

A reviewer itself is not a valid consumer: it runs as a child session and would fail the store's exact-session ownership check. The native relay reviewers have no tools and receive provider-issued prompts. The observed reviewer statement ("I cannot see what was removed, only what is present now") explains why the caller must supply the diff inline; it does not authorize reviewers to fetch artifacts directly.

## Scope
New: a read-class broker operation `reviewDiffRead`, its registry entries, a plugin tool `host_review_diff_read`, a permission-fragment entry, and tests.
Out of scope, must NOT change: `reviewMaterialize`, `reviewPipelineRun`, `reviewPersist` behaviour; the worker environment; the profile; the guard's mutation set.

## Constraints
- S17: `broker/src/**`, `opencode/plugins/**`, `opencode/config-fragments/**`. The result lands through the approval-gated host install; the owner commits by hand.
- Broker stays dependency-free. Explicit types, allowlists, argv vectors, fail closed, no implicit fallback.
- READ-ONLY authority: the operation returns bytes. It must NOT gain mutation, execution or approval authority, and must not be classified as a host mutation.
- Output must be bounded; an over-cap request is refused naming the cap and the observed size, never truncated.
- The run store's existing rules apply unchanged: a run is served only to the session that owns it, the artifact name grammar and reserved-name rule hold, and the read uses the existing race-resistant path (single open, fstat on the same fd, no-follow, regular-file only, canonical containment).

## Decisions (owner, 2026-10-18)
- **Who may read:** the caller only (orchestrator and PM identities), for a run owned by that caller's session. Reviewers are NOT consumers: a reviewer executes in a `child` session while the run store serves only the exact owning session, so it would be refused even if given the tool. The native relay-lane reviewers have all tools disabled and provider-issued prompts, so no binding can be injected; that lane is out of scope. The `ce:review` skill supplies each persona the intent summary, file list, and diff inline (`SKILL.md:436-445`); inlining is the prescribed mechanism, not a workaround.
- **Bounded bytes:** return the whole `scope.diff`, or one named slice; never truncate. Refuse whole-diff reads above the configured cap and direct the caller to read one slice.
- **Exact encoding and integrity:** return validated byte values (0–255), element count, and SHA-256; verify bytes against the artifact's recorded digest before returning. Do not lossily decode UTF-8.
- **Open follow-up, not implemented here:** read operations are currently permitted to every agent (`broker/src/validation.ts:890-899`). Actor-level restriction requires separating read classification from actor authorization. Ownership still bounds access to the caller's own runs; do not attempt actor-level restriction in this unit.
- **Separate unit, not implemented here:** `materialize` has no protected-content policy and can publish tracked protected files, removed historical credentials, and sensitive filenames, while the permission fragment denies ordinary reads of `.env*`, keys, PEM, `.netrc`, and `.git-credentials`. The future materialization change must refuse rather than redact.

## Pre-code advice
The pre-code design was corrected after advice: this operation serves only the owning caller, not reviewer agents. Reviewer session ownership and the tool-disabled, provider-issued native relay lane make reviewer reads unavailable; `ce:review` already prescribes inlining the diff into each persona prompt. Identity-level read authorization and protected-content filtering for materialization remain separate follow-ups.

## Tasks
- **T1 — broker operation.** `reviewDiffRead` accepts the broker-generated run id and an optional slice name. Register through the Operation union, OPERATIONS, SANDBOX_GUARD_CLASS, ALLOWED_PAYLOAD_KEYS, hostToolAccess as READ, the server dispatch case, and a service op builder. Extend the OPERATIONS parity test.
- **T2 — read and integrity.** Reuse the store's race-resistant read and existing owning-session check; serve the whole `scope.diff` or one named slice. Return byte-array values, element count, and SHA-256; verify both recorded bytes and digest. Refuse unknown run, unknown slice, foreign session, over-cap, and integrity mismatch with distinct codes; never return partial data.
- **T3 — plugin tool.** `host_review_diff_read` returns JSON on success, throws an error retaining the code, and asks no approval. Description states it returns a bounded diff for a run the caller owns and that the caller inlines it into reviewer prompts.
- **T4 — permission fragment.** An `allow` entry, matching existing style.
- **T5 — host authority.** The operation is not in the host mutation set and raises no approval. Do not implement actor-level restriction in this unit.
- **T6 — client timeout.** Add a bounded entry so the client cannot abort mid-read.
- **T7 — tests.** Cover ownership, unknown run, unknown slice, cap and observed size, non-UTF-8 byte identity, manifest integrity mismatch, non-mutation/no approval, and dispatch through the real read path. Every test must FAIL when its guard is removed; report a revert table with source SHA-256 before and after and call out any test that stays green without its guard.
- **T8 — records.** Update this tracker with progress, checks, and per-file change counts.

## Acceptance criteria
1. The owning caller can obtain the whole diff or one named slice using the run id and optional slice name.
2. Returned byte arrays are exact, integrity-checked, and bound to count and SHA-256; over-cap data is refused, never truncated.
3. Unknown run, unknown slice, foreign session, cap excess, and integrity mismatch have distinct refusal codes; no foreign session id is disclosed.
4. The operation carries read authority only: not a host mutation, no approval, no execution; actor-level restriction remains out of scope.
5. `bun --cwd broker test --reporter=dot` stays 0 fail; `bun build --target=bun src/main.ts` succeeds from `broker`.
6. No behaviour of the three existing review operations changes.

## Checks
- Focused: `bun --cwd broker test --reporter=dot tests/review-materialize.test.ts tests/review-materialize-operation.test.ts tests/operations-parity.test.ts` — 32 pass, 0 fail, 135 expectations.
- Full: `bun --cwd broker test --reporter=dot` — 1160 pass, 0 fail across 71 files.
- Build: from `broker`, `bun build --target=bun src/main.ts` — succeeded.
- `git diff --check` — succeeded with no whitespace errors.
- `sandbox_bash` is argv-only (no pipes, redirects, globs, &&, ;).

## Route and advice
Route: authorized change, substantial, ODD, delegated. Triggers: mutation, execution, preparation, route declaration.
Pre-code advice is recorded above. The corrected decision is caller-only diff access; this operation is not a reviewer-facing capability and does not add actor-level authorization.
`ce:review` cannot run in this sandbox (its helper is stdin-only and `sandbox_bash` is argv-only), so the post-code advisors apply before the commit.

## Progress
- 2026-10-18 — tracker design corrected before source edits: caller-only read, actor-level restriction and materialize protected-content policy tracked separately.
- 2026-10-18 — added `reviewDiffRead` end-to-end, returned exact byte arrays with recorded count/SHA-256, and added named refusal codes and dispatch coverage.
- 2026-10-18 — unknown-slice adjudication: the artifact-existence guard is NECESSARY to preserve the operation's distinct `review_diff_slice_not_found` code. Removing only that guard made `refuses an unknown slice with its named refusal code` fail: lower-level `readRunArtifact` raised `ReviewRunArtifactNotFoundError` instead of the operation's code. The test pins the named code; the previous green result therefore came from a weaker test/assertion or a different guard-removal point, not proof of redundancy.
- 2026-10-18 — isolated guard revert probes (for each run row, source SHA-256 before and after was `d7d28bbc3422eedd20269da11ca40ad8734d5aa2ae5f800661d270da0784ea1c`; exact restoration was confirmed):

| Guard | Test | Observed failure after isolated removal | SHA-256 before | SHA-256 after |
|---|---|---|---|---|
| Host-read classification: `reviewDiffRead` absent from host mutation set | NOT RUN — source is `broker/src/validation.ts`, outside allowed edit surfaces; relevant classification tests are also outside the two permitted focused test files | NOT RUN; no mutation/probe performed | NOT RUN | NOT RUN |
| Unknown-run refusal | `refuses an unknown run with its named refusal code` | Expected `review_diff_run_not_found`; received `review diff run is not owned by the requesting session` | `d7d28bbc3422eedd20269da11ca40ad8734d5aa2ae5f800661d270da0784ea1c` | `d7d28bbc3422eedd20269da11ca40ad8734d5aa2ae5f800661d270da0784ea1c` |
| Unknown-slice refusal | `refuses an unknown slice with its named refusal code` | Expected `review_diff_slice_not_found`; received `ReviewRunArtifactNotFoundError: review run artifact "slice-9999.diff" does not exist in the run directory` | `d7d28bbc3422eedd20269da11ca40ad8734d5aa2ae5f800661d270da0784ea1c` | `d7d28bbc3422eedd20269da11ca40ad8734d5aa2ae5f800661d270da0784ea1c` |
| Foreign-session (ownership) refusal | `refuses a foreign session without disclosing the owner's session id` | Expected `review_diff_foreign_session`; received `review_run_ownership` | `d7d28bbc3422eedd20269da11ca40ad8734d5aa2ae5f800661d270da0784ea1c` | `d7d28bbc3422eedd20269da11ca40ad8734d5aa2ae5f800661d270da0784ea1c` |
| Byte-cap refusal | `refuses an over-cap artifact with the cap and observed byte size` | Expected `review_diff_byte_cap`; received no refusal (`undefined` code) | `d7d28bbc3422eedd20269da11ca40ad8734d5aa2ae5f800661d270da0784ea1c` | `d7d28bbc3422eedd20269da11ca40ad8734d5aa2ae5f800661d270da0784ea1c` |
| Integrity-mismatch (recorded digest) refusal | `refuses bytes that do not match the recorded digest` | Expected rejection with `review_diff_integrity_mismatch`; promise resolved | `d7d28bbc3422eedd20269da11ca40ad8734d5aa2ae5f800661d270da0784ea1c` | `d7d28bbc3422eedd20269da11ca40ad8734d5aa2ae5f800661d270da0784ea1c` |
| Byte-preserving encoding (non-UTF-8 round trip) | `returns non-UTF-8 bytes exactly and binds their recorded byte length and digest`; `reads a named slice and returns its recorded bytes and digest`; real dispatch preservation test | Lossy UTF-8 conversion replaced `0xff`/`0xfe` with UTF-8 replacement bytes; all three assertions failed against exact expected byte arrays | `d7d28bbc3422eedd20269da11ca40ad8734d5aa2ae5f800661d270da0784ea1c` | `d7d28bbc3422eedd20269da11ca40ad8734d5aa2ae5f800661d270da0784ea1c` |
| Whole-diff over-cap directs caller to a slice | `refuses an over-cap artifact with the cap and observed byte size` (now also asserts the directing text) | Removing only `read one slice instead` failed the new assertion: expected that text, got `review diff is 262145 bytes, over the 262144-byte cap` | `d7d28bbc3422eedd20269da11ca40ad8734d5aa2ae5f800661d270da0784ea1c` | `d7d28bbc3422eedd20269da11ca40ad8734d5aa2ae5f800661d270da0784ea1c` |

- 2026-10-18 — RED evidence: lossy UTF-8 pre-fix conversion produced 3 focused-test failures with replacement bytes `239,191,189` in place of invalid bytes `255,254`; removing the recorded-digest comparison made the tampered artifact promise resolve instead of rejecting with `review_diff_integrity_mismatch`. Both source states were restored byte-identically. Host-read classification row is explicitly NOT RUN due the allowed edit-surface boundary.
- 2026-10-18 — focused: `bun test --reporter=dot tests/review-materialize.test.ts` from `broker` — 20 pass, 0 fail, 75 expectations; `bun test --reporter=dot tests/review-materialize-operation.test.ts` from `broker` — 8 pass, 0 fail, 44 expectations. Combined focused probe after the directing-text assertion — 28 pass, 0 fail, 119 expectations.
- 2026-10-18 — full: `bun test --reporter=dot` from `broker` — 1160 pass, 0 fail across 71 files, 4968 expectations. Build: `bun build --target=bun src/main.ts` from `broker` — succeeded.

- 2026-10-18 — follow-up fixes: both must-fixes are addressed (the diff reader uses the smaller operation/store cap and Gate 4 documents both tools); the service JSDoc and UTF-8/text response are updated. The tool-description change is not included because `opencode/plugins/sandbox-tools.ts` is outside this unit's allowed edit surfaces. Focused verification: `bun test --reporter=dot tests/review-materialize.test.ts` from `broker` — 22 pass, 0 fail, 84 expectations; full verification: `bun --cwd broker test --reporter=dot` — 1162 pass, 0 fail across 71 files, 4977 expectations; build: `bun build --target=bun src/main.ts` from `broker` — command completed without a reported error. Open advisories: multi-slice reads can exceed the 256 KiB whole-diff cap cumulatively because there is no cumulative bound; actor-level read authorization remains a separate follow-up.
- 2026-10-18 — `host_review_diff_read` now directs callers to inline `text` when present and never forward the `data` array into prompts.

## Next step
Review final checks and the revert evidence; no commit or host apply is authorized in this unit.
