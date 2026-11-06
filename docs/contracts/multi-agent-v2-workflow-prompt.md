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
- **What the broker derives.** From the pinned stage (`chainID`, `n`: baseline and result commit, never a caller-named diff): the touched paths, checked against the plan document's `## Allowed edit surfaces` bullets (globs, planner-authored); the diff-line budget (`maxApplyDiffLines`, source files only); and the exit status of each configured test runner, read from the broker's own testRun logs named in `testRunRefs` and counted only when the log header binds it to the project and to the stage result's tree (` project=<id> tree=<sha>` after the flags) and the log is not older than the pinned stage result. Anything absent is MISSING and can never be a clear match. The recorded verdict line never claims `tests:pass` unless a bound log passed.
- **Where the test evidence comes from (D30, U4d).** Never from the host and never from the router. When a chain stage is finished (`prepareResult`, the idle auto-finish, `keepResult`) and its result is imported and pinned, the broker runs each runner of its OWN configuration (`BROKER_TEST_RUNNERS`: argv vector, cwd, timeout, output cap; never anything from the worker, the stage content, the plan or a caller) INSIDE THE WORKER'S SANDBOX (as the worker user, in `/work/<cwd>`, env `CI` and `NO_COLOR` only, the sandbox's own network policy), and writes one broker-owned log per runner in its state directory, which the worker cannot reach. The log is bound only if the sandbox tree equals the pinned result's tree both before and after the runners (a racing worker, or a runner that edits files, leaves no log). Only a clean exit 0 is a pass: a non-zero exit, a timeout, a signal, no exit code, or output over the cap is recorded as a FAILING log (the gate returns `RETURN_TO_PLANNER`); an infrastructure failure (sandbox gone, exec error) writes no log, so the tests check stays MISSING (`SPEC_CHECK`). Evidence collection never blocks or alters stage registration. `stageShow` / `stageList` / `chainStatus` expose the ids as `testRunRefs` when present; the broker does not trust that field, `gateVerdictAuto` re-checks header, tree, project and age of every cited log. Runner executables (`argv[0]`, absolute) must exist inside the worker image. The router may cite any log bound to the same tree, so a re-run (for example a re-finish with the same content) may be cited over an earlier one.
- **What a passing log does and does not prove.** It proves that, in the worker's own sandbox, the configured runners exited 0 on a tree equal to the pinned stage. It does NOT prove the stage is correct: a worker can edit or add test files in the same stage and that is the content that ran, so the scope check (`## Allowed edit surfaces`), the diff review and the Jev criteria (S1..Sn) must cover test tampering; content the runner can see that the tree id does not cover includes: git-ignored files in `/work`; a nested git repository (the tree records only a gitlink, mode 160000, while the runner sees the repository's tracked and untracked files); tracked `*.bundle` files and `.broker-tmp/` (excluded from `add -A`, so the index version is kept while the file the runner reads can differ); anything outside `/work`; file mode when the worker sets `core.fileMode=false` (the tree says 100644, the runner sees an executable); `.gitattributes` text/eol normalisation; and symlinks (the tree records the link, the runner follows it). A process the worker left running can also change files during a run and restore them before the second tree check. The broker refuses to write evidence (no log) when the hashed tree contains a gitlink or when the worker repository sets `core.fileMode=false`, `core.symlinks=false`, `core.worktree`, `core.bare=true` or `core.sparseCheckout=true` (checked before and after the runners, with the same configuration probe as the `filter.*` check); the other items above are documented residuals, not detected. The tree id is computed by git inside the worker's own sandbox, so it is a consistency check and NOT a trust boundary: a live process of the worker can swap the index file or set `core.worktree` between the hash and the run. A green log proves only that the stage passes its own tests under those conditions. The evidence is as trustworthy as the sandbox's report of it; the owner's approval and the independent checks stay the control. At most one finish of a session runs at a time: an explicit `prepareResult` or `keepResult` that overlaps an in-flight finish (including the reaper's idle auto-finish or disconnect reap) is refused with `a result export is already in flight for this session`, and the reaper skips a session that is being finished, so the runners never run twice at once and a worker is never released under a running runner. The reaper's own interval never starts a sweep while the previous one is still running. Finishing a stage now takes up to the sum of the runner timeouts (each at most 600 s) while the session is locked; the OpenCode plugin client budget for `prepareResult` is its default (30 s), so a client that gives up first sees an error while the broker still completes (a retry re-runs the runners). Raising that budget is a separate S17 plugin change.
The `plan-vs-spec` checkpoint has no diff and no test run, so it always routes to the spec check (it still names an existing stage; the plan checkpoint is normally not sent to this operation).
- **What the router supplies.** The checkpoint, the stage reference, the expected criterion ids (each must appear in the plan document; `taskId` must be listed in its `## Tasks` section), one `p` per criterion (finite, in [0, 1]; absent means unsure), and the log ids. Nothing else is accepted.
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
