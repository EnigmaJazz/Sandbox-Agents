# Broker client frame loss

## Objective

A broker response that cannot be matched to a pending request must fail that caller promptly instead of being silently discarded, and a large response must arrive intact rather than stalling the caller until its timeout.

## Problem — observed evidence

- The broker logged `{"operation":"readFile","result":"ok","durationMs":18.079972}` while the plugin raised `broker request 'readFile' timed out` at the same moment — 30 seconds later, since `readFile` uses the client's 30 s default (`broker-client.ts:93`; it is absent from `OPERATION_TIMEOUT_MS` at `:64-84`). **Observed: the broker completed the read and the client never received the response.**
- Controlled comparison in the same project and session shape: `sandbox_edit` succeeds end to end for a **small** file; `sandbox_apply_patch` succeeds for the **large** file (`verify-workflow.sh`, **234,944 bytes**). Whole-file semantics (`sandbox_edit` reads the file to locate `oldString` and rewrites the entire file) carry ~229 KB each way; the patch route carries only the changed region. **Only payload size differs.**

## Problem — read in code

Three defects in the client framer `opencode/plugins/lib/broker-client.ts`:

1. **`:131-133`** — `try { resp = JSON.parse(line) } catch { continue; }`: an unparseable frame is silently dropped. No rejection, no log; the matching pending request is left unresolved until its timeout.
2. **`:141-146`** — `const p = pending.get(resp.id); if (p) { … }` with **no `else`**: a response whose id matches no pending request is silently ignored.
3. **`:122`** — `rx += data.toString("utf8")` decodes **each socket chunk independently**, corrupting any multibyte UTF-8 character split across a chunk boundary. This is the identical defect already fixed in the reviewer relay's framer in this repository; it corrupts content rather than dropping frames, so it is a latent defect rather than this symptom.

## Not established

Which of the two drop paths fires for a large read, and why the frame is unparseable or unmatched, is **not** determined. A per-line **request** size cap exists (`broker/src/server.ts:229`); no response-side cap was found in that file. Do not assert truncation as the cause.

## Scope and shape

Authorized files: `opencode/plugins/lib/broker-client.ts` and its tests.

For the two drop paths, choose and record one behaviour: reject the matching pending request when it can be identified, and make an unmatched id diagnosable (a bounded log of the line length, a bounded prefix, and the live pending ids) rather than a silent no-op. Do not change the request-side cap. Do not change the read paths' by-design semantics.

Response-bound decision: evaluate whether the broker should bound a response and send a typed error frame instead of an oversized one, and record the decision either way. Do not presume a response-side bound or truncation is the cause of the observed symptom.

## Constraints

- `opencode/plugins/**` and `broker/src/**` are S17 — preserved for manual install.
- Preserve the reconnection behaviour described at `broker-client.ts:86-90`.
- Do not commit, push, create a PR, merge, or release under this tracker.

## Stable task IDs

- **T1** — the unparseable-frame path.
- **T2** — the unmatched-id path.
- **T3** — the per-chunk decode.
- **T4** — checks and the reviewability receipt.

## Acceptance criteria

- A large response (≥ 250 KB) resolves instead of timing out.
- An unparseable frame fails its caller promptly rather than after the full timeout.
- An unmatched id is diagnosable.
- A multibyte character split across a chunk boundary survives intact.
- The suite is green.
- The build succeeds.

## Authorized scope

The files above and their tests. No other paths. Not authorized by this tracker: commit, push, PR, merge or release.

## Checks

- `bun --cwd broker test` — record exact totals; committed baseline is **556 pass, 0 fail**.
- `bun build broker/src/main.ts --outfile <outside the repository>`.
- Verification must **EXECUTE** what it validates: exercise the framer with a large synthetic frame and observe the outcome. A parse or build check proves syntax only.

## Route and trigger evidence

- `route: delegated`.
- Specialist: `general` (sandbox writer, per the user's coding-model decision: “Linked directly to OpenCode”).
- Trigger: the two-or-more-non-trivial-files writer trigger.

## Delivery strategy

Forecast: approximately **200 authored changed lines** (additions plus deletions, excluding generated files) for the scoped client and test change. Chosen strategy: **single-pr**. Recompute against the actual work-unit diff before any delivery planning; this tracker does not authorize commit, push, PR, merge, or release.

## Progress

T1–T4 not started.

## Next step

Implement T1–T4 as one bounded change, then return the reviewability receipt.
