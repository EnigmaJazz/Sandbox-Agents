# v2-docs-refresh — post-cutover documentation refresh and V2 update guide

## Objective
Bring all documentation, the TODO list and ODD trackers in line with the completed OpenCode V2 cutover, then publish one guide for applying plugin/config updates to V2.

## Problem
After the cutover (owner-attested, before 2026-11-01) many documents still say "nothing installed" or describe V1 as live. No document explains how to apply plugin or config updates to V2.

## Scope
Documentation only. Out of scope (S17, owner action): `nono/**`, `systemd-user/**`, `scripts/**`, `opencode/**`, `broker/**`, `AGENTS.md`, `docs/threat-model.md`.

## Constraints
- Every status claim is repo-verified (path:line or commit) or labelled owner-attested; unknowns go under Owner to confirm.
- Plan-root protection is live: trackers under `odd/tasks/` are written only by the orchestrator through `host_plan_write`; sandbox writers cannot touch `odd/tasks/**`.
- Artifacts in English. Per-commit cap 400 authored lines / 100 KiB.
- Budget class: Documentation, NOT simple-docs (units touch README/CLAUDE.md/command docs outside the allowlist), so one pre-advice phase and one post-code check apply per `docs/specs/pm-handoff.md`.

## Tasks
- [x] U1 Status and tracking docs: `docs/TODO.md`, `docs/upgrades/opencode-v2.md`, `docs/upgrades/opencode-v2-install-checklist.md`. Writer `odd-apply`, session `ses_e6971aaf3ffd4Ls23cnATldgZQ`, 73 authored lines, committed `f9a53c1`. DEVIATION: dispatched directly to the writer with no PM, no Planner pre-code advice and no post-code check. Remediation: U2 includes an independent post-code check over the U1 files as well (see U2).
- [ ] U2 Top-level docs: `README.md`, `SECURITY.md`, `CLAUDE.md`, `docs/architecture.md`, `docs/operations.md`, `docs/manual-verification.md`. Dispatched through `pm-odd` (pm-unit-brief/v1); includes the post-code check over U1 and U2 candidates.
- [ ] U3 New guide `docs/upgrades/opencode-v2-maintenance.md` (how plugin/config updates are applied to V2), cross-links, `ROUTER-LOG.md` row. Through `pm-odd`.
- [ ] U1b Tracker upkeep: `odd/tasks/README.md` entry for this tracker, `odd/tasks/t7-flip-draft.md` and `odd/tasks/multi-agent-v2-host-tools.md` status reconciliation. Deferred: those files carry tool-managed Revisions/Ticks sections, so the orchestrator will not rewrite them blind; resolve with the owner.

## Acceptance criteria
- No edited document asserts that nothing is installed or that V1 is the working build.
- The maintenance guide gives the exact commands for each update type, a verification step, and a rollback, each checked against the scripts.
- TODO tier counts match the item counts.

## Route and trigger evidence
- U1: route delegated; specialist odd-apply (direct, no PM: deviation above); trigger: secure policy.
- U2/U3: route delegated; specialist pm-odd then writer per PM; RDD: on (global). Class: Documentation (non-simple).

## Owner to confirm
1. Exact cutover date; 2.2.2 is the running build on port 4097.
2. OpenChamber 2 install/attach state.
3. Broker restarted after `c6bff59`; `7a158cf`/`124c5e2` profile changes on the installed profile.
4. Installed `~/.config/nono/profiles/opencode-v2-secure.json` parses (the repo copy does not).
5. Installed V2 files byte-identical to the repo copies.
6. Resolved plugin patch versions on V2.
7. `t7-flip-draft.md` steps 2-5 performed (repo shows only `BROKER_PLAN_ROOT_PROTECTION=1` in `systemd-user/broker.env` and live `PLAN_ROOT_PROTECTED` refusals).
8. Vision bridge OpenAI login on the V2 data root.
9. `asi-review-*` relay works end to end on the live V2 broker.

## Known defects found, out of scope
- (a) `nono/profile/opencode-v2-secure.json:140-141` has no comma between `"api.anthropic.com"` and `"platform.claude.com"`: invalid JSON (S17, owner fix).
- (b) `AGENTS.md` S17 list omits `opencode/plugins-v2/**` (owner decision).
- (c) Checklist `.git` write wording: corrected in U1.
- (d) `nono/profile/opencode-v2-secure.json:5` still ends "NOT INSTALLED" (S17).
- (e) `sandbox_apply_patch` accepts plan-root writes that `sandbox_write` refuses (`broker/src/service.ts:962`).

## Log
- 2026-11-01 U1 writer returned; result reviewed and installed; committed `f9a53c1`.
- 2026-11-01 Process deviation recorded: U1 skipped the PM layer. Owner interrupted the U2 direct dispatch; remaining units are re-routed through pm-odd.

## Next step
Dispatch pm-odd for U2 with a pm-unit-brief/v1, anchored to this tracker revision.


## Revisions
- r1 2026-11-01T10:11:17Z gentle-orchestrator: Create tracker for the post-V2-cutover documentation refresh
- r2 2026-11-01T10:14:32Z gentle-orchestrator: Record U1 commit, the PM-bypass deviation, and re-route remaining units through pm-odd
