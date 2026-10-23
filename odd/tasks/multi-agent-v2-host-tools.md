# ODD task — multi-agent-v2-host-tools

## Objective
Plan-writing, gate-verdict and task-tick host tools so that binding review gates are enforced by broker-validated tools rather than by prompts, on top of the multi-agent v2 design in `docs/handovers/2026-10-19-multi-agent-v2-host-tools.md`.

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
- **T1** `host_plan_write` broker operation, plugin tool and tests. Status: no matching commit subject appears in the recorded top-ten log; the worktree has no tracked modifications, so current implementation status is not established by these facts.
- **T2** Planner/PM roles, `host_plan_write` classification and inventory-parity test. Status: commit `3c17309` records roles and classification; completion of the inventory-parity test is not established by the recorded Git summary.
- **T3** Bind every host-resolved session identity. Status: committed as `a8b2b13`.
- **T4** `host_gate_verdict` broker operation and plugin tool, append-only gate log and `readLatestGateVerdict`. Status: committed as `b4d2500`.
- **T5** `host_task_mark` with an injected tier assessor in `OpContext`. Status: NOT STARTED.
- **T6** Plan-root apply protection behind a config flag. Status: NOT STARTED.
- **T7** Coordinated flip: workflow text plus protection enablement. Status: NOT STARTED.
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
Step 0 command output:

`git log --oneline -10`
```text
4179ee0 opencode-sandbox baseline for ses_e96ffb4deffeM0pFA5NTQs7GwX
b4d2500 feat(broker,plugins): add host_gate_verdict with an append-only gate log
a8b2b13 feat(plugins): bind every host-resolved session identity and let the role matrix decide
3c17309 feat(broker): add planner and pm roles and classify host_plan_write
9f3ff0b docs(contracts): add the multi-agent v2 workflow and tool prompt
6dae9c5 docs(contracts): add the live-derived ce:review parameters and evidence
9f8c125 feat(broker): guide callers through a correction_required closure and its terminal stop
d779896 feat(broker): flag an unreachable correction_required lineage with the sanctioned workaround
b47924e docs(todo): record the correction_required diagnosis and the install divergence
3a2e734 fix(broker,scripts): keep the published artifact on an invalid summary and pin the installed helper bytes
```

`git status --short`
```text
?? ses_e96ffb4deffeM0pFA5NTQs7GwX.bundle
```

`bun --cwd broker test --reporter=dot` — 1272 pass / 0 fail.

Unit status evidence: T1 has no matching commit subject in the top-ten log and no tracked worktree changes; status is not established. T2 has commit `3c17309`; T3 has commit `a8b2b13`; T4 has commit `b4d2500`. For T2 to T4, the available Git commands identify Git commits, not separate `host_sandbox_result_install` result-commit IDs. The only uncommitted path reported is the untracked bundle above, not unit source.

## Accepted residual risks
- A concurrent writer with access to the project tree could swap the destination parent for a symlink between the final path check and `renameSync`; plan-root apply protection is intended to remove this attacker precondition, while closing the race requires directory-fd `renameat` support that Node does not expose.

## Next step
T5 (`host_task_mark`) with the injected assessor, preceded by the post-code advisor pass over T1 to T4.
