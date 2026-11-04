# ODD task — host-archive-and-branch-tools

## Objective
Two missing host capabilities, requested by the owner 2026-11-01 and scheduled together 2026-11-04:

- **A** `host_plan_archive` — move a finished plan/ODD tracker into its `archive/` directory, so archiving no longer needs the owner to run `git mv` by hand.
- **B** `host_git_branch` — create and switch branches, completing the host git family that today covers commit and push only.

## Problem — evidence
**A.** `odd/tasks/**` is guarded by `BROKER_PLAN_ROOT_PROTECTION=1` (`systemd-user/broker.env:49` → `broker/src/service.ts:981-987`), so no sandbox worker may write there. `host_plan_write` replaces one document but cannot move a file. Result: every archive is an owner `git mv` block. This happened twice on 2026-11-01/02 — 13 trackers, then 4 — and each time the index had to be reconciled separately because the move and the index edit were two different acts.

**B.** `TOOL_CLASSIFICATION_INVENTORY` has `gitCommit`, `gitClearCommitIntent`, `gitPush`, `ghIssueCreate` (`broker/src/role-policy.ts:198`). There is no branch operation. Creating a feature branch or switching back to it is currently an owner shell command.

## Scope
In: `broker/src/types.ts` (operation union, sandbox-guard classification, any list the operation must join), `broker/src/validation.ts` (allowed payload fields), `broker/src/role-policy.ts` (classification), `broker/src/service.ts` (operation builders + authorization), `broker/src/server.ts` (dispatch cases), `opencode/plugins/lib/tool-specs-host-ops.ts` (tool definitions), `opencode/plugins/lib/host-tool-approval.ts` (approval metadata for the gated tool), `docs/config-manifest-host-tools.md`, and the broker tests.

Out: branch deletion, rename, force/`--discard-changes`, remote branch creation, `git worktree`, and anything that takes caller-chosen argv. Out of scope for A: deleting trackers (archive is a move, and the tracker is the record).

## Design — A: `host_plan_archive` (operation `planArchive`)
- Caller supplies `projectDir`, `target` (`tasks` | `mini`), `name`, `agent`, `note`.
- `name` validated by the existing `assertPlanDocWriteName`; `target` restricted to the same two roots `host_plan_write` accepts.
- Source `odd/<target>/<name>.md`; destination `odd/<target>/archive/<name>.md`. Both resolved through `resolveCanonicalProjectRoot` and asserted within the project root; `checkProtectedPaths` applied to both relative paths.
- Refusals, each named: source missing (`PLAN_ARCHIVE_SOURCE_MISSING`), destination exists (`PLAN_ARCHIVE_DESTINATION_EXISTS`), path escape, protected path, bad name or target.
- The move is a filesystem rename under the existing plan-doc lock, followed by the same commit path `planDocWrite` uses, with message `docs(odd): archive <target>/<name>`. Git records it as a rename on commit; nothing else needs to change.
- **Authorization mirrors `planDocWrite`**: `authorizeHostDispatch(..., "planArchive", ..., "plan-writer")`, and the payload `agent` must equal the bound session identity, with the same allowed-agent list. **No approval prompt**, matching `host_plan_write`, because the revision/commit record is the compensating control and the operation is a same-repository move.
- `classifyOperation("planArchive")` — classified `MUTATE_PROJECT`, same as `planDocWrite`, so the sandbox guard treats it identically.

## Design — B: `host_git_branch` (operation `gitBranch`)
- One tool, explicit `action`: `"create"` | `"switch"`. Two actions, one validated shape, no free-form argv.
- `create` runs `git switch -c <name>`; `switch` runs `git switch <name>`. Both from the resolved project root with the hardened git environment the git family already uses.
- Branch-name validation before spawn: refuse a leading `-`, whitespace, control characters, and the sequences `..`, `~`, `^`, `:`, `?`, `*`, `[`, `\`, `@{`, a trailing `/` or `.lock`, and a name that is `@`. Length cap 255 bytes. Refuse `HEAD` and detached-HEAD spellings. On any doubt, refuse — the name is the only caller-controlled value and it lands in argv.
- Refuse before spawning when: the branch already exists (`create`) or does not exist (`switch`), determined by `git rev-parse --verify refs/heads/<name>` rather than by parsing `switch` output.
- **Approval: yes.** `host_git_commit` and `host_git_push` are approval-gated because they move the repository; switching branches rewrites the working tree, so it takes the same gate. Approval metadata names the branch and the action.
- `classifyOperation("gitBranch")` — `MUTATE_PROJECT`, joining the other git mutations.
- Explicitly out: `-f`, `--force`, `--discard-changes`, `-d`/`-D`, `-m`, `--orphan`, remote tracking setup, and any second positional argument.

## Constraints
- `broker/src/**` and `opencode/plugins/**` are S17: sandbox writes, reviewed host install, owner commit.
- Fail closed: unknown action, name, or state refuses with a named code; no fallback to a shell string; argv vectors only.
- No widening of the git guard, the plan-root protection, or the protected-path lists.
- Test-first for both units.

## Stable task IDs
- **A1** operation wiring for `planArchive` (types, validation, classification, server dispatch).
- **A2** `planArchive` implementation and the move/commit path.
- **A3** A tests: archive a tracker, refuse the five named conditions, confirm the commit message and that the source no longer exists.
- **B1** operation wiring for `gitBranch`.
- **B2** branch-name validator with its refusal table.
- **B3** `gitBranch` implementation: create, switch, refusals, approval metadata.
- **B4** B tests: create succeeds, switch succeeds, existing/absent refusals, every bad name in the table refused before any spawn, and the tool refuses when the approval is absent.
- **C1** plugin tool definitions for both, plus docs.
- **C2** checks and receipts.

## Acceptance criteria
- Archiving `odd/tasks/x.md` leaves `odd/tasks/archive/x.md` committed and `odd/tasks/x.md` gone, in one operation, with no owner shell step.
- Archiving a name that does not exist, or one already archived, refuses with the named code and changes nothing.
- `host_git_branch` creates a branch from current HEAD, and switches to an existing branch, only after approval.
- Every name in the refusal table is refused before any process spawns; a test proves no spawn occurred.
- No branch deletion, rename, force, or discard path exists.
- The broker suite is green apart from the known `tests/v2-launch.test.ts:94` failure.

## Checks
- `bun --cwd broker test`, exact totals, RED before each implementation and GREEN after.
- From `broker`: `bun build --target=bun src/main.ts`.
- Diff stat per unit; reviewability receipt each (cap 400 authored lines and 100 KiB authored patch — **expect to split A and B into separate commits**).

## Route and trigger evidence
- Route: authorized change, ODD, delegated; two units, A then B, each its own commit.
- Task class: substantial feature with authorization and host-mutation effect.
- Writer: `general` (orchestrator dispatch, sandbox worker). Pre-code advice requested before implementation; post-code advisory review owed for both units.
- Native review: assess after each commit; a host-mutation surface will likely be due.

## Next step
Pre-code advice on this design, then writer unit A (A1–A3), install, commit, then unit B.


## Revisions
- r1 2026-11-04T09:58:46Z gentle-orchestrator: Create tracker for the archive and branch host tools
