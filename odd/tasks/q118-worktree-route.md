# ODD Tasks — q118-worktree-route

- **Feature:** `q118-worktree-route`
- **Project:** `sandbox-integration`
- **Status:** **BLOCKED — W1 candidate is NOT installable.** Applied to the worktree, tests green, but a post-code security review found three blockers and one functional defect. Nothing committed; W2 not started.
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

The consumption half already exists and needs no change: `resolveWorktreeAwareRoot`
(validation.ts:1401) accepts exactly `<root>/<project>/<name>` under a registered root that is not
itself a checkout; `resolveProjectID` (validation.ts:1488) returns the virtual id
`<rootID>~<project>~<name>` and `findProject` (validation.ts:1420) resolves it back; `gitDirFor`
(validation.ts:1468) verifies a linked worktree's `.git` pointer against git's own back-link;
`resolveCanonicalProjectRoot` (service.ts:3567) therefore accepts the worktree for every host
tool. Nothing creates the worktree. That is the whole gap.

## Findings (2026-11-10)

- **A `pm-odd` session holds `host_git_branch` and `host_git_head`.** Observed from its granted
  function list; `host_git_head` was callable with no arguments and returned branch
  `feat/q102-p0-staging`, `detached: false`. So "delegate branch creation to a PM" is live, but it
  is a one-way door: `host_git_branch` is create-only by contract (D33), and `switch: true` would
  strand a shared checkout on the new branch with no supported switch-back. A worktree carries its
  own HEAD and does not have that problem.
- **The `pm-odd` lane cannot run the ODD writer chain in this worktree.** Its subagent surface
  permits only `explore`, `gentle-ai-verify` and `gentle-ai-verify-routine`; `planner` and
  `odd-apply` are not dispatchable targets. The PM returned BLOCKED with zero mutation. This is
  the known **Q105 (hidden Planner)** issue in `workflow_optimisation`; recorded, not worked
  around. The coordinator accepted a direct-writer degradation for W1.
- **`host_plan_write` moves the branch HEAD.** Creating this tracker wrote metadata commit
  `ff99a5a` after the unit-start anchor had been captured at `b7e2b48`, so the first PM run
  blocked with `UNIT_START_ANCHOR_MISMATCH`. Capture the anchor after the tracker commit.
- **Q102 P0 is not fully clear.** P0 docs and the preflight spike are closed (T1, `88bc5dc`,
  owner-approved 2026-11-07), but OPEN-1 (where the review runs) is still an owner decision, no
  real state directory is chosen, the sandbox is DENIED the hypothetical state directory so a
  shared clone needs a profile read grant, and `start`/`capture`/`acknowledge` on a clone stays
  unverified until an owner-consented run. D37 forbids an agent starting it.

## Scope

### Unit W1 — broker core — CANDIDATE APPLIED, NOT INSTALLABLE

Delivered in the worktree as result `ses_e39f89a04ffe0VNbzjPjWjI61h`, commit `918eca65`, 291
authored changed lines across nine paths: `broker/src/{gitops,role-policy,server,service,types,
validation}.ts` and `broker/tests/{gitops.test,service-host-tools.test,worktree-op.test}.ts`.

Behaviour: `gitWorktree` creates `git worktree add -b <branch> <root>/<project>/<name> <sha>`,
authorizing first, resolving `repoDir` through `resolveCanonicalProjectRoot`, requiring `rootDir`
to be an exact registered non-checkout root, refusing an existing target or branch, an
unresolvable or flag-shaped base, a non-checkout `repoDir`, a checkout `rootDir`, and a project
directory resolving outside the root; then verifying HEAD, symbolic-ref and project routing.

### Unit W2 — plugin surface and docs — NOT STARTED

`opencode/plugins/lib/tool-specs-host-ops.ts` (`host_git_worktree`, one `ctx.ask`),
`host-tool-approval.ts` (`buildGitWorktreeAsk`), both `sandbox-permissions.jsonc` fragments
(`"host_git_worktree": "ask"`), `docs/config-manifest-host-tools.md`, `docs/TODO.md`, surface and
call-sweep tests plus the regenerated fixture.

### Non-goals

Deleting, moving, pruning or repairing worktrees; `--force`, `--detach`, `--orphan`, `--porcelain`;
remote creation, fetch or push; switching an existing checkout; changing registered roots; any
profile or sandbox grant change.

## Post-code security review (2026-11-10) — BLOCKERS

Independent read-only `security-reviewer` pass over the applied diff. I verified the two decisive
claims against `broker/src/gitguard.ts` myself.

1. **BLOCKER — smudge/process filter execution.** `GIT_EXECUTION_SUBCOMMANDS`
   (gitguard.ts:117-131) lists `checkout` and `switch` because checking out a tree runs the
   repository's smudge/process filters, but **`worktree` is absent**. `git worktree add` checks out
   a tree, so it runs those filters as the unconfined broker, and
   `assertRepositoryLocalConfigSafe` is never applied. Smallest fix: classify `worktree` as
   execution-bearing at the shared choke point.
2. **BLOCKER — post-conditions always throw in production.** `assertNoCallerConfigOverride`
   (gitguard.ts:226) refuses any caller-supplied global `-C`. The post-creation checks use
   `["git","-C",target,...]`, so every successful creation would fail verification and leave the
   worktree behind. The tests pass only because `worktree-op.test.ts:49-53` spawns `Bun.spawn`
   directly and bypasses production hardening. Fix: run the destination checks with `cwd: target`
   and no `-C`.
3. **BLOCKER — destination inside an existing checkout.** `assertWorktreeTarget` checks
   containment and absence but not that `<root>/<project>` is itself a checkout or an
   inside-root alias into one. A source repository can therefore check its tree out into an
   existing checkout's subtree, creating protected content before the routing post-condition
   refuses.
4. **BLOCKER — validated repository identity discarded.** `gitDirFor(repoDir)` is called and its
   result thrown away; later commands rediscover the repository. For a linked worktree whose
   `.git` pointer can be rewritten, the branch and worktree metadata can land in a foreign
   repository after validation.

Reviewer also flagged as non-blocking: TOCTOU on canonical parents between the existence check and
the spawn; post-creation refusal does not roll back; the tests bypass production hardening.

## Verification actually observed

- `bun test tests/worktree-op.test.ts tests/gitops.test.ts`: 48 pass, 0 fail (writer-observed).
- `host_test_run runner=broker-unit` on the installed tree at `gitHead ff99a5a`: **2014 pass,
  9 skip, 2 fail**, 9383 expect calls, 2025 tests across 110 files, exit 1. Both failures are the
  known pre-existing `tests/v2-launch.test.ts:64` and `:94` profile-drift assertions; this diff
  touches no profile.
- `bun build --target=bun src/main.ts`: succeeded (writer-observed).
- `host_git_commit` refuses: `refusing to commit protected paths (S17): broker/src/gitops.ts,
  broker/src/role-policy.ts, broker/src/server.ts, broker/src/service.ts, broker/src/types.ts,
  broker/src/validation.ts`. The owner commits S17 bytes.
- Green tests do not clear blockers 1-3: they exercise a fake spawn, not the production choke
  point.

## Constraints

- Test-first; RED observed before implementation.
- `cd broker && bun test` green apart from the two known `tests/v2-launch.test.ts` profile-drift
  failures, and `bun build --target=bun src/main.ts` succeeds.
- Broker stays dependency-free; fixed argv only; no shell string.
- S17 paths: `broker/src/**`, `opencode/plugins/**`, `opencode/config-fragments/**`,
  `opencode/plugins-v2/config-fragments/**`. `sandbox_apply` refuses them; land through
  `host_sandbox_result_install`, and the owner commits.
- Risk item 2/3: a Codex review before merge. The agent cannot commit S17 paths.
- No push, no broker restart, no install into `~/.config`.

## Route and trigger evidence

- ROUTE: substantial feature | intent: authorized change | route: ODD secure / PM (`pm-odd`) →
  `planner` pre-code advice → `odd-apply` writer | specialist: `pm-odd` | basis: WORKFLOW.md.
- Recorded deviation (coordinator-accepted): the `pm-odd` lane could not dispatch `planner` or
  `odd-apply` (Q105), so W1 ran as a direct delegated `general` writer with the same fixed
  contract. Pre-code advice was therefore not obtained — which is exactly where blockers 1 and 3
  would most likely have been caught.
- Owner decision: Q118 relayed 2026-11-10. Branch `refactor/p0-shared-tool-table` is explicitly
  NOT reused: its whole divergence from origin/master is four Q114 worker-release paths.

## Progress

- 2026-11-10: tracker created (r1, `ff99a5a`).
- 2026-11-10: W1 dispatched to `pm-odd`; blocked twice (stale anchor, then missing dispatch
  authority). Degraded to a direct `general` writer.
- 2026-11-10: W1 written; one correction round spent closing a symlink containment hole found in
  my own review; applied to the worktree; full suite run through `host_test_run`.
- 2026-11-10: `host_git_commit` refused the S17 paths, as designed.
- 2026-11-10: independent security review returned three blockers plus one functional defect.
  Candidate is not installable.

## Open questions

1. **Authorization for one further correction round.** The unit's single correction was spent on
   the symlink hole; the review blockers arrived after it. Policy does not grant a second round
   without an explicit decision.
2. Should `worktree` join `GIT_EXECUTION_SUBCOMMANDS` wholesale, or be classified per subcommand so
   `git worktree list` stays unguarded?
3. W2 needs an owner decision on the installed-plugin path: `host_git_branch`/`host_git_head` are
   already absent from the retained-master surface although both are committed and granted, so a
   new tool may need a plugin reinstall and broker restart before any session can call it.

## Next step

Owner decision required. Either authorize one correction round covering blockers 1-4 (then Codex
review and commit), or revert the nine paths in the worktree with
`git checkout -- broker/src/gitops.ts broker/src/role-policy.ts broker/src/server.ts broker/src/service.ts broker/src/types.ts broker/src/validation.ts broker/tests/gitops.test.ts broker/tests/service-host-tools.test.ts` and remove the untracked `broker/tests/worktree-op.test.ts`.


## Revisions
- r1 2026-11-10T14:33:05Z gentle-orchestrator: Create Q118 tracker: one supported worktree route from a named base
- r2 2026-11-10T15:36:04Z gentle-orchestrator: Record W1 applied+verified, S17 commit refusal, Q105 PM-lane block and Q102 P0 gap
- r3 2026-11-10T15:45:23Z gentle-orchestrator: Record security review blockers; W1 candidate not installable
