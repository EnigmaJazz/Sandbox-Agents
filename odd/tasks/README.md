# ODD task trackers

This directory holds ODD task trackers for work in progress and completed units. Completed trackers stay in place and are marked **Archived**—they are read-only history, never deleted or moved, because `docs/TODO.md` and other records reference them by path and review lineage.

## Complete / archived

| Tracker | Closure evidence |
|---|---|
| `artifacts-durability-gate` | Commit `682065e`; approved lineage `review-9070428dfe159687`. |
| `broker-socket-lifecycle` | Commits `365b4a1`, `15e0f54`, `5d24a64`; approved lineage `review-0789e564b02b5363`. |
| `host-sandbox-result-tool` | Closure commit `152f433`; approved lineage `review-fef3d82d66ff12a3`. |
| `result-install-divergence` | Commit `1407a78`; approved lineage `review-5de9d2f7cbc97ce3`. |
| `review-trace-write-guard` | Completion commit `f048a67`. |
| `socket-write-drain` | Commits `81c78cc`, `374e347`, `74f280a`, `dd0f1af`, `9c44aa9`, and `cb29902`. |
| `reviewer-relay-root-guard` | Commit `dd345f2`; approved successor lineage `review-8b3f47c19de20a55`. |
| `request-line-cap` | Commit `9c44aa9`. |
| `response-safety-followups` | Approved parent lineage `review-e88a985fad223e87` (response-safety correction); the tracker also records units A–C and subsequent queue-drain/reaper follow-ups, but does not give those later units separate closure lineages. |

## Partial

| Tracker | Remaining action |
|---|---|
| `apply-preview-diff` | Complete T4 documentation and T5 installed-surface readback. |
| `gentle-ai-3.1.0-integration-alignment` | Complete T5 descriptive-surface updates only. |
| `gentle-ai-4-sdd-dormancy` | Tell workflow_optimisation about the impact; restart the broker for fix `c6bff59`. |
| `pm-layer-identities` | Finish plugin-layer runtime identity coverage and post-install checks; verify installed policy/plugin bytes and the live stale-`pm-probe` refusal. |
| `review-host-tool-flag-parity` | T2–T5 remain: re-sweep CLI flag parity, test, update docs/config if needed, and verify/read back. |
| `worker-release-gaps` | Owner restarts the broker to activate the fixes. |

## Open

| Tracker | Remaining action |
|---|---|
| `broker-client-frame-loss` | Implement T1–T4: fail malformed/unmatched response frames, preserve split UTF-8, decide response bound, execute large-frame verification, and report receipt. |
| `broker-frame-resync` | Implement T1–T4: client resync, write-failure visibility, sanitized residual diagnostic, execute same-connection recovery test, and report receipt. |
| `external-advisors` | Complete A5–A9 per the tracker and plan; A2 (A2a `1b3d246`, A2b `deecdeb`, A2c `04322bd`) is complete and closed. |
| `host-git-tools` | Implement T1–T5: host read tools, staging/branch mutations, validation/authorization, tests, and docs/config. |
| `host-journal-tool` | Implement T1–T5: bounded read tool, validation/authorization, tests, and docs/config. |
| `hostfs-mcp-integration` | Implement T1–T15 from the authoritative `docs/hostfs.md` brief, including sandbox tests and staged handoff; do not apply the workflow integration. |
| `register-project-profile-grants` | Implement T1–T5: idempotent `.git`/`.codegraph` grants, tests, existing-project migration, and docs; owner applies S17 profile changes. |
| `sandbox-edit-activation` | Implement T1–T4: ensure-before-read, create target parent directories, execute regression verification, and report receipt. |

## User-owned residuals

- `response-safety-followups`: owner review and manual installation of the broker changes.
- `reviewer-relay-root-guard`: verify the secure OpenCode restart after installing the plugin bytes.
- `request-line-cap`: install the broker and plugin changes and restart the broker.
