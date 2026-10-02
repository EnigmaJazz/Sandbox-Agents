# gentle-ai 4 pre-upgrade: SDD dormancy (steps 1–2)

## Objective

Make the five SDD broker operations and `host_sdd_*` plugin tools dormant, so that upgrading
to gentle-ai 4.0.0 (which removes `sdd-*` subcommands) needs no code change. Keep the code
whole, so a rollback to 3.x is configuration only. Plan: `docs/upgrades/gentle-ai-4.md`,
pre-upgrade steps 1–2.

## Problem

gentle-ai 4.0.0 removed `sdd-status`, `sdd-continue`, `sdd-attempt`, `sdd-archive-compose` and
`sdd-task-result`. The broker operations `sddStatus`, `sddContinue`, `sddTaskResult`,
`sddAttemptGrant` and `sddArchiveCompose`, and the plugin tools `host_sdd_status`,
`host_sdd_continue`, `host_sdd_task_result`, `host_sdd_attempt_grant` and
`host_sdd_archive_compose`, would fail at runtime against v4. Review operations share
`sdd-runtime.ts`/`sdd-service.ts` and must not be affected.

## Constraints

- Never delete SDD code, argv builders, approval builders or tests.
- No behaviour change on gentle-ai 3.7.0 with default settings. Broker: met by `auto`. Plugin: met by install timing; the T2 plugin change is installed on upgrade day, because the plugin can't detect the version at load time (see the plan's step 2).
- Fail closed: an unknown gentle-ai version disables SDD rather than enabling it.
- `broker/src/**` and `opencode/plugins/**` are S17: the user reviews and installs.
- Broker stays dependency-free (`bun:test` and node builtins only).

## Tasks

- [x] **T1 — Broker switch.**
  - `BROKER_LEGACY_SDD=auto|on|off` (default `auto`). `auto` enables SDD only when `gentle-ai --version` reports major < 4; an unreadable version disables it.
  - Resolved once at startup in `main.ts` and logged, with a warning when an explicit setting disagrees with the detected major.
  - The five SDD operations refuse with a typed `PolicyError` when disabled. Review operations are never gated.
  - `defaultConfig` defaults to disabled (fail closed); tests that exercise SDD set it explicitly.
- [x] **T2 — Plugin dormancy.**
  - Move the five `host_sdd_*` tool definitions to `opencode/plugins/lib/legacy-sdd-tools.ts`.
  - Register them only when `OPENCODE_SANDBOX_LEGACY_SDD=1`.
  - Approval builders unchanged.
- [x] **T3 — Permission fragment.**
  - Change the five live `host_sdd_*` entries to `deny`, keep the entries, and record rollback values in a comment.
  - Update the permission-fragment test and mark the role-agents SDD gate historical.
- [x] **T4 — Prompt and docs.**
  - Mark the `sandbox-rules.md` SDD section dormant and fix the retired tool name.
  - Move the manifest's `host_sdd_*` rows to a dormant table and correct the totals.
- [ ] **T5 — OpenSpec archive.**
  - Add a retirement line for `openspec/` to its README; mark `agent-host-tools` tasks 5.1–5.6 superseded.
  - Update the `docs/TODO.md` Tier 4 tail and mark upgrade-doc steps 3–5 done.

## Acceptance criteria

- With 3.7.0 and default settings, the SDD operations behave exactly as before.
- With a v4 binary, or `BROKER_LEGACY_SDD=off`, each of the five operations refuses with the dormancy message, while every review operation still dispatches.
- Without `OPENCODE_SANDBOX_LEGACY_SDD=1`, the plugin registers no `host_sdd_*` tool; with it, exactly the five return with unchanged argument schemas.
- `cd broker && bun test` green; `bun build src/main.ts` succeeds.

## Checks

- `cd broker && bun test`
- `cd broker && bun build src/main.ts --target=bun --outfile <scratch path outside the repo>`

## Route and delivery

- Route: direct inline (Claude Code orchestrator; small, understood edits per task).
- One work-unit commit per task on `feat/review-and-state-hardening`.
- TDD: not configured for this repository; behaviour tests are written with each task and shown failing before the change where meaningful.

## Progress

Started 2026-10-02.

- **T1 done.** New `broker/src/legacy-sdd.ts` (mode parsing, version detection, resolution, `assertLegacySddEnabled`). The gate is the first statement of the five SDD handlers in `sdd-service.ts`. `config.ts` adds `sddRuntime.legacySddEnabled`, defaulting to `false`. `main.ts` resolves and logs it at startup. `systemd-user/broker.env` documents `BROKER_LEGACY_SDD=auto`.
  - Tests: 16 new in `broker/tests/legacy-sdd-dormancy.test.ts`. They failed before implementation (module missing), then passed. `service-host-tools.test.ts` now sets `legacySddEnabled: true` explicitly, because it exercises the 3.x path.
  - Checks: `bun test` passed 600, 0 fail; `bun build src/main.ts` succeeded (output outside the repo).
  - Live: detection on the installed binary reads major 3, so `auto` enables SDD and there's no behaviour change on 3.7.0. A missing binary resolves to dormant, with a warning.

- **T1 committed** as `2c17837`.
- **T2 done.** The five `host_sdd_*` definitions moved to `opencode/plugins/lib/legacy-sdd-tools.ts` and are registered from `sandbox-tools.ts` only when `OPENCODE_SANDBOX_LEGACY_SDD=1`. The four SDD-only argument schemas moved with them; the shared revision schema, `client()` and the project-directory check are passed in. A script check confirms the moved bodies are identical to the originals apart from those three substitutions. `scripts/install-user-files` and `scripts/rollback` list the new file (the existing parity test caught the omission).
  - Tests: 5 new in `broker/tests/legacy-sdd-tools.test.ts`. They failed before implementation (module missing), then passed.
  - Checks: `bun test` passed 605, 0 fail. The plugin bundle builds (`bun build opencode/plugins/sandbox-tools.ts`, externals for the SDK and zod), and so does the broker.
  - Deviation: the plugin defaults to dormant even on 3.7.0, so it's installed on upgrade day (recorded in the plan).
- **T3 done and committed as `5e65f46`** (`chore(sdd): mark the five live host_sdd_* permissions dormant for gentle-ai 4`, 3 files, 12 insertions / 8 deletions).
  - The user ran the suite on the host; all tests passed.
- **T4 done.** The prompt marks host-side SDD dormant by default, identifies the exact legacy opt-in, and no longer advertises the retired `host_sdd_attempt_acquire`. The manifest now places all 13 `host_sdd_*` entries in its dormant table with `deny` permissions, cites `legacy-sdd-tools.ts` and `broker/src/legacy-sdd.ts`, and records the default total as 13 sandbox + 20 host = 33 tools (33 prior host entries − 8 already retired − 5 dormant by default).
  - Checks: `bun --cwd broker test --reporter=dot` passed 647, 0 fail. The requested `bun --cwd broker test` was also run; its detailed output was truncated by the tool.

## Next step

Both tasks are done. Remaining pre-upgrade steps 3–6 (permission fragment, prompt and docs, OpenSpec archive, rollback kit) are in `docs/upgrades/gentle-ai-4.md`.
