# Architecture — Agentic Sandbox Integration

Status: **OpenCode V2 cutover complete (owner-attested, before 2026-11-01).**
The working build is V2 2.2.2 on 127.0.0.1:4097 under
`secure-opencode-v2.service` and the `opencode-v2-secure` nono profile
(owner-attested; also recorded in `docs/upgrades/opencode-v2.md`). V1 1.18.33
on port 4096 is retained only for rollback (same source). Manual gate
sign-off remains user-owned; see `docs/manual-verification.md`.

## Components

```text
                         HOST
                           │
              ┌────────────┴────────────┐
              │                         │
           nono                    sandbox broker (Bun, Unix socket)
           (opencode-v2-secure          │
            profile)                    ├── msb worker A  (project X)
              │                         ├── msb worker B  (project Y)
          OpenCode V2 serve             └── msb worker C
          (127.0.0.1:4097)                     │
              │                                └─ git baseline B → edits → result C
      ┌───────┼──────────┐                     (refs/opencode-sandbox/baseline|result)
      │       │          │
 orchestrator  subagents  host-read tools
      │       │
      └───────┴── model calls stay in host OpenCode (OAuth stays in host, S8)
```

| Component | Where | Responsibility | Spec |
|---|---|---|---|
| `broker/` (Bun TS) | `~/.local/state/opencode-sandbox` state; socket `$XDG_RUNTIME_DIR/opencode-sandbox-broker.sock` (0600) | Trusted policy: session state machine, resource budget, worker lifecycle, git snapshot/result boundary, structured host reads | §6–§10, §17–§22, §26 |
| `opencode/plugins-v2/` | V2 plugin sources; installed under the V2 config root by `scripts/install-user-files-v2` | V2 sandbox tools and routing guard | §11–§14 |
| `opencode/plugins/lib/` | Shared host-neutral plugin logic | Tool specs and broker client shared by the V1 and V2 adapters | §11–§14 |
| `nono/profile/opencode-v2-secure.json` | V2 profile source; installed under `~/.config/nono/profiles/` | Constrains the working OpenCode V2 server | §15 |
| `scripts/start-secure-opencode-v2` | V2 launcher, used by the service template | Starts V2 on 127.0.0.1:4097 under the V2 profile | §15, §23 |
| `docs/secure-opencode-v2.service.template` | User-reviewed V2 unit template | Runs the V2 launcher as a user service | §24 |
| `scripts/install-user-files-v2` / `scripts/rollback-v2` | V2 install and rollback pair | Installs reviewed V2 files or removes unchanged repo copies | §27 |
| `scripts/start-secure-opencode` and `nono/profile/opencode-secure.json` | V1 rollback sources | Retained for rollback; V1 serves port 4096 | §15, §23 |
| `scripts/start-openchamber-v2` | V2 launcher, if OpenChamber 2 is attached | Attaches OpenChamber to the existing V2 server, not a second server | §23 |
| `systemd-user/sandbox-broker.service` | Broker user-unit source | Keep the broker alive; restart on failure. Installed state is not asserted here. | §24 |
| `cli/sandboxctl` | user | Broker inspection/ops; apply requires interactive confirmation | §25 |

## Data flow (per OpenCode session)

1. **HOST_READ_ONLY** — reads/grep/glob/list run against the host project
   (S3). Zero workers exist.
2. **First mutation/execution** (any `sandbox_write/edit/apply_patch/bash`,
   or later `run_tests/build/install` wrappers) → `ensureWorker(sessionID,
   projectDir)` (S4, §11):
   - broker validates sessionID/projectDir against the **trusted allowlist**
     (§7 — no arbitrary host paths);
   - admission check against the pool budget (§22: ≥25% CPU/RAM reserved,
     never the last 4 GiB; reject when exhausted);
   - state → CREATING_SANDBOX;
   - **snapshot** (§17): temporary `GIT_INDEX_FILE` + `git add -A` +
     `write-tree` + `commit-tree -p HEAD` → synthetic baseline **B** under
     `refs/opencode-sandbox/baseline/<sessionID>`; bundle transferred into the
     worker. User branch and real index untouched.
   - worker created from the **fixed trusted image** (LLM never chooses it,
     S11) with policy resources and deny-by-default network (S12);
   - state → SANDBOX_ACTIVE.
3. **Work** — `sandbox_*` file/exec ops go to the SAME worker (worker reuse,
   §28); every request passes the §28 attack table (argv vectors only, no
   resource-request fields).
4. **Finish** — `sandbox_finish` → worker exports a bundle of result ref
   **C**; broker verifies + imports under
   `refs/opencode-sandbox/result/<sessionID>` (§18); state → RESULT_READY.
5. **Apply** — `sandbox_apply` (user approval via `ctx.ask()`; §19.9) →
   state APPLY_PENDING →
   1. **S16 divergence check**: host tree vs baseline B — on divergence,
      refuse and retain the result for reconciliation;
   2. changed-path inspection: reject protected paths (S7/S17), unsafe
      symlink changes, submodule changes (§19.3–5);
   3. `git apply --check` then `git apply` (working tree only — index and
      branch untouched) → state APPLIED.
6. **Reject** — `sandbox_discard` → worker destroyed, result ref deleted,
   state REJECTED (§20).
   **Keep** — `sandboxctl keep` → worker destroyed, result ref retained for
   inspection, state RETAINED (§20).

## State machine (§10)

```text
HOST_READ_ONLY ──first mutation──▶ CREATING_SANDBOX ──success──▶ SANDBOX_ACTIVE
                                      │ failure                     │ finish
                                      ▼                             ▼
                                  FAILED_CLOSED ◀─any failure── RESULT_READY ──accept──▶ APPLY_PENDING ──▶ APPLIED
                                                                   │ reject                     │
                                                                   ▼                            ▼
                                                                REJECTED                    RETAINED
```

State is persisted as atomic JSON per session (`sessions/<sessionID>.json`)
and survives broker restarts. State is NEVER inferred from a worker name
(§10). FAILED_CLOSED is terminal (S14).

## Trust boundaries

- **Broker is trusted** (policy, allowlists, git boundary). It runs outside
  nono (spec §6), as the user, on a 0600 Unix socket.

### Why the broker is a user service, not a root/system service (2026-08-16)

Decision (user-confirmed): the broker stays a `systemd --user` unit; it is
NEVER promoted to a root/system service.

- **No privilege is needed**: KVM is user-granted (`msb doctor` read/write for
  the user, Gate 3), the socket lives in `$XDG_RUNTIME_DIR` (0600 user-only —
  a property a root service could not preserve), and state lives in the
  user's home.
- **Least privilege**: the broker parses UNTRUSTED NDJSON from model-driven
  sessions — its input is the attack surface this system defends. A
  user-level compromise equals the user account (the broker's own trust
  boundary, since it applies the user's project deltas). A root broker
  would make the same compromise a full host takeover.
- **systemd --user already provides** restart-on-failure, `journalctl --user`
  logging, and boot enablement (linger); a system unit adds nothing except
  elevation.
- **Future host-admin automation** (S10 host mutation, e.g. `systemctl
  restart` on user request) must be built as a SEPARATE narrow root helper
  with a fixed API (or polkit) — never by elevating the broker.
- **OpenCode is constrained by nono** (control dir RW, projects RO) and by
  OpenCode permissions (no host bash/edit/write; secret-read denies).
- **Workers are untrusted** (run LLM code): no host mounts, no Docker socket,
  no devices, no arbitrary images, no LAN, no credentials (S8/S9/S11/S12).
- **Result path is the only write channel** worker → host, and it is gated:
  divergence check, protected-path checks, `git apply --check`, human
  approval (S15/S16, §19).

## Fail-closed paths (S14)

Broker down · worker creation failure · snapshot failure · validation
failure · state inconsistency — every one of these FAILS the operation. There
is no code path that falls back to host execution.
