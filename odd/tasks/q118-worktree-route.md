# ODD Tasks — q118-worktree-route

- **Feature:** `q118-worktree-route`
- **Project:** `sandbox-integration`
- **Status:** in progress — tracker created; implementation not started
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
   fragments grant them. The installed plugin surface lags the repository.
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

## Scope

### Unit W1 — broker core (commit 1)

- `broker/src/types.ts`: `gitWorktree` in `Operation`, `exempt-from-sandbox-guard`, `OPERATIONS`.
- `broker/src/validation.ts`: `gitWorktree` payload allowlist; `HOST_MUTATION_OPERATIONS`;
  `assertWorktreeTarget(root, project, name)` — the target is exactly two segments under a
  registered root that is not a git checkout, both segments match `WORKTREE_SEGMENT_RE`, and the
  target is absent.
- `broker/src/gitops.ts`: pure `buildGitWorktreeArgv({ branch, target, sha })`.
- `broker/src/role-policy.ts`: `gitWorktree: "MUTATE_PROJECT"` and
  `host_git_worktree: "HOST_APPROVED_MUTATION"`.
- `broker/src/service.ts`: `buildGitWorktreeOp`; `broker/src/server.ts`: dispatch case.
- Tests first in `broker/tests/`: argv builder, every refusal, the happy path against a temp
  repository, and the routability post-condition.

### Unit W2 — plugin surface and docs (commit 2)

- `opencode/plugins/lib/tool-specs-host-ops.ts`: `host_git_worktree`, exactly one `ctx.ask`.
- `opencode/plugins/lib/host-tool-approval.ts`: `buildGitWorktreeAsk`.
- Both `sandbox-permissions.jsonc` fragments: `"host_git_worktree": "ask"`.
- `docs/config-manifest-host-tools.md` and `docs/TODO.md` rows.
- Surface and call-sweep tests plus the regenerated fixture.

### Fixed contract (W1)

1. `authorizeHostDispatch(ctx, "gitWorktree", sessionID, agent)` runs first, before payload
   validation.
2. `repoDir` resolves through `resolveCanonicalProjectRoot` and must be a git checkout.
3. `rootDir` resolves through `resolveProjectID` and must be a registered root with no `.git` (a
   worktree root, never a checkout).
4. `project` and `name` match `WORKTREE_SEGMENT_RE`; `branch` passes `assertGitBranch`; `base` is
   optional and defaults to `HEAD`, resolved in `repoDir` with
   `git rev-parse --verify --quiet <base>^{commit}` to 40 hex.
5. Refusals before any mutation: target exists; `<root>/<project>` is missing or not a directory;
   the branch already exists (`git show-ref --verify --quiet refs/heads/<branch>`: status 0
   refuses, 1 continues, anything else fails closed); the base is unresolvable or flag-shaped.
6. Fixed argv with `cwd = <canonical repoDir>`: `["git","worktree","add","-b",branch,target,sha]`.
7. Post-conditions: `git -C <target> rev-parse --verify HEAD` equals `sha`;
   `git -C <target> symbolic-ref --short -q HEAD` equals `branch`; and
   `resolveProjectID(target, projects)` yields the virtual id while `findProject` returns
   `target`. A mismatch fails closed and names the created path; cleanup is a non-goal and the
   reason is reported.
8. Bounded, redacted output (`capAndRedact`, `GIT_OUTPUT_MAX_BYTES`).
9. Orchestrator-only; fragment `ask` plus one in-tool `ctx.ask` carrying metadata
   `{ repoDir, rootDir, project, name, branch, base }`.

### Non-goals

Deleting, moving, pruning or repairing worktrees; `--force`, `--detach`, `--orphan`, `--porcelain`;
remote creation, fetch or push; switching an existing checkout; changing registered roots; any
profile or sandbox grant change.

## Constraints

- Test-first; RED observed before implementation.
- `cd broker && bun test` green apart from the two known `tests/v2-launch.test.ts` profile-drift
  failures, and `bun build --target=bun src/main.ts` succeeds.
- Broker stays dependency-free; fixed argv only; no shell string.
- S17 paths: `broker/src/**`, `opencode/plugins/**`, `opencode/config-fragments/**`,
  `opencode/plugins-v2/config-fragments/**`. `sandbox_apply` refuses them; land through
  `host_sandbox_result_install`, and the owner commits.
- Risk item 2/3: a Codex review before merge. Stop at installed-and-verified.
- No push, no broker restart, no install into `~/.config`.

## Acceptance criteria

- A worktree is created at `<root>/<project>/<name>` from `repoDir` at `base`, on the new branch
  `branch`, verified by HEAD and symbolic-ref.
- The created path resolves as `<rootID>~<project>~<name>` through `resolveProjectID`, and
  `findProject` returns it; `gitDirFor` returns its linked git directory.
- `gitHead` on the new path reports `branch` and `sha` — the "a session sees the new HEAD" check.
- Existing branch, existing target, missing project directory, unresolvable base, non-checkout
  `repoDir`, git-checkout `rootDir` and a non-orchestrator caller are all refused before mutation.
- Both fragments and the manifest carry the tool; the surface tests agree.

## Authorized scope

`broker/src/{types,validation,gitops,role-policy,service,server}.ts`, `broker/tests/**`,
`opencode/plugins/lib/{tool-specs-host-ops,host-tool-approval}.ts`,
`opencode/config-fragments/sandbox-permissions.jsonc`,
`opencode/plugins-v2/config-fragments/sandbox-permissions.jsonc`,
`docs/config-manifest-host-tools.md`, `docs/TODO.md`.

## Route and trigger evidence

- ROUTE: substantial feature | intent: authorized change | route: ODD secure / PM (`pm-odd`) →
  `planner` pre-code advice → `odd-apply` writer | specialist: `pm-odd` | basis: WORKFLOW.md.
- Triggers: mutation rule (all broker work is delegated); evidence budget (the broker sources
  exceed one inline batch).
- Owner decision: Q118 relayed 2026-11-10. Branch `refactor/p0-shared-tool-table` is explicitly
  NOT reused (Tier 2 answer, same day): its whole divergence from origin/master is four Q114
  worker-release paths, not staging work.

## Checks

Recorded per unit by the writer that runs them.

## Progress

- 2026-11-10: tracker created. No source edit yet.

## Next step

Dispatch W1 to `pm-odd` with this contract; W2 follows once W1 is installed and verified.

## Revisions
- r1 2026-11-10T14:33:05Z gentle-orchestrator: Create Q118 tracker: one supported worktree route from a named base
