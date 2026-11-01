# v2-docs-refresh — post-cutover documentation refresh and V2 update guide

## Objective
Bring all documentation, the TODO list and ODD trackers in line with the completed OpenCode V2 cutover, then publish one guide for applying plugin/config updates to V2.

## Problem
After the cutover (owner-attested, before 2026-11-01) many documents still said "nothing installed" or described V1 as live. No document explained how to apply plugin or config updates to V2.

## Scope
Documentation only. Out of scope (S17, owner action): `nono/**`, `systemd-user/**`, `scripts/**`, `opencode/**`, `broker/**`, `AGENTS.md`, `docs/threat-model.md`.

## Constraints
- Every status claim is repo-verified (path:line or commit) or labelled owner-attested; unknowns go under Owner to confirm.
- Plan-root protection is live: `odd/tasks/` is written only by the orchestrator through `host_plan_write`.
- Artifacts in English. Per-commit cap 400 authored lines / 100 KiB.
- Class is Documentation (not simple-docs): route per `WORKFLOW.md:122` — matching docs skill (none installed; stated fallback) → delegated writer → proportional structural readback and owner review. No PM, no Planner, no advisors for this class.

## Tasks
- [x] U1 Status and tracking docs: `docs/TODO.md`, `docs/upgrades/opencode-v2.md`, `docs/upgrades/opencode-v2-install-checklist.md`. Writer `odd-apply`, session `ses_e6971aaf3ffd4Ls23cnATldgZQ`, 73 authored lines. Commit `f9a53c1`. Deviation: first routed as an ODD unit directly to `odd-apply`; corrected after owner direction — documentation class needs no PM layer.
- [x] U2 Top-level docs: `README.md`, `SECURITY.md`, `CLAUDE.md`, `docs/architecture.md`, `docs/operations.md`, `docs/manual-verification.md`. Writer `general`, session `ses_e6811d220ffej4bO3qReznA3OX`, 159 authored lines. Commit `9e09877`. First attempt (`ses_e681de21dffeB7kKdcHn2fsbvt`) was discarded: install refused because untracked `CLAUDE.md` was absent from the sandbox baseline. Owner committed `CLAUDE.md` as `9c1c070`; the rerun then installed and committed.
- [x] U3 V2 update guide: `docs/upgrades/opencode-v2-maintenance.md` (133 lines) plus a checklist cross-link and a corrected health-check coverage sentence. Writer `general`, session `ses_e6807490dffejiSQ0z7jCQMOwK`, 137 authored lines. Commit `19ff2bc`.
- [ ] U1b Tracker upkeep: entry for this tracker in `odd/tasks/README.md`, and `odd/tasks/t7-flip-draft.md` / `odd/tasks/multi-agent-v2-host-tools.md` status reconciliation. Deferred: those files carry tool-managed Revisions/Ticks sections; the orchestrator will not rewrite them blind. Owner decision needed.
- [ ] Router log row for this task in the workspace `ROUTER-LOG.md` (the orchestrator never edits it; needs a writer).

## Acceptance criteria
- No edited document asserts that nothing is installed or that V1 is the working build. MET (grep over the six U2 files: no matches; remaining "Gate 1" hits are the historical gate heading and Gate 10/11 headings).
- The maintenance guide gives exact commands for each update type with verification and rollback, each checked against the scripts. MET: every flag traced to `scripts/install-user-files-v2`, `scripts/rollback-v2`, `scripts/secure-launcher-v2.conf:42-75`, `scripts/check-v2-stack.ts` and the unit template.
- TODO tier counts match the item counts. Not re-verified in this task.

## Route and trigger evidence
- U1: documentation; delegated directly to `odd-apply` (deviation above).
- U2, U3: documentation; delegated to `general` (model unset → runtime default). Owner direction: use `general`, not `odd-apply`, because the work is not ODD.
- Checks executed: writer read-back after each batch, literal grep for the stale claims, command/flag tracing to source, relative-link resolution. No test suites (documentation class).

## Review state
- `host_review_assess` on `9c1c070..9e09877` (U2, committed-only, untracked excluded, inventory `sha256:6755ccf6…`): risk `high`, reason `hot_path` (`SECURITY.md`), `review_due: true`, candidate not consumed.
- Native review not started: `WORKFLOW.md:263` records that OpenCode V2 native review remains unavailable and must fail closed until upstream advertises support, and the installed stack is V2. Recorded, not silently skipped.
- U1 and U3 were not separately assessed.

## Owner to confirm
1. Exact cutover date; 2.2.2 is the running build on port 4097.
2. OpenChamber 2 install/attach state.
3. Broker restarted after `c6bff59`; `7a158cf`/`124c5e2` profile changes on the installed profile.
4. Installed `~/.config/nono/profiles/opencode-v2-secure.json` parses (the repo copy does not).
5. Installed V2 files byte-identical to the repo copies.
6. Resolved plugin patch versions on V2 (record them in the guide's table).
7. `t7-flip-draft.md` steps 2-5 performed.
8. Vision bridge OpenAI login on the V2 data root.
9. `asi-review-*` relay works end to end on the live V2 broker.

## Known defects found, out of scope
- (a) `nono/profile/opencode-v2-secure.json:140-141` has no comma between `"api.anthropic.com"` and `"platform.claude.com"`: invalid JSON (S17, owner fix). Now also documented in the maintenance guide's known gaps.
- (b) `AGENTS.md` S17 list omits `opencode/plugins-v2/**` (owner decision).
- (c) `nono/profile/opencode-v2-secure.json:5` still ends "NOT INSTALLED" (S17).
- (e) `sandbox_apply_patch` accepts plan-root writes that `sandbox_write` refuses (`broker/src/service.ts:962`).

## Log
- 2026-11-01 U1 committed `f9a53c1`; ODD-routing deviation recorded.
- 2026-11-01 Owner committed untracked `CLAUDE.md` as `9c1c070` so the sandbox baseline could track it.
- 2026-11-01 U2 result installed and committed `9e09877` (6 files, +99/−60).
- 2026-11-01 U3 guide installed and committed `19ff2bc` (2 files, +135/−2).
- 2026-11-01 U2 assessment: high risk, review due, native review unavailable on V2.

## Next step
Owner review of commits `f9a53c1`, `9e09877`, `19ff2bc`; then U1b and the router-log row.


## Revisions
- r1 2026-11-01T10:11:17Z gentle-orchestrator: Create tracker for the post-V2-cutover documentation refresh
- r2 2026-11-01T10:14:32Z gentle-orchestrator: Record U1 commit, the PM-bypass deviation, and re-route remaining units through pm-odd
- r3 2026-11-01T16:56:06Z gentle-orchestrator: Record U2 and U3 completion, review state, and remaining upkeep
