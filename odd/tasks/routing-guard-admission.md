# ODD task — routing-guard-admission

## Objective
Make tool admission broker-owned and default-deny, so the confined agent cannot reach a host-filesystem mutation through a tool the guard does not know about. AFT stays installed, loadable and functional; only host-administering AFT mutations are denied, which the broker already denies today.

## Problem (verified 2026-10-17)
`opencode/plugins/routing-guard.ts:44-50` blocks five built-in tool NAMES: bash, edit, write, apply_patch, patch. The mutation branch refuses by returning `{ error: ... } as unknown as void` (`:157-163`), but the documented `tool.execute.before` contract is to THROW; the typed `{error}` helper belongs to `tool.execute.after` (`opencode/plugins/lib/reviewer-relay-core.ts:1096-1099`). The read branch already throws correctly (`:153`). So the guard's mutation refusal may not cancel anything, and today's blocking of built-ins is carried by the permission fragment, not by the guard.

The guard reads only `input.tool` and `output.args` (`:116-118`, `:143-144`) with no server or provenance field, so an MCP tool is representable only by its registered name. Whatever nono grants is therefore reachable by any write primitive that is not one of those five names. `nono/profile/opencode-secure.json:27-28` grants the agent read-write on `$HOME/.cache/opencode` and `$HOME/.config/opencode`, and the profile's own README states that subagents inherit the same access. An owner-run probe confirmed the package cache is WRITABLE from inside the profile.

The broker ALREADY has the right classifier and already denies host administration: `broker/src/role-policy.ts:126-152` maps `aft_outline|aft_zoom|aft_search|aft_callgraph|aft_inspect` to HOST_READ_STRUCTURED and `aft_safety|aft_import|ast_grep_replace` to HOST_ADMIN_STRUCTURED, and `decide()` denies that class for every role (`:373-375`). The guard simply never consults it.

## Scope
This unit makes admission broker-owned and default-deny, with the guard consulting it. It does NOT attempt to route AFT into a worker: the worker has no host mounts (fs.conf `{}`, S11) and AFT is not in the worker image, so that is infeasible; denying host administration while keeping AFT reads satisfies the owner's AFT directive. It does NOT change the existing classification of what is denied, and does NOT broaden the guard's path-prefix check into mutation authorization.

## Constraints
- S17: `broker/src/**`, `opencode/plugins/**`, `opencode/config-fragments/**` — the owner commits by hand.
- Broker dependency-free (bun:test + node builtins). Explicit types, allowlists, fail closed, no implicit fallback.
- AFT must remain installed, enabled and functional: reads stay allowed, and no AFT tool file, config or plugin may be removed or disabled.
- A denial must be observable: a refusal that returns instead of throwing is a defect.
- Unknown is denied by default, and denying must remain safe for legitimate work: every tool a secured session legitimately needs must be classified, and a test must fail if one is missing.

## Tasks
- **T1 — classify the full inventory.** Extend the classifier in `broker/src/role-policy.ts` so every tool a secured session legitimately uses has an explicit class: the read toolset, the sandbox family (including the worker and lifecycle ops), the host read and host mutation operations, task/question/skill/systematic, the codegraph and vision and webfetch and github read tools, and the AFT tools with their existing classes preserved exactly. Group the inventory in one exported constant with a test asserting no expected tool is unclassified. Preserve the existing denial of HOST_ADMIN_STRUCTURED; do not widen it.
- **T2 — an admission decision the guard can ask for.** Add a broker operation returning allow or deny with a reason for (session, tool), resolving the agent identity broker-side so the guard never supplies it. Register it through every registry, including the OPERATIONS parity test. Keep it a read-class operation: it changes no state.
- **T3 — the guard consults it and throws.** Replace the hardcoded name lists with the broker decision, per call, failing closed when the broker is unreachable (already the guard's stated posture). Denial must THROW, not return. Keep routing-guard.ts's existing external-read-root approval logic and the approvedRoots fetch unchanged.
- **T4 — the fragment as defence in depth.** Add explicit allow entries for the tools the classifier allows, so a misconfigured guard does not silently block work and a misconfigured fragment does not silently permit it. Do not remove existing entries.
- **T5 — verification.** Tests that (a) every expected tool is classified and an unknown tool is denied, (b) the guard throws on denial and does not return, (c) an AFT read is allowed while `aft_safety`, `aft_import` and `ast_grep_replace` are denied, (d) `sandbox_apply` and the sandbox family remain allowed, (e) the broker failing closed when unreachable. A revert table over each guard with the source sha256 before and after.
- **T6 — records.** Update this tracker's Progress, and record the unit in `ROUTER-LOG.md` in that file's existing row format.

## Acceptance criteria
1. An unclassified tool is denied by default, and the denial throws.
2. Every tool a secured session legitimately needs is allowed, proven by a test that fails if one is missing.
3. AFT reads work; AFT host-admin mutations are denied, matching the broker's existing rule.
4. The broker is unreachable case denies (fail closed).
5. `bun --cwd broker test --reporter=dot` stays at 0 fail from the 1140 baseline; `bun build --target=bun src/main.ts` succeeds.

## Checks
Focused tests on the changed files; full `bun --cwd broker test --reporter=dot`; build from `broker`; the plugin bundle check. `sandbox_bash` is argv-only.

## Route and pre-code advice
Route: authorized change, security fix, ODD, delegated. Triggers: mutation, execution, preparation, route declaration.
Pre-code advice (2026-10-17, two internal first-pass advisors):
- `advisor-security-pre`: the boundary must be execution LOCATION, not tool names; extending the denylist is temporary containment only; do not implement blanket AFT denial; specify what the hook knows and prove refusal prevents execution; resolve the mixed-operation conflict, since `role-policy.ts` labels every `aft_safety` call as host administration while accepting only the operation name.
- `advisor-integration-pre`: the hook registers `tool.execute.before` and sees only a bare tool name; the mutation branch uses the wrong cancellation contract and must throw; a classifier already exists in `role-policy.ts` and the broker already denies host administration, so the fix is to consult it rather than invent a second adjudicator; worker-routing AFT is infeasible (no host mounts, AFT absent from the worker image); default-deny breaks legitimate work unless the allowlist is complete and centralized; do not broaden the string-prefix path check into mutation authorization, and note that `.atl`, `.codegraph` and `.git` are writable beneath the worktree, so "the worktree is read-only" is too broad a claim.

## RDD mode
Effective at route entry: on, deciding source global (read 2026-10-17). Not toggled by this unit.

## Progress
- 2026-10-17 — tracker created; implementation not started.
- 2026-10-18 — Added temporary routing-guard containment: mutation refusals throw the existing block message; blocked `ast_grep_replace`, `aft_import`, and `aft_safety` while preserving AFT reads. `broker/tests/routing-guard.test.ts` did not exist and was created. Temporarily restoring the return form made the focused test fail (8 fail, 3 pass); restoring the throw form made it pass (11 pass, 0 fail). Full broker suite passed (1151 pass, 0 fail); `bun build --target=bun --outdir /tmp/routing-guard-check opencode/plugins/routing-guard.ts` bundled successfully. No dedicated plugin bundle script is defined in the root or broker package scripts. Tracker update records only this containment slice; broker-owned default-deny admission remains the durable work.

## Next step
T1: extend the classifier to the full expected inventory, test-first, with the unclassified-is-denied test in place first.

## Finish
Call `sandbox_finish`, then `sandbox_apply` (approval-gated; may block for human approval — expected). Report the file path, its byte size, whether apply completed, and the changed-path list.
