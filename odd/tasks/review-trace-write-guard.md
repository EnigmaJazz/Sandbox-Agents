# ODD Tasks — review-trace-write-guard

- **Feature:** `review-trace-write-guard`
- **Project:** `sandbox-integration` (`/home/james/agent-sandbox-integration`)
- **Status:** Complete; committed as `f048a67` on `feat/review-and-state-hardening`

## Objective

A provider- or caller-supplied `trace` value must not cause a file to be written inside the project during a review lifecycle, because that moves the untracked inventory mid-flow and invalidates the consent gate's own precondition.

## Problem and evidence

The `trace` value is an optional passthrough with no validation of what it points at:

- `opencode/plugins/sandbox-tools.ts:971` — the `host_review_start` tool accepts `trace` as an optional `reviewTokenArg`.
- `broker/src/sdd-service.ts:197-203, 206-230` — `reviewOptional` copies only declared payload keys that are present, and `buildReviewStartOp` forwards optional `trace`; the broker does not synthesize it here.
- `broker/src/sdd-runtime.ts:960-980` — the `reviewStart` argv definition emits `{ key: "trace", flag: "--trace", kind: "token" }`.
- The incident report says `gentle-ai` writes the supplied value as a path. If that path resolves inside the project, it creates a working-tree file and changes the untracked inventory digest between collection and review start, so the consent precondition no longer matches.

**Incident status:** this is historical evidence from an earlier session's stray trace-named file. It was not reproduced in the current session and must not be described as freshly observed. The cited in-repository source confirms the unchecked passthrough path, not `gentle-ai`'s file-writing implementation. The available evidence does not establish the trace output filename/pattern; do not guess a `.gitignore` entry. Revisit only if the authorized work obtains evidence for a concrete pattern.

## Scope and shape

**Implemented layer:** the broker (`broker/src/sdd-service.ts`), the review-start boundary that forwards values to the runtime. Validation here also protects callers that bypass the plugin.

**Selected and implemented shape: candidate 1.** The broker review-start boundary (`broker/src/sdd-service.ts`) validates `trace` against the canonical project root. Resolution uses the deepest existing ancestor, covering symlinked targets and missing components. Values resolving inside the project, the root itself, or any unresolvable or ambiguous value refuse with `reviewStart trace must resolve unambiguously outside the project root`. Legitimate outside-project values are forwarded unchanged. This broker layer also protects callers that bypass the plugin. Candidate 2 (constrain the value shape so it cannot be project-relative) was not selected because it could reject legitimate external targets without preserving the broader verbatim-token contract.

No `.gitignore` rule was added: the trace output pattern could not be established from available evidence, and guessing was explicitly out of scope.

## Constraints and non-goals

- Do not drop or rewrite a provider-issued `trace` value for legitimate targets; forward it verbatim.
- Do not alter unrelated review parameters.
- Refuse unresolvable or ambiguous values rather than silently passing them through.
- The broker source path is an S17-protected path; its change is committed as requested, but S17 still requires user review and manual installation. No plugin, deployment, push, PR, merge, or release was performed or authorized here.

## Stable tasks

- **T1 — Validation:** implement fail-closed validation that rejects trace paths resolving inside the canonical project root and preserves legitimate outside targets verbatim.
- **T2 — Wiring:** connect validation at the chosen broker review-start layer before any runtime spawn; preserve other review parameters unchanged.
- **T3 — Tests:** add coverage for project-internal refusal before spawn, verbatim external forwarding, unresolvable refusal, and unrelated parameter preservation.
- **T4 — Checks and receipt:** run the specified suite and build, record exact observed totals/results, and return the reviewability receipt (`authored_changed_lines`, `authored_patch_bytes`, `generated_or_binary_paths`).

## Acceptance criteria

- A `trace` resolving inside the project refuses before any spawn.
- A legitimate outside-project value still forwards verbatim.
- An unresolvable value refuses.
- The full suite is green and the build succeeds.

## Authorized scope

Implementation scope was the broker review-start validation in `broker/src/sdd-service.ts` and relevant tests; no plugin change was made. The implementation is committed as `f048a67`. No push, PR, merge, or release was performed or authorized.

## Checks and TDD

- `bun --cwd broker test` — 556 pass, 0 fail; 2,786 assertions across 35 files.
- Build — green with output outside the repository.
- RED, stated honestly: 2 fail / 1 pass with the guard bypassed (inside-project and unresolvable cases failed; outside-project forwarding passed). Focused GREEN: 46 pass / 0 fail.
- Reviewability receipt: 122 authored lines (116 additions, 6 deletions); `authored_patch_bytes` was not measured because the sandbox rejected the measurement command, so no estimate is recorded; generated/binary paths were not specified in the supplied receipt.
- `.gitignore`: no rule added because the trace output pattern could not be established from available evidence; guessing was out of scope.

## Route and trigger evidence

- `route: delegated`
- Specialist: `general` sandbox writer, per the user's coding-model decision for this project/session: “Linked directly to OpenCode”.
- Trigger: the two-or-more-non-trivial-files writer trigger.
- Completion update: the earlier tracker-only/not-started status is superseded by the committed implementation and checks recorded here; commit `f048a67` on `feat/review-and-state-hardening`.

## Delivery strategy and review assessment

The change was committed as `f048a67` on `feat/review-and-state-hardening`; the observed receipt was 122 authored lines (116 additions, 6 deletions). `authored_patch_bytes` was not measured because the sandbox rejected the measurement command; no estimate is recorded.

The scoped assessment against base `1407a78` returned **`review_due: false`**, reason **`under_budget`**, `risk: medium`, 5 paths / 328 lines. No review is due and none was run, so this change is **not reviewed individually**; it joins the pending accumulated slice. Do not describe it as reviewed or approved.

## Progress

- T1 — Complete: fail-closed path validation is implemented at the broker review-start boundary.
- T2 — Complete: validation is wired before runtime forwarding, including callers that bypass the plugin.
- T3 — Complete: internal/root and unresolvable refusals plus unchanged outside-project forwarding are covered; unrelated parameters remain unchanged.
- T4 — Complete: checks and the receipt are recorded above.

## Next step

No further implementation step remains in this task. The change is committed; its assessment is `under_budget`, so it is not individually reviewed and remains part of the pending accumulated slice.
