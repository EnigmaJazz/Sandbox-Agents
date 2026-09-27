# TODO — agent-sandbox-integration

Last updated: 2026-09-22

## Delivered — agent-host-tools (updated 2026-09-22)

- Committed and merged into the default branch. Slice 1 (P0 SDD runtime host tools +
  authorization, 194 tests; OpenSpec artifacts under `openspec/changes/agent-host-tools/`),
  the git/gh tools, and project registration landed in `c0bf4dc`; the review/state
  corrections landed in `54743fc`…`b83c494` and were merged by `8ed9e96` ("merge review
  slice 1 with its corrections"); the apply-preview fail-closed guard and its installer
  carry-through landed in `df1b78f`/`6e0b37b`.
- Push to `origin`: **unverified** from a sandbox worker. The worker snapshot exposes only
  synthetic `work`/`baseline` refs and no remote, so host branch/remote state cannot be
  inspected here.
- Still open:
  - Remove `BROKER_REAP_INTERVAL_MS`.
  - Fix `runPrepare` forcing a refspec.
  - S17 manual review.
- Protected-list note: `BROKER_PROTECTED_SECURITY_FILES` in `systemd-user/broker.env`
  already carries the full protected list (byte-identical to
  `DEFAULT_PROTECTED_SECURITY_FILES` in `broker/src/config.ts`); only the bootstrap-window
  comment above it is stale. `systemd-user/broker.env` is S17, so that comment fix is
  user-installed.
- Historical blocker (2026-09-11): "SDD dispatch latched for the current session — continue
  in a NEW session." Resolved in practice — the agent-host-tools work subsequently completed
  and landed in later sessions (`c0bf4dc`, `8ed9e96`) — so the latch no longer blocks.
  Verify or drop.

## Priority principle — fixed host operations over user-pasted commands

Prefer fixed, approval-gated host operations over user-pasted commands — the human keeps
the decision, the typing goes away. Concrete candidates, in order:

1. `host_journal` — bounded user-journal read for allowlisted units
   (`odd/tasks/host-journal-tool.md`).
2. Host git reads — `status|diff|log|show|branch` (`odd/tasks/host-git-tools.md`).
3. Result-ref inspect and install — approval-gated, S17-aware (see the "Sandbox result-ref
   inspector" section below).
4. Worktree lifecycle plus the `projectId` selector (see the "Planned — worktree review and
   commit" section below).
5. The review-pipeline tools from `docs/PLAN.md` — `host_git_range_materialize`,
   `host_review_pipeline_run`, `host_review_artifact_write`, `host_git_read`.

## Completed

1. Copy-tool hardening (copy_in activation, copy_out source cap, env cap 200)
2. Global AGENTS.md host-side SDD guidance (copy_in/copy_out flow)
4. Worker test runners (bun + pytest in image, 9/9 copy-review)
6. Broker commits (feat(broker) + chore(sandbox))
7. Sync systemd-user/broker.env template (9 projects, S17 real list, binary line)
8. Host bun tests (117 pass) + build
9. Apply-review file flow (applyPreview op + 6/6 tests; live after restart)
11. Agent commit/push with authorization — `host_git_commit` and `host_git_push` exist and are in use (plugin tool + fragment `ask` + broker handler + fixed argv + tests)
17. Revert live S17 bootstrap relaxation (real list now live)
21. Idle-worker reaping + pool queue — clean/dirty reap (60s), queue park/progress/drain, operation-aware client timeout (exec 130s / ensureWorker 120s)

## Pending

3. File nono 0.74 loopback regression at nolabs-ai/nono (drafted)
5. Verify auto-update EACCES resolved (4 history files seeded, journal clean?)
10. Make sandbox_copy_out identical to apply: diff-style review file, no 200 hard cap for source targets
12. GitHub issue reporting with human oversight — `host_gh_issue_create` is implemented and wired (plugin tool + fragment `ask` + broker handler + fixed `gh issue create` argv + tests); the remaining item is a live, human-oversight issue creation, unverified live
13. Sandbox tool-definition pass (13 sandbox_* descriptions/schemas audit)
14. Web/network access for agents (github.com, websearch hosts in nono allow_domain)
16. Final security gate (manual-verification gates + AFT bypass finding + orchestrator staleness + file-mode finding)
19. AFT sandbox-state gating (deny host AFT post-activation)
20. Broker retained-result resume gap (RETAINED results are dead-ends)
22. OpenChamber E2E verification on nono 0.73 (all providers respond)
23. SDD runtime: verify BROKER_GENTLE_AI_BINARY in broker env + sdd-runtime tests on host
27. Superseded — tracked by `odd/tasks/register-project-profile-grants.md` T2, which cites this item: create + grant `<project>/.codegraph` in the nono profile for new projects (mirror the existing `.atl` helper) so CodeGraph can write its index inside secure OpenCode. The grant must be paired with directory creation: nono binds grants to existing paths at sandbox start and cannot create `.codegraph` itself.

## In-progress / parked

15. Role-based subagents SDD — Phase A (P0+A) code committed. The tracker's original commit `6118de1` no longer exists in history (reset, then re-applied as `b6a5f8c`, "restore 6118de1, 3-way merge"); the "159 tests" figure is unverified. Parked at Phase B (9 tasks: B.1-B.3 researcher/worker, C.1-C.3 advisor/deliberation, D.1-D.3 security gate)
18. Read-only orchestrator — part of Phase A (readOnlyAgents + plugin guard), code delivered, S17 pending

## New (2026-09-05)

24. sandbox_diff always shows 0 — buildRetainedDiff returns compare:'' while active-mode diff computes .new reference comparisons
25. sandbox_apply not giving the correct S17 failure message
26. runPrepare .broker-tmp mkdir + git bundle create status check (bites sandbox_bash-only writers)

## Sandbox result-ref inspector (host tool)

**Problem:** the orchestrator cannot inspect the content of a sandbox result ref
(`refs/opencode-sandbox/result/<sessionID>`). On 2026-09-20 a result import was rejected
non-fast-forward because a pre-reset export already held that session's ref, and confirming
whether the blocking ref contained the same work required the user to run `git show` and
`git diff` by hand.

**Proposed:** a read-only host operation (e.g. `host_sandbox_result`) that, for a session ID,
returns the ref's commit identity and timestamp, the changed-path list with per-file
added/removed counts, and the patch or a bounded excerpt. Fixed argv, no worker activation,
bounded output, S17-aware, read-only. A comparison mode (baseline vs result, or any two refs)
would cover the blocking-ref case directly.

**Acceptance:** the orchestrator can determine whether a blocking result ref matches the
intended change without any host shell, and can diff two refs itself.

## Backlog captured 2026-09-21

### 1. Bug fix (blocking another repo) — acknowledge-approved must carry `--lineage`

`host_review_acknowledge_approved` builds an incomplete argv: it does not forward
`--lineage` to `gentle-ai review acknowledge-approved`, and it exposes no parameters, so a
caller cannot supply the missing flag. Reported from a dependent repo where an approved
lineage (`action: execute`, `reason_code: approved_acknowledgement_required`) dead-ends —
the orchestrator has no host Bash by design, so the final step needs a human at the CLI.

Expected: forward all four provider-issued flags in the CLI's order —
`--lineage --target --expected-revision --token`.

Repository status: implemented as commit `80ae253` (unit 5 of the review batch), which emits
all four and refuses a missing value before spawning. **Live and verified (2026-09-21):** the
acknowledgement was executed through `host_review_acknowledge_approved` on the installed
stack, forwarding all four provider-issued flags, and it returned `action: acknowledged`.

### 2. Feature — readable `sandbox_apply` preview

The approval prompt currently shows a `ses_…` filename and a terse summary, which tells the
approver neither what the change is nor where to read it. Requested: every apply produces the
two preview files under descriptive, stable, patch-derived names rather than the session id,
and the approval prompt carries a brief human-readable description of the patch — including
the project name and the full paths of both preview files.

### 3. Feature — cross-project agent-to-agent change requests

Agents in one project cannot request changes to another project they depend on. Requested: a
direct agent-to-agent channel for bug fixes and feature requests across projects, gated by
explicit user approval **at request time** in addition to the existing approval at apply time.

Questions to settle at design time: how a request identifies its target project and its
requester; how evidence and reproduction steps travel with it; how approval-at-request is
recorded, bounded and distinguished from apply-time approval; and how requests that touch
S17/protected paths interact with the existing manual-review boundary.

### 4. Bug — the GGA review hook conflicts with `host_git_commit`

When GGA (Gentle AI) is active and the host git commit tool is used, the GGA code-review
subagent appears to believe it is using the tool, does nothing, and the commit fails. Observed
directly; the mechanism is unverified. First step is to reproduce with GGA enabled and capture
three facts: whether the hook intercepts the commit call, whether the subagent is dispatched at
all, and where the failure surfaces — the commit operation, the hook, or the subagent.

### 5. Bug — the systematic `ce:review` pipeline cannot run from the orchestrator

Four gaps: no non-mutating way to obtain a git range as data; no shared scratch surface between
worker sessions; no execution surface for the bundled helpers (`ensure-ignore.mjs`,
`validate-review.mjs`); and no artifact write surface for `review-summary.json`. Consequence:
reviewers receive no diff and return DIFF_UNAVAILABLE, so `pre_existing` attribution — the core
value of the review — goes unverified, and the packaged pipeline never runs at all.

The full brief, the four proposed fixed host tools, their non-negotiable boundaries, the
acceptance criteria and the regression risks are recorded in `docs/PLAN.md`.

## Planned — worktree review and commit without a per-worktree session

**Problem:** the review and git host operations bind to the session's project and accept no
cwd, so reviewing a git worktree requires a session whose project *is* that worktree. That
constraint is what makes per-slice review awkward, and it is why tonight's checkouts were
dangerous: the tree the broker installs from was also the tree under review. What actually
broke the stack was `install-user-files --apply` run from a checkout — not the checkout.

**Planned shape**

1. **Project selector on the host operations.** Add an optional, allowlisted `projectId` to
   `host_review_status|assess|start|capture_*|acknowledge_approved` and `host_git_commit`,
   resolved through the broker's existing `BROKER_PROJECTS` registry. An id, never a path or
   cwd; unknown ids refused. With this, a worktree registered as a project can be reviewed and
   committed from the main session, and the new-session requirement disappears. It is also
   stricter than today's implicit project binding.
2. **Worktree lifecycle operations.** Read: `host_worktree_list`. Approval-gated mutations:
   `host_worktree_create <projectId> <ref>` and `host_worktree_remove <projectId>`. Fixed
   argv, canonical paths, sibling placement under the home directory (never /tmp), and
   registration through the same path `host_register_project` uses so the relay's allowlist
   check and the broker's project lookup both succeed.
3. **A `worktree-committer` specialist.** Takes a worktree project id plus a unit spec;
   implements through sandbox workers bound to that project, runs that project's tests, and
   returns a prepared result for the orchestrator to review and commit. It never calls host
   operations itself — those stay orchestrator-only, which is also why review and commit stay
   with the orchestrator.
4. **Grant coverage for git metadata.** A worktree's `.git` is a file pointing at the main
   repository's `.git/worktrees/<name>`, so the profile grant for a worktree project must also
   cover the main repository's git metadata. Today's per-project `.git` grant does not
   obviously do that, and this is the wrinkle most likely to bite first.

**Acceptance:** a unit can be reviewed and committed from a worktree without moving the main
tree and without opening a session in the worktree, and no host operation accepts a raw path.
### 6. Bug — commit and issue messages reject newlines

`host_git_commit` refuses any message containing a control character, so a conventional commit
body cannot be passed at all, and every repository using the tool runs into it. The check is
over-broad: the message is delivered as a single argv element (`git commit -m <message> --
<paths>`), so a newline cannot break the command — it only trips a general sanitizer. The same
applies to the GitHub issue `body`.

Proposed: allow `\n` (and `\t`) in `message` and in the issue `body`; keep rejecting NUL and the
remaining C0 controls; keep the byte caps and the non-empty requirement; keep `title`
single-line, which is a genuine constraint. Add tests that a multi-line message reaches
`git commit` intact and that NUL is still refused. Check whether the same validator gates the
other free-text fields (`host_plan_append` content, the review capture inputs) so the fix is
consistent rather than one-off.
### 7. Gap — Python workers cannot run a project's tests

Reported 2026-09-24 from the tesla project, where a sandbox worker could not run a single test and the change therefore shipped unverified.

Evidence: the worker image carries pytest but none of the project's dependencies (`httpx`, `fastapi`, `pytest_asyncio`), has no `pip` and no `uv`, has no network, and provides Python 3.13.5 against a repository targeting 3.14 — so `pytest` dies while loading `tests/conftest.py`.

This is a design gap, not a defect: the image carries *runners* and is validated by a dependency-free fixture, so a real project's dependency set was never in scope. Whatever we choose, it should be chosen deliberately, because "the worker cannot verify" pushes verification back onto the host and quietly weakens the point of sandboxing. Options to weigh:

- read-only access to a project-local environment (awkward: a venv embeds absolute paths, and `.venv/` is gitignored so it is not in the captured baseline);
- an offline wheelhouse the worker may install from, with `pip install --no-index` — requires pip in the image and a matching interpreter;
- a per-project image layer pinning the project's Python version and dependencies;
- accepting that Python projects verify on the host, and saying so in the workflow.

The interpreter mismatch (3.13 vs 3.14) is part of the problem and must be decided rather than worked around.

### 8. Defect — `sandbox_apply_patch` rejects hunks ending on added lines without trailing context

Reported 2026-09-24 from the tesla project: hunks that end on added lines with no trailing context are refused, so the worker had to append trailing context to every hunk. Minor in impact, but the failure mode is wrong — it silently forces awkward patches instead of either accepting them or naming the constraint when it refuses.
### 9. Defect — the idle reaper and retained-result lifecycle have three dead-end faces

Evidence, `sandbox-broker` journal 2026-09-24: two delegated workers activated at 22:39:12 (`ensureWorker` ok 600ms, `exec` ok 518ms, `readFile` ok at 22:39:22). At 22:40:17 and 22:40:19 the `reaper` logged `bundle … / tmp_index …` for both sessions. At 22:40:36 `ensureWorker` returned `session … is FAILED_CLOSED; manual review required`, and the next read returned `not sandbox-active (state=FAILED_CLOSED)`.

Roughly 55 seconds with no broker operation — a model composing a large documentation edit — was treated as idle and reaped. The lifecycle gap has three faces:

1. **In-progress export:** the idle reaper exports sessions while work is still in progress. The 60-second idle threshold can fire during a model turn; operation timeouts (`exec` 130s, `ensureWorker` 120s) do not protect in-flight composition from idleness.
2. **Pruned failed import:** a failed result import becomes unrecoverable once state GC prunes its bundle.
3. **No ref fallback:** there is no fallback from a session id to a surviving result ref.

A reaped session becomes `FAILED_CLOSED` and cannot be resumed. Related to item 20 (`RETAINED` results are dead-ends): lifecycle states have no recovery path, leaving no way to clear them without a restart.

### Additional follow-ups

- **Trace-file defect:** the `review start --trace` value is written as a file in the repository, moving the untracked inventory and invalidating the consent gate's own precondition. Reproduced three times.
- **Result-install revert hazard:** installing a result restores its tree for paths in that result's diff; a later change to the same path is silently reverted while the operation reports `installed: true`.
- **Deployment-verification gap:** a stale installed plugin or nono profile mirror can masquerade as installed; there is no post-install byte verification.
- **OpenChamber upstream note:** the suppressant-key gate used for metadata Details rendering is fragile by design; report it upstream.
- **`R3-003`:** the profile's `~` entry may be inert; verify with `nono why`.
- **Advisory lens findings to track:** `R2-001` (compressed containment helper), `R2-002` (patch catch gives diff advice for non-diff failures), `R3-001` (catch discards the original cause), and `R3-002` (symlink deletion target untested).
