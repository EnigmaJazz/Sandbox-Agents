# ODD task — host-git-exec-hardening

## Objective
Close the confirmed host-side git execution exposure at its single choke point so the unconfined broker can no longer execute a command that the confined OpenCode process wrote into a repository — without changing trusted global-config behavior.

## Problem (verified 2026-10-15)
The confined OpenCode process can write `<project>/.git` read-write (`nono/profile/opencode-secure.json:58`, `filesystem.allow`; the user confirmed nono is enforced), and the unconfined broker runs host `git` against that repository with no neutralization. Every host git spawn funnels through `spawnArgv` (`broker/src/msb.ts:56-97`), whose env at `:65` is `opts.env ? { ...process.env, ...opts.env } : process.env` — a merge, never a replacement, and never a git-config override. The single construction point is `broker/src/server.ts:401` (`ctx.git.spawn`), shared by `hostRead` (`:402`), `sddRuntime` (`:409`) and all git call sites. `broker/src` contains 0 occurrences of `GIT_CONFIG_NOSYSTEM|GIT_CONFIG_GLOBAL|fsmonitor|hooksPath|no-ext-diff|no-textconv` (positive control: `GIT_CONFIG_COUNT` matches `service.ts:1583,1794,1811,1825,1842,1858`, `reaper.ts:472`, `config.ts:377`).

Reachable command-execution mechanisms under the unconfined broker (path scoping does NOT mitigate — hooks, fsmonitor and filters are global repository config, independent of which paths are staged):
- `git add` (`service.ts:2091`; commit path `gitops.ts:399`) — `post-index-change` hook, `core.fsmonitor`, `filter.*.clean`
- `git commit` (`gitops.ts:400`, no `--no-verify`) — `pre-commit` / `commit-msg` / `post-commit` hooks, fsmonitor, clean filter
- `git push` (`gitops.ts:443`) — `pre-push` hook
- `git restore --worktree` (`sandboxResultInstall`) — `smudge` / `process` filters
- `git diff` (7 sites: `service.ts:1981,2130,2160,2172,2202,2824,2895`) — `diff.<d>.command`, `textconv`
- `git fetch` (`:1885`), `git update-ref -d` (`:2294`) — `reference-transaction` hook
- `rev-parse` / `ls-files` / `ls-tree` / `write-tree` / `log` / `bundle` / `show` — nothing reachable

`broker/tests` asserts git ARGV only, never the environment (positive control: those files do assert argv). The exposure is therefore completely untested.

`docs/threat-model.md:98` grants `<project>/.git` read-write and calls it "a deliberate, earned boundary decision" for the reviewer transport; that decision was made without any hook/fsmonitor/filter analysis, and the only hook analysis in the repo (`docs/threat-model.md:161-163`) is scoped to the worker, not the broker's host git calls.

## Authorized posture (user decision, 2026-10-15)
**Scoped**: neutralize the REPOSITORY-LOCAL execution vectors and fail closed on execution-bearing local config. The user's global config is trusted and NOT agent-writable, so `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null` are deliberately NOT used — the global config stays in force so that `credential.helper`, `url.*.insteadOf`, `core.sshCommand`, LFS filter drivers and `commit.gpgsign` keep working.

## Scope
Edits: `broker/src/msb.ts` (the choke point), `broker/src/gitops.ts` (git argv builders), a new `broker/src/gitguard.ts` if the guard needs its own module, `broker/tests/**`, `docs/threat-model.md`.
Out of scope — must NOT change: the worker environment allowlist (`broker/src/config.ts:366-382`) must not be broadened; worker git runs through `MsbAdapter.exec` inside the VM and is not the vector; `hostread.ts` (absolute binary paths) and `sddRuntime` (the `gentle-ai` Go binary) are not git and must be unaffected.

## Constraints
- S17: `broker/src/**` and `docs/threat-model.md` — `sandbox_apply` and `host_git_commit` refuse these; the result lands through the approval-gated host install and the owner commits by hand.
- Broker stays dependency-free (bun:test + node builtins).
- Security style: explicit types, allowlists, argv vectors, fail closed, no implicit fallback.
- Do NOT use `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` env for the neutralization: `spawnArgv`'s merge order lets a call site's own `GIT_CONFIG_COUNT` (`safe.directory` at `service.ts:1583,1794,1811,1825,1842,1858`, `reaper.ts:472`) either win and cancel the neutralization, or lose its `safe.directory` pair and break worker git with "dubious ownership". Prepend command-line `-c` instead.
- The fix is behavioral: no unrelated refactors, no reformatting.

## Tasks
- **T1 — Empirical probe (RED first).** Build a temp git repo containing three marker-writers — (a) `.git/hooks/pre-commit`, (b) a repo-LOCAL `filter.<name>.clean` with a matching worktree `.gitattributes`, (c) a repo-local `core.fsmonitor` command — then exercise the broker's git invocation path and RECORD which markers appear with no neutralization. This establishes the reachable set as executed fact rather than documentation. Report the table.
- **T2 — Neutralize at the choke point.** In `spawnArgv`, keyed on `basename(argv[0]) === "git"` (callers pass the bare `"git"`; the docstring's absolute-path claim does not hold), splice `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.pager=cat` in BEFORE the subcommand (index 1, after the binary). Exclude `git-lfs` and similar names. Cover every git call site in one edit.
- **T3 — Fail-closed local-config guard.** Before spawning an execution-bearing git subcommand, resolve the repository-local config WITHOUT invoking git and refuse with a named error when it defines a key that `-c` cannot override — at minimum `filter.*.clean|smudge|process|required`, `diff.*.command|textconv`, `include.path`, `includeIf.*.path`, `core.gitProxy`, `submodule.*.command`. Resolve the git dir honoring `GIT_DIR` in `opts.env` (the synthetic paths pass `{ GIT_DIR: <repo>/.git }`), a `.git` FILE containing a `gitdir:` pointer (linked worktrees), and `commondir`. Apply the guard only to the execution-bearing subcommands (`add`, `commit`, `push`, `restore`, `checkout`, `diff`, `fetch`, `update-ref`, `apply`, `merge`, `rebase`, `reset`); read-only plumbing needs no guard. Where the git dir cannot be resolved for an execution-bearing subcommand, fail closed.
- **T4 — Commit identity.** Supply the broker's own deterministic author/committer identity for the commit spawn, matching the existing synthetic convention (`GIT_AUTHOR_NAME=opencode-sandbox`, `GIT_AUTHOR_EMAIL=sandbox@local`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`; see `service.ts:809-812`). `buildGitCommitArgv` (`gitops.ts:394-402`) currently supplies none, so a repo without local `user.name` would fail once any config change affects identity.
- **T5 — Keep existing assertions honest.** Update the tests that assert exact git argv (`broker/tests/service-git-commit-session.test.ts:232` and any sibling) to the new vectors. Do NOT change worker-side argv assertions — worker git does not pass through `spawnArgv`.
- **T6 — Non-vacuous regression tests.** Every T1 marker must remain ABSENT after the fix, asserted on real files, so reverting the neutralization re-creates the marker and fails the test. Add: a local `filter.*` config produces the named refusal; an execution-bearing subcommand with an unresolvable git dir fails closed; a benign global-config value is still honored (proving the scoped posture did not over-neutralize).
- **T7 — Correct the threat model.** Rewrite `docs/threat-model.md:98` and the related checklist lines (`:161-163`) to record the analyzed risk, the mitigations, the scoped posture and its rationale, and the residual risk (a repo-local execution-bearing key now causes a refusal rather than silent execution).
- **T8 — Records.** Update this tracker's Progress, and record the unit in `ROUTER-LOG.md` following that file's existing row format.

## Acceptance criteria
1. Every T1 marker is absent when the hardened path runs, and present again if the neutralization is reverted.
2. A local config defining `filter.*`/`diff.*.command`/`include.path` produces a named refusal before any git process spawns.
3. The global config is still honored (no over-neutralization).
4. `bun --cwd broker test --reporter=dot` — baseline 875 pass / 0 fail, must stay 0 fail.
5. From `broker`: `bun build --target=bun src/main.ts` succeeds.
6. `docs/threat-model.md` no longer asserts the `.git` grant as safe without the hook/filter analysis.

## Checks
- Focused: `bun --cwd broker test --reporter=dot` on the changed test files.
- Full: `bun --cwd broker test --reporter=dot`.
- Build: from `broker`, `bun build --target=bun src/main.ts`.
- `sandbox_bash` is argv-only (no pipes, redirects, globs, `&&`).

## Route and pre-code advice
Route: authorized change (security fix), ODD, delegated. Triggers: mutation, execution, preparation, route declaration.
Pre-code advice (two internal first-pass advisors, plus two independent external engines — Claude and Antigravity — consulted by the owner):
- Both external engines independently identified the same escape class and converged on neutralizing git config at the choke point, with the broker never running a helper or git command from an agent-writable location.
- `advisor-integration-pre` supplied must-fixes T2-T5 above: the `GIT_CONFIG_COUNT` merge-order trap, the missing commit identity, the argv-assertion breakage, the `basename` predicate, and the push-auth/global-config consequence.
- `advisor-security-pre` returned EXTERNAL_CONTEXT_REQUIRED (authoritative git precedence and hook/filter semantics). Resolved empirically by T1 instead of by documentation, since executed behavior is the stronger evidence.
- `advisor-design-pre` returned EXTERNAL_CONTEXT_REQUIRED for the installed Systematic helper contract; that evidence is held by the orchestrator and the design questions are recorded with the pipeline-tools unit, not this one.

## Progress
- 2026-10-15 — tracker created; implementation not started.
- 2026-10-16 — **Unit 1 delivered** (commit `91cd914`, 7 files, +869/−17): the
  choke-point neutralization (`-c core.hooksPath=/dev/null -c
  core.fsmonitor=false -c core.pager=cat`), the fail-closed repository-local
  config guard, and the deterministic commit identity. Native review
  **lineage `review-6ce3226ef4a426ec` — approved, 0 blocking findings, authority
  burned**; consumed revision
  `sha256:6b37adb282fe2a000e136aad4ce4a9ba82c35b57a570c5f0ca1e3c1af7b7dda8`;
  four lenses (risk / resilience / readability / reliability). Seven advisory
  findings, with disposition:
  - `R3-001` — `isExecutionBearingLocalKey` branches (`credential.helper`,
    `merge.*.driver`, `gpg.program`, `submodule.*.command`, `sequence.editor`,
    `core.editor`, `core.askpass`, `core.gitproxy`) were unexercised: **fixed in
    unit 2** (table-driven test over every branch).
  - `R3-002` — repo-local pager neutralization was unobserved: **fixed in unit
    2** (resolved-config-value test; a marker probe would be vacuous because git
    never launches a pager on the non-tty pipes `spawnArgv` uses).
  - `R3-003` — advisory recorded as a **documented residual** (see the native
    review record `review-6ce3226ef4a426ec`).
  - `R4-001` — the module header over-claimed that LFS filter drivers keep
    working: **fixed in unit 2** (only GLOBALLY scoped filters keep working; a
    repo-local filter is refused).
  - `R4-002` — `WARNING`, a real fail-open: the guard resolved only
    `opts.env.GIT_DIR` while the child merged `process.env`, so the guard could
    inspect a different repository than git reads: **fixed in unit 2**.
  - `R4-003` — caller `-c`/`-C` could defeat the neutralization splice:
    **fixed in unit 2**.
  - `R4-004` — remote-helper/shell remote transports were not covered:
    **fixed in unit 2** (value-aware allowlist guard).
- 2026-10-16 — **Unit 2 delivered** (uncommitted; exported as a sandbox result):
  - O1 guard/child environment invariant (`GIT_DIR`, `GIT_COMMON_DIR` resolved
    from the same effective environment the child receives);
  - O2 caller `-c`/`-C` override refusal (global-option region only);
  - O3 value-aware remote-transport allowlist guard;
  - O4 honest module header;
  - O5 R3-001/R3-002 tests;
  - O6 commit-failure message names the real subcommand;
  - O7 threat-model rewrite (`.git` analysis + host-git checklist);
  - O8 these records.
  - Focused `bun --cwd broker test --reporter=dot tests/host-git-guard-u2.test.ts`
    → 21 pass / 0 fail (RED before the fixes: 8 pass / 13 fail).

## Next step
T1: build the empirical probe and record which markers execute with no neutralization.
