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

## Next step
Continue U3a before treating it complete: resolve the outstanding tests and registrations above, run each guard revert with before/after hashes, and record observed outcomes.
