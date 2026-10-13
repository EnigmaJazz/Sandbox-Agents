## Planned host operation — workflow router ledger append

`ROUTER-LOG.md` is the workflow decision ledger: each routed work unit in every project should record its date, change or feature, unit class, route, specialist, evidence, and outcome. The ledger lives at `/home/james/ai-workspace/workflow_optimisation/ROUTER-LOG.md`, outside every project that produces the work. In the observed case, seven rows from this repository's session had to be handed to the user manually because this project had no authorized way to write into the ledger's project.

### Proposed operation

Extend `host_plan_append` with a `router-log` document value, alongside `todo` and `plan`, and have the broker resolve that value to the ledger's fixed canonical path. This is preferable to a sibling `host_router_log_append`: it reuses one narrow, fixed append surface and avoids growing the host API with a near-duplicate operation. The added cross-project mapping must remain an explicit broker-owned allowlist entry; it must not turn the operation into a general path writer. A dedicated sibling operation is the fallback only if the ledger's authorization or append semantics cannot safely share `host_plan_append`.

Requirements:

- Resolve the cross-project destination exclusively from the broker-owned document enum to its canonical path; never accept a caller-supplied target path.
- Make it orchestrator-only and approval-gated.
- Bound the appended content and validate the row schema: date, change/feature, unit class, route, specialist, evidence, and outcome.
- Append atomically while preserving all existing bytes; fail closed on invalid input or write failure.
- Enforce S17-aware path protection so this narrow ledger exception cannot authorize writes to other protected paths.
- Do not route the destination through the existing project-root containment (`isWithin(projectRoot, …)` in `buildPlanDocAppendOp`, `assertBeneathProjectRoot` in `appendPlanDocAtomically`): that check correctly refuses an out-of-project path. Give the enum entry its own fixed, canonical, symlink-checked destination and its own containment check, and leave project-root containment unchanged for every other document.

Without this operation, ledger rows must be reconstructed from memory at session end. That is the same unverified synthesis this project has been working to eliminate; capture the evidence-backed row while the routed work and outcome are available instead.

## Planned host operation — claim-retractions ledger append

`CLAIM-RETRACTIONS.md` records retracted agent claims so the next session does not repeat them. It addresses an observed failure class: absence and mechanism claims asserted from a single under-scoped observation. In one session, five claims were retracted: a grep pattern that could not match its target was used to deny that a fix existed; “no prompt occurred” was inferred literally from “no prompt appeared”; a plausible but wrong mechanism blamed state GC for pruning a bundle that had never been written; an untested claim said a new session was required; and literal provider error text was treated as the root cause. Three later fixes each addressed a mechanism that did not exist, for the same reason: reasoning about the producer instead of reading the consumer.

### Proposed operation

Extend `host_plan_append` with a `claim-retractions` document value alongside `todo`, `plan`, and the planned `router-log`, and have the broker resolve that value to the ledger's fixed canonical path. Reuse the narrow append surface rather than adding a near-duplicate host operation; do not turn it into a general path writer.

Requirements:

- Resolve the destination exclusively from a broker-owned document enum to its canonical path; never accept a caller-supplied target path.
- Make it orchestrator-only and approval-gated.
- Bound appended content and validate each row against the schema: date; claim as stated; class (`observed`, `inferred`, or `assumed`); search or check performed; positive control (what the thing would look like if present, and why that search would match it); what caught the retraction; corrected conclusion.
- Append atomically while preserving all existing bytes; fail closed on invalid input or write failure.
- Enforce S17-aware path protection so this narrow ledger exception cannot authorize writes to other protected paths.
- Do not route the destination through the existing project-root containment (`isWithin(projectRoot, …)` in `buildPlanDocAppendOp`, `assertBeneathProjectRoot` in `appendPlanDocAtomically`): that check correctly refuses an out-of-project path. Give the enum entry its own fixed, canonical, symlink-checked destination and its own containment check, and leave project-root containment unchanged for every other document.

Without this operation, records reconstructed from memory at session end are exactly the unverified synthesis this ledger exists to prevent.

## Brief — host review pipeline tools for the secure OpenCode orchestrator

Source: brief from a secure-opencode session whose repo of record was
`/home/james/ai-workspace/tasker/tesla`. Captured in substance; the tool names below are
proposals, not existing operations.

### Observed failure (one real run)

`ce:review` over `593ffd9..7564788` (3,112 changed lines, 26 files) degraded on four axes:

| Gap | Evidence |
|---|---|
| Diff obtained only by brute force | 4 worker delegations; 2 of 3 diff returns truncated in transit (~16 KB / ~26 KB), spilled to a host path no other session could read |
| Reviewers had no diff | 7 of 7 reviewers returned DIFF_UNAVAILABLE — they reviewed current file contents only, so `pre_existing` attribution was unverified |
| Packaged pipeline never ran | `ensure-ignore.mjs` and `validate-review.mjs` (screen/prepare/merge/finalize/artifact) are node scripts outside the sandbox allowlist |
| Run artifact never written | `.context/systematic/ce-review/<runId>/review-summary.json` — the orchestrator has no write surface |

Adjacent: `git rev-parse` was unavailable, so branch/ref facts came from hand-reading
`.git/HEAD`, `.git/refs/**`, `.git/packed-refs`.

### Root causes

- **RC1** — no non-mutating way to obtain a git range as data.
- **RC2** — no shared scratch surface: a file written by one worker session is invisible to the
  next, so a diff fetched once cannot be reused by N reviewers.
- **RC3** — no execution surface for the bundled helpers (structural admission and
  deterministic merge must not be done by hand).
- **RC4** — no artifact write surface.

### Proposed fixed host tools

1. `host_git_range_materialize` — read-only wrt project state; writes only into the ignored run
   dir. Params: `baseRef` (required), `headRef=HEAD`, `mode: committed|workspace`,
   `contextLines=3`, `paths[]`, `runId`. Fixed `git -C <canonical-root>` argv; refuses
   unresolvable refs rather than falling back. Writes `scope.diff`, `scope.index.json`
   (base/head shas, commits, changed paths, per-file added/deleted, untracked) and optional
   `slices/<n>.diff`. Returns only the bounded index, never the diff inline.
2. `host_review_pipeline_run` — approval-gated. Params: `phase:
   ensure-ignore|screen|prepare|merge|finalize|artifact`, `reviewer?`, `harness?`,
   `inputPath`, `runId`. Resolves the installed helper by path, fixed argv, stdin from a
   project-relative path, stdout captured under the run dir and returned as a bounded summary.
3. `host_review_artifact_write` — approval-gated. Params: `runId`, `contentPath|content`,
   `filename: "review-summary.json"`. Atomic temp-file + rename, owner-only perms, refuses any
   path outside `.context/systematic/ce-review/<runId>/`.
4. `host_git_read` — read-only, optional. Allowlisted `rev-parse|merge-base|status|log|
   ls-files|for-each-ref`, bounded output.

### Boundaries (non-negotiable)

Typed params only, fixed argv, canonical project root only — no arbitrary shell, and no
push/commit/checkout/fetch/`--ext-diff`/external diff drivers. Writable roots are exactly two,
both verified gitignored and never assumed: the `ce:review` run dir and `.atl/review/**`.
Tool 1 is read-only wrt refs so it needs no approval; tools 2–3 are ask-gated to
`gentle-orchestrator` only. Reviewers must not be given bash — they gain read access to the
materialized diff and nothing else. Cap materialised bytes (e.g. 8 MiB) and fail closed with a
named error rather than truncating.

### Acceptance criteria

1. A 3,000-line range materialises in ≤1 tool call and **0 reviewers** report DIFF_UNAVAILABLE.
2. `screen→prepare→merge→finalize` each run in ≤1 tool call; the written `review-summary.json`
   passes the artifact self-validation.
3. No inline tool result exceeds ~8 KB; no worker activation is needed for pure scope/diff work.
4. An unresolvable `baseRef` fails closed with a named reason.

### Regression risks to hold

New write roots are new privacy surface — keep them to the two ignore-verified directories and
never inside tracked source. Silent truncation is worse than failure: cap and fail closed.

## Planned change — PM-layer host-mutation identities

The workflow-side PM rollout requires host mutations to be authorized for `pm-odd`, `pm-systematic`, `pm-sdd`, and the temporary `pm-probe`, in addition to `gentle-orchestrator`. Extend the host-resolved identity allowlist without changing the rule that PMs cannot enter the sandbox. Remove `pm-probe` after the workflow side reports its probe closed.

### Identity source and operation boundary

Prefer one configured identity source consumed by both `opencode/plugins/sandbox-tools.ts` and `broker/src/config.ts`, preventing the plugin and broker from drifting. If a shared source is impractical, keep the two constants and add a test that fails when they differ. Preserve existing per-operation authorization. As an optional refinement, the implementation may keep `registerProject` restricted to `gentle-orchestrator`, while allowing PMs to run the other host mutations; a flat identity allowlist is acceptable because workflow-side `opencode.json` also enforces this split.

The relevant existing paths are `READ_ONLY_AGENTS` in `opencode/plugins/sandbox-tools.ts:64`, `DEFAULT_READ_ONLY_AGENTS` in `broker/src/config.ts:243`, and `authorizeHostDispatch`, `bindSessionAgent`, and `assertBindableAgent` in `broker/src/service.ts`, plus `shouldRefuseEnsureWorker` in `broker/src/role-policy.ts`.

### Invariants

Broker and plugin tests must cover all six invariants for each new identity (`pm-odd`, `pm-systematic`, `pm-sdd`, and `pm-probe`):

1. A PM never enters the sandbox: `ensureWorker` refuses allowlisted identities, and `sandbox_*` mutation tools refuse them.
2. Binding is host-resolved from `chat.params` hook input only, never from a tool argument or request envelope.
3. First writer wins: a session bound to one identity is never rebound.
4. Unknown sessions fail closed: no binding means no mutation.
5. Reads remain open to every agent.
6. A worker can never become a PM, including as a child of a PM session.

### Probe plan

After install, obtain observed results—not inferences—for each open question:

1. For a child session created by the Task tool, does `chat.params` fire with the subagent's own name and bind that child, carry the parent's name, or not fire?
2. Does a PM binding remain valid on a session resumed with the Task tool's `task_id`?
3. Does `opencode/plugins/reviewer-relay-transport.ts` deliver review context when its dispatching session is a depth-1 subagent?
4. What does a PM receive from `sandbox_read`, `sandbox_list`, `sandbox_grep`, and `sandbox_diff`, which call `assertNotOrchestrator`; if refused, which read surface should the PM use instead?
5. Is any broker or plugin behavior sensitive to session depth or walking `parentID`, given the workflow side will raise `subagent_depth` from 3 to 4?

This is a design record, not evidence that implementation or probes have completed. S17 broker/plugin changes remain behind the existing manual owner-review and exact-byte installation gate. If an installed file changes, update installer and rollback lists. The contract returned to the workflow side must state authorized identities and any per-operation limits, all five observed answers, and required restarts (`sandbox-broker.service`, `secure-opencode.service`). The workflow side owns `opencode.json`, PM prompts, routing guard, and verifier. This change does not alter the advisor relay or interface contract, worker roles, sandbox isolation, or review-lens transport beyond probe 3.
