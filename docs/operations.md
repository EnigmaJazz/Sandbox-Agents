# Operations — broker, logging, metrics, troubleshooting

Status: the OpenCode V2 cutover is complete (owner-attested, before
2026-11-01): V2 2.2.2 is the working build at 127.0.0.1:4097, served by
`secure-opencode-v2.service` under `opencode-v2-secure` (owner-attested; see
`docs/upgrades/opencode-v2.md`). The repository sources for the launcher,
installer, rollback, health check and service template are verified below.
Whether the separate broker unit is installed is not asserted here.

## OpenCode V2 service

The unit template is `docs/secure-opencode-v2.service.template`; its
`ExecStart` runs `scripts/start-secure-opencode-v2`. The installer and rollback
scripts are `scripts/install-user-files-v2` and `scripts/rollback-v2`.

```sh
systemctl --user status secure-opencode-v2.service
journalctl --user -u secure-opencode-v2.service -n 50
bun scripts/check-v2-stack.ts
```

`check-v2-stack.ts` is read-only. Its supported options are `--server URL`,
`--opencode PATH`, `--password-file FILE` and `--wait SECONDS`; defaults and
behavior are documented in the script header. For rollback, stop V2 and start
the retained V1 unit, then preview the V2 file removal before applying it:

```sh
systemctl --user stop secure-opencode-v2.service
systemctl --user start secure-opencode.service
bash scripts/rollback-v2 --dry-run
bash scripts/rollback-v2 --apply
```

`rollback-v2` removes only files that still match the repository copy; it does
not remove V2 data, config or the password file. The installer's default mode
is dry-run; `bash scripts/install-user-files-v2 --apply` writes the reviewed V2
files. The scripts and accepted flags are defined in their source.

## Running the broker

```sh
# foreground (development)
cd broker && bun src/main.ts

# as a user service (when installed; scripts/install-user-files copies the unit)
systemctl --user daemon-reload
systemctl --user enable --now sandbox-broker
systemctl --user status sandbox-broker
journalctl --user -u sandbox-broker -f
```

Socket: `$XDG_RUNTIME_DIR/opencode-sandbox-broker.sock` (0600, user-only,
spec §6). State: `~/.local/state/opencode-sandbox/` (sessions, bundles,
patches, tmp — all 0700/0600).

## Logging (§26)

JSONL. Every operation logs: `ts, sessionID, agent, projectID, workerID,
operation, result, durationMs, error`. Exec payloads are logged as argument
**counts only** — never argv contents. `logging.ts#redact` strips
token/key/secret/password/credential-shaped assignments from any free text
that is logged.

Never logged, by construction: OAuth tokens, API keys, credential-containing
env vars, secret file contents.

Where: stdout by default; `--log-file PATH` (or `BROKER_LOG_FILE`) writes to
a 0600 file; the systemd unit routes to `journalctl --user -u
sandbox-broker`.

## Metrics

`sandboxctl metrics` (broker op `metrics`) reports: total/reserved CPU+RAM,
aggregate in-use, workers active/max, sessions-by-state, budget exhaustion.
Also `sandboxctl doctor` for socket health + pool state.

## Inspecting state

- `sandboxctl list` — workers
- `sandboxctl status <session>` — session state machine
- `sandboxctl diff <session>` — B..C delta
- `sandboxctl keep <session>` / `discard <session>` / `stop <session>` —
  §20 result options and worker teardown (interactive confirmation where
  destructive)

## Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| `broker not reachable (fail closed)` | broker not running / socket path mismatch | `sandboxctl doctor`; check unit: `systemctl --user status sandbox-broker`; confirm `BROKER_SOCKET` matches |
| `session X is FAILED_CLOSED` | worker creation or snapshot failure | read the session's `error` field (`sandboxctl status`); fix root cause (msb image present? disk full? pool exhausted?); broker state is terminal — manual intervention required (recovery.md) |
| `host project diverged from baseline (S16)` | host tree changed after worker creation | deliberate: automatic apply refused; decide: reconcile + `sandboxctl apply` again, or `discard` |
| `resource request above policy` | model tried to choose resources | expected: broker-side policy (§7, §11); nothing to fix |
| `patch does not apply cleanly` | stale baseline or malformed patch | re-baseline (new session) or adjust patch in worker |
| `msb create failed` | msb not installed / image missing / KVM issue | `msb doctor`; `msb image list`; ensure `debian` image cached (Gate 3) |
| `env key ... rejected (S8/S9)` | model tried to set credential env | expected: allowlist enforcement |

## Safety rails

- Never run `msb` commands with user-supplied image/network/security options
  — the broker constructs every vector from policy.
- The broker has NO host-mutation API (v1). If an agent asks for host
  changes, the answer is a manual user action (spec §9).
- Log rotation: JSONL grows; add logrotate for the log file / rely on
  journald for the unit logs.
