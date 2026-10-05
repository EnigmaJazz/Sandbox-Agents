# PM-layer host-mutation identities

## Objective

Authorize the workflow-side project-manager (PM) agents to run the host mutations currently restricted to `gentle-orchestrator`, without allowing PMs or workers into the sandbox. Record the security contract, implementation checks, and live evidence still required before relying on the new identities.

## Problem

The host-mutation identity allowlist currently names only `gentle-orchestrator`. The workflow-side design moves work-unit coordination and host mutations to `pm-odd`, `pm-systematic`, and `pm-sdd`; a temporary `pm-probe` is also needed for the workflow-side go/no-go probe. Without extending the host-resolved identity allowlist, PM host mutations are refused. Allowlist changes must preserve sandbox separation, trusted session binding, and read access for every agent.

## Scope

- Extend the host-mutation identity allowlist to `gentle-orchestrator`, `pm-odd`, `pm-systematic`, `pm-sdd`, and temporary `pm-probe`.
- Prefer one configured list read by broker and plugin. If a shared source is impractical, retain two constants and test that they remain identical.
- Review the named identity paths: `opencode/plugins/sandbox-tools.ts:64` (`READ_ONLY_AGENTS`), `broker/src/config.ts:243` (`DEFAULT_READ_ONLY_AGENTS`), `authorizeHostDispatch`, `bindSessionAgent`, and `assertBindableAgent` in `broker/src/service.ts`, and `shouldRefuseEnsureWorker` in `broker/src/role-policy.ts`.
- Preserve the existing per-operation authorization. Optional refinement, at the implementer's discretion: keep `registerProject` limited to `gentle-orchestrator` while PMs receive the remaining host mutations. A flat identity list is acceptable because workflow-side `opencode.json` permissions also enforce this split.
- Test all six security invariants for every new identity.
- Gather the five open, live-observation answers listed under T5 after installation; do not substitute inference for observed behavior.
- If an installed file changes, update installer and rollback lists. Delivery remains behind the existing manual gate: the owner reviews and installs the exact bytes.
- Return a concise contract statement covering authorized identities and operation limits, the five observed answers, and required restarts (`sandbox-broker.service`, `secure-opencode.service`).

## Non-goals

- No change to the advisor relay or `docs/advisor/interface-contract.md`.
- No change to worker roles, sandbox isolation, or review-lens transport beyond investigating the subagent-dispatch question in T5.
- The workflow side owns `opencode.json`, PM prompts, routing guard, and verifier.

## Constraints

- Treat `broker/src/**` and `opencode/plugins/**` as S17: the owner reviews and installs those bytes manually.
- Keep broker implementation dependency-free; use fixed argv and fail closed.
- Do not claim a live probe result until it has been observed after installation.
- Remove temporary `pm-probe` from the allowlist once the workflow side reports the probe closed.
- Keep this task record faithful to the 2026-10-04 handover; no additional requirements are implied.

## Stable tasks

- [ ] **T1 — Choose and update the shared identity source.** Add `pm-odd`, `pm-systematic`, `pm-sdd`, and temporary `pm-probe` alongside `gentle-orchestrator`; prefer one shared configured source, or retain synchronized broker/plugin constants with a drift test. Preserve per-operation authorization; decide whether to apply the optional `registerProject`-only refinement.
- [ ] **T2 — Preserve identity binding and sandbox separation.** Verify host-resolved binding, first-binding-wins behavior, fail-closed unknown sessions, open reads, worker exclusion, and the rule that a worker cannot be bound as a PM, including as a child of a PM session.
- [ ] **T3 — Add identity-specific regression coverage.** Broker and plugin tests must cover each of the six invariants for each new identity (`pm-odd`, `pm-systematic`, `pm-sdd`, `pm-probe`):
  1. A PM never enters the sandbox: `ensureWorker` refuses allowlisted identities, and `sandbox_*` mutation tools refuse them.
  2. Binding is host-resolved only from `chat.params` hook input, never a tool argument or request envelope.
  3. First writer wins: a session bound to one identity is never rebound.
  4. Unknown sessions fail closed: no binding means no mutation.
  5. Reads remain open to every agent.
  6. A worker never becomes a PM, including as a child of a PM session.
- [ ] **T4 — Keep delivery records and manual installation aligned.** Update installer and rollback lists if any installed file changes; deliver exact bytes for owner review and installation under the existing manual gate.
- [ ] **T5 — Answer five open evidence questions by live observation after install.** Record the actual observation and evidence for each; do not infer an answer:
  1. For a child session created by the Task tool, does `chat.params` fire with the subagent's own name so the broker binds the child, carry the parent's name, or not fire?
  2. Does the binding remain valid when the PM session resumes through the Task tool's `task_id`?
  3. Does `opencode/plugins/reviewer-relay-transport.ts` deliver review context when the dispatching session is itself a depth-1 subagent?
  4. What does a PM receive from `sandbox_read`, `sandbox_list`, `sandbox_grep`, and `sandbox_diff` (each calls `assertNotOrchestrator`)? If refused, which read surface should the PM use instead?
  5. Is any broker or plugin behavior sensitive to session depth or walking `parentID`, given the workflow side will raise `subagent_depth` from 3 to 4?

## Acceptance criteria

- Broker and plugin tests cover each of the six invariants for each new identity.
- The broker and plugin use one shared configured identity source, or their two constants are protected by a test that fails if they differ.
- Existing per-operation authorization remains intact; if selected, `registerProject` is explicitly limited to `gentle-orchestrator` while PMs receive the other host mutations.
- Installer and rollback lists are updated whenever an installed file changes.
- Owner reviews and manually installs the exact bytes through the existing gate.
- The returned contract statement names identities permitted to run host mutations and any per-operation limits, reports observed answers to all five T5 questions, and names the required service restarts: `sandbox-broker.service` and `secure-opencode.service`.
- Temporary `pm-probe` is removed once the workflow side reports its probe closed.

## Authorized scope

Documentation preparation is limited to `odd/tasks/pm-layer-identities.md`, `docs/TODO.md`, and `docs/PLAN.md`. The subsequent implementation scope described by this record is the handover-named broker/plugin identity allowlist, binding, role-policy paths, related broker/plugin tests, and installer/rollback lists only if installed files change. The owner retains review and installation authority for S17 files. The workflow side retains ownership of `opencode.json`, PM prompts, routing guard, and verifier.

## Checks

- `sandbox_bash ["bun", "--cwd", "broker", "test", "--reporter=dot"]` from the project root; do not pass a cwd.
- Confirm authored changed-line count for the documentation result and attempt the authored patch-byte measurement; report the measured number or explicitly state if measurement is refused.
- Review the exact documentation diff and confirm no files outside the authorized documentation scope changed.
- Live probes for T5 are post-install evidence tasks and are not answered by this documentation-only result.

## Route and trigger evidence

- Route: delegated ODD documentation work; substantial tracker required before implementation.
- Trigger: this work comprises multiple recoverable tasks across tracker, TODO, PLAN, identity implementation, tests, and live probes.
- Scope for this result: documentation only; no source, test, plugin, or review changes.

## Progress

- [x] Read the source handover and the requested tracker/TODO/PLAN format references.
- [x] Create the tracker and integrate the Tier 2 TODO and PLAN design record.
- [x] Run the requested broker test command and prepare the documentation-only result for owner approval.
- [ ] Complete implementation and live evidence tasks only in a separately authorized work unit.

## Evidence

- Source contract: `docs/handovers/2026-10-04-pm-layer-agent-sandbox-integration.md`.
- Current tracker, TODO, and PLAN formatting references were read before authoring.
- The five T5 questions remain open; no live observations are claimed here.
- Broker tests: `bun --cwd broker test --reporter=dot` reported `729 pass`, `0 fail`, `3310 expect() calls`, and `Ran 729 tests across 49 files. [3.30s]`.
- Reviewability receipt: 136 authored changed lines (100 tracker additions, 33 PLAN additions, 2 TODO additions, 1 TODO deletion); no generated or binary paths in the documentation diff. An authored patch-byte measurement was attempted, but the sandbox refused the shell-character-containing command; byte count is unmeasured.
- The test run created a root-level untracked bundle, which was removed. Final scope verification remains pending.

## Next step

Review and install the exact documentation result under the existing manual gate. Then schedule the separately authorized allowlist implementation; perform T5's live probes after installation and remove `pm-probe` only after the workflow side reports its probe closed.
