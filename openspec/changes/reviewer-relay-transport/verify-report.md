```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:406bd43d653667e8f265a8458ef835650cdfa046e9054ccd6aca3d448001518a
verdict: pass
blockers: 0
critical_findings: 0
requirements: 7/7
scenarios: 13/13
test_command: "/usr/bin/env -C /work/broker /usr/local/bin/bun test --reporter=junit --reporter-outfile=/tmp/reviewer-relay-full.xml"
test_exit_code: 0
test_output_hash: sha256:6d6b067d56fb70f575791aae892d52ac65df19a8d93688fe35bd279c5d7e3681
build_command: "/usr/bin/env -C /work/broker /usr/local/bin/bun build src/main.ts --outfile /tmp/reviewer-relay-main.js"
build_exit_code: 0
build_output_hash: sha256:55491c2476d6d6624995f422072dc9668184c9357873ecec78e59cfa42116e91
```

## Verification Report

**Change**: `reviewer-relay-transport`  
**Version**: N/A  
**Mode**: Standard (`strict_tdd: false`)  
**Persistence**: Hybrid deliverable requested: this canonical body is stored in OpenSpec and Magic Context  
**Candidate**: committed tree `26532d4ca79b566c8a8990f61fd7e00f8b7b768d`; evidence revision `sha256:406bd43d653667e8f265a8458ef835650cdfa046e9054ccd6aca3d448001518a`

### Executive Summary

Final independent verification passes. All 13 implementation tasks are complete; all 7 requirements and 13 scenarios have passing runtime coverage; all 6 design decisions are coherent with the committed candidate. The two previously reported framing defects are genuinely fixed: stdout is buffered as bytes until the `0x0A` frame boundary before UTF-8 decoding, and a post-result frame arriving after a real `setImmediate` event-loop turn is refused before result admission at stdout EOF.

The change measures 2,689 changed lines against the 800-line review budget. The maintainer explicitly accepted and documented this size exception when authorizing the final independent-verification objective; it is not a blocker or a newly raised warning. Gate 11 remains pending and entirely user-owned.

### Completeness

| Metric | Value |
|---|---:|
| Tasks total | 13 |
| Tasks complete | 13 |
| Tasks incomplete | 0 |
| Requirements complete | 7/7 |
| Scenarios compliant | 13/13 |
| Design decisions followed | 6/6 |

### Build and Test Execution

#### Focused relay suite

**Command**: `/usr/bin/env -C /work/broker /usr/local/bin/bun test tests/reviewer-relay-transport.test.ts`  
**Exit code**: `0`

```text
52 pass
0 fail
279 expect() calls
Ran 52 tests across 1 file. [93.00ms]
```

The exact focused run includes passing regressions named:

- `preserves a multibyte code point split across two stdout chunks`
- `refuses an extra frame delivered in a later stdout event after the result`
- `refuses a complete frame delivered in a later event-loop turn after the result`

A second focused run emitted JUnit evidence with the same `52 pass / 0 fail / 279 expect()` result. Its report digest is `sha256:37a0943519150d99c5cbc0dc62af1d568e996c49dd830f1126884cfafc345666`.

#### Full required gate

**Command**: `/usr/bin/env -C /work/broker /usr/local/bin/bun test`  
**Exit code**: `0`

```text
402 pass
0 fail
1818 expect() calls
Ran 402 tests across 17 files. [356.00ms]
```

The full run also printed the expected exercised fail-closed queue diagnostic:

```text
{"sessionID":"net1","operation":"ensureWorker","result":"error","error":"client disconnected while queued for a worker slot","durationMs":10.957604,"ts":"2026-09-15T20:34:48.391Z"}
```

That diagnostic is test-path output, not a suite failure. A second full-gate run emitted JUnit evidence and again produced `402 pass / 0 fail / 1818 expect() calls / 17 files`; the exact JUnit report digest recorded in the envelope is `sha256:6d6b067d56fb70f575791aae892d52ac65df19a8d93688fe35bd279c5d7e3681`.

#### Build

**Command**: `/usr/bin/env -C /work/broker /usr/local/bin/bun build src/main.ts --outdir /tmp/build-check`  
**Exit code**: `0`

```text
Bundled 24 modules in 34ms

  main.js  1.15 MB  (entry point)
```

A second equivalent build used `--outfile /tmp/reviewer-relay-main.js`, exited `0`, and reported `Bundled 24 modules in 31ms` with `reviewer-relay-main.js 1.15 MB (entry point)`. The envelope's `build_output_hash` is the SHA-256 digest of that generated build output artifact: `sha256:55491c2476d6d6624995f422072dc9668184c9357873ecec78e59cfa42116e91`.

**Coverage command**: Not configured (`coverage_command: null`; threshold `0`). Behavioral scenario coverage is `13/13` through passing runtime tests.

### Defect-Fix Confirmation

#### 1. Split multibyte UTF-8 survives stdout chunking

✅ Confirmed by source and runtime evidence.

- `opencode/plugins/reviewer-relay-transport.ts:645-660` appends raw `Buffer` chunks, finds the byte newline with `buffered.indexOf(0x0a)` at line 656, and calls `toString("utf8")` only on the complete line slice. A partial UTF-8 code point remains buffered as bytes.
- `broker/tests/reviewer-relay-transport.test.ts:407-427` splits the four-byte 😀 sequence inside the code point, emits the two raw chunks separately, and asserts the materialized string and UTF-8 bytes are unchanged with no U+FFFD.
- The focused runtime suite passed this named regression.

#### 2. A genuinely later-turn post-result frame is refused

✅ Confirmed by source and runtime evidence.

- `opencode/plugins/reviewer-relay-transport.ts:614,669,708,730-747` stores the result in `admittedResult`, keeps the reader/deadline live, refuses every complete post-result frame through `reviewer_relay_frame_refused`, refuses a partial post-result frame at EOF, and resolves only after stdout closes.
- `broker/tests/reviewer-relay-transport.test.ts:455-488` emits a result, awaits `setImmediate` at line 481 to yield a real event-loop turn, proves completion is still unsettled, emits a second complete frame, and asserts the typed refusal plus child termination.
- The focused runtime suite passed this named regression.

### Spec Compliance Matrix

| Requirement | Scenario | Passing runtime evidence | Result |
|---|---|---|---|
| Session-repository root resolution | Session repository selected | `accepts the exact canonical allowlisted root`; `asi-review-* resolves the session repository and materializes the block` | ✅ COMPLIANT |
| Session-repository root resolution | Untrusted root rejected | Root-selection tests for relative, symlink/noncanonical, server, outside-allowlist, selector-like, control-bearing, missing, and malformed roots | ✅ COMPLIANT |
| Disjoint reviewer hook scope | Installed reviewer name bypasses relay | `installed reviewer agents and unrelated tools bypass the relay untouched` | ✅ COMPLIANT |
| Disjoint reviewer hook scope | Integration reviewer name is handled | `asi-review-* resolves the session repository and materializes the block` | ✅ COMPLIANT |
| Binding-only Task boundary | Context is materialized by relay | Hook test asserts the start frame carries only the binding while the Task receives the complete materialized block | ✅ COMPLIANT |
| Verbatim and complete provider framing | Valid frame preserved | `valid frame is preserved byte-for-byte`; split-multibyte regression | ✅ COMPLIANT |
| Verbatim and complete provider framing | Partial frame refused | Malformed/unexpected-key, missing START/END, partial EOF, duplicate/extra, and real-later-turn post-result tests | ✅ COMPLIANT |
| Bounded host process | Disciplined spawn | Fixed binary/argv, `shell:false`, piped stdio, canonical cwd, allowlist-only environment, stdout/stderr bounds | ✅ COMPLIANT |
| Bounded host process | Relay deadline expires | `the deadline is finite and supports multi-minute reviewer calls` asserts 600 seconds and typed termination | ✅ COMPLIANT |
| Manual security-boundary delivery | Protected artifact is ready | Fragment tests verify exactly six hidden/tool-less agents plus `NOT INSTALLED`/`MANUAL`; Task-name mapping test passes | ✅ COMPLIANT |
| Diagnostic-only lens context read | Diagnostic read retained | Full gate passes lens-context argv, validator, executor raw-block, service forwarding, timeout, and amendment tests | ✅ COMPLIANT |
| Diagnostic-only lens context read | Transport is required separately | `reviewLensContext stays diagnostic and transport stays separate`; relay source owns only `asi-review-*` transport | ✅ COMPLIANT |
| Diagnostic-only lens context read | Existing primitive remains protected | Full gate passes unchanged `reviewLensContext` canonical-root, fixed-argv, raw-block, service, and validation contracts | ✅ COMPLIANT |

**Compliance summary**: `13/13` scenarios compliant at runtime; `7/7` requirements complete.

### Correctness (Static Evidence)

| Requirement | Status | Notes |
|---|---|---|
| Session-repository root resolution | ✅ Implemented | Session client lookup, broker allowlist, canonical `realpath` equality, server-root inequality, no ambient fallback |
| Disjoint reviewer hook scope | ✅ Implemented | Six `asi-review-*` names are explicitly disjoint from six installed `review-*` names |
| Binding-only Task boundary | ✅ Implemented | Binding is written in the start frame; materialized prompt replaces Task input only after provider response |
| Verbatim and complete provider framing | ✅ Implemented | Strict schema/keys/state, raw byte buffering, delimiter validation, EOF-gated result admission, typed refusal paths |
| Bounded host process | ✅ Implemented | Fixed binary/argv, direct no-shell spawn, constructed environment, 4 MiB/64 KiB bounds, 600-second deadline |
| Manual security-boundary delivery | ✅ Prepared | Repository assets are explicitly `NOT INSTALLED`; installation and reviewer Task remain user-owned |
| Diagnostic-only lens context read | ✅ Preserved | Amendment is documentation-only and existing host-tool runtime contracts pass unchanged |

### Coherence (6 Design Decisions)

| Decision | Followed? | Evidence |
|---|---|---|
| Session root | ✅ Yes | `client.session.get`, broker policy, exact canonical equality, cache, server-root refusal, and no fallback are implemented and tested |
| Agents / launch | ✅ Yes | Six hidden/tool-less `asi-review-*` agents and `AGENTS.md` lens mapping; provider lens/capture fields remain unchanged |
| Lifecycle | ✅ Yes | Global owner/deferred/refused registry, four-relay cap, before/after lifecycle, half-close, cleanup, deadline, and typed refusals are tested |
| Fidelity | ✅ Yes | Isolation transform and `session.created` agent/title decoding are present; framing state machine has passing boundary coverage |
| Capture / authority | ✅ Yes | Exact frame keys and strings are validated; no token, lineage, subject identity, or authority is synthesized |
| Spawn | ✅ Yes | Fixed absolute binary and argv vector, `shell:false`, piped stdio, allowlist-only environment, and output bounds are asserted |

### Host-Review-Tools and Host Configuration Boundary

✅ The `host-review-tools` portion is amendment-only. `openspec/changes/agent-host-tools/design.md:239-253` adds the explicit correction that `reviewLensContext` is diagnostic-only and that the separate relay resolves the Task-session repository. No reviewer-relay runtime behavior was added to the host-review tool.

✅ Existing host-review contracts remain green in the full suite, including fixed lens-context argv, canonical-root validation, raw provider-block return, read authorization, payload validation, and client timeout.

✅ No installed host configuration was touched. The deliverables remain repository-local; `opencode/config-fragments/reviewer-relay-agents.jsonc:1-10` says `NOT INSTALLED` and `MANUAL`, and `docs/discovery-report.md:189-201` records that the installed transport was not modified. The worker status before report creation contained only the excluded session bundle `ses_f593985d8ffeVKAUTbzZ6EB191.bundle`; no `.broker-tmp/` or `*.bundle` is part of this deliverable.

### Review Budget Exception

The committed relay package is 2,689 changed lines (`1,301` test + `207` agent fragment + `1,181` plugin) against the 800-line budget. The attempt ledger records the maintainer's explicit acceptance of this exact measured size and authorizes the fresh independent-verification objective with a 2,700-line cap. This is an accepted, documented exception and is not classified as a blocker, warning, or unresolved finding.

### Manual Gate

**Gate 11: PENDING — user-owned.** `docs/manual-verification.md:249-275` requires the user to review the S17 diff, install/merge exact bytes, restart secured OpenCode, and run one `asi-review-risk` Task. This report does not self-certify any part of Gate 11.

### Issues Found

**CRITICAL**: None.  
**WARNING**: None.  
**SUGGESTION**: None.

### Verdict

**PASS**

All complete requirements and scenarios have passing runtime coverage, both prior defects are fixed on the committed candidate, all design decisions remain coherent, and no unresolved implementation defect was found. Gate 11 is a separate pending user-owned delivery gate, not an automated verification failure.
