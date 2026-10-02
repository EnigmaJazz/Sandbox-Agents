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
- No behaviour change on gentle-ai 3.7.0 with default settings.
- Fail closed: an unknown gentle-ai version disables SDD rather than enabling it.
- `broker/src/**` and `opencode/plugins/**` are S17: the user reviews and installs.
- Broker stays dependency-free (`bun:test` and node builtins only).

## Tasks

- [x] **T1 — Broker switch.**
  - `BROKER_LEGACY_SDD=auto|on|off` (default `auto`). `auto` enables SDD only when `gentle-ai --version` reports major < 4; an unreadable version disables it.
  - Resolved once at startup in `main.ts` and logged, with a warning when an explicit setting disagrees with the detected major.
  - The five SDD operations refuse with a typed `PolicyError` when disabled. Review operations are never gated.
  - `defaultConfig` defaults to disabled (fail closed); tests that exercise SDD set it explicitly.
- [ ] **T2 — Plugin dormancy.**
  - Move the five `host_sdd_*` tool definitions to `opencode/plugins/lib/legacy-sdd-tools.ts`.
  - Register them only when `OPENCODE_SANDBOX_LEGACY_SDD=1`.
  - Approval builders unchanged.

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

## Next step

T2.
