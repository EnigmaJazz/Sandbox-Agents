# v2-docs-refresh — post-cutover documentation refresh and V2 update guide

## Objective
Bring all documentation, the TODO list and ODD trackers in line with the completed OpenCode V2 cutover, then publish one guide for applying plugin/config updates to V2.

## Status
COMPLETE for the documentation units; native review approved and acknowledged. Five advisory findings remain as later work.

## Scope
Documentation only. Out of scope (S17, owner action): `nono/**`, `systemd-user/**`, `scripts/**`, `opencode/**`, `broker/**`, `AGENTS.md`, `docs/threat-model.md`.

## Constraints
- Every status claim is repo-verified (path:line or commit) or labelled owner-attested.
- `odd/tasks/` is written only by the orchestrator through `host_plan_write`.
- Class: Documentation per `WORKFLOW.md:122` — matching docs skill (none installed; stated fallback) → delegated writer → proportional structural readback and owner review. No PM, no Planner, no advisors.

## Tasks
- [x] U1 Status and tracking docs. Writer `odd-apply` `ses_e6971aaf3ffd4Ls23cnATldgZQ`, 73 lines, commit `f9a53c1`. Deviation: first routed as an ODD unit; corrected on owner direction.
- [x] U2 Top-level docs (README, SECURITY, CLAUDE, architecture, operations, manual-verification). Writer `general` `ses_e6811d220ffej4bO3qReznA3OX`, 159 lines, commit `9e09877`. First attempt `ses_e681de21dffeB7kKdcHn2fsbvt` discarded: install refused because untracked `CLAUDE.md` was absent from the baseline; owner committed it as `9c1c070`.
- [x] U3 V2 update guide `docs/upgrades/opencode-v2-maintenance.md` (133 lines) plus checklist cross-link and corrected health-check coverage sentence. Writer `general` `ses_e6807490dffejiSQ0z7jCQMOwK`, 137 lines, commit `19ff2bc`.
- [ ] U1b Tracker upkeep in `odd/tasks/README.md` and reconciliation of `t7-flip-draft.md` / `multi-agent-v2-host-tools.md`. Deferred: tool-managed Revisions/Ticks sections.
- [ ] Workspace `ROUTER-LOG.md` row for this task (needs a writer).

## Acceptance criteria
- No edited document asserts that nothing is installed or that V1 is the working build. MET (grep over the six U2 files; remaining "Gate 1" hits are the historical heading and Gate 10/11 headings).
- The maintenance guide gives exact commands per update type with verification and rollback, each checked against the scripts. MET.
- TODO tier counts match item counts. Not re-verified.

## Review (native RDD)
- Lineage `review-64fe04b275bb1eb8`, target `sha256:d1b15934a7bf…`, base tree `42860660…`, candidate tree `955cd8d6…`, base ref `9c1c070` (committed-only, untracked excluded).
- Consent: granted by the owner through the provider envelope. Start created four lenses; `review-risk` and `review-resilience` admitted directly, `review-readability` and `review-reliability` were first refused at capture (`reviewer_result_not_admissible`) and were captured from the completed lens results.
- Outcome: **approved**, zero blocking findings. Acknowledgement burned authority; consumed revision `sha256:825871373e01…`. Reviewed boundary is the candidate tree at commits through `aee56e0`.
- Advisory (informational, non-blocking, later work):
  - `R2-quickstart-rollback-example` (WARNING, readability): README quick start validates only the retained V1 rollback profile, with no example for verifying the working V2 build.
  - `R2-duplicated-profile-warning` (SUGGESTION): the invalid-profile warning appears twice in the maintenance guide.
  - `R2-volatile-line-pins` (SUGGESTION): the guide cites many line numbers in files outside the candidate, which will rot.
  - `R2-vague-test-record` (SUGGESTION): manual-verification lost the concrete historical test count.
  - `R3-001` (WARNING, reliability): the update loop has no gate between installing the reviewed files (which include the known-invalid profile) and restarting the service.
- Refuter: none dispatched; the review closed on the four lenses.
- Correction rounds used: 0.

## Owner to confirm
1. Exact cutover date; 2.2.2 running on port 4097.
2. OpenChamber 2 install/attach state.
3. Broker restarted after `c6bff59`; `7a158cf`/`124c5e2` profile changes.
4. Installed `~/.config/nono/profiles/opencode-v2-secure.json` parses.
5. Installed V2 files byte-identical to the repo copies.
6. Resolved plugin patch versions (record them in the guide's table).
7. `t7-flip-draft.md` steps 2-5 performed.
8. Vision bridge OpenAI login on the V2 data root.
9. `asi-review-*` relay works end to end on the live V2 broker.

## Known defects found, out of scope
- (a) `nono/profile/opencode-v2-secure.json:140-141`: missing comma, invalid JSON (S17, owner fix). Documented in the guide's known gaps and in advisory `R3-001`.
- (b) `AGENTS.md` S17 list omits `opencode/plugins-v2/**`.
- (c) `nono/profile/opencode-v2-secure.json:5` still ends "NOT INSTALLED".
- (e) `sandbox_apply_patch` accepts plan-root writes that `sandbox_write` refuses (`broker/src/service.ts:962`).

## Log
- 2026-11-01 U1 `f9a53c1`; owner `CLAUDE.md` `9c1c070`; U2 `9e09877`; U3 `19ff2bc`.
- 2026-11-01 Native review started on owner consent, four lenses dispatched through the `asi-review-*` relay.
- 2026-11-01 Review approved, acknowledged, authority burned, boundary advanced.

## Next step
Address the two WARNING advisories as later work (`R3-001` first: put a profile-validation gate before the service restart), then U1b and the router-log row.


## Revisions
- r1 2026-11-01T10:11:17Z gentle-orchestrator: Create tracker for the post-V2-cutover documentation refresh
- r2 2026-11-01T10:14:32Z gentle-orchestrator: Record U1 commit, the PM-bypass deviation, and re-route remaining units through pm-odd
- r3 2026-11-01T16:56:06Z gentle-orchestrator: Record U2 and U3 completion, review state, and remaining upkeep
- r4 2026-11-01T17:01:38Z gentle-orchestrator: Record approved review lineage, acknowledg
