# Agentic Sandbox Integration

Safe agent-execution architecture around the existing OpenCode + Gentle-AI +
OpenChamber environment, per the specification in `SYSTEM_PROMPT.md`.

**Core policy** (§1):

> Host reads are permitted within approved read roots. Project writes and
> arbitrary code execution automatically occur inside a transient Microsandbox.
> Host mutation requires explicit human approval.

## Architecture summary

- **Broker** (`broker/`, Bun + TypeScript, no dependencies): trusted policy
  and worker lifecycle on a user-only Unix socket — session state machine
  (§10), resource budget (§22), `msb` adapter with argv vectors (§6),
  git snapshot/result boundary (§17–§20: synthetic baseline under
  `refs/opencode-sandbox/baseline/<sessionID>`, results under
  `.../result/<sessionID>`), structured read-only host API (§8).
- **OpenCode plugins** (`opencode/plugins/`): explicit `sandbox_*` tools with
  lazy activation (§11–§12) + routing guard that fails closed after
  activation (§13) + permission fragment (§14).
- **nono** (`nono/`): child profile `opencode-secure` sandboxing the host
  OpenCode process (control dir RW, project roots RO, §15).
- **Launchers + unit** (`scripts/`, `systemd-user/`): secured
  `opencode serve` on 127.0.0.1:4096, OpenChamber attach (§23), broker
  systemd user unit (§24), idempotent installer + rollback.
- **CLI** (`cli/sandboxctl`): doctor/list/status/metrics/diff/keep/discard/
  stop/cleanup; apply requires interactive confirmation (§25).
- **Tests**: `broker/tests` (offline unit tests incl. the §28 attack table),
  `tests/integration|security|acceptance` (gated suites, skipped by default).

## Gate status (§27)

| Gate | Title | Status |
|---|---|---|
| 0 | Discovery complete | ✅ done (docs/discovery-report.md) |
| 1 | Code generated, nothing installed | **current — ready for user review** |
| 2 | nono profile generated and validated | pending |
| 3 | Microsandbox manually verified | pending |
| 4 | Broker passes unit/security tests | pending |
| 5 | Throwaway-project lazy sandbox test | pending |
| 6 | Git result round-trip | pending |
| 7 | OpenAI OAuth/subagent isolation | pending |
| 8 | Parallel worker isolation | pending |
| 9 | OpenChamber integration | pending |
| 10 | Adversarial security acceptance | pending |

Agents do not self-certify gates (docs/manual-verification.md).

## Quick start (verification only)

```sh
cd broker && bun test        # 87 unit tests, no msb/nono/opencode needed
bun build src/main.ts --outdir /tmp/build-check
nono profile validate nono/profile/opencode-secure.json
nono run --dry-run --profile nono/profile/opencode-secure.json -- true
```

## Layout

```
AGENTS.md  README.md  SECURITY.md  .gitignore
broker/    broker/src   broker/tests      # broker + unit tests
cli/                                       # sandboxctl
opencode/  plugins/  tools/  prompts/  config-fragments/
nono/      profile/
systemd-user/
scripts/                                   # launchers, installer, rollback
tests/     unit/  integration/  security/  acceptance/
docs/      architecture  threat-model  operations  recovery  manual-verification
```

## Docs

- `docs/architecture.md` — components, data flow, state machine, snapshot/result flow
- `docs/threat-model.md` — S1–S17 mitigations + §29 adversarial checklist
- `docs/operations.md` — broker ops, logging, metrics, troubleshooting
- `docs/recovery.md` — divergence/FAILED_CLOSED/corruption/rollback
- `docs/manual-verification.md` — Gates 0–10 checklists
- `docs/discovery-report.md` — verified host facts
