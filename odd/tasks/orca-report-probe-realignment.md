# ODD task — orca-report-probe-realignment

## Objective
Make the `host_orca_report` S4 liveness probe accept the reply the installed Orca CLI
actually returns, so a live dispatch is reportable again.

## Status
**T1–T4 implemented and verified in the sandbox; installation is BLOCKED on an owner step.**
The result is exported and matches the owner's spec exactly; `host_sandbox_result_install`
refuses it for a reason that only the owner can clear (see Blocked).

## Problem
`buildOrcaDispatchProbeArgv` ran `orca orchestration check --terminal <handle> --json`. The
real `check` reply carries only `acknowledged, cancelled, connectionLost, count, deliveryId,
dispatchId, messages, mutation, replayed, runId, timedOut` — no `taskId`, no terminal handle
and no `status` — so `parseOrcaDispatchProbe` never matched and every `worker_done` /
`heartbeat` / `ask` was refused as "not live". Verified against the installed CLI by the
owner, not inferred from this repository.

The read-only replacement is `orca orchestration worker-show --dispatch <ctx_…> --json`, whose
reply is `{ "ok": true, "result": { "dispatch": {…}, "worker": …, "terminal": …, … } }`. A live
`result.dispatch` carries `status: "dispatched"`, `assigneeHandle` equal to the worker's
`term_…` handle, `taskId: "task_<12 hex>"`, `id: "ctx_<12 hex>"`, and null `completedAt`,
`terminationReason` and `capabilityRevokedAt`.

## Scope
In: `broker/src/orca.ts` (probe argv, parser, docstring), `broker/src/service.ts`
(`buildOrcaReportOp` probe call), `broker/tests/orca-report.test.ts`,
`docs/config-manifest-host-tools.md` §5f.

Out: every other `orcaReport` rule (fixed binary, allowlisted types, field validation,
admission and classification, the send argv); `nono/profile/opencode-v2-secure.json`;
`systemd-user/broker.env`; broker restart.

## Constraints
- S17 paths (`broker/src/**`) are never written on the host: the change lands as a sandbox
  result installed through `host_sandbox_result_install` after owner review.
- `worker-show` is read-only and takes the dispatch id the caller already holds; no caller-chosen
  program, flag or environment.
- Fail closed: only an explicitly observed live dispatch is reportable; every other reply
  refuses with a named reason rather than sending unchecked.

## Tasks
- **T1** Probe argv is now `[binary, "orchestration", "worker-show", "--dispatch", <dispatchId>, "--json"]`.
  **Done**, verified.
- **T2** `parseOrcaDispatchProbe` reads `result.dispatch` and requires `ok === true`, plain
  `result`/`result.dispatch` objects, exact `id`/`taskId`/`assigneeHandle`, `status` exactly
  `dispatched`, and the three settlement fields present and `null`; every other reply refuses
  with a reason-naming `StateError`. The old guessing (`SETTLED_DISPATCH_STATES`,
  `dispatchCandidates`, `firstField`, array shapes, snake_case alternatives, multi-match branch)
  is deleted. **Done**, verified.
- **T3** S4 tests rewritten: live accepted with exactly one probe and one send; exact argv;
  wrong terminal, wrong task, wrong dispatch id, non-`dispatched` status, missing status, three
  non-null settlement fields, three missing settlement fields, `ok: false`, non-JSON,
  non-object JSON, missing `result`, missing `result.dispatch`, both old `check` reply shapes,
  probe timeout and non-zero exit — every refusal proving one probe spawn and no send. **Done**,
  41 tests in the file, all passing.
- **T4** Docstring that called the reply shape unverifiable, and the manifest §5f "Liveness (S4)"
  paragraphs, now document the verified `worker-show` predicate. **Done**, verified.

## Acceptance criteria
- A live `result.dispatch` reply sends exactly once and reports `dispatchState: "dispatched"`. Met (test).
- Every non-live reply listed in T3 is refused with a named reason and nothing is sent. Met (test).
- No other `orcaReport` rule changes. Met: only the probe argv, the parser, the probe call site
  and the documentation changed.
- The broker suite passes apart from the known `v2-launch.test.ts` V2 nono profile failure. Met in
  the sandbox; the host tree still carries the old code, so this is not yet true host-side.

## Checks
- Host pre-change baseline (`host_test_run` runner `broker-unit`, HEAD `20a37b4`): 1580 pass /
  9 skip / 1 fail — the known `V2 nono profile > reaches the same hosts and project roots as V1`.
- Sandbox, after the change (`bun test tests/orca-report.test.ts`, cwd `broker`): 41 pass / 0 fail.
  The same file was 21 pass / 20 fail before the implementation, i.e. the new tests failed first.
- Sandbox, full suite (`bun test`, cwd `broker`): 1592 pass / 10 skip / 1 fail, 1603 tests. The one
  failure is the known `v2-launch.test.ts` profile test, untouched. The extra skip is
  `nono profile validate`, which skips because `nono` is not on PATH inside the sandbox.
- Sandbox, `bun build --target=bun src/main.ts` (cwd `broker`): succeeded, no diagnostics.
- Host, after the change: still 1580 pass / 9 skip / 1 fail, because nothing has been installed.

## Blocked
`host_sandbox_result_install` refuses both independently produced results with
`cannot install result: working tree diverged from baseline at: broker/src/orca.ts,
broker/tests/orca-report.test.ts`. Those two are exactly the files the orcaReport feature
**created** (they are untracked in the host index); `broker/src/service.ts` and the docs are
pre-existing tracked files and compare clean. The broker builds its baseline with
`git add -A` (so the baseline contains the untracked files) and then installs only after
`git diff --quiet <baseline> -- <paths>`, which reports a path that is in the baseline but
unknown to the index as differing. This is the same shape as the divergence recorded in
`books`/memory for untracked result targets; it is not caused by this change, and a second,
fresh writer session with a fresh baseline reproduced it exactly.

**Owner step to clear it**, either:
1. stage the two new files (`git add broker/src/orca.ts broker/tests/orca-report.test.ts`, or
   `git add -A` the whole feature the owner intends to commit), then re-run
   `host_sandbox_result_install` for `ses_e67302547ffeuGV7HZJXG4emng`; or
2. review and apply the exported diff by hand:
   `/home/james/.local/state/opencode-sandbox/apply-preview/ses_e67302547ffeuGV7HZJXG4emng.diff`.

`broker/src/**` is S17, so `sandbox_apply` is refused by design
(`result touches protected paths (S7/S17): broker/src/orca.ts, broker/src/service.ts`); the
result-install review is the sanctioned path.

## Route and trigger evidence
Route: bug investigation with an authorized fix (WORKFLOW.md Task Classes). Root cause is the
owner's live CLI observation, then test-first implementation, then review. Substantial by decision
content: an authorization-relevant enforcement gate plus its test surface. Writer:
`pr-comment-resolver` subagent (the configured `systematic-implementer` model variant is
unavailable on this host, `Variant unavailable for opencode-go/deepseek-v4.1-flash: max`). Two
writer sessions were used because the first result could not be installed; the second also
confirmed via `git ls-files -s` that all four targets are mode `100644`.

## Progress
Result `refs/opencode-sandbox/result/ses_e67302547ffeuGV7HZJXG4emng` (commit `f49ef2e`,
4 files, 382 authored lines, under the 400-line and 100 KiB limits). An earlier equivalent result
`refs/opencode-sandbox/result/ses_e67372f39ffeSGj6CpW3DyJncE` (commit `646b71a`, 365 authored
lines) exists and is superseded by the second. Neither is installed or committed.

## Next step
Owner stages the two new files (or applies the diff), the result is installed, the host suite is
re-run, and the predicate gets its post-code review before the owner commits.


## Revisions
- r1 2026-11-01T20:23:25Z gentle-orchestrator: Create the tracker for the orcaReport liveness-probe realignment
- r2 2026-11-01T20:40:20Z gentle-orchestrator: Record implementation done, verified in sandbox, install blocked on untracked targets
