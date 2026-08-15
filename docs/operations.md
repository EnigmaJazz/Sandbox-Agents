# Operations — broker, logging, metrics, troubleshooting

Status: **Gate 1** — none of this is live yet. These procedures apply once
the broker runs as the user systemd service (Gate 4+).

## Running the broker

```sh
# foreground (development)
cd broker && bun src/main.ts

# as a user service (after Gate 4 review; scripts/install-user-files copies the unit)
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
