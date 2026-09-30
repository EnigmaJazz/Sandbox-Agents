# Broker frame resynchronization

## Objective

One response that never completes must not break a session: the client must resynchronise its framing after a timeout, a short or failed write must be visible rather than swallowed, and the next occurrence must name its own cause.

## Problem — observed evidence

- After the previous change (`df90b54`, which made the client's silent drop paths fail loudly), the user reports that a large-file `readFile` still times out, and that once a large file has timed out in a session, smaller files also start failing.
- This poisoning is the signature of a line framer retaining a partial frame: the large response never completes, so the caller waits out its 30 s timeout; retained bytes are then prepended to every later response, and the next newline terminates a corrupted composite, so smaller reads fail too.
- The previous fix was necessary but insufficient: it made *unparseable* frames visible, but a frame that never *completes* produces no parse failure, so nothing was caught and the caller still timed out.
- Broker-side operation evidence is healthy (`readFile ok` in 18 ms), and `respond` writes `JSON.stringify(resp) + "\\n"` in one call, which is structurally correct framing. The cause of the incomplete frame is **not established**.

## Not established

Why the large frame never completes is unknown. A partial write, a capped write, and a lost tail are all consistent with the evidence. Do not assert any of them as the cause. Bun buffers internally, so backpressure is a candidate, not a proven cause. The residual-`rx` diagnostic exists to distinguish a large residual (frame truncated in transit / send-side evidence) from an empty or tiny residual (nothing arrived / response was never written); neither observation alone should be overstated as proof of the underlying cause.

## Scope

Authorized files: `opencode/plugins/lib/broker-client.ts`, `broker/src/server.ts`, and their tests.

Three authorized items:

1. **T1 — Client resync:** on request timeout, discard the retained partial frame so the connection resynchronises and later responses parse. Decision: clear the residual buffer only; do not fail other pending requests, because their complete newline-delimited responses remain independently parseable. Preserve the reconnect behaviour described at `broker-client.ts:86-90`.
2. **T2 — Write/backpressure visibility:** in `broker/src/server.ts` `respond` (`:456-460`), the catch currently swallows a write error (comment: “socket already closed”), and `SocketLike.write` is declared `(data: string): void` (`:98`), discarding the returned byte count and handling no drain. Make a short or failed write visible rather than silent. Treat backpressure as a candidate, not a proven cause.
3. **T3 — Residual-`rx` diagnostic:** on timeout, log the retained buffer's byte length and a bounded, sanitized prefix. Ensure the prefix cannot expose response contents, credentials, or other secrets; use only safe framing/diagnostic characters or equivalent redaction. This evidence should distinguish large residual from empty/tiny residual without claiming more than it establishes.

Do not change the request-side cap (`MAX_LINE_BYTES`, `server.ts:93/224`), read paths' by-design semantics, or the reconnect behaviour described at `broker-client.ts:86-90`.

## Constraints

- Keep the change within the authorized files and their tests.
- Do not commit, push, create a PR, merge, or release under this tracker.
- Do not claim the send-side cause is known; short/partial write, capped write, and lost tail remain hypotheses until measured.

## Stable task IDs

- **T1** — client resync after request timeout.
- **T2** — write/backpressure visibility.
- **T3** — residual-`rx` timeout diagnostic.
- **T4** — checks and the reviewability receipt.

## Acceptance criteria

- A response that never completes leaves the connection usable: a subsequent normal response on the same client resolves.
- A short or failed write is visible rather than swallowed.
- A timeout reports the residual buffer length and a bounded, sanitized prefix that contains no secrets.
- The suite is green.
- The build succeeds.

## Authorized scope

`opencode/plugins/lib/broker-client.ts`, `broker/src/server.ts`, and their tests. No other paths. Not authorized by this tracker: commit, push, PR, merge, or release.

## Checks

- `bun --cwd broker test` — record exact totals; committed baseline is **559 pass, 0 fail**.
- `bun build broker/src/main.ts --outfile <outside the repository>`.
- Verification must **EXECUTE** what it validates: reproduce the poisoning with a never-completing frame followed by a normal response on the same client, and observe that the second response resolves. Build or parse checks alone do not prove runtime behavior.

## Delivery strategy

Forecast: approximately **250 authored changed lines** (additions plus deletions, excluding generated files) across the scoped client, server, and tests; revise against the implementation diff before delivery. Chosen strategy: **single-pr**, because the client resync, server write reporting, diagnostic, and their regression checks form one bounded end-to-end work unit. This tracker does not authorize commit, push, PR, merge, or release.

## Progress

T1–T4 not started.

## Route and trigger evidence

- `route: delegated`.
- Specialist: `general` (sandbox writer, per the user's coding-model decision: “Linked directly to OpenCode”).
- Trigger: the two-or-more-non-trivial-files writer trigger.

## Next step

Implement T1–T4 as one bounded change, then return the reviewability receipt.
