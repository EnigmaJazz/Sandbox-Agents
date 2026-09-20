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
