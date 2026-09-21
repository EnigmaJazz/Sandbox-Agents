# TODO — agent-sandbox-integration

Last updated: 2026-09-11

## In flight — agent-host-tools (2026-09-11)

- Landed on host, UNCOMMITTED: (a) apply-preview prereq — removed applyResult line cap (broker/src/service.ts) + colour-coded `sandbox_apply` preview file (opencode/plugins/sandbox-tools.ts); (b) slice 1 — P0 SDD runtime host tools + authorization (194 tests). OpenSpec artifacts under `openspec/changes/agent-host-tools/`; Magic Context records 922–928 + resume memory 930.
- Pending: slice 2 (git/gh: gitCommit/gitPush/ghIssueCreate), slice 3 (registerProject dispatch + docs/threat-model), then verify + archive.
- Carry-forward (acceptance): restore full `BROKER_PROTECTED_SECURITY_FILES` + remove `BROKER_REAP_INTERVAL_MS`; reinstall plugin + restart secure OpenCode; commit landed slices as work units (hunk-split); fix `runPrepare` forcing refspec; S17 manual review.
- Blocker: SDD dispatch latched for the current session — continue in a NEW session.

## Completed

1. Copy-tool hardening (copy_in activation, copy_out source cap, env cap 200)
2. Global AGENTS.md host-side SDD guidance (copy_in/copy_out flow)
4. Worker test runners (bun + pytest in image, 9/9 copy-review)
6. Broker commits (feat(broker) + chore(sandbox))
7. Sync systemd-user/broker.env template (9 projects, S17 real list, binary line)
8. Host bun tests (117 pass) + build
9. Apply-review file flow (applyPreview op + 6/6 tests; live after restart)
17. Revert live S17 bootstrap relaxation (real list now live)
21. Idle-worker reaping + pool queue — clean/dirty reap (60s), queue park/progress/drain, operation-aware client timeout (exec 130s / ensureWorker 120s)

## Pending

3. File nono 0.74 loopback regression at nolabs-ai/nono (drafted)
5. Verify auto-update EACCES resolved (4 history files seeded, journal clean?)
10. Make sandbox_copy_out identical to apply: diff-style review file, no 200 hard cap for source targets
11. Agent commit/push with authorization (gitCommit/gitPush ops, approval-gated)
12. GitHub issue reporting with human oversight (gh issue-create, approval-gated)
13. Sandbox tool-definition pass (13 sandbox_* descriptions/schemas audit)
14. Web/network access for agents (github.com, websearch hosts in nono allow_domain)
16. Final security gate (manual-verification gates + AFT bypass finding + orchestrator staleness + file-mode finding)
19. AFT sandbox-state gating (deny host AFT post-activation)
20. Broker retained-result resume gap (RETAINED results are dead-ends)
22. OpenChamber E2E verification on nono 0.73 (all providers respond)
23. SDD runtime: verify BROKER_GENTLE_AI_BINARY in broker env + sdd-runtime tests on host
27. register-project: create + grant `<project>/.codegraph` in the nono profile for new projects (mirror the existing `.atl` helper) so CodeGraph can write its index inside secure OpenCode. The grant must be paired with directory creation: nono binds grants to existing paths at sandbox start and cannot create `.codegraph` itself.

## In-progress / parked

15. Role-based subagents SDD — Phase A (P0+A) code delivered (commit 6118de1, 159 tests); S17 review pending (NOT applied to host); parked at Phase B (9 tasks: B.1-B.3 researcher/worker, C.1-C.3 advisor/deliberation, D.1-D.3 security gate)
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
all four and refuses a missing value before spawning. Not yet live for dependent repos until
that branch is installed; verify against the affected repo afterwards.

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
