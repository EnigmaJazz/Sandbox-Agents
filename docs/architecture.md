# Architecture — Agentic Sandbox Integration

Status: **Gate 1 (code generated, nothing installed)** — see
`docs/manual-verification.md` for gate status. This document describes the
intended system per SYSTEM_PROMPT.md §6–§20.

## Components

```text
                         HOST
                           │
              ┌────────────┴────────────┐
              │                         │
           nono                    sandbox broker (Bun, Unix socket)
           (opencode-secure             │
            profile)                    ├── msb worker A  (project X)
              │                         ├── msb worker B  (project Y)
          OpenCode serve                └── msb worker C
          (127.0.0.1:4096)                     │
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
| `opencode/plugins/sandbox-tools.ts` | OpenCode plugin dir (Gate 2+) | Stage A `sandbox_*` tools; lazy activation | §11–§12 |
| `opencode/plugins/routing-guard.ts` | OpenCode plugin dir (Gate 2+) | Read routing after activation (S5); blocks host mutation tools; system-prompt rule injection | §13–§14 |
| `opencode/config-fragments/sandbox-permissions.jsonc` | merged manually | Permission deny/allow map; secret-read denies | §14 |
| `nono/profile/opencode-secure.json` | `~/.config/nono/profiles/` (Gate 2+) | Sandbox the host OpenCode process: control dir RW, project roots RO | §15 |
| `scripts/start-secure-opencode` | run by user | `nono run --profile opencode-secure -- opencode serve --hostname 127.0.0.1 --port 4096` | §15, §23 |
| `scripts/start-openchamber` | run by user | Attach OpenChamber to the existing secured server (never a second server) | §23 |
| `systemd-user/sandbox-broker.service` | user unit (Gate 4+) | Keep the broker alive; restart on failure | §24 |
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
