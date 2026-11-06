# ODD task — host-archive-and-branch-tools

**U1 / task A: COMPLETE — committed as `5372467` (2026-11-06).** Gate 2 PASS pre-commit `a5afb7e1`. Branch B (`host_git_branch`) is deferred and unauthorized.

## Objective
Two host capabilities requested by the owner 2026-11-01:
- **A / U1** `host_plan_archive` (`planArchive`): archive one finished plan/tracker without an owner shell move. **Delivered.**
- **B** `host_git_branch`: create/switch branches; retained as deferred r1 scope, NOT authorized by this U1 plan or its gates.

## Problem and observed evidence
- Sandbox plan-root protection requires a fixed host operation for archiving. This plan does not relax that protection.
- `authorizeHostDispatch` permits `planDocWrite` in the plan-writer branch only when the bound identity is a plan role or configured read-only identity. The new operation needed its own narrow entry in that same condition.
- `buildPlanDocWriteOp` uses target-specific agent allowlists, canonical approved-root resolution, protected-path checks, and a canonical absolute document lock.
- `commitPlanDocRevision` accepts one flat path, rejects archive paths, and returns commit errors without rolling back the write; it could not implement the archive transaction unchanged.
- Raw operation classification and public tool admission are different names; classifying the public archive tool as raw `MUTATE_PROJECT` would have denied the intended read-only coordinators.

## Delivered surface
Implementation: `broker/src/{types,validation,role-policy,service,server}.ts`, `opencode/plugins/lib/tool-specs-host-ops.ts`, `docs/config-manifest-host-tools.md`, `broker/tests/plan-archive.test.ts`, plus the in-scope inventory/fixture/fragment updates (`broker/tests/fixtures/**`, `broker/tests/{sandbox-tools-call-sweep,sandbox-tools-surface,v2-config-fragments}.test.ts`, `opencode/config-fragments/sandbox-permissions.jsonc`, `opencode/plugins-v2/config-fragments/sandbox-permissions.jsonc`).

## A2 — archive transaction (as built)
Refusal codes: `PLAN_ARCHIVE_AGENT_NOT_BOUND`, `PLAN_ARCHIVE_AGENT_MISMATCH`, `PLAN_ARCHIVE_AGENT_REFUSED`, `PLAN_ARCHIVE_TARGET_INVALID`, `PLAN_ARCHIVE_NOTE_INVALID`, `PLAN_ARCHIVE_SOURCE_MISSING`, `PLAN_ARCHIVE_DESTINATION_EXISTS`, `PLAN_ARCHIVE_PATH_ESCAPE`, `PLAN_ARCHIVE_PROTECTED_PATH`, `PLAN_ARCHIVE_NOT_REGULAR`, `PLAN_ARCHIVE_HARDLINK_REFUSED`, `PLAN_ARCHIVE_INDEX_DIRTY`, `PLAN_ARCHIVE_UNCERTAIN_STATE`, `PLAN_ARCHIVE_ROLLBACK_FAILED`.

Behaviour: `lstat` existence checks, symlink protection first, no overwrite, bytes unchanged, both canonical locks held in sorted order through the transaction, index preflight scoped to the two participating paths, staging exactly `git add -A -- <source> <dest>`, and commit arbitration that never reverse-renames a commit that landed. Timeouts and spawn rejections reconcile against the pre-operation HEAD; unresolvable outcomes fail closed as `PLAN_ARCHIVE_UNCERTAIN_STATE` without undoing the move.

## A3 — tests (as built)
`broker/tests/plan-archive.test.ts` covers tasks/mini success, every refusal category, bound-identity and allowlist failures, plugin forwarding, symlink and nonregular/hardlink sources, deterministic lock serialization, injected add/commit failures with rollback, the ambiguous-commit boundary, a status-zero commit timeout, a spawn rejection that must not roll back, and a timed-out diff comparison that must be uncertain. Recorded gap: no dirty-index/hardlink test; omitted to hold closed correction scope.

## Route and trigger evidence
ROUTE: substantial feature | intent: authorized change | route: ODD secure / PM dispatch and Planner gates | specialist: pm-odd → planner gates → odd-apply writer | basis: WORKFLOW.md.
- Writers: `ses_e59d16dceffewMDWbYuhk6cglb` (initial), `ses_e5997ad54ffextKXFVlt9uTeEV` (fixtures/fragments), `ses_e590eb291ffenqJ3Xn1VrshuVh` (second pass), `ses_e58e4d366ffe0MoQ35R0f4K6Mf` (third pass), `ses_e57375755ffe7Ll40AahWnL2W5` (fourth pass); corrections 2–4 were each owner-authorized after a gate or advisor finding.
- Verifiers: `ses_e59768fdcffesJijI2oBNC3fll`, `ses_e58fbd90cffeel25WUqhhQ0Jq6`, `ses_e5746daceffeX8heJWR14IvVaZ`.
- Post-code advisor: `ses_e573e4e79ffeQUTCXm4dHDlQhi` (raw preserved below; the earlier session was unreachable).
- Static substitution (owner-directed): `aft_inspect` falls back to a cached TypeScript with no Node type environment; discharged by `bun build --target=bun src/main.ts` and the suite transpile.

## Log
- Gate 1 A/U1 PASS 2026-11-04T10:49:44Z (plan r2 `37126522…`).
- Installs: `51ed8727` (8 paths), `92fbb986` (6), `0e1a2955` (2, superseded), `c0e851e4` (2, third correction), `a5afb7e1` (2, fourth correction). An owner `git add` of `plan-archive.test.ts` was required before a later result could install over it.
- Third correction (75 lines): `runHostStep` forwards `timedOut`; commit spawn wrapped in `try/catch` reconciling committed → success with warning, uncertain → `PLAN_ARCHIVE_UNCERTAIN_STATE` without undoing the move, genuine pre-commit failure → rethrow with cause.
- Fourth correction (43 lines): `reconcilePlanArchiveCommit` rejects on `head.timedOut` and returns `uncertain` on `diff.timedOut` before reading an exit status, so an incomplete `git diff --quiet` can never be read as `committed`.
- Runner evidence before commit (`host_test_run broker-unit`): 1608 pass, 9 skip, 1 fail (6876 expects, 1618 tests, 94 files); sole failure `tests/v2-launch.test.ts:94` (`platform.claude.com`), accepted baseline. Digest `sha256:eec3e6a3…`, `gitHead ed1e099`.
- Gate 2 A/U1 PASS 2026-11-04T23:22:06Z planner `ses_e572257adffe5VixYx3jjwPKIh` ref=Gate2 pre-commit `a5afb7e1`; raw advice read directly from this document by the Planner.
- Owner commit `5372467b74bfea861a57c4e4495f040bc87320de` (2026-11-06), exactly the 14 scoped paths.
- Post-commit native assessment (`baseRef aee56e0`, committed-only, untracked excluded): **medium**, 67 paths / 6599 lines, `review_due: false` (`under_budget`) — the slice accumulates and the provider will call it at budget. Reason recorded: `executable_change` `broker/src/orca.ts` from an earlier unit in the same slice.
- Gate tool records the technical verdict only; it does not certify manual acceptance Gates 0–10.

## Raw post-code advice (verbatim, advisor-gemini-post `ses_e573e4e79ffeQUTCXm4dHDlQhi`)
> **1. F1 — Closed? Verdict: Closed.**
> - Flag forwarding and timeout coverage (observed): `runHostStep` (`broker/src/service.ts:2677`) now sets `timedOut: result.timedOut === true` on the returned `HostStepResult`. Every `step(...)` invocation in `buildPlanArchiveOp` (`broker/src/service.ts:4945-4946`) delegates to `runHostStep`. Both staging (`add.status !== 0 || add.timedOut` at line 4985) and committing (`commit.status !== 0 || commit.timedOut` at line 5012) now receive the populated boolean.
> - Status-zero path is genuinely reconciled (observed): At `broker/src/service.ts:5012-5022`, when `commit.status === 0` and `commit.timedOut === true`, execution enters the `if (commit.status !== 0 || commit.timedOut)` block. In the ternary `preHead !== "" || commit.timedOut || commit.status === null`, `commit.timedOut` is `true`, so `reconcilePlanArchiveCommit` is unconditionally invoked — even in an unborn-HEAD repository where `preHead === ""`. If the timed-out commit actually updated HEAD and matched both paths, lines 5023-5027 return `{ committed: true, commitWarning: ... }`; if `uncertain`, lines 5029-5033 throw `PlanArchiveUncertainError` (skipping rollback at line 5053); only if `not-committed` does line 5034 throw `planArchiveFailure("PLAN_ARCHIVE_COMMIT_FAILED", commit)` to trigger rollback.
> - Does the test prove the fix (observed/inferred): it intercepts `git commit` and returns `{ status: 0, stdout: "", stderr: "", timedOut: true }` without advancing HEAD, while all other git commands run against real git. It asserts `PLAN_ARCHIVE_COMMIT_FAILED: git step timed out`, file restoration, and clean status. Without `timedOut: result.timedOut === true` at line 2677, `commit.status !== 0 || commit.timedOut` at line 5012 would be `false`, bypassing reconciliation and returning `{ committed: true }` at line 5047. The test therefore directly proves the forwarding.
>
> **2. F2 — Closed? Verdict: Closed.**
> - Can a rejected commit spawn reach the rollback path (observed): At `4988-5011` the commit step is wrapped in `try/catch (spawnError)`. Inside `catch`: it awaits `reconcilePlanArchiveCommit` (line 4994), which catches its own internal errors and never throws (`4879-4893`); if `committed` it returns early (4995-5000), bypassing the outer catch at 5052; if `uncertain` it throws `PlanArchiveUncertainError` (5001-5005) and the outer catch at 5053 rethrows for that class before `rollbackPlanArchiveMove` (5054); only `not-committed` throws `StateError("PLAN_ARCHIVE_COMMIT_FAILED: commit spawn failed: ...")` (5006-5010), which reaches the outer catch and rolls back.
> - Can uncertain mask a genuine rollback failure (observed): No. `PlanArchiveUncertainError` is thrown only at 5002 and 5030, strictly before the outer catch, and 5053 exits immediately for that class. Rollback is never attempted when `reconciled === "uncertain"`, and a rollback failure throws `StateError("PLAN_ARCHIVE_ROLLBACK_FAILED: ...")` at 5059.
>
> **3. New defects — No new defects.**
> - Double reconciliation: none. Every branch of `catch (spawnError)` (4990-5011) either returns (4996) or throws (5002, 5010); execution never falls through to 5012.
> - Swallowing a real pre-commit failure into `committed`: no. `reconcilePlanArchiveCommit` returns `committed` only if `rev-parse HEAD` exits 0 with a 40-hex SHA, `id !== preHead`, and `git diff --quiet` exits 0; with both locks held and a clean index before moving, a failed commit leaves `id === preHead` or returns `uncertain`.
> - Document locks on thrown paths: released by `withPlanDocLock` nesting; nothing bypasses it.
>
> **4. Flagged observation — `service.ts:4882-4887` (reconciliation lookups ignoring `timedOut`). Verdict: material follow-up.**
> - `git diff --quiet` reports only through its exit status, so a runner reporting `status: 0, timedOut: true` on an unfinished comparison would make line 4887 return `committed` instead of `uncertain`.
> - Recommendation: check `head.timedOut` at 4884 and `diff.timedOut` at 4887 — a 2-line hardening inside the same function. **Implemented as the fourth correction, with a regression test.**
>
> **Advisor key learnings (verbatim):** (1) When a process runner can report `timedOut: true` alongside `status: 0`, every status-based success check — including read-only steps whose output is solely exit code `0` — must check `!result.timedOut` before trusting `status === 0`. (2) Catching a spawn rejection around `git commit` must route through the same HEAD and tree-diff reconciliation as a nonzero commit exit before any filesystem rollback is permitted. (3) Returning a distinct `PlanArchiveUncertainError` when reconciliation itself fails prevents the outer rollback handler from undoing a filesystem move whose git commit may have already landed.

## Review-size-exception
> A host operation is atomic: operation registration, authorization branch, payload validation, classification, server dispatch, plugin tool definition, fragment rules and tests are one behaviour. Splitting would commit a registered operation with no surface, or a surface with no authorization — a security-relevant half state this repository has already had to correct once. Tests cannot be separated from the behaviour under this recipe, so the indivisible-change exception applies.
- authored_lines: 576 (360 tracked + 216 test) + 103 (second pass) + 75 (third) + 43 (fourth)
- authored_patch_bytes: 35553 + ~6.6 KB + ~3.6 KB
- generated_or_binary_paths: none

## Lessons carried out of this unit
1. A declared-but-never-populated status field is invisible to a green suite: the tests passed through a different predicate than the one being fixed.
2. Any check whose only signal is an exit status must also consult its timeout flag, or an unfinished command reads as success.
3. A correction ceiling keeps verification honest but converts real defects into human-authorization stops; that trade must be stated to the owner, not absorbed silently.
4. Advisor raw output was unreachable by the Planner and had to be preserved in this document before Gate 2 could pass — durable raw artifacts, not session memory, are the gate's readable evidence.
5. New files created by an installed sandbox result must be owner-staged before a later result can install over them.

## Next step
Unit A/U1 is closed and committed. Native review is not yet due (medium, `under_budget`); the accumulated slice will call it at budget. Branch unit B (`host_git_branch`) remains unauthorized and requires its own plan, advice and gates before any implementation.


## Revisions
- r1 2026-11-04T09:58:46Z gentle-orchestrator: Create tracker for the archive and branch host tools
- r2 2026-11-04T10:49:21Z planner: Finalize U1/A with owner decisions, PM suggestions, and raw security/specification advice
- r3 2026-11-04T14:54:49Z gentle-orchestrator: Record second pass, the F1/F2 recheck, and Gate 2 ESCALATE
- r4 2026-11-04T23:16:36Z gentle-orchestrator: Preserve the raw post-code advice durably and record the fourth correction
- r5 2026-11-06T16:04:22Z gentle-orchestrator: Record Gate 2 PASS, the owner commit 5372467, the post-commit assessment, and unit closure

## Gates
- A PASS 2026-11-04T10:49:44Z planner ref=Gate1 U1/A: plan r2 commit 37126522fad90914139c47de268266b3fc250e6d; raw pre-advice ses_e59d6df63ffefVSSWDU312fsQy; code evidence ses_e59e0db49ffe0pgljjH1TaT0uY
- A ESCALATE 2026-11-04T14:53:16Z planner ref=Gate2: service.ts:2647,2673-2680 drops timedOut; 4983-4995 bypasses timeout handling. Raw recheck ses_e58fbd90cffeel25WUqhhQ0Jq6. Third correction requires human authorization.
- A PASS 2026-11-04T23:22:06Z planner ref=Gate2 U1/A pre-commit a5afb7e1; raw advice items 1-4 tracker:52-75; service.ts:2678,4884-4891,4991-5057; plan-archive.test.ts:255-291; runner tracker:48; scope 14 paths only.
