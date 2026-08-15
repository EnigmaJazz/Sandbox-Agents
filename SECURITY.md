# Security — invariants and reporting

This repository implements security infrastructure (SYSTEM_PROMPT.md §2).
The invariants below are the contract; the threat model
(`docs/threat-model.md`) maps each to its mitigation.

## S1 — No arbitrary project code executes on the host
## S2 — Project writes occur only inside a worker until acceptance
## S3 — Reads before activation may use the host
## S4 — First mutation/execution activates the worker
## S5 — Reads switch after activation (no stale host reads)
## S6 — External read-only data available only via approved roots
## S7 — Sensitive host paths are always protected (SSH, GPG, AWS, Kube, gcloud, OpenCode auth, .env)
## S8 — OAuth never enters workers
## S9 — Provider credentials stay outside workers
## S10 — Generic host shell is unavailable (v1)
## S11 — Workers cannot request host access (no mounts/devices/privileged/arbitrary images)
## S12 — Worker network is deny-by-default (final config)
## S13 — Session isolation: sessionID → one worker
## S14 — Fail closed: any failure fails the operation, never host fallback
## S15 — Result integration is controlled (git result boundary, no direct worker→host writes)
## S16 — Host divergence is detected before apply
## S17 — Security configuration cannot modify itself

## Reporting a vulnerability

- **Do not include credentials or secret contents in any report.**
- Preferred: open an issue in this repository (if a tracker is configured)
  or tell the repository owner directly.
- Include: affected gate/section, invariant (S#), reproduction steps,
  impact, and a suggested fix. High/critical findings must be resolved
  before final acceptance (§29).

## Scope notes

- Gate 1 status: code + configuration templates only — nothing is installed
  (`docs/manual-verification.md`).
- The broker socket is user-only (0600 in `$XDG_RUNTIME_DIR`); the threat
  model assumes a same-UID trust boundary between broker and OpenCode.
- `auth.json` must remain process-accessible for OAuth (§16); model-facing
  reads are denied at the OpenCode permission layer (S7).
