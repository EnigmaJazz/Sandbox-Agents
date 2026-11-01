# ODD task — orca-report-probe-realignment

## Objective
Make the `host_orca_report` S4 liveness probe accept the reply the installed Orca CLI
actually returns, so a live dispatch is reportable again.

## Status
**DONE — installed in the host worktree and verified. Not committed (owner's step).**
No broker restart, no `install-user-files-v2`, no secure-opencode-v2 restart was performed.

## Problem
`buildOrcaDispatchProbeArgv` ran `orca orchestration check --terminal <handle> --json`. The real
`check` reply carries only `acknowledged, cancelled, connectionLost, count, deliveryId,
dispatchId, messages, mutation, replayed, runId, timedOut` — no `taskId`, no terminal handle and
no `status` — so `parseOrcaDispatchProbe` never matched and every `worker_done`, `heartbeat` and
`ask` was refused as "not live". Verified against the installed CLI by the owner, not inferred
from this repository.

The read-only replacement is `orca orchestration worker-show --dispatch <ctx_…> --json`, whose
reply is `{ "ok": true, "result": { "dispatch": {…}, "worker": …, "terminal": …, … } }`. A live
`result.dispatch` carries `status: "dispatched"`, `assigneeHandle` equal to the worker's `term_…`
handle, `taskId: "task_<12 hex>"`, `id: "ctx_<12 hex>"`, and null `completedAt`,
`terminationReason` and `capabilityRevokedAt`.

## Scope
In: `broker/src/orca.ts` (probe argv, parser, docstring), `broker/src/service.ts`
(`buildOrcaReportOp` probe call), `broker/tests/orca-report.test.ts`,
`docs/config-manifest-host-tools.md` §5f.

Out: every other `orcaReport` rule (fixed binary, allowlisted types, field validation, admission
and classification, the send argv); `nono/profile/opencode-v2-secure.json`;
`systemd-user/broker.env`; broker restart.

## Constraints
- S17 paths (`broker/src/**`) are written only through the result-install path after owner review;
  `sandbox_apply` refuses them by design.
- `worker-show` is read-only and takes the dispatch id the caller already holds; no caller-chosen
  program, flag or environment.
- Fail closed: only an explicitly observed live dispatch is reportable; every other reply refuses
  with a named reason rather than sending unchecked.

## Tasks
- **T1** Probe argv is `[binary, "orchestration", "worker-show", "--dispatch", <dispatchId>, "--json"]`.
  Done, verified host-side (`broker/src/orca.ts:63-64`).
- **T2** `parseOrcaDispatchProbe` reads `result.dispatch` and requires `ok === true`, plain
  `result`/`result.dispatch` objects, exact `id`/`taskId`/`assigneeHandle`, `status` exactly
  `dispatched`, and the three settlement fields present and `null`; every other reply refuses with
  a reason-naming `StateError`. The old guessing (`SETTLED_DISPATCH_STATES`,
  `dispatchCandidates`, `firstField`, array shapes, snake_case alternatives, multi-match branch)
  is deleted. Done, verified by test.
- **T3** S4 tests rewritten (19 cases in the block, 41 in the file): live accepted with exactly one
  probe and one send; exact argv; wrong terminal, wrong task, wrong dispatch id, non-`dispatched`
  status, missing status, three non-null settlement fields, three missing settlement fields,
  `ok: false`, non-JSON, non-object JSON, missing `result`, missing `result.dispatch`, both old
  `check` reply shapes, probe timeout and non-zero exit — every refusal proving one probe spawn and
  no send. Done, verified by test.
- **T4** The docstring that called the reply shape unverifiable and the manifest §5f "Liveness
  (S4)" paragraphs now document the verified `worker-show` predicate. Done, verified.

## Acceptance criteria
- A live `result.dispatch` reply sends exactly once and reports `dispatchState: "dispatched"`. Met.
- Every non-live reply listed in T3 is refused with a named reason and nothing is sent. Met.
- No other `orcaReport` rule changes. Met.
- The broker suite passes apart from the known `v2-launch.test.ts` V2 nono profile failure. Met
  host-side.

## Checks
- Host baseline before the change (`host_test_run` runner `broker-unit`, HEAD `20a37b4`): 1580 pass
  / 9 skip / 1 fail.
- Sandbox, `bun test tests/orca-report.test.ts` (cwd `broker`): 41 pass / 0 fail. Before the
  implementation the same file was 21 pass / 20 fail — the new tests failed first.
- Sandbox, `bun test` (cwd `broker`): 1592 pass / 10 skip / 1 fail; the extra skip is
  `nono profile validate` (`nono` absent from the sandbox PATH). `bun build --target=bun
  src/main.ts`: succeeded, no diagnostics.
- **Host after install** (`host_test_run` runner `broker-unit`, HEAD `99b8228`): **1603 tests,
  1593 pass, 9 skip, 1 fail**. The single failure is the known
  `V2 nono profile > reaches the same hosts and project roots as V1, with the same isolation`
  (`tests/v2-launch.test.ts:94`, owner-side `platform.claude.com` in
  `nono/profile/opencode-v2-secure.json`). Pass count is baseline + the 13 added tests; the skip
  count is unchanged at 9. `orca-report.test.ts` contributes 41 passing tests with no skips.
- Host structural readback after install: `broker/src/orca.ts:59-64` carries the `worker-show`
  argv and its new docstring.

## Install
`host_sandbox_result_install` for `ses_e67302547ffeuGV7HZJXG4emng`
(result `refs/opencode-sandbox/result/ses_e67302547ffeuGV7HZJXG4emng`, commit `f49ef2e`,
4 files, 382 authored lines) succeeded with `installed: true`, restoring all four paths.
The earlier attempt was refused with `working tree diverged from baseline at: broker/src/orca.ts,
broker/tests/orca-report.test.ts` because those two files were the feature's **new** files and
were untracked in the host index while the baseline snapshot (`git add -A`) contained them. The
owner staged both, and the identical result then installed unchanged. This is the recorded
result-install divergence for untracked targets, not a defect in this change.

## Route and trigger evidence
Route: bug investigation with an authorized fix (WORKFLOW.md Task Classes), test-first, then
review. Substantial by decision content: an authorization-relevant enforcement gate and its test
surface. Writer: `pr-comment-resolver` subagent (the configured `systematic-implementer` variant is
unavailable on this host). Two writer sessions produced equivalent results; the second is the
installed one.

## Progress
Installed and green. Nothing committed by the orchestrator: `host_git_commit` needs an applied
result and refuses S17 paths, so the owner commits.

## Next step
Post-code advisory review of the committed candidate (an authorization gate), then the owner's
work-unit commit. No broker restart is included: the running broker still executes the previously
built code, so the live `worker-show` path is exercised only after the owner restarts it.


## Revisions
- r1 2026-11-01T20:23:25Z gentle-orchestrator: Create the tracker for the orcaReport liveness-probe realignment
- r2 2026-11-01T20:40:20Z gentle-orchestrator: Record implementation done, verified in sandbox, install blocked on untracked targets
- r3 2026-11-01T21:18:44Z gentle-orchestrator: Record successful install and the green host suite
