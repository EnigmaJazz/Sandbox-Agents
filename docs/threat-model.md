# Threat model — Agentic Sandbox Integration

Status: **Gate 1**. Assumes the OpenCode model is MALICIOUS (spec §29
adversarial review posture). Every invariant S1–S17 is mapped to its
mitigation, followed by the §29 checklist as the review guide.

## Threat model summary

**Assets**: host filesystem (esp. credentials), host services (systemd,
tailscale, docker), OAuth store, the user's git working tree, the broker
itself, the security configuration (S17).

**Attacker**: the LLM model + anything it controls (worker code, malicious
git objects, crafted tool arguments). NOT the local user — the broker socket
is user-only by construction (§6), so threat model assumes same-UID trust
boundary between broker and OpenCode process; session IDs are opencode-issued.

## S1–S17 → mitigations

| # | Invariant | Mitigation (code / config / gate) |
|---|---|---|
| S1 | No arbitrary project code on host | Ordinary `bash` denied in permissions fragment + routing-guard blocks bash/edit/write/apply_patch; broker has **no** generic host-shell op (S10). All execution goes to msb workers. |
| S2 | Writes only in worker until acceptance | `sandbox_*` write ops target the worker repo only; host working tree only ever touched by `git apply` of an approved B→C delta (§19.9). |
| S3 | Reads before activation on host | routing-guard allows read/grep/glob/list while `workerStatus` reports HOST_READ_ONLY. |
| S4 | First mutation activates worker | Plugin calls `ensureWorker` on write/edit/apply_patch/bash; broker transitions HOST_READ_ONLY→CREATING_SANDBOX→SANDBOX_ACTIVE. |
| S5 | Reads switch after activation | routing-guard `tool.execute.before`: SANDBOX_ACTIVE/RESULT_READY ⇒ project-path reads throw the redirect error; broker state is authoritative. |
| S6 | External read roots only | `canonicalizeWithinRoots`: realpath + prefix-boundary check; symlink escape rejected (unit-tested). Approved roots are explicit config, never whole-home. |
| S7 | Sensitive paths protected | OpenCode permission denies (`auth.json`, `.ssh/**`, `.gnupg/**`, `.aws/**`, `.kube/**`, gcloud, gh hosts.yml, `.env*`, keys) + broker `protectedPaths` (S17 set too) + nono denies non-overlapping stores. |
| S8 | OAuth never enters workers | No auth file copy; exec env allowlist with credential-key rejection; worker secret conf is empty; broker never forwards credentials. |
| S9 | Provider creds stay out of workers | Same env allowlist + credential-shape key rejection (unit-tested). |
| S10 | No generic host shell | Broker exposes only structured read-only host ops (fixed argv, readOnly flags, unit-tested). Host mutation = manual user step. |
| S11 | Workers cannot request host access | Payload exact-key allowlists reject image/mounts/privileged/devices/network/securityProfile (unit-tested §28). msb conf files generated from broker policy only. |
| S12 | Worker network deny-by-default | net.conf placeholder deny at Gate 1; final allowlist net-conf generated at Gate 3; LAN/metadata/socket access excluded; msb `--net-conf` from policy. |
| S13 | Session isolation | sessionID → exactly one worker; per-session lock serializes transitions; worker names derived from sessionID. |
| S14 | Fail closed | Every error path returns an error; FAILED_CLOSED terminal state; no host fallback anywhere; guard also fails closed when broker unreachable. |
| S15 | No direct worker→host write path | Result crosses via git bundle → import under `refs/opencode-sandbox/result/<id>` → apply is broker-side, gated. |
| S16 | Divergence detected | `computeDivergence` (baseline tree vs current host tree) before apply; refusal retains result (unit-tested). |
| S17 | Config cannot modify itself | `protectedSecurityFiles` globs (broker src, nono profile, plugins, fragments, systemd unit, scripts, security/acceptance tests, threat model) rejected in apply; changes require manual review. |

## Residual risks (honest, Gate 1)

1. **auth.json is process-accessible** (required by §16 for OAuth) — only the
   OpenCode permission layer + guard prevent model reads. An opencode
   permission bypass (e.g. `external_directory: allow`, bug in rule engine)
   would expose it. Mitigation: fragment denies + periodic audit; keep
   `read` deny list current.
2. **Broker trust boundary is same-UID**: any process running as the user can
   talk to the socket (0600 user-only). Workers are isolated by msb, not by
   OS-level user separation — a worker escape would be a host-UID compromise.
3. **msb config schema drift** (0.6.9 today): sparse conf files generated at
   runtime must be re-validated at Gate 3 against `msb create --help`.
4. **git apply surface**: apply is working-tree-only, but a crafted diff can
   still touch files the broker's protected-path globs don't cover —
   protected-path list must be maintained.
5. **Sandbox_bash tokenizer**: not a shell; model commands relying on pipes
   fail loudly (good), but the tokenizer is client-side — the broker's argv
   validation is the enforcement point.
6. **nono Linux Landlock**: no deny-within-allow — profile must stay narrow;
   a too-broad grant at Gate 2 review weakens S7 at the process layer.

## §29 adversarial checklist (review guide for the reviewer agent)

Assume the OpenCode model is malicious. Investigate, in order:

path traversal · symlink attacks · TOCTOU (snapshot→apply window) · command
injection · argument injection · environment injection · Git hooks (baseline
bundle could carry hooks — verify worker repo init disables them) ·
.git/config (worker must not gain host config) · credential helpers · SSH
agent socket · Docker socket · Unix sockets · /proc · /sys · device access ·
network pivoting · metadata endpoints · broker authentication (same-UID) ·
session spoofing (plugin-supplied sessionID) · cross-session access ·
worker reuse · result-bundle attacks (malformed bundles, ref smuggling) ·
malicious Git objects · submodules · symlink result application · S17
self-modification · OpenCode permission bypass · failure-open behaviour.

Each finding: severity (high/critical must be resolved before final
acceptance, §29), evidence, suggested fix, owning gate.

## Reporting process

Security issues: open an issue in the repository or tell the repository owner
directly (this repo has no public tracker configured). Include: affected
gate, invariant (S#), reproduction, impact, suggested fix. Do not include
credential material in any report.
