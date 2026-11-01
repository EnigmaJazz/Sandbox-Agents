# ODD tracker index

Derived from the directory, never the other way round. **`odd/tasks/*.md` is authoritative; this file is a view.** Before adding an entry, list the directory. Completed trackers move to `odd/tasks/archive/`.

Last rebuilt: 2026-11-01, after a reconciliation found 38 trackers against 24 indexed, and four trackers asserting work that had already shipped.

## Active trackers (25)

| Tracker | Status | Next action |
|---|---|---|
| `external-advisors` | A1–A4 done; A5–A9 pending | A5: OpenCode host tools. A2a/b/c closed with review authority burned. |
| `host-git-tools` | Open, not started | T1: the five read tools (`status\|diff\|log\|show\|branch`). Branch create/switch is now TODO Tier 2 item 19. |
| `host-journal-tool` | Open, not started | T1: bounded `host_journal`, after deciding overlap with `hostServiceLogs`. |
| `register-project-profile-grants` | Open, not started; S17 owner apply | T1: idempotent `.git` grant, which unblocks project and worktree registration. |
| `hostfs-mcp-integration` | Open, parked | T1: MCP core. Parked deliberately; do not start without an owner decision. |
| `routing-guard-admission` | Open; containment done | T1: classify the inventory. |
| `multi-agent-v2-host-tools` | T1–T6 done, T7 partial, T8 owner | T7: record the live plan-root refusal proof (`t7-flip-draft` steps 2–5). |
| `t7-flip-draft` | Step 1 done, 2–5 pending | Enable, install, restart, then prove the refusal for a mutation and a result install. |
| `sandbox-edit-activation` | T1–T2 done, T3–T4 open | Name and run the two regression tests; record totals and the receipt. |
| `pm-layer-identities` | T1–T5 done (T3 partial, T5.3 untested) | Verify installed policy/plugin bytes and observe the live stale-`pm-probe` refusal. |
| `worker-release-gaps` | T1–T4 done; superseded by `worker-release-outcome` (archived) | Observe release behaviour on the restarted broker; confirm the 22 `DESTROYED`-but-live VMs are reclaimed. |
| `gentle-ai-4-sdd-dormancy` | T1–T5 done; restart performed 2026-11-01 | Observe the dormancy `PolicyError` refusal, then tell `workflow_optimisation` about the impact. |
| `broker-frame-resync` | T1–T3 done (`7be0d07`), T4 open | Record test totals and the receipt, then archive. |
| `broker-client-frame-loss` | T1–T3 done (`df90b54`), T4 open | Record test totals and the receipt, then archive. |
| `review-pipeline-tools` | Built end to end, not live | Owner: install, merge the `host_review_materialize` fragment by hand, restart the broker, run the Gate 4 probes. |
| `review-pipeline-phases` | Chunk 1 done; chunks 2–3 escalated | Fix the `finalize` validator summary; the validator-request gap blocks the rest. |
| `apply-preview-diff` | T1–T3 done, T4–T5 open | T5: post-install readback with the owner. |
| `gentle-ai-3.1.0-integration-alignment` | T1–T4 done, T5 docs-only open | T5: the descriptive surfaces. |
| `review-host-tool-flag-parity` | T1 done, T2–T5 open | Re-sweep flag parity against the current tool surface. |
| `review-run-foundation` | **Not re-verified** on 2026-11-01 | Confirm completion from its own Progress section before treating it as done. |
| `review-foundation-hardening` | **Not re-verified** | Same: its Objective says it closes defects in a *completed* unit, which implies done, but the file does not say so. |
| `review-slice-delivery` | **Not re-verified** | Confirm before archiving. |
| `host-git-exec-hardening` | **Not re-verified** | Its own text is referenced as already committed by other trackers; confirm its status line. |
| `spawn-output-integrity` | Review **escalated, not approved** | Not complete by the review contract. Resolve the escalation before archiving. |
| `flow-probe` | Gate 1 PASS recorded; T2 deferred | Closed as a probe; archive once the deferred item is either done or dropped. |

## Waiting on the owner, not on code

- `t7-flip-draft` steps 2–5 and `multi-agent-v2-host-tools` T7: the flag is live (`systemd-user/broker.env:49`); only the refusal proof is missing.
- `review-pipeline-tools`: install, manual fragment merge, broker restart, probes.
- `register-project-profile-grants`: S17 apply.
- `spawn-output-integrity`: the escalation decision.

## Archived (13)

`odd/tasks/archive/`: `artifacts-durability-gate`, `broker-error-code-propagation`, `broker-socket-lifecycle`, `host-sandbox-result-tool`, `request-line-cap`, `response-safety-followups`, `result-install-divergence`, `review-trace-write-guard`, `reviewer-relay-root-guard`, `sandbox-diff-receipt-bytes`, `socket-write-drain`, `v2-docs-refresh`, `worker-release-outcome`.

Each was archived on explicit completion evidence in its own file or a confirmed commit. `worker-release-outcome` was archived despite unticked task boxes, because its own Progress section, its review lineage and `b85e3bc` all say complete; the boxes were stale.

## Reconciliation notes, 2026-11-01

- **Checkbox state is the weakest evidence in this repository.** Four trackers said "not started" for work already committed: `broker-frame-resync` (`7be0d07`), `broker-client-frame-loss` (`df90b54`), `sandbox-edit-activation` (`2e531a6`, plus `tool-specs-sandbox.ts:96`), `multi-agent-v2-host-tools` T5/T6 (`7299ada`, `4cda0ef`, `875f409`, `0471f4c`, `b368c8d`). When a tracker and a commit disagree, check the code, then fix the tracker.
- **Trackers cannot be edited by workers.** `BROKER_PLAN_ROOT_PROTECTION=1` (`systemd-user/broker.env:49`) guards `odd/tasks/**` (`broker/src/service.ts:965`), so only the orchestrator's `host_plan_write` can write here. It replaces one document, rejects uppercase names, and cannot move a file — so archiving still needs owner `git mv`. Tracked as TODO Tier 2 item 18.
- **`docs/TODO.md` carries stale statuses too:** worker release and error-code propagation were listed as "pending commit/review" while committed and reviewed. Correct them when the surrounding text is next touched.

## How to add a tracker

One document per feature, named `odd/tasks/<feature-name>.md` in lowercase with hyphens. It carries: objective, problem with evidence, scope, constraints, stable task IDs, acceptance criteria, authorized scope, checks, route and trigger evidence, progress, and next step. Then add a row here in the same change.


## Revisions
- r1 2026-11-01T17:55:33Z gentle-orchestrator: Rebuild the tracker index from the directory
