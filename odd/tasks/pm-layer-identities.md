# PM-layer host-mutation identities

## Objective

Authorize the workflow-side project-manager (PM) agents to run the host mutations currently restricted to `gentle-orchestrator`, without allowing PMs or workers into the sandbox. Record the security contract, implementation checks, and live evidence still required before relying on the new identities.

## Problem

The host-mutation identity allowlist was extended for workflow-side `pm-odd`, `pm-systematic`, and `pm-sdd`, and temporarily included `pm-probe` for the workflow-side go/no-go probe. The workflow side has now closed that probe (reported as the condition for this removal). This change removes `pm-probe` from the plugin and broker identity lists and the broker mutation map. A lingering session record bearing that name is no longer allowlisted and is denied mutations; it does not inherit another identity's rights. Allowlist changes must preserve sandbox separation, trusted session binding, and read access for every agent.

## Scope

- The final host-mutation identity allowlist is `gentle-orchestrator`, `pm-odd`, `pm-systematic`, and `pm-sdd`; `pm-probe` was temporary and is removed after the workflow side closed its probe.
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

## Pre-code security advice

### Implementation unit — pre-code

- `advisor-security-pre` reviewed the change before implementation. These findings are **advisory evidence, not approval**.
- `HostToolPolicy` grants **every** listed mutation to **every** allowlisted identity. There is no identity×operation matrix. A flat widening would therefore have handed PMs `registerProject`, `gitPush`, `ghIssueCreate`, the entire review set, the SDD document mutations, `sandboxResultInstall`, and `advisorAsk`. This is why the implementation enforces an explicit broker-side limit.
- The `registerProject` restriction is necessary, not optional: registration can create remotes and change visibility and touches `.atl`, profile, broker, and launcher config. A flat list would leave exclusion to host permissions while the broker still accepted it.
- Invariant 6 had a concrete gap: the plugin's `ensureWorker` sends no agent, the broker writes `agent: req.agent`, and the binding path checked only a **conflicting** identity and never worker state, history, or parentage. A worker created without a recorded agent could later accept a privileged binding. This is why the binding guard is a prerequisite, now implemented.
- “Reads stay open” is true only of **host** reads; `sandbox_read`, `sandbox_list`, `sandbox_grep`, and `sandbox_diff` refuse allowlisted identities.
- One effective source: the plugin could consume the broker's `policy.readOnlyAgents` and fail closed; the drift test proves repository-default equality only.

## Stable tasks

- [x] **T1 — Choose and update the shared identity source.** Add `pm-odd`, `pm-systematic`, `pm-sdd`, and temporary `pm-probe` alongside `gentle-orchestrator`; prefer one shared configured source, or retain synchronized broker/plugin constants with a drift test. Preserve per-operation authorization; apply the `registerProject`-only restriction to `gentle-orchestrator`.
- [x] **T2 — Preserve identity binding and sandbox separation.** Verify host-resolved binding, first-binding-wins behavior, fail-closed unknown sessions, host reads, worker exclusion, and the rule that a worker cannot be bound as a PM, including as a child of a PM session.
- [x] **T3 — Add identity-specific regression coverage.** Broker and plugin tests cover each of the six invariants for each new identity (`pm-odd`, `pm-systematic`, `pm-sdd`, `pm-probe`), with the six-invariant coverage explicitly **partial** pending the remaining integration-level checks:
  1. A PM never enters the sandbox: `ensureWorker` refuses allowlisted identities, and `sandbox_*` mutation tools refuse them.
  2. Binding is host-resolved only from `chat.params` hook input, never a tool argument or request envelope.
  3. First writer wins: a session bound to one identity is never rebound.
  4. Unknown sessions fail closed: no binding means no mutation.
  5. Reads remain open to every agent.
  6. A worker never becomes a PM, including as a child of a PM session.
- [x] **T4 — Keep delivery records and manual installation aligned.** Installer and rollback lists needed no change because `sandbox-tools.ts` was already listed in both; deliver exact bytes for owner review and installation under the existing manual gate.
- [x] **T5 — Answer five evidence questions by live observation after install.** Record the actual observation and evidence for each; mark any part that remains untested:
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

- [x] T1 — identity source and broker-side per-operation limits implemented; implementation commit `6dfe9ab`.
- [x] T2 — binding and sandbox-separation guards implemented; implementation commit `6dfe9ab`.
- [x] T3 — identity-specific regression coverage added; implementation commit `6dfe9ab`. Six-invariant coverage remains **partial**: runtime invocation of every sandbox tool per identity, direct end-to-end proof that tool arguments or the request envelope cannot supply the binding identity, and an integration-level PM-child lifecycle path remain pending.
- [x] T4 — installer and rollback lists needed no change because `sandbox-tools.ts` was already listed in both.
- [x] T5 live-evidence portion — five answers recorded below as live observations after installation; T5.3 full context delivery remains untested.
- [x] Update this tracker with the implementation and live evidence; tracker commit `e0bbd40`.
- [x] Remove temporary `pm-probe` after workflow-side closure and add regression coverage for stale-session denial and envelope/tool-argument identity spoofing.

## Review disposition

The PM-layer identity change was approved and acknowledged with authority burned under lineage `review-f08baf883fae880d`, for candidate `685e394..444d1e1`; the last-reviewed boundary is `444d1e1`. The eleven provider-designated, non-blocking advisories are recorded in `docs/TODO.md` Tier 4 and are separate later work, not grounds to rerun or reopen review on this candidate. The risk lens returned no findings and confirmed the identity×operation matrix, broker-side `registerProject` restriction, lifecycle guard, drift test, coverage of all six invariants, and minimal `pm-probe` scope.

Outstanding work remains explicit: T3's six-invariant coverage is partial as described above; T5.3 full reviewer-relay context delivery remains untested; and removal verification is partial. This change tests repository-default broker policy, confirms that `pm-probe` is absent from the mutation map, checks plugin/broker identity-list parity, and proves a stale `pm-probe` session is denied. After installation, the effective broker policy and installed plugin bytes still need checking. A live refusal from a previously bound `pm-probe` session requires a running stack and is not established by these unit tests.

## Evidence

- Source contract and original requirements: `docs/handovers/2026-10-04-pm-layer-agent-sandbox-integration.md`.
- Pre-code review by `advisor-security-pre` is recorded above as advisory evidence, not approval.
- Implementation commit: `6dfe9ab`. Its own RED run was `729 pass, 6 fail`; GREEN was `751 pass, 0 fail, 3406 expect() calls, 49 files`.
- Observed integration lesson: `odd/tasks/pm-layer-identities.md` was applied to the working tree but never committed. A sandbox result whose baseline is built from git state could therefore not install; the fail-closed baseline-divergence check refused rather than overwriting, and the check was right.
- The five T5 results below are **live observations after installation**.
- Broker tests for this tracker update: `bun --cwd broker test --reporter=dot` reported `751 pass`, `0 fail`, `3406 expect() calls`, and `Ran 751 tests across 49 files. [3.30s]`.
- Reviewability receipt for this tracker update: 64 authored changed lines (48 additions, 16 deletions). Patch-byte measurement was attempted with a Python subprocess measurement command, but the sandbox refused it as `argv item contains shell metacharacters`; byte count is unmeasured.

## T5 — Live observations after installation

These are **live observations after installation**, with evidence and inference distinguished explicitly.

1. **T5.1 — Subagent binding: OBSERVED, the child IS bound.** From a `pm-probe` child, `host_git_commit` returned `cannot commit: no applied B→C result for this session` and `host_review_start` returned the SDD runtime's `untracked files require an explicit declaration` stderr. **No `HOST_MUTATION_*` token appeared.** This is decisive because `buildGitCommitOp` calls `authorizeHostDispatch` before `resolveCommitResult` (`broker/src/service.ts:2517` vs. `:2519`), and `buildReviewStartOp` does the same before its runtime call (`broker/src/sdd-service.ts:269` vs. `:282`): those business errors are unreachable unless authorization passed. Answer: `chat.params` **fires for a Task-tool child and binds it**; it does not carry the parent's name and does not fail open. The bound identity is **inferred** to be `pm-probe`, not directly observed; the broker echoes no identity on a permitted call.
   - **Earlier-run ambiguity and resolution (important for future probes):** a prior run returned `host mutation tool "gitCommit" is orchestrator-only (HOST_MUTATION_UNKNOWN_AGENT)`, which initially looked like Task children were not bound. That was not the cause: the **installed** plugin still carried `READ_ONLY_AGENTS = ["gentle-orchestrator"]` at line 64, so the hook could not bind any PM identity. After the installer ran, the installed plugin listed all five identities at lines 64–70 and binding succeeded. An unbound result must be checked against the **installed** plugin before being read as a hook defect.
2. **T5.2 — Resumed sessions: OBSERVED, the binding survives a resume.** Resuming the same child via `task_id` and re-attempting `host_git_commit` returned the same deeper business error with no `HOST_MUTATION_*` token. Two mechanisms remain consistent and were **not distinguished**: `chat.params` re-sends the binding per turn, and `bindSessionAgent` is idempotent for the same identity (`broker/src/service.ts:248-257`). The call result is observed; the mechanism is not observed.
3. **T5.3 — Review relay from a subagent: OBSERVED, reachable but not fully exercised.** Dispatching an `asi-review-*` Task from the depth-1 child returned `opencode_reviewer_relay_refused: reviewer_relay_frame_refused: relay Task prompt has no provider-issued review binding`. Dispatch reached the relay and was refused at the frame layer for lack of a provider-issued binding, expected with no live lineage attached; this was not a session-root or parent-resolution failure. Full context delivery remains untested.
4. **T5.4 — PM read surface: OBSERVED.** A PM holds `read`, `glob`, the AFT tools, `codegraph_codegraph_explore`, `ast_grep_search`, and the context tools, plus the host read operations enumerated at `broker/src/validation.ts:809-820`. It holds **no** `sandbox_*` tools, intentionally, because it has no way to activate a sandbox, and no host `bash`. Repository inspection uses AFT navigation + CodeGraph relationships + `ast_grep_search` structure + a bounded `read` of a known allowed path.
5. **T5.5 — Nested depth: OBSERVED in code, with control.** No behavior in `broker/src/**` or `opencode/plugins/**` is sensitive to session depth or walks `parentID`: an AST search for `depth` across those 36 files returned **no matches**, with the positive control that the same search found `parentID`. `subagent_depth` appears only in documentation. The sole `parentID` uses are `opencode/plugins/lib/reviewer-relay-core.ts:1390` and `:1394`, where it logs presence/length and correlates a registration—not a depth gate. Raising `subagent_depth` from 3 to 4 should not alter the binding path, `ensureWorker`, or relay session-root resolution.

## Contract statement

- **Identities permitted to run host mutations, with per-operation limits:** `gentle-orchestrator` — every `HOST_MUTATION_OPERATIONS` entry. `pm-odd`, `pm-systematic`, and `pm-sdd` — every such entry except `registerProject`. The temporary `pm-probe` entry is removed. Enforced broker-side in `HOST_MUTATION_IDENTITY_OPERATIONS`.
- The five answers above are recorded as observed results. Not observed: the bound identity echo on a permitted call, which of the two resume mechanisms applies, full review-relay context delivery, and the pending integration checks listed under Progress.
- **Required restarts:** `sandbox-broker.service` and `secure-opencode.service`.
- **`pm-probe` removal verification:** this change covers repository-default broker policy and a stale-record unit test. Effective broker policy and installed plugin bytes can be verified after installation. A live refusal from a previously bound probe session requires a running stack and remains outstanding.

## Next step

Complete the pending runtime and integration checks. For `pm-probe` removal, verify effective broker policy and installed plugin bytes after installation; use a running stack to observe refusal from a previously bound probe session.
