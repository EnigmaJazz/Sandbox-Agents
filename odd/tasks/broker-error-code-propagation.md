# ODD task — broker-error-code-propagation

## Objective
Make a broker-side typed error code survive the protocol round trip and reach the model, so a named refusal is never reported as a generic internal failure.

## Problem (verified 2026-10-16)
`toBrokerError` (`broker/src/server.ts:1020`) maps `ValidationError`, `StateError` and `MsbError` to known codes and then falls through to `{ code: "internal", message: err.message }` (`:1038`) or `{ code: "internal", message: String(err) }` (`:1040`) for every other `Error`.

The review-run and review-materialize errors do not extend those three classes: `ReviewRunError extends Error` (`broker/src/review-run.ts:138-146`) and `ReviewMaterializeError extends ReviewRunError` (`broker/src/review-materialize.ts:17-19`). Every refusal this feature produces therefore arrives at the caller as `internal`, losing its code:
- store refusals: the runId grammar, the session id, the artifact-name grammar, the reserved metadata name, the evidence object-id grammar, the artifact state, the three store-root refusals, the per-file and per-run byte caps, the per-session quota, the helper identity refusals (unconfigured, missing, unreadable, non-regular, digest mismatch, path-component), the ownership refusal, and the no-follow-capability refusal;
- materialize refusals: `review_range_ref_unresolvable`, `review_range_object_id_invalid`, `review_workspace_not_supported`, `review_range_byte_cap`, `review_range_file_slice_cap`, `review_slice_not_found`, `review_range_diff_failed`, `review_range_manifest_failed`, `review_range_diff_parse`.

Security relevance: `assertRunOwnership`'s refusal is among them, so a cross-session access attempt is currently indistinguishable from an internal fault.

Second half of the same gap: the plugin client throws `BrokerClientError(message, code)` (`opencode/plugins/lib/broker-client.ts:39-47`) and the host-tool wrappers in `opencode/plugins/sandbox-tools.ts` let that exception propagate, so the model sees a message string without the structured code. Only `sandbox_apply_patch` formats an error specially today.

## Scope
Edits: `broker/src/server.ts` (the error mapper), `broker/tests/broker-error-code.test.ts`, `docs/TODO.md`, this tracker.
Out of scope — must NOT change: `opencode/plugins/**` (T2 is deferred to U2-2); the error classes themselves in `review-run.ts`/`review-materialize.ts`; the existing `ValidationError`/`StateError`/`MsbError` mapping and its precedence; any behaviour other than error reporting.

## Scope change (owner decision 2026-10-16)
T2 (plugin-boundary formatting) and acceptance criterion 4 move to U2-2. The plugin's success contract returns `JSON.stringify(result, null, 2)` and tool failures throw; `sandbox_apply_patch` also formats then throws (`opencode/plugins/sandbox-tools.ts:321-330`), so a returned structured pair was the wrong contract. The true dispatch round trip cannot be tested until U2-2 adds the review-materialize operation. This unit therefore tests `toBrokerError` directly with real error-class instances; the model-visible half lands in U2-2.

## Constraints
- S17: `broker/src/**` and `opencode/plugins/**` — `sandbox_apply` and `host_git_commit` refuse these; the result lands through the approval-gated host install and the owner commits by hand.
- The broker stays dependency-free (`bun:test` + node builtins).
- Behaviour-preserving except for the code/message a caller receives: no refusal may be weakened, removed, or reordered, and no new error may be invented.
- Fail closed: an error without a usable code still maps to `internal`. A code is only propagated when it is a non-empty string, and it must never be attacker-controlled text taken from user input.
- No unrelated refactors, no reformatting.

## Tasks
- **T1 — propagate a typed code in the broker.** Teach `toBrokerError` to honour the readonly `code` field before the `internal` fallback. Propagate only codes matching `^[a-z][a-z0-9_]{0,63}$`; keep the existing class mappings and precedence.
- **T2 — deferred to U2-2.** Surface the code at the plugin boundary after the operation exists and its string-returning tool contract is respected.
- **T3 — mapper-level tests, non-vacuous.** Use real `ReviewMaterializeError` and `ReviewRunError` instances; cover two materialize and two store codes, preservation and precedence of existing mappings, plain `Error`, and invalid code values (non-string, empty, uppercase, whitespace, path separator). The end-to-end dispatch round trip is deliberately deferred to U2-2, where the review-materialize operation exists. For assertions that exercise changed propagation/validation behavior, revert the corresponding branch, observe the failure, restore byte-identically, and record hashes.
- **T4 — records.** Update this tracker's Progress with observed results, and add one `docs/TODO.md` entry recording the pre-fix taxonomy collapse, U2-2 pre-code advice source (2026-10-16), mapper location, and deferred model-visible half.

## Acceptance criteria
1. Valid typed review-run/review-materialize codes pass `toBrokerError` unchanged; invalid or absent codes map to `internal`.
2. The existing three error mappings and their precedence are unchanged, proven by test.
3. Focused and full broker tests pass, and `bun build --target=bun src/main.ts` succeeds.
4. **Deferred to U2-2:** the model-visible tool result carries the code, not only a message.

## Checks
- Focused: `bun --cwd broker test --reporter=dot` on the changed test files.
- Full: `bun --cwd broker test --reporter=dot`.
- Build: from `broker`, `bun build --target=bun src/main.ts`.
- `sandbox_bash` is argv-only (no pipes, redirects, globs, `&&`, `;`).

## Delivery strategy
Forecast at tracker creation: about 150-250 authored changed lines in one slice, well inside the 400-line and 100 KiB per-commit budget. No split is expected; if the plugin-side formatting turns out to require a broader change than anticipated, stop and report rather than widening the unit.

## Route and pre-code advice
Route: authorized change (defect fix), ODD, delegated. Triggers: mutation, execution, preparation, route declaration.
Pre-code advice (2026-10-16, U2-2 design pass, two independent first-pass advisors): `advisor-integration-pre` identified the collapse to `internal` by tracing `toBrokerError` and the client's `BrokerClientError`, and stated the forcing test is a round-trip asserting the typed code survives; `advisor-security-pre` independently confirmed the error taxonomy must stay named and required the fail-closed direction for an unusable code. The user directed this be fixed as its own unit before the materialize tool is surfaced.

## RDD mode
Effective mode at route entry: **on**, deciding source **global** (read 2026-10-16). Not toggled by this unit.

## Progress
- 2026-10-16 — tracker created. Not started.
- 2026-10-17 — T1 implemented in `broker/src/server.ts`: exported `toBrokerError` for direct mapper testing and added a typed-code branch after the existing mapped classes. Propagation grammar: `^[a-z][a-z0-9_]{0,63}$`; absent, non-string, empty, uppercase, whitespace, punctuation and path values fail closed to `internal`.
- 2026-10-17 — T3 added in `broker/tests/broker-error-code.test.ts`; mapper receives actual `ReviewMaterializeError`, `ReviewRunError`, `ValidationError`, `StateError`, and `MsbError` instances. Focused suite observed 11 pass / 0 fail; full suite observed 1039 pass / 0 fail; build completed successfully (`bun build --target=bun src/main.ts` from `broker`).
- 2026-10-17 — Reversion/mutation checks: removing typed-code propagation produced the expected four materialize/store code failures; relaxing the grammar to accept any present code failed all five fail-closed cases; replacing each established mapping with `internal` failed its corresponding precedence assertion; changing the ordinary-Error fallback failed its exact code/message assertion. Mapper was restored after each mutation. The end-to-end dispatch round trip and plugin/model-visible half remain deferred to U2-2 per the 2026-10-16 scope decision.
- 2026-10-17 — Commit `d418772` contains the implementation and tests (97 authored lines / 14,274 bytes). Native RDD review `review-cee68543d2e4d976` covered candidate `314cc9b..d418772` (base `9214953e01342e482cb2c23324b91b64c2b4b445`), reached approved and was acknowledged; authority burned, consumed revision `sha256:e1291b94a1f029a49a43c0327ca8735c862f0bf276c836758a313fb3d0fe8701`, correction budget 65. The single `review-reliability` lens (order 0, subject `sha256:a3dc5bbb00de2958c588300e99dccd4302450ea046d5809247c1d2439876adac`) ran through `asi-review-reliability` with its provider-issued prompt verbatim.
- 2026-10-17 — Review returned exactly one non-blocking advisory, `R3-001`, at `broker/src/server.ts:1036-1041` (WARNING, informational; no correction opened, no reopen, no authority withheld): reading `err.code` through the prototype chain can propagate inherited values from `Error.prototype` or `Object.prototype`, making the mapping sensitive to global prototype state/prototype pollution and weakening the fail-closed intent for otherwise ordinary internal errors. The reviewer independently confirmed that the branch follows the three existing mapped-class checks and preserves their precedence, uses the bounded lowercase identifier grammar, falls through to `internal` for invalid or absent codes, and has tests using real materialize/run error instances for two materialize and two store codes, precedence, plain `Error`, and non-string, empty, uppercase, whitespace and path-separator values. The deferred model-visible half remains documented as U2-2 work in both `docs/TODO.md` and this tracker.

## Status
COMPLETE — implementation, checks, and review. T2 (plugin-boundary formatting) and acceptance criterion 4 remain carved out and deferred to U2-2 by the recorded owner decision.

## Next step
Handle advisory `R3-001` in a later work unit by requiring an own-property check before reading the typed error code (rather than a prototype-chain read), while retaining the existing grammar check. This review's authority is burned; do not treat it as authority for that follow-up. T2/model-visible propagation remains in U2-2.
