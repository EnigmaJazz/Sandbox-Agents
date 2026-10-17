# ODD task — review-pipeline-phases

## Objective
Make `ce:review` run end to end from the secure orchestrator: expose the four pure-stdin validator phases with bounded inline stdin and by-reference chaining, and the single approval-gated persist step that extracts the artifact from `finalize`, writes it into the project run directory, and validates it.

## Problem (verified 2026-10-16 against the installed contract)
`ce:review` cannot complete. The packaged helper `validate-review.mjs` implements four pure-stdin phases and the parent cannot invoke any of them. The authoritative contract is `~/.cache/opencode/packages/@fro.bot/systematic@3.22.4/node_modules/@fro.bot/systematic/skills/ce-review/references/pipeline-invocation.md` (281 lines) and `synthesis-artifact-contract.md`.

Verified constraints that shape this unit:
- **stdin only.** "Feed the persona's raw JSON return on stdin through a fresh single-quoted heredoc delimiter -- never argv, command substitution, or a temp file" (pipeline-invocation.md:35-37). A project-relative `inputPath` is a temp file and is therefore excluded by the contract itself, not merely by policy.
- **Phase argv.** `screen --reviewer <persona> --harness <opencode|pi|claude-code>`; `prepare`; `merge`; `finalize`. Each reads a JSON envelope on stdin and writes JSON on stdout.
- **Exit-code taxonomy.** exit 0 accepted; exit 1 the input was structurally rejected (correct the envelope exactly once, never hand-synthesize); exit 2 usage error, TTY input or a stdin read failure (retry exactly once with byte-identical input; a second exit 2 is a launch failure); a missing helper is `validation_unavailable`. A helper failure is NEVER permission to hand-synthesize a phase output.
- **By-reference chaining is required, not optional.** `merge` takes `{prepared:<prepare output>, adjudication}` and `finalize` takes `{merge, prepared, screen_results, dispatch_records, ...}` -- each phase carries the previous phases' outputs wholesale. `prepare`'s output includes the groups the model must adjudicate, so a bounded inline summary is insufficient for the model to do its job: the model must read the prepared groups. Large phase outputs must therefore live in the run store and be read back on demand, never copied by hand.
- **Artifact containment is enforced.** The artifact must live at `<repo>/.context/systematic/ce-review/<runId>/review-summary.json`; containment "resolves `.context/systematic/ce-review` relative to the working directory" (synthesis-artifact-contract.md:301-303). `--allow-outside-artifact-root` exists and "The parent must never pass this flag when validating its own run's `review-summary.json`". Persisting anywhere else (for example the broker run store) makes validation report the directory unavailable, and a run containing `validation_unavailable` evidence "can never finalize as `completed`". The persist step is therefore a genuine project write.
- **`schema_version: 1` must be written into `review-summary.json` before validating** (synthesis-artifact-contract.md:279-282); without it the validator reports the legacy status (exit 3) rather than a validation result.
- **Validation runs from the repository root** and its statuses are `passed`, `failed`, `unavailable`, `not_attempted`; `failed` never deletes the artifact ("A failing artifact is evidence and stays on disk"). `mode:report-only` writes no artifact and performs no validation.
- **Persist extraction.** Writing-mode `finalize` stdout is the wrapper `{kind:'writing', artifact, report}`; only `.artifact` is persisted, never the wrapper. Temp file in the same directory, owner-only, atomic rename.
- **The ignore entry is mandatory, not cosmetic.** `.gitignore` covers `.atl/` but NOT `.context/`, and `.git/info/exclude` is the empty default. Without an ignore entry every run leaves untracked files that change the eligible-untracked inventory digest that `review assess` computes, so one run would invalidate the next review's candidate identity.

Foundation already delivered and reviewed that this unit builds on: the run store with atomic publication, caps, quotas, ownership, retention and race-resistant reads (`broker/src/review-run.ts`); the pinned helper identity with `assertPinnedReviewHelper` (`broker/src/review-run.ts`); the byte-faithful spawn with stdin and `envMode` (`broker/src/msb.ts`); the materialize operation and its registries (`broker/src/review-materialize.ts`, `broker/src/validation.ts`); and error-code propagation (`broker/src/server.ts`).

## Scope
Edits (final list to be confirmed per slice): `broker/src/review-pipeline.ts` (new), `broker/src/review-run.ts`, `broker/src/review-ignore.ts` (new, if the ignore provisioning warrants its own module), `broker/src/types.ts`, `broker/src/validation.ts`, `broker/src/service.ts`, `broker/src/server.ts`, `broker/src/config.ts`, `broker/plugins`-adjacent definitions under `opencode/plugins/sandbox-tools.ts`, `opencode/plugins/lib/broker-client.ts`, `opencode/config-fragments/sandbox-permissions.jsonc`, `broker/tests/**`, `docs/**`, `.gitignore`, `odd/tasks/review-pipeline-tools.md`.
Out of scope and must NOT be done here: any change to `nono/profile/**`; any widening of the worker environment allowlist; any relaxation of existing protection lists; any autofix or headless mode; the `pi` and `claude-code` harnesses; path filters; run retention changes.

## Constraints
- S17 paths in this unit: `broker/src/**`, `opencode/plugins/**`, `opencode/config-fragments/**`, `scripts/**`. `sandbox_apply` and `host_git_commit` refuse them; the result lands through the approval-gated host install and the owner commits by hand. `.gitignore`, `docs/**` and `odd/**` are not S17.
- The broker stays dependency-free: `bun:test` + node builtins only.
- Never resolve a helper from the package cache: the pinned path and digest from config are the only inputs, verified per run by `assertPinnedReviewHelper`.
- Fail closed with a named error; never truncate; never hand-synthesize a phase output; never pass `--allow-outside-artifact-root` for this run's own artifact.
- `spawnExec` with `envMode: "replace"` is the execution seam; do not widen `spawnArgv`'s merge semantics.
- Behavioural change only: no unrelated refactors, no reformatting.

## Tasks

### Slice U3a — the pure phases
- **T1 — operation.** A `reviewPipelineRun` broker operation: fixed phase enum (`screen|prepare|merge|finalize`), optional `reviewer` restricted to an enumerated persona list, `harness` fixed server-side to `opencode` and never model-chosen, and the run identified by a broker-issued id. Registered through every registry: the `Operation` union, `OPERATIONS`, `SANDBOX_GUARD_CLASS`, `hostToolAccess`/`HOST_MUTATION_OPERATIONS`, `ALLOWED_PAYLOAD_KEYS`, the dispatch switch, and the client timeout.
- **T2 — inline stdin.** The phase payload arrives as an inline string field in the NDJSON request, bounded (256 KiB) and REFUSED rather than truncated when over. The broker writes those exact bytes to the child's stdin and closes it. No delimiter machinery is needed or wanted: the delimiter exists only because a shell interpolates, and there is no shell here.
- **T3 — helper identity.** Every phase run calls `assertPinnedReviewHelper` first and refuses with the existing named errors when the helper is unconfigured, missing, not a regular file, or digest-mismatched.
- **T4 — exit-code taxonomy.** exit 0 returns the parsed JSON; exit 1 returns a distinct structurally-rejected outcome carrying only the bounded stderr diagnostic, never a synthesized output; exit 2 returns `validation_unavailable`. A missing or unstartable helper is also `validation_unavailable`. The never-bypass rule is enforced in code: there is no code path that produces a phase output without the helper.
- **T5 — by-reference chaining.** Each phase's stdout is published into the run store as an artifact with its sha256; the response carries a bounded summary plus the artifact reference, never the full payload. A later phase can name a previous phase's run artifact as its stdin source instead of inline content, and the broker splices the stored bytes, so the model never copies large JSON by hand. Both paths (inline and by-reference) must be bounded and fail closed.
- **T6 — tests.** Real-filesystem tests with a fixture helper script that reproduces the exit-code taxonomy (0/1/2 and a missing helper), asserting: each phase's argv is exactly the fixed vector; the stdin bytes the child receives are byte-identical to the input including a non-UTF-8 payload; an over-cap payload is refused naming the cap and the observed size; exit 1 yields no synthesized output; exit 2 yields `validation_unavailable`; a digest mismatch refuses before spawn (assert zero spawns); by-reference splices the stored bytes exactly. Every guard must FAIL when removed, verified by reverting it and observing the named failure, with the source sha256 recorded identical before and after. Do not claim a revert check you did not observe.

### Slice U3b — persist and ignore provisioning
- **T7 — ignore provisioning.** Before the first persist, determine whether the run directory is already effectively ignored using fixed-argv `git check-ignore` in the hardened environment. If it is not, create or append `.context/.gitignore` with the entry for `systematic/ce-review/`, idempotently: no duplicate entry, existing bytes preserved, an existing ineffective or negated entry refused or repaired only by appending, symlink and non-regular-file targets rejected, and the result verified effective before it is relied on. Write by temp file plus rename, owner-only, in the same directory. Prefer `.context/.gitignore` over the repository root `.gitignore` because the former never edits a tracked file; document that a project may instead ignore `.context/` at the root, in which case the check passes and the broker writes nothing.
- **T8 — persist step.** The single approval-gated operation in this feature. From a successful writing-mode `finalize`, extract ONLY `.artifact` from the captured stdout, add `schema_version: 1` if absent, write it to a temp file created exclusively with owner-only permissions in the same run directory, atomically rename it over `review-summary.json`, and remove the temp file on any non-success. The model never supplies artifact content; it supplies only the run and the finalize reference. Report-only mode writes nothing.
- **T9 — artifact validation.** After the rename, run the pinned helper's `artifact <path>` subcommand from the repository root and record the outcome. Map the four statuses faithfully: `passed`; `failed` when the validator ran and the artifact did not conform (and the artifact STAYS on disk); `unavailable` when the validator is absent or cannot start, with a distinct reason; `not_attempted` when it was not run. Never pass `--allow-outside-artifact-root` for this run's own artifact. A non-passing validation means the run is not complete.
- **T10 — tests.** Real-filesystem tests: an unignored run directory gains a `.context/.gitignore` that is verified effective; an already-ignored path writes nothing (assert no write occurred, not merely no error); a duplicate append does not occur on a second call; a symlinked `.gitignore` is refused; the temp file is absent after a simulated failure between write and rename; only `.artifact` is persisted from a `{kind:'writing', artifact, report}` wrapper; `schema_version` is present; each of the four validation statuses is reachable and distinguishable. Every guard verified by revert with hashes recorded.

### Slice U3c — surfacing
- **T11 — plugin tools.** `host_review_pipeline_run` and the approval-gated persist tool, following the existing precedent exactly: bounded zod inputs, `c.request(op, ctx.sessionID, payload, ctx.agent)`, JSON on success and a thrown error retaining the broker code, with `ctx.ask` ONLY on the persist step. Add the matching permission-fragment entries and the client timeouts above the helper budget.
- **T12 — authority.** Extend agent authority consistently with U2-2b: the orchestrator and every PM identity (including the ASTRA variants) that already holds `HOST_MUTATION_IDENTITY_OPERATIONS` entries; deny by default; `registerProject` stays excluded. Assert that a general agent is denied and that neither operation is read-open.
- **T13 — records and operator docs.** Update this tracker, `odd/tasks/review-pipeline-tools.md`, `ROUTER-LOG.md`, and the Gate 4 document with the install order, the manual permission merge, the restarts, and the unverified probes.

## Acceptance criteria
1. A three-thousand-line range materializes in one call and no reviewer reports DIFF_UNAVAILABLE.
2. `screen`, `prepare`, `merge` and `finalize` each run in at most one call through the broker, with byte-identical stdin, and the persisted `review-summary.json` passes the helper's `artifact` self-validation.
3. No phase output is ever produced without the helper; no inline result exceeds its cap; an over-cap payload is refused, never truncated.
4. An unresolvable ref, a digest-mismatched helper, an over-cap payload, an unignored run directory it cannot make safe, and a non-conforming artifact each fail closed with a named reason.
5. `bun --cwd broker test --reporter=dot` — baseline 1063 pass / 0 fail, must stay 0 fail. From `broker`: `bun build --target=bun src/main.ts` succeeds.
6. Authoring discipline: any new test the unit adds must fail when its fix is reverted, and the tracker records which guards were individually reverted with the source sha256 before and after. A test that cannot be made to fail on revert must be reported as such rather than claimed as coverage.

## Checks
- Focused: `bun --cwd broker test --reporter=dot` on the changed test files.
- Full: `bun --cwd broker test --reporter=dot`.
- Build: from `broker`, `bun build --target=bun src/main.ts`.
- `sandbox_bash` is argv-only (no pipes, redirects, globs, `&&`, `;`).

## Delivery strategy
Forecast at tracker creation: about 1,400 authored changed lines across three slices (U3a about 600, U3b about 550, U3c about 250), excluding generated files. Strategy: `ask-on-risk` (default). Each slice is an independently coherent behaviour slice that keeps its own tests; the per-commit cap is 400 authored changed lines and 100 KiB authored patch, and a slice that cannot fit is split further or records an owner-approved exception, never shrunk by removing correct code or genuine test coverage.

## Route and pre-code advice
Route: authorized change, substantial feature, ODD, delegated. Triggers: mutation, execution, preparation, route declaration.
Thinking layers: `ce:plan` satisfied by the existing plan brief plus two external design reviews; `ce:brainstorm` satisfied by that record. `ce:review` remains unavailable in this sandbox, so post-code advisory substitutes and the native RDD review is the independent check.
Pre-code advice carried from the U2 design pass and applied here:
- External (Claude): cut the standalone `ensure-ignore` phase and the free-content artifact writer (`finalize` already emits `.artifact`); keep phase stdout by reference rather than inline; send payloads inline on the child's stdin rather than via a project-relative path the orchestrator cannot create; make slices mandatory and reviewer-sized; one approval on the persist, not one per phase.
- External (Antigravity): `.context/` is not gitignored; `ensure-ignore` writes outside the declared roots; scratch belongs where the confined agent cannot write; do not widen `spawnArgv`.
- Internal `advisor-security-pre`: a `pipeline_run`-class tool must not be approval-free; the eight-property gate applies.
- Internal `advisor-integration-pre`: the spawn-boundary must-fixes, delivered.
Owner decisions taken during this unit: (a) the persist step writes into the project because the upstream contract's containment makes any other location produce a permanently degraded run; (b) the ignore entry is provisioned by the tool itself and skipped when already effective, so it works in other projects without pre-configuration; (c) this repository adds `.context/` to its root `.gitignore` instead of accepting a new untracked stray, so the eligible-untracked inventory stays at its existing six paths.

## RDD mode
Effective mode at route entry: **on**, deciding source **global** (read 2026-10-16). Not toggled by this unit.

## Progress
- 2026-10-16 — tracker created. U3a not started.
- 2026-10-17 — U3a T1–T4 implementation and requested coverage completed in the sandbox. Added `reviewPipelineRun` protocol/guard/operation, host mutation and payload registries, dispatch and service builder; `review-pipeline.ts` implements phase/reviewer validation, 256 KiB cap, exact Buffer stdin (string UTF-8 or byte-array payload), pinned-helper verification and exit taxonomy. Reviewer allowlist: `review-risk`, `review-resilience`, `review-readability`, `review-reliability`.
- RED observed: operation parity initially failed because `OPERATIONS` lacked `reviewPipelineRun` (1 pass / 1 fail). Later revert checks also produced the specific test failures listed below.
- Task B coverage added: real executable temp helper verifies fixed argv for all phases, excludes caller harness/args, reveals stdin SHA-256 for raw non-UTF-8 bytes, and exercises exit 0/1/2, missing/unstartable helper, cap, digest mismatch, phase/reviewer validation and typed codes. Task C extends host mutation/read-open/access assertions to all PM identities including ASTRA and denies `general`.
- Focused: `bun --cwd broker test tests/review-pipeline.test.ts tests/operations-parity.test.ts tests/validation.test.ts --reporter=dot` — 89 pass / 0 fail. Full: `bun --cwd broker test --reporter=dot` — 1075 pass / 0 fail. Build: `bun build --target=bun src/main.ts` from `broker` succeeded.
- Revert table (before and after source hash for each isolated experiment: `78f37a5bcc3b4c99cd8d9acb703b1c74d9bf705a46932ceab40cdcbb377c3af5`):
  | Guard | Named failing test and observed failure |
  |---|---|
  | 256 KiB cap | `refuses an over-cap stdin payload and names its observed byte size without spawning` — promise resolved instead of refusing. |
  | Byte Buffer construction | `preserves arbitrary stdin bytes and the fixture reveals their digest` — observed digest differed from expected raw-byte digest. |
  | `assertPinnedReviewHelper` | `digest mismatch refuses before spawn and unknown phases fail validation` — promise resolved; digest mismatch did not refuse. |
  | Exit 1 branch | `returns a distinct structural rejection without a phase output on exit one` — received `validation_unavailable` instead of `structurally_rejected`. |
  | Exit 2 branch | `maps exit two to validation_unavailable` — observed `review_pipeline_test_removed_exit2` error. |
  | Fixed argv / fixed harness | `runs fixed phase argv with byte-identical stdin and no caller-controlled harness` and `observes exact fixed argv for all phases and rejects caller argv fields` — child observed empty argv. |
  | Phase enum | `digest mismatch refuses before spawn and unknown phases fail validation` — invalid phase promise resolved. |
  | Reviewer enum | `digest mismatch refuses before spawn and unknown phases fail validation` — screen without reviewer promise resolved. |
  | Missing/unstartable helper mapping | `maps missing helper and unstartable helper to validation_unavailable` — missing helper threw `review_helper_missing` instead of returning unavailable. |
- Every experiment was restored; the identical before/after SHA-256 confirms byte-identical restoration. No test had to be strengthened during revert runs; the raw-byte fixture and direct payload-allowlist assertions were added to make those guards observable.
- Reviewability receipt measured with `git diff --output=.u3a-receipt.patch` then `wc -c`: patch 13,320 bytes; `git diff --numstat` showed 96 additions and 17 deletions. Client-timeout registration is pending the surfacing slice; it is outside this writer's allowed paths.

## Historical next step (superseded after U3a review)
The earlier U3a continuation note was superseded by the approved U3a review outcome below and the current status at the end of this tracker.

### U3a review outcome (2026-10-16)

Native RDD review `review-d63291bbd176cae7` — **approved**, acknowledged, authority burned.
- Candidate: base tree `ba691c6232c49593a42c397b8990c862a7d998a8` to `234456b971de2d3d0960e93cc344eeff12f55c1d`, committed-only, workspace projection, target `sha256:de242a9389ccdbb8724ba74d1f75fa3aa0397b8d53c343b5ef8d484d49f22fc4`.
- Risk: medium (`executable_change` at `broker/src/review-pipeline.ts`); 9 paths, 379 changed lines; correction budget 190. Lens: `review-reliability`, order 0.
- Consumed revision `sha256:598b1f406e48737e2655988734ea89c6f76a7ee6ae2d2ba7a1b0d9c5c197081e`.
- The lens independently confirmed the phase/reviewer validation, the 256 KiB cap, the exact Buffer stdin (string or byte array), the pinned-helper check before spawn, the fixed argv vectors, the 0/1/2 outcome mapping, and the registry parity plus orchestrator/PM-only authorization.
- `review assess` before the start: medium / `under_budget` / `review_due: false`; reviewed on the owner's explicit decision.

**Advisory findings (non-blocking, informational — none opened a correction; treat as separate later work, never a reason to re-run review on this candidate):**
- **R3-001** (WARNING, `broker/src/review-pipeline.ts:98-100`) — the accepted outcome returns the entire phase stdout inline rather than publishing it to the run store and returning a bounded summary plus artifact reference; large `prepare`/`merge`/`finalize` outputs will not scale, so this must change when T5 (by-reference chaining) lands. Already acknowledged as pending in this tracker.
- **R3-002** (SUGGESTION, `broker/src/service.ts:3616-3622`) — `buildReviewPipelineRunOp` casts the request payload and delegates without an observable assertion at the operation boundary that disallowed keys are rejected; `assertPayloadKeys` is unit-tested but a handler-level or end-to-end test would prove the framework wires it in for this operation.

## Status
U3a (T1-T4) is recorded as committed and reviewed. U3b T7–T10 implementation and tests are present in the current sandbox result; the exact requested full-suite invocation passed, though the persist operation still depends on U3a T5 publishing finalize output to the run store. T5 and client-timeout registration, U3c, native RDD review, owner installation, and owner commit remain pending.

## U3b progress — T7–T10
- Implemented `reviewPersist` broker-side registration (operation union, ordered registry, sandbox guard partition, host mutation classification, payload allowlist, server dispatch and service builder). Payload accepts only `projectDir`, broker-issued `runId`, `finalizeRef`, and optional mode; no artifact content field. The plugin tool and approval prompt remain U3c.
- Added `review-persist.ts`: fixed-argv `git check-ignore -q -- <artifact>` via `spawnExec` with `envMode: "replace"`; skip `.context/.gitignore` writes when already ignored; otherwise append idempotently with original bytes preserved, reject symlink/non-regular ignore files and unsafe directory components, write by owner-only temp plus same-directory rename, then verify effectiveness. A root `.context/` ignore is documented and results in no `.context/.gitignore` write.
- Persist extracts only `.artifact` from a writing wrapper, adds `schema_version: 1`, atomically replaces `review-summary.json` from an exclusive owner-only same-directory temp, and cleans the temp after a pre-rename failure. Report-only returns distinct `not_attempted`; rejected/unavailable finalize outcomes and non-writing wrappers refuse.
- Artifact validation runs the pinned helper as `artifact <path>` with cwd at the canonical project root and no outside-root flag. Statuses have distinct codes; failed validation leaves the artifact in place and returns `incomplete`, as does unavailable validation. Passing validation returns `persisted`.
- RED observed: first targeted run failed because the new module did not yet exist; after adding the typed stub the test failed with `review_persist_not_implemented`. After implementation, a focused failure exposed a fixture path mismatch (validator was unavailable); correcting the fixture to use `reviewHelperPath`/`reviewHelperSha256` produced green tests. A later focused failure exposed an overly strict expected ignore-check call count; the test was corrected to assert the two git calls separately from the validator call.
- Persist-only: `bun test tests/review-persist.test.ts --reporter=dot` from `broker` — 16 pass / 0 fail. Focused all changed tests: `bun test tests/review-persist.test.ts tests/operations-parity.test.ts tests/validation.test.ts --reporter=dot` — 97 pass / 0 fail.
- Full: the exact requested `bun --cwd broker test --reporter=dot` from the repository root — 1092 pass / 0 fail. An earlier `bun test --reporter=dot` invocation with working directory `broker` returned 1088 pass / 4 fail in existing `review-pipeline.test.ts` fixtures (`/usr/bin/env: node: Permission denied`); invoking the prescribed command immediately afterward passed all 1092 tests. The invocation difference is observed, but its cause was not established. The failed standalone suite was also reproduced as 5 pass / 4 fail and left untouched because `broker/tests/review-pipeline.test.ts` is outside this slice's allowed edit surfaces.
- Build: `bun build --target=bun src/main.ts` from `broker` returned successfully (bundled output; no build error).
- Added 16 real-filesystem tests under temporary git repositories. Coverage includes effective ignore and no-write evidence, fixed argv/replacement env, append preservation and no duplicate, symlink and unsafe-ancestor refusals, post-write ignore verification, temp cleanup, artifact-only extraction, schema insertion, report-only, refused finalize outcomes, and all four validation outcomes (missing and unstartable validator reasons are distinct).
- Revert table — each isolated source edit was restored; every before/after hash pair is identical. Hashes `45e93fbb1d9a2646f8fbf537f66b3eed8f4f9cd99485888e384282bc31b69728` cover the first three experiments; `91652ce6cf5ac244527a9846e8af2f1d12ad8bb7c278a1268a52bbd5d0353e82` covers the remaining experiments:
  | Guard | Test that failed when removed; observed failure | Before SHA-256 | After SHA-256 |
  |---|---|---|---|
  | Initial ignore check | `ignore checks use fixed argv and replacement environment before and after provisioning` — only one git check occurred; already-ignored and duplicate-call tests also failed. | `45e93fbb1d9a2646f8fbf537f66b3eed8f4f9cd99485888e384282bc31b69728` | same |
  | No-write when already ignored | `already ignored context performs no ignore-file write` — `.context/.gitignore` unexpectedly existed; context mtime invariant failed. | `45e93fbb1d9a2646f8fbf537f66b3eed8f4f9cd99485888e384282bc31b69728` | same |
  | Idempotent/duplicate-entry refusal | `refuses to duplicate an existing ineffective or negated entry` — call resolved instead of refusing. | `45e93fbb1d9a2646f8fbf537f66b3eed8f4f9cd99485888e384282bc31b69728` | same |
  | Symlink refusal | `refuses a symlinked context ignore file` — received `review_ignore_unsafe_target`, not the required `review_ignore_symlink`. | `91652ce6cf5ac244527a9846e8af2f1d12ad8bb7c278a1268a52bbd5d0353e82` | same |
  | Effectiveness re-check | `fails closed when the post-write ignore verification is ineffective` — call resolved; fixed-argv test observed only one check. | `91652ce6cf5ac244527a9846e8af2f1d12ad8bb7c278a1268a52bbd5d0353e82` | same |
  | Artifact-only extraction | `persists only artifact and adds schema_version after making the directory effectively ignored` — persisted wrapper included `kind` and `report`. | `91652ce6cf5ac244527a9846e8af2f1d12ad8bb7c278a1268a52bbd5d0353e82` | same |
  | Schema insertion | Same named persist test — observed `schema_version` was undefined. | `91652ce6cf5ac244527a9846e8af2f1d12ad8bb7c278a1268a52bbd5d0353e82` | same |
  | Atomic rename | Persist test raised `ENOENT` reading `review-summary.json`; failed-validation test observed no artifact on disk. | `91652ce6cf5ac244527a9846e8af2f1d12ad8bb7c278a1268a52bbd5d0353e82` | same |
  | Temp cleanup | `removes the exclusively created temp file when rename preparation fails` — `.review-summary.<uuid>.tmp` remained. | `91652ce6cf5ac244527a9846e8af2f1d12ad8bb7c278a1268a52bbd5d0353e82` | same |
  | Report-only branch | `report-only mode writes no artifact and does not invoke validation` — received `incomplete`/`unavailable` with a path instead of `report_only`/`not_attempted`. | `91652ce6cf5ac244527a9846e8af2f1d12ad8bb7c278a1268a52bbd5d0353e82` | same |
  | Rejected finalize refusal | `refuses structurally rejected and unavailable finalize outcomes` — received `review_persist_kind` instead of `review_persist_rejected`. | `91652ce6cf5ac244527a9846e8af2f1d12ad8bb7c278a1268a52bbd5d0353e82` | same |
  | Unavailable finalize refusal | Same named refusal test — received `review_persist_kind` instead of `review_persist_unavailable`. | `91652ce6cf5ac244527a9846e8af2f1d12ad8bb7c278a1268a52bbd5d0353e82` | same |
  | Validation status mapping | Persist test returned `unavailable` with `validator exited with status 0` instead of `passed`. | `91652ce6cf5ac244527a9846e8af2f1d12ad8bb7c278a1268a52bbd5d0353e82` | same |
- No test remained green when its listed guard was reverted; no additional test-strengthening was required during the revert runs.
- Remaining: U3c plugin/approval surface; U3a T5 by-reference output storage and client timeout remain pending per the recorded U3a state. The exact requested full-suite command is green; the direct invocation from `broker` showed the separate four-failure discrepancy documented above. Native RDD review and owner installation/commit remain outside this sandbox task.

## Progress addendum — interpreter guard fixtures and revert verification (2026-10-17)

- Corrected the legacy `install-user-files --verify` fixture by recording `process.execPath` as `BROKER_REVIEW_HELPER_INTERPRETER` in its temporary HOME broker environment. The 9 original failures were caused by that absent fixture value; no installer requirement or assertion was weakened.
- Added installer checks: `--apply` journals and writes the canonical interpreter alongside the path and digest; repeated `--apply` preserves exactly one interpreter assignment; `--apply` refuses with `REVIEW_HELPER_INTERPRETER_MISSING` when neither `node` nor `bun` resolves; `--verify` rejects missing, non-absolute, and non-executable interpreter values for a pinned install.
- Strengthened the unconfigured interpreter test to assert the dedicated diagnostic `review helper interpreter is not configured`, so removing the null-specific refusal no longer passes through the generic invalid-path branch.
- Focused checks: `bun test tests/install-user-files-verify.test.ts` — 33 pass / 0 fail; `bun test tests/review-helper-pin.test.ts` — 23 pass / 0 fail; `bun test tests/review-pipeline.test.ts` — 12 pass / 0 fail.
- Full check: `bun --cwd broker test --reporter=dot` — 1100 pass / 0 fail across 69 files. Build: `bun build --target=bun src/main.ts` from `broker` succeeded. Syntax: `bash -n scripts/install-user-files` succeeded. No command used the real `$HOME` for installer execution; installer tests used temporary HOME fixtures.
- RED observed on the original spawn shape `[helper.path, ...]`: the mode-0600 test returned `{ outcome: "validation_unavailable", code: "review_pipeline_validation_unavailable", diagnostic: "" }`; the assertion failed because accepted output was expected. The spawn throw is caught and mapped to unavailable with an empty diagnostic. The silent diagnostic is recorded as a parent finding; behavior was not changed.
- Isolated revert experiments (each targeted named test failed; each source file was restored to its before SHA-256):

  | Guard removed | Focused test and observed failure | Before SHA-256 | After SHA-256 |
  |---|---|---|---|
  | Dedicated unconfigured-interpreter refusal (`review-run.ts`) | `refuses an unconfigured interpreter before spawning` — expected the dedicated “not configured” message; got the generic “must be a non-empty absolute path” message. The test was strengthened to detect this branch. | `2923113bb72670c2187be7d46ce5b2f92beb5cb3535c306213086eafcd88a143` | `2923113bb72670c2187be7d46ce5b2f92beb5cb3535c306213086eafcd88a143` |
  | Interpreter regular-file check (`review-run.ts`) | `refuses missing, symlinked, and non-executable interpreters by distinct code` — expected rejection; promise resolved. | `2923113bb72670c2187be7d46ce5b2f92beb5cb3535c306213086eafcd88a143` | `2923113bb72670c2187be7d46ce5b2f92beb5cb3535c306213086eafcd88a143` |
  | Interpreter executable-bit check (`review-run.ts`) | Same named test — expected rejection; promise resolved. | `2923113bb72670c2187be7d46ce5b2f92beb5cb3535c306213086eafcd88a143` | `2923113bb72670c2187be7d46ce5b2f92beb5cb3535c306213086eafcd88a143` |
  | Pipeline interpreter argv (`review-pipeline.ts`) | `runs a mode-0600 pinned helper through its configured interpreter` — observed argv omitted `/usr/local/bin/bun`; after adjusting the temporary assertion to proceed, result was `validation_unavailable` with diagnostic `""` rather than accepted output. | `9f455b8ac962c99a11f6601e8ab467676b5db67a38b68a909ca2012e2506b477` | `9f455b8ac962c99a11f6601e8ab467676b5db67a38b68a909ca2012e2506b477` |
  | Persist validator interpreter argv (`review-persist.ts`) | `persists only artifact and adds schema_version` — exact argv assertion failed (`false`). | `8edcae0f2f3e80c8a7c267d9ccfdd86dadb85bcf7bd1ac21cbd4780781b1dd7a` | `8edcae0f3e80c8a7c267d9ccfdd86dadb85bcf7bd1ac21cbd4780781b1dd7a` |
  | Installer canonical interpreter resolution (`scripts/install-user-files`) | `apply pins the highest version with private modes and broker env values` — expected resolved `/usr/local/bin/bun`; got the temporary symlink path under HOME. | `92e12ce677f73588d9ec4da87655b361354ecb83e6af021d45d262e6d91c091e` | `92e12ce677f73588d9ec4da87655b361354ecb83e6af021d45d262e6d91c091e` |
  | Installer refusal when no interpreter resolves (`scripts/install-user-files`) | `apply refuses when neither node nor bun resolves` — expected nonzero; apply succeeded after removing the refusal branch. | `92e12ce677f73588d9ec4da87655b361354ecb83e6af021d45d262e6d91c091e` | `92e12ce677f73588d9ec4da87655b361354ecb83e6af021d45d262e6d91c091e` |
  | Installer interpreter verify check (`scripts/install-user-files`) | `verify refuses missing, non-absolute, and non-executable pinned interpreters` — expected status 1; got status 2 (legacy missing-journal incomplete result), with no interpreter drift detected. | `92e12ce677f73588d9ec4da87655b361354ecb83e6af021d45d262e6d91c091e` | `92e12ce677f73588d9ec4da87655b361354ecb83e6af021d45d262e6d91c091e` |

- No revert experiment stayed green. Fixture additions and exact diagnostic assertions made all requested experiments fail observably; only the unconfigured-message assertion needed strengthening.
- Reviewability receipt for this sandbox delta is recorded in the delivery response after measuring `git diff --output=<path>` and `wc -c <path>`. No commit was created; S17 files remain in the sandbox result for owner-controlled installation/review.

## Next step
Complete U3a T5/client-timeout integration, then U3c surfacing and its owner-controlled review/install steps.
