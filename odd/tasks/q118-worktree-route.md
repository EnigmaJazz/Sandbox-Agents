# ODD Tasks — q118-worktree-route

- **Feature:** `q118-worktree-route`
- **Project:** `sandbox-integration`
- **Status:** W1 applied and verified in the worktree; W2 not started; owner commit and Codex review pending (S17)
- **Created:** 2026-11-10
- **Delivery strategy:** `ask-on-risk`
- **Chain strategy:** `stacked-to-main` (standing owner choice)
- **Plan:** none; the contract below is the design authority (owner queue item Q118)
- **Source:** owner queue Q118, relayed by the Orca coordinator dispatch 2026-11-10

## Objective

Give the delegation chain one supported, sandbox-preserving route to a clean branch or git
worktree at a named base. The orchestrator is read-only and a sandbox worker's repository holds
only its own `baseline`/`work` refs, so neither can see or create a host branch; today only a
human shell can. After this unit an approval-gated broker operation creates the worktree, and the
broker resolves it as a virtual project, so a session bound to it reads the new HEAD.

## Problem

Observed 2026-11-10 in this dispatch:

1. A delegated `general` worker inside the sandbox reports top level `/work` with branches
   `baseline` and `work` only; `refactor/p0-shared-tool-table`, `master` and `origin/master` are
   unresolvable there. The sandbox cannot see host refs, so it cannot branch from one.
2. The retained-master seat has no `host_git_branch` and no `host_git_head` on its tool surface,
   although `opencode/plugins/lib/tool-specs-host-ops.ts:84,113` defines both and both permission
   fragments grant them. The installed plugin surface lags the repository for this identity.
3. Host refs ARE reachable through the broker: `host_review_materialize` diffed
   `origin/master..refactor/p0-shared-tool-table` for this seat, a ref the sandbox cannot see. The
   broker is therefore the correct place to create the branch and the worktree.

The consumption half already exists and needs no change:

- `resolveWorktreeAwareRoot` (validation.ts:1401) accepts exactly `<root>/<project>/<name>` under a
  registered root that is not itself a checkout, requiring its own `.git`.
- `resolveProjectID` (validation.ts:1488) returns the virtual id `<rootID>~<project>~<name>`, and
  `findProject` (validation.ts:1420) resolves it back while the rule holds.
- `gitDirFor` (validation.ts:1468) verifies a linked worktree's `.git` pointer against git's own
  back-link.
- `resolveCanonicalProjectRoot` (service.ts:3567) therefore accepts the worktree for every host
  tool, because `findProject` already returned the worktree path.

Nothing creates the worktree. That is the whole gap.

## Findings (2026-11-10)

- **A `pm-odd` session holds `host_git_branch` and `host_git_head`.** Observed from its granted
  function list; `host_git_head` was callable with no arguments and returned branch
  `feat/q102-p0-staging`, `detached: false`. So "delegate branch creation to a PM" is live, but it
  is a one-way door: `host_git_branch` is create-only by contract (D33), and `switch: true` would
  strand a shared checkout on the new branch with no supported switch-back. A worktree does not
  have that problem, because it carries its own HEAD.
- **The `pm-odd` lane cannot run the ODD writer chain in this worktree.** Its subagent surface
  permits only `explore`, `gentle-ai-verify` and `gentle-ai-verify-routine`; `planner` and
  `odd-apply` are not dispatchable targets. The PM returned BLOCKED with zero mutation. This is
  the known **Q105 (hidden Planner)** issue in `workflow_optimisation`; recorded, not worked
  around. The coordinator accepted a direct-writer degradation for W1.
- **`host_plan_write` moves the branch HEAD.** Creating this tracker wrote metadata commit
  `ff99a5a` after the unit-start anchor had been captured at `b7e2b48`, so the first PM run
  blocked with `UNIT_START_ANCHOR_MISMATCH`. The anchor must be captured after the tracker commit.
- **Q102 P0 is not fully clear.** P0 docs and the preflight spike are closed (T1, `88bc5dc`,
  owner-approved 2026-11-07), but OPEN-1 (where the review runs) is still an owner decision, no
  real state directory is chosen, the sandbox is DENIED the hypothetical state directory so a
  shared clone needs a profile read grant, and `start`/`capture`/`acknowledge` on a clone stays
  unverified until an owner-consented run. D37 forbids an agent starting it.

## Scope

### Unit W1 — broker core — APPLIED, VERIFIED

- `broker/src/types.ts`: `gitWorktree` in `Operation`, `exempt-from-sandbox-guard`, `OPERATIONS`.
- `broker/src/validation.ts`: payload allowlist; `HOST_MUTATION_OPERATIONS`;
  `assertWorktreeTarget(root, project, name)` with canonical containment.
- `broker/src/gitops.ts`: pure `buildGitWorktreeArgv({ branch, target, sha })`.
- `broker/src/role-policy.ts`: `gitWorktree: "MUTATE_PROJECT"` and
  `host_git_worktree: "HOST_APPROVED_MUTATION"`.
- `broker/src/service.ts`: `buildGitWorktreeOp`; `broker/src/server.ts`: dispatch case.
- Tests first in `broker/tests/worktree-op.test.ts`, `broker/tests/gitops.test.ts`,
  `broker/tests/service-host-tools.test.ts`.

### Unit W2 — plugin surface and docs — NOT STARTED

- `opencode/plugins/lib/tool-specs-host-ops.ts`: `host_git_worktree`, exactly one `ctx.ask`.
- `opencode/plugins/lib/host-tool-approval.ts`: `buildGitWorktreeAsk`.
- Both `sandbox-permissions.jsonc` fragments: `"host_git_worktree": "ask"`.
- `docs/config-manifest-host-tools.md` and `docs/TODO.md` rows.
- Surface and call-sweep tests plus the regenerated fixture.

### Fixed contract (W1, as delivered)

1. `authorizeHostDispatch(ctx, "gitWorktree", sessionID, agent)` runs first, before payload
   validation.
2. `repoDir` resolves through `resolveCanonicalProjectRoot` and must be a git checkout.
3. `rootDir` resolves through `resolveProjectID` and must be a registered root with no `.git`.
4. `project` and `name` match `WORKTREE_SEGMENT_RE`; `branch` passes `assertGitBranch`; `base`
   defaults to `HEAD` and resolves through `git rev-parse --verify --quiet <base>^{commit}` to
   40 hex.
5. Refusals before any mutation: target exists; `<root>/<project>` missing, not a directory, or
   resolving outside the canonical root; branch already exists (status 0 refuses, 1 continues,
   anything else fails closed); base unresolvable or flag-shaped.
6. Fixed argv with `cwd = <canonical repoDir>`: `["git","worktree","add","-b",branch,target,sha]`.
7. Post-conditions: HEAD equals `sha`; symbolic-ref equals `branch`; `resolveProjectID(target)`
   yields the virtual id and `findProject` returns `target`. A mismatch fails closed and names the
   created path; cleanup is a non-goal.
8. Bounded, redacted output (`capAndRedact`, `GIT_OUTPUT_MAX_BYTES`).
9. Orchestrator-only; W2 adds fragment `ask` plus one in-tool `ctx.ask`.

### Non-goals

Deleting, moving, pruning or repairing worktrees; `--force`, `--detach`, `--orphan`, `--porcelain`;
remote creation, fetch or push; switching an existing checkout; changing registered roots; any
profile or sandbox grant change.

## W1 result (2026-11-10)

- Result `ses_e39f89a04ffe0VNbzjPjWjI61h`, commit `918eca65`, 291 authored changed lines across
  nine paths, applied to the worktree with `host_sandbox_result_install`.
- Two writer attempts were spent: the first produced the operation and the argv test but no
  integration coverage; the single correction round added the refusal matrix and then closed a
  real containment hole found in review (a symlinked `<root>/<project>` let `git worktree add`
  create a tree outside the root before the routing post-condition refused).
- `bun test tests/worktree-op.test.ts tests/gitops.test.ts`: 48 pass, 0 fail.
- `host_test_run runner=broker-unit` on the installed tree at `gitHead ff99a5a`: **2014 pass,
  9 skip, 2 fail**, 9383 expect calls, 2025 tests across 110 files, exit 1. Both failures are the
  known pre-existing `tests/v2-launch.test.ts:64` and `:94` profile-drift assertions; nothing in
  this diff touches a profile.
- `bun build --target=bun src/main.ts`: succeeded (writer-observed).
- `host_git_commit` refuses: `refusing to commit protected paths (S17): broker/src/gitops.ts,
  broker/src/role-policy.ts, broker/src/server.ts, broker/src/service.ts, broker/src/types.ts,
  broker/src/validation.ts`. The owner commits these bytes after the Codex review.

## Constraints

- Test-first; RED observed before implementation.
- `cd broker && bun test` green apart from the two known `tests/v2-launch.test.ts` profile-drift
  failures, and `bun build --target=bun src/main.ts` succeeds.
- Broker stays dependency-free; fixed argv only; no shell string.
- S17 paths: `broker/src/**`, `opencode/plugins/**`, `opencode/config-fragments/**`,
  `opencode/plugins-v2/config-fragments/**`. `sandbox_apply` refuses them; land through
  `host_sandbox_result_install`, and the owner commits.
- Risk item 2/3: a Codex review before merge. Stop at applied-and-verified; the commit is the
  owner's because `host_git_commit` refuses S17 by design.
- No push, no broker restart, no install into `~/.config`.

## Acceptance criteria

- [x] A worktree is created at `<root>/<project>/<name>` from `repoDir` at `base`, on the new
  branch `branch`, verified by HEAD and symbolic-ref.
- [x] The created path resolves as `<rootID>~<project>~<name>` through `resolveProjectID`, and
  `findProject` returns it; `gitDirFor` returns its linked git directory.
- [x] Existing branch, existing target, missing project directory, unresolvable base, flag-shaped
  base, non-checkout `repoDir`, git-checkout `rootDir` and a non-orchestrator caller are all
  refused before mutation.
- [x] A project directory resolving outside the root is refused before mutation, with a
  regression test proving `git worktree add` is never invoked.
- [ ] `host_git_head` on the new path reports `branch` and `sha` — the live "a session sees the new
  HEAD" check. Not yet run: the tool is not on this seat's surface, and it needs an installed
  plugin (W2) plus a broker restart, both owner actions.
- [ ] Both fragments and the manifest carry the tool; the surface tests agree — W2.

## Authorized scope

`broker/src/{types,validation,gitops,role-policy,service,server}.ts`, `broker/tests/**`,
`opencode/plugins/lib/{tool-specs-host-ops,host-tool-approval}.ts`,
`opencode/config-fragments/sandbox-permissions.jsonc`,
`opencode/plugins-v2/config-fragments/sandbox-permissions.jsonc`,
`docs/config-manifest-host-tools.md`, `docs/TODO.md`.

## Route and trigger evidence

- ROUTE: substantial feature | intent: authorized change | route: ODD secure / PM (`pm-odd`) →
  `planner` pre-code advice → `odd-apply` writer | specialist: `pm-odd` | basis: WORKFLOW.md.
- Recorded deviation (coordinator-accepted): the `pm-odd` lane could not dispatch `planner` or
  `odd-apply` (Q105), so W1 ran as a direct delegated `general` writer with the same fixed
  contract. Pre-code advice was therefore not obtained; the Codex review and the owner's diff
  review are the compensating gates for a Risk item 2/3 change.
- Owner decision: Q118 relayed 2026-11-10. Branch `refactor/p0-shared-tool-table` is explicitly
  NOT reused: its whole divergence from origin/master is four Q114 worker-release paths.

## Checks

Recorded in `## W1 result`.

## Progress

- 2026-11-10: tracker created (r1, commit `ff99a5a`).
- 2026-11-10: W1 dispatched to `pm-odd`; blocked twice (stale anchor, then missing dispatch
  authority). Degraded to a direct `general` writer.
- 2026-11-10: W1 written, corrected once for a containment hole, applied to the worktree, and
  verified through `host_test_run runner=broker-unit`.
- 2026-11-10: `host_git_commit` refused the S17 paths, as designed.

## Open questions

1. W2 needs an owner decision on the installed-plugin path: `host_git_branch`/`host_git_head` are
   already absent from the retained-master surface although both are committed and granted, so a
   new tool may need a plugin reinstall and broker restart before any session can call it.
2. `buildGitWorktreeOp`'s doc comment still ends with two sentences that describe `gitHead`
   (`GIT_DIR` binding). Cosmetic; fold into W2 or the owner's edit.
3. `MsbError` is used for a `git worktree add` failure. Semantically loose; `StateError` or
   `GitGuardError` would read better. Left as is to keep the reviewed diff stable.

## Next step

Owner: Codex review, then commit the nine paths. Then W2 (plugin surface, fragments, manifest,
surface tests), which is what makes the tool reachable from a session.


## Revisions
- r1 2026-11-10T14:33:05Z gentle-orchestrator: Create Q118 tracker: one supported worktree route from a named base
- r2 2026-11-10T15:36:04Z gentle-orchestrator: Record W1 applied+verified, S17 commit refusal, Q105 PM-lane block and Q102 P0 gap
