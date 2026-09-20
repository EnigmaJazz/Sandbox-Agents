# Apply Progress: Reviewer Relay Transport

- change: `reviewer-relay-transport`
- store: hybrid (Magic Context + OpenSpec, identical canonical bodies)
- phase: apply
- mode: **Standard** (`strict_tdd: false` in `openspec/config.yaml`); the change's
  tasks still required RED-first, so a RED → GREEN table is recorded per work unit
- chain strategy: `stacked-to-main` (corrected from `feature-branch-chain` at the
  user's direction before implementation began)
- delivery strategy: `auto-chain`
- date: 2026-09-15
- remediation: `reviewer-relay-frame-fix` and `reviewer-relay-postresult-remediation`
  (post-verification bounded defect fixes; see "Bounded Defect Remediation" below)

## Completed Tasks

- [x] 1.1 RED fakes/tests for session-root selection and every threat selector
- [x] 1.2 RED tests for hook disjointness, binding-only boundary, framing fidelity,
  malformed/extra/oversized frames, and missing `GENTLE_AI_REVIEW_CONTEXT_END`
- [x] 1.3 RED tests for fixed binary/argv, `shell:false`, allowlist-only environment,
  4 MiB stdout / 64 KiB stderr bounds, deadline, crash/abort/duplicate/disposal
  refusals, and no synthesized authority
- [x] 2.1 `opencode/plugins/reviewer-relay-transport.ts` with pinned
  `gentle-ai.provider-transport/v1` NDJSON validation, verbatim frame forwarding,
  END-delimiter enforcement, and typed fail-closed refusals
- [x] 2.2 Canonical session resolution via `client.session.get`, versioned
  process-global immutable cache, broker `policy.projects` realpath equality, exact
  allowlist root, server-root inequality, no ambient fallback
- [x] 2.3 Fixed spawn (`/home/linuxbrew/.linuxbrew/bin/gentle-ai review
  opencode-transport`), piped stdio, `shell:false`, constructed HOME/XDG/locale env,
  bounds, finite 600 s deadline
- [x] 2.4 Versioned `(sessionID,callID,agent)` owner/deferred/refused registry, four
  concurrent relays, before/after state machine, half-close, cleanup/kill, isolation
  transform, `session.created` agent/title decode
- [x] 3.1 `opencode/config-fragments/reviewer-relay-agents.jsonc` with six hidden,
  subagent-only, tool-less `asi-review-*` agents and counterpart models
- [x] 3.2 `AGENTS.md` lens→Task-name map (provider lens/capture fields unchanged);
  `openspec/changes/agent-host-tools/design.md` Phase 6 amended as diagnostic-only
- [x] 3.3 `docs/discovery-report.md` §11 and `docs/manual-verification.md` Gate 11
  (assets, S17 review/install/restart/one-Task gate, rollback, no agent certification)
- [x] 4.1 Full `bun test` and `bun build src/main.ts`; intended repo-local paths only
- [x] 4.2 `reviewLensContext` diagnostic contract unchanged; transport separate
- [ ] 4.3 Reviewed package handed to the user (manual S17 gate — user completes)

## Files Changed

| File | Action | What Was Done |
|------|--------|---------------|
| `opencode/plugins/reviewer-relay-transport.ts` | Created | Relay core (root resolution, bounded spawn, strict framing, deadline) plus lifecycle hooks, owner/deferred/refused registry, isolation transform |
| `opencode/config-fragments/reviewer-relay-agents.jsonc` | Created | Six `asi-review-*` agents: hidden, subagent-only, tool-less, counterpart models; NOT INSTALLED, MANUAL merge |
| `broker/tests/reviewer-relay-transport.test.ts` | Created | 49 tests: root selectors, framing, spawn discipline, authority boundary, lifecycle, hooks, fragment, Task-name map |
| `AGENTS.md` | Modified | Added the reviewer relay section with the lens→Task-name table and the unchanged provider-field contract |
| `openspec/changes/agent-host-tools/design.md` | Modified | Added the amendment that `reviewLensContext` is diagnostic, not transport or authority |
| `docs/discovery-report.md` | Modified | Added §11 recording the assets, boundaries, and that the installed transport was not modified |
| `docs/manual-verification.md` | Modified | Added Gate 11 with the gates, install steps, and rollback |
| `openspec/changes/reviewer-relay-transport/tasks.md` | Modified | `Chain strategy` corrected to `stacked-to-main`; Phase 1–3 and 4.1/4.2 marked complete |

## Test Environment Notes (worker)

- The sandbox worker executes commands with cwd `/`, so `cd broker && bun test` is
  reproduced as `env -C /work/broker ...`.
- `bun` is not spawnable through PATH in the worker; the absolute
  `/usr/local/bin/bun` works. Both facts are worker properties, not product defects.

## RED → GREEN Evidence

| Work unit | RED (test written first, observed failing) | GREEN (after implementation) |
|---|---|---|
| 1 — root/spawn/framing core | `bun test tests/reviewer-relay-transport.test.ts` → `error: Cannot find module '../../opencode/plugins/reviewer-relay-transport.ts'`; `0 pass, 1 fail, 1 error`. After the first core drop: `3 fail` — the RED tests caught three real gaps: (a) a session-lookup failure escaped untyped, (b) an allowlist-load failure escaped untyped, (c) `validateMaterializedPrompt` accepted a bare `GENTLE_AI_REVIEW_CONTEXT_END` as the start marker because the start delimiter is its prefix. All three were fixed in the core. | `49 pass, 0 fail` (focused suite), `399 pass, 0 fail` (full suite) |
| 2 — lifecycle hooks + fragment + map | Before the hooks existed the hook suite failed loudly: `RelayRefusal: reviewer_relay_hooks_unimplemented` for all 7 hook-scope tests, `ENOENT ... reviewer-relay-agents.jsonc` for the fragment, and 3 Task-name-map failures. After the first hooks drop: `4 fail` — the after hook read the agent identity from `input.args` only, and the tests modelled the wrong host shape. Fixed by modelling the verified host API (`input.args` on the after hook) and adding a mirrored-output fallback so a host shape change cannot silently pass raw reviewer prose through as a completion. | `49 pass, 0 fail` |
| 3 — docs + integration proof | No new tests; document assertions in the same suite were RED until the `AGENTS.md` map, the fragment, and the design amendment existed. | `49 pass, 0 fail` |

## Work Unit Evidence

### Work unit 1 — bounded root/spawn/framing relay

| Evidence | Value |
|---|---|
| Focused test command and exact result | `/usr/bin/env -C /work/broker /usr/local/bin/bun test tests/reviewer-relay-transport.test.ts` → `49 pass, 0 fail, 269 expect() calls, Ran 49 tests across 1 file. [48.00ms]` |
| Runtime harness command/scenario and exact result | `N/A` for the real provider child: the plugin is S17 and is not installed, so no `gentle-ai` transport is spawned and no `HOME`/XDG state is touched. The protocol path is exercised through an injected scripted transport child that answers `start` → `prompt{nonce, block}` and `complete{nonce, output}` → `result{output}`, including the binding-only → materialized-prompt substitution and the `cwd`/argv/env spec asserted on every spawn. |
| Rollback boundary | Revert `opencode/plugins/reviewer-relay-transport.ts` and `broker/tests/reviewer-relay-transport.test.ts`. No other file depends on them. |

### Work unit 2 — lifecycle hooks, agents, and Task mapping

| Evidence | Value |
|---|---|
| Focused test command and exact result | `/usr/bin/env -C /work/broker /usr/local/bin/bun test tests/reviewer-relay-transport.test.ts` → `49 pass, 0 fail`; hook-scope block: installed `review-*` names and unrelated tools bypass with zero spawns, `asi-review-*` resolves the session root and materializes the block, root refusal refuses pre-spawn, the fourth-plus relay refuses pre-spawn, a duplicate instance defers, `session.created` registers only `asi-review-*`, and an orphaned completion refuses loudly. |
| Runtime harness command/scenario and exact result | `N/A` until the user installs the S17 package; the reviewer Task is the manual gate (Gate 11). Simulated harness: a shared registry Map drives two hook instances to prove owner/deferred behaviour without a real host. |
| Rollback boundary | Revert the hook block in `opencode/plugins/reviewer-relay-transport.ts`, delete `opencode/config-fragments/reviewer-relay-agents.jsonc`, and remove the reviewer relay section from `AGENTS.md`. The core relay and its tests stay intact. |

### Work unit 3 — docs, integration proof, and manual handoff

| Evidence | Value |
|---|---|
| Focused test command and exact result | `/usr/bin/env -C /work/broker /usr/local/bin/bun test` → `399 pass, 0 fail, 1808 expect() calls, Ran 399 tests across 17 files. [347.00ms]` |
| Build harness command and exact result | `/usr/bin/env -C /work/broker /usr/local/bin/bun build src/main.ts --outdir /tmp/build-check` → `Bundled 24 modules in 33ms` / `main.js 1.15 MB (entry point)`. `--outdir` is used only so the build does not leave `broker/main.js` in the reviewed package. |
| Workspace check | `/usr/bin/env -C /work git status --short` → `M AGENTS.md`, `M docs/discovery-report.md`, `M docs/manual-verification.md`, `M openspec/changes/agent-host-tools/design.md`, `?? broker/tests/reviewer-relay-transport.test.ts`, `?? opencode/config-fragments/reviewer-relay-agents.jsonc`, `?? opencode/plugins/reviewer-relay-transport.ts`. No installed host configuration was read or written; `~/.config/opencode/plugins/` was not modified. |
| Rollback boundary | Revert the docs/`AGENTS.md`/design changes and uninstall the plugin and fragment per Gate 11. |

## Deviations from Design

1. **`startRelay` also enforces the canonical absolute root.** The design puts root
   validation in the resolver; the relay core additionally refuses a relative,
   symlinked, or control-bearing `cwd` before spawn, so the spawn boundary holds even
   if a future caller bypasses the resolver. Defence in depth, no contract change.
2. **After-hook agent identity accepts a mirrored output.** The verified host carries
   the Task arguments on the after-hook *input*; the relay falls back to the mirrored
   `output.args` when the input omits them, so a host shape change cannot silently
   pass raw reviewer prose through as a completion.
3. **The cache re-checks the server-root inequality on a hit.** The design describes a
   versioned process-global cache of successful roots; re-checking this instance's
   server root on a hit keeps the guard per instance when duplicate plugin instances
   share the cache.
4. **No separate module for the hooks.** Everything lives in the single plugin file
   named by the design's file-changes table; no extra artifact was introduced.

## Issues Found

1. `validateMaterializedPrompt` initially treated the `GENTLE_AI_REVIEW_CONTEXT_END`
   marker as satisfying the start-delimiter check (the start delimiter is its prefix).
   Fixed by rejecting a start marker that begins the END marker; the RED test now
   covers `body only\n..._CONTEXT_END`.
2. A session-lookup or broker-policy failure initially escaped as an untyped error
   instead of a typed refusal. Fixed with `refusalOr`, which preserves a typed refusal
   and wraps anything else in the caller-specific typed refusal.
3. The worker runs commands with cwd `/`, and `bun` is not on the worker's spawn PATH;
   `env -C /work/broker /usr/local/bin/bun ...` is required. Reported, not worked
   around in product code.
4. `.broker-tmp/` (broker-side patch scratch, root-owned) and the pre-existing session
   `ses_*.bundle` appear as untracked worker files. They are NOT deliverables and must
   be excluded from the reviewed package.

## Workload / PR Boundary

- Mode: **stacked PR slices** (`stacked-to-main`, three reviewable work units in one
  shared worker because S17 makes the protected paths non-appliable, so a later worker
  could never see an earlier slice's files)
- Current work unit: all three slices implemented and verified in this session
- Boundary: starts from the untouched repository and ends at a reviewed package; no
  protected path is applied or committed
- Estimated review budget impact: authored additions are dominated by
  `opencode/plugins/reviewer-relay-transport.ts` (~1,100 lines) and
  `broker/tests/reviewer-relay-transport.test.ts` (~1,200 lines); the change is above
  the 800-line session budget as one unit, which is why it is delivered as three
  stacked work units. No comment, blank line, doc, or test was removed or compressed
  to fit the budget.

## S17 Landing Discipline

- Published candidate and verified in the worker; `sandbox_finish` produced the
  reviewed package. `sandbox_apply` was deliberately NOT run: the package contains
  `opencode/plugins/**` and `opencode/config-fragments/**`, which S17 rejects.
- What remains for the user: review the diff, install
  `opencode/plugins/reviewer-relay-transport.ts` to
  `~/.config/opencode/plugins/reviewer-relay-transport.ts`, manually merge the
  `agent` block from `opencode/config-fragments/reviewer-relay-agents.jsonc` into
  `~/.config/opencode/opencode.json`, restart secured OpenCode, and run ONE reviewer
  Task targeting `asi-review-risk`. Rollback removes those two installed entries and
  restores the prior loud `binding_invalid` refusal.
- No agent claims Gate 11, the reviewer Task, or any part of the manual gate as done.

## Bounded Defect Remediation — `reviewer-relay-frame-fix`

Post-verification static review found two framing defects in the landed relay core.
Only those two were fixed; no other behavior, schema, registry, or spawn discipline
changed.

### Defect 1 (critical) — multibyte UTF-8 split across stdout chunks

- Before: `onStdout` accumulated `chunk.toString("utf8")` per chunk, so a multibyte
  code point split across two chunks decoded to replacement characters and the
  forwarded frame was no longer verbatim.
- After: stdout is assembled as raw bytes (`Buffer.concat`) and a line is decoded
  only once the `0x0a` frame boundary is present (`buffered.indexOf(0x0a)` and
  `subarray(0, newline).toString("utf8")`). A partial trailing code point stays as
  bytes until its frame arrives; no code point is ever decoded twice or split.

### Defect 2 (warning) — a frame after the terminal result was ignored

- Before: the result frame set `closed = true`, and `onStdout` returned early on
  `closed`, so a frame delivered in a later data event was silently ignored. Only
  an extra frame buffered in the same callback hit the `resultSeen` refusal.
- After: the result frame no longer sets `closed`; it sets `resultSeen` and settles
  on one microtask so any frame emitted in the same synchronous stdout burst is
  inspected first. A complete post-result frame now reaches the existing
  `frameRefused("extra frame after the result frame")` branch in every data event
  while the relay is live. `onStderr`/`onError`/`onClose`/`onAbort` are guarded with
  `resultSeen` so a late child event cannot discard a result that was already framed.

### RED → GREEN (work unit `reviewer-relay-frame-fix`)

| Test | RED (observed failing) | GREEN |
|---|---|---|
| `preserves a multibyte code point split across two stdout chunks` | `expect(received).toBe(expected)` — the 😀 four-byte code point rendered as U+FFFD because it was split after its first byte | `materialized.prompt` equals the original body and its UTF-8 bytes; no U+FFFD |
| `refuses an extra frame delivered in a later stdout event after the result` | `error: expected a typed refusal but the call resolved` (the later frame was ignored after `closed`) | typed `reviewer_relay_frame_refused` refusal; child killed |

Focused RED run before the fix: `49 pass, 2 fail, 272 expect() calls, Ran 51 tests across 1 file. [50.00ms]`.

### Files changed (remediation)

| File | Action | What Was Done |
|------|--------|---------------|
| `opencode/plugins/reviewer-relay-transport.ts` | Modified | Byte-buffered stdout framing; the result frame settles on a microtask with `resultSeen` (not `closed`) so a later frame is a typed refusal; late child events guarded |
| `broker/tests/reviewer-relay-transport.test.ts` | Modified | `emitStdoutBytes` raw-chunk helper; two RED-first regression tests (split multibyte code point; post-result frame in a later data event) |

### Work unit evidence (`reviewer-relay-frame-fix`)

| Evidence | Value |
|---|---|
| Focused test command and exact result | `/usr/bin/env -C /work/broker /usr/local/bin/bun test tests/reviewer-relay-transport.test.ts` → `51 pass, 0 fail, 276 expect() calls, Ran 51 tests across 1 file. [50.00ms]` |
| Full suite and build | `/usr/bin/env -C /work/broker /usr/local/bin/bun test` → `401 pass, 0 fail, 1815 expect() calls, Ran 401 tests across 17 files. [357.00ms]`; `/usr/bin/env -C /work/broker /usr/local/bin/bun build src/main.ts --outdir /tmp/build-check` → `Bundled 24 modules in 31ms` / `main.js 1.15 MB (entry point)` |
| Runtime harness command/scenario and exact result | `N/A` for the real provider child (S17, not installed): the split-chunk and post-result-frame paths are driven through the injected transport-child fake emitting raw `Buffer` chunks. |
| Rollback boundary | Revert the stdout-assembly and result-branch hunks in `opencode/plugins/reviewer-relay-transport.ts` and remove the two tests plus `emitStdoutBytes` from `broker/tests/reviewer-relay-transport.test.ts`. No unrelated work is touched. |

### Apply outcome

- Operator authorization: S17 was temporarily disabled by the operator, who explicitly
  authorized `sandbox_apply` for this remediation; the fix lands with `sandbox_apply`
  at the end of this run.
- `.broker-tmp/` and `ses_*.bundle` remain untracked non-deliverables and are excluded
  from the applied result.
- Gate 11 and the manual install remain unclaimed and user-owned.

## Bounded Defect Remediation — `reviewer-relay-postresult-remediation`

Independent re-verification found that the previous remediation's microtask
admission still admitted the result while a further frame could legitimately
arrive. Only the post-result/terminal ordering and its test were changed; the
provider frame schema, the lifecycle registry, the disjoint hook scope, and the
spawn discipline are untouched.

### Defect (critical) — a frame in a genuinely later event-loop turn was swallowed

- Before: `onStdout` set `resultSeen` and settled `resultFrame` on a queued
  microtask (`queueMicrotask(() => resolveResult(admitted))`) while leaving
  `closed` unset. The existing regression test emitted the result and the extra
  frame in one synchronous burst, so the loop's `resultSeen` branch refused the
  extra frame before the microtask ran. In production the after-hook closed the
  relay as soon as `complete()` resolved, so a frame arriving in a genuinely
  later event-loop turn returned at `onStdout`'s `closed` guard and was silently
  dropped: the completion had already settled and could no longer refuse.
- After: the result frame no longer settles anything. It records the admitted
  output (`admittedResult`) and keeps the stdout reader, the extra-frame
  refusal, and the 600 s deadline live. Admission happens only in `onClose`,
  once the child has closed stdout (EOF), so no further frame can arrive. A
  complete frame in any earlier turn reaches the `extra frame after the result
  frame` refusal; a partial line left at EOF reaches the `partial frame after
  the result frame` refusal. The deadline is cleared on admission, not on the
  result frame, so the relay cannot hang.

### RED → GREEN (work unit `reviewer-relay-postresult-remediation`)

- RED (test changes only, before the plugin fix):
  `/usr/bin/env -C /work/broker /usr/local/bin/bun test tests/reviewer-relay-transport.test.ts`
  → `1 fail`, `51 pass`, `277 expect() calls`, `Ran 52 tests across 1 file. [94.00ms]`.
  The new test failed at `expect(settled).toBe(false)` with
  `Expected: false / Received: true` — the completion had already settled before
  the later frame arrived.
- GREEN (after the plugin fix): the same command →
  `52 pass, 0 fail, 279 expect() calls, Ran 52 tests across 1 file. [58.00ms]`.

### Files changed (remediation)

| File | Action | What Was Done |
|------|--------|---------------|
| `opencode/plugins/reviewer-relay-transport.ts` | Modified | The result frame records `admittedResult` without settling; `onClose` admits on stdout EOF, refuses a post-result partial frame, and clears the deadline only on admission |
| `broker/tests/reviewer-relay-transport.test.ts` | Modified | New RED-first regression test yielding a real event-loop turn (`setImmediate`) between the result and the extra frame; the fake/scripted children now close stdout after the result, and the completion tests await that EOF |

### Work unit evidence (`reviewer-relay-postresult-remediation`)

| Evidence | Value |
|---|---|
| Focused test command and exact result | `/usr/bin/env -C /work/broker /usr/local/bin/bun test tests/reviewer-relay-transport.test.ts` → `52 pass, 0 fail, 279 expect() calls, Ran 52 tests across 1 file. [58.00ms]` |
| Full suite and build | `/usr/bin/env -C /work/broker /usr/local/bin/bun test` → `402 pass, 0 fail, 1818 expect() calls, Ran 402 tests across 17 files. [335.00ms]`; `/usr/bin/env -C /work/broker /usr/local/bin/bun build src/main.ts` → the bundle was written to stdout on exit 0 and no build artifact was written into the repository |
| Runtime harness command/scenario and exact result | `N/A` for the real provider child (S17, not installed): the later-turn ordering is driven through the injected transport-child fake, which emits the result, yields a real event-loop turn, then emits a second complete frame that must reach the typed refusal |
| Rollback boundary | Revert the `admittedResult`/result-branch and `onClose` hunks in `opencode/plugins/reviewer-relay-transport.ts` and remove the new test plus the fake/scripted-child close changes from `broker/tests/reviewer-relay-transport.test.ts`. No unrelated work is touched. |

### Apply outcome (remediation)

- Operator authorization: S17 was temporarily disabled and the operator explicitly
  authorized `sandbox_apply` for this remediation; the fix lands with `sandbox_apply`
  in this run.
- `.broker-tmp/` and `ses_*.bundle` remain untracked non-deliverables and are excluded
  from the applied result.
- Gate 11 and the manual install remain unclaimed and user-owned.
