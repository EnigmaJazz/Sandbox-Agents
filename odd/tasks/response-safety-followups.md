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

## Next step
Unit A (T1).
