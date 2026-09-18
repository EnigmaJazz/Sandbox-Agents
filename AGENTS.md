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

## Reviewer relay transport (lens → Task name)

Native 4R review runs through the in-repo reviewer relay transport
(`opencode/plugins/reviewer-relay-transport.ts`) plus the reviewed agent
fragment (`opencode/config-fragments/reviewer-relay-agents.jsonc`). Both are
S17 paths: the USER reviews the diff and installs the exact bytes by hand.

A reviewer Task MUST target the `asi-review-*` subagent name for its lens:

| Lens | Task `subagent_type` |
|---|---|
| `review-risk` | `asi-review-risk` |
| `review-resilience` | `asi-review-resilience` |
| `review-readability` | `asi-review-readability` |
| `review-reliability` | `asi-review-reliability` |
| `review-refuter` | `asi-review-refuter` |
| `review-validator` | `asi-review-validator` |

The installed `REVIEW_AGENTS` names (`review-risk`, `review-resilience`,
`review-readability`, `review-reliability`, `review-refuter`,
`review-validator`) belong to the installed transport. The `asi-review-*` set is
strictly disjoint from it, so each Task is handled by exactly one transport.

Provider-issued review fields are unchanged. Lens values stay
`review-risk|review-resilience|review-readability|review-reliability` inside
provider continuations, and every capture argument — target, lineage, expected
revision, repository context, subject hash, lens, order, and the
provider-returned `materialize`/`execute` flags — remains provider-issued and is
forwarded byte-for-byte. The relay substitutes only the Task `subagent_type`; it
never synthesizes or rewrites a provider token, lineage value, or authority.
`reviewLensContext` / `host_review_lens_context` stays a read/diagnostic
primitive and is not the reviewer transport.

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
