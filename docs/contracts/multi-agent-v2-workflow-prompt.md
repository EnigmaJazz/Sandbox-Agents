# Prompt — multi-agent v2: plan tools, gating, and the ODD tracker change
Run this prompt in /home/james/ai-workspace/workflow_optimisation.

## Order of work (do not reorder)

1. **Permissions first, inert.** Add permission entries for `host_plan_write`, `host_gate_verdict` and `host_task_mark` to the opencode config fragment now. A permission entry for a tool that does not exist yet is inert: it grants nothing and blocks nothing, so it is safe to land before the tools exist.
2. **Tools second, protection dormant.** Implement and deploy the tools in `agent-sandbox-integration`, with plan-root apply protection present in code but DISABLED behind a config flag. Nothing calls the new tools yet and no writer is blocked, so ODD work continues on the old path.
3. **Workflow text third, only after the tools work.** Once `host_plan_write` and `host_task_mark` are verified live, change `WORKFLOW.md` and enable plan-root protection in the same step. Changing the workflow earlier would block tracker writes in the other direction: the old path is closed and the new path does not exist yet.
4. **Verification last.** Make one real plan revision through `host_plan_write`, one tick through `host_task_mark`, and one refused apply touching `odd/tasks/**`.

Never enable plan-root protection before the tools are proven live, and never change the workflow before the permissions are deployed.

## Author split (normative)

| Record | Author and path |
| --- | --- |
| Plan document (objective, approach, reasoning, acceptance criteria) | PLANNER through `host_plan_write`; nobody else writes plan prose. |
| Gate verdicts | PLANNER through `host_gate_verdict`, append-only. |
| Task ticks and evidence | PM through `host_task_mark`. |
| Reading all of it | ORCHESTRATOR, read-only. |

This split protects fidelity: an orchestrator transcribing a stronger model's reasoning can silently drop the caveat that mattered. It also protects posture: the orchestrator is deliberately unable to mutate project state and must not gain a plan-writing tool to route around the worker ban.

## Tool contracts to add

### `host_plan_write`

- Allowlist roots `odd/tasks/**` and `odd/mini/**` in broker code. Reject traversal, symlinks and every path outside those roots.
- Require a revision number and a one-line change note per write. Require an expected-revision argument and compare-and-swap; refuse a stale writer rather than merging.
- PLANNER may write both roots. PM may write `odd/mini/**` only, and only when the plan's frontmatter route is a no-Sol route. Refuse every other agent.
- Agents may not write broker-owned frontmatter keys: `route`, `tier` and `gate`.

### `host_gate_verdict`

- PLANNER only. Record `PASS`, `REFINE` or `ESCALATE` against a task ID. `REFINE` must carry a refinement plan.
- Append-only: never rewrite an earlier verdict. Store verdicts where `host_task_mark` can read them without trusting the caller.
- Refuse other roles, invalid verdicts, missing task IDs, and a `REFINE` without its refinement plan.

### `host_task_mark`

- PM only. Tick exactly one task ID and never edit task text.
- Require a commit reference or diff digest, plus a test command and its result. Refuse unless the gate requirement is met.
- Do not trust route or risk tier from plan frontmatter: the PM and planner write that frontmatter, so a gate keyed on it would certify itself. Derive the tier with `gentle-ai review assess --committed-only` on the evidence commit; raise only, never lower, and treat a failed assessment as high.
- Refuse other roles, malformed or incomplete evidence, and any request to change task text or tick more than one task.

## Apply-time protection of plan roots

Add `odd/tasks/**` and `odd/mini/**` to the apply deny list so no sandbox result can restore or delete them. This stops an apply worker from silently discarding the planner's reasoning inside an otherwise legitimate diff. With that protection on, no writer may create or update a tracker; that work moves to the planner and the PM ticks above.

## What this replaces in WORKFLOW.md

Old rule: the orchestrator delegates tracker creation to a sandbox writer before the first source edit, and updates the tracker after each completed task.

New rule: the planner authors the plan through `host_plan_write`, the PM ticks tasks through `host_task_mark`, the orchestrator only reads, and writers never touch plan roots. The durable task record remains the repository file, now written by exactly two broker-validated paths.

## Permissions to add

Add the three tool names to the config fragment with the same approval posture as the existing host tools. The fragment is a manual merge in this repository, never applied by a script.

## What is explicitly out of scope

Native 4R review is unchanged. The ce:review contract revision is separate. Reject Magic Context mirroring of verdicts or ticks: keep the record file-only, because the broker has no Magic Context surface and a trust decision must not depend on an agent-side memory write.

## Verification

- Read back the whole file and confirm every required section is present and in order.
- Confirm the file ends with a newline.
