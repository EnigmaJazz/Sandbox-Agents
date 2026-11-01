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
- **OpenCode plugins** (`opencode/plugins-v2/`): V2 adapters and guard for the
  working OpenCode V2 stack; shared host-neutral plugin logic remains under
  `opencode/plugins/lib/`. V1 sources under `opencode/plugins/` are retained
  for rollback.
- **nono** (`nono/`): V2 profile `opencode-v2-secure` confines the working
  OpenCode server; the V1 `opencode-secure` profile is retained for rollback.
- **Launchers + units** (`scripts/`, `docs/`): V2 server on 127.0.0.1:4097,
  V2 systemd template, installer and rollback; the V1 server on port 4096 is
  retained only for rollback.
- **CLI** (`cli/sandboxctl`): doctor/list/status/metrics/diff/keep/discard/
  stop/cleanup; apply requires interactive confirmation (§25).
- **Tests**: `broker/tests` (offline unit tests incl. the §28 attack table),
  `tests/integration|security|acceptance` (gated suites, skipped by default).

## Deployment status

The OpenCode V2 cutover is complete (owner-attested, before 2026-11-01):
V2 2.2.2 is the working build, served on 127.0.0.1:4097 by
`secure-opencode-v2.service` under the `opencode-v2-secure` nono profile.
V1 1.18.33 on port 4096 is retained only for rollback. See
[`docs/upgrades/opencode-v2.md`](docs/upgrades/opencode-v2.md) for repository
status and [`docs/manual-verification.md`](docs/manual-verification.md) for
user-owned manual gates. Agents do not self-certify gates.

## Quick start (verification only)

```sh
cd broker && bun test        # offline unit suite; no msb/nono/opencode needed
bun build --target=bun src/main.ts --outdir /tmp/build-check
cd ..
nono profile validate nono/profile/opencode-secure.json  # retained V1 rollback profile
nono run --dry-run --profile nono/profile/opencode-secure.json -- true
```

## Layout

```
AGENTS.md  README.md  SECURITY.md  .gitignore
broker/    broker/src   broker/tests      # broker + unit tests
cli/                                       # sandboxctl
opencode/  plugins/  plugins-v2/  tools/  prompts/  config-fragments/
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
