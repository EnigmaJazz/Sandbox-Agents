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

## Broker sandbox identity runtime follow-up — 2026-10-07

- **Observed:** the broker's only sandbox-operation identity refusal seam is `buildEnsureWorkerOp` in `broker/src/service.ts:299-313`. A host-bound identity (from the stored record or, for an unbound session, the request agent) is rejected before session touch/admission with the exact reason suffix `orchestrator-readonly`; the test now asserts the exact message for all four configured identities. An unbound ordinary session with an already-active worker is a positive control and reuses the worker through the same `buildEnsureWorkerOp` runtime path.
- **Observed (2026-10-07 follow-up):** the broker now checks a bound session identity at the common sandbox dispatch boundary in `broker/src/server.ts` before any sandbox handler runs. The policy remains the existing configured `readOnlyAgents` allowlist and uses the `orchestrator-readonly` reason family. `ensureWorker` retains its existing refusal inside `buildEnsureWorkerOp`; request-envelope identity claims do not grant the new dispatch refusal or bypass it.
- **Observed (automated dispatch test):** for each of `gentle-orchestrator`, `pm-odd`, `pm-systematic`, and `pm-sdd`, each operation in the table below returns the exact identity refusal before its handler; the ordinary unbound positive control does not receive that refusal. This does not claim the handlers' ordinary state/payload paths succeed for the positive control.
- **Matrix, broker runtime, same result for each listed identity:** `ensureWorker` → `orchestrator agent "<identity>" is not allowed to create a worker (orchestrator-readonly)`; `workerStatus`, `exec`, `readFile`, `writeFile`, `applyPatch`, `listDir`, `grep`, `diff`, `prepareResult`, `applyResult`, `discardResult`, `keepResult`, `destroyWorker`, `listWorkers`, `copyInInfo`, `copyIn`, `copyOutInfo`, and `copyOut` → `orchestrator agent "<identity>" is not allowed to use sandbox operation "<operation>" (orchestrator-readonly)`.
- **Closure:** the previously missing broker identity × sandbox operation refusal seam is implemented and covered by a table-driven runtime dispatch test. Plugin-side guards remain a separate layer and were not changed. The broker source is S17-protected and still requires owner review/manual application.
- **Plugin-side limit:** the plugin's `assertNotOrchestrator` calls and tool exposure remain a separate layer. Existing coverage checks source declarations, not executing each plugin tool with each identity; this follow-up does not claim that layer as runtime-proven.
- **Verification:** the earlier ensureWorker fixture's first RED run exposed a broken positive-control fixture (the pre-seeded active session lacked a pinned baseline/git fixture), not a policy failure. After supplying a minimal fake git result and allowlisted project, GREEN was `781 pass, 0 fail`.
- **2026-10-07 dispatch follow-up verification:** RED was the new all-operation dispatch test failing because an operation returned successfully instead of the expected identity refusal; the initial fixture timed out once while its ordinary ensureWorker positive control attempted actual worker creation, then was bounded to an unregistered project path. GREEN with the fixed fixture: `782 pass, 0 fail, 3567 expect() calls; Ran 782 tests across 50 files. [4.48s]`. Command: `bun --cwd broker test --reporter=dot`.
- **Reviewability receipt for this follow-up:** authored line and patch-byte measurement are reported in the session result. The patch-byte measurement attempt may be refused by the sandbox argv policy; no unmeasured byte count is claimed.

## Follow-up finding — operation admission remains separate from exhaustive dispatch guards

- **Observed (2026-10-07, recorded only):** the `Operation` union includes `gitCommit`, `gitPush`, and `ghIssueCreate` (`broker/src/types.ts:82-85` at HEAD `093d03d`), and `BrokerServer.dispatch` has corresponding cases (`broker/src/server.ts:635-642` at that HEAD), but the `OPERATIONS` literal omits all three (`broker/src/types.ts:144-207` at that HEAD). `parseRequest` only checks that `req.operation` is a string and casts it to `Operation`; it does not validate membership in `OPERATIONS` (`broker/src/server.ts:553-559` at that HEAD).
- **Disposition:** pre-existing admission gap, separate from the sandbox-guard partition and exhaustive dispatch switch. Recorded for follow-up; no admission behavior changed in this unit.

## Next step

The broker-side all-operation refusal finding is closed in source and regression coverage; owner review and manual application remain required because the implementation touches S17 `broker/src/**`. The separate plugin-layer runtime identity coverage and post-install checks from the earlier `pm-probe` removal remain outside this follow-up.

## Parse-failure request correlation — 2026-10-08

- **Observed:** `parseRequest` validates `id` against `REQUEST_ID_RE` before checking `sessionID`, `operation` type, and operation length. The previous parse-failure envelope discarded that already-validated id and always used `"0"`, unlike the framer's recoverable oversize correlation.
- **Implementation:** `parseRequest` now returns a discriminated result: either `{ envelope }` or `{ id?, error }`. Failures before successful id validation omit `id`; each of the three checks after validation returns the validated id. This keeps protocol validation in one parser and makes the distinction explicit at the dispatch boundary. No response-path re-validation was added: `REQUEST_ID_RE` is authoritative at parsing, and only that validated string is propagated.
- **Behavior preserved:** malformed JSON, non-object input, unsupported version, invalid request id, and unrecoverable framer oversize retain their existing `"0"` fallback behavior. The request-line framer is unchanged. The allowlist rejection remains in dispatch and continues to use the real envelope id.
- **Tests:** socket assertions now verify that invalid `sessionID`, non-string `operation`, and an oversized operation each return the request's own id. Removed the false comment claiming the id could not be parsed. Advisor sockets share `dispatchLine` and therefore inherit this behavior without separate code changes.
- **TDD evidence:** RED with the new socket checks failed because the invalid-session response was keyed under `"0"`, leaving no reply under `invalid-session`; suite summary was `784 pass`, `1 fail`, `3562 expect() calls`, `Ran 785 tests across 50 files. [6.69s]`. GREEN summary: `785 pass`, `0 fail`, `3567 expect() calls`, `Ran 785 tests across 50 files. [4.59s]`.
- **Delivery:** `broker/src/**` is S17-protected; retain the sandbox result for owner review/manual application. Automatic application refusal must be recorded verbatim in the session result.

## Operation-name admission — 2026-10-07

- **Observed:** `parseRequest` now rejects operation names longer than 128 characters with the fixed validation message `operation name exceeds 128 characters`, before the value can reach dispatch or operation/error logging. The bound is shared by the main and advisor sockets because both route through `parseRequest`.
- **Derivation:** the longest member of the `Operation` union is `reviewCaptureCorrectionPlan` at 27 characters; 128 allows more than 4× headroom. Admission intentionally checks length only, not `OPERATIONS` membership: `gitCommit`, `gitPush`, and `ghIssueCreate` remain routed union operations although omitted from that literal.
- **Observed:** an unknown operation sent through the main socket reaches dispatch and returns a validation error envelope; it is not a thrown client-side exception. This replaces the previous host-read `state` error with `validation`. Whether any external client depended on the old code is **not established**.
- **Verification:** socket regression covers the unknown-operation envelope, the fixed oversized-name response without echo, and a successful `metrics` request on the same connection after rejection. RED: `784 pass`, `1 fail`, `3562 expect() calls`, `Ran 785 tests across 50 files. [6.74s]`; it reached dispatch and logged/echoed the 129-character value. GREEN: `785 pass`, `0 fail`, `3564 expect() calls`, `Ran 785 tests across 50 files. [4.58s]`.

## Dispatch-contract hardening — 2026-10-07

- **Observed:** required `BrokerConfig.readOnlyAgents` is now consumed directly by dispatch, `buildEnsureWorkerOp`, queued `createWorkerForSession`, `buildPolicyOp`, `authorizeHostDispatch`, and `assertBindableAgent`; the optional casts/fallbacks no longer weaken those consumers. Constructor validation rejects a missing/non-array/malformed list. An explicit empty list remains valid and means no agent is allowlisted; its policy meaning is unchanged.
- **Observed:** the dispatch test iterates its independent, hardcoded `EXPECTED_SANDBOX_OPERATIONS` literal and compares that expected membership against production `SANDBOX_OPERATIONS`, retaining exact refusal messages. Keeping the expected list independent prevents a production change from silently changing the test's own matrix and making the assertion self-confirming.
- **Observed:** `ensureWorker` remains excluded from the shared bound-record check because its handler must also reject an allowlisted envelope claim before store touch; creation continues to persist `agent: req.agent`. Direct-handler refusal tests, ordinary-worker reuse positive control, and the bound `ensureWorker` matrix case remain.
- **Observed:** unbound dispatch cases are specified individually: absent record → exact `unknown session` failure; identity-less record → successful `workerStatus`; ordinary identified worker → successful `workerStatus`; allowlisted envelope claim on unbound `ensureWorker` → exact established policy refusal with no session record created.
- **Deferred at this unit; superseded by “Exhaustive sandbox-guard partition — 2026-10-07” below:** no exhaustive `Record<Operation, classification>` had yet been added. The current unit's scope did not establish a meaningful classification for every protocol operation; the following unit implemented the exhaustive partition rather than adding a partial table that appeared complete.
- **Verification:** RED command: `bun --cwd broker test --reporter=dot`; `782 pass`, `1 fail`, `3556 expect() calls`, `Ran 783 tests across 50 files. [4.57s]`. The failure was the expected constructor assertion: expected `BrokerConfig.readOnlyAgents must be an array of non-empty agent names`, but `BrokerServer` did not throw. GREEN command: `bun --cwd broker test --reporter=dot`; exact summary: `783 pass`, `0 fail`, `3557 expect() calls`, `Ran 783 tests across 50 files. [4.48s]`.
- The S17 source change must remain a retained sandbox result for owner review/manual application; broker apply refusal is expected under the repository's protected-path policy.

## Follow-up finding — sandbox-guard exhaustiveness is not type-checked here

- **Observed in source:** `SANDBOX_GUARD_CLASS` partitions `Operation` with `satisfies Record<Operation, SandboxGuardClass>` in `broker/src/types.ts`; `BrokerServer.dispatch` uses a `never` assignment and rejecting default in `broker/src/server.ts`.
- **Verification limitation:** no type-checker is available in this environment. `bun x --no-install tsc`, `bunx --no-install tsc`, and direct `tsc` all failed to run without a download. `bun test` and `bun build` transpile TypeScript; they do not semantically type-check it. Therefore compile-time exhaustiveness is **not verified here**. Only runtime behavior and transpilation were verified; do not assume the exhaustiveness guarantee is enforced.
- **Runtime distinction:** the sandbox guard runs before the dispatch switch, so case position is irrelevant. Every `sandbox-dispatch-guard` operation is refused regardless of where its case sits. The denial test proves this per operation against an independently maintained literal. What remains unenforced here is compile-time agreement, not runtime refusal.
- **Follow-up:** add a real type-check gate (`typecheck` script plus the TypeScript dependency) so exhaustiveness is enforced rather than asserted. Installing dependencies is outside this environment's authority.
- **Separate open finding:** the existing `OPERATIONS` admission gap remains distinct: `gitCommit`, `gitPush`, and `ghIssueCreate` are missing from the literal although present in the union and dispatch, and `parseRequest` does not validate membership. See “Follow-up finding — operation admission remains separate from exhaustive dispatch guards” above; this section does not merge or close it.

## Exhaustive sandbox-guard partition — 2026-10-07

- **Observed:** `Operation` is exhaustively assigned by `SANDBOX_GUARD_CLASS` (`satisfies Record<Operation, SandboxGuardClass>`). The assignment was derived from actual dispatch cases and handler behavior, not operation names; a label alone does not prove the handler code matches it.
- **Partition (operation → class):**
  - `sandbox-dispatch-guard` (18): `workerStatus`, `exec`, `readFile`, `writeFile`, `applyPatch`, `listDir`, `grep`, `diff`, `prepareResult`, `applyResult`, `discardResult`, `keepResult`, `destroyWorker`, `listWorkers`, `copyOutInfo`, `copyOut`, `copyInInfo`, `copyIn`.
  - `sandbox-handler-guard` (1): `ensureWorker`.
  - `exempt-from-sandbox-guard` (46): `metrics`, `sddStatus`, `sddContinue`, `sddArchiveCompose`, `sddTaskResult`, `reviewAssess`, `reviewModeStatus`, `reviewStatus`, `reviewLensContext`, `sddAttemptGrant`, `planDocAppend`, `sandboxResult`, `sandboxResultInstall`, `bindSessionAgent`, `reviewStart`, `reviewCaptureResult`, `reviewCaptureUnachievable`, `reviewAcknowledgeApproved`, `reviewCaptureCorrectionPlan`, `reviewCaptureRefuter`, `reviewCaptureValidation`, `reviewValidate`, `reviewRecover`, `gitCommit`, `gitClearCommitIntent`, `gitPush`, `ghIssueCreate`, `hostSystemSummary`, `hostMemory`, `hostDiskUsage`, `hostNetworkListeners`, `hostProcessList`, `hostServiceStatus`, `hostServiceLogs`, `hostTailscaleStatus`, `hostDockerList`, `hostDockerLogs`, `policy`, `registerProject`, `resultDiff`, `advisorAsk`, `advisorGet`, `advisorList`, `advisorRead`, `advisorRespond`, `evidenceKeep`.
- **Classification traps:** `sddContinue` is policy-treated as a host read. `advisorRead` writes a claim and `evidenceKeep` executes worker commands; neither is a generic host read.
- **Observed:** `SANDBOX_OPERATIONS` is derived from the `sandbox-dispatch-guard` class and is the single source of truth for that dispatch-refusal membership.
- **Observed:** dispatch no longer forwards unhandled operations to `buildHostOp`; its default assigns `op` to `never` and throws `ValidationError`. The ten host-read operations are explicit cases: `hostSystemSummary`, `hostMemory`, `hostDiskUsage`, `hostNetworkListeners`, `hostProcessList`, `hostServiceStatus`, `hostServiceLogs`, `hostTailscaleStatus`, `hostDockerList`, `hostDockerLogs`.
- **Coverage added:** an independent expected-membership literal compared against production membership; `ensureWorker` in the denial driver with its handler-level refusal message; a bound allowlisted identity reaching exempt `metrics`; and two mixed-array constructor cases asserting the exact error for a non-string and an empty-string element.
- **Verification:** RED was the production-view assertion failing because the old constant still included `ensureWorker`. GREEN: `784 pass, 0 fail, 3560 expect() calls; Ran 784 tests across 50 files. [4.59s]` via `bun --cwd broker test --reporter=dot`. `bun build` bundled 32 modules; `git diff --check` was clean. S17 refused automatic application, so the broker source remains a retained result for owner review/manual application.

## Unexpected request failure safety — 2026-10-08

- **Placement decision:** put a safety envelope around the whole synchronous body of `dispatchLine`, retaining the validated envelope as soon as parsing succeeds. This is the earliest common boundary with the correct correlation id for both main and advisor sockets; it catches failures from parsing, advisor binding, session bookkeeping, the normal dispatch catch's `toBrokerError`/`respond`/logging, success response/logging, and awaited dispatch work. Also guard the `onData` oversize response and attach a rejection handler where `dispatchLine` is intentionally fire-and-forget. Avoided changing `parseRequest`, the established id-correlation result, allowlist decisions, framer recovery, operation cap, or identity rights.
- **Safety response:** `id: envelope?.id ?? "0"`, `code: "internal"`, fixed message `unexpected broker error processing request`; never derive the response from `err.message` or `String(err)`. Log server-side only, without the raw request line. `safeRespond` catches serialization/write/queue callback failures and attempts `socket.end()` then `socket.close()` as terminal fallback.
- **Throw-site coverage:** outer `dispatchLine` envelope includes parse errors' response construction/write, advisor binding and its catch's response/logger, session set/get, progress response, awaited dispatch, response construction/write, `toBrokerError`, and both normal result/error logger calls. `onData` catches escaped dispatch promise rejections and guards oversize responses; a private `UnexpectedRequestError` carries the already-validated envelope through fail-loud rethrow so the call-site fallback keeps the real id. The pre-existing `SocketWriteQueue.flush` catches `socket.write` failures but invokes `onFailure` without protecting a throwing callback; `safeRespond` now catches that propagation. Deliberately unchanged: expected parser validation responses and ordinary typed/domain dispatch failures continue their established error mapping. The framer's oversize extraction and 512-byte prefix recovery are unchanged.
- **Fail-loud decision:** add `BrokerConfig.failLoudUnexpectedErrors`; its default is false (and remains false in the observed Bun test invocation, where `NODE_ENV` is unset), while tests explicitly enable it where rethrow behavior is asserted. It is configurable and shape-validated at server construction. With the flag enabled, the dispatch safety envelope rethrows after server-side logging; the `onData` rejection boundary logs and emits the fixed safety response to prevent an unhandled rejection. The injected-envelope regression explicitly disables fail-loud to assert the socket response path.
- **Regression coverage:** on one socket assert fallback id `"0"` for malformed JSON, a JSON array/non-object, unsupported version, and invalid request id, then a successful valid metrics request after each rejection. Inject a synchronous throw after parsing and assert the real envelope id is used, internal/fixed response content does not reveal the injected message, and a valid later request succeeds. The previous real-id correlation assertions for invalid session, operation type, and operation length remain untouched.
- **TDD:** initial meaningful RED was the new throw-injection test: `secret injected exception` escaped from `dispatchLine` at socket event handling, and no correlated response arrived (`32 pass`, `1 fail`, `218 expect() calls`, `Ran 33 tests across 1 file. [167.00ms]`). The fail-loud call-site correlation assertion then had a separate RED: expected known id `fail-loud-id`, received `0`, proving the rejection boundary had lost the parsed envelope. Corrected both issues, then targeted GREEN: `34 pass`, `0 fail`, `223 expect() calls`, `Ran 34 tests across 1 file. [202.00ms]`. Final full-suite GREEN: `787 pass`, `0 fail`, `3580 expect() calls`, `Ran 787 tests across 50 files. [4.66s]`.
- **Delivery:** S17 protects `broker/src/**`; retain the sandbox result for owner review/manual application. Automatic apply refusal must be recorded verbatim in the session result.

## Unexpected request failure corrections — 2026-10-09

- **Framer terminal failure:** `onData` now catches a throw from `framer.push`, deletes that socket's framer, logs server-side, and ends/closes the socket without responding. A failed allocation may leave the framer partially mutated, so neither it nor the request stream is trusted; attempting a response could also require more allocation.
- **Single request-line cap:** `onData` computes `maxRequestLineBytes` once and reuses it for framer construction and oversize error text.
- **Fail-loud regression:** the test directly drives `dispatchLine` with an injected bookkeeping failure in both flag states. Enabled rejects with `UnexpectedRequestError` and writes no response; disabled resolves after writing the fixed safety response. It therefore distinguishes the flag behavior rather than asserting a response shared by both paths.
- **Logging:** `dispatchLine` logs the original unexpected error before its fail-loud branch. The `onData` rejection handler suppresses logging only for `UnexpectedRequestError`, avoiding a duplicate while retaining logging for other rejected values.
- **Verification:** RED: the framer-throw test failed because `framer.push` escaped `onData` (`34 pass`, `1 fail`, `227 expect() calls`, `Ran 35 tests across 1 file. [234.00ms]`). Targeted GREEN: `35 pass`, `0 fail`, `230 expect() calls`, `Ran 35 tests across 1 file. [188.00ms]`. Full suite: `788 pass`, `0 fail`, `3587 expect() calls`, `Ran 788 tests across 50 files. [4.82s]`. `bun build src/main.ts` from `broker/` succeeded with exit status 0.

## Deferred follow-up — SocketWriteQueue installation ordering

- **Observed, not fixed here:** `respond` stores a newly constructed `SocketWriteQueue` in `this.socketWrites` before calling `enqueue`. If `enqueue` throws, the map still retains that queue; a later response retrieves and reuses it. Investigate terminal cleanup or failure handling in a separate bounded unit. This correction does not change `SocketWriteQueue`.
