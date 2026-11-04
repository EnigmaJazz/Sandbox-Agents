# ODD task — host-archive-and-branch-tools

## Objective
Two host capabilities requested by the owner 2026-11-01 and scheduled together 2026-11-04:
- **A / U1** `host_plan_archive` (`planArchive`): archive one finished plan/tracker without an owner shell move.
- **B** `host_git_branch`: create/switch branches; retained as deferred r1 scope, NOT authorized by this U1 plan or its gates.

## Problem and observed evidence
- Observed in the existing tracker r1: sandbox plan-root protection requires a fixed host operation for archiving. This plan does not relax that protection.
- Observed: `broker/src/service.ts` `authorizeHostDispatch` permits `planDocWrite` in the plan-writer branch only when the bound identity is a plan role or configured read-only identity (lines 202–225). The new operation needs its own narrow entry in that same condition.
- Observed: `buildPlanDocWriteOp` uses target-specific agent allowlists, canonical approved-root resolution, protected-path checks, and a canonical absolute document lock (lines 4661–4739). Its task list differs from its mini list.
- Observed: `commitPlanDocRevision` accepts one flat path, rejects archive paths, and returns commit errors without rolling back the write (lines 4384–4488). It cannot implement the archive transaction unchanged.
- Observed: raw operation classification and public tool admission are different names. `host_plan_write` is `HOST_APPROVED_MUTATION`; `classifyOperation` looks up the supplied string, and tool admission classifies the public tool name (`broker/src/role-policy.ts:110–223`, `broker/src/service.ts:2524–2581`). Inferred: classifying the public archive tool as raw `MUTATE_PROJECT` would deny the intended read-only coordinators; a public fixed-host entry is needed without altering role permissions.

## Current unit and allowed edit surfaces
**U1 / task A only:** A1–A3 plus archive-only C1/C2. Gate-log taskId: `A`; U1 identifies this work unit. No B implementation or branch operation.

Implementation files:
- `broker/src/types.ts`
- `broker/src/validation.ts`
- `broker/src/role-policy.ts`
- `broker/src/service.ts`
- `broker/src/server.ts`
- `opencode/plugins/lib/tool-specs-host-ops.ts`
- `docs/config-manifest-host-tools.md`
- New `broker/tests/plan-archive.test.ts`
- `broker/tests/plan-doc-commit.test.ts` and `broker/tests/session-agent-binding.test.ts` only for directly related archive integration assertions/fixture reuse.
- In-scope extension authorized 2026-11-04: `broker/tests/fixtures/**`, `opencode/config-fragments/**`, `opencode/plugins-v2/config-fragments/**`, and the inventory/permission lists the failing tests name.

Sanctioned tracker metadata surface: this document, only through the approved host plan route. The writer brief must identify the correction from `general` to `pm-odd → planner gates → odd-apply writer`; it must not ask the sandbox writer to bypass plan-root protection. No task completion ticks before Gate 2.

Out: `host_git_branch`, `host-tool-approval.ts` changes, configuration/deployment, unrelated cleanup, broadened shared commit/path helpers, permission-matrix changes, arbitrary argv, deleting trackers, or modifying live host configuration. S17 applies to broker/plugin artifacts; no agent self-certifies manual Gates 0–10.

## Owner-decided requirements — 2026-11-04
- Move `odd/<target>/<name>.md` to `odd/<target>/archive/<name>.md`; `target` is exactly `tasks` or `mini`; payload fields are exactly `projectDir`, `target`, `name`, `agent`, `note`.
- Validate name with existing `assertPlanDocWriteName`. Resolve the exact approved canonical project root, check containment and protected paths for BOTH paths, and use the plan-document lock mechanism.
- Commit message exactly `docs(odd): archive <target>/<name>`. No approval prompt; the fixed act and its commit record are the compensating control.
- (a) Add only `planArchive` beside `planDocWrite` in the plan-role allowance.
- (b) `tasks` uses `planWriterAgents`; `mini` uses the deduplicated union of `planWriterAgents`, `planMiniWriterAgents`, and `readOnlyAgents`. Payload agent must equal the bound session identity.
- (c) Dedicated archive-local commit logic stages exactly both paths with argv-vector `git add -A -- <source> <dest>`, then the existing commit invocation shape with both explicit paths.
- (d) Acquire both canonical document locks in deterministic sorted order, keep both through the transaction, release in reverse order.
- (e) If the move succeeds but commit fails, restore the source and index and rethrow the original error. If move-back fails, throw `PLAN_ARCHIVE_ROLLBACK_FAILED` naming both relative paths.

## A2 — archive transaction (as built)
- Explicit archive refusal codes: `PLAN_ARCHIVE_AGENT_NOT_BOUND`, `PLAN_ARCHIVE_AGENT_MISMATCH`, `PLAN_ARCHIVE_AGENT_REFUSED`, `PLAN_ARCHIVE_TARGET_INVALID`, `PLAN_ARCHIVE_NOTE_INVALID`, `PLAN_ARCHIVE_SOURCE_MISSING`, `PLAN_ARCHIVE_DESTINATION_EXISTS`, `PLAN_ARCHIVE_PATH_ESCAPE`, `PLAN_ARCHIVE_PROTECTED_PATH`, `PLAN_ARCHIVE_NOT_REGULAR`, `PLAN_ARCHIVE_HARDLINK_REFUSED`, `PLAN_ARCHIVE_INDEX_DIRTY`, `PLAN_ARCHIVE_UNCERTAIN_STATE`, `PLAN_ARCHIVE_ROLLBACK_FAILED`.
- Name validation reuses the existing helper and therefore `PLAN_WRITE_NAME_INVALID`.
- `lstat`-based existence checks, ancestor/leaf symlink protection first, no overwrite, bytes moved unchanged.
- Both locks held through revalidation, rename, staging, commit and rollback.
- Index preflight scoped to the two paths refuses `PLAN_ARCHIVE_INDEX_DIRTY` for preexisting staged/conflicted entries on either, while permitting unrelated staged files.
- Commit arbitration: reconcile against `preHead`, `timedOut` and `status === null`; a committed result is never reverse-renamed; uncertain outcomes fail closed with `PLAN_ARCHIVE_UNCERTAIN_STATE`.

## A3 — tests (as built)
`broker/tests/plan-archive.test.ts` covers tasks/mini success, the refusal categories, bound-identity and allowlist failures, plugin forwarding, symlink and nonregular/hardlink sources, deterministic lock serialization, injected add/commit failures with rollback, and the ambiguous-commit reconciliation boundary. Deliberately not covered, recorded as a gap: a dirty-index/hardlink test, omitted to hold the closed scope of the second correction.

## Route and trigger evidence
ROUTE: substantial feature | intent: authorized change | route: ODD secure / PM dispatch and Planner gates | specialist: pm-odd → planner gates → odd-apply writer | basis: WORKFLOW.md.
- Owner continue + refinements (a)–(e) 2026-11-04; no restart, no `general` writer.
- Observed skills: workflow-odd-secure, workflow-route; orchestrating-subagents where noted. ODD/fixed-plan controls override generic suggestions.
- Preparation: tracker r1, CodeGraph impact, direct navigation, one explore + approved advisor-gemini-pre RAW ses_e59d6df63ffefVSSWDU312fsQy; Planner no mutation/execution/writer/lens.
- Scope: authorization + host-mutation contract (planArchive beside planDocWrite, raw MUTATE_PROJECT vs public HOST_APPROVED_MUTATION, two-path move/commit/rollback, sorted dual locks); substantive, not tiny.
- Writers: initial ses_e59d16dceffewMDWbYuhk6cglb + refinement ses_e5997ad54ffextKXFVlt9uTeEV (fixtures/fragments on 51ed8727… → 92fbb986…) + owner-authorized second pass ses_e590eb291ffenqJ3Xn1VrshuVh (F1/F2 + injections on 92fbb986… → 0e1a2955…). Ceiling exceeded; further pass needs fresh auth.
- Verifier: gentle-ai-verify ses_e59768fdcffesJijI2oBNC3fll (REFINE: F1/F2 blockers) + scoped recheck ses_e58fbd90cffeel25WUqhhQ0Jq6 (REFINE scoped: F1 incomplete, F2 not universal; tests/boundaries pass; RED unverified).
- Post advisor: advisor-gemini-post ses_e59688202ffer8DjRDz8hh7njW (atomicity NO under timeout/spawn-exception; staging/auth NO bypass; F1/F2 confirmed blockers, F3 reject, F4 follow-up; 6 out-of-scope paths excluded). No second advisor cycle on PM authority.
- Assessment forecast: high/unassessable (dirty tree); post-commit review WILL be due. Not a Gate 2 blocker.
- Static substitution (owner-directed): aft_inspect falls back to cached TypeScript 5.9.3 with no Node type environment (phantom Cannot-find-module/Buffer/NodeJS across untouched files) → discharged by `bun build --target=bun src/main.ts` + `bun test` transpile. Not a type-correctness proof.

## Log
- Gate 1 A/U1 PASS 2026-11-04T10:49:44Z planner ref=Gate1 (plan r2 37126522…; pre-advice ses_e59d6df…; evidence ses_e59e0db…).
- Anchor verified: tracker 148 lines, last line Gate 1 PASS, loose ref refactor/p0-shared-tool-table 5b143b35… (packed 9550277… stale).
- Installs: 51ed8727… (8 paths) + 92fbb986… (6 paths) + 0e1a2955… (service.ts + plan-archive.test.ts). New-file note: an owner `git add` of `plan-archive.test.ts` was required before the second correction could install — the file was created by the first result and was untracked, so the broker refused with a baseline divergence.
- RED/GREEN second pass: RED 6 pass/2 fail/41 expects (143 → COMMIT_FAILED; EAGAIN → not UNCERTAIN) → GREEN 8 pass/50 expects; full 1604 pass/10 skip/1 fail (v2-launch:94 platform.claude.com only)/6860 expects/1615 tests/94 files; build exit 0. Receipt 103 authored lines, ~6.6 KB.
- Recheck: F1 incomplete — `timedOut` declared at 2647 but `runHostStep`'s return (2673–2680) omits it, so a status-zero timeout never reaches reconciliation; the passing tests use 143/null and succeed through other predicates. F2 present but not universal — the try/catch at 4878–4892 yields uncertain, yet a commit-spawn rejection at 4986 bypasses reconcile and rolls back; lookup `timedOut` uninspected. Unborn-HEAD case not executed.
- Gate 2 ESCALATE 2026-11-04 planner ses_e58f5ca25ffeSIg5uw2kn0OACD (tracker record 196b65a8…): a true blocker remains (timedOut forwarding); a THIRD correction requires explicit human authorization; commit and completion held. No advisor re-run — Planner read both RAW outputs.
- Hygiene: the commit must carry ONLY the 14 scoped paths; exclude the `host-git-tools.md` truncation, `package.json`/`package-lock.json`, `.codegraph/.gitignore`, `.windsurf/workflows/sdd-new.md`, and `odd/tasks/flow-probe.md`.

## Review-size-exception
> A host operation is atomic: operation registration, authorization branch, payload validation, classification, server dispatch, plugin tool definition, fragment rules and tests are one behaviour. Splitting would commit a registered operation with no surface, or a surface with no authorization — a security-relevant half state that this repository has already had to correct once (see the plan-root and admission fixes). Tests cannot be separated from the behaviour under this recipe, so the indivisible-change exception applies.
- authored_lines: 576 (360 tracked + 216 test) + second pass 103 (34/23 + 46/0)
- authored_patch_bytes: 35553 (+ ~6.6 KB second pass)
- generated_or_binary_paths: none

## Gates, delivery and finite revision cycle
This section describes technical sequence only; it does not certify manual/user acceptance gates.
1. Planner reads raw pre-code advice, finalizes the plan, records Gate 1 for A/U1. Technical only.
2. Only after Gate 1 PASS: PM dispatches `odd-apply`. Frozen S17 result is previewed and installed through the sanctioned manual-review flow; no live deployment.
3. Obtain raw `advisor-gemini-post` advice after writer/verifier evidence.
4. Planner records Gate 2 BEFORE the work-unit commit and before PM completion/ticks. A second REFINE/ESCALATE returns to the human; nonblocking follow-ups go to later work.
5. Only after Gate 2 PASS and an applicable receipt: the USER commits the S17 paths through the repo's manual path. No Planner commit, task marking or deployment approval.
6. Native risk assessment/review runs separately on the committed candidate before continuing to B; it is NOT Gate 2 input.

## Stable task IDs
- **A / U1** current gate/work-unit grouping.
- **A1** archive operation wiring and authorization.
- **A2** archive move/commit/rollback transaction.
- **A3** archive tests and checks.
- **B1–B4** branch tool — deferred, not authorized.

## Deferred B — retained r1 design, not Gate 1 authority for implementation
- One `host_git_branch` / `gitBranch` tool, action exactly `create` or `switch`, fixed argv `git switch -c <name>` or `git switch <name>` from canonical project root and hardened Git environment.
- Validate branch name before spawn: leading `-`, whitespace/control characters, `..`, `~`, `^`, `:`, `?`, `*`, `[`, backslash, `@{`, trailing `/` or `.lock`, sole `@`, HEAD/detached spellings refused; cap 255 bytes. No caller-chosen argv.
- Refuse existing branch on create and absent branch on switch using `git rev-parse --verify refs/heads/<name>`; approval required with action/name metadata. Raw operation classified `MUTATE_PROJECT`.
- No deletion, rename, force/discard, orphan, remote-tracking setup, remote creation or worktree support.
- Its future unit includes `host-tool-approval.ts`, branch plugin/docs rows and tests. Requires its own plan, advice and gates before writing.

## Next step
Awaiting owner authorization for a third correction scoped to forwarding `timedOut` out of `runHostStep`'s return plus one regression test that fails specifically without that forwarding. On authorization: fresh writer on the installed base, install, scoped recheck, Gate 2. No commit and no tick until Gate 2 passes.


## Revisions
- r1 2026-11-04T09:58:46Z gentle-orchestrator: Create tracker for the archive and branch host tools
- r2 2026-11-04T10:49:21Z planner: Finalize U1/A with owner decisions, PM suggestions, and raw security/specification advice
- r3 2026-11-04T14:54:49Z gentle-orchestrator: Record second pass, the F1/F2 recheck, and Gate 2 ESCALATE

## Gates
- A PASS 2026-11-04T10:49:44Z planner ref=Gate1 U1/A: plan r2 commit 37126522fad90914139c47de268266b3fc250e6d; raw pre-advice ses_e59d6df63ffefVSSWDU312fsQy; code evidence ses_e59e0db49ffe0pgljjH1TaT0uY
- A ESCALATE 2026-11-04T14:53:16Z planner ref=Gate2: service.ts:2647,2673-2680 drops timedOut; 4983-4995 bypasses timeout handling. Raw recheck ses_e58fbd90cffeel25WUqhhQ0Jq6. Third correction requires human authorization.
