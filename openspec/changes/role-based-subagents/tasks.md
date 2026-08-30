# Tasks: Role-Based Subagents

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | P0 180; A 260; B 420; C 360; D 180 (1,400 total) |
| 800-line budget risk | High; each slice capped below 800 |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 P0 → PR 2 A → PR 3 B → PR 4 C → PR 5 D |
| Delivery strategy | auto-chain (800-line budget) |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|
| 1 | Capability model/config | PR 1 | `cd broker && bun test` | N/A: config/policy unit | P0 files |
| 2 | Orchestrator exclusion | PR 2 | `cd broker && bun test` | N/A: guarded lifecycle | A files |
| 3 | Researcher/Worker routing | PR 3 | `cd broker && bun test` | N/A: broker flow tests | B files |
| 4 | Consultation protocol | PR 4 | `cd broker && bun test` | N/A: state-machine tests | C files |
| 5 | Gate preparation | PR 5 | `cd broker && bun build src/main.ts` | N/A: manual gates user-owned | D files |

## Phase 0: Central Capability Model

- [x] **0.1 RED — policy matrix.** Add failing tests for unknown effects, complete authorization context, AFT classification, model-policy independence, and live-security denial. Files: `broker/tests/role-policy.test.ts`. Verify: `cd broker && bun test`; deps: none; reqs: role-model R1–R5.
- [x] **0.2 GREEN — policy/config.** Implement capability classes, fail-closed decision function, role model knobs, and role config block. Files: `broker/src/role-policy.ts`, `broker/src/config.ts`, `broker/src/types.ts`, `opencode/config-fragments/role-agents.jsonc`. Verify: `cd broker && bun test`; deps: 0.1; reqs: role-model R1–R5, delegation-roles R5.

## Phase A: Read-Only Orchestrator

- [x] **A.1 RED — exclusion.** Test zero orchestrator `sandbox_*` tools, broker `ensureWorker` refusal without side effects, and plugin pre-dispatch denial. Files: `broker/tests/role-policy.test.ts`; deps: 0.2; reqs: orchestrator-readonly R1–R3.
- [x] **A.2 GREEN — guards.** Add `readOnlyAgents`, trusted-role refusal, plugin guard, orchestrator config, and permission maps. Files: `broker/src/{config,service,server}.ts`, `opencode/plugins/{routing-guard,sandbox-tools}.ts`, `opencode/config-fragments/sandbox-permissions.jsonc`, `opencode.json`. Verify: `cd broker && bun test`; deps: A.1; reqs: orchestrator-readonly R1–R4.
- [x] **A.3 REFRESH — installed source.** Refresh `opencode/plugins/sandbox-tools.ts` while retaining apply-preview flow and verify config parity. Files: `opencode/plugins/sandbox-tools.ts`; verify: `git diff --check`; deps: A.2; reqs: orchestrator-readonly R1–R3.

## Phase B: Researcher/Worker Roles

- [ ] **B.1 RED — relationship/attach.** Cover forged, cross-parent, expired, missing, stale-host, allowlist, and mutation-denial cases. Files: `broker/tests/researcher-routing.test.ts`; deps: A.2; reqs: researcher-routing R1–R5.
- [ ] **B.2 GREEN — lifecycle.** Implement trusted registration, parent-child validation, read-only attach, and broker client operations. Files: `broker/src/{state,service,server,logging}.ts`, `opencode/plugins/lib/broker-client.ts`; verify: `cd broker && bun test`; deps: B.1; reqs: researcher-routing R1–R5, delegation-roles R3–R5.
- [ ] **B.3 CONFIG — roles/network.** Add Researcher/Worker definitions, permissions, and approved Researcher web hosts; preserve worker network constraints. Files: `opencode/config-fragments/role-agents.jsonc`, `opencode/prompts/role-routing.md`, `opencode/config-fragments/sandbox-permissions.jsonc`, `nono/profile/opencode-secure.json`; verify: `cd broker && bun test`; deps: B.2; reqs: delegation-roles R1–R4, role-model R3–R4.

## Phase C: Advisor/Deliberation

- [ ] **C.1 RED — protocol/anti-loop.** Test briefing schema/codes, Advisor-first opt-in, three rounds, participant failure, outcomes, evidence-hash and depth caps. Files: `broker/tests/role-policy.test.ts`; deps: B.2; reqs: advisor-deliberation R1–R6.
- [ ] **C.2 GREEN — state machine.** Implement advisor, solver, challenger, judge, fresh-eyes definitions and bounded transitions. Files: `opencode/config-fragments/role-agents.jsonc`, `opencode/prompts/role-routing.md`, `broker/src/{service,state,types}.ts`; verify: `cd broker && bun test`; deps: C.1; reqs: advisor-deliberation R1–R6.
- [ ] **C.3 RED/GREEN — ledger.** Test and implement bounded redacted events for decisions, relationships, consultations, rounds, outcomes, and logging failure. Files: `broker/src/logging.ts`, `broker/src/types.ts`, `broker/tests/role-policy.test.ts`; verify: `cd broker && bun test`; deps: C.2; reqs: observability R1–R5.

## Phase D: Security Gate Preparation

- [ ] **D.1 RED — regressions.** Add regression coverage for orchestrator denial, stale-host refusal, worker isolation, and bounded consultation. Files: `broker/tests/{role-policy,researcher-routing}.test.ts`; verify: `cd broker && bun test`; deps: A.2,B.2,C.3; reqs: all applicable requirements.
- [ ] **D.2 DOC/GATE.** Record S17 revert/manual-review note, protected-path status, rollout exclusions, and open web-provider question. Files: `docs/threat-model.md`; verify: `git diff --check`; deps: D.1; reqs: role-model R5, observability R3.
- [ ] **D.3 FINAL.** Run full tests/build; user performs manual security gates 0–10 and controlled integration. Files: all changed paths; verify: `cd broker && bun test && bun build src/main.ts`; deps: D.2; reqs: all.

Threat matrix: all rows are explicitly N/A; no matrix-specific RED tasks are required.
