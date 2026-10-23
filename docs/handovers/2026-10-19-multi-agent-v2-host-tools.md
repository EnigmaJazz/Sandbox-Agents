# Handover: gated plan and verdict host tools (multi-agent setup v2)

**For:** the agent working in `agent-sandbox-integration`.
**From:** Claude Code (advisory), `workflow_optimisation`, 2026-10-19.
**Status:** design handover. Nothing here is approved for implementation until the owner says so.
**Companion:** `workflow_optimisation` handover `docs/handoffs/2026-10-19-multi-agent-v2-workflow-config.md`.
That half depends on this one: its config cannot enable tools that do not exist yet.

## Why

The owner's multi-agent design (v2) adds a planner (GPT-6.1 Sol) that gates work twice, a light PM
(Haiku), and binding review gates. "Binding" means the gates are enforced by tools, not prompts.
Every `host_*` tool is defined here (`opencode/plugins/sandbox-tools.ts`, broker ops in
`broker/src`), so the new tools belong here.

## What already exists (verified 2026-10-19)

- `host_plan_append` (`opencode/plugins/sandbox-tools.ts:975`): allowlisted enum target
  (`todo` -> `docs/TODO.md`, `plan` -> `docs/PLAN.md`), `ctx.ask` approval, broker op
  `planDocAppend` (`broker/src/types.ts:63`, `:153` exempt-from-sandbox-guard), atomic write.
  **Use it as the pattern.**
- Calling-agent identity: tools receive `ctx.agent` and forward it to the broker
  (`assertNotOrchestrator(ctx.agent, ...)`, `sandbox-tools.ts:227`). A single tool can therefore
  enforce per-role limits.
- Apply deny list: `DEFAULT_PROTECTED_PATHS` (`broker/src/config.ts:261`), checked by
  `checkProtectedPaths` (`broker/src/gitops.ts:242`).

## Requested tools

### 1. `host_plan_write`
- Targets: the ODD feature document `odd/tasks/<feature>.md` and a mini-plan directory
  (proposed `odd/mini/<id>.md`). The path allowlist is enforced in broker code, not the prompt.
  Reject traversal, symlinks and any path outside those two roots.
- Revisions are versioned. Each write records a revision number and a one-line change note, and
  takes an expected-revision argument (compare-and-swap). A stale writer is refused, not merged.
- Role limits via `ctx.agent`: the planner may write both targets. The PM may write mini plans
  only, and only when the plan's frontmatter route is a no-Sol route. Every other agent is refused.
- **Approval: OWNER DECISION.** The design asks for no `ctx.ask`. Every host tool here is
  ask-gated today, so dropping it is an exception to this repo's safety model. If accepted,
  record it in `docs/threat-model.md` with the compensating controls: the path allowlist, the
  role check, plan-only content, and the revision log.

### 2. `host_gate_verdict` (planner only)
- Records `PASS`, `REFINE` or `ESCALATE` against a task ID in the feature document. A `REFINE`
  must carry a refinement plan. The verdict is append-only, and an earlier verdict is never
  rewritten.
- Store it beside the plan (a `## Gates` section or a sidecar), so `host_task_mark` can read it
  without trusting the caller.

### 3. `host_task_mark` (PM only)
- Ticks exactly one task ID. It cannot edit task text.
- Evidence is required: a commit reference (or diff digest) and a test command with its result.
- The broker refuses unless the route's gate requirement is met:
  - Routes with Sol gate 2: the latest `host_gate_verdict` for that task is `PASS`, and it is
    newer than the evidence commit.
  - Low-risk Small: tests pass and the post-code lens raised no blocking finding.
- **Correction to the design:** do not trust the route or risk tier in the plan frontmatter. The
  PM and planner write that frontmatter, so a gate keyed on it would certify itself. The broker
  should derive the tier from `gentle-ai review assess --committed-only` on the evidence commit
  (raise only, never lower), and treat a failed assessment as `high`.

### 4. Apply tool deny list
- Add the plan roots (`odd/tasks/**`, `odd/mini/**`) to `DEFAULT_PROTECTED_PATHS`, so a worker
  cannot write plans even through a sandbox result. Check first that nothing currently relies on
  workers writing `odd/tasks/` through apply. If something does, report it and do not break it
  silently.

### 5. Tiny-route size guard (new, replaces a prompt rule)
- The design's Tiny escape hatch ("more than ~20 lines or one file, or touches
  auth/security/data/schema: do not apply") cannot be honored by the model: it does not know the
  diff size until it has written it.
- Enforce it in `host_sandbox_result_install`: when the calling agent is the Tiny-route agent,
  refuse results over the line or file limit or touching configured sensitive globs. Return a
  typed refusal the orchestrator can route on.

## Constraints

- Tests first, with a positive control for every refusal path. Follow the existing
  `broker/tests/host-tool-approval.test.ts` and `sandbox-tool-contract.test.ts` patterns.
- Protected paths in this repo (the profile, `register-project.ts`, the threat model) need the
  owner's approval to change.
- Dual-mode for OpenCode V1 and V2. No new dependency on SDD, `host_sdd_*` or V1-only hooks.
- One writer for task ticks: once `host_task_mark` exists it is the only path that ticks a task.

## Open questions to answer before building

1. Whether `odd/tasks/` is written by any current apply path (affects item 4).
2. Whether the broker can run `gentle-ai review assess` itself, or must take the result from an
   existing `host_review_assess` call by reference.
3. Whether a verdict or tick should also mirror to Magic Context, or stay file-only.

## Report back

The tool contracts as built, the test names, any deviation from this handover with its reason,
and the threat-model entry for the approval decision.
