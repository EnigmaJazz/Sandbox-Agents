# T7 draft — coordinated flip of plan-root protection

## Objective
Close the worker-apply path into `odd/tasks/**` and `odd/mini/**` once the broker-hosted write path is proven, and align the workflow text with the three-tier plan authority.

## Authority model (owner decision, 2026-10-24)
1. The orchestrator writes DRAFT plan revisions through `host_plan_write`.
2. The planner revises and approves those drafts, and records gate verdicts through `host_gate_verdict`.
3. The PM ticks tasks after planner approval, through `host_task_mark` — NOT YET BUILT (T5).
4. Until T5 lands, ticks are carried as ordinary plan revisions by the writer holding authority.

## Steps
1. Enable draft writes for the orchestrator and prove a revision writes and reads back. DONE.
2. Set `BROKER_PLAN_ROOT_PROTECTION=1`, install and restart the broker.
3. Verify an apply result touching `odd/tasks/**` is refused with the protected-path refusal.
4. Update the workflow text in `workflow_optimisation` to the three-tier model above.
5. Record the residual gap: no PM tick tool exists until T5.

## Non-goals
- No change to `host_gate_verdict` or its gate log.
- No change to the native review tooling.


## Revisions
- r1 2026-10-24T22:23:33Z gentle-orchestrator: Orchestrator draft: first revision, verifying the draft path under split plan/gate authority.

- r2 2026-10-25T10:09:17Z pm-odd: task mark T1 passed

## Ticks
T1 passed evidence=047fbb011ee91aeee72df1e07ba7703b07ebf3cd tier=high 2026-10-25T10:09:17Z pm-odd: probe: PM tick verification
