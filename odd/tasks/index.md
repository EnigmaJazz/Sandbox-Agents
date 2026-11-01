# ODD tracker index

Derived from the directory, never the other way round. **`odd/tasks/*.md` is authoritative; this file is a view.** Before adding an entry, list the directory. Completed trackers move to `odd/tasks/archive/`.

Last rebuilt: 2026-11-01. A reconciliation found 38 trackers against 24 indexed, and eight trackers asserting work that had already shipped or already closed.

## Active trackers (21)

| Tracker | Status | Next action |
|---|---|---|
| `external-advisors` | A1–A4 done; A5–A9 pending | A5: OpenCode host tools. A2a/b/c closed with review authority burned. |
| `host-git-tools` | Open, not started | T1: the five read tools (`status\|diff\|log\|show\|branch`). Branch create/switch is TODO Tier 2 item 19. |
| `host-journal-tool` | Open, not started | T1: bounded `host_journal`, after deciding overlap with `hostServiceLogs`. |
| `register-project-profile-grants` | Open, not started; S17 owner apply | T1: idempotent `.git` grant, which unblocks project and worktree registration. |
| `hostfs-mcp-integration` | Open, parked | T1: MCP core. Parked deliberately; do not start without an owner decision. |
| `routing-guard-admission` | Open; containment done | T1: classify the inventory. |
| `multi-agent-v2-host-tools` | T1–T6 done, T7 partial, T8 owner | T7: record the live plan-root refusal proof (`t7-flip-draft` steps 2–5). |
| `t7-flip-draft` | Step 1 done, 2–5 pending | Prove the refusal for a worker mutation and a result install on the running broker. |
| `sandbox-edit-activation` | T1–T2 done, T3–T4 open | Name and run the two regression tests; record totals and the receipt. The success-without-persisting symptom is a separate, untracked defect. |
| `pm-layer-identities` | T1–T5 done (T3 partial, T5.3 untested) | Verify installed policy/plugin bytes and observe the live stale-`pm-probe` refusal. |
| `worker-release-gaps` | T1–T4 done; superseded by the archived `worker-release-outcome` | Observe release behaviour on the restarted broker; confirm the 22 `DESTROYED`-but-live VMs are reclaimed. |
| `gentle-ai-4-sdd-dormancy` | T1–T5 done; broker restarted 2026-11-01 | Observe the dormancy `PolicyError` refusal, then tell `workflow_optimisation` about the impact. |
| `broker-frame-resync` | T1–T3 done (`7be0d07`), T4 open | Record test totals and the receipt, then archive. |
| `broker-client-frame-loss` | T1–T3 done (`df90b54`), T4 open | Record test totals and the receipt, then archive. |
| `review-pipeline-tools` | Built end to end, not live | Owner: install, merge the `host_review_materialize` fragment by hand, restart the broker, run the Gate 4 probes. |
| `review-pipeline-phases` | Chunk 1 done; chunks 2–3 escalated | Fix the `finalize` validator summary; the validator-request gap blocks the rest. |
| `apply-preview-diff` | T1–T3 done, T4–T5 open | T5: post-install readback with the owner. |
| `gentle-ai-3.1.0-integration-alignment` | T1–T4 done, T5 docs-only open | T5: the descriptive surfaces. |
| `review-host-tool-flag-parity` | T1 done, T2–T5 open | Re-sweep flag parity against the current tool surface. |
| `spawn-output-integrity` | Work landed; native review **escalated, not approved** | Decide the escalation. Not archived while a review outcome is unresolved. |
| `flow-probe` | Gate 1 PASS recorded; T2 deferred | Archive once the deferred item is done or formally dropped. |

## Verified complete on 2026-11-01 — move these to `odd/tasks/archive/`

Each was read in full, not inferred from a checkbox.

| Tracker | Evidence | Review outcome |
|---|---|---|
| `review-run-foundation` | `8704563` + `44deade` (U1b-1), `a4d3cd3` + `4f1b044` (U1b-2), `b56d76e` (U1b-3). Its old "Next step: U1b-3 (T12)" was stale; T12–T13 shipped in `b56d76e`. | Three lineages, all approved with authority burned: `review-ee8377f105bd5b05`, `review-33e7f844c3943cf1`, `review-d85ff493af457075`. |
| `review-foundation-hardening` | F1, F2a, F2b complete; all ten findings 62–71 closed or recorded; items 72 and 73 created by the unit. | `review-62420fc48ebb558b`: **escalated, not approved** (`R3-ApplyDuplicateEnvKeys`, `unknown_causality`), recorded as TODO item 73. The work is done; the authority was not issued. |
| `review-slice-delivery` | `fe1bd43` (13 files, +363/−8). Assessment `68fdacb..HEAD` returned `review_due: false`, `under_budget`. | No native review of its own; design corrected by post-code advice. |
| `host-git-exec-hardening` | Unit 1 and unit 2 committed; unit 2 as `4debc59` (8 files, +765/−14) under an owner size exception. Its own "Next step" already says none. | `review-e7d46dbde3ef5d0b`: approved, authority burned. One BLOCKER (`R3-CallerConfigConcatBypass`) refuted by the provider refuter. |

## Waiting on the owner, not on code

- `t7-flip-draft` steps 2–5 and `multi-agent-v2-host-tools` T7: the flag is live (`systemd-user/broker.env:49`); only the refusal proof is missing.
- `review-pipeline-tools`: install, manual fragment merge, broker restart, probes.
- `register-project-profile-grants`: S17 apply.
- `spawn-output-integrity`: the escalation decision.
- `worker-release-gaps` and `gentle-ai-4-sdd-dormancy`: observation on the restarted broker.

## Archived (13, already moved)

`odd/tasks/archive/`: `artifacts-durability-gate`, `broker-error-code-propagation`, `broker-socket-lifecycle`, `host-sandbox-result-tool`, `request-line-cap`, `response-safety-followups`, `result-install-divergence`, `review-trace-write-guard`, `reviewer-relay-root-guard`, `sandbox-diff-receipt-bytes`, `socket-write-drain`, `v2-docs-refresh`, `worker-release-outcome`.

`worker-release-outcome` was archived despite unticked task boxes, because its Progress section, its review lineage and `b85e3bc` all say complete. The boxes were stale.

## Reconciliation notes, 2026-11-01

- **Checkbox state is the weakest evidence in this repository.** Eight trackers were wrong: four said "not started" for committed work (`broker-frame-resync` `7be0d07`; `broker-client-frame-loss` `df90b54`; `sandbox-edit-activation` `2e531a6` plus `tool-specs-sandbox.ts:96`; `multi-agent-v2-host-tools` T5/T6 via `7299ada`, `4cda0ef`, `875f409`, `0471f4c`, `b368c8d`), and four more carried stale next steps or unstated completion (`review-run-foundation`, `review-foundation-hardening`, `review-slice-delivery`, `host-git-exec-hardening`). When a tracker and a commit disagree, check the code, then fix the tracker.
- **Trackers cannot be edited by workers.** `BROKER_PLAN_ROOT_PROTECTION=1` (`systemd-user/broker.env:49`) guards `odd/tasks/**` (`broker/src/service.ts:965`), so only the orchestrator's `host_plan_write` can write here. That tool replaces one document, rejects uppercase names, and cannot move a file — so archiving still needs owner `git mv`. Tracked as TODO Tier 2 item 18.
- **`docs/TODO.md` carries stale statuses too:** worker release and error-code propagation are listed as "pending commit/review" while committed and reviewed. Correct them when that text is next touched.
- **`gentle-ai-4.md` and TODO line 62 still say the `c6bff59` broker restart is unconfirmed.** The owner confirmed the restart on 2026-11-01; update that sentence when next edited.

## How to add a tracker

One document per feature, named `odd/tasks/<feature-name>.md` in lowercase with hyphens. It carries: objective, problem with evidence, scope, constraints, stable task IDs, acceptance criteria, authorized scope, checks, route and trigger evidence, progress, and next step. Then add a row here in the same change.


## Revisions
- r1 2026-11-01T17:55:33Z gentle-orchestrator: Rebuild the tracker index from the directory
- r2 2026-11-01T18:00:37Z gentle-orchestrator: Record the four verified-complete trackers pending archive
