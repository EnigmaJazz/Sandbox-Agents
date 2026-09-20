# Exploration: Reviewer Relay Transport

- change: `reviewer-relay-transport`
- store: hybrid (Magic Context + OpenSpec)
- phase: explore
- date: 2026-09-15

## Problem Statement

Gentle AI's native 4R review (`review-risk` / `review-resilience` / `review-readability` /
`review-reliability`) cannot run in this environment. openchamber multiplexes many repositories
through ONE secure OpenCode server whose process cwd is
`/home/james/ai-workspace/workflow_optimisation` — never the session's repository.

The reviewer transport plugin spawns `gentle-ai review opencode-transport` with
`cwd = worktree || directory` taken from `PluginInput` (the plugin instance, i.e. the server's
project), so the relay resolves the opaque `rctx2_…` repository-context handle against the wrong
repository. Every reviewer Task then fails:

```
opencode_review_transport_binding_invalid: Task repository context does not match the repository and binding it commits to
```

The provider side (lineage, target, capture-phase revision, four lens slots with distinct subject
hashes) is correct throughout. The defect is purely transport working-directory resolution on a
multi-repo host.

## Verified Evidence

1. **The transport is an installed plugin, not in this repository.**
   `~/.config/opencode/plugins/opencode-review-transport.ts` (312 lines).
   `REVIEW_AGENTS = {review-risk, review-resilience, review-readability, review-reliability,
   review-refuter, review-validator}`. The root cause is explicit at `:189` and `:207`:

   ```ts
   const OpenCodeReviewTransportPlugin: Plugin = async ({ directory, worktree }) => {
     ...
     const cwd = () => worktree || directory
   ```

   so `cwd()` is the server's project, not the session's. `:251-275` (`tool.execute.before`)
   matches `input.tool === "task"` and `output.args.subagent_type ∈ REVIEW_AGENTS`, starts the
   relay, and replaces `output.args.prompt` with the relay-materialized prompt; `:276-308`
   (`tool.execute.after`) replaces `output.output` with the relay result frame. The frame
   protocol is `gentle-ai.provider-transport/v1`: `start{prompt}` → `prompt{nonce}` →
   `complete{nonce, output|error}` → `result{output}` (`:30-37`, `:152-186`). This is a complete,
   source-available reference implementation.

2. **Decisive hand test.** Piping a FULLY pre-materialized lens block (binding line +
   `GENTLE_AI_REVIEW_CONTEXT` + `GENTLE_AI_REVIEW_PATCH` diff blocks + `..._CONTEXT_END`,
   689,090 bytes) as the `start` frame into `gentle-ai review opencode-transport` from a WRONG
   cwd still fails with the same `opencode_review_transport_binding_invalid` error (empty
   stdout). The relay ALWAYS resolves the handle from its own cwd; broker-side
   pre-materialization cannot substitute.

3. **The relay accepts a binding-only prompt.** A prompt containing only the small (~400 byte)
   `GENTLE_AI_REVIEW_BINDING {...}` line passes the earlier gate
   `Task prompt has no provider-issued review binding`, after which the relay materializes the
   whole block itself. This is what makes a corrected-cwd relay viable while only the small
   prompt crosses the Task boundary.

4. **`ToolContext.directory` is available to TOOLS.** Our own
   `opencode/plugins/sandbox-tools.ts` uses `ctx.directory` at 40+ sites (`:284-1273`;
   `ensureWorker` `:101-103`; `currentProjectDirectory` `:169-171`), which is why our host tools
   target the correct repository while the transport does not.

5. **The hook input has no directory.** `tool.execute.before` input carries only
   `{tool, sessionID, callID}`. The per-session directory exists only on `ToolContext`, so a fix
   must look it up (e.g. via `PluginInput.client`) or the hook input must be extended.

6. **In-repo assets exist but do not cover the transport.** `broker/src/sdd-runtime.ts` spawns
   `gentle-ai` with fixed argv and the canonical project root as cwd (`resolveProjectRoot`
   `:1045-1061` requires the exact allowlisted root); `reviewLensContext` `:1277-1298` returns the
   raw multi-line block; host review ops and reviewer-result staging exist. Running the relay from
   INSIDE the repository materializes the full block and fails only with `provider_result_missing`
   (no completion frame was sent) — confirming cwd is the only blocker.

7. **Secondary in-repo defects.** `msb.ts:70-73` stops appending stdout/stderr once `cap` is
   reached and `config.ts:353` hardcodes `sddRuntime.outputMaxBytes = 512 * 1024`, so the 689 KB
   lens block is truncated before its END delimiter; `server.ts:469-475` `respond()` swallows
   `socket.write` errors and logs ok; `reviewLensContext` takes ~109 s in the broker vs ~102 ms for
   the identical CLI run by hand, consuming 84% of the 130 s client budget
   (`broker-client.ts:77`); `withSessionLock` (`server.ts:461-467`) serializes ops per session.

## Affected Areas

- `opencode/plugins/**` (S17) — new reviewer-relay plugin for option A; agent apply is rejected by
  design and requires explicit manual review.
- `opencode/config-fragments/*.jsonc` (S17) — our reviewer agent definitions and permissions.
- `opencode/plugins/lib/broker-client.ts` (S17) — only if a broker-assisted cwd lookup or the
  output-cap change is in scope.
- `broker/src/{sdd-runtime,msb,config,server}.ts` (S17) — secondary defects and option C.
- `openspec/changes/agent-host-tools/design.md:241` — the disproven Phase 6 premise; amend or
  supersede.
- `docs/discovery-report.md` — records installed agents/plugins; update if new agents are added.

## Options

### A. In-repo reviewer relay plugin (our own)

Port `opencode-review-transport.ts` into `opencode/plugins/`, hooking OUR OWN reviewer agent names
(strictly disjoint from the installed transport's `REVIEW_AGENTS`, so the two cannot collide),
resolving cwd = the session's repository, spawning `gentle-ai review opencode-transport` with it,
holding the child across the reviewer call, and injecting the materialized prompt in memory (and
the completion frame on return).

- Pros: the only in-repo route; update-proof (our plugin is not overwritten by gentle-ai updates);
  the reference implementation is available to port; the relay is proven to work from a correct cwd
  (evidence 6); the 689 KB block never crosses the tool boundary, so the 512 KiB cap and the ~109 s
  broker path are both bypassed.
- Cons: we own review-protocol plumbing correctness; the session directory must be resolved inside a
  hook that has none; requires our own reviewer agents whose names must stay out of `REVIEW_AGENTS`;
  S17 (`opencode/plugins/**`, `config-fragments/**`) means agent apply is rejected and a manual
  review + user install is required; depends on the provider launching our names (or the orchestrator
  mapping lens → our names).
- Update-proofness: high. S17: the deliverable itself is S17 → manual path. Security boundary: adds a
  host-binary spawn with a cwd parameter, so it MUST reuse broker allowlist semantics (canonical root
  only, fixed argv, no shell, bounded output, no env injection) or it becomes a confused deputy.
  512 KiB cap: off the critical path. ~109 s: avoided (child spawn is ~102 ms scale).

### B. Upstream fix in gentle-ai

Transport resolves the session's directory (via `PluginInput.client`), or OpenCode adds `directory`
to the `tool.execute.before` input.

- Pros: fixes the native path for everyone; zero in-repo surface; no S17 exposure; no new spawn
  capability.
- Cons: outside this repository and outside our control; requires an upstream issue, an upstream
  release, and a reinstall; nothing lands here.
- Update-proofness: total (it IS the update). S17: none. Security boundary: none. 512 KiB cap and
  ~109 s: unchanged; both remain defects.

### C. Host-side broker relay op

The broker materializes the block and hands it to the reviewer agent.

- Pros: reuses the trusted fixed-argv/allowlist broker boundary; no new spawn capability in a plugin.
- Cons: BLOCKED as specified — the 689 KB block must cross the tool boundary and `outputMaxBytes` is
  512 KiB (`config.ts:353`, `msb.ts:70-73`); the ~109 s `reviewLensContext` latency is on the
  critical path and already consumes 84% of the 130 s client budget; the block would also transit the
  response envelope and client read limits. Requires at least two S17 changes (cap + perf) plus a
  staging/streaming design, and still does not remove the need for a relay child held alive across
  the reviewer call.
- Update-proofness: high. S17: yes (broker). Security boundary: low risk (existing boundary).
  512 KiB cap: the blocker. ~109 s: the blocker.

### D. Separate reviewer-only OpenCode instance per repo

Launch a dedicated secure instance whose cwd IS the reviewed repository.

- Pros: zero code change; directly validates the root-cause diagnosis (the transport's `directory`
  becomes correct); no S17 exposure.
- Cons: operator action; one instance per repository; does not scale with openchamber multiplexing;
  its own nono profile and security surface; restart/session-lifecycle cost; the in-session
  orchestrator cannot Task across instances, so it is an operator workaround, not an integration.
- Update-proofness: n/a. S17: none. Security boundary: adds another privileged instance. 512 KiB cap
  and ~109 s: unaffected.

### E. Same-name interception / neutralize the installed transport

Rejected: plugin ordering is undefined, we cannot suppress another plugin's hook for the same
`subagent_type`, and the installed transport fails loudly rather than passing through.

## Recommendation

Pursue **A** as the in-repo direction, with **B filed upstream in parallel** as the durable fix, and
**D documented as the interim operator workaround**. Do NOT pursue C as specified (blocked by the cap
and the ~109 s path). Do NOT attempt E.

Rationale: evidence 3 and 6 show the relay works if and only if its cwd is the repository, and that
only the small binding prompt needs to cross the Task boundary. A corrected-cwd relay is therefore
the minimal in-repo intervention, and it keeps both the 512 KiB cap and the ~109 s broker path off
the critical path. The ~312-line reference plugin is on disk, so this is a port with exactly one
changed input (the cwd source), not a protocol invention.

**Amend / supersede agent-host-tools Phase 6.** The premise at `design.md:241` — that the broker
owning the repository per project makes the per-lens reviewer step work — is DISPROVEN by evidence 2.
`reviewLensContext` is implemented, tested and harmless, but it does not enable the reviewer path; it
should be retained as a read/diagnostic primitive only, and that change's record should be amended
explicitly. This change's archive should carry the correction rather than deleting the op (deletion
would churn S17 for no benefit).

## Open Questions

1. Session-directory resolution inside `tool.execute.before`: does `PluginInput.client` expose a
   session's project directory? If not, is a shared in-process registry written by `sandbox-tools.ts`
   handlers (which DO receive `ToolContext.directory`) reliable given plugin module duplication?
2. Does the review flow pin the exact agent names `review-risk|…`? If the lens travels only inside the
   binding line, our own names are safe; if the names are pinned, our plugin collides with the
   installed transport and A needs an upstream coordination point.
3. Frame fidelity: must `experimental.chat.system.transform` isolation and the `session.created`
   decode (agent or `(@<agent> subagent)` title suffix) be reproduced exactly, or is a subset
   sufficient?
4. Long-lived child semantics: multi-minute reviewer calls, stdin/stdout framing, half-close, and
   relay timeout bounds.
5. Where does the ~109 s go (spawn env, per-session lock wait, output handling)? Measure before any
   design relies on the broker path for a 689 KB block.
6. Does raising `outputMaxBytes` above 689 KB hold end-to-end (response envelope, client read limits),
   and does any code assume ≤512 KiB?
7. S17 delivery: which manual-review/apply-exception path authorizes changing `opencode/plugins/**`,
   and who installs it?
8. Reviewer-result capture: how is the subject hash obtained and echoed, and does the relay's result
   frame carry it (per-slot distinct subject hashes)?

## Risks

- **False review authority.** If we own the relay, a subtly wrong completion frame could make a review
  LOOK complete. Relay provider-issued frames only; never synthesize tokens, lineage, or authority.
- **Hook collision** with the installed transport if the agent names are not strictly disjoint →
  loud refusals or double materialization.
- **Protocol drift.** `gentle-ai.provider-transport/v1` is provider-owned; a gentle-ai update can
  change it. Pin/verify the schema and fail closed.
- **New host-execution capability.** A plugin spawning `gentle-ai` with a cwd argument is a
  confused-deputy risk unless cwd is restricted to the allowlisted canonical root with fixed argv, no
  shell, bounded output, and no env injection.
- **Silent truncation.** A truncated block has no END delimiter today; any block-consuming design must
  fail closed on a missing END rather than prompt with partial context.
- **S17 tension.** We would modify the security-boundary plugin set; routing-guard/permission
  semantics must not weaken, and the change cannot be agent-applied.

## Non-Goals

- No upstream gentle-ai change in this repository (file an issue only).
- No modification of the installed plugins under `~/.config/opencode/plugins/`.
- No change to provider review semantics (lineage, tokens, capture authority) — we relay, we do not
  authorize.
- No new nono profiles or systemd units; no per-repo privileged instances beyond documenting D.
- No raising of the SDD-runtime output cap and no broker timeout/perf refactor in this change (they
  matter only to the rejected option C).
- No deletion of `reviewLensContext` or other agent-host-tools artifacts; the correction is an
  amendment.

## Ready for Proposal

Yes.
