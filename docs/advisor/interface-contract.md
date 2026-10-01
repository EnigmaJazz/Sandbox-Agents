# External advisor interface contract

Status: **proposed**. Nothing is installed. This contract is the boundary between the two
implementation plans:

- [`plan-sandbox-integration.md`](plan-sandbox-integration.md) builds the system (broker,
  OpenCode host tools, advisor MCP server, launchers, confinement). It lives in this repository.
- [`handoff-workflow-optimisation.md`](handoff-workflow-optimisation.md) decides when the system
  must be used and wires it into the workflow. It is carried into `workflow_optimisation`.

Each side's OpenCode sandbox agents can work only in their own repository. They meet only at
the names, shapes and guarantees below. Changing anything here needs both sides to agree.

## 1. Roles and authority

| Party | May do | Never does |
|---|---|---|
| OpenCode orchestrator | Create advisory requests; read responses; relay review-lens responses into gentle-ai through the existing review host tools | Write or change an advisor's response; submit its own lens result to a review that uses external advisors |
| External advisor (Claude Code or Antigravity, opened and prompted by the user) | Read the project; investigate in a throwaway worker; keep bounded evidence; submit one immutable response per request | Call any gentle-ai, `host_*`, review or SDD operation; acknowledge; issue or hold keys; apply, export or install anything |
| Broker | Store requests and responses; check bindings; stage stored bytes into gentle-ai | Decide approval |
| gentle-ai (provider) | Admit results, adjudicate, issue and burn acknowledgement tokens, report `assess` | — |
| workflow_optimisation (routing guard, WORKFLOW.md, verifier) | Decide when advice or external review is mandatory and what a missing response means | Treat advisory evidence as approval |

**A response is evidence.** Submitting one never issues a key, never writes a routing-guard
marker, and never counts as approval.

## 2. Request kinds

- **`pre-code-advice`**: the advisor answers the WORKFLOW.md advice question about a frozen plan
  and snapshot. Its effect on progression belongs only to workflow_optimisation.
- **`review-lens`**: the advisor writes one gentle-ai reviewer result for one selected lens of
  an **external-lens lineage** (§4). Its effect on progression belongs only to gentle-ai.

## 3. OpenCode host tools (provided by sandbox-integration)

### `host_advisor_ask`

```jsonc
{
  "kind": "pre-code-advice" | "review-lens",
  "binding": {
    "task": "odd/tasks/<feature>.md#T<n>",   // required: the ODD task and its stable task ID
    "step": "<free text, ≤128 bytes>",        // required: e.g. "pre-code", "slice-2 review"
    "route": "workflow-odd-secure",           // optional, recorded only
    "stage": "<stage id>"                     // optional, recorded only
  },
  "snapshot": { "resultRef": "refs/opencode-sandbox/result/<sid>" } | { "commit": "<40-hex>" } | { "worktree": true },
  "host": "claude" | "agy" | "rotate",        // "rotate" = the broker picks the least recently used host for this project
  "selection": { "rule": "<policy rule id>" },// required: the workflow_optimisation rule that chose the host (§6)
  "group": "<id>",                            // optional: independent first-pass requests on the same question share a group
  "thread": "<id>", "parentId": "<id>",       // optional; a follow-up is always a NEW request
  // pre-code-advice only:
  "question": "<text>", "evidenceRefs": ["<repo path or doc id>"],
  // review-lens only:
  "review": { "lineage": "review-…", "lens": "review-risk|review-resilience|review-readability|review-reliability" }
}
```

It returns `{ id, thread, status: "pending" }`.

- For `review-lens` the orchestrator supplies only `lineage` and `lens`. The broker reads
  `target`, `order`, `subject_hash` and the reviewer task (`review lens-context`) from gentle-ai.
  The model never types provider values.
- No field may carry an acknowledgement `token`. One is refused if present.

### `host_advisor_get {id}` / `host_advisor_list {task?, step?, status?}`

```jsonc
{
  "id": "…", "kind": "…", "binding": { … }, "thread": "…", "parentId": null,
  "status": "pending" | "claimed" | "submitted" | "declined" | "expired",
  "snapshot": { "commit": "<40-hex>", "tree": "<40-hex>", "source": "worktree|resultRef|commit", "resultRef": null },
  "selection": { "rule": "…", "requestedHost": "claude|agy|rotate", "resolvedHost": "claude|agy",
                 "override": null | { "host": "agy", "reason": "<text>" } },   // set by advisor-open if the user overrides
  "group": null | "<id>",
  "advisor": { "host": "claude", "model": "<self-reported>", "session": "<host session id>" },
  "response": {                    // present only when submitted
    "verdict": "<text>",           // pre-code-advice
    "findings": [ … ],             // pre-code-advice: free-form; review-lens: gentle-ai reviewer schema
    "reviewerResult": { … }        // review-lens: the exact JSON that will be relayed
  },
  "evidence": { "dir": "<broker state path>", "manifestSha256": "sha256:…", "files": [ { "path": "…", "sha256": "…" } ] },
  "review": { "lineage": "…", "target": "…", "lens": "…", "order": 0, "subjectHash": "sha256:…" }  // review-lens only
}
```

### `host_review_start` (existing): extra option

`externalLenses: true` starts the review **without** `--agent`, which makes it an
external-lens lineage (§4). The broker records the lineage as external-lens in its state.

### `host_review_capture_result` (existing): extra argument

`inputFromAdvisorResponse: "<id>"`. For an external-lens lineage this is the **only** accepted
input; a free-form `input` is refused. The broker:
1. reads the current `collect` transition from gentle-ai;
2. checks that lineage, target, lens, order and subject hash match the stored response;
3. runs `capture-result --preflight`, then the real capture with the stored bytes.

## 4. External-lens lineages (verified against gentle-ai 3.7.0, 2026-10-01)

- **Starting.** A review started without `--agent` is offered a `collect` transition. It asks for
  every selected lens as a `reviewer_result` file through
  `capture-result --input --lineage --expected-revision --target --repository-context --lens --order`.
- **Reviewer task.** `review lens-context` produces the complete reviewer task for each lens
  (binding, instructions, patch, numstat, name-status, result schema).
- **Subject hashes.** Each lens has its own `subject_hash`. Capture accepts both the
  `start`/`collect` hash (artifact-subject v1) and the `lens-context` hash (v2).
- **Rotation.** Capturing one lens doesn't rotate the revision or context for the others. A state
  transition (for example to `correction_required`) does, and old handles then fail.
- **Refused by gentle-ai itself:**
  - a wrong `subject_hash` (`binding_mismatch`);
  - placeholder evidence ("must be concrete");
  - a stale revision or context;
  - an old result after the candidate changes.
- **Progression.** When every lens is clean the state is `approved`, then
  `acknowledge-approved --token` burns the authority. After that, `review assess --committed-only`
  reports `already_reviewed` with `consumed: true`. A new commit reports `review_due: true` with
  `consumed: false`.
- **Blocking findings.** A CRITICAL `introduced` finding gives `correction_required`, and the
  existing correction, refuter and validator path takes over.
- **Not a progression check.** `review validate` reports repository delivery policy only.
- **Security property:** gentle-ai trusts whatever result content is submitted. Whoever can call
  `capture-result --input` on an external-lens lineage can approve it. Hence the
  only-stored-responses rule in §3.
- **Not usable here.** A review started with `--agent opencode` uses the
  `opencode_provider_injected` transport: `--materialize` is refused, and results only arrive
  through the live relay (600 s). External advisors can't take part in such a lineage.

## 5. Guarantees the system gives (for workflow_optimisation to rely on)

1. **Missing, unanswered or bad evidence never counts.** A request in `pending`, `claimed`,
   `declined` or `expired`, or one that doesn't exist, can't be relayed and can't be reported as
   `submitted`.
2. **Responses are immutable.** A follow-up is a new id carrying `parentId`.
3. **Every response is bound** to its `binding.task`/`binding.step`, an exact snapshot commit and
   tree, and (for `review-lens`) to the lineage, target, lens, order and subject hash.
4. **Advisors can't change the host project.** That is enforced by the advisor socket allowlist,
   the CLI tool permissions and the nono profile.
5. **Advisors have no authority operations.** No advisory operation writes routing-key or
   stage-marker paths, or calls gentle-ai on an advisor's behalf.

## 6. Advisor selection (policy in workflow_optimisation, mechanism here)

- **The policy lives in workflow_optimisation.** It's a rule table: which requests get
  `rotate`, which get a group of both hosts, which name a specific host. Every request records
  the `selection.rule` that applied.
- **This repository supplies only the mechanism:**
  - **`rotate`** resolves to the least recently used host for the project, recorded as
    `resolvedHost`.
  - **`group`**: an advisor reading a request can never see another request's response from the
    same group until both are submitted. That's first-pass independence.
  - **Overrides:** `advisor-open --host <h> --override-reason <text>` records a user override.
    It's refused without a reason.
- **Advisor answers carry no advisor-selected authority.** Which host answered is evidence about
  the response, not a factor in adjudication.

## 7. Open points (resolved by the plans, recorded here when settled)

- Whether one lineage can mix relayed (`asi-review-*`) and external lenses. Not observed; v1
  assumes it can't.
- What happens when the same lens is captured twice for real. Preflight accepts a duplicate; the
  broker refuses a second relay of a lens per lineage in any case.
- Request expiry TTL (proposed default: 24 h).
