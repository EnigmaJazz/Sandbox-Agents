# Tasks: Agent Host Tools

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 900–1150 (adds roughly 250–350 lines for finish/reset/grant) |
| 800-line budget risk | High |
| Chained PRs recommended | No (single maintainer-approved size exception) |
| Suggested split | Single PR: runtime/authorization, plugin wiring, and ledger tests |
| Delivery strategy | single-pr |
| Chain strategy | size:exception |
| Decision needed before apply | Yes (requires maintainer-approved size:exception) |

Decision needed before apply: Yes
Chained PRs recommended: No
Chain strategy: size:exception
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Runtime commands, authorization, and flag probe | PR 1 | `cd broker && bun test` | Host-broker probes for installed `gentle-ai` flags | Revert runtime/authorization files only |
| 2 | Ref-scoped commit, guarded push, and GH issue | PR 2 | `cd broker && bun test` | `SANDBOX_GATED_TESTS` live git/GH scenarios (if supported) | Revert `gitops.ts` and related tools/tests |
| 3 | Registration dispatch, permissions, docs, and integration | PR 3 | `cd broker && bun test` | `bun build src/main.ts`; manual `.new` staging/apply review | Revert registration/plugin/fragment/docs changes |
| 4 | Maintainer-authorized attempt ledger tools: acquire, settle, status, begin, finish, rescope, reset, and grant | PR 4 / size:exception | `cd broker && bun test` | Host-broker ledger invocations with CLI cap/state/CAS rejection and status passthrough | Revert ledger types, runtime, service, plugin, permissions, tests, and artifact amendments |

Forecast note: this unit adds roughly 250–350 lines to the already-recorded 650–800 estimate, for an expected 900–1150 total, and requires the maintainer-approved `size:exception` / `single-pr` decision.

## Phase 1: Contract Probe and Foundation

- [x] 1.1 Through the host broker, verify `sdd-continue --json`, `review assess --cwd/--json`, and `review mode status --json` against installed `gentle-ai`; record exact outcomes before freezing builders.
- [x] 1.2 Reconcile the verified flags in `openspec/changes/agent-host-tools/specs/host-sdd-runtime-tools/spec.md` (line ~7), preserving the design’s final argv contract.
- [x] 1.3 Add P0 payload types, operation names, allowlisted keys, canonical path/value validators, and `HostToolPolicy` authorization tests in `broker/src/types.ts`, `broker/src/validation.ts`, and `broker/tests/validation.test.ts`; Test: `cd broker && bun test`.

## Phase 2: SDD Runtime and Authorization

- [x] 2.1 Add RED tests for exact status/continue/acquire/settle/archive/verify/task-result/review vectors, all settle outcomes, omitted interrupted revision, unsafe keys, and read-vs-mutation authorization in `broker/tests/sdd-runtime.test.ts` and `broker/tests/service-host-tools.test.ts`.
- [x] 2.2 Implement fixed builders/handlers/dispatch in `broker/src/sdd-runtime.ts`, `broker/src/sdd-service.ts`, `broker/src/service.ts`, and `broker/src/server.ts`; expose tools and policy in `opencode/plugins/sandbox-tools.ts`, `opencode/plugins/lib/host-tool-approval.ts`, and `opencode/config-fragments/sandbox-permissions.jsonc`; Test: `cd broker && bun test`.
- [x] 2.3 Add pure metadata-rich `ctx.ask` helper tests and implement mutation approval metadata in `opencode/plugins/lib/host-tool-approval.ts`; Test: `cd broker && bun test`.

## Phase 3: Git, GH, Registration, and Integration

- [x] 3.1 Add RED tests for approved-cwd/relative/absolute selector rejection, B→C scope, staged/empty state, `-a` avoidance, protected paths, branch/upstream/detached/force/refspec guards, redaction, caps, and exact GH argv in `broker/tests/gitops.test.ts` and `broker/tests/service-host-tools.test.ts`.
- [x] 3.2 Implement `gitCommit`, `gitPush`, and `ghIssueCreate` in `broker/src/gitops.ts`, `broker/src/service.ts`, `broker/src/server.ts`, `opencode/plugins/sandbox-tools.ts`, `opencode/plugins/lib/broker-client.ts`, and `opencode/config-fragments/sandbox-permissions.jsonc`; Test: `cd broker && bun test`.
- [x] 3.3 Wire existing `buildRegisterProjectOp` dispatch and validation in `broker/src/server.ts`, `broker/src/service.ts`, and `broker/src/validation.ts`; add success/nonzero tests in `broker/tests/service-host-tools.test.ts`; Test: `cd broker && bun test`.
- [x] 3.4 Document S17 protected-path review and `.new` staging/apply-review rollout in `docs/threat-model.md`; do not touch live configuration; Test: `cd broker && bun test`.

### Correction work unit: ledger-untracked-declaration

- [x] 3.5 Add read operation `reviewStatus` (exact fixed argv, `agent` defaulting to `opencode`, raw-envelope passthrough), payload key `reviewStatus: [projectDir, agent]`, read authorization, plugin tool `host_review_status`, and fragment `allow`.
- [x] 3.6 Extend `sddAttemptAcquire` with `untrackedScope`, `expectedUntrackedInventory`, and `intendedUntracked`: allowlisted payload keys, bounded and canonicalized validation, appended argv, plugin pass-through args, and ask metadata (scope, digest, untracked count).
- [x] 3.7 Surface bounded (at most 4 KiB) trimmed stderr in `SddRuntimeExecutor.run()` for both empty stdout and non-JSON stdout.
- [x] 3.8 Add focused tests for review-status argv, acquire untracked variants and rejections, stderr surfacing, and read/mutation authorization; Test: `cd broker && bun test`.
- [x] 3.9 Update the spec/design/tasks/apply-progress artifacts for this correction (review status read, acquire untracked declaration); Test: `cd broker && bun test`.

- [x] 3.10 Extend `sddAttemptSettle` with the shared untracked declaration (`untrackedScope`, `expectedUntrackedInventory`, `intendedUntracked`): allowlisted payload keys, shared canonicalized validation reused by acquire and settle, appended argv, plugin pass-through args, and ask metadata (scope, digest, untracked count).
- [x] 3.11 Add focused settle untracked tests (argv with scope+digest, select+intended, no-flag unchanged, rejections, interrupted still omits `--evidence-revision`, shared-helper coverage) in `broker/tests/sdd-settle-untracked.test.ts`; Test: `cd broker && bun test`.
- [x] 3.12 Update the spec/design/tasks/apply-progress artifacts for Correction 2 (settle untracked declaration); Test: `cd broker && bun test`.

## Phase 4: Verification

- [x] 4.1 Run `cd broker && bun test` and `bun build src/main.ts`; verify live gated git/GH scenarios only when supported and preserve exact broker evidence.
- [x] 4.2 Confirm every mutation is orchestrator-only plus fragment `ask` and `ctx.ask`, every read is prompt-free/open, and rollback stops before sandbox apply or restores prior files.

S17 protected paths require explicit manual review; deliver through sandbox `.new` staging, `sandbox_finish`, and apply-review flow. No credentials, live configuration, installs, or arbitrary dispatch are permitted.

## Phase 5: Acceptance & Carry-forward (operator-owned)

- [ ] 5.1 Restore `BROKER_PROTECTED_SECURITY_FILES` in the live `~/.config/opencode-sandbox/broker.env` to the full S17 list (currently temporarily `[]`) and remove `BROKER_REAP_INTERVAL_MS=3600000`; restart `sandbox-broker`. Rule B: must be restored before final acceptance.
- [ ] 5.2 Reinstall the repository plugin to `~/.config/opencode/plugins/` and restart the secure OpenCode so the new host tools (`host_sdd_*`, `host_review_*`, `host_git_*`, `host_gh_*`), the colour-coded `sandbox_apply` preview, and the `sdd-attempt` acquire/settle ledger are live.
- [ ] 5.3 Commit the landed work as reviewable work units. PR 1 (apply-preview prereq) and PR 2 (slice 1) are currently intermixed in the working tree; `broker/src/service.ts` and `opencode/plugins/sandbox-tools.ts` need hunk-splitting.
- [ ] 5.4 Fix `runPrepare` import fetch to a forcing refspec (`+<ref>:<ref>`) in `broker/src/service.ts` (~line 1263) and `broker/src/gitops.ts:88`; add a test proving a second prepare/auto-finish succeeds. Prevents the reaper-induced non-fast-forward that lost two slice-1 attempts.
- [ ] 5.5 S17 manual review of all protected-path changes (`broker/src/**`, `opencode/plugins/**`, `opencode/config-fragments/**`) before final acceptance.
- [ ] 5.6 Run slices 2–3 and verify under the full `gentle-ai sdd-attempt acquire/settle` ledger once the plugin is reinstalled (the settle TOOL was not live for slices 1–2, which ran under a documented bootstrap exception).

Note: SDD phase dispatch is latched in the session that hit sdd_task_result_malformed from sdd-apply; slices 2–3, verify, and archive must run in a NEW session.

### Work unit: host-sdd-attempt-ledger-tools

- [x] 3.13 Write RED tests first for exact argv, malformed `expectedRevision`, positive cap forwarding, CLI rejection without broker clamping, exact payload keys, bounded/control-free `actor` and `reason`, and orchestrator-only handler authorization in `broker/tests/sdd-runtime.test.ts`, `broker/tests/validation.test.ts`, and `broker/tests/service-host-tools.test.ts`; Test: `cd broker && bun test`.
- [x] 3.14 Register `sddAttemptRescope` and `SddAttemptRescopePayload`, canonical validators/allowlist, and `HOST_MUTATION_OPERATIONS` wiring in `broker/src/types.ts` and `broker/src/validation.ts`; validate `sha256:` plus 64 lowercase hex, positive integer caps, existing identifiers, bounded actor, and 1..4096-byte control-free reason.
- [x] 3.15 Add `buildSddAttemptRescopeArgv` and executor in `broker/src/sdd-runtime.ts`, service handler/`authorizeHostDispatch` in `broker/src/sdd-service.ts` and `broker/src/service.ts`, and dispatch in `broker/src/server.ts`; emit the exact fixed argv and never clamp or encode the CLI cap ceiling.
- [x] 3.16 Add `host_sdd_attempt_rescope` optional-field pass-through in `opencode/plugins/sandbox-tools.ts`, operation client support and ask metadata (change, expectedRevision, workUnit, caps, actor) in `opencode/plugins/lib/{broker-client,host-tool-approval}.ts`, and `ask` in `opencode/config-fragments/sandbox-permissions.jsonc`; update `openspec/changes/agent-host-tools/specs/host-sdd-runtime-tools/spec.md`, `openspec/changes/agent-host-tools/design.md`, `openspec/changes/agent-host-tools/tasks.md`, and `openspec/changes/agent-host-tools/apply-progress.md`; Test: `cd broker && bun test`.

- [x] 3.17 Write RED tests first in `broker/tests/sdd-runtime.test.ts` for exact begin argv, malformed `expectedRevision`, positive cap forwarding, CLI rejection without broker clamping, and tolerant status passthrough of non-JSON stdout; in `broker/tests/validation.test.ts` for exact payload keys for both operations and the begin allowlist; and in `broker/tests/service-host-tools.test.ts` for begin orchestrator-only authorization/handler routing and status read authorization open to all. Test: `cd broker && bun test`.
- [x] 3.18 Register `sddAttemptBegin` and `sddAttemptStatus` in `broker/src/types.ts` (`Operation` union, `OPERATIONS`, payload types) and `broker/src/validation.ts` (canonical validators, payload-key allowlists, `sddAttemptBegin` in `HOST_MUTATION_OPERATIONS`, `sddAttemptStatus` in `HOST_READ_OPERATIONS`).
- [x] 3.19 Add `buildSddAttemptBeginArgv`/`buildSddAttemptStatusArgv` and executor methods in `broker/src/sdd-runtime.ts`; begin handler and `authorizeHostDispatch` in `broker/src/sdd-service.ts` and `broker/src/service.ts`; status handler; and dispatch cases in `broker/src/server.ts`. Emit exact fixed argv; begin never clamps or encodes the CLI cap ceiling; status uses tolerant raw-envelope passthrough and never hard-fails on non-JSON.
- [x] 3.20 Add `host_sdd_attempt_begin` (ask metadata: change, expectedRevision, workUnit, caps) and `host_sdd_attempt_status` (read, no prompt) in `opencode/plugins/sandbox-tools.ts`; operation names in `opencode/plugins/lib/broker-client.ts`; begin ask metadata in `opencode/plugins/lib/host-tool-approval.ts`; `ask` for begin and `allow` for status in `opencode/config-fragments/sandbox-permissions.jsonc`; update the spec/design/tasks/apply-progress artifacts as part of the unit. Test: `cd broker && bun test`.

- [x] 3.21 Write RED tests for `sddAttemptFinish`: exact fixed argv and optional-flag order, canonical-root cwd, exact payload keys, CAS/evidence/outcome coupling, untracked declaration, redaction-before-cap, and orchestrator-only authorization/dispatch in `broker/tests/{sdd-runtime,validation,service-host-tools}.test.ts`; Test: `cd broker && bun test`.
- [x] 3.22 Implement finish contracts, allowlists, validators, `buildSddAttemptFinishArgv`, redacted capped executor output, service authorization/handler, and server dispatch in `broker/src/{types,validation,sdd-runtime,sdd-service,service,server}.ts`; preserve CLI state policy and do not accept token/cwd/binary/argv.
- [x] 3.23 Wire `host_sdd_attempt_finish` with metadata-rich `ctx.ask`, broker-client operation/timeout, and fragment `ask` in `opencode/plugins/{sandbox-tools.ts,lib/broker-client.ts}` and `opencode/config-fragments/sandbox-permissions.jsonc`; extend `broker/tests/service-host-tools.test.ts` for routing, metadata, timeout, and permissions. Test: `cd broker && bun test`.

- [x] 3.24 Write RED tests for `sddAttemptReset`: exact argv and optional relation order, canonical-root cwd, exact payload keys, CAS/text/relation validation, CLI-authorized terminal-state behavior, redaction-before-cap, and orchestrator-only authorization in `broker/tests/{sdd-runtime,validation,service-host-tools}.test.ts`; Test: `cd broker && bun test`.
- [x] 3.25 Implement reset contracts, allowlists, validators, `buildSddAttemptResetArgv`, redacted capped executor output, service authorization/handler, and server dispatch in `broker/src/{types,validation,sdd-runtime,sdd-service,service,server}.ts`; forward relation unchanged and leave objective-state policy to the CLI.
- [x] 3.26 Wire `host_sdd_attempt_reset` with metadata-rich `ctx.ask`, broker-client operation/timeout, and fragment `ask` in `opencode/plugins/{sandbox-tools.ts,lib/broker-client.ts}` and `opencode/config-fragments/sandbox-permissions.jsonc`; extend `broker/tests/service-host-tools.test.ts` for routing, metadata, timeout, and permissions. Test: `cd broker && bun test`.

- [x] 3.27 Write RED tests for `sddAttemptGrant`: exact repeated-root argv order, initial versus CAS revision, canonical unique root bounds, safe token/actor/reason, redaction-before-cap, and orchestrator-only authorization in `broker/tests/{sdd-runtime,validation,service-host-tools}.test.ts`; Test: `cd broker && bun test`.
- [x] 3.28 Implement grant contracts, allowlists, canonical-root/path validators, `buildSddAttemptGrantArgv`, redacted capped executor output, service authorization/handler, and server dispatch in `broker/src/{types,validation,sdd-runtime,sdd-service,service,server}.ts`; preserve supplied roots/order and do not synthesize revision or state.
- [x] 3.29 Wire `host_sdd_attempt_grant` with metadata-rich `ctx.ask`, broker-client operation/timeout, and fragment `ask` in `opencode/plugins/{sandbox-tools.ts,lib/broker-client.ts}` and `opencode/config-fragments/sandbox-permissions.jsonc`; extend `broker/tests/service-host-tools.test.ts` for routing, metadata, timeout, and permissions. Test: `cd broker && bun test`.

### Work unit: host-plan-doc (`planDocAppend`)

- [x] 3.30 Write RED tests for exact `{projectDir,doc,content,heading?}` keys, enum-only `todo`/`plan` mapping, traversal/absolute/unknown/protected rejection, oversize/control-character rejection, approval, and orchestrator-only authorization in `broker/tests/{plan-doc,validation,service-host-tools}.test.ts`; Test: `cd broker && bun test`.
- [x] 3.31 Add `planDocAppend` types, allowlist, canonical-root/destination validators, mutation policy, handler, and server dispatch in `broker/src/{types,validation,sdd-service,service,server}.ts`; reject caller cwd/binary/argv and pin the canonical key set including optional `heading`.
- [x] 3.32 Implement dependency-free atomic append/create/heading insertion in new `broker/src/plan-doc.ts`; serialize by destination, preserve existing bytes, use sibling exclusive temp + fsync + rename, revalidate paths, and clean up failures.
- [x] 3.33 Wire `host_plan_append`, metadata-rich `ctx.ask`, broker-client operation/timeout, and fragment `ask` in `opencode/plugins/{sandbox-tools.ts,lib/{broker-client,host-tool-approval}.ts}` and `opencode/config-fragments/sandbox-permissions.jsonc`; Test: `cd broker && bun test`.
- [x] 3.34 Add RED coverage for create-if-missing, append preservation, heading boundaries, concurrent serialization, atomic failure/temp cleanup, symlink/path drift, protected destinations, and no mutation before approval in `broker/tests/plan-doc.test.ts`; update `openspec/changes/agent-host-tools/specs/host-plan-doc/spec.md` to declare optional `heading`, plus `design.md`, `tasks.md`, and `docs/threat-model.md`; Test: `cd broker && bun test`.

### Work unit: host-review-lifecycle (nine operations)

- [x] 3.35 Write RED tests first for exact argv/key allowlists and enum/shape/size/boolean/coupling rejection across `reviewStart`, `reviewCaptureResult`, `reviewCaptureUnachievable`, `reviewAcknowledgeApproved`, `reviewCaptureCorrectionPlan`, `reviewCaptureRefuter`, `reviewCaptureValidation`, `reviewValidate`, and `reviewRecover` in `broker/tests/{review-runtime,validation,service-host-tools}.test.ts`; Test: `cd broker && bun test`.
- [x] 3.36 Add contracted payload types, validators, operation registration, and orchestrator-only mutation authorization in `broker/src/{types,validation,sdd-service,service}.ts`; preserve accepted provider tokens verbatim, including repeated path order and opaque `reviewRecover.focus`.
- [x] 3.37 Implement separate fixed-argv builders and executor methods for all nine operations in new `broker/src/review-runtime.ts`; use canonical cwd, direct spawn, timeout handling, and redact-before-512-KiB output caps without reconstructing provider tokens.
- [x] 3.38 Implement review handlers and dispatch in `broker/src/{sdd-service,service,server}.ts`; stage validated regular `reviewCaptureResult.input` files privately as designed, pass literal `-` only for explicit EOF, and clean staged files on every exit plus startup stale cleanup.
- [x] 3.39 Wire nine plugin tools, broker-client methods/timeouts, metadata-rich `ctx.ask`, and nine fragment `ask` entries in `opencode/plugins/{sandbox-tools.ts,lib/{broker-client,host-tool-approval}.ts}` and `opencode/config-fragments/sandbox-permissions.jsonc`; Test: `cd broker && bun test`.
- [x] 3.40 Add RED tests for staged-file mode/size/permissions/snapshot/lifetime/cleanup, literal `-`, nonzero/timeout/redaction behavior, canonical-root enforcement, approval, and non-orchestrator denial; extend `broker/tests/{review-runtime,validation,service-host-tools}.test.ts`; Test: `cd broker && bun test`.
- [x] 3.41 Update `openspec/changes/agent-host-tools/specs/host-review-tools/spec.md`, `openspec/changes/agent-host-tools/design.md`, `openspec/changes/agent-host-tools/tasks.md`, and `docs/threat-model.md`; record verification open questions for the acknowledge-approved flag, capture-result staging, and recover `--focus` domain, while keeping `sdd-attempt handoff|repair` deferred.

Ledger work unit: `host-sdd-attempt-ledger-tools` covers acquire, settle, status, begin, finish, rescope, reset, and grant. `sdd-attempt handoff` and `sdd-attempt repair` remain deferred.

Extension note: this extension adds roughly 250–350 lines to the already-recorded 650–800-line estimate and remains under the maintainer-approved `size:exception` / `single-pr` decision.

### Work unit: host-tool-gaps (remediation)

Spec↔CLI reconciliation for four host-tool contracts: the frozen delta specs and the installed `gentle-ai` CLI disagreed, so both the specs and the implementation were amended to agree. No new files were created.

- [x] 3.42 G1: `sdd-attempt begin` untracked declaration — spec argv/allowlist + "Begin untracked declaration" scenario; `buildSddAttemptBeginArgv` exact keys + `appendUntrackedDeclaration`; `sddAttemptBegin` allowlist; `SddAttemptBeginPayload`; `attemptBegin` executor; `buildSddAttemptBeginOp`; `host_sdd_attempt_begin`; `buildSddAttemptBeginAsk`; Test: `cd broker && bun test`.
- [x] 3.43 G2: `sdd-attempt settle --remediates-evidence-revision` — spec settle template; `buildSddAttemptSettleArgv` exact key + bare 64-hex flag; `sddAttemptSettle` allowlist; `SddAttemptSettlePayload`; `attemptSettle` executor; `buildSddAttemptSettleOp`; `host_sdd_attempt_settle`; `buildSddAttemptSettleAsk`; Test: `cd broker && bun test`.
- [x] 3.44 G3: `review status` passthrough — spec review-status template; `buildReviewStatusArgv` exact keys + `--lineage`/`--repository-context`/`--projection` after `--agent` before `--next-transition`; `reviewStatus` allowlist; `ReviewStatusPayload`; executor; `buildReviewStatusOp`; `host_review_status` (read, no `ctx.ask`); Test: `cd broker && bun test`.
- [x] 3.45 G4: `review capture-result --order` accepts `0` — review spec `0..32`; `assertReviewOrder`; `reviewOrderArg`; `buildReviewCaptureResultAsk`; Test: `cd broker && bun test`.
- [x] 3.46 RED-first tests in `broker/tests/{sdd-runtime,validation,sdd-settle-untracked,service-host-tools,host-tool-approval}.test.ts`; `cd broker && bun test` -> **329 pass / 0 fail** (1436 expect() calls, 15 files); plugin parse -> **Bundled 10 modules**.

### Addendum: review workload and suggested work units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 5 | `host-plan-doc`: approved append-only TODO/PLAN document writes | Single PR / size:exception | `cd broker && bun test` | Approved append/create/heading scenarios; no live config | Revert plan-doc module, wiring, plugin/fragment entries, tests, and artifacts |
| 6 | `host-review-lifecycle`: nine fixed-argv review operations and staged capture input | Single PR / size:exception | `cd broker && bun test` | Approved lifecycle vectors, staged cleanup, and token passthrough | Revert review runtime, wiring, plugin/client/permissions, tests, and artifacts |

Amended estimate: 1600–2100 total changed lines, adding roughly 700–950 lines; retain the single-PR `size:exception` decision.
Decision needed before apply: Yes
Chained PRs recommended: No

### Work unit: review-status-intended-untracked-selection (correction)

- [x] C1 RED tests first in `broker/tests/{validation,sdd-runtime,service-host-tools}.test.ts` for the `reviewStatus` allowlist, the fail-closed validator, exact argv position (after `--projection`, before `--next-transition`), verbatim byte passthrough, and rejection of non-JSON / oversized / control-bearing / flag-like values before spawn.
- [x] C2 Add `intendedUntrackedSelection` to `ReviewStatusPayload` (`broker/src/types.ts`) and to the `reviewStatus` payload-key allowlist, plus `assertIntendedUntrackedSelection` (non-empty JSON, 65536-byte cap, control-free, not flag-like) in `broker/src/validation.ts`.
- [x] C3 Emit exactly one `--intended-untracked-selection <json>` element after `--projection` and before `--next-transition`, forwarded verbatim, in `buildReviewStatusArgv`; extend `ReviewStatusArgvInput` and the `reviewStatus` executor; forward the field in `buildReviewStatusOp` (`broker/src/sdd-runtime.ts`, `broker/src/sdd-service.ts`).
- [x] C4 Add the optional `intendedUntrackedSelection` string arg and pass-through to `host_review_status` in `opencode/plugins/sandbox-tools.ts`; it stays a read (`allow`, no `ctx.ask`).
- [x] C5 Extend the review-status fixed-argv template and add the "Review status intended untracked selection" scenario in `specs/host-sdd-runtime-tools/spec.md`; record the transport in `design.md`; update this task block and `apply-progress.md`; Test: `cd broker && bun test`; builds: `bun build --target=bun broker/src/main.ts` and the plugin parse.

## Phase 6: Review lens-context and inline capture

- [x] 6.1 Add `reviewLensContext` read op: `Operation`/`OPERATIONS` + `ReviewLens`/`ReviewLensContextPayload` in `broker/src/types.ts`; `HOST_READ_OPERATIONS` + payload-key allowlist + `assertReviewLens`/`assertReviewInputJson` in `broker/src/validation.ts`; `buildReviewLensContextArgv` + `runRaw` executor in `broker/src/sdd-runtime.ts`; `buildReviewLensContextOp` in `broker/src/sdd-service.ts`; dispatch in `broker/src/server.ts`.
- [x] 6.2 Add `inputJson` inline capture: `ReviewCaptureResultPayload.inputJson`, `reviewCaptureResult` allowlist, mutually-exclusive staging via `stageReviewInputJson`/`writeStagedReviewInput` with the existing `finally` cleanup in `broker/src/sdd-runtime.ts`, and pass-through in `broker/src/sdd-service.ts`.
- [x] 6.3 Wire `host_review_lens_context` (read, no `ctx.ask`) and `inputJson` on `host_review_capture_result`; add inline byte count + digest to `buildReviewCaptureResultAsk` in `opencode/plugins/lib/host-tool-approval.ts`; fragment `allow` for the lens-context read.
- [x] 6.4 Tests: lens-context argv/executor/authorization and inline staging/rejection in `broker/tests/{sdd-runtime,validation,service-host-tools,host-tool-approval}.test.ts`.
- [x] 6.5 Artifacts: `specs/host-review-tools/spec.md` (read + exact argv + `inputJson`), `specs/host-tool-authorization/spec.md` (nine reads), `design.md`, `tasks.md`, `apply-progress.md`.
