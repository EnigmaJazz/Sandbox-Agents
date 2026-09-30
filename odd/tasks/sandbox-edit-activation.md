# Sandbox Edit Activation

## Objective

`sandbox_edit` must work when it is the first worker-touching operation in a session, and a write into a directory that does not yet exist must succeed.

## Problem and verified journal evidence

Broker journal evidence from 2026-09-30:

1. **The edit pre-read refuses on a session with no worker.** `sandbox_edit` locates `oldString` by reading the file first, and that read goes through the read path, which by design requires an already-active worker and never creates one. Observed journal entry:

   ```json
   {"sessionID":"ses_f0c8a5e22ffenuO74rlYT8aSQv","agent":"general","operation":"readFile","result":"error","error":"session ses_f0c8a5e22ffenuO74rlYT8aSQv has no worker recorded — fail closed","durationMs":0.368787}
   ```

   This is the read path's fail-closed refusal, **not** the terminal `FAILED_CLOSED` state.

2. **The same-millisecond pair proves the asymmetry.** `ensureWorker` immediately preceded that session's own `writeFile`:

   ```json
   {"sessionID":"ses_f0c918afcffeL3aupHaI7R0cK7","operation":"ensureWorker","result":"ok","durationMs":768.724437}
   ```

   `ensureWorker` itself is healthy throughout (580–770 ms), so this is not an ensure timeout; a write does ensure before acting.

3. **A release in the gap also contributes.** The session associated with the refusing read shows successful `ensureWorker` calls at 18:57:27 (563 ms) and 18:58:43 (15 ms), then the refusing read at 19:00:52 — roughly two minutes later, consistent with an idle reap having released the worker. Reads never ensure, and a released session cannot be resumed by a read.

4. **A separate second defect: writing into a new directory.** The broker journal records:

   ```json
   {"sessionID":"ses_f0c918afcffeL3aupHaI7R0cK7","operation":"writeFile","result":"error","error":"writeFile failed in worker (status 1): • Backend local\nmv: cannot move '/work/.broker-tmp/write-3897ba18-1c23-4ac9-979c-1b17c24acfa4.tmp' to 'delegation-test/general-writer-test.md': No such file or directory"}
   ```

   The worker's temp-then-`mv` path does not create the target's parent directory.

## Constraints and non-goals

- The documented contract that reads require an active worker and never create one is **by design**. Do not change the read paths to activate workers.
- Fix the mutation path: `sandbox_edit` must ensure the worker **before** its internal read.
- Preserve every existing refusal and containment check.
- Do not change the reaper's release-only idle behaviour.
- `opencode/plugins/**` and `broker/src/**` are S17 paths and are preserved for manual installation.

## Scope

- `opencode/plugins/lib/sandbox-edit-core.ts` and the plugin tool path that calls it.
- The broker/worker write path for the parent-directory defect.
- Tests for both defects.

## Stable task IDs

- **T1:** Ensure-before-read in the edit path.
- **T2:** Parent-directory creation in the write path.
- **T3:** Tests, including a first-operation edit on a fresh session.
- **T4:** Checks and the reviewability receipt.

## Acceptance criteria

- A `sandbox_edit` as the first worker-touching operation in a fresh session succeeds.
- A write into a non-existent directory succeeds.
- Read paths still refuse without an active worker, unchanged by design.
- An ambiguity/absence refusal in the edit is preserved.
- The full suite is green.
- The build succeeds.

## Authorized scope

Only the files above and their tests. This tracker does not authorize commit, push, PR, merge, or release.

## Checks

- `bun --cwd broker test` — report exact totals; baseline is **556 pass, 0 fail**.
- `bun build broker/src/main.ts --outfile <outside the repository>`.
- Verification must **EXECUTE** what it validates: run the operation and observe its outcome, not merely parse or build it.

## Route and trigger evidence

- Route: `delegated`.
- Specialist: `general` (sandbox writer, per the user's coding-model decision: “Linked directly to OpenCode”).
- Trigger: the two-or-more-non-trivial-files writer trigger.

## Delivery strategy

Forecast: approximately 60 authored additions and 15 authored deletions across the scoped implementation and tests (about 75 authored lines total; estimate only, to be revisited against the actual staged diff). Chosen strategy: **single-pr** under the `ask-on-risk` / `auto-chain` / `single-pr` / `exception-ok` policy; the forecast is below the normal 400-line / 100-KiB review budget and does not imply an exception or chain.

## Progress

T1–T4 not started.

## Next step

Implement T1–T4 as one bounded change, then return the reviewability receipt.
