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
| Gate verdicts | PLANNER through `host_gate_verdict`, append-only. The one exception (D22): CODE records a first `PASS` through `host_gate_verdict_auto`, called only by a configured non-LLM gate-router identity, and only for a clear match (see below). |
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

### `host_gate_verdict_auto` (D22, the narrow exception to the author split)

`host_gate_verdict` and its PLANNER-only authorship are unchanged. D22 adds exactly one more way a verdict is recorded:

- **Who.** Only a session bound to a name in the broker's `gateRouterAgents` allowlist (default empty: denied for everyone). It is a trusted non-LLM identity, disjoint from `readOnlyAgents`, `stageReviewAgents`, the plan writers, the roles and every orchestrator identity. The Planner, the orchestrator, the PMs and the workers are all refused, at the broker operation and at tool admission. The identity is the broker-bound one, never an envelope claim.
- **Trust boundary.** The Jev call is made OUTSIDE the broker, which has no network and no API key. The probabilities `p` are therefore the router's claim: the broker cannot verify them. Whoever can bind the router identity IS the trust root for them. The broker bounds what that trust can do: it never accepts a deterministic result, threshold or verdict from the caller, and re-derives scope, budget and test status itself.
- **What the broker derives.** From the pinned stage (`chainID`, `n`: baseline and result commit, never a caller-named diff): the touched paths, checked against the plan document's `## Allowed edit surfaces` bullets (globs, planner-authored); the diff-line budget (`maxApplyDiffLines`, source files only); and the exit status of each configured test runner, read from the broker's own `testRun` log headers named in `testRunRefs`. Anything absent is MISSING and can never be a clear match. Known limit: `testRun` runs on the host worktree, so a log is not tied to the stage's content and the router chooses which logs to cite; the tests check is only as strong as that choice (the fail-closed alternative, tests always MISSING, would make the code path unreachable, and is the owner's decision). The `plan-vs-spec` checkpoint has no diff and no test run, so it always routes to the spec check (it still names an existing stage; the plan checkpoint is normally not sent to this operation).
- **What the router supplies.** The checkpoint, the stage reference, the expected criterion ids (each must appear in the plan document), one `p` per criterion (finite, in [0, 1]; absent means unsure), and the log ids. Nothing else is accepted.
- **Routing (pure, `routeGate`).** `RECORD_PASS` needs every deterministic check passed AND every expected `p > 0.7`. A failed check, or any `p < 0.3`, returns `RETURN_TO_PLANNER`. Everything else, including `p` in [0.3, 0.7] and any missing evidence, returns `SPEC_CHECK`. Confidence alone never passes.
- **What code records.** Only `PASS`, authored by the router identity, on the existing append-only `## Gates` log, with the probabilities and the check results in the line and a `ref=d22-auto:...` pointer. On `RETURN_TO_PLANNER` and `SPEC_CHECK` it records nothing and returns the label with the check results. The PLANNER stays the author of `REFINE`, of `ESCALATE`, and of any `PASS` that follows the independent spec check (`advisor-spec-pre` / `advisor-spec-post`, D27). Code never rewrites a verdict.
- **No supersede.** Code records only a task's first verdict: if the latest verdict is a PLANNER `REFINE` or `ESCALATE` it refuses (`GATE_AUTO_SUPERSEDE_REFUSED`), and if a `PASS` already exists it refuses (`GATE_AUTO_PASS_EXISTS`). Refined work therefore returns to PLANNER authorship. A verdict is keyed by `taskId`, and a PLANNER `PASS` after the plan-vs-spec spec check on a task id blocks code on that same id: the implementation gate needs its own gate id (for example `T1.impl`; `host_task_mark` ticks against the latest `PASS` of the id it is given). An identical replay records nothing and returns the original `verdictHash`.

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
