# ODD task — review-pipeline-tools

## Objective
Make `ce:review` usable from the secure orchestrator by exposing two model-facing host tools: `host_review_materialize` (obtain a git range as data, written into the broker-owned run store, with no project write and no approval) and `host_review_slice_read` (serve reviewer-sized slices to reviewers without giving them bash). This unit builds slice U2 only: materialize plus slice read. The pipeline phases and the gated persist are a later slice (U3).

## Problem
`docs/PLAN.md:39-107` records the degraded run that motivated the feature: the diff was obtainable only by brute force, **7 of 7 reviewers returned DIFF_UNAVAILABLE**, the packaged helper pipeline never ran, and `review-summary.json` was never written. Two independent external design reviews (Claude and Antigravity, 2026-10-15) established the root cause of the reviewer failures and the shape of the fix:
- Handing reviewers a single whole-range diff does not work: the reviewer's own `read` truncates around 2000 lines and its `glob`/`grep` skip gitignored paths, so `scope.diff` alone reproduces DIFF_UNAVAILABLE. Slices must therefore be MANDATORY and sized to a reviewer budget.
- The orchestrator has NO write surface at all (`role-policy.ts` ORCHESTRATOR_ALLOWED_TOOLS), so any design where the model supplies an `inputPath` or `contentPath` cannot work. The broker must own every byte.
- A free-content artifact writer must not exist; `finalize` already emits the artifact and the broker should extract and validate it. That tool is NOT in this slice.
- `.context/` is not gitignored, and a directory-level ignore check cannot establish that every child is ignored, so no part of this design may write into the project tree.

## Foundation this unit builds on (already committed and reviewed)
- `broker/src/review-run.ts` — the broker-owned run store: a broker-generated runId bound to its session, a store root from broker config with three store-root refusals, directories 0700 and files 0600, byte caps (per run 8 MiB, per file 4 MiB) and a per-session quota, all enforced before publication and refused with a named error carrying the cap and the observed size, never a truncated file. Publication is atomic (`publishValidatedArtifactAtomic`, temp file plus `O_EXCL`, fsync, rename), and `metadata.json` is reserved case-insensitively as the run record name. `readRunArtifact` is the race-resistant read path: grammar and reserved-name checks, canonical boundary-aware containment against that run, a single `openSync` with `O_NOFOLLOW`, `fstatSync` on that same fd, a regular-file requirement, and the byte cap enforced on both the fstat size and the returned length. `assertRunOwnership` serves a run only to its owning session and does not echo the foreign id. `pruneReviewRuns` and `recoverInterruptedRuns` handle retention and interrupted runs.
- `broker/src/msb.ts` — `spawnExec(argv, opts)` shares the same spawn boundaries as `spawnArgv` but supports an opt-in `envMode: "replace"` and `stdin?: Buffer`, and routes through the same git-hardening choke point (`hardenGitArgv`). `spawnArgv` merges the broker environment and must NOT be widened.
- `broker/src/gitguard.ts` — `hardenGitArgv` neutralizes repository-local `core.hooksPath`/`core.fsmonitor`/`core.pager` with command-line `-c` and refuses execution-bearing git subcommands when the repository-local config defines a key `-c` cannot unset, including a value-aware remote-transport allowlist. Every host git call already passes through it.
- `scripts/install-user-files` pins the ce:review validator helper into a broker-private directory and records `BROKER_REVIEW_HELPER_PATH`/`BROKER_REVIEW_HELPER_SHA256`, verified by `assertPinnedReviewHelper`.

## Scope
Edits, all S17: `broker/src/types.ts` (the `Operation` union), `broker/src/validation.ts` (`ALLOWED_PAYLOAD_KEYS`), `broker/src/service.ts` (the op builders), `broker/src/server.ts` (the dispatch switch and its exhaustiveness guard), `broker/src/role-policy.ts`, the sandbox-guard classification, `broker/src/msb.ts` only if a spawn capability is genuinely missing, `broker/tests/**`, `opencode/plugins/sandbox-tools.ts` (the tool definitions), `opencode/config-fragments/sandbox-permissions.jsonc`, the host-tool manifest document, `docs/TODO.md`, and this tracker.
Out of scope, and must NOT be built in this unit: `host_review_pipeline_run` and the approval-gated persist (U3); any free-content artifact writer; any change to `nono/profile/**`; any change to the worker environment allowlist; any relaxation of an existing protection list; `host_git_read` as a model-facing tool (the external reviews demoted it to an internal module).

## Constraints
- S17: `broker/src/**`, `opencode/plugins/**`, `opencode/config-fragments/**` and `scripts/**` are refused by `sandbox_apply` and `host_git_commit`; the result lands through the approval-gated host install and the owner commits by hand.
- Broker stays dependency-free (`bun:test` + node builtins).
- Security style: explicit types, allowlists, argv vectors, canonical paths, atomic writes, fail closed, no implicit fallback.
- The model supplies NO path and NO byte payload in this slice. The broker generates the runId, owns the store, and owns every artifact. An argument that would let the caller name a file, a directory or a slice destination is a design failure.
- Refs are RESOLVED, never parsed for syntax by the caller: `git rev-parse --verify --end-of-options <ref>^{commit}` and pass only resulting hex object ids to the diff command. Reject a ref that does not resolve with a named error.
- Fail closed, never truncate: a range or a single file exceeding its cap is a named refusal.
- No inline result may carry the diff. Materialize returns only its bounded index.

## Tasks
### Slice U2-1 — materialize and slice read (broker side)
- **T1 — `host_review_materialize`.** Parameters: `baseRef` (required), `headRef` (default `HEAD`), `mode` (`committed` | `workspace`, default `committed`). The broker generates the runId through the existing store. Resolve both refs to commit object ids with `git rev-parse --verify --end-of-options`; refuse an unresolvable ref with a named error that names the ref. Produce the diff with `spawnExec` (replacement env, the git hardening choke point) and publish it into the run store as `scope.diff`. Slice along FILE boundaries to a reviewer budget (about 1500 lines or 45 KiB per slice, whichever binds first) into `slices/<n>.diff`. A single file larger than one slice fails closed with a named error naming the file and its size. Record in the run record: the resolved base and head object ids, the changed-path manifest, each slice's byte length and sha256, and the range's total byte length. Return ONLY a bounded index (the changed-path list, the slice count, per-slice byte lengths and hashes, the runId) and never the diff; the inline result must stay under about 8 KB.
- **T2 — no project write, no approval.** Materialize writes only inside the run store. It must touch nothing in the project tree and must not be approved-gated. Add a test asserting the project tree is byte-identical and mtime-unchanged after a materialize (a real filesystem snapshot comparison, not a `git status` string).
- **T3 — `host_review_slice_read`.** Parameters: `runId`, `slice`. Return at most about 64 KiB of slice content per call and refuse a larger slice with a named error rather than truncating. Enforce `assertRunOwnership`, so a run is served only to the session that created it. Use the existing race-resistant `readRunArtifact` path rather than a new read.
- **T4 — tests for U2-1.** The unresolvable-ref refusal; the oversized-single-file refusal; the slice sizing arithmetic including the boundary case (exactly at the budget is allowed, one byte over is not); the index-only return (assert the serialized index size and that it contains no diff text); the no-project-write snapshot test; the ownership refusal on slice read; the over-cap slice refusal. Every test must FAIL when its guard is removed — verify by temporarily reverting each guard, observing the failure, then restoring byte-identically and recording the source sha256 before and after.

### Slice U2-2 — surfacing the two tools
- **T5 — operation surface.** Add both operations to the `Operation` union (`broker/src/types.ts`) and to `ALLOWED_PAYLOAD_KEYS` (`broker/src/validation.ts`) with exactly the parameters above and no others. Add the op builders and dispatch them in the `never`-guarded switch in `broker/src/server.ts`. Classify both in the sandbox guard so the read-only orchestrator is NOT blocked by the readOnlyAgents policy. Add an `OPERATIONS` parity test asserting that `OPERATIONS` matches the `Operation` union, because `OPERATIONS` was already drifting before this change.
- **T6 — plugin tool definitions and permission.** Add both tools to `opencode/plugins/sandbox-tools.ts` following the existing pattern (ask-gating only where the tool mutates; materialize and slice read do not), and add their permission entries to `opencode/config-fragments/sandbox-permissions.jsonc` with a comment recording which gate they belong to. Update the host-tool manifest document.
- **T7 — tests for U2-2.** A test that both operations are present in the union, in `ALLOWED_PAYLOAD_KEYS`, and reachable through the dispatch switch; the `OPERATIONS` parity test; and a test that an unknown extra payload key is refused for each new operation.
- **T8 — records.** Update this tracker's Progress with observed results, and record the unit in `ROUTER-LOG.md` following that file's existing format.

## Acceptance criteria
1. A range of roughly 3,000 changed lines materializes in ONE call, returns only the bounded index, and writes nothing into the project tree.
2. No inline tool result exceeds about 8 KB, and slice reads are capped at about 64 KiB with a named refusal over the cap.
3. An unresolvable `baseRef` fails closed with a named reason.
4. Both tools are present in the operation union, the payload allowlist, the dispatch switch, the plugin tool definitions, the permission fragment and the manifest; the orchestrator is not guard-blocked; the `OPERATIONS` parity test passes.
5. `bun --cwd broker test --reporter=dot` — baseline 1017 pass / 0 fail, must stay 0 fail. From `broker`: `bun build --target=bun src/main.ts` succeeds.
6. `host_review_pipeline_run`, the artifact persist, and any free-content writer are NOT introduced.

## Checks
- Focused: `bun --cwd broker test --reporter=dot` on the changed test files.
- Full: `bun --cwd broker test --reporter=dot`.
- Build: from `broker`, `bun build --target=bun src/main.ts`.
- `sandbox_bash` is argv-only (no pipes, redirects, globs, `&&`, `;`).

## Delivery strategy
Forecast at tracker creation: about 1,200 authored changed lines across two slices (U2-1 about 700, U2-2 about 500), excluding generated files. Strategy: `ask-on-risk` (default). The per-commit cap of 400 authored changed lines and 100 KiB authored patch applies; a slice that cannot fit is split further rather than shrunk. Landing U2-2 makes the tools live only after the owner runs `scripts/install-user-files --apply` and restarts secure OpenCode; that act is the owner's. Push, PR and merge are not authorized here.

## Route and pre-code advice
Route: authorized change, substantial feature, ODD, delegated. Triggers: mutation, execution, preparation, route declaration.
Pre-code advice for the underlying feature was taken before U1 and is recorded with it: two independent external design reviews (Claude, Antigravity) plus three internal first-pass advisors. Their durable findings are the ones restated under Problem, plus: reviewers must receive reviewer-sized slices rather than a whole-range diff; the orchestrator has no write surface, so the broker owns every byte; the free-content artifact writer must not exist; `.context/` is not gitignored so nothing may write into the project tree; and a new host operation must be classified in the sandbox guard or the read-only orchestrator is blocked. `advisor-design-pre` returned `EXTERNAL_CONTEXT_REQUIRED` for the installed helper contract, and that evidence now lives in `review-run.ts` and `scripts/install-user-files`.

## RDD mode
Effective mode at route entry: on, deciding source global (read 2026-10-16). Not toggled by this unit.

## Progress
- 2026-10-16 — tracker created. U2-1 not started.

## Next step
T1: implement `host_review_materialize`, test-first, with the unresolvable-ref and oversized-file refusals in place before any slice is written.
