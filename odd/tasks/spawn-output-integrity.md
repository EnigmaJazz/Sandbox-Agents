# ODD task — spawn-output-integrity

## Objective
Make the host process spawn boundary byte-exact and self-reporting, so no caller can mistake truncated or corrupted output for complete output, and give it the optional stdin capability the host review pipeline needs — without changing the semantics the worker VM path depends on.

## Problem (verified 2026-10-16, by direct inspection)
`spawnArgv` (`broker/src/msb.ts:70-105`) collects stdout/stderr as JS strings and gates on string length:
- `broker/src/msb.ts:100-105` — `if (stdout.length < cap) stdout += chunk.toString("utf8")`. `String.length` counts UTF-16 code units, while every caller checks UTF-8 bytes after the fact: `broker/src/service.ts:1596` (`assertCompleteOutput` for diff), `broker/src/service.ts:2897-2898` (`buildSandboxResultOp` patch completeness), `broker/src/gitops.ts:380` (`capAndRedact`). A COMPLETE non-ASCII payload can therefore be reported truncated. Recorded as `docs/TODO.md` Tier 4 item 56.
- The same lines decode per chunk, so a multi-byte UTF-8 code point split across a `data` event becomes U+FFFD — silent corruption of downstream diffs and review artifacts.
- `broker/src/msb.ts:101` stops appending on reaching the cap WITHOUT recording that it did, so overflow is invisible.
- `broker/src/msb.ts:23-28` — `SpawnResult` has no overflow field at all.
- `broker/src/msb.ts:95` — `stdio: ["ignore","pipe","pipe"]`: no stdin support. The review-pipeline helpers are stdin-only node scripts.
- `broker/src/msb.ts:99` — cap default 512 KiB, applied to stdout and stderr independently.

Related records: Tier 4 item 57 (the inline preview is capped without the truncation signal reflecting it), Tier 4 item 58 (two fakes ignore output caps).

Vacuous-test evidence for this exact area (the project's recurring defect): `broker/tests/sandbox-result-patch-bytes.test.ts:67-80` builds a fake `git.spawn` that caps with `(result.stdout ?? "").slice(0, maxOutputBytes)` on a STRING, defaults the cap to `Number.POSITIVE_INFINITY`, and returns no truncation field — so the test that exists to cover patch truncation cannot observe the boundary at all.

## Scope
Edits: `broker/src/msb.ts` (the spawn boundary), the three byte-checking callers listed above, `broker/tests/**`, `docs/TODO.md`.
Out of scope / must NOT change: `MsbAdapter`'s invocation semantics for worker create/exec/copy/stop/remove/list/status; the worker env allowlist (`broker/src/config.ts:366-382`); `spawnArgv`'s environment MERGE semantics; any nono profile; any new host tool.

## Constraints
- S17: `broker/src/**` — `sandbox_apply` and `host_git_commit` refuse it; the result lands through the approval-gated host install and the owner commits by hand.
- Broker stays dependency-free (bun:test + node builtins).
- Security style: explicit types, argv vectors, fail closed, no implicit fallback; never publish a successful object derived from truncated output.
- `spawnArgv`'s env MUST stay `childEnvironment(opts.env)` = `{ ...process.env, ...env }`. Five callers depend on inheriting `process.env`: `broker/src/hostread.ts:105-108` (PATH for `ps`/`systemctl`/`journalctl`/`docker`/`tailscale`), `broker/src/sdd-runtime.ts:864-868` (PATH for `gentle-ai`), `broker/src/service.ts:2486-2490` (host git), `broker/src/msb.ts:285-288` (`cp`), and `broker/tests/host-git-guard-u2.test.ts:138-172` (asserts inherited `GIT_DIR`/`GIT_COMMON_DIR` are honoured). A replacement-only env must be OPT-IN on the new function only.
- The git hardening at the choke point (`hardenGitArgv`, applied at `broker/src/msb.ts:86`) must apply to ANY new spawn path that can be handed git argv — no future git caller may bypass it.
- Behavioral change only: no unrelated refactors, no reformatting.

## Tasks
- **T1 — byte-exact collection with overflow reporting.** Collect stdout/stderr as `Buffer[]`; count actual BYTES; stop RETAINING at the cap but keep draining the stream so the child never blocks on a full pipe; decode once at EOF (`Buffer.concat(...).toString("utf8")`); set `outputTruncated`/`stderrTruncated` from bytes read vs cap. Exactly-at-cap is NOT truncated; over-cap is. `outputTruncated` is the authority — an "exactly the cap" output must not be reported truncated.
- **T2 — buffered decode.** Fix the split-multibyte corruption for stdout AND stderr by decoding once at close rather than per chunk.
- **T3 — optional stdin.** Add `stdin?: Buffer` to `SpawnOptions`; set `stdio[0]` to `"pipe"` ONLY when `stdin` is provided; write the buffer and end the stream; tolerate EPIPE if the child exits without reading it, without crashing or rejecting.
- **T4 — a separate spawn for the review pipeline.** Add `spawnExec` with an explicit `envMode: "merge" | "replace"` (default `"merge"`) and stdin support, sharing the same byte-exact boundaries and the same git-hardening path as `spawnArgv`. `spawnArgv` keeps its current merge semantics and stays the path worker VM spawns use.
- **T5 — migrate the three byte-checking callers to the explicit flag** (`broker/src/service.ts:1596`, `broker/src/service.ts:2897-2898`, `broker/src/gitops.ts:380`), so an exactly-at-cap complete output is not falsely reported truncated and an over-cap output is provably truncated.
- **T6 — item 57.** Make the truncation signal reflect the capped inline preview.
- **T7 — item 58: make the fakes model the boundary.** At minimum: `broker/tests/sandbox-diff-fidelity.test.ts:60-77` and `:88-99`, `broker/tests/sandbox-result-patch-bytes.test.ts:67-80` (string `.slice` + `POSITIVE_INFINITY` default + no flag), `broker/tests/service-apply.test.ts:51-82`, `broker/tests/service-diff.test.ts:25-34,55-62`, `broker/tests/sdd-runtime.test.ts:35-41`, `broker/tests/service-git-commit-session.test.ts:90-108`, `broker/tests/msb.test.ts:22-32`. Each fake must model byte caps and the overflow flag, so a wrong implementation fails the test.
- **T8 — real-boundary tests (test-first; observe RED).** (a) a multi-byte code point split across `data` events decodes intact; (b) cap+1 bytes → `outputTruncated: true` and byte-capped output; (c) exactly-at-cap → `outputTruncated: false`; (d) a stdin round-trip; (e) stderr overflow sets `stderrTruncated`. Use real processes (or a fake that genuinely models bytes and chunk boundaries). Each must FAIL against the current implementation.
- **T9 — records.** Update `odd/tasks/spawn-output-integrity.md` Progress with observed results, and update `docs/TODO.md` Tier 4 items 56/57/58.

## Acceptance criteria
1. No caller can observe truncated output with `outputTruncated === false`, and a complete output of exactly the cap is not reported truncated.
2. A multi-byte code point split across `data` events decodes without U+FFFD.
3. `stdin` is delivered verbatim; `spawnArgv`'s merge semantics, the worker VM path, and the git hardening path are unchanged.
4. `bun --cwd broker test --reporter=dot` — baseline 917 pass / 0 fail, must stay 0 fail. From `broker`: `bun build --target=bun src/main.ts` succeeds.
5. Items 56/57/58 are closed and the fakes named in T7 model the boundary.

## Checks
- Focused: `bun --cwd broker test --reporter=dot` on the changed test files.
- Full: `bun --cwd broker test --reporter=dot`.
- Build: from `broker`, `bun build --target=bun src/main.ts`.
- `sandbox_bash` is argv-only (no pipes, redirects, globs, `&&`, `;`).

## Route and pre-code advice
Route: authorized change, ODD, delegated. Triggers: mutation, execution, preparation, route declaration.
Pre-code advice (`advisor-integration-pre`, 2026-10-16; plus a separate `advisor-security-pre` review of the sibling foundation unit, not this one):
- MUST-FIX: cap measured in UTF-16, not bytes (`msb.ts:101`; callers `service.ts:1596`, `service.ts:2897-2898`, `gitops.ts:380`) — T1/T5.
- MUST-FIX: split multi-byte character corruption (`msb.ts:100-105`) — T2.
- MUST-FIX: no stdin support (`msb.ts:95`) — T3.
- MUST-FIX: replacement-only env as a default would break named callers (`hostread.ts:105-108`, `sdd-runtime.ts:864-868`, `service.ts:2486-2490`, `msb.ts:285-288`, `host-git-guard-u2.test.ts:138-172`) — T4.
- SHOULD-FIX: Shape A (fix `spawnArgv` in place, add a separate function) rather than migrating every caller, because `MsbAdapter` routes every `msb` invocation through the same spawn (`msb.ts:198-204`) — T4.
- SHOULD-FIX: extend the option/result types so callers adopt incrementally — T1.
- ADVISORY: on overflow, drain rather than kill, and never return complete-looking output — T1.
- ADVISORY: the named fakes would keep passing even if the boundary were wrong — T7/T8. This is the project's recurring defect class and the reason T8 must be RED first.

## Progress
- 2026-10-16 — tracker created; implementation not started.

## Next step
T8 first: write the real-boundary tests and observe them fail against the current implementation.
