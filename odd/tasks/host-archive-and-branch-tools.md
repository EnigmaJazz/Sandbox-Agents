# ODD task — host-archive-and-branch-tools

## Objective
Two host capabilities requested by the owner 2026-11-01 and scheduled together 2026-11-04:
- **A / U1** `host_plan_archive` (`planArchive`): archive one finished plan/tracker without an owner shell move.
- **B** `host_git_branch`: create/switch branches; retained as deferred r1 scope, NOT authorized by this U1 plan or its gates.

## Problem and observed evidence
- Sandbox plan-root protection requires a fixed host operation for archiving. This plan does not relax that protection.
- `authorizeHostDispatch` permits `planDocWrite` in the plan-writer branch only when the bound identity is a plan role or configured read-only identity. The new operation needs its own narrow entry in that same condition.
- `buildPlanDocWriteOp` uses target-specific agent allowlists, canonical approved-root resolution, protected-path checks, and a canonical absolute document lock. Its task list differs from its mini list.
- `commitPlanDocRevision` accepts one flat path, rejects archive paths, and returns commit errors without rolling back the write. It cannot implement the archive transaction unchanged.
- Raw operation classification and public tool admission are different names. `host_plan_write` is `HOST_APPROVED_MUTATION`; classifying the public archive tool as raw `MUTATE_PROJECT` would deny the intended read-only coordinators.

## Current unit and allowed edit surfaces
**U1 / task A only.** No B implementation or branch operation.

Implementation files: `broker/src/{types,validation,role-policy,service,server}.ts`, `opencode/plugins/lib/tool-specs-host-ops.ts`, `docs/config-manifest-host-tools.md`, new `broker/tests/plan-archive.test.ts`; in-scope extension authorized 2026-11-04: `broker/tests/fixtures/**`, `opencode/config-fragments/**`, `opencode/plugins-v2/config-fragments/**`, and the inventory/permission lists the failing tests name.

Out: `host_git_branch`, `host-tool-approval.ts`, configuration/deployment, unrelated cleanup, broadened shared commit/path helpers, permission-matrix changes, arbitrary argv, deleting trackers, modifying live host configuration. S17 applies; no agent self-certifies manual Gates 0–10.

## Owner-decided requirements — 2026-11-04
- Move `odd/<target>/<name>.md` to `odd/<target>/archive/<name>.md`; `target` exactly `tasks` or `mini`; payload fields exactly `projectDir`, `target`, `name`, `agent`, `note`.
- Commit message exactly `docs(odd): archive <target>/<name>`. No approval prompt.
- (a) only `planArchive` beside `planDocWrite` in the plan-role allowance; (b) target allowlists mirroring `planDocWrite`; (c) dedicated archive-local commit staging exactly both paths; (d) both canonical locks in deterministic sorted order; (e) restore source and index if the commit failed, `PLAN_ARCHIVE_ROLLBACK_FAILED` when restore fails.

## A2 — archive transaction (as built)
Refusal codes: `PLAN_ARCHIVE_AGENT_NOT_BOUND`, `PLAN_ARCHIVE_AGENT_MISMATCH`, `PLAN_ARCHIVE_AGENT_REFUSED`, `PLAN_ARCHIVE_TARGET_INVALID`, `PLAN_ARCHIVE_NOTE_INVALID`, `PLAN_ARCHIVE_SOURCE_MISSING`, `PLAN_ARCHIVE_DESTINATION_EXISTS`, `PLAN_ARCHIVE_PATH_ESCAPE`, `PLAN_ARCHIVE_PROTECTED_PATH`, `PLAN_ARCHIVE_NOT_REGULAR`, `PLAN_ARCHIVE_HARDLINK_REFUSED`, `PLAN_ARCHIVE_INDEX_DIRTY`, `PLAN_ARCHIVE_UNCERTAIN_STATE`, `PLAN_ARCHIVE_ROLLBACK_FAILED`. `lstat` existence checks, symlink protection first, no overwrite, bytes unchanged, both locks held through the transaction, index preflight scoped to the two paths, and commit arbitration that never reverse-renames a commit that landed.

## A3 — tests (as built)
`broker/tests/plan-archive.test.ts` covers tasks/mini success, refusal categories, bound-identity and allowlist failures, plugin forwarding, symlink and nonregular/hardlink sources, deterministic lock serialization, injected add/commit failures with rollback, the ambiguous-commit boundary, a status-zero commit timeout, a spawn rejection that must not roll back, and a timed-out diff comparison that must be uncertain. Recorded gap: no dirty-index/hardlink test; omitted to hold closed scope.

## Route and trigger evidence
ROUTE: substantial feature | intent: authorized change | route: ODD secure / PM dispatch and Planner gates | specialist: pm-odd → planner gates → odd-apply writer | basis: WORKFLOW.md.
- Owner decisions and refinements (a)–(e) 2026-11-04 drive this unit; no restart, no `general` writer.
- Skills: workflow-odd-secure, workflow-route; orchestrating-subagents where noted.
- Writers: `ses_e59d16dceffewMDWbYuhk6cglb` (initial), `ses_e5997ad54ffextKXFVlt9uTeEV` (fixtures/fragments), `ses_e590eb291ffenqJ3Xn1VrshuVh` (second pass, owner-authorized), `ses_e58e4d366ffe0MoQ35R0f4K6Mf` (third pass, owner-authorized), `ses_e57375755ffe7Ll40AahWnL2W5` (fourth pass, owner-authorized).
- Verifiers: `ses_e59768fdcffesJijI2oBNC3fll` (first, F1/F2 blockers), `ses_e58fbd90cffeel25WUqhhQ0Jq6` (scoped recheck), `ses_e5746daceffeX8heJWR14IvVaZ` (post-third-correction, partial with identity gap).
- Post-code advisor: `ses_e473…` cycle unavailable; the live raw advisor is `ses_e573e4e79ffeQUTCXm4dHDlQhi`, reproduced verbatim below.
- Static substitution (owner-directed): `aft_inspect` falls back to cached TypeScript 5.9.3 with no Node type environment; discharged by `bun build --target=bun src/main.ts` and the suite transpile.

## Log
- Gate 1 A/U1 PASS 2026-11-04T10:49:44Z (plan r2 `37126522…`).
- Anchor verified each round; loose ref authoritative, `packed-refs` stale.
- Installs: `51ed8727` (8 paths), `92fbb986` (6), `0e1a2955` (2, superseded), `c0e851e4` (2, third correction), `a5afb7e1` (2, fourth correction). An owner `git add` of `plan-archive.test.ts` was required before a later result could install over it.
- Third correction (`c0e851e4`, 75 lines): `runHostStep` forwards `timedOut`; the commit spawn is wrapped in `try/catch` reconciling committed → success with warning, uncertain → `PLAN_ARCHIVE_UNCERTAIN_STATE` without undoing the move, genuine pre-commit failure → rethrow with cause. Two tests added.
- Fourth correction (`a5afb7e1`, 43 lines): `reconcilePlanArchiveCommit` rejects on `head.timedOut` and returns `uncertain` on `diff.timedOut` before reading an exit status, so an incomplete `git diff --quiet` can never be read as `committed`. One test added with a recorded RED.
- Runner evidence after the fourth correction (`host_test_run broker-unit`): **1608 pass, 9 skip, 1 fail**, 6876 expects, 1618 tests, 94 files; sole failure `tests/v2-launch.test.ts:94` (`platform.claude.com`), the accepted baseline. Digest `sha256:eec3e6a36c632c3c41fe2326af520021ce56ca3840f00f43c8e53ec840d1d268`, `gitHead ed1e099`.
- Gate 2 status: not yet recorded. The Planner requires the advisor's RAW output to be readable by itself; the advisor session is not reachable through `ctx_search` and cannot be resumed by it, so the raw text is preserved in this document below.
- Hygiene: the commit carries exactly the 14 scoped paths; excluded unrelated dirty paths `.codegraph/`, `.windsurf/`, `odd/tasks/flow-probe.md`, `odd/tasks/host-git-tools.md`, `package.json`, `package-lock.json`.

## Raw post-code advice (verbatim, advisor-gemini-post `ses_e573e4e79ffeQUTCXm4dHDlQhi`)
> **1. F1 — Closed? Verdict: Closed.**
> - Flag forwarding and timeout coverage (observed): `runHostStep` (`broker/src/service.ts:2677`) now sets `timedOut: result.timedOut === true` on the returned `HostStepResult`. Every `step(...)` invocation in `buildPlanArchiveOp` (`broker/src/service.ts:4945-4946`) delegates to `runHostStep`. Both staging (`add.status !== 0 || add.timedOut` at line 4985) and committing (`commit.status !== 0 || commit.timedOut` at line 5012) now receive the populated boolean.
> - Status-zero path is genuinely reconciled (observed): At `broker/src/service.ts:5012-5022`, when `commit.status === 0` and `commit.timedOut === true`, execution enters the `if (commit.status !== 0 || commit.timedOut)` block. In the ternary `preHead !== "" || commit.timedOut || commit.status === null`, `commit.timedOut` is `true`, so `reconcilePlanArchiveCommit` is unconditionally invoked — even in an unborn-HEAD repository where `preHead === ""`. If the timed-out commit actually updated HEAD and matched both paths, lines 5023-5027 return `{ committed: true, commitWarning: ... }`; if `uncertain`, lines 5029-5033 throw `PlanArchiveUncertainError` (skipping rollback at line 5053); only if `not-committed` does line 5034 throw `planArchiveFailure("PLAN_ARCHIVE_COMMIT_FAILED", commit)` to trigger rollback.
> - Does the test prove the fix (observed/inferred): it intercepts `git commit` and returns `{ status: 0, stdout: "", stderr: "", timedOut: true }` without advancing HEAD, while all other git commands run against real git. It asserts `PLAN_ARCHIVE_COMMIT_FAILED: git step timed out`, file restoration, and clean status. Without `timedOut: result.timedOut === true` at line 2677, `commit.status !== 0 || commit.timedOut` at line 5012 would be `false`, bypassing reconciliation and returning `{ committed: true }` at line 5047. The test therefore directly proves the forwarding. It exercises the `not-committed` outcome of a status-0 timeout rather than the `committed` outcome.
>
> **2. F2 — Closed? Verdict: Closed.**
> - Can a rejected commit spawn reach the rollback path (observed): At `4988-5011` the commit step is wrapped in `try/catch (spawnError)`. Inside `catch`: it awaits `reconcilePlanArchiveCommit` (line 4994), which catches its own internal errors and never throws (`4879-4893`); if `committed` it returns early (4995-5000), bypassing the outer catch at 5052; if `uncertain` it throws `PlanArchiveUncertainError` (5001-5005) and the outer catch at 5053 rethrows for that class before `rollbackPlanArchiveMove` (5054); only `not-committed` throws `StateError("PLAN_ARCHIVE_COMMIT_FAILED: commit spawn failed: ...")` (5006-5010), which reaches the outer catch and rolls back.
> - Can uncertain mask a genuine rollback failure (observed): No. `PlanArchiveUncertainError` is thrown only at 5002 and 5030, strictly before the outer catch, and 5053 exits immediately for that class. Rollback is never attempted when `reconciled === "uncertain"`, and a rollback failure throws `StateError("PLAN_ARCHIVE_ROLLBACK_FAILED: ...")` at 5059, never the uncertain class.
>
> **3. New defects — No new defects, with one edge-case observation on unborn HEAD.**
> - Double reconciliation: none. Every branch of `catch (spawnError)` (4990-5011) either returns (4996) or throws (5002, 5010); execution never falls through to 5012.
> - Swallowing a real pre-commit failure into `committed`: no. `reconcilePlanArchiveCommit` (4882-4888) returns `committed` only if `rev-parse HEAD` exits 0 with a 40-hex SHA, `id !== preHead`, and `git diff --quiet HEAD -- <source> <destination>` exits 0. Because both locks are held (4942-4943) and the index was verified clean before moving (4966), a pre-commit failure that did not create the commit leaves `id === preHead`, or on an unborn branch returns `uncertain`. If the pre-operation `rev-parse HEAD` at 4967 failed transiently and `preHead` became `""`, a later failed commit still reconciles to `not-committed` because the staged rename differs from HEAD.
> - Document locks on thrown paths: released. `withPlanDocLock(firstKey, () => withPlanDocLock(secondKey, async () => { ... }))` (4943) wraps the whole callback; nothing in the diff bypasses it.
>
> **4. Flagged observation — `service.ts:4882-4887` (reconciliation lookups ignoring `timedOut`). Verdict: material follow-up, non-blocking for F1/F2 in practice, but a real correctness gap if the runner returns `status: 0, timedOut: true` on lookup commands.**
> - `git rev-parse HEAD` (4882): a timeout after flushing the SHA leaves it valid; a timeout before flushing fails the regex and returns `uncertain`.
> - `git diff --quiet` (4886) reports only through its exit status, so if the runner reports `status: 0, timedOut: true` on a killed child that had not finished comparing trees, line 4887 (`if (diff.status === 0) return "committed"`) would misclassify an incomplete diff as `committed` instead of `uncertain`.
> - `preHeadResult` (4967-4968) and the post-commit `head` (5041) also do not check `timedOut`, though both are guarded by 40-hex checks or diff checks.
> - Recommendation: check `head.timedOut` at 4884 and `diff.timedOut` at 4887 — a 2-line hardening inside the same function.
>
> **Advisor key learnings (verbatim):** (1) When a process runner can report `timedOut: true` alongside `status: 0`, every status-based success check — including read-only reconciliation steps like `git diff --quiet` whose output is solely exit code `0` — must check `!result.timedOut` before trusting `status === 0`. (2) Catching a spawn rejection around `git commit` must route through the same HEAD and tree-diff reconciliation as a nonzero commit exit before any filesystem rollback is permitted. (3) Returning a distinct `PlanArchiveUncertainError` when reconciliation itself fails prevents the outer rollback handler from undoing a filesystem move whose git commit may have already landed.

Note for the gate: the advisor reviewed the third correction; the fourth correction implements exactly its recommendation in item 4 and touches only `reconcilePlanArchiveCommit`'s two lookup guards, with one added test. F1/F2 closures are unaffected.

## Review-size-exception
> A host operation is atomic: operation registration, authorization branch, payload validation, classification, server dispatch, plugin tool definition, fragment rules and tests are one behaviour. Splitting would commit a registered operation with no surface, or a surface with no authorization — a security-relevant half state this repository has already had to correct once. Tests cannot be separated from the behaviour under this recipe, so the indivisible-change exception applies.
- authored_lines: 576 (360 tracked + 216 test) + 103 (second pass) + 75 (third) + 43 (fourth)
- authored_patch_bytes: 35553 + ~6.6 KB + ~3.6 KB
- generated_or_binary_paths: none

## Next step
Record Gate 2 against the fourth correction using the raw advisor text preserved above. On PASS, the owner commits exactly the 14 scoped paths and I run the post-commit native assessment and review. No tick before that.


## Revisions
- r1 2026-11-04T09:58:46Z gentle-orchestrator: Create tracker for the archive and branch host tools
- r2 2026-11-04T10:49:21Z planner: Finalize U1/A with owner decisions, PM suggestions, and raw security/specification advice
- r3 2026-11-04T14:54:49Z gentle-orchestrator: Record second pass, the F1/F2 recheck, and Gate 2 ESCALATE
- r4 2026-11-04T23:16:36Z gentle-orchestrator: Preserve the raw post-code advice durably and record the fourth correction

## Gates
- A PASS 2026-11-04T10:49:44Z planner ref=Gate1 U1/A: plan r2 commit 37126522fad90914139c47de268266b3fc250e6d; raw pre-advice ses_e59d6df63ffefVSSWDU312fsQy; code evidence ses_e59e0db49ffe0pgljjH1TaT0uY
- A ESCALATE 2026-11-04T14:53:16Z planner ref=Gate2: service.ts:2647,2673-2680 drops timedOut; 4983-4995 bypasses timeout handling. Raw recheck ses_e58fbd90cffeel25WUqhhQ0Jq6. Third correction requires human authorization.
