# ODD task — planner-pm-aft-read

## Status
**IMPLEMENTED, ADVISORY-REVIEWED, COMMITTED, LIVE.** Committed as `0ac79d5` (three files: `broker/src/service.ts`, `broker/src/role-policy.ts`, `broker/tests/tool-admission.test.ts`). The broker was restarted 2026-11-04, so the admission change is executing.

Not yet observed: a real `planner` or `pm` session actually admitted for an AFT read. That is the last piece of evidence this unit owes.

## Objective
Give the `planner` and `pm` roles the same pre-activation AFT read access that `researcher` and `general` already have, without widening any other structured host read.

## Problem — verified in source before the change
All five AFT read tools classify as `HOST_READ_STRUCTURED` (`broker/src/role-policy.ts:212-213`). `decide()` denied that whole capability for every role except `researcher` and `general` at `:500-509`, returning before the role matrix was consulted at `:511`. The matrix entries `planner: { HOST_READ_STRUCTURED: true }` (`:435` before the change) and the `pm` equivalent were therefore unreachable — the matrix implied access the planner did not have.

Why explore subagents were unaffected: an agent binds only if it is in `readOnlyAgents` or normalizes to a role (`broker/src/service.ts:251`); an unbound session is allowed `HOST_READ_STRUCTURED` while in `HOST_READ_ONLY` (`:2547-2550`). `planner` and `pm` are roles, so they bind and hit the denial.

## Implementation
`broker/src/service.ts:2553-2565`, a pre-check inside `buildToolAdmissionOp` before `decide()`:

```ts
if (
  classifyAft(payload.tool as string) === "HOST_READ_STRUCTURED" &&
  (role === "planner" || role === "pm") &&
  record.state === "HOST_READ_ONLY"
) {
  return { …, decision: "allow", reason: "PRE_ACTIVATION_PLANNER_PM_AFT_READ_ALLOWED" };
}
```

Narrow by construction: AFT tools only, the two roles only after `normalizeRoleKey` (so `pm-odd` and `pm-systematic` normalize to `pm`), `HOST_READ_ONLY` only, and a distinct reason code so an audit can tell which rule admitted the call. Everything else falls through unchanged.

`broker/src/role-policy.ts:428-429` now carries a comment above the `planner` matrix entry stating that `HOST_READ_STRUCTURED` is unreachable there and that the pre-check is what admits AFT reads.

## Decisions
1. Scope is `planner` and `pm` (owner, 2026-11-02).
2. Pre-activation only, matching `researcher`/`general`; after activation reads must go through the sandbox.
3. AFT operations only, not the whole `HOST_READ_STRUCTURED` class. The broader denial of `metrics`, `listWorkers`, `reviewAssess`, `sddStatus` and the `host_*` reads for these roles is a separate question, not decided here.

## Acceptance criteria
- `planner` and `pm` in `HOST_READ_ONLY` are allowed `aft_outline`, `aft_zoom`, `aft_search`, `aft_callgraph`, `aft_inspect`. Met by test.
- Both are denied those five once the session is not `HOST_READ_ONLY`. Met by test.
- Both remain denied every non-AFT `HOST_READ_STRUCTURED` operation. Met by test.
- `aft_safety`, `aft_import`, `ast_grep_replace` remain denied. Met by test.
- Every other role's behaviour unchanged. Met by test.
- **Live**: a real planner session receives the allow. Not yet observed.

## Checks
- RED before implementation: `planner and pm receive pre-activation AFT read access only` failed with `ROLE_DENIED_FOR_AFT_READ`.
- GREEN after: focused 16 pass. With the pre-check temporarily reverted during the correction pass, 15 pass / 2 fail (canonical `pm` and the new `pm-odd` case); `service.ts` restored byte-identically at `sha256:064a3d24771f1cc351908847a5d7fa31c0d99d7d5899656f80a65768fc86caee`.
- Focused after the correction: 17 pass / 0 fail, 282 assertions.
- `bun --cwd broker test`: 1,596 pass / 10 skip / 1 fail, 6,808 assertions. The failure is the known `tests/v2-launch.test.ts:94` host-list mismatch (owner-side `platform.claude.com` in `nono/profile/opencode-v2-secure.json`), untouched.
- From `broker`: `bun build --target=bun src/main.ts` completed without error.

## Advisory review (2026-11-02, before the commit)
Two independent advisors, neither seeing the other's answer.

- **Security: no findings.** Verified the grant is exactly the five AFT reads for exactly those roles in exactly `HOST_READ_ONLY`; that authorization reads `record.agent`, not a request claim; that the admin AFT tools cannot satisfy the equality check; that plan writes do not move the session state; and that the read-only-orchestrator and `SECURITY_MUTATION` denials are not bypassed.
- **Security WARNING (pre-existing, not introduced):** `broker/src/server.ts:705-713` logs operation, result, agent, session and duration for successful requests but not the admission tool, decision or reason, so admission allows and denies both look like successful `toolAdmission` requests. The reason code is distinguishable in the response, not in the broker audit trail.
- **Correctness: two WARNINGs**, both the misleading matrix entries at `role-policy.ts:435` and `:448`, plus two SUGGESTIONs — no test for the `pm-odd` alias path, and none pinning `ast_grep_replace` as denied for these roles.
- **Resolution:** all three non-advisory gaps closed before the commit. The logging limitation is recorded here and not fixed in this unit.

## Route and trigger evidence
- Route: authorized change, ODD, delegated. Writer: `general` (orchestrator dispatch, sandbox worker).
- Task class: small feature with authorization effect — not a Tiny fix, because it changes an admission decision.
- S17: `broker/src/**` was written in the sandbox, installed through the reviewed host path, and committed by the owner (`0ac79d5`).

## Next step
Observe one real planner or pm session admitted for an AFT read with reason `PRE_ACTIVATION_PLANNER_PM_AFT_READ_ALLOWED`, then archive this tracker. If that observation cannot be produced, record why and archive on the test evidence with that gap named.


## Revisions
- r1 2026-11-02T22:53:04Z gentle-orchestrator: Create tracker for planner/pm AFT read admission
- r2 2026-11-04T09:16:54Z gentle-orchestrator: Record commit 0ac79d5, the advisory outcome and the live-state gap
- r3 2026-11-04T09:29:13Z gentle-orchestrator: No change to evidence; hold for the live planner observation
