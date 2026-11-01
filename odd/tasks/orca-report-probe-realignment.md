# ODD task — orca-report-probe-realignment

## Objective
Make the `host_orca_report` S4 liveness probe accept the reply the installed Orca CLI
actually returns, so a live dispatch is reportable again.

## Status
**Implementation in flight; the feature is installed uncommitted in this checkout.**
The probe was written against a guessed reply shape and refuses every report.

## Problem
`buildOrcaDispatchProbeArgv` runs `orca orchestration check --terminal <handle> --json`.
The real `check` reply carries only `acknowledged, cancelled, connectionLost, count,
deliveryId, dispatchId, messages, mutation, replayed, runId, timedOut` — no `taskId`, no
terminal handle and no `status` — so `parseOrcaDispatchProbe` never matches and every
`worker_done` / `heartbeat` / `ask` is refused as "not live". Verified against the installed
CLI by the owner, not inferred from this repository.

The read-only alternative is `orca orchestration worker-show --dispatch <ctx_…> --json`, whose
reply is `{ "ok": true, "result": { "dispatch": {…}, "worker": …, "terminal": …, … } }`. A live
`result.dispatch` carries `status: "dispatched"`, `assigneeHandle` equal to the worker's
`term_…` handle, `taskId: "task_<12 hex>"`, `id: "ctx_<12 hex>"`, and null `completedAt`,
`terminationReason` and `capabilityRevokedAt`.

## Scope
In: `broker/src/orca.ts` (probe argv, parser, docstring), `broker/src/service.ts`
(`buildOrcaReportOp` probe call and its docstring), `broker/tests/orca-report.test.ts`,
`docs/config-manifest-host-tools.md` §5f.

Out: every other `orcaReport` rule (fixed binary, allowlisted types, field validation,
admission and classification, the send argv); `nono/profile/opencode-v2-secure.json`;
`systemd-user/broker.env`; broker restart.

## Constraints
- S17 paths (`broker/src/**`) are never written on the host: the change lands as a sandbox
  result installed through `host_sandbox_result_install` after owner review.
- The fixed binary and fixed argv stay the boundary. `worker-show` is read-only and takes the
  dispatch id the caller already holds; no caller-chosen program, flag or environment.
- Fail closed: only an explicitly observed live dispatch is reportable; every other reply
  refuses with a named reason rather than sending unchecked.

## Tasks
- **T1** Replace the probe argv with `orca orchestration worker-show --dispatch <dispatchId> --json`.
- **T2** Rewrite `parseOrcaDispatchProbe` to read `result.dispatch` and require `id`, `taskId`,
  `assigneeHandle`, `status === "dispatched"`, and null `completedAt`, `terminationReason`,
  `capabilityRevokedAt`; refuse `ok: false`, non-JSON and a missing `result.dispatch`.
- **T3** Rewrite the S4 tests: live accepted; wrong terminal, wrong task, wrong dispatch id,
  wrong status, each non-null settlement field, `ok: false`, non-JSON, probe timeout and
  non-zero exit all refused with nothing sent.
- **T4** Update the docstring that calls the reply shape unverified, and the manifest docs that
  name the old probe.

## Acceptance criteria
- A live `result.dispatch` reply sends exactly once and reports `dispatchState: "dispatched"`.
- Every non-live reply listed in T3 is refused with a named reason and nothing is sent.
- No other `orcaReport` rule changes.
- The broker suite passes apart from the known `v2-launch.test.ts` V2 nono profile failure.

## Checks
- Pre-change baseline (`host_test_run` runner `broker-unit`, HEAD `20a37b4`): 1580 pass / 9 skip /
  1 fail — the known `V2 nono profile > reaches the same hosts and project roots as V1` test.

## Route and trigger evidence
Route: bug investigation with an authorized fix (WORKFLOW.md Task Classes). Root cause is the
owner's live CLI observation, then test-first implementation, then review. Substantial by
decision content: an authorization-relevant enforcement gate plus its test surface. One sandbox
writer implements; the coordinator is read-only and installs the exported result.

## Progress
Implementation in flight. No commit is claimed: the change is installed as a sandbox result and
the owner commits.

## Next step
Install the writer's result, run the broker suite, then review the new predicate.


## Revisions
- r1 2026-11-01T20:23:25Z gentle-orchestrator: Create the tracker for the orcaReport liveness-probe realignment
