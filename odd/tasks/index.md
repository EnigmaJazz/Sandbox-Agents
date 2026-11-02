# ODD tracker index

Derived from the directory, never the other way round. **`odd/tasks/*.md` is authoritative; this file is a view.** Before adding an entry, list the directory. Completed trackers move to `odd/tasks/archive/`.

Last rebuilt: 2026-11-02 from the directory listing and a native review assessment at HEAD.

## Active trackers (22)

| Tracker | Status | Next action |
|---|---|---|
| `orca-report-probe-realignment` | Implementation done, installed and green; **tracker says "not committed", but three commits exist** | Reconcile the commit state, then the post-code advisory review an authorization gate owes. See the note below. |
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

## `orca-report-probe-realignment` — reconcile before trusting it

The tracker says **"DONE — installed in the host worktree and verified. Not committed (owner's step)"** (`:8`), and its Next step still asks for "the owner's work-unit commit" (`:106`). The branch reflog shows three commits with the subject `feat(broker): add orca report bridge` (`9e5e88f`, `007a806`, `f98dd15`). Either the tracker predates the commits, or three commits carry one change. Also outstanding: the post-code advisory review an authorization-relevant gate owes; the native review is **not** due (see below), which is a different gate.

## Native review state at HEAD (2026-11-02)

`assess --base-ref=aee56e0 --committed-only --untracked-scope=exclude`:

- **medium** risk, one reason: `executable_change` at `broker/src/orca.ts`.
- 63 paths, 5,564 changed lines, `candidate.consumed: false`.
- **`review_due: false`**, reason `under_budget`. No review is owed for this accumulated slice yet.
- The assessment initially refused with `unassessable` and required an explicit untracked declaration; the figures above **exclude** untracked files (`sha256:6755ccf6…`). Anything untracked is not covered.

## Archived (17)

`odd/tasks/archive/`: `artifacts-durability-gate`, `broker-error-code-propagation`, `broker-socket-lifecycle`, `host-git-exec-hardening`, `host-sandbox-result-tool`, `request-line-cap`, `response-safety-followups`, `result-install-divergence`, `review-foundation-hardening`, `review-run-foundation`, `review-slice-delivery`, `review-trace-write-guard`, `reviewer-relay-root-guard`, `sandbox-diff-receipt-bytes`, `socket-write-drain`, `v2-docs-refresh`, `worker-release-outcome`.

The last four (`review-run-foundation`, `review-foundation-hardening`, `review-slice-delivery`, `host-git-exec-hardening`) were read in full and verified complete on 2026-11-01 before the move landed as `6006c16` ("docs(odd): remove completed task trackers"). `review-foundation-hardening` carries an **escalated** review, not an approved one; the work is done, the authority was never issued.

`worker-release-outcome` was archived despite unticked task boxes, because its Progress section, its review lineage and `b85e3bc` all say complete.

## Reconciliation notes

- **Checkbox state is the weakest evidence in this repository.** Trackers have claimed "not started" for committed work (`broker-frame-resync` `7be0d07`; `broker-client-frame-loss` `df90b54`; `sandbox-edit-activation` `2e531a6` plus `tool-specs-sandbox.ts:96`; `multi-agent-v2-host-tools` T5/T6 via `7299ada`, `4cda0ef`, `875f409`, `0471f4c`, `b368c8d`), and stale next steps (`review-run-foundation` pointed at work shipped two commits earlier). When a tracker and a commit disagree, check the code, then fix the tracker.
- **Trackers cannot be edited by workers.** `BROKER_PLAN_ROOT_PROTECTION=1` (`systemd-user/broker.env:49`) guards `odd/tasks/**` (`broker/src/service.ts:965`), so only the orchestrator's `host_plan_write` can write here. That tool replaces one document, rejects uppercase names, and cannot move a file, so archiving still needs owner `git mv`. Tracked as TODO Tier 2 item 18.
- **`docs/TODO.md` carries stale statuses:** worker release and error-code propagation are listed as "pending commit/review" while committed and reviewed; the `c6bff59` restart is still called unconfirmed although the owner confirmed it; `authored_patch_bytes` is described as rejected when it now reports. Fix them when that text is next touched.
- **Index drift is the recurring failure.** Three rebuilds in two days, each because the file listed fewer trackers than the directory held. Treat the directory as the only inventory.

## How to add a tracker

One document per feature, named `odd/tasks/<feature-name>.md` in lowercase with hyphens. It carries: objective, problem with evidence, scope, constraints, stable task IDs, acceptance criteria, authorized scope, checks, route and trigger evidence, progress, and next step. Then add a row here in the same change.


## Revisions
- r1 2026-11-01T17:55:33Z gentle-orchestrator: Rebuild the tracker index from the directory
- r2 2026-11-01T18:00:37Z gentle-orchestrator: Record the four verified-complete trackers pending archive
- r3 2026-11-02T22:23:22Z gentle-orchestrator: Rebuild from the directory: 22 active, 17 archived, orca flagged
