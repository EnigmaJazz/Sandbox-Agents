# ODD task — multi-agent-v2-host-tools

## Objective
Plan-writing, gate-verdict and task-tick host tools so that binding review gates are enforced by broker-validated tools rather than by prompts, on top of the multi-agent v2 design in `docs/handovers/2026-10-19-multi-agent-v2-host-tools.md`.

## Status
**T1–T6 implemented; T7 is partially done (the protection flag is enabled in the installed environment, live refusal proof outstanding); T8 is the owner's.** Reconciled 2026-11-01 against commits and the live tool surface. The previous task list marked T5 and T6 "NOT STARTED" after both had shipped, and T1 "not established" after it was demonstrably working.

## Problem
The multi-agent v2 design adds a planner that gates work twice and a light PM, but every `host_*` tool today is ask-gated and none can write a plan, record a verdict or tick a task. A gate that lives only in a prompt can be certified by the model that is being gated. Separately, an apply worker's result can currently overwrite or discard the planner's reasoning in `odd/tasks/**` inside an otherwise legitimate diff.

## Scope
In: `host_plan_write`, `host_gate_verdict`, `host_task_mark`; planner/pm roles in the admission matrix; apply-time protection of `odd/tasks/**` and `odd/mini/**` behind a config flag; the workflow and permission changes in `workflow_optimisation`.

Out: native 4R review changes; the ce:review contract revision; Magic Context mirroring of verdicts or ticks.

## Decisions recorded
1. Plan prose is written by the PLANNER through `host_plan_write`; the orchestrator never writes plan content, because transcribing a stronger model's reasoning can silently drop the caveat that mattered, and because the orchestrator is deliberately unable to mutate project state.
2. Verdicts are recorded by the planner through `host_gate_verdict`, append-only, stored in a `## Gates` section of the plan document.
3. Task ticks are recorded by the PM through `host_task_mark`, which requires evidence and a broker-derived tier.
4. `host_plan_write` and `host_gate_verdict` take NO approval prompt. Owner-approved on the basis that plan text is not authority; the compensating controls are the path allowlist, the role allowlist, append-only gate lines and the revision log.
5. The tier for a tick is derived by the broker via `gentle-ai review assess --committed-only` on the evidence commit, raised only and never lowered, with a failed assessment treated as `high`. Route and tier from plan frontmatter are never trusted because the planner and PM write that frontmatter.
6. Plan-root apply protection stays DISABLED behind a config flag until the tools are proven live, then flips in the same step as the workflow text change.
7. Session identity binding records who the host says a session is; authorization stays in the role matrix, so an unknown identity binds and is then denied.

## Tasks
- **T1** `host_plan_write` broker operation, plugin tool and tests. Status: **done.** The operation exists and is live: this document was written through `host_plan_write`, which returned a revision and committed the change (`b35f04c`, `296707f`, `62dc5c0`). No individual commit subject is claimed here because the reconciling evidence is a successful live call.
- **T2** Planner/PM roles, `host_plan_write` classification and inventory-parity test. Status: roles and classification committed as `3c17309`. The inventory-parity test's own result is not recorded in this tracker.
- **T3** Bind every host-resolved session identity. Status: committed as `a8b2b13`.
- **T4** `host_gate_verdict` broker operation and plugin tool, append-only gate log and `readLatestGateVerdict`. Status: committed as `b4d2500`; the tool is present in the live orchestrator surface.
- **T5** `host_task_mark` with an injected tier assessor in `OpContext`. Status: **done** — `7299ada` ("add the taskMark operation with broker-derived tier and gate rule") and `4cda0ef` ("expose host_task_mark for PM ticks").
- **T6** Plan-root apply protection behind a config flag. Status: **done** — `875f409` ("add opt-in apply protection for the plan roots"), `0471f4c` ("refuse plan-root paths at worker mutation and at result install"), `b368c8d` (separate plan-root naming from S7/S17 in apply refusals).
- **T7** Coordinated flip: workflow text plus protection enablement. Status: **partially done.** The flag is enabled in the installed environment (`systemd-user/broker.env:49`, `BROKER_PLAN_ROOT_PROTECTION=1`, loaded through `EnvironmentFile=` in `systemd-user/sandbox-broker.service:38`), and the refusal is observable in code (`broker/src/service.ts:965`, `:971`, `:2046`). Outstanding: the recorded proof that a live mutation and a live result install are both refused. Tracked in `odd/tasks/t7-flip-draft.md` steps 2–5.
- **T8** Threat-model entry for the no-ask decision. Status: OWNER.

## Acceptance criteria
- A plan write refuses a stale revision.
- A gate verdict is append-only and a REFINE without a refinement plan is refused.
- A tick without evidence is refused.
- A tick whose latest verdict is not PASS is refused on a gated route.
- A result touching `odd/tasks/**` is refused once protection is on.
- An unclassified `host_*` tool fails the inventory-parity test.

## Checks
- `bun --cwd broker test --reporter=dot` — Step 0: 1272 pass / 0 fail.
- `cd broker && bun build --target=bun src/main.ts` — succeeded when run as `bun build --target=bun src/main.ts` with `cwd=broker`.

## Route and trigger evidence
These units were built through delegated sandbox writers, each exported and installed through `host_sandbox_result_install`, with the owner committing. Process gap found on 2026-10-23: no ODD tracker existed for the feature, pre-code advice was attempted once and cancelled and never retried, and no post-code advisory review ran for T1 to T4. This tracker is the correction. T5 onward must carry pre-code advice and a post-code check.

## Progress

Reconciliation on 2026-11-01 replaced the stale task statuses above. Commit evidence for T5 and T6, from the branch reflog:

```text
7299ada feat(broker): add the taskMark operation with broker-derived tier and gate rule
4cda0ef feat(broker,plugins): expose host_task_mark for PM ticks
875f409 feat(broker): add opt-in apply protection for the plan roots
0471f4c feat(broker): refuse plan-root paths at worker mutation and at result install
b368c8d fix(broker): name plan-root protection separately from S7/S17 in apply refusals
```

Live evidence for T1 and T4, observed 2026-11-01 in this session: `host_plan_write` wrote four tracker documents and returned committed revisions each time; `host_gate_verdict` and `host_task_mark` are present in the orchestrator tool surface.

## Native review history and boundary decision

The native review lineage history for the multi-agent v2 tool surface starts from base `3a2e734`:

- **`review-d8ed42856e727cd2`** — 29 paths, 1942 lines, high risk. Four lenses and a refuter. Two CRITICAL findings were corroborated: a `planDocWrite` after a `gateVerdict` erased the `## Gates` section, and `authorizeHostDispatch` changed denial text for existing operations. Both were fixed in `ebb485a`. The lineage wedged in `correction_required`; no authority was issued.
- **`review-668150ccd508581c`** — 30 paths, 2118 lines, high risk. Four lenses and a refuter. Four findings were corroborated: broker-owned plan frontmatter was accepted; PM mini writes were unrestricted by route; the plugin still advertised a clean-tree gate the broker no longer enforced; provenance work was unbounded and synchronous inside the lock. One finding was `inconclusive`: registry missing `testRun`, contradicted by successful live calls. All four corroborated findings were fixed in `0985475`. The lineage wedged in `correction_required`; no authority was issued.
- The root cause of both wedges is the upstream Gentle AI defect, open as `Gentleman-Programming/gentle-ai#4571`: `correction_required` is written with `fix_delta_hash` equal to the SHA-256 of empty input at `capture_phase_epoch: 1`, and the only transition offered in that state cannot supply a correction delta. We observed this on 4.2.0; other reporters have reported it from 2.8.2 onward.
- **Third attempt: NOT STARTED.** The owner decided to stop growing the candidate rather than run a third review of a 2220-line slice.

**Owner decision:** the reviewed boundary is advanced to `0985475` **without native review authority**. This is an explicit owner decision, not a review result. The slice grew because each correction round added code to the same candidate; a 2000+ line candidate on this surface keeps producing real defects, and each round makes the next candidate larger, so no round can converge while the defect blocks correction cycles.

**Residual risk:** 2220 lines of broker, plugin and config changes are covered by the 1306-test suite, two independent post-code advisory passes, and two rounds of evidence-based review findings that were fixed — but they carry no native review authority record.

**Policy from this point:** one work unit per candidate, capped at about 400 authored changed lines, reviewed before the next unit starts, with `--base-ref` set to the previous reviewed commit. If a unit would exceed the cap, split it before writing code, not after.

## Accepted residual risks
- A concurrent writer with access to the project tree could swap the destination parent for a symlink between the final path check and `renameSync`; plan-root apply protection is intended to remove this attacker precondition, while closing the race requires directory-fd `renameat` support that Node does not expose.

## Next step
T7: record the live refusal proof for both a worker mutation under `odd/tasks/**` and a result install touching it, per `odd/tasks/t7-flip-draft.md` steps 2–5. Then T8 (owner) and close.


## Revisions
- r1 2026-11-01T17:55:14Z gentle-orchestrator: Reconcile: T1-T6 shipped, T7 partial, T8 owner
