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
- [x] Bounded test-first allowlist defect fix: baseline was **843 pass / 0 fail / 3816 expect() calls / 843 tests across 54 files [4.96s]** (the requested expectation was 847, but the observed baseline was 843). The new test first failed with `ValidationError: env key 'GIT_INDEX_FILE' is not on the worker env allowlist`; cause: `assertWorkerEnv` performs exact set membership, so the `GIT_*` entry was inert. Added only `GIT_INDEX_FILE`, removed the misleading `GIT_*` entry, and documented why a wildcard is forbidden (`GIT_SSH_COMMAND` and `GIT_EXTERNAL_DIFF` execute commands). The test uses `defaultConfig().resource.envAllowedKeys` and covers the intended key, wildcard negative control, and S8/S9 credential rejection. Focused after fix: **3 pass / 0 fail / 3 expect() calls / 3 tests across 1 file [14.00ms]**. Full suite after fix: **846 pass / 0 fail / 3819 expect() calls / 846 tests across 55 files [4.91s]**. `bun build --target=bun src/main.ts` from `broker` completed successfully (exit 0).
- [x] Blast-radius finding: `service.ts:738` (`assertPinnedSnapshotCompatible`) uses `ctx.git.spawn` host-side; `service.ts:806` (`runSnapshot`) uses `ctx.git.spawn` host-side; `service.ts:2065` (`hostDivergence`) uses `ctx.git.spawn` host-side; and `gitops.ts:72` is only the pure `buildSnapshotPlan` env description, whose `argvSteps` are executed host-side through `ctx.git.spawn`, not `MsbAdapter.exec`/`assertWorkerEnv`. Only active `buildDiffOp` at `service.ts:1579` passes `GIT_INDEX_FILE` to worker `adapter.exec` and is gated by `assertWorkerEnv`; this change resolves that affected worker call without changing the host-side call sites.
- [ ] T3 — expose broker-computed patch bytes.
- [ ] T4 — correct the description and cap output.
- [ ] T5 — broaden/complete real-Git integration coverage for the remaining receipt-byte case.

## Next step
The exact-membership `GIT_INDEX_FILE` allowlist defect is fixed and verified; its worker call path is now permitted without introducing a wildcard. The four adjacent `GIT_INDEX_FILE` references are host-side (three `ctx.git.spawn` execution paths and the pure `gitops.ts` plan), so no other call site needed an edit. The full suite is green at 846 tests and the broker build exited 0. Continue with T3 — expose the complete committed B→C patch byte count from `host_sandbox_result`; do not change result contents or apply/install/divergence guards. T4 and T5 remain unchecked.
