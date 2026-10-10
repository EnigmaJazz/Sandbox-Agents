# Broker socket lifecycle — recover stale sockets, refuse live ones, unlink on shutdown

## Objective
Make the broker's Unix socket binding survive an unclean process death: recover a socket
file left behind by a crashed or suspended broker, refuse to steal a socket owned by a
live broker, and remove socket files on clean shutdown.

## Problem (observed 2026-10-10)
The broker production journal shows a crash-loop repeated until the systemd restart
counter reached 62:

    Failed to listen at /run/user/1000/opencode-sandbox-broker.sock
    syscall: "listen", errno: 98, code: "EADDRINUSE"
        at start (broker/src/server.ts:371:32)

An unclean stop (machine suspend) left the socket file on disk. `start()` never removes
an existing socket before `Bun.listen`, so every subsequent start fails identically and
the broker can never come up again without manual deletion of the file.

## Scope
- `broker/src/server.ts` — `start()` (~:367-398), `startAdvisorListeners()` (~:404-436),
  `shutdown()` (~:462-476).
- `broker/src/main.ts` — the `await server.start()` call site (~:215) and its failure path.
- New test file `broker/tests/server-socket-lifecycle.test.ts`.
- This tracker.

## Constraints
- Do NOT change the socket mode (0600), the parent directory mode (0700), the listener
  callbacks, the serve/dispatch behavior, the systemd unit (S17 protected, later-gate
  artifact), or the advisor bind/teardown semantics beyond stale-socket handling.
- `broker/src/**` is S17: expect the sandbox apply to be refused and the result retained
  for owner review.
- Fail closed on every ambiguous probe outcome. A wrong "stale" verdict could delete a
  live broker's socket.

## Tasks (stable IDs)

### T1 — Stale-socket recovery with a fail-closed probe
Add a helper that, given a socket path: returns immediately when the path does not exist;
refuses when the path exists but is not a socket; probes by connecting; treats
`ECONNREFUSED` and `ENOENT` as stale; treats a successful connect as a live broker; and
fails closed on every other error (`EACCES`, `EAGAIN`, timeouts, unknown). On stale, it
unlinks and returns. On live, it throws a distinguishable error (for example
`SocketInUseError` with a stable code) carrying the path.

### T2 — Apply the recovery to the main socket
Call the T1 helper in `start()` immediately before `Bun.listen`, after the parent
directory is created, so a surviving socket file no longer produces `EADDRINUSE`.

### T3 — Apply the recovery to advisor sockets
Call the same T1 helper in `startAdvisorListeners()` for each advisor socket path before
its `Bun.listen`. The advisor bind uses `advisorSocketPath(this.config.socketPath,
projectId)` from `broker/src/advisor-socket.ts`. Advisor projects are opt-in, so this
path is not currently exercised in production, but the defect class is identical.

### T4 — Unlink sockets on clean shutdown
Extend `shutdown()` so it removes the main socket file and every advisor socket file it
created, after stopping the listeners. Each unlink is individually guarded so a failure
to remove one file cannot prevent the rest of shutdown.

### T5 — Live-broker refusal must not restart-storm
`systemd-user/sandbox-broker.service` uses `Restart=on-failure` with a 5 s delay, so a
non-zero exit on the live-broker case would loop forever. `main.ts` must catch the T1
error specifically, log a clear message naming the socket path, and exit with status 0 so
systemd does not restart. Every other startup error keeps its current non-zero behavior.

### T6 — Tests
- A stale main socket file with no listener is recovered: `start()` succeeds, the socket
  is present afterwards, and its mode is 0600.
- A live broker's socket is not stolen: a second server on the same path fails to start
  and the first keeps working.
- `shutdown()` removes both the main socket file and advisor socket files.
- An existing path that is not a socket is refused without deleting it.
Tests must use a temp directory and must never touch the real `/run/user/1000` path.

## Acceptance criteria
- Reproducing today's condition (actual socket file present, no listener) makes `start()`
  succeed instead of throwing `EADDRINUSE`.
- A live broker is never unlinked and never has its socket replaced.
- Every ambiguous probe outcome fails closed rather than unlinking.
- Clean shutdown leaves no socket files behind.
- The live-broker refusal exits 0 so systemd does not restart the service.

## Checks
- Focused new test file, then the full broker suite, with the exact summary and the
  observed baseline.
- `bun build src/main.ts` from `broker`.
- Genuine RED before the fix where the test reproduces `EADDRINUSE`.

## Delivery strategy
ask-on-risk (default). Forecast: one coherent socket-lifecycle unit, well under the
400-line budget. No chained PR slice is expected.

## Route and trigger evidence
- Route: authorized ODD change, delegated to a sandbox writer; `broker/src/**` is S17 so
  the apply is expected to be refused and the result retained for owner review.
- Trigger: user selected this as the next unit after the 2026-10-10 broker outage.
- Pre-code advisory completed before implementation; it corrected four gaps: the systemd
  restart storm on the live-broker case, the identical advisor-socket defect, the missing
  unlink on clean shutdown, and the need for an explicit probe-error taxonomy with
  fail-closed defaults. It also confirmed a bare unlink before listen is wrong (it would
  let a second broker steal a healthy broker's socket), that a successful connect proves
  liveness without any protocol handshake, and that a small TOCTOU window between probe
  and listen is an accepted residual rather than a solved problem.
- Residual risk to state in the record: the probe is not atomic. Keeping the gap between
  the stale verdict and `Bun.listen` free of awaits bounds it, but a concurrent manual
  start could still race.

## Progress
- [x] T1 — Added a fail-closed Unix-socket probe; only `ECONNREFUSED` and `ENOENT` allow stale-path removal. Live listeners throw `SocketInUseError` (`SOCKET_IN_USE`).
- [x] T2 — Main socket recovery runs after parent-directory creation and immediately before `Bun.listen`.
- [x] T3 — Advisor socket recovery uses `advisorSocketPath(...)` immediately before each advisor `Bun.listen`.
- [x] T4 — Shutdown stops listeners, then individually attempts to unlink only sockets this server actually bound (so shutdown after a refused second start cannot remove the live server's path).
- [x] T5 — `main.ts` catches `SocketInUseError`, reports the path and exits 0; other startup failures are rethrown.
- [x] T6 — Added temp-directory tests for stale recovery/mode, live-listener safety, shutdown unlinking and non-socket refusal.
- [x] R3-socket-probe-timeout — Bounded the liveness probe to 2,000 ms; timeout fails closed without unlinking and reports `probe-timeout`.

## Evidence
- Baseline observed before edits: `811 pass`, `0 fail`, `3666 expect() calls`, `Ran 811 tests across 51 files. [4.93s]`.
- Genuine RED before production changes: stale socket start failed with `syscall: "listen"`, `errno: 98`, `code: "EADDRINUSE"` at `start`; the live-listener and non-socket cases also failed their expected differentiated errors.
- Focused GREEN after final shutdown-safety assertion: `4 pass`, `0 fail`, `13 expect() calls`, `Ran 4 tests across 1 file. [45.00ms]`.
- Full suite after final edits: `815 pass`, `0 fail`, `3679 expect() calls`, `Ran 815 tests across 52 files. [4.69s]`.
- A supplementary regression check caught and then verified the shutdown fix: `shutdown()` on the second server after live-socket refusal must preserve the first server's socket; the second focused run before that fix showed `3 pass`, `1 fail` because the path was removed.
- `bun build src/main.ts` from `broker` failed because Bun's default browser target has no `node:net` `connect` polyfill (`error: Browser polyfill for module "node:net" doesn't have a matching export named "connect"`). The runtime-targeted `bun build src/main.ts --target=bun` completed successfully (exit 0).
- Resolution: the documented compile check moved to `bun build --target=bun src/main.ts` because the stale-socket probe imports `node:net`, which the default browser target does not polyfill.
- The probe does not make the lstat/connect/unlink/listen sequence atomic. It awaits the connection probe, removes the awaitable gap after stale verdict, then invokes `Bun.listen` immediately; a concurrent manual start remains a residual race.
- R3-socket-probe-timeout correction evidence: observed baseline `815 pass`, `0 fail`, `3679 expect() calls`, `Ran 815 tests across 52 files. [5.00s]`; focused correction `6 pass`, `0 fail`, `15 expect() calls`, `Ran 6 tests across 1 file. [46.00ms]`; full suite `817 pass`, `0 fail`, `3681 expect() calls`, `Ran 817 tests across 52 files. [4.81s]`; runtime-targeted build succeeded.
- Commit `365b4a1` (fix; 4 files, +324/-3), commit `15e0f54` (documented compile-check correction; 5 files, +9/-9), and commit `5d24a64` (review correction; 42 insertions / 10 deletions).
- Native review lineage `review-0789e564b02b5363` was approved and acknowledged with authority burned at the corrected candidate identity `sha256:a85e3038315f9e8a2a2e41e46f9c665750237a5935d4050596faec16ff8f88fb`. The review raised one CRITICAL, `R3-socket-probe-timeout` (the unbounded probe); it was corrected in `5d24a64`, and the targeted validator confirmed the correction.
- Informational review findings and disposition: `R1-1` and `R4-probe-no-timeout` are superseded by the correction because they describe the pre-correction probe; `R4-race-probe-listen` is the already-accepted non-atomic residual; `R4-restartloop-unrecoverable-refusal` is pre-existing and queued as a follow-up in `docs/TODO.md`.
- Checks as they now stand: full suite `817 pass / 0 fail / 3681 expect() calls` across 52 files; `bun build --target=bun src/main.ts` succeeded (25 modules, exit 0).

## Next step
Closed: implementation, correction, commits and review are complete. No further action is required for this unit.
