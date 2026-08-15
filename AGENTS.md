# AGENTS.md — rules for AI agents working in this repository

This repository implements **security infrastructure** (SYSTEM_PROMPT.md).
Every agent session working here must follow these rules.

## Absolute constraints

1. **Create/modify files ONLY inside this repository.** No changes to
   `~/.config`, `~/.local/share`, `~/.config/nono`, systemd units, or any
   live OpenCode/nono/systemd configuration. No `sudo`. No installs.
   The only sanctioned host-side commands are read-only diagnostics and
   `bun test` inside `broker/`.
2. **Never commit, print, or log credentials** — OAuth tokens, API keys,
   passwords, or secret file contents (§26).
3. **Never self-certify a manual gate.** Gates 0–10 (docs/manual-verification.md)
   are completed by the USER. Agents generate code and tests; users approve.

## S17 — security components agents must never modify

Agent-produced changes (e.g. a sandbox result) that touch any of these are
rejected at apply time and require explicit manual review:

- `broker/src/**` (broker implementation + policy)
- `nono/profile/**`, `systemd-user/**`
- `opencode/plugins/**`, `opencode/config-fragments/**`
- `scripts/**`, `tests/security/**`, `tests/acceptance/**`
- `docs/threat-model.md`

## Working style

- English for all artifacts (code, docs, comments).
- Security style (spec §30): explicit types, allowlists, canonical-path
  checks, argv-vector process spawning (no shell strings), atomic state
  writes, no `eval`, no implicit fallback. If you find yourself building a
  shell string — stop and use an argv vector.
- Broker code must stay dependency-free: `bun:test` + node builtins only, so
  `bun test` works offline.
- Before committing: `cd broker && bun test` must be green. Run `bun build
  src/main.ts` to verify compilation. Do not run gated suites
  (`SANDBOX_GATED_TESTS=...`) unless the environment actually supports them.
- Do not invent facts: verify commands before documenting them; never claim
  a test passed that did not run.
- Later-gate artifacts (nono profile, systemd unit, plugins, scripts,
  config fragments) carry a header comment stating they are NOT installed
  and which gate unlocks them.

## Reporting

Security findings: open an issue or tell the repository owner directly
(see SECURITY.md). Never include credentials in reports.
