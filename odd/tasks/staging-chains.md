# ODD Tasks — staging-chains

- **Feature:** `staging-chains`
- **Project:** `sandbox-integration`
- **Status:** planned — tracker only; P0 docs written, no code started
- **Created:** 2026-11-05
- **Delivery strategy:** `ask-on-risk`
- **Chain strategy:** `stacked-to-main` (the user's standing choice)
- **Plan:** `docs/staging/plan.md` (scope: D24 note in that file)
- **Source specs:** `workflow_optimisation` `docs/specs/multi-tier-orchestration-criteria.md` (S70-S95) and `multi-tier-orchestration.md` (D22, D24)

## Objective

Build the staged work chain at the D24 scope (P0-P2, a reduced P4, P6 kept, P5 only if unattended multi-stage work needs it, P3 deferred), then the D22 gate-verdict author change as its own B2 unit.

## Rules for every unit

- Test-first: the new tests fail before the code is written.
- Before commit: `cd broker && bun test` is green and `cd broker && bun build --target=bun src/main.ts` passes.
- Start each unit from a clean checkout or worktree outside any dirty checkout (S72). Do not start unattended multi-stage work before the workflow enforcement in the plan's "Where this falls in the wider queue" is live.
- Code is under S17 paths: the user reviews the diff and installs it. Agents never certify a manual gate.
- One work-unit commit per task, about 400 changed lines at most.

## Tasks

| ID | Phase | Specs | Status | Notes |
|---|---|---|---|---|
| T1 | P0 docs: threat-model section, plan D24 note, this tracker | S70, S90, S86, S87 | written, uncommitted; the user reviews `docs/threat-model.md` (S17) | The spike result is in `workflow_optimisation` `odd/advice/b0-native-review-on-staged-refs.md`. Review location stays OPEN-1 (S71, S79 blocked). |
| T2 | P1: chain and stage records, refs, `chainCreate` / `chainStatus`, worker starts from the tip, stage registered on finish | S76, S77 | pending | Broker derives baselines. Host tree unchanged until apply. |
| T3 | P2: stage-review role and allowlist, global deny of `host_stage_*`, `host_stage_list/show/approve/reject/apply`, in-order apply, `sandboxctl stages` | S78, S80, S81 | pending | Touches `opencode/plugins/**`, `opencode/config-fragments/**` and both installer parity lists. S79 waits for OPEN-1. |
| T4 | Reduced P4: reject, `STALE`, re-run from the tip | S82, S83, S84, S85 | pending | No merge-tree replay and no conflict hand-back. Needs adversarial tests. |
| T5 | P6: gated acceptance tests in `tests/acceptance/`, manual gate | S88, S89 | pending | The user runs and signs off; no agent self-certifies. |
| T6 | B2 gate routing: D22 `host_gate_verdict` author change | S93, S94, S95 | pending | Isolated commit (high-risk item 3), then an independent verifier. Contract: `docs/contracts/multi-agent-v2-workflow-prompt.md`. |

Not scheduled: P3 (S86, deferred), P5 (S87, only on a demonstrated unattended multi-stage need; record the need or its omission here). S93 (Tier 5 has no Engram write) is placed in T6 (owner decision, 2026-11-06).

## Log

- 2026-11-05: tracker created by the multi-tier-orchestration T6 unit U0 (docs only; no tests apply).
- 2026-11-06: owner placed S93 in the B2 gate-routing unit (T6).
- 2026-11-06: P1 (8c88d44) independently verified: no blockers; S76, S77 pass; non-chain differential against d61f322 identical. Carry-forward from the advisories: (1) a refused re-finish moves refs/opencode-sandbox/result/<session> before the pin refuses, so apply must read refs/.../stage/<n>, never the session result ref; (2) chainAttach must call assertSessionID when it becomes a socket op (P2); (3) a stage claim can leak when a worker is released after a failed finish, so the reduced P4 needs a documented way to release or rebuild a stage claim; (4) `chain` is not shape-validated on load (broker-written only; validate when convenient).
- 2026-11-06: P2a (9b39247) independently verified: no blockers; deny-by-default held against 13 identities and forged envelope claims; 9,819-dispatch differential against d61f322 identical. Advisories queued for a hardening unit after U2b: (A1) stageReviewAgents accepts plan roles such as planner and pm; refuse names in HOST_MUTATION_IDENTITY_OPERATIONS or plan roles; (A2) normalize and dedupe config names; (A4) strict string types in the new operation builders instead of String() coercion; (A5) changedPaths returns worker-authored file names verbatim to the stage-review model (prompt-injection surface): escape or cap them; (A6) stage-review tool admission is wider than the two stage tools (defence in depth). Owner-visible notes: chainCreate and chainAttach are held by gentle-orchestrator and all pm-* identities, matching the existing mutation pattern; chain ids are 48 bits of randomBytes (not a secret).
