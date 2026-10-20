# Prompt — revise the ce:review contract in workflow_optimisation

Run this prompt in `/home/james/ai-workspace/workflow_optimisation`.

## Task

Revise the ce:review contract text (the `ce:review` paragraph under "Current upstream review lifecycle" in `WORKFLOW.md`, and `odd/tasks/q86-ce-review-parameters.md`) so that the following are NORMATIVE contract parameters, not implementation suggestions. Record each item as a requirement with its refusal behavior.

1. **Helper identity.** A configured absolute helper path plus a configured SHA-256, and a separate configured absolute, regular, executable interpreter. Never PATH-resolved and never defaulted. Both are verified before every invocation; mismatch, absence, or a non-regular file is a named refusal with no fallback.
2. **Byte custody.** The pinned helper's bytes must come from a source the confined agent cannot write, and the digest must be verified against an operator-authored anchor. A digest computed at install time over agent-writable bytes is not a trust anchor. In practice the anchor lives in the project repository working tree, the only local surface a confined agent cannot write.
3. **Inline stdin cap.** The payload is capped at 256 KiB of real bytes. Over-cap refuses, naming the cap and the observed size. Never truncate.
4. **Slices.** A slice is limited to 1500 realized diff lines or 46,080 bytes, whichever binds first, packed on file boundaries. An oversized single file refuses, naming the cap and the observed size. Never split mid-file and never truncate.
5. **Fixed argv.** Per phase: `screen --reviewer <persona> --harness opencode`; bare `prepare`; bare `merge`; bare `finalize`; `artifact <path>`. The harness is server-side, never caller input.
6. **Timeouts.** Thirty seconds per helper invocation with a sixty-second client timeout, so the client cannot abort mid-write.
7. **Exit codes.** `0` valid; `1` structural rejection; `2` usage or unreadable path; `3` legacy artifact missing `schema_version`. Exit `1` whose stderr begins with `ce-review-validator: internal error in ` is a helper CRASH, not a rejection; that prefix is the only discriminator.
8. **Range data.** Resolved base and head object IDs are supplied as range data. Reviewer-side Git is not used for resolution.
9. **Artifacts.** Every phase publishes its raw output bytes as a deterministic per-phase artifact with byte length and SHA-256. Callers receive references, lengths, hashes and bounded summaries only, never raw helper output inline.
10. **Single approval gate.** Exactly one approval, on `persist`, taken before dispatch. Denial dispatches zero requests. `materialize` and the four phases need no approval.
11. **Phase envelopes (discovered live; make them normative).**
    - `prepare` payload: `{ "screen_results": [ { "reviewer": "<persona>", "result": <screen artifact> } ], "selected_dispatches": [ { "persona": "<persona>", "dispatch_outcome": "<outcome>" } ] }`. The two persona sets must match exactly; `input_finding_count` inside a dispatch entry is REJECTED.
    - `merge` payload: `{ "prepared": <prepare artifact>, "adjudication": { "decisions": [ ... ] } }`.
    - `finalize` payload: `{ "merge": ..., "prepared": ..., "screen_results": ..., "dispatch_records": ..., "validator_lifecycle_results": ..., "plan_assessment": { "verdict": ..., "results": ... }, "parent_run_metadata": { ... } }`. `plan_assessment` accepts ONLY `verdict` and `results`. `parent_run_metadata.timestamps` requires both `started_at` and `completed_at`. `validation.status` must be `not_attempted` at finalize, with a non-empty `reason`. `head_sha` is bound by the runtime, and a differing caller value is refused.

## Two open requirements — record as UNRESOLVED

- **Reviewer delivery.** Sliced diff delivery to reviewer personas is unresolved. The orchestrator materializes the diff and inlines it into persona prompts; reviewer-side reading is not viable because reviewers are child sessions, the run store serves only the exact owner, and the native relay lane has all tools disabled. The contract must specify how a reviewer receives its slice without granting store access or tool execution.
- **Helper byte custody.** The contract must name the operator-authored anchor and the non-agent-writable source, and must state that an install-time computed digest over agent-writable bytes does not satisfy it.

## Persona authority

State explicitly that ce:review personas RETAIN read access to source and tests and gain NO execution. Any command or test a persona wants run must be expressed as a structured test request — hypothesis, exact command, required environment, expected confirming and falsifying observations, side effects — executed by an authorized operator or agent, with the observed evidence returned to the reviewer.

## Boundary

Do not merge enumerations. The ce:review persona list and the native 4R lens names are different sets and must never be unified. The native review lane is unchanged by this contract revision.
