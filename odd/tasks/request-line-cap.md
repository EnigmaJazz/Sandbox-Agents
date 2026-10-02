# Request-line cap and client receive fixes

## Objective

Large but valid broker requests must succeed, and an oversize request must fail on its own
without disconnecting every session. A client timeout must never corrupt another request's
reply. This covers `docs/TODO.md` Tier 2 item 13, plus the remaining client-side T4 items of
`odd/tasks/socket-write-drain.md`.

## Problem (verified 2026-10-02)

- `broker/src/server.ts` sets `MAX_LINE_BYTES = 1 MiB`. `onData` checks the whole accumulated
  buffer and, when it overflows, answers `id: "0"` and closes the socket. Meanwhile
  `contentMaxBytes` is 1 MiB of content (before JSON escaping) and `patchMaxBytes` is 4 MiB, so
  a 0.7–1 MiB write or any patch over 1 MiB drops the connection that all plugin sessions share.
- `assertContent` accepts any string, so worst-case JSON escaping is 6× (`\u0000`).
- `opencode/plugins/lib/broker-client.ts` clears the whole receive buffer when any request times
  out. That can destroy a different request's partly received reply. A queued-hold progress
  frame clears the request's only timer and sets no new deadline.

## Tasks

- [x] **T1 — Server request framing.**
  - An exported `RequestLineFramer` caps each request line at the largest allowed payload
    (`contentMaxBytes`, `patchMaxBytes`, review input) × 6 for escaping, plus a 64 KiB envelope
    allowance.
  - An oversize line is discarded up to its newline and answered with a typed `protocol` error
    under the request id recovered from the line's start. The socket stays open.
  - Several pipelined lines never add up against one cap.
- [x] **T2 — Client receive fixes.**
  - On a timeout, clear the receive buffer only when its partial frame belongs to the request
    that timed out.
  - A queued-hold frame re-arms a bounded deadline (the broker queue timeout plus margin)
    instead of leaving the request with no timer.

## Acceptance criteria

- A 1 MiB-content write and a 4 MiB patch, JSON-escaped, pass the framer.
- An oversize request gets an error under its own id, and another request on the same
  connection still completes.
- A timeout leaves a neighbouring request's partial reply intact, and that reply still resolves.
- A queued request whose real reply never arrives fails at its bounded deadline.
- `cd broker && bun test` green; `bun build src/main.ts` succeeds.

## Constraints

- `broker/src/**` and `opencode/plugins/**` are S17: the user reviews and installs.
- Dependency-free; argv only; no weakening of request validation.
- `docs/TODO.md` is being edited by a delegated agent (gentle-ai 4 steps 3–5). Update it only
  after that agent's commits land.

## Route and delivery

- Route: direct inline (Claude Code orchestrator).
- One work-unit commit per task on `feat/review-and-state-hardening`; no push.
- Tests are written first and shown failing.

## Progress

Started 2026-10-02.

- **T1 done.** `broker/src/server.ts`:
  - `maxRequestLineBytes()` = the largest of `contentMaxBytes`, `patchMaxBytes` and `REVIEW_INPUT_MAX_BYTES`, × 6, + 64 KiB. That's 24 MiB + 64 KiB with defaults. It's a ceiling, not an allocation.
  - The exported `RequestLineFramer` caps each line, discards an oversize one up to its newline, and recovers its id from the first 512 bytes.
  - `onData` answers an oversize request with a `protocol` error under that id, and no longer closes the socket.
  - Tests: 8 new in `broker/tests/request-line-framer.test.ts`: sizing, framer behaviour, and an end-to-end run against a real `BrokerServer` over a raw socket. They failed before implementation (exports missing).
  - Old behaviour, shown against the committed `server.ts`: a 1.2 MiB request made both it and a concurrent normal request fail with "broker socket closed".
  - The end-to-end test uses a raw socket client because `sandbox-edit-tool-activation.test.ts` module-mocks `broker-client.ts`, and that mock leaks across files.
  - Checks: `bun test` passed 613, 0 fail; `bun build src/main.ts` succeeded.
  - Committed as `9c44aa9`.
- **T2 done.** `opencode/plugins/lib/broker-client.ts`:
  - **Timeouts:** a timeout discards the partial reply only when its frame id (read from the frame start) is the timed-out request's. Otherwise the partial reply is kept and completes. I first tried "never clear", but the existing test `broker-client.test.ts` ("discards a timed-out partial response…") showed it breaks the never-completing truncated-frame case, so the id match is required.
  - **Queued holds:** the first queued notice replaces the deadline once with `queuedHoldTimeoutMs` (default 600 s, the broker's queue timeout) plus the operation timeout. Later notices never extend it.
  - **Anchored id recovery:** malformed-frame recovery now reads an id only from the frame start (`{"version":1,"id":…`), so a fragment that merely contains an id can't fail that caller.
  - **Redacted logging:** discarded-frame logs are structure-only, so no content leaks.
  - Tests: 5 new in `broker/tests/broker-client-receive.test.ts`, which imports the client with a query suffix so the module mock in `sandbox-edit-tool-activation.test.ts` can't leak in. Three failed before the change (neighbour reply lost; both queued holds hung), then passed. The anchoring test was added with the change.
  - Checks: `bun test` passed 618, 0 fail. The plugin and broker builds both succeed.

## Next step

Both tasks are done. `docs/TODO.md` Tier 2 item 13 and `odd/tasks/socket-write-drain.md` (T4 client items) are updated after the delegated gentle-ai 4 docs work lands, to avoid editing the TODO concurrently. The user installs the broker restart and the plugin (S17).
