# TODO — agent-sandbox-integration

Last updated: 2026-09-05

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

## In-progress / parked

15. Role-based subagents SDD — Phase A (P0+A) code delivered (commit 6118de1, 159 tests); S17 review pending (NOT applied to host); parked at Phase B (9 tasks: B.1-B.3 researcher/worker, C.1-C.3 advisor/deliberation, D.1-D.3 security gate)
18. Read-only orchestrator — part of Phase A (readOnlyAgents + plugin guard), code delivered, S17 pending

## New (2026-09-05)

24. sandbox_diff always shows 0 — buildRetainedDiff returns compare:'' while active-mode diff computes .new reference comparisons
25. sandbox_apply not giving the correct S17 failure message
26. runPrepare .broker-tmp mkdir + git bundle create status check (bites sandbox_bash-only writers)
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
