# ODD task — host-git-branch

**Status:** in progress. Spec item **D33**. Contract fixed by the owner; a parallel agent writes permission rules against the same names, so `host_git_branch` / `gitBranch` must not be renamed.

## Objective

Add one host tool, `host_git_branch` (broker operation `gitBranch`), that creates a new local branch at a base commit, optionally switching to it, through a fixed argv vector. Never overwrites, deletes, force-moves, or touches a remote.

## Problem

The working rule requires a feature branch before substantial ODD work, and non-yolo parallel-worker mode needs `git switch -c`. With only `host_git_commit` and `host_git_push`, the orchestrator cannot create a branch without asking the owner to run Git by hand (`docs/TODO.md`, tier 2 open item 4 covers reads only).

## Scope

### Delivered surface

- `broker/src/types.ts` — `gitBranch` in the `Operation` union and in `SANDBOX_GUARD_CLASS` as `exempt-from-sandbox-guard`.
- `broker/src/validation.ts` — `gitBranch: ["projectDir", "name", "base", "switch"]` in `ALLOWED_PAYLOAD_KEYS`; `"gitBranch"` in `HOST_MUTATION_OPERATIONS`.
- `broker/src/role-policy.ts` — `gitBranch: "MUTATE_PROJECT"` and `host_git_branch: "HOST_APPROVED_MUTATION"` in `TOOL_CLASSIFICATION_INVENTORY`.
- `broker/src/gitops.ts` — pure `buildGitBranchArgv({ name, base, switchBranch })`.
- `broker/src/service.ts` — `buildGitBranchOp`.
- `broker/src/server.ts` — dispatch case.
- `opencode/plugins/lib/tool-specs-host-ops.ts` — `host_git_branch` tool with exactly one `ctx.ask`.
- `opencode/plugins/lib/host-tool-approval.ts` — `buildGitBranchAsk`.
- `opencode/config-fragments/sandbox-permissions.jsonc` and `opencode/plugins-v2/config-fragments/sandbox-permissions.jsonc` — `"host_git_branch": "ask"` (owner decision: this unit adds both rather than leaving the count tests red for the parallel agent).
- `docs/config-manifest-host-tools.md` — §5a table, mutation list and permission list.
- `docs/TODO.md` — close the open host-git-branch item.
- Tests: `broker/tests/gitops.test.ts`, `broker/tests/service-host-tools.test.ts`, `broker/tests/host-tool-approval.test.ts`, regenerated `broker/tests/fixtures/sandbox-tools-surface.json`, `broker/tests/sandbox-tools-surface.test.ts`, `broker/tests/sandbox-tools-call-sweep.test.ts`, `broker/tests/v2-config-fragments.test.ts`.

### Behaviour (fixed contract)

1. `authorizeHostDispatch(ctx, "gitBranch", req.sessionID, req.agent)` — orchestrator category, same class as `gitCommit`; the broker-derived trusted identity must be in `readOnlyAgents`.
2. `resolveCanonicalProjectRoot(ctx, payload.projectDir)` — approved root only; an escaping or non-approved `projectDir` is refused there.
3. Payload: `name` (required, `assertGitBranch`), `base` (optional, default `HEAD`), `switch` (optional boolean, default `false`). Exact-key validation; unknown keys refused.
4. Base resolution: `git rev-parse --verify --quiet <base>^{commit}`. Non-zero status, empty output, a leading `-`, or a non-string refuses. The resolved commit SHA is what the branch is created at.
5. Existing-branch refusal: `git show-ref --verify --quiet refs/heads/<name>` — status 0 means the branch exists and the operation refuses before any mutation.
6. Fixed argv: `["git","branch",name,<sha>]`, or `["git","switch","-c",name,<sha>]` when `switch` is true.
7. Post-condition: `git rev-parse --verify refs/heads/<name>^{commit}` must equal the resolved base commit; otherwise fail closed.
8. Bounded, redacted output (`capAndRedact`, `GIT_OUTPUT_MAX_BYTES`), including error text.
9. Approval class matches `host_git_commit`: fragment `ask`, metadata `{ name, base, switch }`.

### Non-goals

Deleting, renaming or force-moving a branch; `--force`/`-f`; remote creation, push or tracking setup; switching to an existing branch without creating; listing branches (separate tier-2 read item).

## Constraints

- Fixed argv vectors only; no shell string.
- S17 paths: `broker/src/**`, `opencode/plugins/**`, `opencode/config-fragments/**`. The owner installs those bytes; `sandbox_apply` refuses them, so `host_sandbox_result_install` plus an owner commit is the expected landing path.
- Broker stays dependency-free; `bun:test` + node builtins only.
- Test-first: new assertions observed RED before implementation, then GREEN.
- No deploy, mirror to `~/.config`, or service restart.

## Acceptance criteria

- `host_git_branch` creates a branch at `HEAD` by default and at an explicit base when given.
- `switch: true` creates and switches in one fixed `git switch -c` argv.
- An existing branch, an invalid name, an unresolvable or flag-shaped base, an unknown payload key and a non-orchestrator caller are all refused with a named error.
- The plugin surface records 52 tools and 25 asking for approval; both fragments carry `host_git_branch: ask`.
- `cd broker && bun test` green apart from the known `tests/v2-launch.test.ts:94` V2 nono profile failure; `bun build --target=bun src/main.ts` compiles.

## Route and trigger evidence

ROUTE: substantial feature | intent: authorized change | route: ODD secure / direct delegated writer | specialist: `pr-comment-resolver` (writer) | basis: WORKFLOW.md.

- Triggers fired: **writer** (two or more non-trivial files) and **mapping** (bounded inline evidence before dispatch).
- Environment deviations, recorded rather than papered over: `pm-odd`, `pm-systematic`, `odd-apply`, `gentle-ai-worker` and the `advisor-*-pre` / `advisor-*-post` agents were **not registered** in the creating session; `systematic-implementer` cannot dispatch (variant unavailable). The working writer lane is `pr-comment-resolver`.
- Pre-code advice: discharged by the owner-authored fixed contract (approach, refusals, non-goals and acceptance criteria specified before dispatch).
- Blocked then resumed: from this linked worktree every host control-plane tool refused with `host tool requires the exact approved project root` until the owner fixed and restarted the broker on 2026-11-06. `host_review_mode_status` now returns `receipt-driven development: on (decided by global)`.

### Attempt 2 — Orca dispatch (2026-11-06)

ROUTE: substantial feature | intent: authorized change | route: ODD secure / PM (`pm-odd`) | specialist: `pm-odd` (dispatcher), writer per PM selection | basis: WORKFLOW.md.

- Authorization: the Orca dispatch authorizes implementing `host_git_branch` under spec D33 and supersedes `odd/tasks/host-archive-and-branch-tools.md`, which left branch unit B deferred and unauthorized.
- Worktree: `/home/james/ai-workspace/worktrees/agent-sandbox-integration/host-git-branch`, branch `feat/host-git-branch`, merged with current master; unit-start HEAD `ffe5fe7923f141f439bde3b809eaba1273d711d8`, dirty paths none.
- Controlled baseline (`host_test_run` runner `broker-unit`, worktree digest `sha256:6e3a507c196364797ee6e2007dce9b651f776ceacb53934b828243329f373975`): **1888 pass, 9 skip, 1 fail** — the single failure is the known `tests/v2-launch.test.ts:94` "V2 nono profile > reaches the same hosts and project roots as V1, with the same isolation" (`platform.claude.com` extra allow-domain).
- Pre-code advice: the dispatch requires the Planner advisor cycle. `planner`, `advisor-*-pre` and `advisor-*-post` are not in this runtime's registered subagent surface, so the cycle is re-attempted through `pm-odd` and recorded as unavailable if it cannot be dispatched. The owner-authored fixed contract above remains the design authority in that case.
- Frozen draft: a previous writer result (`refs/opencode-sandbox/result/ses_e4dd0b405ffe6cUen4IHE6EQRR`, commit `47d9a9d`, 3 paths) is unreviewed and is **not** bound to this worktree project (`host_sandbox_result` returns `sandbox session ... is not bound to this project`). It is treated as an unseen draft and is not installed.

## Review-size forecast

Indivisible host-operation change: operation, authorization, validation, classification, argv builder, server dispatch, plugin tool, approval metadata, fragment rules, docs and tests are one behaviour and land together. Forecast authored lines ≈ 420–520 across 14 paths plus a regenerated fixture. A `review-size-exception` is expected and must be recorded here before the commit.

## Progress

| Item | Status | Notes |
|------|--------|-------|
| Tracker | done | Created before the first source edit |
| Tests (RED) | pending | |
| Implementation | pending | |
| Docs + fragments + fixture | pending | |
| Suite + build | pending | |
| Commit | pending | |

## Log

- 2026-11-06: tracker created after the broker worktree fix; RDD `on` (global).
- 2026-11-06: attempt 2 under an Orca dispatch. Baseline captured: 1888 pass / 9 skip / 1 known fail at HEAD `ffe5fe7`. Route recorded as `pm-odd`. Frozen prior result unreviewed and not bound to this project; not installed.

## Next step

Dispatch `pm-odd` with the fixed contract, test-first.


## Revisions
- r1 2026-11-06T18:46:14Z gentle-orchestrator: Create tracker for the host_git_branch host tool (spec D33)
- r2 2026-11-06T22:48:22Z gentle-orchestrator: Attempt 2: Orca dispatch, pm-odd route, baseline recorded
