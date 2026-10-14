# Sandbox diff fidelity and receipt byte count

## Objective
Make the active worker diff truthful and make the reviewability receipt's authored patch byte count a broker-computed field, so a worker never measures it by hand and can never report a wrong number.

## Problem
Two Tier 3 defects share the same root: the current active-diff path does not faithfully describe the worker changes, and the authored-patch byte count cannot be measured correctly from inside the sandbox.

- **Tier 3 item 2:** `sandbox_diff` active mode reports zero because `buildDiffOp` runs `git diff <baseline> HEAD` while the worker's `HEAD` is the baseline and its edits are uncommitted (`broker/src/service.ts`, around lines 1577–1588).
- **Tier 3 item 7:** `authored_patch_bytes` cannot be measured in the sandbox. The differential experiment established that `git diff --numstat`, `--stat`, and `--shortstat` omit untracked files entirely; a pipeline form is refused by the sandbox tokenizer with the exact message `argv item contains shell metacharacters`; `git diff --output=<path>` plus `wc -c <path>` works argv-only but returned **0 bytes** for an untracked-only change, silently reporting a wrong number; `git diff --no-index --output=<p> /dev/null <file>` plus `wc -c` correctly measured one untracked file (**230 bytes**), but no single argv-only form measures a combined tracked-and-untracked patch.

## Constraints
- `broker/src/**` and `opencode/plugins/**` are S17 paths. Expect `sandbox_apply` to be refused; retain the result for the owner to review, apply, and commit by hand.
- Keep the broker dependency-free (`bun:test` plus Node built-ins).
- Do not weaken the apply, install, or divergence guards.
- Do not change the exported result's contents.
- **Non-goal:** Do not rewrite `runPrepare` in this unit. It works, and rewriting the export path carries more risk than the drift it would remove. `sandbox_diff` is a faithful simulation of the export, not a shared implementation, so its exclusions must be kept in step with `runPrepare` by a test.

## Tasks (stable IDs)

### T1 — Share the exclusion pathspecs
Extract the shared exclusion pathspecs so `buildDiffOp` and `runPrepare` cannot drift apart. Preserve the exact `.broker-tmp` and `*.bundle` exclusions.

### T2 — Make active `buildDiffOp` reflect the worker tree
Compute its diff through a temporary index seeded from the baseline and staged from the worker working tree. Leave the worker's real index and `HEAD` untouched, and reproduce the exact `.broker-tmp` and `*.bundle` pathspec exclusions. Return `diff`, `stat`, `changedPaths`, and the apply preview from this construction.

### T3 — Expose broker-computed patch bytes
Expose `patchBytes` on `host_sandbox_result`, computed from the complete B→C patch it already reads. Expose the authored changed-line count too if it is already computable from that same data. The authoritative receipt value is the committed result patch; the install-time divergence guard proves it matches what is installed.

### T4 — Correct the description and cap output
Correct the false active-mode `sandbox_diff` tool description and apply the output cap in `buildDiffOp`.

### T5 — Add real-Git integration coverage
Use real-Git integration tests, not mocked adapters, for each falsifying case:
- A tracked edit alone produces a non-empty diff.
- An untracked new file appears in `diff`, `stat`, `changedPaths`, and `applyPreview`.
- An untracked-only change produces `patchBytes > 0` on `host_sandbox_result`.
- `.broker-tmp` is excluded.
- A deleted tracked file appears as deleted.

## Acceptance criteria
- Each falsifying test fails against the current source and passes after the change.
- `host_sandbox_result` reports a byte count for a result whose only change is a new file.
- A `sandbox_diff` call leaves the worker's real index and `HEAD` unchanged.
- The valid argv-only fallback `git diff --no-index --output=<p> /dev/null <file>` plus `wc -c` is recorded as valid for a **single untracked file only**. It does not measure a combined tracked-and-untracked patch; `git diff --output=<path>` plus `wc -c` silently gives the wrong zero-byte result for an untracked-only change.

## Checks
- Baseline, before edits: `bun --cwd broker test --reporter=dot` — **838 pass / 0 fail / 3802 expect() calls / 838 tests across 53 files [4.99s]**.
- RED, before production edits: `bun --cwd broker test tests/sandbox-diff-fidelity.test.ts --reporter=dot` — **2 pass / 3 fail / 7 expect() calls / 5 tests across 1 file [82.00ms]**. Failures were tracked edit `result.diff` expected `-base`, received empty; untracked file `result.diff` expected `new-file.txt`, received empty; deleted file `result.diff` expected `deleted file mode`, received empty.
- Focused after implementation: `bun --cwd broker test tests/sandbox-diff-fidelity.test.ts --reporter=dot` — **5 pass / 0 fail / 12 expect() calls / 5 tests across 1 file [94.00ms]**.
- `service-diff.test.ts` focused after updating the active-mode argv expectation: `bun --cwd broker test tests/service-diff.test.ts --reporter=dot` — **3 pass / 0 fail / 7 expect() calls / 3 tests across 1 file [21.00ms]**.
- Full suite after the follow-up: `bun --cwd broker test --reporter=dot` — **843 pass / 0 fail / 3816 expect() calls / 843 tests across 54 files [4.90s]**.
- Requested build command `bun --cwd broker build --target=bun src/main.ts` returned `error: Script not found "build"` (Bun treats `build` as a script in this form). Equivalent build executed from `broker`: `bun build --target=bun src/main.ts` completed successfully (exit 0).
- Real-Git integration tests execute in `sandbox-diff-fidelity.test.ts`; `state-artifacts.test.ts` confirms the unchanged real-Git `runPrepare` flow.

## Route and delivery
- Route: delegated sandbox writer, secure ODD.
- One work-unit commit per task. The owner applies and commits S17 paths.
- A reviewability receipt is required.

## Progress
- [x] Diagnosis complete. The source of the two defect records is `docs/TODO.md`, Tier 3 items 2 and 7. The differential experiment established the untracked-file measurement behavior and exact tokenizer error recorded above.
- [x] Pre-code advisory complete. It corrected the premise that `prepareResult`/`runPrepare` uses a temporary index: it stages and commits on the worker's real index and `HEAD` (`git add -A`, `git commit`, `git update-ref`; `broker/src/service.ts:1713–1768`). The temporary-index pattern to follow is `hostDivergence` (`broker/src/service.ts:1995–2044`).
- [x] Advisory evidence: active-mode `sandbox_diff` tool description is false (`opencode/plugins/sandbox-tools.ts:362–365`); `buildDiffOp` does not apply `GIT_OUTPUT_MAX_BYTES` on the worker; `runPrepare` exclusions are pathspec-based and must be reproduced exactly. `service-diff.test.ts` and `apply-preview.test.ts` mock the adapter and cannot catch either defect. `host_sandbox_result` (`broker/src/service.ts:2732–2780`) already reads the complete committed B→C patch, making it the least-change surface for exposing bytes.
- [x] T1 — shared `RESULT_EXCLUDE_PATHS` is defined in `broker/src/diff-spec.ts` and used by both active `buildDiffOp` and `runPrepare`; `runPrepare` retains the identical `git add -A -- . :(exclude).broker-tmp :(exclude)*.bundle` argument sequence.
- [x] T2 — active diff seeds a disposable `GIT_INDEX_FILE` from the baseline, stages the worker working tree with the shared exclusions, and reads stat/diff/name-status/changed paths from the cached diff; cleanup removes the temporary index. The real-Git tests confirm untracked and deleted files are included and the real index/HEAD remain unchanged.
- [x] Follow-up: updated `service-diff.test.ts`'s active path-discovery argv shape assertion to require `git diff --cached --name-only --no-renames -z <baseline> -- .` plus both shared exclusions, and added assertions for baseline seeding (`git read-tree`) and staging (`git add -A` with the same exclusions). Retained-mode assertions are unchanged.
- [x] T3 — expose broker-computed patch bytes. `patchBytes` is measured from the complete `completePatch.stdout` at `broker/src/service.ts:2856`, the same source passed to `ensureCompleteApplyPreview`; `authoredChangedLines` sums numeric additions and removals from `readResult.changedPaths` at `broker/src/service.ts:2857–2860`. The response fields are typed by `SandboxResultPatchMetrics` at `broker/src/types.ts:314`. Real-Git tests in `broker/tests/sandbox-result-patch-bytes.test.ts` cover untracked-only, patch-byte agreement, empty result, and line totals.
- [x] T4 — corrected the false `sandbox_diff` description: active mode includes worker uncommitted edits and untracked files; retained mode reads the exported result. `buildDiffOp` now supplies `GIT_OUTPUT_MAX_BYTES` to worker git execution and refuses any bounded git output (stat, diff, name-status, changed paths, or compare) at or above the cap rather than returning a possibly truncated value. The manifest citation now points to `sandbox-tools.ts:362-372`.
- [x] T5 — real-Git fidelity tests cover oversized diff refusal, a tracked edit plus untracked file together, `.broker-tmp` exclusion across diff/stat/changed paths/apply preview, and deleted tracked files. The existing `.broker-tmp` and deleted-file tests already existed; `.broker-tmp` assertions were strengthened to check all returned diff surfaces.
- [x] No duplicate T3 receipt-byte cases: `sandbox-result-patch-bytes.test.ts` already covers untracked-only `patchBytes > 0`, exact patch-byte agreement, empty-result bytes, and authored line totals. Those T5 cases remain covered by T3 and were not duplicated here.
- [x] Env-allowlist defect and fix — restored as a progress entry after the earlier baseline restore dropped it; recorded elsewhere. This T4/T5 unit did not modify that fix.

### T3 evidence
- Baseline command: `bun --cwd broker test --reporter=dot` — `843 pass`, `0 fail`, `3816 expect() calls`, `Ran 843 tests across 54 files. [5.03s]`.
- RED command: `bun --cwd broker test tests/sandbox-result-patch-bytes.test.ts --reporter=dot` — `0 pass`, `4 fail`, `5 expect() calls`, `Ran 4 tests across 1 file. [84.00ms]`. The untracked-only test failed at `expect(result.patchBytes).toBeGreaterThan(0)` with `Expected and actual values must be numbers or bigints`; byte agreement, empty result, and authored line count each received `undefined`.
- Focused GREEN command: `bun --cwd broker test tests/sandbox-result-patch-bytes.test.ts --reporter=dot` — `4 pass`, `0 fail`, `5 expect() calls`, `Ran 4 tests across 1 file. [88.00ms]`.
- Full suite: `bun --cwd broker test --reporter=dot` — `847 pass`, `0 fail`, `3821 expect() calls`, `Ran 847 tests across 55 files. [4.92s]`.
- Build: from `broker`, `bun build --target=bun src/main.ts` completed successfully; observed successful build output and no error (exit status 0).
- The valid receipt-byte implementation measures the complete patch already held by the broker. It does not use `git diff --output=<path>` plus `wc -c`, which silently yields zero for an untracked-only change.

### T4/T5 evidence (2026-10-14)
- Baseline before edits: `bun --cwd broker test --reporter=dot` — **850 pass / 0 fail / 3824 expect() calls / 850 tests across 56 files [5.09s]**.
- RED for the active oversized-diff test, before active production edits: `bun --cwd broker test tests/sandbox-diff-fidelity.test.ts --reporter=dot` — **6 pass / 1 fail / 18 expect() calls / 7 tests across 1 file [141.00ms]**. Verbatim failure: `Expected promise that rejects` / `Received promise that resolved: Promise { <resolved> }`.
- RED for the retained oversized-diff test, before retained production edits: the same focused command — **7 pass / 1 fail / 22 expect() calls / 8 tests across 1 file [156.00ms]**. Verbatim failure: `Expected promise that rejects` / `Received promise that resolved: Promise { <resolved> }`.
- Focused GREEN after both active and retained coverage: `bun --cwd broker test tests/sandbox-diff-fidelity.test.ts --reporter=dot` — **8 pass / 0 fail / 22 expect() calls / 8 tests across 1 file [147.00ms]**.
- Full suite: `bun --cwd broker test --reporter=dot` — **853 pass / 0 fail / 3834 expect() calls / 853 tests across 56 files [4.93s]**.
- Build: from `broker`, `bun build --target=bun src/main.ts` — completed successfully, exit status 0.
- Output-cap behavior: active and retained `buildDiffOp` git outputs are constrained with `maxOutputBytes: GIT_OUTPUT_MAX_BYTES` and rejected with `ValidationError` when their UTF-8 byte count is `>= GIT_OUTPUT_MAX_BYTES`. This deliberately refuses rather than silently truncating a unified diff or auxiliary metadata. It mirrors `buildSandboxResultOp` at `broker/src/service.ts:2854,2863`, which passes the same cap to git and only uses the complete patch when its measured UTF-8 bytes are `< GIT_OUTPUT_MAX_BYTES`.
- Existing `.broker-tmp` and deleted-file cases passed; `.broker-tmp` was strengthened to assert absence from diff, stat, changed paths, and apply preview.
- Exact-description literal search over the registered project found no old-description assertion requiring edits outside the allowed surfaces.

## Review and closure
- Tracker complete; T1–T5 remain complete. Native review lineage `review-fe7cae5a7ddc98d0` approved and acknowledged; authority was burned via `review.acknowledge-approved`. The consumed revision is `sha256:2e0ccdff8857a05429858367a55175669f70303dff3f288d43935e909f51d911`. Candidate: base `e87dc1bab5321f625aab3d4c3e5697270ab732bc` to `899aee290f72f20c3ba227d8da5411c1cf805faf`, 29 paths, 882 changed lines, medium risk. The bounded plan selected only `review-reliability`; no refuter ran, so there is no refuter verdict to record. New reviewed boundary: `05b54fa`.
- Queued non-blocking advisory `R3-patch-bytes-cap` in Tier 4 of `docs/TODO.md`: `patchBytes` is derived from `completePatch.stdout`, bounded by `GIT_OUTPUT_MAX_BYTES`; at the cap the value may report a truncated byte count, and no oversized-result test covers that boundary, leaving receipt accuracy for large results unproved. The metric at `broker/src/service.ts:2848` is computed unconditionally, while lines 2856–2863 gate the apply preview on being under the cap. Provider classification: WARNING, disposition `informational`, evidence class `inferential`, reported as `introduced`.

### Tier 4 item 56 follow-up
- Tier 4 item 56 (`R3-patch-bytes-cap`) is fixed in commit `5466b1c`. `patchBytes` is optional in `SandboxResultPatchMetrics`; if the raw patch was not read complete, the count is omitted and `rawPatchTruncated` is `true`, so callers cannot treat a truncated size as real.
- `authoredChangedLines` is unaffected: `readChangedPaths` already fails closed at the cap. Earlier tracker lines describing `patchBytes` as always present document T3 as first implemented; this note supersedes those descriptions.

## Post-code advice
- [x] Two independent post-code advisors reviewed commit `5466b1c`; findings and dispositions follow.
- **Cap-unit mismatch (fails closed) — queued.** `spawnArgv` caps on JavaScript string length (`msb.ts:70–72`), while the completeness predicate uses `Buffer.byteLength` (`service.ts:2849–2850`). A non-ASCII patch whose string length is below the cap but whose UTF-8 byte length is at or above it is genuinely complete yet is reported truncated, with the count omitted. This fails closed, so it is safe but pessimistic. `readChangedPaths` and the apply-preview gate both use byte length, so aligning this site alone would desynchronize it from them; the advisor identified `spawnArgv` reporting truncation as the real fix below.
- **`spawnArgv` truncation reporting — queued.** `spawnArgv` should report truncation rather than silently capping on a unit its callers must guess about. `odd/tasks/socket-write-drain.md` already records this underlying defect. This is the correct fix for the cap-unit mismatch above.
- **No in-repository consumer assumes `patchBytes` is present — resolved.** Verified by AST-grep over `broker/src` and `opencode/plugins`, and by a search across docs, openspec and plugins. The advisor could not determine whether a consumer outside this repository depends on the field.
- **Field-name confusion — resolved.** The rename in this working tree from `patchBytesTruncated` to `rawPatchTruncated` distinguishes the raw patch from the pre-existing `patchTruncated` bounded preview.
- **Inline preview silently capped — queued (new).** The inline preview is also capped by `maxOutputBytes`, so it can lose tail content without `patchTruncated` reflecting it.
- **Testing correction.** The oversized test would still pass if the spawn fake ignored the cap entirely, because `buildSandboxResultOp` recomputes the predicate itself; the fake's slicing does not affect the outcome. The fake extension did not achieve what was claimed for it. The RED was genuine and the test falsifies the original defect; what it proves is the predicate, not the fake's truncation behaviour.
- **Two fakes ignore output caps entirely — queued as a check.** `broker/tests/sandbox-diff-fidelity.test.ts:88–99` (spawn) and `:60–77` (`adapter.exec`) could hide defects in how `buildDiffOp` handles oversized output.
- Native review lineage `review-b97b2c817ed00b83` approved and acknowledged with authority burned. Target: `sha256:6c56ba4f46c3a8f077ac8f5298003c845f7d6a7ce449a433adf0ee4f8e5fc3b3`; candidate: base `899aee290f72f20c3ba227d8da5411c1cf805faf` to tree `c8ffaa89a2f01bfb04ab0c8a81cbf45d31c77cb6`, 6 paths / 65 changed lines, medium risk. The bounded plan selected one `review-reliability` lens. Consumed revision: `sha256:a0ea21ac165299f35c3f32e3253b7ef7046c629ff699c1f8204df2bab9b47f82`. The reviewed boundary advances to `1085ec6`.
- **`R3-rawPatchTruncated-semantics` — queued.** WARNING, reported as `introduced`, deterministic. At `broker/src/service.ts:2849-2852`, `rawPatchTruncated` is set whenever `patchComplete` is false, including a non-zero git exit status, while the type comment at `broker/src/types.ts:314` describes it as indicating only that the output cap was reached. This conflates cap truncation with git failure and can mislead a caller about why `patchBytes` is absent.
- **`R3-status-failure-coverage` — queued.** WARNING, reported as `introduced`, inferential. Tests at `broker/tests/sandbox-result-patch-bytes.test.ts:136-144` cover the over-cap case but do not exercise the `completePatch.status !== 0` branch of `patchComplete`; omission of `patchBytes` and `rawPatchTruncated: true` on git failure is unverified.

## Next step
The tracker is complete. The reviewed candidate contains S17-protected paths (`broker/src/**` and `opencode/plugins/**`); the owner must manually apply/commit the retained diff. No files outside the allowed edit surfaces were changed.
