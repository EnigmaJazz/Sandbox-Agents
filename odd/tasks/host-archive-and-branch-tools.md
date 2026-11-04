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

Sanctioned tracker metadata surface: this document, only through the approved host plan route. The writer brief must identify the correction from `general` to `pm-odd → planner gates → odd-apply writer`; it must not ask the sandbox writer to bypass plan-root protection. No task completion ticks before Gate 2. This revision makes that Route correction now.

Out: `host_git_branch`, `host-tool-approval.ts` changes, configuration/deployment, unrelated cleanup, broadened shared commit/path helpers, permission-matrix changes, arbitrary argv, deleting trackers, or modifying live host configuration. S17 applies to broker/plugin artifacts; no agent self-certifies manual Gates 0–10.

## Owner-decided requirements — 2026-11-04
The supplied r2 design supersedes the r1 single-path commit statement:
- Move `odd/<target>/<name>.md` to `odd/<target>/archive/<name>.md`; `target` is exactly `tasks` or `mini`; payload fields are exactly `projectDir`, `target`, `name`, `agent`, `note`.
- Validate name with existing `assertPlanDocWriteName`. Resolve the exact approved canonical project root, check containment and protected paths for BOTH paths, and use the plan-document lock mechanism.
- Commit message exactly `docs(odd): archive <target>/<name>`. No approval prompt; the fixed act and its commit record are the compensating control.
- (a) Add only `planArchive` beside `planDocWrite` in the plan-role allowance. Require the same bound plan role or read-only orchestrator identity; do not widen other operations.
- (b) `tasks` uses `planWriterAgents`; `mini` uses the deduplicated union of `planWriterAgents`, `planMiniWriterAgents`, and `readOnlyAgents`. Payload agent must equal the bound session identity. Use archive-shaped refusal codes such as `PLAN_ARCHIVE_AGENT_REFUSED`.
- (c) Dedicated archive-local commit logic stages exactly both paths with argv-vector `git add -A -- <source> <dest>`, then the existing commit invocation shape with both explicit paths. Do not generalize `commitPlanDocRevision` or its flat-path assertion.
- (d) Acquire both canonical document locks in deterministic sorted order, keep both through the transaction, release in reverse order. Sort the pair initially formed as source/destination; do not assume lexical ordering always puts source first. A concurrent source write must not interleave.
- (e) If the move succeeds but commit fails, restore the source and index and rethrow the original error. If move-back fails, throw `PLAN_ARCHIVE_ROLLBACK_FAILED` naming both relative paths. A test must demonstrate restored source and no archive-induced index change.

## A1 — operation, authorization and tool wiring
- Add `planArchive` to the operation union, `OPERATIONS`, sandbox-guard map (same exemption as `planDocWrite`), `HOST_MUTATION_OPERATIONS`, exact payload-key table, server builder import and dispatch.
- Classify raw `planArchive` as `MUTATE_PROJECT`, as requested. Separately classify public `host_plan_archive` as `HOST_APPROVED_MUTATION`, mirroring `host_plan_write` so intended coordinator admission works. This classification does not add a prompt. Leave role matrices, other classifications and `planDocWrite` behavior unchanged.
- Extend only the existing `planDocWrite` authorization disjunct to include `planArchive`, preserving all existing bound-identity conditions and the gate/task-mark branches.
- Plugin schema exposes `target`, `name`, `note`; derive `projectDir` and `agent` from the existing trusted context exactly like `host_plan_write`. No caller-chosen paths or argv, and no `ctx.ask` call.
- Add only archive tool documentation rows. State fixed same-repository move, exact fields, target-specific authorization, no approval prompt, refusal/rollback behavior, and not-installed/manual delivery status where applicable. No branch tool row in this unit.

## A2 — archive transaction
### Validation and filesystem boundary
- Follow `buildPlanDocWriteOp` for bound identity, tasks/mini allowlists and note validation. Explicit archive codes: `PLAN_ARCHIVE_AGENT_NOT_BOUND`, `PLAN_ARCHIVE_AGENT_MISMATCH`, `PLAN_ARCHIVE_AGENT_REFUSED`, `PLAN_ARCHIVE_TARGET_INVALID`, `PLAN_ARCHIVE_NOTE_INVALID`.
- Name validation reuses the existing helper and therefore `PLAN_WRITE_NAME_INVALID`; do not silently change existing helper behavior.
- Derive the flat source and matching archive destination from validated target/name only. Use a local pair assertion allowing only those two matching layouts, not a generalized shared commit regex. Use `PLAN_ARCHIVE_PATH_ESCAPE` and `PLAN_ARCHIVE_PROTECTED_PATH` for archive containment/protected-path refusals; verify both paths independently.
- Under both locks, validate ancestor chains with existing no-symlink protection and use `lstat`, not `existsSync`/following `stat`, for existence. Source must be a regular single-link file: missing → `PLAN_ARCHIVE_SOURCE_MISSING`; nonregular → `PLAN_ARCHIVE_NOT_REGULAR`; hardlink → `PLAN_ARCHIVE_HARDLINK_REFUSED`.
- Run ancestor/leaf symlink protection first; inherited `PLAN_WRITE_SYMLINK_REFUSED` wins for any source/destination symlink, including a dangling destination symlink. Otherwise any occupied destination, including directory/FIFO, gives `PLAN_ARCHIVE_DESTINATION_EXISTS`. No overwrite.
- Check protected paths and symlinks before creating the archive parent; recheck after parent creation and immediately before rename. Retain the existing documented external parent-swap limitation; in-process locks are not cross-process filesystem exclusion.
- Move bytes unchanged. Do not regenerate content or add Revision/Gates text to the archived document.

### Locking
- Reuse `withPlanDocLock` with the exact canonical absolute keys used by plan writes; sort the two keys deterministically and nest their scopes. Retain both scopes through revalidation, rename, staging, commit and any rollback. The inner scope settles before the outer scope.
- No replacement lock infrastructure, shared helper refactor, or claim that concurrent owner Git/filesystem changes are serialized.

### Git transaction and failure boundary
- Use the existing hardened plan-doc Git environment, fixed identity, timeout and runner, with explicit argv only.
- Before moving, check the index state scoped to the two participating paths. Refuse preexisting staged/conflict entries on either with `PLAN_ARCHIVE_INDEX_DIRTY`; unrelated staged files are permitted and must remain untouched. This preflight distinguishes index entries from untracked working-tree files and handles repositories without a committed HEAD explicitly rather than mislabeling a Git error as clean state.
- Stage exactly `git add -A -- <source> <dest>`. Commit with `git commit -m <exact archive message> -- <source> <dest>`. No broad staging/commit/reset, forced-add fallback, shell strings or caller-controlled extra flags. Shared `commitPlanDocRevision` remains unchanged.
- Treat staging/commit spawn errors, timeout and nonzero results as transaction failures, not success or a swallowed `committed:false`. Keep the original thrown error; convert a nonzero runner result once to a bounded archive commit/stage error and rethrow that same error after successful cleanup.
- On failure after move, verify safe source/destination state before reverse rename so a newly appeared source is not overwritten. Move back and restore only archive-induced index effects; preserve unrelated staged/unstaged files. Index restoration must work for a previously tracked source as well as untracked/unborn source cases that reach a staging failure. If any rollback phase fails, throw `PLAN_ARCHIVE_ROLLBACK_FAILED` naming both relative paths with bounded phase detail and original error as cause. Do not falsely claim cleanup completed.
- Select and prove the exact path-scoped index cleanup in test-first work; do not rely on an unverified claim that a single checkout/restore/rm command handles every HEAD/path state. The approved evidence carrier could not be dispatched for this optional Git-command fact check; no commands or outcomes were verified by the Planner.
- Separate successful commit from post-commit metadata lookup. A zero-exit commit establishes success; subsequent `rev-parse HEAD` failure must NOT trigger reverse rename or falsely report a failed archive. Return `committed:true`, omit unavailable `commit`, and include a bounded `commitWarning`; on successful lookup return the validated commit ID. Apply this rule to thrown lookup failures and malformed output too. This is report-state handling, not a change to existing plan-write semantics.
- For an ambiguous commit result (e.g. timeout after Git may have updated HEAD), reconcile against the pre-operation HEAD and the exact two-path committed result before selecting committed-success versus rollback. If it cannot be determined safely, fail closed with explicit uncertain-state/rollback-failure evidence and both paths rather than blindly undoing a possibly committed move. Add a failure-injection test for the boundary; do not claim crash-atomicity or rollback concurrent external Git.

## A3 — test-first acceptance and verification
Execution posture: test-driven-development. Add the archive tests and record the named targeted RED run BEFORE implementation. Missing behavior, not an unrelated baseline failure, must explain RED. Then implement and record GREEN.

`broker/tests/plan-archive.test.ts` plus directly related existing integration tests must cover:
1. Tasks and mini success in real temporary Git repositories: exact preserved bytes, source absent, destination present, exact commit message, both move sides in commit, valid success response, unrelated staged and unstaged paths unchanged.
2. Five original refusal categories without filesystem/index/HEAD mutation: missing source (`PLAN_ARCHIVE_SOURCE_MISSING`), occupied destination (`PLAN_ARCHIVE_DESTINATION_EXISTS`), path escape, protected path, bad name/target. Cover name and target separately with the exact codes above. For unreachable traversal after strict validation, prove malicious inputs are refused before I/O and test local pair containment directly; do not fabricate a naturally reachable escape.
3. Bound/payload-agent mismatch, missing binding, unauthorized worker, tasks allowlist exclusion, and every mini allowlist source. Test direct operation authorization as well as public-tool admission; test unbound mutation denial. Verify both raw/public classification entries without broadening other operations.
4. Plugin forwarding of trusted directory/agent, exact allowed fields, server dispatch wiring, and no approval request. A broker handler test alone is not end-to-end tool evidence.
5. Source and ancestor symlinks; archive-parent/destination symlinks including dangling leaf; nonregular/hardlinked source; occupied nonregular destination. Assert error precedence and no overwrite/out-of-root effect.
6. Deterministic lock serialization: pause archive inside the commit runner, start a valid concurrent plan write to the same source, prove it cannot complete/interleave before the archive transaction settles, then release and check outcomes. No sleep-only race assertion. Cover destination-lock contention/second archive conflict and reverse acquisition completion.
7. Inject add and commit failures: original error propagates, source bytes restored, archive file absent, index state restored, unrelated staged/unstaged entries unchanged and HEAD unchanged. Include tracked, untracked-source and unborn-HEAD failure fixtures; an exact-add pathspec refusal is an error to roll back, not a reason to replace owner-required argv.
8. Move-back failure and index-cleanup failure: `PLAN_ARCHIVE_ROLLBACK_FAILED` names both paths and retains original cause. Preexisting staged/conflicted participating paths refuse before moving with `PLAN_ARCHIVE_INDEX_DIRTY` and preserve the prior index.
9. Successful commit followed by failed/thrown/malformed commit-ID lookup remains a committed archive with warning and no reverse move. Inject an ambiguous commit failure/timeout to prove the reconciliation boundary does not undo an already committed archive.

Required checks by authorized writer/verifier, not this read-only Planner:
- Named targeted RED and GREEN runs with exact results.
- `bun --cwd broker test`, exact counts and failures. The r1 tracker mentions `tests/v2-launch.test.ts:94`; that is not a current verified baseline or blanket waiver. Reproduce and distinguish any baseline failure from regressions.
- In `broker/`: `bun build --target=bun src/main.ts`.
- Static diagnostics for every changed path on the SAME initial candidate as first verification/post-advice; report coverage gaps, not a fabricated clean result. A parse/build check does not replace executing archive integration tests.
- Actual diff/path inventory and staged reviewability receipt for EACH intended commit: at most 400 authored lines and 100 KiB authored patch. If A exceeds the budget, stop for PM/Planner boundary refinement; do not omit behavior/tests or compress code to fit. Native START remains its own final serialized-input authority.

## Advice selection and raw-output disposition
- Selected `advisor-gemini-pre` exactly once: approved API-credit security advisor for authorization, filesystem paths and Git-index mutation; also the compulsory pre-specification carrier while Antigravity is inactive. Do not duplicate with `advisor-spec-pre` or subscription Gemini advisors. This unit's security/specification advice was returned and read RAW by the Planner: session `ses_e59d6df63ffefVSSWDU312fsQy`.
- Observed raw findings: clarify index rollback for differing HEAD/path states; separate successful commit from failed commit-ID lookup; use `lstat` with explicit symlink/refusal precedence; preserve exact line-219 authorization shape; use separate raw-operation and public-tool classifications; sort both canonical lock keys. Incorporated above.
- The advisor's exact Git-command claims were advice, not execution evidence. Optional bounded `advisor-gemini-evidence` dispatch was permission-rejected; no result exists, no retry/substitution, and no command semantics or test success is claimed from it. Runtime-specific cleanup selection is explicitly assigned to test-first proof.
- No separate design/UX advisor: no UI surface. No additional integration/testing/maintainability advisor: this is one bounded archive transaction/wiring surface; security/specification advice covers its required failure and integration tests, and no independent library/platform API change is introduced. No subscription Gemini dispatch: external lane remains PLANNED.
- `planner-evidence` skipped: direct reads/CodeGraph and one `explore` evidence task supplied relevant source facts. `explore` raw result read: session `ses_e59e0db49ffe0pgljjH1TaT0uY`. No additional broad research or unrelated advisory pass.
- Compulsory post carrier: `advisor-gemini-post`, exactly once at the post position after writer output and verifier evidence, before Gate 2. Provide the exact owner specification, allowed surfaces, actual diff and relevant code; read its RAW result. If unavailable, BLOCKED, not substituted.

## Route and trigger evidence
ROUTE: substantial feature | intent: authorized change | route: ODD secure / PM dispatch and Planner gates | specialist: pm-odd → planner gates → odd-apply writer | basis: WORKFLOW.md.
- Owner's continue decision and refinements (a)–(e), received 2026-11-04, are the current input; do not restart or select `general` as this PM's writer.
- Observed loaded skills for this Planner phase: workflow-route, workflow-odd-secure, orchestrating-subagents, ce:plan. Specific ODD unit/advisor/fixed-plan controls override generic extra-agent/artifact suggestions.
- Observed preparation: tracker r1, CodeGraph source/impact, direct symbol navigation, one `explore` task and one approved `advisor-gemini-pre` task with raw output. Planner performed no code mutation, execution, writer or review-lens dispatch.
- Scope trigger: authorization and host-mutation security contract across broker/tool wiring; substantive ODD, not passive tiny work.
- Writer selected by PM: `odd-apply`. The PM must carry this plan and owner model/session decisions, exact allowed paths, RED-first requirements, tracker-route correction and S17/manual-delivery constraints into its brief.

## Gates, delivery and finite revision cycle
This section describes technical sequence only; it does not certify manual/user acceptance gates.
1. Planner reads raw pre-code advice, finalizes this plan, then records Gate 1 through the fixed gate tool for task A/U1. Gate 1 is technical only.
2. Only after Gate 1 PASS: PM dispatches `odd-apply`. Writer/verifier provide actual checks, source/diff and first-candidate static diagnostics. Frozen S17 result must be previewed and installed through the sanctioned manual-review flow; no live deployment.
3. Obtain compulsory raw `advisor-gemini-post` advice after writer/verifier evidence. PM supplies pre-commit assessment of the installed candidate, exact identity and all evidence to Planner.
4. Planner records Gate 2 BEFORE the work-unit commit and before PM completion/ticks. Batch initial-candidate findings into ONE fresh correction if REFINE; rerun targeted checks/post assessment and Gate 2 on the revised installed candidate. Second Gate 2 PASS unless a true blocker remains; second REFINE/ESCALATE returns to the human, nonblocking follow-ups go to later work.
5. Only after technical Gate 2 PASS and applicable receipt: USER commits S17 exact reviewed paths through the repo's required manual path. No Planner commit, task marking or deployment approval.
6. Native risk assessment/review runs separately on the committed candidate before continuing to B; it is NOT Gate 2 input. RDD effective mode/source must be read by PM/orchestrator, not assumed or toggled. PM closes the unit only after required post-commit process. Preserve durable evidence/Magic Context mirror before claiming closure.

## Stable task IDs
- **A / U1** current gate/work-unit grouping.
- **A1** archive operation wiring and authorization.
- **A2** archive move/commit/rollback transaction.
- **A3** archive tests and checks above.
- **B1** operation wiring for `gitBranch` — deferred.
- **B2** branch-name validator with refusal table — deferred.
- **B3** branch implementation, create/switch/refusals/approval — deferred.
- **B4** branch tests — deferred.
- **C1** plugin/docs; archive rows only in U1, branch rows deferred.
- **C2** checks/receipts per unit.

## Deferred B — retained r1 design, not Gate 1 authority for implementation
- One `host_git_branch` / `gitBranch` tool, action exactly `create` or `switch`, fixed argv `git switch -c <name>` or `git switch <name>` from canonical project root and hardened Git environment.
- Validate branch name before spawn: leading `-`, whitespace/control characters, `..`, `~`, `^`, `:`, `?`, `*`, `[`, backslash, `@{`, trailing `/` or `.lock`, sole `@`, HEAD/detached spellings refused; cap 255 bytes. No caller-chosen argv.
- Refuse existing branch on create and absent branch on switch using `git rev-parse --verify refs/heads/<name>`; approval required with action/name metadata. Raw operation classified `MUTATE_PROJECT`.
- No deletion, rename, force/discard, orphan, remote-tracking setup, remote creation or worktree support.
- Its future unit includes `host-tool-approval.ts`, branch plugin/docs rows and tests: create/switch success, existing/absent refusal, all bad names before any spawn, missing approval refusal. Requires its own plan/advice/Gates before writing.

## Next step
Record technical Gate 1 for A/U1 on this revision. No code, tests or installation have been performed by this Planner; all runtime acceptance remains unverified until the authorized execution phase.

## Revisions
- r1 2026-11-04T09:58:46Z gentle-orchestrator: Create tracker for the archive and branch host tools
- r2 2026-11-04T10:49:21Z planner: Finalize U1/A with owner decisions, PM suggestions, and raw security/specification advice
