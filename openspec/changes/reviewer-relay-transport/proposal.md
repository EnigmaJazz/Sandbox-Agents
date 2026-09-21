# Proposal: Reviewer Relay Transport

## Intent

Native 4R review cannot run here: openchamber serves many repositories through one secure OpenCode process whose cwd is the server project, so the installed reviewer transport (`cwd = worktree || directory`, `:189`/`:207`) resolves the `rctx2_…` handle against the wrong repository and every reviewer Task fails `opencode_review_transport_binding_invalid`. A fully pre-materialized 689,090-byte block fails identically, while a binding-only ~400 B prompt passes and the relay materializes the block itself. Restore native reviews in-repo without weakening the security boundary.

## Scope

In scope:
- In-repo relay plugin (option A) hooking OUR OWN reviewer names, disjoint from installed `REVIEW_AGENTS`.
- cwd from the session repository; `gentle-ai review opencode-transport` on fixed argv, held across the reviewer call; prompt injected in memory; fail-closed framing; bounded output.
- `agent-host-tools` Phase 6 amendment; S17 manual-review and install notes.

Out of scope:
- Option B upstream fix (separate external issue); option D per-repo instance (documented operator workaround); options C/E (rejected — 512 KiB cap, undefined hook order).
- Raising the SDD output cap; the ~109 s `reviewLensContext` latency; `respond()` swallowing; per-session serialization.
- Modifying installed plugins; provider review semantics.

## Capabilities

- New `reviewer-relay-transport`: relay resolving the session repository and delivering provider-materialized reviewer context to our own reviewer agents.
- Modified `host-review-tools`: `reviewLensContext` retained as a read/diagnostic primitive, not a transport substitute; no deletion or weakening.

## Approach

Port `opencode-review-transport.ts` into `opencode/plugins/` with one changed input: cwd from the session repository. Hooks match only our disjoint names; the small binding prompt crosses the Task boundary and the relay materializes the block, bypassing the 512 KiB cap and the slow broker path. Provider tokens, lineage, and authority are relayed verbatim, never synthesized.

## Affected Areas

- `opencode/plugins/**` — new relay plugin (S17: manual path).
- `opencode/config-fragments/*.jsonc` — reviewer agent defs/permissions (S17).
- `openspec/changes/agent-host-tools/design.md:241` — Phase 6 premise corrected.
- `docs/discovery-report.md` — recorded agents.

## Risks

| Risk | L | Mitigation |
|------|---|------------|
| False review authority | M | Relay provider frames only; never synthesize tokens/lineage/authority |
| Confused deputy spawn | M | Allowlisted root, fixed argv, no shell, bounded output, no env injection |
| Hook collision | M | Strictly disjoint agent names |
| Protocol drift | M | Pin `gentle-ai.provider-transport/v1`; fail closed |
| Truncated block | M | Fail closed on missing `GENTLE_AI_REVIEW_CONTEXT_END` |
| S17 tension | H | Not agent-appliable; manual review + user install |

## Rollback Plan

Revert the commit and uninstall the plugin/fragment; prior loud `binding_invalid` returns; no persisted schema change.

## Dependencies

`gentle-ai` binary, `gentle-ai.provider-transport/v1`, manual review plus user install (S17).

## Open Design Questions

1. Session-directory resolution in `tool.execute.before`: `PluginInput.client` or an in-process registry written by our handlers?
2. Reviewer names/launch surface without out-of-repo edits; can the pinned lens VALUE stay fixed while the agent NAME differs?
3. Relay lifecycle: multi-minute child, framing, half-close, timeouts, ownership.
4. Frame fidelity vs the 312-line reference: reproduce isolation and `session.created` decode exactly, or a subset?
5. Result capture: subject-hash handoff, and whether the result frame carries it.

## Success Criteria

- [ ] Our reviewer names launch the relay with session-repository cwd; a reviewer Task completes.
- [ ] Missing `..._CONTEXT_END` fails closed; no token synthesized.
- [ ] cwd allowlisted root only, fixed argv, no shell, no env injection.
- [ ] `cd broker && bun test` and `bun build src/main.ts` pass; S17 manual review recorded.
