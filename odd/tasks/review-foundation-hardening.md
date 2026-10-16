# ODD task — review-foundation-hardening

## Objective
Close the ten review-identified defects in the completed `review-run-foundation` unit, so the broker-side helper verifier and the installer's pin step behave correctly under failure, absence and hostile-filesystem conditions instead of degrading silently.

## Problem (verified 2026-10-16)
`review-run-foundation` shipped in three slices, each independently reviewed and approved (`8704563`/`44deade`, `a4d3cd3`/`4f1b044`, `b56d76e`). Those reviews raised ten non-blocking findings, recorded as `docs/TODO.md` Tier 4 items 62–71. None is exploitable on its own; together they are the difference between a foundation that fails closed under abnormal conditions and one that fails closed only on the happy path. This unit fixes them.

Sources, all traced to code during pre-code advice:
- `docs/TODO.md` items 62–71 (the findings, with their review lineages and evidence).
- `odd/tasks/review-run-foundation.md` (the unit's constraints and the eight-property design gate).
- Pre-code advice, 2026-10-16, two internal first-pass advisors (`advisor-security-pre`, `advisor-integration-pre`).

## Constraints
- S17: `broker/src/**` and `scripts/**` — the result lands through the approval-gated host install and the owner commits by hand.
- The broker stays dependency-free (bun:test + node builtins). `node` may be used by the installer as a parser because the pinned helper is itself a Node script, so no NEW host dependency is introduced.
- Security style: explicit types, allowlists, argv vectors, canonical-path checks, atomic writes, fail closed, no implicit fallback.
- Fail closed, never silently degrade. An over-cap or malformed artifact is a named refusal.
- Blast radius is contained: callgraph confirms `assertPinnedReviewHelper` and `readRunArtifact` have ZERO non-test callers, so only tests consume their behavior today.
- Do NOT alter the eight-property design gate, do NOT re-open any reviewed candidate, and do NOT change any behavior the reviews approved other than the ten findings below.

## Accepted decisions from pre-code advice
- **Cache trust — reconciled, not redesigned.** The installer selects a helper inside the agent-writable package cache and copies it into the private pin. Hashing bytes from that cache is not independent authentication. The trust moment is the owner's own `--apply`, which is exactly why the unit's T12 chose the reviewed installer over a broker-side first-use bootstrap (`odd/tasks/review-run-foundation.md:56-58`). This unit does not change that; it records the reconciliation in `docs/review-run-store.md` and states plainly that the pin authenticates *stability after the owner's act*, not provenance.
- **Item 65 — symlink rejection is necessary but not race-free.** `[[ -L "$dir" ]]` on a normalized path is the portable final-component test (it also catches dangling links) and must run BEFORE any `-d` test. Reject non-directory existing entries separately. A check-then-`mkdir -p`/`chmod`/`cp` sequence still has a replacement window if an ancestor is writable; what closes that is the confinement property (design gate #2, verified by the operator probe in `docs/review-run-store.md`), not another bash check. Say so in the doc and add a deterministic replacement test asserting the external target's bytes and modes are UNCHANGED.
- **Item 63 — fail closed; a portable fallback is not equivalent.** A separate `lstat`/`realpath` check leaves a replacement window and inode comparison after opening does not satisfy "never follow". Reject an unavailable or unusable no-follow capability with a named refusal, and prove by test that the open is NOT attempted. Make the capability injectable so the absent branch is reachable in a test rather than dead code.
- **Item 69 — genuine parsing, canonical format.** Parse `pin.json` with `node -e` (argv-vector style, no `eval`, no `source`). For the two installer-managed environment keys, define one canonical single-occurrence assignment format, validate the path and digest values, and refuse malformed or DUPLICATE assignments explicitly rather than silently taking the last. Reject unsupported values BEFORE writing them.
- **Item 66 — three observable modes, and the source check moves before any write.** (a) Legacy verify: no pin directory, no pin record, no helper config keys — verify the legacy destinations, report the helper as unconfigured/not verified, and never count it as a verified pin. (b) Installed-pin verify: ANY pin or config presence activates full consistency checks; partial state, wrong type, mismatched path/hash or malformed records is FAILURE, not legacy exemption; with a valid pin but absent source, report the source comparison as unavailable/incomplete rather than as byte drift. (c) Apply: an unavailable or untrusted source is a named failure BEFORE any deployment or configuration write. Today missing-source is detected after `broker.env` has already been replaced, so a refusal can leave a previously working pin unconfigured — fix that ordering and add a test proving an existing install's helper and config survive a refused apply.
- **Item 67 — restore coverage; the recorded rationale is wrong.** `snapshotTree` already records directory, file and link modes, so "the snapshot misses mode-only changes" is not the reason to restore the assertion. Use a genuinely UNSEEDED legacy fixture for the failure and dry-run scenarios and assert the state directory remains absent; for seeded scenarios assert the existing state is unchanged in bytes, types and modes. Correct the rationale in the item text.
- **Items 64 and 68 — assert concrete outcomes, never "does not throw".**
- **Item 68/70 ordering is mandatory:** anchor the helper selection pattern to the intended `@fro.bot/systematic@<major.minor.patch>` package root FIRST, then write the decoy.
- **Item 71 is last:** it re-verifies the final script hash after every other change has landed.

## Slices
### F1 — broker verifier (`broker/src/review-run.ts` + its tests)
- **Item 62.** `assertPinnedReviewHelper` maps EVERY `lstatSync` failure to `review_helper_missing`. Classify by `err.code`: ENOENT stays `review_helper_missing`; EACCES/EPERM and ENOTDIR get distinct named refusals; every other error code gets an explicit unexpected-error refusal rather than being mislabeled as missing. Use deterministic error injection for the permission case (a chmod-derived EACCES is not guaranteed in every environment).
- **Item 63.** `readRunArtifact` uses `constants.O_NOFOLLOW ?? 0`. Fail closed with a named refusal when the flag is absent or unusable, prove by test that no open is attempted in that case, and keep the existing within-run symlink test (it isolates no-follow from canonical containment).
- **Item 64.** Add tests for `pruneReviewRuns` and `recoverInterruptedRuns` when a run's `metadata.json` is missing and when it is unparseable. Specify the expected outcome explicitly and assert it: the run appears in the pruned summary with its state and reason, and recovery reports it in its recovered set with the directory intact. Include age and global-bound controls, and decide-and-state whether the deletion/skip policy in that state satisfies the "never removes a run still referenced by an open review" requirement.
### F2 — installer pin step (`scripts/install-user-files` + its tests)
- **Item 70 first.** Anchor the helper `find` pattern and version regex to the `@fro.bot/systematic@<major.minor.patch>` package root so a nested directory carrying a higher version string can never be selected.
- **Item 68 second.** Place a distinct-byte, higher-version decoy INSIDE `packages`, with the exact `*/skills/ce-review/scripts/validate-review.mjs` suffix but outside the intended package root. Assert that broad enumeration DOES include it, that legitimate selection excludes it, and that removing only the root anchor makes the decoy win — a real selection differential, not a path `find` never returns.
- **Item 65.** Reject a symlinked destination directory (final-component `[[ -L ]]` before any `-d` test, including dangling links), reject non-directory existing entries, and check ancestors. Add the deterministic replacement test asserting the external target's bytes and modes are unchanged.
- **Item 66.** Implement the three modes and the moved source check exactly as specified above, with the existing-install-survives-a-refused-apply test.
- **Item 69.** `node -e` parsing for `pin.json`; canonical single-occurrence env format with explicit malformed/duplicate refusal; tests covering spaces, quotes, backslashes and duplicate assignments, and distinguishing harmless JSON reformatting from a malformed record.
- **Item 67.** Restore the per-scenario no-mutation assertion with an unseeded legacy fixture, and correct the recorded rationale.
- **Item 71 last.** Re-run the revert-verification for the live-config-path-equality guard against the FINAL script hash, and record the hash before and after.

## Acceptance criteria
1. Every one of items 62–71 is fixed or explicitly recorded as not-worth-fixing with a justification; none is silently dropped.
2. Each fix has a test that FAILS when the fix is reverted; for the test-only items (64, 68) the test asserts a concrete outcome, not merely the absence of a throw.
3. Item 66's three modes are each observable and tested, including that a refused apply leaves an existing install's helper and config intact.
4. Item 68's decoy would be selected if and only if the item-70 anchor is removed.
5. `bun --cwd broker test --reporter=dot` — baseline 993 pass / 0 fail, must stay 0 fail. From `broker`: `bun build --target=bun src/main.ts` succeeds. `bash -n scripts/install-user-files` succeeds.
6. No reviewed-and-approved behavior outside the ten findings changes.

## Checks
- Focused: `bun --cwd broker test --reporter=dot` on each changed test file.
- Full: `bun --cwd broker test --reporter=dot`.
- Build: from `broker`, `bun build --target=bun src/main.ts`.
- Syntax: `bash -n scripts/install-user-files`.
- `sandbox_bash` is argv-only (no pipes, redirects, globs, `&&`, `;`).

## Delivery strategy
Two slices, F1 then F2, each a separately coherent behavior slice keeping its own tests. Forecast: F1 about 250 authored lines, F2 about 400. Per-commit cap 400 authored lines / 100 KiB authored patch; a slice that cannot fit is split further rather than shrunk. Push/PR/merge are not authorized.

## Route and pre-code advice
Route: authorized change, ODD, delegated. Triggers: mutation, execution, preparation, route declaration. Implementation is dispatched to the `general` sandbox worker (owner directive 2026-10-16).
Pre-code advice (2026-10-16, two internal first-pass advisors, recorded in full above): `advisor-security-pre` supplied the cache-trust reconciliation, the item-65 trust-boundary decision, the item-66 three-mode split and the moved source check, the item-63 fail-closed ruling, the item-69 parsing contract, the item-68/70 selection-differential requirement, the item-67 rationale correction, and the item-62/64 error-taxonomy and concrete-outcome requirements. `advisor-integration-pre` confirmed the item-66 seam is correct, established the zero-non-test-caller blast radius by callgraph, decided `node -e` over a format migration, confirmed two slices is the right granularity, and fixed the ordering (70 before 68; 71 last; 65/66/69 independent).

## RDD mode
Effective mode at route entry: on, deciding source global. Not toggled by this unit.

## Progress
- 2026-10-16 — tracker created from the ten findings and the two pre-code advisories. F1 started per authorized implementation-writer dispatch; scope remains items 62–64 only.
- 2026-10-16 — F1 items 62 and 63 implemented in `broker/src/review-run.ts`; focused tests added in `broker/tests/review-run.test.ts`. Item 62 uses a synthetic injected `lstat` error (not chmod) for EACCES/EPERM. Item 63 injects an absent flag and an open counter, and separately injects EINVAL to prove unusable-flag refusal. Revert checks: item 62 reverted test run produced 6 failures (EACCES, EPERM, injected ENOTDIR, EIO, missing code, real ENOTDIR), restored `broker/src/review-run.ts` SHA-256 `7004436b822479da4a001b6428fc85c92fa015baef58b15a5e6ba6e6bd6c89fa`; item 63 reverted test run produced 1 failure (no-follow unavailable); source restored byte-identically to the recorded hash before item-62 revert. The added unusable-flag test had RED evidence: before EINVAL classification it failed, receiving `review_run_artifact_read` instead of `review_run_artifact_no_follow_unavailable`.
- 2026-10-16 — Item 64 tests cover missing/unparseable metadata: expired pruning reports `{state:null, reason:"expired"}` and removes the run; global-bound pruning reports `{state:null, reason:"over-bound"}` only with `maxRuns:0` and TTL excludes age expiry; recovery reports no recovered run and leaves both directory and metadata state intact. Age/TTL controls are present. Policy decision: this behavior does NOT satisfy “never removes a run still referenced by an open review.” A missing or malformed record prevents determining whether the run is open, yet pruning treats `record:null` as closed and can delete it for age or global-bound reasons. F1's item-64 scope is characterization; this risk is reported and not silently changed.
- 2026-10-16 — Complete F1 focused run: `bun --cwd broker test tests/review-run.test.ts --reporter=dot` — 66 pass / 0 fail. Full run: `bun --cwd broker test --reporter=dot` — 1007 pass / 0 fail (includes new tests; requested 993 baseline was not the observed suite count). Build from `broker`: `bun build --target=bun src/main.ts` — succeeded. F1 items 62, 63, and 64 are complete as scoped; no F2 work started. S17 paths remain subject to approval-gated install; no commit made.

## Next step
F1 complete. F2 items 65–71 remain pending; separately address the item-64 policy risk if authorized.
