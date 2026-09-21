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

## Direct project-document mutation (`planDocAppend`)

**Boundary**: the broker can append to exactly two project documents —
`docs/TODO.md` (`doc: "todo"`) and `docs/PLAN.md` (`doc: "plan"`). It is the
first broker operation that writes a project file directly instead of spawning
a fixed-argv CLI.

**Invariants**

- No caller path/cwd/binary/argv: `doc` is an enum, and the two destinations
  are compile-time constants joined beneath the canonical approved root.
- Append-only: existing bytes are read, preserved verbatim and ordered, and
  the trimmed block is appended (EOF or before the next equal/higher ATX
  heading). There is no overwrite, truncate, replace, or delete input.
- Bounded: content is trimmed, 1..16384 UTF-8 bytes, LF-only; the optional
  heading is 1..256 bytes and control-free.
- Atomic and serialized: per-destination lock, sibling `O_CREAT|O_EXCL` temp
  file, fsync, close, revalidate destination/parent, rename, directory fsync;
  temp files are removed on every failure path.
- Path safety: destination and its real parent must resolve beneath the
  canonical root; symlinked/non-regular existing destinations are rejected
  before and immediately before the rename; protected/S17 destinations are
  rejected before any I/O.
- Authority: orchestrator-only mutation + fragment `ask` + metadata-rich
  in-tool `ctx.ask` before the broker call.

**Residual risk**: the broker writes Markdown inside the project, so a
compromised approval could append misleading plan content. The two destination
constants and byte/heading caps bound the blast radius; the files are not
executable and not on the S17 list.
## Host project registration (`host_register_project`) and S17 rollout

**Boundary**: `registerProject` is an orchestrator-only broker mutation that
runs the existing fixed-argv operator tool
`bun scripts/register-project.ts [--dry-run] [--create-remote] [--public] <path>`.
The broker accepts exactly `{path,dryRun,createRemote,makePublic}` and rejects
every other key.

**Invariants**

- Authority: orchestrator-only mutation (broker `HOST_MUTATION_OPERATIONS` +
  `authorizeHostDispatch`); broker authorization is authoritative, and a
  non-orchestrator call is denied before any spawn.
- Path ban before spawn: the target must be an existing absolute directory that
  is neither `/`, `$HOME`, nor beneath
  `$HOME/.ssh|.config|.local|.cache|.gnupg|.aws|.kube`, `/etc`, `/usr`, `/var`,
  or `/tmp`. An ineligible path or an invalid flag combination
  (`--public` without `--create-remote`) fails validation with NO process
  spawned.
- Fixed argv only: no caller-supplied cwd, binary, or argv; the script path is
  a broker-owned constant.

### Per-project profile grants written by registration

Registration grants each project three entries in
`nono/profile/opencode-secure.json`: the project tree stays `read`
(`filesystem.read`), while `<project>/.atl` and `<project>/.codegraph` are
`filesystem.allow` (read-write) metadata caches. It also grants
`<project>/.git` read-write.

**`.git` read-write is a deliberate, earned boundary decision.** It is broader
than the `.atl`/`.codegraph` metadata grants because `.git` is refs, index, and
history — not a tool cache. It exists because the native reviewer transport
resolves the opaque repository-context binding only through Git's registered
sibling worktrees and then keeps all authority, materialization, and capture
operations on that root
(`internal/cli/review_opencode_transport.go:328-334`). Without the grant the
transport child exits `binding_invalid`; with only `<project>/.git/gentle-ai`
read-write it stops at `materialization_unavailable`; with `<project>/.git`
read-write it materializes the provider prompt. The project tree itself is
never granted read-write, and unrelated profile entries are never rewritten.

Registration never creates `.git`: a synthesized `.git` would be a broken Git
directory. `git init -b main` runs before the profile writers, so `.git`
normally exists; when it does not, the grant is skipped with a warning because
nono binds grants to paths that exist at sandbox start. `<project>/.codegraph`
is created because nono cannot create it, exactly as `.atl` already is.

**S17 protected-path review**: registration mutates live host configuration
that sits on or beside the S17 set — `nono/profile/opencode-secure.json`,
`$HOME/.config/opencode-sandbox/broker.env`, and
`scripts/secure-launcher.conf`. Any agent-produced change under
`broker/src/**`, `nono/profile/**`, `systemd-user/**`, `opencode/plugins/**`,
`opencode/config-fragments/**`, `scripts/**`, `tests/security/**`,
`tests/acceptance/**`, or this document is rejected at apply time and requires
explicit manual review.

**`.new` staging / apply-review rollout**: S17 targets are never installed by
an agent. Candidate files are staged as `<target>.new` OUTSIDE the live paths,
the user reviews the diff, and only then copies the file into place and
restarts the affected service(s). `sandbox_finish` exports the result bundle;
`sandbox_apply` presents the diff and blocks for explicit human approval; a
denial or failed apply retains the result unchanged. Rollback stops before the
copy, or restores the prior files.

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

## Review lifecycle host tools (host-review-lifecycle)

The nine `host_review_*` tools are orchestrator-only mutations with fragment
`ask` plus an in-tool `ctx.ask`. Provider-issued tokens (target, lineage,
expected revision, repository context, subject/request hash, lens, contract,
policy, trace, attestation, release values) are validated only and passed
byte-for-byte into their fixed argv positions; the broker never reconstructs,
reorders, or defaults them. `reviewRecover.maintainerAuthorization` is
validated as LF-only JSON and forwarded verbatim, and it is never echoed into
approval metadata (only "present (redacted)").

`reviewCaptureResult.input` is a project-relative path or the literal `-`.
For a path, the broker snapshots a regular file of at most 512 KiB into the
broker-private `${stateDir}/review-input/` directory (mode `0600`,
`O_CREAT|O_EXCL`, random name), passes that absolute private path as
`--input`, and unlinks it in a `finally` on success, nonzero exit, timeout,
or spawn failure. Stale snapshots are removed when the executor is
constructed. The staging directory lives OUTSIDE the project tree, so it
cannot change the repository's untracked inventory. Literal `-` forwards
explicit EOF with no staging; inline result bytes are not a supported
transport.

Residual risk: the caller supplies the project-relative input path, so a
compromised orchestrator can ask the broker to read any regular file beneath
the approved root and hand it to `gentle-ai`; the 512-KiB cap and canonical
root check bound that disclosure. Verification must still resolve the exact
`review acknowledge-approved` flag set against the installed binary before
any flag is added.
