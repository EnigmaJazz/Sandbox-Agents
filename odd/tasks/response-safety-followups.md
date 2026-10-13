# Response-safety follow-ups

## Objective
Close the four non-blocking advisories left by the approved review lineage `review-e88a985fad223e87` (reviewed boundary `bf3c792`), which corrected the dispatch response-safety defects in `broker/src/server.ts`.

## Problem and context
That review approved the response-safety correction and recorded four advisories. A pre-code advisory then stress-tested the intended fixes and corrected two of them materially:

- **R4-001 (WARNING, pre-existing, `server.ts:494-498`).** `writeFinal` sets `finalWritten` only after `this.respond` returns, so a throw inside `respond` leaves the guard open and the outer catch writes a second envelope for the same id. Correct fix: set the flag before the write attempt and make the helper swallow a `respond` failure, so each request gets at most one final-response attempt. A `respond` that throws after queueing bytes cannot be un-sent; the invariant the broker can actually hold is at-most-one final envelope. Deeper replay tolerance belongs at the operation layer and is out of scope.
- **R4-002 (WARNING, introduced, `server.ts:558-568`).** In fail-loud mode `dispatchLine` resolves once a final is written instead of rejecting, so fail-loud downgrades to a log entry for that class. The pre-code advisory judged the behavior correct — after a final is accepted the protocol obligation is satisfied and rejecting would violate the same at-most-one invariant — but the branch is untested and undocumented.
- **R4-003 (SUGGESTION, introduced, four log sites).** Each log site swallows failures with an empty catch and no counter or fallback. The pre-code advisory found the intended fix incomplete: `broker/src/logging.ts` writes to a `createWriteStream` whose failures arrive asynchronously via an `'error'` event, which the synchronous catches never observe, so a disk-full error silently drops every later log line. The counter must live in `Logger` itself, be fed by both the synchronous catch and an `'error'` listener, be exposed through the existing `metrics` operation, and trigger a single guarded one-time `process.stderr` fallback.
- **R4-004 (SUGGESTION, worsened, `server.ts:456-465`).** The framer-failure path closes the socket first, which drops responses already queued for other requests on that socket. The pre-code advisory established that `end()` alone does not fix it either: Bun sockets do not buffer internally, so the broker's own `SocketWriteQueue` holds the unwritten bytes and `end()` flushes only what already reached `socket.write`. Correct teardown: mark the socket dead, drain the queue through a new terminal callback, then `end()`; consult the dead marker in `respond`, `safeRespond`, and the `drain` handler; use `close()` only when `end` is absent.

Also recorded while here: the project's `broker/tsconfig.json` sets `erasableSyntaxOnly` and `noImplicitOverride`, but neither can be enforced on this host because `tsc` cannot run without `@types/bun`/`@types/node`, so violations accumulate unseen across `broker/src/**` changes. AFT's cached TypeScript is the only partial signal and it lacks those type packages.

## Scope — three work units, one at a time
- **Unit A — dispatchLine finalization (R4-001, R4-002).** Fix the flag placement; add the missing fail-loud test; document the downgrade at the guard. Touch `broker/src/server.ts` and `broker/tests/session-agent-binding.test.ts`.
- **Unit B — framer terminal teardown (R4-004).** Dead-socket marker, queue drain before `end()`, dead-marker checks in the write paths, and the deferred fix where `respond` stores a `SocketWriteQueue` before a successful enqueue. Touch `broker/src/server.ts` and the test.
- **Unit C — logger resilience (R4-003) plus the tsconfig documentation note.** Counter and `'error'` listener in `Logger`, a metrics field, a one-time stderr fallback, and a `docs/TODO.md` line for the tsconfig enforcement gap. Touch `broker/src/logging.ts`, `broker/src/types.ts`, `broker/src/service.ts`, tests, and `docs/TODO.md`.

## Constraints
- Never auto-apply; `broker/src/**` is S17, so each unit is retained as a sandbox result for owner review and manual application.
- Keep tests, docs, and behavior in the same work unit; do not separate code from tests to hit a metric.
- No change to the safety-response shape, the `"0"` fallback semantics, the id-correlation behavior, the framer's id recovery, the allowlist rejection, the 128-character cap, or identity rights.
- The `Logger.log` signature and return type stay as they are; it must swallow internally.
- Fix the deferred `SocketWriteQueue` store-before-enqueue defect inside Unit B rather than leaving it.

## Tasks
- T1 — Unit A: flag placement in `writeFinal`, fail-loud test, design note. Checks: focused test then full suite; `bun build src/main.ts` from `broker`.
- T2 — Unit B: dead marker, `SocketWriteQueue.terminate`, drain-then-end, dead checks in `respond`/`safeRespond`/`drain`, queue-store fix; update the framer-failure test to expect `end` and add a second `onData` assertion. Same checks.
- T3 — Unit C: `Logger` counter plus `'error'` listener, metrics field, one-time stderr fallback, `docs/TODO.md` tsconfig line. Same checks.
- T4 — per-unit work-unit commit and native review against the last reviewed boundary.

## Acceptance criteria
- A `respond` that throws produces at most one attempted final envelope and does not produce a second envelope for the same id.
- The fail-loud-with-final-written branch is covered by a test and documented.
- A logger stream error increments an observable counter and triggers exactly one fallback write.
- A framer failure drains owed queued writes before the socket ends and ignores later `data` events.
- Full suite green and `bun build src/main.ts` completes for each unit.

## Checks
`sandbox_bash ["bun", "--cwd", "broker", "test", "--reporter=dot"]` and `sandbox_bash ["bun", "build", "src/main.ts"]` from the `broker` directory.

## Delivery strategy
`ask-on-risk`, inherited from the parent work. Three sequential work-unit commits, each well under the 400 authored-line and 100 KiB per-commit reviewability caps; Unit B is riskier than A because it changes socket lifecycle behavior.

## Route and trigger evidence
`route: delegated`; specialist `general` (sandbox writer); trigger: secure policy — every project mutation and execution is delegated, no inline mutation route exists. Record actual Task dispatch and result per unit before marking it complete.

## Outcomes

- **T1 — Unit A:** Completed in the prior work unit. Its full-suite baseline is recorded as **792 pass / 0 fail** in the handoff. Before Unit B edits, this worker observed the focused `session-agent-binding.test.ts` baseline: **39 pass / 0 fail**.
- **T2 — Unit B:** Added a per-socket dead marker, terminal queue callback, drain-before-end teardown, dead-socket checks, and the enqueue-before-map-store fix. TDD RED was observed on the focused file: **38 pass / 4 fail**; failures were the changed end-vs-close expectation, loss of the owed queue, second framer creation for late data, and stale queue installation after enqueue throws. GREEN focused result: **43 pass / 0 fail / 255 expect() calls**. Full suite: **796 pass / 0 fail / 3612 expect() calls / 50 files**. Build `bun build src/main.ts` from `broker`: completed successfully (exit 0).
- The existing framer-failure test intentionally changes its expectation: `end()` must be called and `close()` must not be called when `end` exists. An additional test proves `close()` remains the fallback when `end` is absent. The owed-write test asserts the response frame is written before `end`; the late-data test asserts no second framer creation or additional write; the queue-store test asserts a throwing first enqueue leaves no queue in `socketWrites`.
- **T3 — Unit C:** `Logger` now contains log failures, counts synchronous sink failures and asynchronous stream errors, marks failed streams dead, and writes one fixed, redacted stderr fallback. Metrics exposes `droppedLogLines`; `docs/TODO.md` names the missing `@types/bun`/`@types/node` host type-check dependencies. RED focused result: 0 pass / 4 fail, each failing for the missing behavior. GREEN focused result: 4 pass / 0 fail / 10 expect() calls; combined logging and session-binding result: 50 pass / 0 fail / 280 expect() calls. Full suite: 803 pass / 0 fail / 3637 expect() calls / 51 files. Build `bun build src/main.ts` from `broker`: succeeded (exit 0). The existing `session-agent-binding.test.ts` test “an ok logger failure cannot write a contradictory second response” covers the final-response-path logging throw: the request id receives one successful response only.

## R4-STALL-1 — bounded framer-failure teardown

- **R4-STALL-1 (WARNING, introduced by Unit B):** An owed response could keep a framer-failed socket open indefinitely if the peer never drained. Teardown now waits at most 5000 ms by default, then calls `close()` directly; a normal drain still ends gracefully. Tests inject a 20 ms deadline.
- The terminal action is once-guarded, and the queue accepts only its first `terminate` callback. Timeout handles are unref'd and cleared when either terminal path wins. Main and advisor drain handlers share one dead-socket guard helper.
- **R4-DISCARD-2 (known boundary, unchanged):** A socket write failure discards all pending frames on that connection. This pre-existing behavior remains out of scope.

## R4-stdout-sink-coupling — stdout sink independence

- **R4-stdout-sink-coupling (WARNING, introduced by Unit C):** `Logger` now attaches one shared `process.stdout` error listener for active console loggers, latches stdout failures, attempts the file sink before stdout, and isolates each sink so one failure cannot skip the other. Both already-dead sinks count one dropped log line, not two.
- The file path is retained as a private readonly field. Reopening a dead file stream or stdout sink is not implemented; the broker must restart to reopen either dead sink. This is the current, intentional recovery boundary.
- TDD RED: focused logging tests reported **4 pass / 2 fail / 13 expect() calls**. The synchronous case repeated the failed stdout write and counted both lines as dropped; the asynchronous event threw because no stdout error listener existed.
- TDD GREEN: focused logging tests reported **6 pass / 0 fail / 18 expect() calls**. The sync regression test verifies one stdout write attempt and both durable JSONL records; the async test emits `process.stdout`'s `error` event and verifies the counter, latch, and fixed fallback.
- Full-suite baseline observed before edits: **803 pass / 0 fail / 3637 expect() calls / 51 files**. Final full suite: **805 pass / 0 fail / 3645 expect() calls / 51 files**. `bun build src/main.ts` from `broker` succeeded.

## R4-STALL-2 — forced-close visibility and deterministic deadline tests

- Added a structured `connection` record after the forced `socket.close()` in the `forceCloseSocket` once-guard callback. It contains only `operation`, `result`, and fixed `detail`; no request/session envelope fields or error are emitted.
- Added a production-default test that captures the actual scheduled callback and timer handle without waiting for five seconds, verifies the 5000 ms delay and `unref()`, then invokes that same callback and checks one socket close plus the exact log record.
- Converted both injected-deadline timing tests to Bun's Jest-compatible fake timers. They assert the deadline has not fired before 20 ms, then fires at 20 ms; and that draining before 20 ms ends once and suppresses the later forced close. `jest.useRealTimers()` runs in each `finally`. Fake timers worked; no spy fallback was needed.
- Focused TDD RED: **46 pass / 1 fail / 278 expect() calls**; the new production-default test failed because the forced-close log record was absent. Focused GREEN: **47 pass / 0 fail / 278 expect() calls**.
- Full-suite baseline observed before edits: **805 pass / 0 fail / 3645 expect() calls / 51 files**. Final full suite: **806 pass / 0 fail / 3653 expect() calls / 51 files**. `bun build src/main.ts` from `broker` succeeded (exit 0).
- The log call is after `socket.close()` inside the once-guard callback. The production-default test proves the captured timer is scheduled at 5000 ms, `unref()` is called, and the exact captured callback performs the one-time close and record emission.

## R4-STALL-3 — timer-safe forced-close logging

- The forced-close log now has its own silent `try/catch`, so a logger exception cannot escape the deadline timer callback; the socket-close catch remains limited to close failures.
- The production-default test captures all timers and identifies the deadline by its 5000 ms delay, asserts exactly one timer has that delay and that timer's `unref()` call, then verifies one close across two invocations.
- The throwing-logger regression test holds an owed response, triggers framer failure, and verifies invoking the deadline callback does not throw and still closes the socket.
- Out of scope: `BrokerServer.startReaper()` passes an unguarded `this.logger.log` callback through `reaper.ts` to `setInterval`; this is the same class of timer-callback exposure and is recorded for separate follow-up.
- Focused TDD RED: **47 pass / 1 fail / 280 expect() calls**; the throwing-logger test failed because `timer log failed` escaped the deadline callback. GREEN: **48 pass / 0 fail / 281 expect() calls**.
- Full-suite baseline observed before edits: **806 pass / 0 fail / 3653 expect() calls / 51 files**. Final suite: **807 pass / 0 fail / 3656 expect() calls / 51 files**. `bun build src/main.ts` from `broker` succeeded (exit 0).

## R4-REAPER-LOG — exception-safe reaper telemetry and dropped-log accounting

- Guarded every reaper `onLog` invocation through `safeLog`; the helper catches callback throws so sweep work and cleanup continue. The startup artifact pass uses the same protected logging path, and interval sweeps use it for all three phases.
- Strengthened `Logger.log` with a method-level catch that accounts for an otherwise escaping failure once through `markDropped()`. The once guard prevents retry/recursion, while the existing one-time stderr fallback implementation remains unchanged.
- TDD RED: focused reaper tests first reported **8 pass / 2 fail / 50 expect() calls**; direct sweeps rejected on a throwing logger and interval execution did not release the stale worker. After adding the Logger regression, RED reported **10 pass / 1 fail / 53 expect() calls**; the logger accounting failure escaped `Logger.log`.
- TDD GREEN: focused reaper tests reported **11 pass / 0 fail / 55 expect() calls**. Coverage verifies a throwing callback does not prevent later sweep phases, fake-timer interval work completes without an escaped callback error, and a dropped-line accounting throw does not escape or count twice.
- Full-suite baseline observed before edits: **807 pass / 0 fail / 3656 expect() calls / 51 files**. Final full suite: **810 pass / 0 fail / 3663 expect() calls / 51 files**. `bun build src/main.ts` from `broker` succeeded (exit 0).
- `server.ts`, reaper schedule/intervals, forced-close record fields, teardown ordering, and `MetricsRecord` fields were unchanged. `broker/src/**` remains S17; retain the sandbox result for owner review and manual application.

## Next step
Owner review and manual application; `broker/src/**` remains S17.

## R4-REAPER-DROP — separate reaper telemetry-drop accounting

- Added `ReaperOptions.onDrop`; every reaper `safeLog` path receives it explicitly through helper parameters, including artifact removal/error helpers, startup artifact sweep, interval phases, idle/unfinished sweeps, and disconnect reap; both server entry points supply the same Logger hook. The hook is guarded separately so accounting failure cannot interrupt cleanup.
- `Logger.noteReaperTelemetryDrop()` increments a separate monotonic counter without calling `markDropped()` or writing its stderr fallback. The metrics record exposes `droppedReaperTelemetryEvents` independently of `droppedLogLines`; the server supplies the hook.
- The focused counter test directly awaits `sweepIdle` with a throwing consumer and verifies one reaper-drop increment and zero dropped log lines. It has no interval/timer dependency. The fake-timer interval test now uses a bounded microtask poll (20 iterations) for the worker-stop marker instead of two fixed microtask ticks.
- Typed-consumer check: `MetricsRecord` is constructed in `broker/src/service.ts`; `cli/sandboxctl` uses a partial typed metrics shape that does not enumerate the new field, and its `metrics` command uses `Record<string, unknown>`. No typed consumer required edits. Service returns `0` for legacy logger test doubles lacking the new getter.
- Full-suite baseline observed before edits: **810 pass / 0 fail / 3663 expect() calls / 51 files**. Focused TDD RED: **11 pass / 1 fail / 56 expect() calls**; failure was the missing reaper-drop counter (`undefined`, expected `1`). Focused GREEN: **12 pass / 0 fail / 57 expect() calls**. Final full suite: **811 pass / 0 fail / 3665 expect() calls / 51 files**. `bun build src/main.ts` from `broker` completed successfully (exit 0).
- Reaper schedules, intervals, cleanup/release behavior, `ReaperHandle`, and existing dropped-line accounting/fallback are unchanged. This is retained for owner review; do not auto-apply because `broker/src/**` is S17.

## R4-REAPER-DROP-POLL-DIAG

- Added a bounded-poll exhaustion assertion before the exact worker-stop marker assertion; the loop condition, yield, and 20-iteration cap are unchanged.
- Baseline full suite: 811 pass / 0 fail / 3665 expect() calls / 51 files. Focused reaper suite: 12 pass / 0 fail / 58 expect() calls; final full suite: 811 pass / 0 fail / 3666 expect() calls / 51 files.
