# ODD task — planner-pm-aft-read

## Objective
Give the `planner` and `pm` roles the same pre-activation AFT read access that `researcher` and `general` already have, without widening any other structured host read.

## Problem — verified in source
All five AFT read tools classify as `HOST_READ_STRUCTURED` (`broker/src/role-policy.ts:212-213`: `aft_outline`, `aft_zoom`, `aft_search`, `aft_callgraph`, `aft_inspect`).

`decide()` short-circuits that whole capability before the role matrix is consulted (`broker/src/role-policy.ts:500-509`):

```ts
if (capability === "HOST_READ_STRUCTURED") {
  if (role === "researcher" || role === "general") { …pre-activation allow… }
  return { decision: "deny", reasonCode: "ROLE_DENIED_FOR_AFT_READ" };
}
```

The role matrix is only read at `:511`. So `planner: { HOST_READ_STRUCTURED: true }` (`:435`) and the same entry for `pm` (`:448`) are **unreachable**. Reading the matrix suggests both roles already have the capability; they do not.

How explore agents get AFT today, for contrast: an agent is bindable only if it is in `readOnlyAgents` or normalizes to a role (`broker/src/service.ts:251`). A subagent with a name that is neither stays unbound, and an unbound session is allowed `HOST_READ_STRUCTURED` while in `HOST_READ_ONLY` (`broker/src/service.ts:2547-2550`, `UNBOUND_SESSION_READ_ONLY_CLASS`). Named explore agents therefore work through the unbound path, not the matrix. `planner` and `pm` are roles, so they bind, and then hit the denial.

## Scope
In: `broker/src/role-policy.ts` (or a narrow pre-check in `broker/src/service.ts` `buildToolAdmissionOp`), and the matching tests.

Out: the `HOST_READ_STRUCTURED` denial for every other role; `HOST_ADMIN_STRUCTURED`; the role matrix itself except where a test asserts the reachability fix; any change to agent naming, binding, or `readOnlyAgents`.

## Decisions
1. **Scope is planner and pm** (owner, 2026-11-02).
2. **Pre-activation only**, matching `researcher` and `general`. After a worker is active, reads must go through the sandbox so the host tree cannot be inspected around the confinement. Neither role activates a worker, so this costs them nothing.
3. **Grant only AFT operations**, not the whole `HOST_READ_STRUCTURED` class. The existing branch denies the entire class for non-`researcher`/`general` roles, which also blocks `metrics`, `listWorkers`, `reviewAssess`, `sddStatus` and the host reads for planner and pm. That is a separate, broader question; this unit does not decide it. Use `classifyAft` (`:229-233`) as the discriminator so the grant is exactly the five AFT read tools plus nothing else.
4. Preferred implementation, because `decide()` receives no operation name: a narrow pre-check in `buildToolAdmissionOp` before `decide` — if the tool is an AFT read, the bound role normalizes to `planner` or `pm`, and the session state is `HOST_READ_ONLY`, allow with a named reason code. A writer may instead thread the operation into `AuthorizationContext` if that is cleaner, but must not widen any other capability in the process.
5. A new reason code is required rather than reusing `PRE_ACTIVATION_AFT_READ_ALLOWED`, so an audit can tell which rule admitted the call.

## Constraints
- `broker/src/**` is S17: the writer works in the sandbox, the result installs through the reviewed host path, the owner commits.
- Fail closed. Any unrecognized role, capability, state or tool name keeps the existing denial.
- Do not change `AFF`/AFT classification itself, and do not reclassify `aft_safety` or `aft_import` (they are `HOST_ADMIN_STRUCTURED` and stay denied for every role, `:490-492`).

## Stable task IDs
- **T1** — the admission change for `planner` and `pm` AFT reads, pre-activation only, with a distinct reason code.
- **T2** — tests: planner allowed, pm allowed, pre-activation; the same two roles denied after activation; `worker`/`advisor`/`judge`/`fresh_eyes` still denied; a non-AFT `HOST_READ_STRUCTURED` operation still denied for planner and pm; `aft_safety`/`aft_import` still denied.
- **T3** — checks and the reviewability receipt.

## Acceptance criteria
- A `planner` session in `HOST_READ_ONLY` is allowed `aft_outline`, `aft_zoom`, `aft_search`, `aft_callgraph`, `aft_inspect`.
- A `pm` session in `HOST_READ_ONLY` is allowed the same five.
- Both are denied the same five once the session is not `HOST_READ_ONLY`.
- `planner` and `pm` remain denied every non-AFT `HOST_READ_STRUCTURED` operation (unchanged by this unit).
- Every other role's behaviour is unchanged, test-pinned.
- The suite is green apart from the known `tests/v2-launch.test.ts:94` failure recorded in the project constraints.

## Checks
- `bun --cwd broker test` — record exact totals.
- From `broker`: `bun build --target=bun src/main.ts`.
- Test-first: the new cases must fail before the change and pass after; record both observations.

## Route and trigger evidence
- Route: authorized change, ODD, delegated. Writer: `general` (orchestrator dispatch, sandbox writer).
- Task class: small feature with authorization effect — not a Tiny fix, because it changes an admission decision.
- Advisory review owed after the change: this is an authorization gate.

## Next step
Dispatch the writer with T1–T3, test-first.


## Revisions
- r1 2026-11-02T22:53:04Z gentle-orchestrator: Create tracker for planner/pm AFT read admission
