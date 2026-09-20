# Tasks: Reviewer Relay Transport

## Review Workload Forecast

Estimated changed lines: 760
400-line budget risk: High
Chained PRs recommended: Yes
Decision needed before apply: No
Chain strategy: stacked-to-main
Delivery strategy: auto-chain

High risk triggers three review/apply slices, not automated PRs: S17 protected plugin/config files require automation to stop at a reviewed package; the user reviews each diff, installs exact bytes, restarts secure OpenCode, and runs one reviewer Task. Agents never certify that gate.

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|
| 1 | RED tests plus bounded root/spawn/framing relay | PR 1 | `cd broker && bun test reviewer-relay-transport.test.ts` | N/A: protected plugin is not installed | Revert plugin/test slice |
| 2 | Lifecycle hooks, agents, and Task mapping | PR 2 | `cd broker && bun test reviewer-relay-transport.test.ts` | N/A until user installs S17 package | Remove relay agents and hook behavior |
| 3 | Docs, integration proof, and manual handoff | PR 3 | `cd broker && bun test` and `bun build src/main.ts` | User-run reviewer Task after install/restart | Revert docs and uninstall plugin/fragment |

## Phase 1: RED Contract and Security Tests

- [x] 1.1 Create `broker/tests/reviewer-relay-transport.test.ts` RED fakes/tests for session-root selection and every threat selector: exact canonical allowlisted root succeeds; relative, symlink/noncanonical, server, outside, and `git -C`-like roots refuse before spawn.
- [x] 1.2 Add RED tests for installed names bypassing, `asi-review-*` handling, binding-only prompt/materialized complete context, byte-preserved valid frames, malformed/extra/oversized frames, and missing `GENTLE_AI_REVIEW_CONTEXT_END` fail-closed.
- [x] 1.3 Add RED tests asserting fixed binary/argv, `shell:false`, allowlist-only environment, 4 MiB stdout/64 KiB stderr bounds, timeout termination, crash/abort/duplicate/disposal refusal, and no synthesized authority.

## Phase 2: Relay Core (RED → GREEN)

- [x] 2.1 Create `opencode/plugins/reviewer-relay-transport.ts` with pinned `gentle-ai.provider-transport/v1` NDJSON validation, exact frame forwarding, binding-only boundary, END-delimiter enforcement, and typed fail-closed errors.
- [x] 2.2 Implement canonical session resolution via `client.session.get`, versioned process-global immutable cache, broker `policy.projects`/`realpath` equality, exact allowlist root, and server-root inequality; never fallback to `directory`, `worktree`, cwd, or registry.
- [x] 2.3 Implement fixed `/home/linuxbrew/.linuxbrew/bin/gentle-ai review opencode-transport` spawn, piped stdio, `shell:false`, constructed HOME/XDG/locale environment, bounds, and finite 600-second deadline.
- [x] 2.4 Implement versioned `(sessionID,callID,agent)` owner/deferred/refused registry, four-concurrent cap, before/after state machine, half-close, cleanup/kill, isolation transform, and `session.created` agent-title decode.

## Phase 3: Wiring and Documentation

- [x] 3.1 Create `opencode/config-fragments/reviewer-relay-agents.jsonc` with six hidden, subagent-only, tool-less `asi-review-*` agents and counterpart models; mark manual installation.
- [x] 3.2 Amend `AGENTS.md` with lens→Task-name mapping while preserving provider lens/capture fields; amend `openspec/changes/agent-host-tools/design.md` Phase 6 as diagnostic-only.
- [x] 3.3 Update `docs/discovery-report.md` and `docs/manual-verification.md` with assets, S17 review/install/restart/one-Task gate, rollback, and prohibition on agent certification.

## Phase 4: Verification and Handoff

- [x] 4.1 Run `cd broker && bun test`; run `bun build src/main.ts`; verify only intended repo-local paths changed and no installed configuration was touched.
- [x] 4.2 Verify `reviewLensContext` diagnostic contract remains unchanged and transport is separate; record results without claiming manual completion.
- [x] 4.3 Stop at the reviewed package: candidate built and verified in-worker (`399 pass / 0 fail`), exported through `sandbox_finish`, and not applied because protected paths require the user's manual delivery.

> **Pending user-owned delivery handoff — not agent-certifiable:** Review the S17 diff, install/merge the exact plugin and fragment bytes, restart secure OpenCode, and run one `asi-review-risk` Task. Follow `docs/manual-verification.md` Gate 11; this handoff is intentionally non-blocking and is not an implementation checkbox.
