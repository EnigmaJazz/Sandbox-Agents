# ODD task — host-git-branch

**Status:** implemented, installed and verified; commit + native review pending. Spec item **D33**. Contract fixed by the owner; a parallel agent writes permission rules against the same names, so `host_git_branch` / `gitBranch` must not be renamed.

## Objective

Add one host tool, `host_git_branch` (broker operation `gitBranch`), that creates a new local branch at a base commit, optionally switching to it, through a fixed argv vector. Never overwrites, deletes, force-moves, or touches a remote.

## Problem

The working rule requires a feature branch before substantial ODD work, and non-yolo parallel-worker mode needs `git switch -c`. With only `host_git_commit` and `host_git_push`, the orchestrator cannot create a branch without asking the owner to run Git by hand (`docs/TODO.md`, tier 2 open item 4 covers reads only).

## Scope

### Delivered surface

- `broker/src/types.ts` — `gitBranch` in the `Operation` union, in `SANDBOX_GUARD_CLASS` as `exempt-from-sandbox-guard`, and in the runtime `OPERATIONS` array (`operations-parity.test.ts` requires all three).
- `broker/src/validation.ts` — `gitBranch: ["projectDir", "name", "base", "switch"]` in `ALLOWED_PAYLOAD_KEYS`; `"gitBranch"` in `HOST_MUTATION_OPERATIONS` (which propagates to the identity matrix automatically, since `gentle-orchestrator` is `HOST_MUTATION_OPERATIONS` minus `taskMark`).
- `broker/src/role-policy.ts` — `gitBranch: "MUTATE_PROJECT"` and `host_git_branch: "HOST_APPROVED_MUTATION"`.
- `broker/src/gitops.ts` — pure `buildGitBranchArgv({ name, base, switchBranch })`.
- `broker/src/service.ts` — `buildGitBranchOp`.
- `broker/src/server.ts` — dispatch case.
- `opencode/plugins/lib/tool-specs-host-ops.ts` — `host_git_branch` tool with exactly one `ctx.ask`.
- `opencode/plugins/lib/host-tool-approval.ts` — `buildGitBranchAsk`.
- `opencode/config-fragments/sandbox-permissions.jsonc` and `opencode/plugins-v2/config-fragments/sandbox-permissions.jsonc` — `"host_git_branch": "ask"`.
- `docs/config-manifest-host-tools.md` — §4 ASK list, §5 inventory arithmetic (34 tools: 13 `sandbox_*` + 21 host) and the §5a row.
- `docs/TODO.md` — item 19 marked IMPLEMENTED with the delivered shape.
- Tests: `gitops.test.ts`, `service-host-tools.test.ts`, `host-tool-approval.test.ts`, `sandbox-tools-surface.test.ts`, `sandbox-tools-call-sweep.test.ts`, `v2-config-fragments.test.ts`, and the regenerated fixture `fixtures/sandbox-tools-surface.json`.

### Behaviour (fixed contract, as delivered)

1. `authorizeHostDispatch(ctx, "gitBranch", req.sessionID, req.agent)` runs FIRST, before payload validation — an unauthorized caller cannot probe the payload surface.
2. `resolveCanonicalProjectRoot(ctx, payload.projectDir)` — approved root only.
3. Payload: `name` (required, `assertGitBranch`), `base` (optional, default `HEAD`), `switch` (optional boolean). Exact-key validation; unknown keys refused.
4. Base resolution: `git rev-parse --verify --quiet <base>^{commit}`; non-zero status or non-40-hex output refuses.
5. Existing-branch refusal: `git show-ref --verify --quiet refs/heads/<name>` — status 0 refuses before any mutation; status 1 means absent; any other status fails closed.
6. Fixed argv: `["git","branch",name,sha]`, or `["git","switch","-c",name,sha]` when `switch` is true.
7. Post-condition: `git rev-parse --verify refs/heads/<name>^{commit}` must equal the resolved base; with `switch: true`, HEAD must also be the new branch. Otherwise fail closed.
8. Bounded, redacted output via `capAndRedact` / `GIT_OUTPUT_MAX_BYTES`.
9. Approval class matches `host_git_commit`: fragment `ask` plus one in-tool `ctx.ask`, metadata `{ name, base, switch }`.

### Non-goals (unchanged)

Deleting, renaming or force-moving a branch; `--force`/`-f`; remote creation, push or tracking setup; switching to an existing branch without creating; listing branches.

## Constraints

- Fixed argv vectors only; no shell string.
- S17 paths: `broker/src/**`, `opencode/plugins/**`, `opencode/config-fragments/**`. `sandbox_apply` refuses them; the landing path was `host_sandbox_result_install` from the reviewed result ref.
- Broker stays dependency-free.
- Test-first: RED observed before implementation.
- No deploy, mirror to `~/.config`, or service restart.

## Acceptance criteria — outcome

- Creates at `HEAD` by default and at an explicit base: **met** (unit tests + builder argv).
- `switch: true` uses one fixed `git switch -c`: **met**.
- Existing branch, invalid name, flag-shaped/unresolvable base, unknown payload key, non-orchestrator caller all refused: **met**.
- Plugin surface 52 tools / 25 asking; both fragments carry `host_git_branch: ask`: **met**.
- Suite green apart from the known `tests/v2-launch.test.ts:94` failure; build compiles: **met** (see Evidence).

## Route and trigger evidence

### Attempt 1 (2026-11-06, superseded)

ROUTE: substantial feature | ODD secure / direct delegated writer | `pr-comment-resolver`. Recorded environment deviation: `pm-odd`, `pm-systematic`, `odd-apply`, `gentle-ai-worker` and the `advisor-*` agents were believed not registered; the owner-authored fixed contract was treated as the design authority. Tracker created before the first source edit. No implementation landed in this attempt.

### Attempt 2 — Orca dispatch (2026-11-06)

ROUTE: substantial feature | intent: authorized change | route: ODD secure / PM (`pm-odd`) | specialist: `pm-odd` → `planner` (pre-code advice) → `odd-apply` (writer) | basis: WORKFLOW.md.

- Authorization: the Orca dispatch authorizes `host_git_branch` under spec D33 and supersedes `odd/tasks/host-archive-and-branch-tools.md`, which left branch unit B deferred.
- Worktree: `/home/james/ai-workspace/worktrees/agent-sandbox-integration/host-git-branch`, branch `feat/host-git-branch`, merged with current master.
- Unit-start HEAD: `c2615451e9a26f0ee588cae31d794abd13977746` (after the tracker-only commit).
- **Pre-code advice actually ran.** `pm-odd` dispatched `planner` by literal agent name in the foreground (session `ses_e4cee5057ffejW1lIf5FrvwTXN`). It returned six source-cited findings: the `gitguard` `switch` gap (out of scope), `OPERATIONS`-array parity, the `HostMutationOperation` union addition, authorize-before-payload ordering, fail-closed precision items, and a missing executable plugin-execution test. The in-scope items were forwarded verbatim into the writer brief.
- Availability correction: from the `pm-odd` surface `planner` IS dispatchable; `pr-comment-resolver` and `general` are refused there with `Permission denied: subagent`; `odd-apply` is the working writer there. This corrects the attempt-1 assumption.
- Frozen prior draft (`refs/opencode-sandbox/result/ses_e4dd0b405ffe6cUen4IHE6EQRR`, commit `47d9a9d`) was never installed: unreviewed and not bound to this worktree project.

## Review-size exception

**`review-size-exception` (recorded before the commit).** Technical reason: the change is one indivisible host-operation behaviour — `Operation` union + guard map + runtime `OPERATIONS`, payload allowlist, identity classification, argv builder, service handler, server dispatch, plugin tool, approval metadata, both permission fragments, the two docs and seven test files cannot be split without leaving the surface inconsistent (a tool registered without its permission rule, or a payload key without its handler, is a live defect). Measured on the exported result: **501 authored changed lines** (added 501 / removed 0 across 19 paths; `patchBytes` 41 708) against the 400-line default cap. The native START guard remains the authority.

## Evidence

- Controlled baseline (`host_test_run` `broker-unit`, HEAD `ffe5fe7`, empty dirty set, digest `sha256:6e3a507c…f373975`): **1888 pass / 9 skip / 1 fail**.
- RED (writer, cwd `broker`): `bun test tests/gitops.test.ts tests/service-host-tools.test.ts tests/host-tool-approval.test.ts` → `Export named 'buildGitBranchArgv' not found`, `buildGitBranchOp is not defined`, `buildGitBranchAsk is not defined`.
- Writer GREEN: focused 4-file run 140 pass / 0 fail (15 new tests); surface + call-sweep 6 pass / 0 fail; fixture regenerated with `env SANDBOX_TOOLS_SURFACE_WRITE=1 bun test tests/sandbox-tools-surface.test.ts`.
- Result ref: `refs/opencode-sandbox/result/ses_e4cebd141ffezmNCI8xC6B60qn`, commit `7a7d208a6a64424f9302ee1c855431f17144b4cd`, 19 paths, no deletions, `authoredChangedLines` 501.
- Installed via `host_sandbox_result_install` (19 paths restored from that exact result commit; nothing else touched).
- **Final suite on the installed tree** (`host_test_run` `broker-unit`, HEAD `c261545`, dirty = the 19 paths, digest `sha256:0ee0daaa…48000e68`): **1903 pass / 9 skip / 1 fail**, 8703 expect() calls, 107 files. Delta +15 tests.
- Final failing-test list (exactly one): `tests/v2-launch.test.ts:94` — "V2 nono profile > reaches the same hosts and project roots as V1, with the same isolation" (`platform.claude.com` extra allow-domain from the owner's uncommitted nono profile). Identical to baseline; untouched by this change.
- Build: `bun build --target=bun src/main.ts` (cwd `broker`) → exit 0, `Bundled 37 modules in 14ms`, observed by the writer on result commit `7a7d208`; the install restored exactly those bytes, so the installed tree is byte-identical to what was built. Not re-executed from the orchestrator (no build runner is configured for `host_test_run`).

## Deviations, recorded rather than papered over

1. The fixed contract's "Appendix A.2" does not exist in this checkout (the file ends at §8); the writer mirrored every `host_git_push` occurrence instead — §4 ASK list and the §5a row.
2. No standalone plugin ask-order test exists and it is outside the allowed surfaces; coverage is the fixture `asks: 1` plus the call sweep.
3. Approval metadata stores `switch` as a boolean, per the contract `{ name, base, switch }`.
4. `gitBranch` was also added to the runtime `OPERATIONS` array — required by `operations-parity.test.ts`; a necessary completion, not a redesign.
5. `buildGitBranchArgv` validates the resolved base with `assertGitBranch` (strictly stricter) and `switch: true` additionally verifies HEAD equals the requested branch. Both are fail-closed tightenings.
6. Post-code advisory (`advisor-*-post`) and `ce:review` are not dispatchable from this surface; the pre-code planner pass is the only advisory evidence. No independent verifier was dispatched (substantial-feature budget owes none absent a named security boundary; the code is security-adjacent but the pre-code planner covered it).

## Progress

| Item | Status | Notes |
|------|--------|-------|
| Tracker | done | Created before the first source edit |
| Tests (RED) | done | RED output captured above |
| Implementation | done | `buildGitBranchOp` + argv builder + dispatch |
| Docs + fragments + fixture | done | 34-tool arithmetic; both fragments `ask` |
| Suite + build | done | 1903/9/1 on installed tree; build exit 0 |
| Commit | pending | review-size-exception recorded above |
| Native review | pending | RDD `on` (global); assess after the commit |

## Log

- 2026-11-06: tracker created after the broker worktree fix; RDD `on` (global).
- 2026-11-06: attempt 2 under an Orca dispatch. Baseline 1888/9/1 at HEAD `ffe5fe7`.
- 2026-11-06: `planner` pre-code advice ran from `pm-odd`; writer `odd-apply` produced result `7a7d208`; installed; suite 1903/9/1; build exit 0.

## Next step

Commit the installed result as one work unit, then assess native review against the committed candidate.


## Revisions
- r1 2026-11-06T18:46:14Z gentle-orchestrator: Create tracker for the host_git_branch host tool (spec D33)
- r2 2026-11-06T22:48:22Z gentle-orchestrator: Attempt 2: Orca dispatch, pm-odd route, baseline recorded
- r3 2026-11-06T23:22:47Z gentle-orchestrator: Implementation verified; review-size exception recorded
