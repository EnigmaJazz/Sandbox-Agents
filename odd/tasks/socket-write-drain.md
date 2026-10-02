# Broker socket write drain and complete-file integrity

## Objective

A large broker/plugin message must survive the round trip in both directions, and no partially-read file must ever be returned or written back.

## Problem — observed evidence

- The broker and plugin exchange one JSON line per message over a Unix socket. The user's in-memory experiment established that a single message larger than about 219 KB is cut off; the receiver never sees the closing newline and waits out its timeout.
- Broker logs for the last 7 days show all 871 `readFile` calls completed; the slowest took 0.86s. The time is lost after the broker has sent its reply.
- `broker/src/server.ts:459` calls `socket.write(data)` once. An in-memory Bun 1.3.14 test on an abstract Unix socket (no files written) measured 100 KB → 100 KB, 200 KB → 200 KB, 300 KB → 219 KB, and 600 KB → 219 KB. The observed ceiling matches the kernel's default socket send buffer (`net.core.wmem_default = 212992`). The experiment indicates that Bun sends what fits and drops the rest unless the sender handles `drain` and resends it. Nothing in `broker/src` or the plugins handles `drain`.
- `broker-client.ts:127` processes a reply only after seeing `\n`; when the newline is in the dropped tail, the plugin waits. `readFile` has no `OPERATION_TIMEOUT_MS` entry and uses the 30 s default.
- The approximate 4,700-line threshold follows from the encoded reply size: JSON escaping adds bytes for quotes, backslashes, tabs, and newlines; at roughly 45 bytes/line plus escaping, the reply exceeds 219 KB.
- `sandbox_edit` reads a complete file via `readFile`, then sends the whole edited file back via `writeFile` (`opencode/plugins/sandbox-tools.ts:291-305`). The plugin's `socket?.write(...)` at `broker-client.ts:257` also ignores the number of bytes sent.
- Related silent-truncation defect: `spawnArgv` (`broker/src/msb.ts:70`) stops retaining output after 512 KB (`outputMaxBytes`) without flagging it. The `writeFile` limit (`contentMaxBytes`) is 1 MB, so the limits do not match. After socket delivery is fixed, `readFile` on a larger file could return partial content and `sandbox_edit` could write that partial content back.
- Related line-ending defect: `MsbAdapter.run` converts every CRLF to LF in all output, including `cat`; a `sandbox_edit` on a CRLF file can therefore rewrite every line.
- A cut-off reply can leave the connection out of step if its tail arrives after the client has cleared its buffer.

## Not yet observed

The short-write warning added in `7be0d07` has logged nothing since the broker restarted at 21:59; no large read has occurred since, so the log has not confirmed the mechanism. The abstract-socket experiment reproduces the cutoff, but that runtime experiment is not a broker/plugin end-to-end test. The earlier statement that “Bun buffers internally” is false and must be corrected in both its source comment and `odd/tasks/broker-frame-resync.md`; T4 owns that correction.

## Scope

Authorized files: `broker/src/**`, `broker/tests/**`, `opencode/plugins/**` and their tests, and this tracker at `odd/tasks/socket-write-drain.md`. The broker/plugin paths are S17 and must be preserved for manual user installation; this tracker does not authorize installation.

Six stable work items:

1. **T1 — Server write queue + drain** (`broker/src/server.ts`): give each connection an outgoing queue; `respond()` appends and sends what the socket accepts; a `drain` handler sends the remainder. The queue must prevent a second reply from interleaving into a partially-sent one.
2. **T2 — Plugin write queue + drain** (`opencode/plugins/lib/broker-client.ts`): queue outgoing messages and add a `drain` handler in `Bun.connect`. This fixes large `sandbox_write`, `sandbox_edit`, and `sandbox_apply_patch` requests. Decide and record whether each request timeout starts only after the full request is sent, or the current timeout remains and a half-sent request fails cleanly.
3. **T3 — Refuse partial reads**: add a `truncated` flag to `SpawnResult`; make `buildReadFileOp` return an error when set; skip CRLF conversion for `readFile`; decide and record how the 512 KB read limit and 1 MB write limit relate.
4. **T4 — Review-driven fixes** (from the advisory review of `1407a78..HEAD`): narrow timeout `rx` clearing so it cannot destroy another request's partially received response—extract the partial frame ID and clear only when it matches the timed-out request or the buffer is empty; close the socket on a failed response write so the client promptly fails pending callers with `unavailable`; on a queued hold, re-arm a bounded deadline instead of clearing the client's only timer; clean up the worker-side write temp on a mid-flow failure; correct the false “Bun buffers internally” comment and tracker note.
5. **T5 — Optional `editFile` operation**: optionally have `sandbox_edit` send only `oldString`/`newString` rather than the whole file in both directions, making edits independent of file size. Record whether this is implemented or deferred and why.
6. **T6 — Checks and reviewability receipt**: execute the required checks and produce the reviewability receipt.

## Constraints

- Keep all implementation and test changes within the authorized scope above. Do not implement any part under this tracker-only assignment.
- `broker/src/**` and `opencode/plugins/**` are S17: preserve them for manual user installation.
- Use argv vectors only; no shell-string spawning.
- Preserve existing reconnect behavior and request-side `MAX_LINE_BYTES` cap.
- Do not weaken any containment or path-validation check.
- Do not commit, push, create a PR, merge, or release.

## Acceptance criteria

- 300 KB and 600 KB replies each arrive whole and in order.
- A 300 KB `writeFile` request succeeds.
- `readFile` refuses a cut-off result instead of returning a partial file.
- `readFile` does not alter line endings.
- A large `readFile` and `sandbox_edit` on the 4,700-line script both succeed with the byte count unchanged.
- The suite is green and the build succeeds.

## Authorized scope

`broker/src/**`, `broker/tests/**`, `opencode/plugins/**` and their tests, and `odd/tasks/socket-write-drain.md`. No other paths. Not authorized: install, commit, push, PR, merge, or release.

## Checks

- `bun --cwd broker test` — record exact totals; committed baseline is **564 pass, 0 fail**.
- `bun build broker/src/main.ts --outfile <outside the repository>` — the output must be outside the repository.
- Verification must **EXECUTE** what it validates: a fake socket accepting partial writes and then triggering `drain`; a real abstract Unix socket carrying 300 KB and 600 KB replies; the plugin sending a 300 KB `writeFile`; and `readFile` refusing a truncated result.
- State plainly anything that cannot be exercised until the plugin is installed on the host. Do not represent a build or parse check as runtime verification.

## Delivery strategy

Forecast: this work exceeds the 400-authored-line per-commit cap. Chosen strategy: **auto-chain**, split into independently coherent slices; the socket queues are prerequisite to the large-payload and file-integrity work. Reforecast each slice against its implementation diff and keep each candidate within the cap without shrinking correct code.

- **Slice 1 — T1 + T2 socket queues and drain handling:** forecast approximately 200–350 authored changed lines, including focused tests. This is the prerequisite and can be verified independently with the fake socket, abstract Unix socket, and 300 KB plugin `writeFile` execution checks.
- **Slice 2 — T3 complete-file and line-ending integrity:** forecast approximately 100–200 authored changed lines, including regression tests for truncation refusal and CRLF preservation.
- **Slice 3 — T4 review-driven hardening:** forecast approximately 150–250 authored changed lines, including timeout matching, failed-write socket closure, bounded queued-hold deadline, temp cleanup, and correction of the false buffering comment and this tracker's earlier note.
- **Slice 4 — T5 optional edit operation and T6 final verification/receipt:** forecast approximately 100–250 authored changed lines if T5 is implemented; if T5 is deferred, record the reason and forecast only the checks/receipt work. Reassess whether T5 fits as an independently reviewable slice before implementation.

No commit or delivery action is authorized by this tracker. Each authored slice must respect the per-commit cap; the strategy is a forecast, not permission to split or omit required behavior to fit.

## Progress

Reconciled 2026-10-02. All tasks are closed. This record had stayed untracked; the work was delivered in these commits:

- **T1 + T2 — done in `81c78cc`.** Server and client write queues with `drain`, FIFO with no interleaving, a failed write closes the socket, and a request's timeout starts once its frame is fully sent. Live-verified after the broker restart on 2026-10-01: `sandbox_read` on a ~4,800-line file completes.
- **T3 — done in `374e347`.** readFile checks the target is a regular file within `contentMaxBytes` (the write limit, which settles the 512 KB / 1 MB question). It reads as base64, so CRLF and a BOM survive, refuses a decoded-length mismatch, and refuses non-UTF-8 content.
- **T4 — done across `81c78cc`, `74f280a` and `dd0f1af`.**
  - **Socket closes on a failed response write**, and the false "Bun buffers internally" comment is corrected: `81c78cc`.
  - **The worker-side write temp is cleaned up on a mid-flow failure:** `74f280a`. writeFile's `finally` removes both of its temps.
  - **Timeout clearing is narrowed**, discarding only when the frame-start id is the timed-out request's: `dd0f1af`.
  - **A queued hold re-arms one bounded deadline:** `dd0f1af`.
- **T5 — deferred.** `sandbox_edit` already sends only `oldString`/`newString` from the agent; the plugin reads and writes the whole file through the broker. After `81c78cc`, `374e347` and `9c44aa9` (per-line request cap sized for escaped payloads), that works for any file up to `contentMaxBytes`. A broker-side `editFile` would only save transport bytes. Revisit if files near 1 MiB become common.
- **T6 — done per commit.** `cd broker && bun test` stayed green at every commit (most recently 630 pass, 0 fail at `cb29902`), and `bun build src/main.ts` succeeded each time.

## Route and trigger evidence

- `route: delegated`.
- Specialist: `general` (sandbox writer).
- Trigger: the two-or-more-non-trivial-files writer trigger.

## Next step

None. Closed. The remaining related work is in `docs/TODO.md`: Tier 2 item 13 (done in `9c44aa9`), and the Tier 3/4 broker items.
