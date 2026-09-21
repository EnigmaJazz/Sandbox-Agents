# Design: Reviewer Relay Transport

## Technical Approach

Port the provider relay into one in-repo plugin, replacing plugin-instance cwd with Task-session authority. Preserve the binding-only boundary and provider protocol; add strict root, framing, process, and lifecycle bounds (R1–R5). Dedicated agents and manual S17 delivery satisfy R2/R6; `reviewLensContext` remains diagnostic-only (R7).

## Architecture Decisions

| Decision | Alternatives / tradeoff | Choice and rationale | Trace |
|---|---|---|---|
| Session root | A tool-handler registry has ordering and module-duplication hazards. | Use `PluginInput.client.session.get({path:{id}})`. Cache successful immutable roots in a versioned `globalThis` map; on miss query the client and broker `policy.projects`, `realpath` both sides, and require exact equality with one canonical allowlisted root and inequality with the plugin server root. Lookup, broker, shape, or validation failure refuses pre-spawn; never fall back to `directory`, `worktree`, `process.cwd()`, or a handler registry. | R1 |
| Agents / launch | Same names trigger both plugins. | Define `asi-review-{risk,resilience,readability,reliability,refuter,validator}` in `reviewer-relay-agents.jsonc`, hidden, subagent-only, tool-less, with counterpart models. Repo `AGENTS.md` maps only Task `subagent_type`; lens values remain `review-risk|review-resilience|review-readability|review-reliability`, and capture arguments remain provider-issued. | R2 |
| Lifecycle | Per-hook children lose state; serialization blocks 4R. | A versioned process-global registry reserves `(sessionID,callID,agent)` before lookup. Distinct keys run concurrently, capped at four; duplicate hooks defer to the owner, and a fifth refuses pre-spawn. `before` writes `start{prompt}` and awaits `prompt{nonce}`; `after` writes `complete{nonce,output}`, half-closes stdin, awaits `result{output}`, then removes/kills. A 600-second end-to-end deadline, crash, abort, duplicate completion, or disposal kills and returns a typed refusal. | R3–R5 |
| Fidelity | A subset risks inherited instructions or unidentified child sessions. | Reproduce the state machine, owner/deferred/refused registry, cleanup, isolation system replacement, and `session.created` decode by runtime `agent` or `(@agent subagent)` title; OpenCode 1.18.x requires them. Replace cwd and agent constants. Omit `worktree||directory`, canonical names, broker lens materialization, and unrelated cap/performance work. | R2–R5 |
| Capture / authority | Creating selectors could fabricate authority. | Validate exact NDJSON schema/state/keys and preserve prompt/result strings byte-for-byte. `prompt` must contain `GENTLE_AI_REVIEW_CONTEXT` and end with `GENTLE_AI_REVIEW_CONTEXT_END`; EOF, extra, malformed, oversized, or partial frames refuse. The result frame has no separate subject-hash field: `output` is reviewer JSON containing the prompted echo. `after` returns it unchanged; the orchestrator passes it as `inputJson` using only the provider-returned capture continuation and subject hash. The relay derives no authority. | R4, R7 |
| Spawn | Inherited command/env widens authority. | A wrapper accepts only validated cwd/prompt and spawns fixed `/home/linuxbrew/.linuxbrew/bin/gentle-ai`, argv `review`,`opencode-transport`, `shell:false`, piped stdio, and constructed allowlist-only HOME/XDG/locale env. Bound each stdout frame to 4 MiB and stderr to 64 KiB; reject overflow. | R1, R5 |

## Data Flow

`provider status → AGENTS name map → Task(binding) → before(client session → broker allowlist → relay prompt) → reviewer → after(complete/result) → capture-result(exact provider continuation)`

## File Changes

| File | Action | Description |
|---|---|---|
| `opencode/plugins/reviewer-relay-transport.ts` | Create | Decoders, root resolver, bounded relay, registries, hooks. Manual target: `~/.config/opencode/plugins/reviewer-relay-transport.ts`. |
| `opencode/config-fragments/reviewer-relay-agents.jsonc` | Create | Six agents; manually merge into host config. |
| `broker/tests/reviewer-relay-transport.test.ts` | Create | Spawn/client/broker fakes and protocol tests. |
| `AGENTS.md` | Modify | Task-name map; capture fields stay unchanged. |
| `openspec/changes/agent-host-tools/design.md` | Modify | Amend Phase 6: lens context is diagnostic, not transport or authority. |
| `docs/{discovery-report,manual-verification}.md` | Modify | Record assets and S17 review/install/rollback gate. |

## Testing Strategy

| Layer | Scenarios |
|---|---|
| Unit (RED first) | Session repository selected; untrusted root rejected; installed name bypasses; integration name handled; context materialized; valid frame preserved; partial frame refused; disciplined spawn; deadline expires. |
| Integration | Diagnostic read retained; transport required separately; existing primitive protected; `cd broker && bun test`; `bun build src/main.ts`. |
| Manual | Protected artifact ready: user reviews S17 diff, installs, restarts, and runs one reviewer Task; agents never certify this gate. |

## Threat Matrix

| Boundary | Applicability | Safe / failure behavior | Planned RED tests |
|---|---|---|---|
| Documentation-like paths | N/A — no executable classification | — | — |
| Git repository selection | Applicable — cwd selects context | Exact canonical allowlisted absolute root succeeds; `git -C`-like text, relative, symlink/noncanonical, server, and outside roots refuse pre-spawn. | One test per listed selector. |
| Commit state | N/A — no Git mutation | — | — |
| Push state | N/A — no push | — | — |
| PR commands | N/A — no PR automation | — | — |

## Migration / Rollout

No data migration. S17 stops automation after the review package. The user manually reviews, copies/merges exact bytes, restarts secure OpenCode, and performs the gate. Rollback removes installed entries; the prior loud binding failure returns.

## Open Questions

None. All 7 requirements and 13 scenarios are covered.
