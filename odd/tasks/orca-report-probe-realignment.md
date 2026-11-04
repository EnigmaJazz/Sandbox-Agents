# ODD task — orca-report-probe-realignment

## Objective
Make the `host_orca_report` S4 liveness probe accept the reply the installed Orca CLI
actually returns, so a live dispatch is reportable again.

## Status
**IMPLEMENTED, INSTALLED, COMMITTED, LIVE, ADVISORY-REVIEWED. Refuse path verified against the real CLI; accept path still unobserved.**
One work unit in three commits — `9e5e88f`, `007a806`, `f98dd15`, all subject `feat(broker): add orca report bridge` (owner-attested: "It is one change"). Code at HEAD: `broker/src/orca.ts:63-64`. Broker restarted 2026-11-04, so the new probe is executing.

## Problem
`buildOrcaDispatchProbeArgv` ran `orca orchestration check --terminal <handle> --json`. The real
`check` reply carries only `acknowledged, cancelled, connectionLost, count, deliveryId,
dispatchId, messages, mutation, replayed, runId, timedOut` — no `taskId`, no terminal handle and
no `status` — so `parseOrcaDispatchProbe` never matched and every `worker_done`, `heartbeat` and
`ask` was refused as "not live". Verified against the installed CLI by the owner.

The replacement is `orca orchestration worker-show --dispatch <ctx_…> --json`, whose reply is
`{ "ok": true, "result": { "dispatch": {…}, "worker": …, "terminal": …, … } }`. A live
`result.dispatch` carries `status: "dispatched"`, `assigneeHandle` equal to the worker's `term_…`
handle, `taskId: "task_<12 hex>"`, `id: "ctx_<12 hex>"`, and null `completedAt`,
`terminationReason` and `capabilityRevokedAt`.

## Scope
In: `broker/src/orca.ts` (probe argv, parser, docstring), `broker/src/service.ts`
(`buildOrcaReportOp` probe call), `broker/tests/orca-report.test.ts`,
`docs/config-manifest-host-tools.md` §5f, `docs/threat-model.md` (accepted residual).

Out: every other `orcaReport` rule (fixed binary, allowlisted types, field validation, admission
and classification, the send argv); `nono/profile/opencode-v2-secure.json`;
`systemd-user/broker.env`.

## Constraints
- `broker/src/**` is S17: written in the sandbox, installed through the reviewed host path, committed by the owner.
- `worker-show` is read-only and takes the dispatch id the caller already holds; no caller-chosen program, flag or environment.
- Fail closed: only an explicitly observed live dispatch is reportable.

## Tasks
- **T1** Probe argv is `[binary, "orchestration", "worker-show", "--dispatch", <dispatchId>, "--json"]`. Done (`broker/src/orca.ts:63-64`).
- **T2** `parseOrcaDispatchProbe` reads `result.dispatch` and requires `ok === true`, plain `result`/`result.dispatch` objects, exact `id`/`taskId`/`assigneeHandle`, `status` exactly `dispatched`, and the three settlement fields present and `null`; every other reply refuses with a reason-naming `StateError`. The old guessing (`SETTLED_DISPATCH_STATES`, `dispatchCandidates`, `firstField`, array shapes, snake_case alternatives, multi-match branch) is deleted. Done.
- **T3** S4 tests rewritten (19 cases in the block, 41 in the file). Done.
- **T4** Docstring and manifest §5f document the verified `worker-show` predicate. Done.

## Checks
- Host baseline before the change (`broker-unit`, HEAD `20a37b4`): 1580 pass / 9 skip / 1 fail.
- Sandbox focused: 41 pass / 0 fail (21 pass / 20 fail before implementation — the new tests failed first).
- Host after install (`broker-unit`, HEAD `99b8228`): 1603 tests, 1593 pass, 9 skip, 1 fail — the known `tests/v2-launch.test.ts:94` profile mismatch. `orca-report.test.ts` contributes 41 passing, no skips.

## Live verification on the restarted broker (2026-11-04)
A real `host_orca_report` call with `type: "worker_done"` against a stale Orca dispatch returned:

```
orcaReport refused: dispatch ctx_d34806064c82 is not live (status failed)
```

What this establishes, and it is more than the fixtures could:
- The new `worker-show` probe **ran against the installed CLI** and resolved a real dispatch. The old `check` probe could not produce a status at all.
- The parser reached the status branch and refused on the actual settlement value `failed`, exactly as specified.
- Fail-closed behaviour holds end to end on the live path: the refusal names the field and nothing was sent.

What it does not establish: the **accept** path. Every available Orca session was stale, so no dispatch was in `status: "dispatched"`, and no live send has been observed. One live dispatch is still needed to see the accept branch and the actual send.

Operational note: all Orca sessions being stale is a coordinator-side condition, unrelated to this change, and worth its own look — it means no Orca-dispatched worker could report at all, live or not.

## Install
`host_sandbox_result_install` for `ses_e67302547ffeuGV7HZJXG4emng` (commit `f49ef2e`, 4 files, 382 authored lines) succeeded. An earlier attempt was refused with `working tree diverged from baseline` because the two new files were untracked; the owner staged them and the identical result installed. Recorded as the untracked-target divergence, not a defect.

## Route and trigger evidence
Route: bug investigation with an authorized fix, test-first, then review. Substantial by decision content: an authorization-relevant enforcement gate. Writer: `pr-comment-resolver` (the configured `systematic-implementer` variant is unavailable on this host).

## Post-code advisory review (2026-11-02)
Two independent advisors, neither seeing the other's answer.
- **Correctness: no findings.** All 12 parser branches and both service-level refusals are test-covered; no branch decides accept/refuse untested; wrong-shape replies land on named `StateError`s because `isRecord` guards every property read; no `check`-era remnants remain; §5f matches the implementation field for field; the timeout message is textually distinct.
- **Security: one CRITICAL, accepted as a residual** — the gate proves liveness, not ownership. Recorded in `docs/threat-model.md:222-246` (item 7, *Residual risks (honest, Gate 1)*) with the acceptance reasoning, the identifier entropy, and the testable assumption that no worker can learn another's dispatch tuple. Also the narrower probe/send TOCTOU.

## Next step
Two things, in this order:
1. One live `worker_done` from a dispatch in `status: "dispatched"` to exercise the accept branch. Until then the unit is verified on refusal only.
2. Then archive this tracker.


## Revisions
- r1 2026-11-01T20:23:25Z gentle-orchestrator: Create the tracker for the orcaReport liveness-probe realignment
- r2 2026-11-01T20:40:20Z gentle-orchestrator: Record implementation done, verified in sandbox, install blocked on untracked targets
- r3 2026-11-01T21:18:44Z gentle-orchestrator: Record successful install and the green host suite
- r4 2026-11-02T22:24:45Z gentle-orchestrator: Record the commit state and the outstanding advisory review
- r5 2026-11-02T22:30:17Z gentle-orchestrator: Record the advisory outcome and the accepted impersonation residual
- r6 2026-11-04T09:29:35Z gentle-orchestrator: Record the live refusal on the restarted broker and what remains unobserved
