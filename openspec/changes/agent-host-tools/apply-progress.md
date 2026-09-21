# Apply Progress: Agent Host Tools (Slice 1 / PR 1)

## Mode

Standard (`strict_tdd: false`; tests accompany implementation). No Strict TDD
module loaded.

## Completed Tasks

- [x] 1.1 Reconcile `sdd-continue`, `review assess`, and `review mode status` flags against the authoritative orchestrator-resolved flag contract; no host CLI was probed in the worker.
- [x] 1.2 Reconcile spec flags in `openspec/changes/agent-host-tools/specs/host-sdd-runtime-tools/spec.md`: `sdd-continue [change] --cwd <root>` (dropped `--json`), `review assess --cwd <root> --json` (added `--cwd`), `review mode status` (dropped `--json`).
- [x] 1.3 P0 payload types, operation names, allowlisted keys, canonical value/path validators, and `HostToolPolicy` authorization in `types.ts` / `validation.ts` / `validation.test.ts`.
- [x] 2.1 RED tests: exact status/continue/acquire/settle/archive/verify/task-result/review vectors, all settle outcomes, omitted interrupted revision, unsafe keys, and read-vs-mutation authorization.
- [x] 2.2 Fixed builders/handlers/dispatch in `sdd-runtime.ts`, `sdd-service.ts`, `service.ts`, `server.ts`; tools/policy in `sandbox-tools.ts`, `host-tool-approval.ts`, `sandbox-permissions.jsonc`.
- [x] 2.3 Pure metadata-rich `ctx.ask` helper + tests.

## Files Changed

| File | Action | What |
|------|--------|------|
| `broker/src/types.ts` | Modified | New `Operation`s, payload interfaces, `SddSettleOutcome` / `SddHarnessDisposition`. |
| `broker/src/validation.ts` | Modified | Canonical host validators, `HostToolPolicy`, payload key allowlists. |
| `broker/src/sdd-runtime.ts` | Modified | Fixed argv builders + executor methods for the P0 read set, three mutations, and tolerant `reviewModeStatus`. |
| `broker/src/sdd-service.ts` | Modified | Authorization-aware handlers for every P0 op. |
| `broker/src/service.ts` | Modified | `authorizeHostDispatch` (reads open, mutations orchestrator-only). |
| `broker/src/server.ts` | Modified | Dispatch cases for the new operations. |
| `opencode/plugins/lib/host-tool-approval.ts` | Created | Pure ask-metadata builders for host mutations. |
| `opencode/plugins/sandbox-tools.ts` | Modified | `host_sdd_*` / `host_review_*` tools; `ctx.ask` on mutations. |
| `opencode/config-fragments/sandbox-permissions.jsonc` | Modified | Reads `allow`; mutations `ask`. |
| `broker/tests/{validation,sdd-runtime,service-host-tools,host-tool-approval}.test.ts` | Modified/Created | Vector, settle-variant, authorization, and ask-metadata tests. |
| `openspec/changes/agent-host-tools/tasks.md` | Modified | Tasks 1.1–2.3 checked off. |
| `openspec/changes/agent-host-tools/specs/host-sdd-runtime-tools/spec.md` | Modified | Reconciled fixed-argv flags (line ~7). |

## Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `cd broker && bun test` → **194 pass / 0 fail**, 715 expect() calls, 14 files, ~251 ms. |
| Runtime harness command and exact result | `bun build --target=bun --outfile=/tmp/bc-main.js src/main.ts` → **Bundled 17 modules in 7ms** (`bc-main.js` 133.30 KB). A bare stdout build streams a >512 KiB bundle and hits the sandbox exec cap, so `--outfile` is used. |
| Rollback boundary | Revert the six `broker/src` files, `opencode/plugins/lib/host-tool-approval.ts`, `opencode/plugins/sandbox-tools.ts`, `opencode/config-fragments/sandbox-permissions.jsonc`, the four broker test files, and the spec/tasks/apply-progress docs. No persisted schema; host tools fall back to the two existing SDD ops. |

## Deviations from Design

- `HostToolPolicy`, the canonical host validators, and the read/mutation operation
  classification live in `validation.ts`; `authorizeHostDispatch` lives in
  `service.ts`. This matches the task file list (design named only the policy).
  Trusted session→agent resolution mirrors `ensureWorker` (`record.agent ??
  envelope.agent`).
- `review mode status` uses a tolerant `runRaw` path: numeric status + raw text,
  JSON parsed only when stdout actually parses; it never hard-fails on non-JSON.
- `sdd-verify-validate` requirement/scenario counts accept `0..100000`
  (non-negative), not only positive.
- `sdd-archive-compose` / `sdd-verify-validate` / `sdd-task-result` resolve
  project-relative paths beneath the canonical root and emit absolute paths, so
  the commands are cwd-independent (`sdd-task-result` still carries `--cwd`).
- Slice scope only: `gitCommit`/`gitPush`/`ghIssueCreate`, `registerProject`
  dispatch, and docs are intentionally NOT implemented (slices 2–3).

## Issues Found

- The sandbox exec rejects a relative `cwd`; runs use `env -C /work/broker`.
- `sandbox_apply_patch` requires correct hunk counts; patches with a bare
  `-`/`+` block and no context line are rejected, so context lines are included.
- S17 protected paths (`broker/src/**`, `opencode/plugins/**`,
  `opencode/config-fragments/**`) are touched; operator-authorized relaxation is
  required at `sandbox_apply`.

## Workload / PR Boundary

- Mode: chained PR slice (auto-chain, stacked-to-main). Unit 1 = runtime commands
  + authorization (PR 1).
- Boundary: from the two existing SDD ops to the full P0 read set + three
  orchestrator-only mutations with approval. Unit 2 (git/GH) and Unit 3
  (registration/docs) are explicitly out of scope.
- Budget: this slice exceeds the 800-line review budget. The apply-time cap is
  operator-removed for this slice, so it lands as one cohesive work unit with its
  mandatory tests rather than being compressed or gutted.

## Status

Slice 1 complete: 1.1–2.3 done (6 of 22 tasks). Ready for independent
verification of this slice.

## Slice 2: Git, GH, Registration Boundary (work unit `slice2-git-gh-tools`, PR 2)

### Completed Tasks

- [x] 3.1 RED tests: approved-cwd/selector rejection, B→C scope, staged/empty state, `-a` avoidance, S17 protected paths, branch/upstream/detached/force/refspec guards, redaction, caps, and exact GH argv.
- [x] 3.2 `gitCommit`/`gitPush`/`ghIssueCreate` across `gitops.ts`, `service.ts`, `server.ts`, `sandbox-tools.ts`, `broker-client.ts`, `host-tool-approval.ts`, and `sandbox-permissions.jsonc`.

### Files Changed (slice 2)

| File | Action | What |
|------|--------|------|
| `broker/src/types.ts` | Modified | `gitCommit`/`gitPush`/`ghIssueCreate` operations + `GitCommitPayload`/`GitPushPayload`/`GhIssueCreatePayload`. |
| `broker/src/validation.ts` | Modified | Git/GH canonical validators (commit message, path list, remote/branch, repo/title/body caps) and payload-key allowlists; all three in `HOST_MUTATION_OPERATIONS`. |
| `broker/src/gitops.ts` | Modified | `buildGitCommitArgv`, `buildGitPushArgv`, `buildGhIssueCreateArgv`, `capAndRedact` (redact then 512-KiB cap). |
| `broker/src/service.ts` | Modified | `resolveCanonicalProjectRoot`, `runHostStep`, and the three orchestrator-only handlers. |
| `broker/src/server.ts` | Modified | Dispatch cases for the three operations. |
| `opencode/plugins/lib/host-tool-approval.ts` | Modified | `buildGitCommitAsk`/`buildGitPushAsk`/`buildGhIssueCreateAsk` + union extension. |
| `opencode/plugins/sandbox-tools.ts` | Modified | `host_git_commit`/`host_git_push`/`host_gh_issue_create` tools with `ctx.ask`. |
| `opencode/plugins/lib/broker-client.ts` | Modified | Operation timeouts for the three tools. |
| `opencode/config-fragments/sandbox-permissions.jsonc` | Modified | `ask` for all three tools. |
| `broker/tests/{gitops,service-host-tools,host-tool-approval}.test.ts` | Modified | Guard/vector/cap/redaction, authorization, handler, and ask-metadata coverage. |

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `env -C /work/broker bun test` -> **240 pass / 0 fail**, 901 expect() calls, 15 files (~204 ms). |
| Runtime harness command and exact result | `env -C /work/broker bun build --target=bun --outfile=/tmp/bc-main.js src/main.ts` -> **Bundled 17 modules** (149.45 KB). Plugin parse: `env -C /work bun build --external @opencode-ai/plugin --external zod --outfile=/tmp/plugin-check.js opencode/plugins/sandbox-tools.ts` -> **Bundled 10 modules** (0.98 MB). |
| Rollback boundary | Revert `broker/src/{types,validation,gitops,service,server}.ts`, `opencode/plugins/{sandbox-tools.ts,lib/host-tool-approval.ts,lib/broker-client.ts}`, `opencode/config-fragments/sandbox-permissions.jsonc`, the three broker test files, and the tasks/apply-progress edits. The three operations fall back to "unknown operation"; no persisted schema. |

### Workload / PR Boundary

- Mode: `single-pr` with maintainer-approved `size:exception` (the slice exceeds the ledger's 800-line cap).
- Boundary: from the slice-1 host-tool pipeline to the three fixed-argv git/GH mutations with approval. `registerProject` dispatch (3.3) and docs (3.4) remain out of scope.
- Authored B→C lines: **1024** (git numstat, before artifact docs). Cannot shrink further without dropping required RED coverage (365 test lines) or the mandatory ask-metadata helpers; landing as one cohesive work unit rather than gutting tests.

### Deviations from Design

- `buildGitPushArgv` takes broker-resolved `{branch, upstream, ahead, remote, setUpstream, allowProtectedBranch}` and refuses every unsafe shape via strict remote/branch allowlists (rejecting leading `-`, `+`, `:`, and `..`), so force/force-with-lease/delete/`+refspec` can neither be requested nor encoded.
- `gitPush` resolves branch/upstream/ahead with read-only `git symbolic-ref`/`rev-parse`/`rev-list` before the guard, so no push spawns on a refused condition.
- The plugin ask metadata for commit/push carries the fields available at plugin time (message; remote/setUpstream); the broker-owned derived values (branch/paths/ahead) are enforced and returned by the handler. The pure helpers support the full field set for callers that have it.
- `gitCommit` requires session state `APPLIED` with a persisted `resultRef`; unrelated staged work is never swept because both argv steps carry explicit `-- <paths>`.

### Issues Found

- `sandbox_apply_patch` requires every hunk to end with a context line and rejects zero-context EOF appends; blank context lines are matched literally.
- GH repo slugs needed a leading-`-` guard beyond the charset (added a negative lookahead).

### Status

Slice 2 complete: tasks 3.1 and 3.2. Focused tests and both builds green. Ready for independent verification.
## Task Group 3.3-3.4: Registration dispatch and S17 rollout docs

### Completed Tasks

- [x] 3.3 Wired `buildRegisterProjectOp` into broker dispatch and authorization: `server.ts` dispatch case, `validation.ts` `HOST_MUTATION_OPERATIONS` + `assertRegisterableProjectPath` path-ban validator, and the `service.ts` handler now uses `payloadOf` + `authorizeHostDispatch` + the banned-path/existence check before spawning. Success/non-zero/ban/no-spawn/exact-key/authorization tests added to `broker/tests/service-host-tools.test.ts`; validator/allowlist tests added to `broker/tests/validation.test.ts`.
- [x] 3.4 Documented the S17 protected-path review and `.new` staging/apply-review rollout in `docs/threat-model.md` (additive; no live configuration touched).

### Files Changed (3.3-3.4)

| File | Action | What |
|------|--------|------|
| `broker/src/validation.ts` | Modified | `registerProject` added to `HOST_MUTATION_OPERATIONS`; `assertRegisterableProjectPath` + banned-root constants; `statSync` import. |
| `broker/src/service.ts` | Modified | `buildRegisterProjectOp` authorizes the orchestrator, uses the shared payload allowlist, and rejects banned/ineligible paths before spawn; exact fixed argv preserved. |
| `broker/src/server.ts` | Modified | Import + `registerProject` dispatch case (no more `StateError` fallback). |
| `broker/tests/service-host-tools.test.ts` | Modified | Success, non-zero, banned-path, flag-coupling, exact-key, and orchestrator-only coverage; `registerProject` added to the mutation authorization matrix. |
| `broker/tests/validation.test.ts` | Modified | Mutation classification, payload-key allowlist, and `assertRegisterableProjectPath` boundary coverage. |
| `docs/threat-model.md` | Modified | Host project registration boundary + S17 protected-path review/`.new` staging rollout. |
| `openspec/changes/agent-host-tools/{tasks.md,apply-progress.md}` | Modified | Tasks 3.3/3.4 checked; this section. |

### Work Unit Evidence

| Evidence | Value |
|----------|-------|
| Focused test command and exact result | `env -C /work/broker bun test` -> **313 pass / 0 fail**, 1387 expect() calls, 15 files (~275 ms). |
| Runtime harness command and exact result | `env -C /work/broker bun build --target=bun --outfile=/work/broker/dist/main.js src/main.ts` -> **Bundled 17 modules** (`main.js` 203.98 KB). |
| Plugin parse | `env -C /work bun build --external @opencode-ai/plugin --external zod --outfile=/work/plugin-check.js opencode/plugins/sandbox-tools.ts` -> **Bundled 10 modules** (`plugin-check.js` 1.0 MB). |
| Rollback boundary | Revert `broker/src/{validation,service,server}.ts`, the two edited broker test files, and the `docs/threat-model.md`/tasks/apply-progress edits. `registerProject` falls back to the `StateError` host-read path; no persisted schema. |

### Deviations from Design

- Task 3.3 was scoped to broker dispatch/validation/authorization; the plugin `host_register_project` tool keeps its pass-through and the fragment has no `host_register_project` entry. Broker authorization is now authoritative, so a non-orchestrator call is denied regardless of plugin state.
- Existence/directory checks use `statSync` in the broker so an ineligible path is rejected before the registration script can spawn, matching the spec's "no process MUST spawn" scenario.

### Issues Found

- `host_register_project` has no fragment `ask` entry and its plugin tool does not call `ctx.ask`, unlike every other host mutation. The broker now enforces orchestrator-only authorization, but the design's "fragment ask + metadata-rich `ctx.ask`" approval layer is not wired for this tool. Recommend a small follow-up (plugin tool + fragment) before acceptance.
- The spec bans registration beneath `/tmp`, so the eligible-path success test uses `process.cwd()` (an existing, non-banned directory) rather than a temp directory.

### Status

Task group 3.3-3.4 complete: focused tests (313/0), broker build, and plugin parse all green. Ready for independent verification.

## Correction Work Unit: ledger-untracked-declaration

### Completed Tasks

- [x] 3.5 `reviewStatus` read: fixed argv `gentle-ai review status --cwd <root> --contract gentle-ai.review-integration/v2 --agent <agent> --next-transition` with `agent` defaulting to `opencode`; read authorization; plugin tool `host_review_status`; fragment `allow`.
- [x] 3.6 `sddAttemptAcquire` untracked declaration: payload keys `untrackedScope`, `expectedUntrackedInventory`, `intendedUntracked`; bounded/canonicalized validation; appended argv; plugin pass-through args; ask metadata (scope, digest, untracked count).
- [x] 3.7 `SddRuntimeExecutor.run()` surfaces bounded (at most 4 KiB) trimmed stderr for empty and non-JSON stdout.
- [x] 3.8 Focused tests: review-status argv, untracked variants/rejections, stderr surfacing, and read/mutation authorization.
- [x] 3.9 Spec/design/tasks/apply-progress artifacts updated.

### Files Changed (correction)

| File | Action | What |
|------|--------|------|
| `broker/src/types.ts` | Modified | `reviewStatus` operation; `ReviewStatusPayload`; acquire untracked payload fields. |
| `broker/src/validation.ts` | Modified | Review-agent/untracked-scope/digest/intended-path validators; `reviewStatus` read authorization; payload key allowlists. |
| `broker/src/sdd-runtime.ts` | Modified | `buildReviewStatusArgv`; acquire untracked argv append; bounded-stderr run errors; `reviewStatus` executor method. |
| `broker/src/sdd-service.ts` | Modified | `buildReviewStatusOp`; acquire untracked pass-through. |
| `broker/src/server.ts` | Modified | `reviewStatus` dispatch case and import. |
| `opencode/plugins/sandbox-tools.ts` | Modified | `host_review_status` tool; acquire untracked args. |
| `opencode/plugins/lib/host-tool-approval.ts` | Modified | Acquire ask metadata for scope, digest, and untracked count. |
| `opencode/config-fragments/sandbox-permissions.jsonc` | Modified | `host_review_status: allow`. |
| `broker/tests/{sdd-runtime,validation,service-host-tools,host-tool-approval}.test.ts` | Modified | Correction coverage. |
| `openspec/changes/agent-host-tools/{specs/host-sdd-runtime-tools/spec.md,design.md,tasks.md,apply-progress.md}` | Modified | Correction artifacts. |

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `cd broker && bun test` -> **207 pass / 0 fail**, 784 expect() calls, 14 files (~230 ms). |
| Runtime harness command and exact result | `bun build --target=bun --outfile=/tmp/bc-main.js src/main.ts` -> **Bundled 17 modules** (138.17 KB). Plugin parse: `bun build --external @opencode-ai/plugin --external zod --outfile=/tmp/plugin-check.js opencode/plugins/sandbox-tools.ts` -> **Bundled 10 modules** (0.97 MB). |
| Rollback boundary | Revert `broker/src/{types,validation,sdd-runtime,sdd-service,server}.ts`, `opencode/plugins/sandbox-tools.ts`, `opencode/plugins/lib/host-tool-approval.ts`, `opencode/config-fragments/sandbox-permissions.jsonc`, the four broker test files, and the spec/design/tasks/apply-progress edits. No persisted schema. |

### Deviations from Design

- `reviewStatus` reuses the standard SDD result shape (`{status,json,stderr}`) unchanged; the broker never reshapes the envelope.
- `agent` is optional and defaults to `opencode`, validated as `^[a-z0-9_-]{1,64}$`.
- The untracked declaration is paired both ways: `untrackedScope` and `expectedUntrackedInventory` must appear together; `intendedUntracked` is allowed only with `select`.
- Intended paths reuse `assertProjectRelativePath` (relative, no traversal, no control chars, at most 4096 bytes) and are resolved beneath the canonical root; a leading `-` is accepted because it is a flag value, never re-parsed as a flag.

### Issues Found

- None in the corrected behavior. `review status` emits JSON; a non-JSON body now fails with the stderr cause attached.

### Status

Correction `ledger-untracked-declaration` complete: tasks 3.5-3.9. Focused tests and both builds green.

## Correction Work Unit: ledger-settle-untracked

### Completed Tasks

- [x] 3.10 Extend `sddAttemptSettle` with the shared untracked declaration (`untrackedScope`, `expectedUntrackedInventory`, `intendedUntracked`): allowlisted payload keys, shared canonicalized validation reused by acquire and settle, appended argv, plugin pass-through args, and ask metadata (scope, digest, untracked count).
- [x] 3.11 Focused settle untracked tests: argv with scope+digest and select+intended, no-flag argv unchanged, all rejections (select without intended, exclude with intended, digest without scope, non-sha digest, absolute/`..`/control-char/oversized path, over-count), interrupted still omits `--evidence-revision`, and shared-helper coverage exercised by both acquire and settle.
- [x] 3.12 Spec/design/tasks/apply-progress artifacts updated for Correction 2.

### Files Changed (correction 2)

| File | Action | What |
|------|--------|------|
| `broker/src/validation.ts` | Modified | `sddAttemptSettle` payload key allowlist gains `untrackedScope`, `expectedUntrackedInventory`, `intendedUntracked`. |
| `broker/src/types.ts` | Modified | `SddAttemptSettlePayload` gains the three untracked declaration fields. |
| `broker/src/sdd-runtime.ts` | Modified | Shared `UntrackedDeclarationInput` + `appendUntrackedDeclaration` reused by acquire and settle; `SddAttemptSettleArgvInput` and the `attemptSettle` executor inputs extended; settle appends the declaration. |
| `broker/src/sdd-service.ts` | Modified | `buildSddAttemptSettleOp` forwards the three fields exactly like acquire. |
| `opencode/plugins/lib/host-tool-approval.ts` | Modified | Shared `applyUntrackedAskDetails`; settle ask surfaces scope, digest, and untracked count. |
| `opencode/plugins/sandbox-tools.ts` | Modified | `host_sdd_attempt_settle` optional args and payload pass-through; description updated. |
| `broker/tests/sdd-settle-untracked.test.ts` | Created | Settle argv/executor/allowlist/ask/service-forwarding coverage. |
| `openspec/changes/agent-host-tools/{specs/host-sdd-runtime-tools/spec.md,design.md,tasks.md,apply-progress.md}` | Modified | Correction 2 artifacts. |

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `cd broker && bun test` -> **216 pass / 0 fail**, 820 expect() calls, 15 files (~219 ms). Settle-focused file `tests/sdd-settle-untracked.test.ts` -> **9 pass / 0 fail**, 36 expect() calls. |
| Runtime harness command and exact result | `bun build --target=bun --outfile=/tmp/bc-main.js src/main.ts` -> **Bundled 17 modules** (139.0 KB). Plugin parse: `bun build --external @opencode-ai/plugin --external zod --outfile=/tmp/plugin-check.js opencode/plugins/sandbox-tools.ts` -> **Bundled 10 modules** (0.97 MB). |
| Rollback boundary | Revert `broker/src/{validation,types,sdd-runtime,sdd-service}.ts`, `opencode/plugins/{sandbox-tools.ts,lib/host-tool-approval.ts}`, `broker/tests/sdd-settle-untracked.test.ts`, and the spec/design/tasks/apply-progress edits. Acquire behavior is unchanged; settle falls back to rejecting undeclared untracked flags. No persisted schema. |

### Deviations from Design

- The shared untracked validation is one `appendUntrackedDeclaration(argv, UntrackedDeclarationInput)` helper used by both acquire and settle; the input type was generalized from `SddAttemptAcquireArgvInput` so the rule set cannot drift.
- Settle appends the declaration flags after `--process-evidence` (mirroring acquire's trailing append); CLI flags are order-independent.
- Tests live in the new focused `broker/tests/sdd-settle-untracked.test.ts` rather than being inserted into the large existing files; it follows the same bun:test style and imports (`SddRuntimeExecutor`, `buildSddAttemptSettleArgv`, the approval builder, and the service handler with a minimal context).
- `host-tool-approval.ts` acquire now calls the shared `applyUntrackedAskDetails`, removing the duplicated acquire block (no behavior change).

### Issues Found

- The `sandbox_apply_patch` parser requires every hunk to end with a context line and each hunk header count to match exactly; hunks ending on a bare addition were rejected until a trailing context line was included.

### Status

Correction `ledger-settle-untracked` complete: tasks 3.10-3.12. Focused tests and both builds green.

## Work unit: host-sdd-attempt-ledger-tools

### Completed Tasks

- [x] 3.13 RED tests first for the six ledger operations: exact begin/status/rescope/finish/reset/grant argv, malformed `expectedRevision`, positive cap forwarding, exact payload-key allowlists, bounded/control-free `actor`/`reason`, and orchestrator-only handler authorization.
- [x] 3.14 `sddAttemptRescope` + `SddAttemptRescopePayload`, canonical validators (`assertExpectedRevision`, `assertLowercaseRequestId`, `assertObjectiveRelation`, `assertCanonicalRoots`), allowlist, and `HOST_MUTATION_OPERATIONS` wiring.
- [x] 3.15 `buildSddAttemptRescopeArgv` + executor; service handler; dispatch; exact argv with no cap clamping.
- [x] 3.16 `host_sdd_attempt_rescope` pass-through, broker-client timeout, and fragment `ask`; artifacts updated.
- [x] 3.17 RED tests for begin argv/revision/caps, status passthrough of non-JSON, payload keys, and authorization.
- [x] 3.18 `sddAttemptBegin` + `sddAttemptStatus` operations, payload types, allowlists, and read/mutation classification.
- [x] 3.19 `buildSddAttemptBeginArgv`/`buildSddAttemptStatusArgv` + executor methods (status via tolerant `runRaw`); begin/status handlers; dispatch.
- [x] 3.20 `host_sdd_attempt_begin` (ask) and `host_sdd_attempt_status` (read); broker-client timeouts; ask metadata; fragment `allow`/`ask`.
- [x] 3.21 RED tests for finish argv/optional order, CAS/evidence/outcome coupling, untracked declaration, redaction-before-cap, and authorization.
- [x] 3.22 Finish contracts/allowlists/validators, `buildSddAttemptFinishArgv`, redacted capped executor output (`run(..., true)`), handler, dispatch.
- [x] 3.23 `host_sdd_attempt_finish` ask metadata, broker-client timeout, fragment `ask`, routing/timeout/permission tests.
- [x] 3.24 RED tests for reset argv/relation order, CAS/text/relation validation, redaction, and authorization.
- [x] 3.25 Reset contracts/allowlists/validators, `buildSddAttemptResetArgv`, redacted capped executor, handler, dispatch.
- [x] 3.26 `host_sdd_attempt_reset` ask metadata, broker-client timeout, fragment `ask`, routing tests.
- [x] 3.27 RED tests for grant repeated-root argv order, initial vs CAS revision, root bounds, and authorization.
- [x] 3.28 Grant contracts/allowlists/canonical-root validator, `buildSddAttemptGrantArgv`, redacted capped executor, handler, dispatch.
- [x] 3.29 `host_sdd_attempt_grant` ask metadata, broker-client timeout, fragment `ask`, routing tests.

### Files Changed (ledger work unit)

| File | Action | What |
|------|--------|------|
| `broker/src/types.ts` | Modified | Six new `Operation`s + `OPERATIONS`; `SddAttempt{Begin,Rescope,Status,Finish,Reset,Grant}Payload`. |
| `broker/src/validation.ts` | Modified | `assertExpectedRevision`, `assertLowercaseRequestId`, `assertObjectiveRelation`, `assertCanonicalRoots`; read/mutation classification; payload-key allowlists. |
| `broker/src/sdd-runtime.ts` | Modified | Six argv builders + `appendObjectiveArgv`; six executor methods; `run(..., redactOutput)` redacts-then-caps finish/reset/grant output. |
| `broker/src/sdd-service.ts` | Modified | `buildSddAttempt{Status,Begin,Rescope,Finish,Reset,Grant}Op`, `objectiveFields`, `requireStringArray`. |
| `broker/src/server.ts` | Modified | Imports + six dispatch cases. |
| `opencode/plugins/lib/host-tool-approval.ts` | Modified | Union members + `buildSddAttempt{Begin,Rescope,Finish,Reset,Grant}Ask`. |
| `opencode/plugins/sandbox-tools.ts` | Modified | `host_sdd_attempt_{status,begin,rescope,finish,reset,grant}` tools; lowercase request-id arg. |
| `opencode/plugins/lib/broker-client.ts` | Modified | 130s timeouts for the six operations. |
| `opencode/config-fragments/sandbox-permissions.jsonc` | Modified | `host_sdd_attempt_status: allow`; five mutations `ask`. |
| `broker/tests/{sdd-runtime,validation,service-host-tools,host-tool-approval}.test.ts` | Modified | Ledger argv/executor, validators/allowlists, routing/authorization, and ask-metadata coverage. |
| `openspec/changes/agent-host-tools/{tasks.md,apply-progress.md}` | Modified | Ledger work-unit artifacts. |

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `env -C /work/broker bun test` -> **265 pass / 0 fail**, 1034 expect() calls, 15 files (~212 ms). RED baseline before implementation: 137 pass / 4 fail / 4 module-load errors (missing `buildSddAttemptStatusArgv`, `buildSddAttemptRescopeOp`, `buildSddAttemptResetAsk`, `assertObjectiveRelation`). |
| Runtime harness command and exact result | `env -C /work/broker bun build --target=bun --outfile=/work/broker/dist/main.js src/main.ts` -> **Bundled 17 modules** (`main.js` 167.73 KB). Plugin parse: `env -C /work bun build --external @opencode-ai/plugin --external zod --outfile=/tmp/plugin-check.js opencode/plugins/sandbox-tools.ts` -> **Bundled 10 modules** (`plugin-check.js` 0.99 MB). |
| Rollback boundary | Revert `broker/src/{types,validation,sdd-runtime,sdd-service,server}.ts`, `opencode/plugins/{sandbox-tools.ts,lib/host-tool-approval.ts,lib/broker-client.ts}`, `opencode/config-fragments/sandbox-permissions.jsonc`, the four edited broker test files, and the tasks/apply-progress edits. The six operations fall back to "unknown operation"; acquire/settle/status behavior is unchanged; no persisted schema. |

### Deviations from Design

- All six operations go through the SDD runtime executor (not the git `runHostStep` path) because they invoke `gentle-ai`; `finish`/`reset`/`grant` use `run(argv, root, true)` which applies `capAndRedact` (redact then 512 KiB cap) before returning. Redaction runs on stdout/stderr; a redaction that mangles a secret-shaped JSON assignment would surface as a non-JSON error rather than silently returning unredacted output.
- `sddAttemptFinish` always emits `--evidence-revision` per the fixed template: the canonical 64-hex revision for `passed`/`failed`, and the explicit empty value for `interrupted`. A non-empty non-canonical revision for `interrupted` is rejected.
- `assertCanonicalRoots` enforces lexical canonicality via `resolve(root) === root` (rejects `..`, trailing `/`, doubled separators) plus `isAbsolute`; it does not `realpath` (grant roots need not exist yet).
- `sddAttemptGrant`'s optional `expectedRevision` is omitted from argv when absent (initial grant) and emitted otherwise; roots are preserved in caller order as repeated `--root`.
- The broker forwards positive caps for begin/rescope unchanged and never encodes or clamps the CLI's objective ceiling.
- `sdd-service` reuses `requireString`/`requireNumber`/`requireStringArray`; `assertPayloadKeys` only rejects undeclared keys, so required-key enforcement happens in the handlers/builders.

### Issues Found

- `assertPayloadKeys` validates the extra-key allowlist only; it does not require keys (the handlers/builders do). One RED assertion initially assumed key-required behavior and was corrected.
- `sandbox_apply_patch` is strict about hunk counts; several large multi-hunk patches were split and applied individually.
- No new untracked test files were created; coverage was added to the four existing test files so the ledger's untracked inventory stays stable.

### Workload / PR Boundary

- Mode: `single-pr` with maintainer-approved `size:exception`; this work unit exceeds the 800-line measured-diff ledger cap.
- Boundary: from the six landed ledger reads/mutations (acquire, settle, review status) to the full six-operation ledger surface (status, begin, rescope, finish, reset, grant) with orchestrator-only authorization and approval. `sdd-attempt handoff`/`repair` remain deferred; tasks 3.3/3.4 and Phase 4/5 are out of scope.
- Authored B→C lines: **1984** (git numstat: 1978 insertions / 6 deletions across 13 files). Tests are 709 of those lines and are required RED coverage; the remainder is the six-operation runtime/validation/service/plugin pipeline. Cannot shrink further without dropping required coverage or operation surface — landing as one cohesive work unit under `size:exception`.

### Status

Work unit `host-sdd-attempt-ledger-tools` complete: tasks 3.13-3.29. Focused tests (265/0), broker build, and plugin parse all green. Ready for independent verification.

## Work unit: host-plan-doc (`planDocAppend`)

### Completed Tasks

- [x] 3.30 RED tests first: exact `{projectDir,doc,content,heading?}` keys, enum-only `todo`/`plan` mapping, traversal/absolute/unknown/protected rejection, oversize/control-character rejection, approval metadata, and orchestrator-only authorization (extended `validation.test.ts`, `service-host-tools.test.ts`, `host-tool-approval.test.ts`).
- [x] 3.31 `planDocAppend` operation, `PlanDocAppendPayload`, payload-key allowlist, `PLAN_DOC_TARGETS` enum, canonical-root/destination validators, and `HOST_MUTATION_OPERATIONS` classification in `types.ts` / `validation.ts`; handler + `server.ts` dispatch.
- [x] 3.32 Atomic append/create/heading insertion implemented inside `broker/src/service.ts` (no new module): per-destination lock, sibling `O_CREAT|O_EXCL` temp + fsync + rename + directory fsync, revalidation, failure cleanup.
- [x] 3.33 `host_plan_append` tool + metadata-rich `ctx.ask`, `planDocAppend` client timeout, and fragment `ask` wired in `sandbox-tools.ts`, `host-tool-approval.ts`, `broker-client.ts`, and `sandbox-permissions.jsonc`.
- [x] 3.34 RED coverage for create-if-missing, append preservation, heading boundaries, missing/ambiguous heading, concurrent serialization, symlink/path drift, protected destinations, temp cleanup, no-other-file mutation, and doc-enum rejection; spec `heading` alignment; `docs/threat-model.md` plan-document boundary.

### Files Changed (host-plan-doc)

| File | Action | What |
|------|--------|------|
| `broker/src/types.ts` | Modified | `planDocAppend` operation + `OPERATIONS`; `PlanDocAppendPayload`. |
| `broker/src/validation.ts` | Modified | `PLAN_DOC_TARGETS`, content/heading bounds, `assertPlanDocName`/`normalizePlanDocContent`/`assertPlanDocHeading`; mutation classification; payload-key allowlist. |
| `broker/src/service.ts` | Modified | Plan-doc lock, heading scan, `computePlanDocAppend`, atomic append, and `buildPlanDocAppendOp`. |
| `broker/src/server.ts` | Modified | Import + `planDocAppend` dispatch case. |
| `opencode/plugins/sandbox-tools.ts` | Modified | `host_plan_append` tool with `ctx.ask`. |
| `opencode/plugins/lib/host-tool-approval.ts` | Modified | `planDocAppend` union member + `buildPlanDocAppendAsk`. |
| `opencode/plugins/lib/broker-client.ts` | Modified | `planDocAppend` timeout. |
| `opencode/config-fragments/sandbox-permissions.jsonc` | Modified | `host_plan_append: ask`. |
| `broker/tests/{validation,service-host-tools,host-tool-approval}.test.ts` | Modified | Plan-doc validator, handler, atomic-write, and ask-metadata coverage. |
| `openspec/changes/agent-host-tools/{specs/host-plan-doc/spec.md,tasks.md,apply-progress.md}` | Modified | Optional `heading` declared; tasks 3.30-3.34 checked; this section. |
| `docs/threat-model.md` | Modified | Direct project-document mutation boundary + residual risk. |

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `env -C /work/broker bun test` -> **282 pass / 0 fail**, 1114 expect() calls, 15 files. RED baseline before implementation: **174 pass / 3 fail / 3 module-load errors**. |
| Runtime harness command and exact result | `env -C /work/broker bun build --target=bun --outfile=/work/broker/dist/main.js src/main.ts` -> **Bundled 17 modules** (`main.js` 174.93 KB). Plugin parse: `env -C /work bun build --external @opencode-ai/plugin --external zod --outfile=/work/plugin-check.js opencode/plugins/sandbox-tools.ts` -> **Bundled 10 modules** (`plugin-check.js` 0.99 MB). |
| Rollback boundary | Revert `broker/src/{types,validation,service,server}.ts`, `opencode/plugins/{sandbox-tools.ts,lib/{broker-client,host-tool-approval}.ts}`, `opencode/config-fragments/sandbox-permissions.jsonc`, the three edited broker test files, and the spec/tasks/apply-progress/threat-model edits. `planDocAppend` falls back to "unknown operation"; no persisted schema. |

### Deviations from Design

- Design/tasks named a new `broker/src/plan-doc.ts` and `broker/tests/plan-doc.test.ts`; the orchestrator required **no new files** to keep the ledger's untracked inventory stable. The dependency-free append helper lives in `broker/src/service.ts`, and coverage was added to the three existing test files. Pure text logic (`computePlanDocAppend`) is exported for direct unit testing.
- The optional `heading` is the heading TEXT without `#` markers (1..256 bytes, control-free); matching compares the stripped ATX heading text and inserts at the start of the next heading of equal or higher level (or EOF). A missing or ambiguous heading fails closed with `ValidationError`.
- Existing bytes are read as UTF-8 and rewritten UTF-8; valid UTF-8 round-trips byte-identically (a non-UTF-8 document is out of contract).
- `appendPlanDocAtomically` creates the `docs/` parent directory when the mapped document is absent; the mapped constant is the only path ever created.

### Issues Found

- `sandbox_apply_patch` rejects hunks that end with additions and no trailing context line, and rejects `-` removal lines in the same way; every hunk needs a trailing context line. One EOF append also dropped its final added line, so EOF appends use a guard blank.
- Approval is enforced at the plugin layer (fragment `ask` + `ctx.ask`); the broker has no approval signal, so "no mutation before approval" is proven by the ask builder (`always: []`, permission `host_plan_append`) plus the broker mutation-path authorization tests.

### Status

Work unit `host-plan-doc` complete: tasks 3.30-3.34. Focused tests (282/0), broker build, and plugin parse all green. Ready for independent verification.


## Work unit: host-review-lifecycle (nine operations)

### Completed Tasks

- [x] 3.35 RED tests first: exact argv/key allowlists and enum/shape/size/boolean/coupling rejection for all nine ops, in the existing `broker/tests/{sdd-runtime,validation,service-host-tools,host-tool-approval}.test.ts`.
- [x] 3.36 Payload types, validators, operation registration, and orchestrator-only authorization in `broker/src/{types,validation,sdd-service}.ts`; provider tokens preserved verbatim.
- [x] 3.37 Fixed-argv builders and executor methods for all nine ops in `broker/src/sdd-runtime.ts` (no new module), with canonical cwd, direct spawn, timeout handling, and redact-before-512-KiB caps.
- [x] 3.38 Review handlers and dispatch in `broker/src/{sdd-service,server}.ts`; private staged `reviewCaptureResult.input` snapshots with per-call cleanup plus startup stale cleanup; literal `-` forwarded only for explicit EOF.
- [x] 3.39 Nine plugin tools, broker-client timeouts, metadata-rich `ctx.ask`, and nine fragment `ask` entries in `opencode/plugins/{sandbox-tools.ts,lib/{broker-client,host-tool-approval}.ts}` and `opencode/config-fragments/sandbox-permissions.jsonc`.
- [x] 3.40 Staged-file mode/size/permissions/snapshot/lifetime/cleanup, literal `-`, timeout/redaction, and canonical-root enforcement coverage.
- [x] 3.41 Artifacts: `host-review-tools` spec confirmed as the frozen contract; `design.md` addendum; `tasks.md`; `docs/threat-model.md` review-lifecycle boundary; this section. Open questions carried forward.

### Files Changed (host-review-lifecycle)

| File | Action | What |
|------|--------|------|
| `broker/src/types.ts` | Modified | Nine `Operation`s + `OPERATIONS`; review payload types + enum aliases. |
| `broker/src/validation.ts` | Modified | Enum/token/baseRef/order/correctionLines/sha256/boolean/maintainer-auth/unique-intended validators; mutation classification; payload-key allowlists. |
| `broker/src/sdd-runtime.ts` | Modified | Table-driven frozen review command specs, nine named builders, nine executor methods, capture-result staging + startup stale cleanup. |
| `broker/src/sdd-service.ts` | Modified | Nine orchestrator-only review handlers with exact-key passthrough. |
| `broker/src/server.ts` | Modified | Nine dispatch cases; `reviewInputDir` wired to `${stateDir}/review-input`. |
| `opencode/plugins/sandbox-tools.ts` | Modified | Nine `host_review_*` tools; input size/digest preview; review arg schemas. |
| `opencode/plugins/lib/host-tool-approval.ts` | Modified | Nine metadata-rich `buildReview*Ask` builders; union extended; tokens shown only as a short digest; maintainer JSON redacted. |
| `opencode/plugins/lib/broker-client.ts` | Modified | 130s timeouts for the nine review operations. |
| `opencode/config-fragments/sandbox-permissions.jsonc` | Modified | `ask` for all nine review tools. |
| `broker/tests/{sdd-runtime,validation,service-host-tools,host-tool-approval}.test.ts` | Modified | Review argv/staging/validator/authorization/ask coverage. |
| `openspec/changes/agent-host-tools/{tasks.md,apply-progress.md}` | Modified | Work-unit artifacts. |
| `docs/threat-model.md` | Modified | Review-lifecycle token/staging boundary. |

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `env -C /work/broker bun test` -> **305 pass / 0 fail**, 1345 expect() calls, 15 files. RED baseline before implementation: 137 pass / 4 fail / 4 module-load errors. |
| Runtime harness command and exact result | `env -C /work/broker bun build --target=bun --outfile=/work/broker/dist/main.js src/main.ts` -> **Bundled 17 modules** (`main.js` 200.96 KB). Plugin parse: `env -C /work bun build --external @opencode-ai/plugin --external zod --outfile=/tmp/plugin-check.js opencode/plugins/sandbox-tools.ts` -> **Bundled 10 modules** (`plugin-check.js` 1.0 MB). |
| Rollback boundary | Revert `broker/src/{types,validation,sdd-runtime,sdd-service,server}.ts`, `opencode/plugins/{sandbox-tools.ts,lib/{broker-client,host-tool-approval}.ts}`, `opencode/config-fragments/sandbox-permissions.jsonc`, the four edited broker test files, and the tasks/apply-progress/threat-model edits. The nine ops fall back to "unknown operation"; no persisted schema. |

### Deviations from Design

- Design/tasks named a new `broker/src/review-runtime.ts` and `broker/tests/review-runtime.test.ts`; the orchestrator required **no new files** to keep the ledger untracked inventory stable. The nine builders live in `broker/src/sdd-runtime.ts` as one table-driven `REVIEW_COMMANDS` spec plus nine thin named wrappers, and coverage extends the four existing test files.
- `reviewAcknowledgeApproved` is flag-less and isolated in one builder/wrapper so a verified flag is a one-line change; the executor still runs it with cwd = canonical root.
- Provider-issued tokens (target, lineage, expected revision, repository context, subject/request hash, lens, contract, policy, trace, attestation, release values) are validated only and pushed byte-for-byte into their fixed argv positions; `focus` on `reviewRecover` stays a 1..128-byte opaque token, never narrowed to the four start lenses.
- `reviewCaptureResult.input` is a project-relative path or `-`; the broker snapshots a regular file (<=512 KiB) into `${stateDir}/review-input/<random>.input` at mode `0600` with `O_CREAT|O_EXCL`, passes that private absolute path as `--input`, and deletes it in `finally`. `-` is passed literally with no staging. Stale files are removed when the executor is constructed; `cleanupStaleReviewInputs` is exported for tests.
- The ask builders never echo opaque tokens: they surface enums/modes plus one short non-cryptographic `tokenDigest`, and `reviewRecover.maintainerAuthorization` appears only as "present (redacted)".

### Issues Found

- `node:fs` ESM does not expose `O_CREAT`/`O_EXCL`/`O_WRONLY` as named exports under bun; staging uses `constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY`.
- `sandbox_apply_patch` appends context-free hunks at EOF; count mismatches surface as "corrupt patch", so large blocks were sized against the parser.

### Workload / PR Boundary

- Mode: `single-pr` with maintainer-approved `size:exception`.
- Boundary: from the landed ledger/plan-doc tools to the nine-operation review lifecycle with staged capture input and orchestrator-only approval.
- Authored B->C lines: recorded after `sandbox_finish` (numstat); the work unit exceeds the 800-line review budget and cannot shrink without dropping required coverage or operations.

### Status

Work unit `host-review-lifecycle` complete: tasks 3.35-3.41. Focused tests (305/0), broker build, and plugin parse all green. Ready for independent verification.

## Remediation: host-tool-gaps

### What Changed

Spec↔CLI reconciliation for four host-tool contracts: the frozen delta specs and the installed `gentle-ai` CLI disagreed, so both the specs and the implementation were amended to agree, with RED-first tests. No new files were created, keeping the ledger untracked inventory stable.

- **G1 `sdd-attempt begin` untracked declaration**: spec argv/allowlist + "Begin untracked declaration" scenario; `buildSddAttemptBeginArgv` exact keys + shared `appendUntrackedDeclaration`; `sddAttemptBegin` payload allowlist; `SddAttemptBeginPayload`; `attemptBegin` executor; `buildSddAttemptBeginOp`; `host_sdd_attempt_begin` pass-through; `buildSddAttemptBeginAsk` surfaces scope/digest/count.
- **G2 `sdd-attempt settle --remediates-evidence-revision`**: spec settle template; `buildSddAttemptSettleArgv` exact key + bare 64-hex flag; `sddAttemptSettle` allowlist; `SddAttemptSettlePayload`; `attemptSettle` executor; `buildSddAttemptSettleOp`; `host_sdd_attempt_settle` pass-through; `buildSddAttemptSettleAsk` surfaces the revision.
- **G3 `review status` passthrough flags**: spec review-status template; `buildReviewStatusArgv` exact keys + `--lineage`/`--repository-context`/`--projection` after `--agent` and before `--next-transition`; `reviewStatus` allowlist; `ReviewStatusPayload`; executor; `buildReviewStatusOp`; `host_review_status` pass-through (read, no `ctx.ask`).
- **G4 `review capture-result --order` accepts 0**: spec `0..32`; `assertReviewOrder`; `reviewOrderArg`; `buildReviewCaptureResultAsk`; comments/tests updated.

### Exact Commands and Results

| Command | Result |
|---------|--------|
| `env -C broker bun test` | **329 pass / 0 fail**, 1436 expect() calls, 15 files (~216 ms). RED baseline before implementation: **314 pass / 15 fail**; baseline before this work unit: 315 pass / 0 fail. |
| `env -C . bun build --external @opencode-ai/plugin --external zod --outfile=/tmp/plugin-check.js opencode/plugins/sandbox-tools.ts` | **Bundled 10 modules in 30ms** (`plugin-check.js` 1.0 MB). |

### Files Changed (remediation)

| File | Action | What |
|------|--------|------|
| `openspec/changes/agent-host-tools/specs/host-sdd-runtime-tools/spec.md` | Modified | Begin untracked template/allowlist + scenario; settle remediates template; review-status passthrough template. |
| `openspec/changes/agent-host-tools/specs/host-review-tools/spec.md` | Modified | `order` `0..32`. |
| `openspec/changes/agent-host-tools/design.md` | Modified | reviewStatus passthrough contract; settle remediates / begin untracked notes. |
| `broker/src/types.ts` | Modified | Begin untracked fields; settle `remediatesEvidenceRevision`; review-status passthrough fields. |
| `broker/src/validation.ts` | Modified | Begin/settle/reviewStatus payload-key allowlists; `assertReviewOrder` `0..32`. |
| `broker/src/sdd-runtime.ts` | Modified | Begin untracked append; settle remediates flag; review-status passthrough flags; inputs + three executors. |
| `broker/src/sdd-service.ts` | Modified | Forward begin untracked, settle remediates, and review-status passthrough. |
| `opencode/plugins/sandbox-tools.ts` | Modified | Begin/settle args+pass-through; `host_review_status` args+pass-through; `reviewOrderArg` `0..32`. |
| `opencode/plugins/lib/host-tool-approval.ts` | Modified | Begin ask untracked details; settle ask remediates; capture-result ask order 0. |
| `broker/tests/{host-tool-approval,sdd-runtime,sdd-settle-untracked,service-host-tools,validation}.test.ts` | Modified | RED-first begin-untracked, settle-remediates, review-status passthrough, and order-0 coverage. |
| `openspec/changes/agent-host-tools/{tasks.md,apply-progress.md}` | Modified | This remediation's tasks and section. |

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `env -C broker bun test` -> **329 pass / 0 fail**, 1436 expect() calls, 15 files (~216 ms). |
| Runtime harness command and exact result | Plugin parse: `env -C . bun build --external @opencode-ai/plugin --external zod --outfile=/tmp/plugin-check.js opencode/plugins/sandbox-tools.ts` -> **Bundled 10 modules in 30ms** (1.0 MB). No live `gentle-ai` invocation (the orchestrator holds the attempt). |
| Rollback boundary | Revert the four spec/design edits, `broker/src/{types,validation,sdd-runtime,sdd-service}.ts`, `opencode/plugins/{sandbox-tools.ts,lib/host-tool-approval.ts}`, the five edited broker test files, and the tasks/apply-progress edits. Behavior falls back to rejecting the undeclared begin/settle/review-status keys and `order` `1..32`; no persisted schema. |

## Remediation: register-project-approval

### What Changed

- `opencode/plugins/lib/host-tool-approval.ts`: added `"registerProject"` to
  `HostMutationOperation`, plus `RegisterProjectAskArgs` and
  `buildRegisterProjectAsk` (permission `host_register_project`, operation
  `registerProject`, `always: []`, `patterns: ["*"]`, details carry `path` and
  `dryRun`/`createRemote`/`makePublic` as `yes`/`no`, and a one-line summary
  naming the path and flags). An empty `path` throws `HostToolAskError`.
- `opencode/plugins/sandbox-tools.ts`: imported `buildRegisterProjectAsk`; the
  `host_register_project` tool now calls
  `await ctx.ask(buildRegisterProjectAsk({ path, dryRun, createRemote, makePublic }))`
  before `const c = await client();`. The existing `c.request("registerProject", ...)`
  call is unchanged.
- `opencode/config-fragments/sandbox-permissions.jsonc`: added
  `"host_register_project": "ask"` next to the other `host_*` mutation entries.
- `broker/tests/host-tool-approval.test.ts`: added coverage for
  `buildRegisterProjectAsk` (permission, `metadata.operation`, empty `always`,
  `patterns: ["*"]`, details path + three `yes`/`no` flags, summary names the
  path, and an empty `path` throws).

### Why

Independent verification flagged a CRITICAL spec violation: the spec
(`specs/host-tool-authorization/spec.md` line 16) lists `registerProject` among
mutations that MUST be orchestrator-only, fragment-`ask`, and protected by a
metadata-rich in-tool `ctx.ask`. Broker-side orchestrator-only authorization was
already correct and was NOT changed; only the missing plugin/fragment approval
layer was added.

### Exact Commands and Results

| Command | Result |
|---|---|
| `env -C broker bun test` | **315 pass / 0 fail**, 1394 expect() calls, 15 files (~288 ms). Baseline was 313/0; the two new `buildRegisterProjectAsk` tests are the +2. |
| `env -C /work bun build --external @opencode-ai/plugin --external zod --outfile=/tmp/plugin-check.js opencode/plugins/sandbox-tools.ts` | **Bundled 10 modules in 27ms** (`plugin-check.js` 1.0 MB). |

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `env -C broker bun test` -> **315 pass / 0 fail**, 1394 expect() calls, 15 files. |
| Runtime harness command and exact result | Plugin parse: `env -C /work bun build --external @opencode-ai/plugin --external zod --outfile=/tmp/plugin-check.js opencode/plugins/sandbox-tools.ts` -> **Bundled 10 modules in 27ms** (1.0 MB). No broker runtime path was changed. |
| Rollback boundary | Revert `opencode/plugins/lib/host-tool-approval.ts`, `opencode/plugins/sandbox-tools.ts`, `opencode/config-fragments/sandbox-permissions.jsonc`, `broker/tests/host-tool-approval.test.ts`, and this apply-progress section. `host_register_project` returns to pass-through with no fragment entry; broker authorization is unchanged. |

### Files Changed (remediation)

| File | Action | What |
|------|--------|------|
| `opencode/plugins/lib/host-tool-approval.ts` | Modified | `registerProject` union member + `RegisterProjectAskArgs` + `buildRegisterProjectAsk`. |
| `opencode/plugins/sandbox-tools.ts` | Modified | Import + `ctx.ask` before the `registerProject` request. |
| `opencode/config-fragments/sandbox-permissions.jsonc` | Modified | `host_register_project: ask`. |
| `broker/tests/host-tool-approval.test.ts` | Modified | Two `buildRegisterProjectAsk` tests. |
| `openspec/changes/agent-host-tools/apply-progress.md` | Modified | This section. |

### Deviations from Design

- The in-tool ask mirrors `host_plan_append`/`buildPlanDocAppendAsk`: the three
  booleans are surfaced as `yes`/`no` because `details` only accepts
  `string | number`, and they are always present (defaulting to `no`) so the
  approval surface never varies in shape.

### Status

Remediation `register-project-approval` complete: focused tests (315/0) and the
plugin parse are green. Broker authorization is untouched. Ready for independent
verification.

## Work unit: review-status-intended-untracked-selection (correction)

### Completed Tasks

- [x] C1 RED tests first in `broker/tests/{validation,sdd-runtime,service-host-tools}.test.ts`: `reviewStatus` allowlist acceptance/rejection of `intendedUntrackedSelection`, the fail-closed validator, exact argv position (after `--projection`, before `--next-transition`), verbatim byte passthrough of unusual JSON spacing, and rejection of empty / non-JSON / flag-like / control-bearing / oversized values before spawn.
- [x] C2 `intendedUntrackedSelection` added to `ReviewStatusPayload`, to the `reviewStatus` payload-key allowlist, and as `assertIntendedUntrackedSelection` (65536-byte cap) in `broker/src/validation.ts`.
- [x] C3 `buildReviewStatusArgv` emits exactly one `--intended-untracked-selection <json>` element after `--projection` and before `--next-transition`, forwarded verbatim; `ReviewStatusArgvInput`, the `reviewStatus` executor, and `buildReviewStatusOp` forward it.
- [x] C4 `host_review_status` gains the optional `intendedUntrackedSelection` string arg and pass-through; it stays a read (fragment `allow`, no `ctx.ask`).
- [x] C5 Spec template + scenario, design transport, tasks block, and this section updated.

### Files Changed (review-status selection)

| File | Action | What |
|------|--------|------|
| `broker/src/types.ts` | Modified | `ReviewStatusPayload.intendedUntrackedSelection?`. |
| `broker/src/validation.ts` | Modified | `reviewStatus` allowlist entry; `assertIntendedUntrackedSelection` + `REVIEW_INTENDED_UNTRACKED_SELECTION_MAX_BYTES`. |
| `broker/src/sdd-runtime.ts` | Modified | `ReviewStatusArgvInput` field; import; builder emission; executor forward. |
| `broker/src/sdd-service.ts` | Modified | `buildReviewStatusOp` forwards `intendedUntrackedSelection`. |
| `opencode/plugins/sandbox-tools.ts` | Modified | `host_review_status` arg + payload pass-through. |
| `broker/tests/{validation,sdd-runtime,service-host-tools}.test.ts` | Modified | RED-first allowlist/validator/argv/verbatim/rejection coverage. |
| `openspec/changes/agent-host-tools/specs/host-sdd-runtime-tools/spec.md` | Modified | Optional selection in the template + scenario. |
| `openspec/changes/agent-host-tools/design.md` | Modified | Review-status selection transport. |
| `openspec/changes/agent-host-tools/{tasks.md,apply-progress.md}` | Modified | Correction task block + this section. |

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `env -C /work/broker bun test` -> **332 pass / 0 fail**, 1459 expect() calls, 15 files (~224 ms). RED baseline before implementation: **267 pass / 3 fail / 1 module-load error**, 1038 expect() calls. |
| Runtime harness command and exact result | `bun build --target=bun --outfile=/tmp/broker-main.js broker/src/main.ts` -> **Bundled 17 modules in 7ms** (208.00 KB). Plugin parse: `bun build --external @opencode-ai/plugin --external zod --outfile=/tmp/plugin-check.js opencode/plugins/sandbox-tools.ts` -> **Bundled 10 modules in 30ms** (1.0 MB). |
| Rollback boundary | Revert `broker/src/{types,validation,sdd-runtime,sdd-service}.ts`, `opencode/plugins/sandbox-tools.ts`, the three edited broker test files, and the spec/design/tasks/apply-progress edits. `reviewStatus` falls back to rejecting the undeclared key; every other operation is unchanged; no persisted schema. |

### Deviations from Design

- The validator treats the value as opaque schema-bound JSON: it verifies non-emptiness, a leading-`-` ban, a 65536-byte UTF-8 cap (matching `reviewRecover.maintainerAuthorization`), absence of NUL/control characters, and `JSON.parse` well-formedness — but never the JSON shape or schema field, because the broker MUST forward the provider value byte-for-byte rather than reconstruct it.
- Raw newlines are rejected by the existing control-character rule, so pretty-printed values are out of contract; the provider value is a single compact argv element.
- The plugin arg schema is `z.string().min(1).max(65536).optional()`; it deliberately does not refine JSON because the broker is authoritative and the plugin only passes through.

### Issues Found

- The `review start` untracked declaration cannot substitute for this collect step: `review start` requires a `--target` matching a freshly built snapshot, and that target is only issued after the collect is satisfied (`stale_target_identity`, `mutation_outcome: not_started`). The selection must therefore ride `review status`, as implemented.
- The exact `gentle-ai.review-intended-untracked-selection/v1` schema (required fields, maximum path count) is unverified against the installed binary here; the broker validates well-formedness/bounds only, so an unexpected-but-valid JSON shape is forwarded unchanged rather than guessed.

### Status

Correction `review-status-intended-untracked-selection` complete: C1-C5. Focused
tests (332/0) and both builds green. Ready for independent verification.

### Correction C6 — ce:review security fixes

Three `ce:review`-verified defects in the new host-tool code, fixed RED-first. No spec, design, proposal, or task changes; scenario counts stay 16/61.

1. **Canonical registration path** (`broker/src/validation.ts`): `assertRegisterableProjectPath` resolves the target with `realpathSync` inside the existing try/catch and re-runs the filesystem-root / `$HOME` / banned-root checks plus the directory check against the resolved canonical path (the lexical checks stay as defence in depth); the canonical result must be absolute with `resolve(canonical) === canonical`. A symlink alias whose real target is banned (`$HOME/.ssh`, `/etc`) is now rejected before spawn.
2. **Shell-active byte rejection + canonical forwarding**: the canonical path is rejected when it contains `$`, backtick, `\`, `"`, or `!`, because it is written as `  "${path}"` into `scripts/secure-launcher.conf`, a double-quoted assignment sourced by both launchers; `buildRegisterProjectOp` (`broker/src/service.ts`) now forwards the canonical path returned by the validator into the registration argv.
3. **Verbatim stdout** (`broker/src/sdd-runtime.ts`): `SddRuntimeExecutor.run` parses and returns the raw stdout (provider tokens byte-for-byte) and applies `capAndRedact` only to stderr/diagnostics; the spawn's `outputMaxBytes` keeps stdout bounded at 512 KiB.

### Tests (RED first)

| Test | RED (before fix) | GREEN (after fix) |
|---|---|---|
| canonical path returned; existing directory still accepted (extended) | fail (returned `undefined`) | pass |
| symlink alias -> `$HOME/.ssh` and -> `/etc` rejected | fail (accepted) | pass |
| `$(...)`, backtick, `"`, `$`, `\`, `!` directory names rejected | fail (accepted) | pass |
| finish/review stdout verbatim, stderr redacted (updated) | fail (`token=REDACTED`) | pass |
| review stdout JSON byte-for-byte (`authorization=abc123`) | fail (rewritten) | pass |
| review stderr still redacted and capped at 512 KiB | pass (guard) | pass |

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `env -C broker bun test` -> **336 pass / 0 fail**, 1473 expect() calls, 15 files (~228 ms). RED baseline: **330 pass / 6 fail** of 336. |
| Runtime harness command and exact result | `env -C broker bun build --target=bun --outfile=/tmp/broker-main.js src/main.ts` -> **Bundled 17 modules in 6ms** (208.45 KB). Plugin parse: `env -C . bun build --external @opencode-ai/plugin --external zod --outfile=/tmp/plugin-check.js opencode/plugins/sandbox-tools.ts` -> **Bundled 10 modules in 27ms** (1.0 MB). |
| Rollback boundary | Revert `broker/src/{validation,sdd-runtime,service}.ts` and the two edited broker test files: registration returns to the lexical-only check and the executor to redact-before-parse. No persisted schema. |

### Deviations from Design

- `assertRegisterableProjectPath` now returns the canonical path instead of being a pure assertion; the register handler consumes that value.
- Raw stdout applies to every `run(..., true)` caller (finish/reset/grant plus the review ops), not only review, because the shared executor cannot redact stdout for one caller without stranding tokens for the others.

### Issues Found

- `host-review-tools` line 27 ("Returned stdout ... MUST pass through `redact()`") conflicts with the verbatim-token requirement for stdout JSON; the correction treats the redaction clause as stderr/diagnostics-scoped and leaves the spec unchanged. The residual wording conflict is carried forward for the spec owners.

### Status

Correction C6 complete. Focused tests (336/0) and both builds green. Ready for independent verification.

### Correction D1 — per-project review lens transport

**Defect (verified):** the per-lens reviewer step builds its Task approval from the OpenCode transport plugin, which spawns `gentle-ai review opencode-transport` with cwd = the shared OpenCode server's cwd (a different project). `ResolveReviewRepositoryContextBindingFromHost(ctx, ".")` therefore resolved the wrong repository and every lens Task failed `opencode_review_transport_binding_invalid`. Running the same start frame by hand from inside this repository materializes the full reviewer block, proving the process cwd — not the provider frame — is the fault.

**Fix:** the broker now owns the repository per project and exposes a fixed-argv READ that materializes the block directly.

- `reviewLensContext {projectDir,repositoryContext,lineage,target,expectedRevision,lens}` -> `gentle-ai review lens-context --cwd <canonical-root> --repository-context <h> --lineage <l> --target <t> --expected-revision <r> --lens <review-risk|review-resilience|review-readability|review-reliability>`. It returns the raw multi-line reviewer block (binding line plus `GENTLE_AI_REVIEW_CONTEXT` ... `END`) through `runRaw`; the block is plain text, never JSON-parsed. Added to `HOST_READ_OPERATIONS`, the payload-key allowlist, the `Operation` union/`OPERATIONS`, broker dispatch, and the plugin as `host_review_lens_context` (fragment `allow`, no `ctx.ask`).
- `reviewCaptureResult` gains optional `inputJson`: exactly one of `input`/`inputJson` may be present (both absent allowed). A present `inputJson` is a non-empty NUL-free JSON string of at most `REVIEW_INPUT_MAX_BYTES`; the broker stages its exact bytes into the same private `0600` `${stateDir}/review-input/<random>.input` snapshot as file inputs and unlinks it in `finally`. Approval metadata carries only the inline byte count and a short digest, never the body.

### Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command and exact result | `env -C broker bun test` -> **348 pass / 0 fail**, 1535 expect() calls, 15 files (~222 ms). Baseline before this correction: **336 pass / 0 fail**, 1473 expect() calls. |
| Runtime harness command and exact result | `env -C broker bun build --target=bun --outfile=/tmp/broker-main.js src/main.ts` -> **Bundled 17 modules in 7ms** (212.0 KB). Plugin parse: `env -C . bun build --external @opencode-ai/plugin --external zod --outfile=/tmp/plugin-check.js opencode/plugins/sandbox-tools.ts` -> **Bundled 10 modules in 25ms** (1.0 MB). |
| Rollback boundary | Revert `broker/src/{types,validation,sdd-runtime,sdd-service,server}.ts`, `opencode/plugins/{sandbox-tools.ts,lib/host-tool-approval.ts}`, `opencode/config-fragments/sandbox-permissions.jsonc`, the four edited broker test files, and the tasks/design/spec/apply-progress edits. The lens-context read and inline `inputJson` fall back to "unknown operation"/undeclared field; no persisted schema. |

### Deviations from Design

- `reviewLensContext` is a READ, not a mutation: it is added to `HOST_READ_OPERATIONS`, `host_review_lens_context` is fragment `allow`, and it never calls `ctx.ask`. The inline capture body reuses the existing staging machinery via a shared `writeStagedReviewInput` helper.

### Status

Correction D1 complete: the exact `reviewLensContext` argv and the inline `inputJson` capture body are implemented and covered. Focused tests (348/0) and both builds green. Ready for independent verification.

### Spec amendment — verbatim protocol stdout

Amended `specs/host-review-tools/spec.md` (Token and process boundary paragraph) to reconcile the spec with the landed executor behavior: returned **stderr** MUST pass through `redact()` before the 512 KiB cap, while returned **protocol stdout** MUST be preserved verbatim — its provider-issued tokens are forwarded into subsequent review operations and MUST NOT be normalized, reconstructed, or rewritten by redaction — bounded by the executor's spawn output cap. No `### Requirement`/`#### Scenario` heading was added, removed, or renamed (counts stay 16/61). This closes the residual wording conflict recorded under C6 Issues Found.

