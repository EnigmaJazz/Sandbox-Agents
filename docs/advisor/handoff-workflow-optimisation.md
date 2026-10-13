# Plan B: mandate and wire in advice (workflow_optimisation)

Status: **proposed**. Executor: the OpenCode sandbox agents of
`~/ai-workspace/workflow_optimisation`, following its WORKFLOW.md. This file is written in
agent-sandbox-integration; the user carries it into workflow_optimisation (for example as
`docs/EXTERNAL-ADVISORS-PLAN.md`) together with `interface-contract.md`, and an ODD tracker is
created for it there.

The system itself (broker, host tools, advisor sessions) is built by
[`plan-sandbox-integration.md`](plan-sandbox-integration.md). The boundary is
[`interface-contract.md`](interface-contract.md). Build **no** enforcement in the sandbox
project, and no new gate or completion mechanism here either: reuse the routing guard, the
WORKFLOW.md policy, the verifier and gentle-ai's review authority.

## User decisions (2026-10-01)

1. **Advice is mandatory for every non-trivial change.** "Trivial" keeps its WORKFLOW.md meaning
   (trivial document edits; clearly bounded few-line changes with no contract or security
   effect). The aim is to exercise the process as much as possible; it can be tightened later.
2. **Interim, starting now:** the mandate is met by the five registered `advisor-*` OpenCode
   subagents, which are automated and raise no subscription issue.
3. **After plan A is installed:** an **external** advisor (Claude Code or Antigravity, opened
   and prompted by the user) is mandatory as well, chosen by the policy table below.
4. **Selection is a policy table with rotation.** By default the host alternates per request.
   Consequential questions go to both hosts as an independent group. The orchestrator records
   the rule; the user may override when opening the session, and the override is recorded.

**Preserve the work under way:**
- the five registered `advisor-*` subagents and their verifier fixes (TODO "Advisor
  registration — verifier findings");
- `docs/ADVISOR-HANDOFF.md`;
- `odd/tasks/routing-guard-keys.md` (T7 stages, T8 bug-fix route, the item 12 guard fixes).

## Coherence fixes found while slotting this in (do first: B0)

| # | Where | Problem | Fix |
|---|---|---|---|
| 1 | `docs/TODO.md` "sandbox tooling fault fully characterised", item 10 | The conclusion "`sandbox_read` broken at any size; never use" came from probes in `ses_f0c117946ffe…`. The broker logged both of those reads as `ok` in 12–16 ms at ~20:08Z on 2026-09-30, **before** the drain fix `81c78cc`. The small read followed a large one on the same connection: the large reply was cut off at ~219 KB and swallowed the small one. The fix has been installed (plugin 2026-09-30 23:41, broker restart 2026-10-01 17:26). No `readFile` has reached the broker since, so nothing has re-tested it. | Mark the conclusion **stale, pending re-probe**. Keep the patch route as the interim worker rule, and make item 10's "never use `sandbox_read`" conditional on the re-probe in plan A's prerequisite. |
| 2 | `docs/TODO.md` header "BLOCKER (active)" | Later entries show worker creation and mutation working (item 1 landed). | Re-state it as resolved or narrowed, with evidence, or remove it. |
| 3 | `WORKFLOW.md` | `## Pre-code advice (advisors)` appears **twice** (two near-identical sections). | Merge them into one section as part of B1. |
| 4 | `docs/PLAN.md` "Layers" and "one trigger set" decision | Advice is triggered by a list, and the impact axis "shares one trigger set". With advice mandatory for every non-trivial change, impact no longer decides **whether** advice happens. | Redefine impact so it decides **how much**: the number of advisors, whether a cross-family group is needed, and whether an external review lineage is used. It still raises scrutiny and never lowers it. |
| 5 | `docs/TODO.md` item 8 "Cross-project items" | It lists the append operation, the ledger move, the project-scoped signal and the install-vs-commit gap. In agent-sandbox-integration's TODO only the ledger appends exist (Tier 2 items 7–8). The other two are now listed there as well. | Point item 8 at the sandbox TODO entries by name. |

## Slices (each one ODD task)

### B1. Policy (WORKFLOW.md, `docs/PLAN.md`): can start now, interim mandate
- **Mandate.** Replace the trigger list with "advice is mandatory for every non-trivial change"
  in the single merged advice section. Keep:
  - the advice question;
  - first-pass independence;
  - "a failed or exhausted advisor is a missing opinion, never an approval; report a blocked
    gate";
  - the rule that consensus requires different model families.
- **Interim lane:** the smallest sufficient set of registered `advisor-*` subagents (one by
  default). Impact decides when to add a second family (the Go advisors span DeepSeek, Kimi and
  MiMo).
- **External lane (activated by B3 once plan A is installed).** Every non-trivial change also
  gets an external advisor, chosen by this table:

  | Rule id | When | Host |
  |---|---|---|
  | `default-rotate` | every non-trivial change not matched below | `rotate` (alternates Claude/agy per project) |
  | `consequential-pair` | security, permissions, credentials, enforcement paths, or a consequential architecture decision | group of both `claude` and `agy` (independent first pass) |
  | `review-lens-external` | a review the policy routes to an external-lens lineage (below) | `rotate` per lens; `consequential-pair` lenses get both |
  | `user-override` | the user overrides in `advisor-open` with a reason | recorded by the broker, never chosen by the orchestrator |

- **External-lens review.** Define when a review is started with `externalLenses: true` instead
  of the `asi-review-*` relay. The proposed start is `high_risk` assessments and hot paths.
  Amend the "mandatory relay lane" rule to name this as its one exception. Relayed and external
  lenses don't mix in one lineage (interface-contract §7).
- **Subscription rule.** External sessions are opened and prompted only by the user. No queue
  watcher, script or OpenCode agent launches or prompts them.
- **What the mandate does to throughput.** Every non-trivial unit now waits for the user to
  open at least one session. That's intentional while testing; record it as the first thing to
  tighten.

### B2. ODD tracker protocol for advisory evidence: can start now
- **Interim lane:** record each advisor dispatch, its model and its answer summary under the
  task ID.
- **External lane:**
  - **on asking**, record `advice pending: <id>` (with `selection.rule`) under the task ID, as
    `binding.task` = `odd/tasks/<feature>.md#T<n>`. Mirror it to Magic Context;
  - **on resume**, call `host_advisor_get` and record the status, `resolvedHost`, any override,
    the snapshot commit, the evidence manifest hash and how each finding was resolved.
- **Review lenses** are relayed only with `host_review_capture_result
  inputFromAdvisorResponse`. After that, follow gentle-ai's transitions verbatim, and record
  `assess` (`already_reviewed`, `consumed`) as for native review.
- **Follow-ups** are new requests carrying `parentId`. Recorded responses are never edited.

### B3. Activate the external lane: after plan A slices A3, A5, A6 and A7/A8 are installed
- **Permissions:** grant the orchestrator `host_advisor_ask`, `host_advisor_get` and
  `host_advisor_list` in `global-config/opencode.json`. Deny them to workers, `advisor-*`
  subagents and relay lanes.
- **Verifier checks:**
  - the grants above;
  - that only the orchestrator holds `host_review_capture_result`;
  - that no non-user launcher references `advisor-open`.
- **Flip the B1 external lane from "planned" to "mandatory".**

### B4. Routing guard integration (warn-only; after B3)
- **Optional `advice` stage.** If the owner wants one, add it to `ROUTE_STAGES` for every route
  that has non-trivial work. It's satisfied only by an **observed** `host_advisor_get` result
  with `status: submitted` whose `binding.task` matches the session's tracker (and, in the
  interim, an observed `advisor-*` dispatch result). The marker records that evidence exists;
  it is not approval.
- **Ordering:** do this after the item 12 guard fixes. R2-001's inverted `allowsSpecialists`
  must be fixed before another stage relies on it.
- **External-lens reviews:** warn when `host_review_capture_result` is called with a free-form
  `input`. The broker refuses it anyway; the warning helps diagnosis.

### B5. Handoff document (`docs/ADVISOR-HANDOFF.md`): after B3
Answer the two "Requested" items with plan A's verified contracts:
- cross-project read-only inspection;
- workspace isolation.

Describe the external lane next to the five registered advisors.

### B6. Engram evaluation (report only)
Assess whether engram can give scoped, per-request access to handoff summaries and evidence
references:
- project labels aren't access control;
- unrelated memories must not be exposed;
- independent first-pass reviewers must not see each other's conclusions before submitting.

WORKFLOW.md currently says ODD work does not invoke `mem_*`, so any adoption is the owner's
decision.

## Where this slots into `docs/TODO.md` and `docs/PLAN.md`

The current priority order (TODO "PRIORITY CHANGE") is: advisor layer, then guard fixes
(item 12), then workflow policy, then the rest. Insert:

1. **The advisor layer.** Finish the outstanding verifier fixes for the registration (unchanged),
   then mirror, restart and verify each advisor.
2. **New: B0 coherence fixes and the B1 + B2 interim mandate.** This is the "advice for every
   non-trivial change" policy, met by the registered advisors. It's a small doc change and
   immediately exercises the process on every later unit, including item 12.
3. Item 12 guard fixes (R2-001 first). These are now themselves subject to the advice mandate.
4. Workflow policy (item 5), now including fix 4 in the B0 table (impact = how much advice) and
   the B1 selection table.
5. **New: B3, then B4, then B5.** They're blocked on plan A being installed; list them as
   PLANNED with that dependency.
6. The rest unchanged (items 6, 7, 9, 10, 11). Item 10 is amended per fix 1 in the B0 table.
   Item 11 (split `verify-workflow.sh`) stays valuable regardless of the re-probe result.

In `docs/PLAN.md` "Sequence", step 3 (advisor layer) becomes "advisor layer: registration, then
the mandatory advice policy (interim lane)". Add a step after 4: "external advisor lane:
activate after agent-sandbox-integration plan A is installed".

## Acceptance

1. Every non-trivial unit after B1 has an advice record in its tracker. A unit that has none is
   reported as a blocked gate, never silently skipped.
2. After B3, every non-trivial unit also has an external request. Its `selection.rule` matches
   the table, `default-rotate` alternates hosts, and `consequential-pair` produces two
   independent responses.
3. Valid evidence progresses only through the existing mechanisms: the routing-guard stage
   (warn-only) for advice, and gentle-ai approval, acknowledgement and `assess` for review.
   Stale or missing evidence satisfies nothing.
4. The verifier passes with the B3 grants, and fails if a worker or advisor is granted
   `host_advisor_*` or `host_review_capture_result`.
