# Manual verification — Gates 0–10

Status: **Gate 1 done (code generated, nothing installed); Gates 0 done,
2–10 pending.** Per SYSTEM_PROMPT.md §27, each gate stops for the USER to
perform/review the checklist. Agents must never self-certify a manual gate.

## Gate 0 — Discovery ✅ (completed)

`docs/discovery-report.md` (2026-08-15): opencode 1.18.18, nono 0.73.0,
msb 0.6.9, OpenChamber 1.18.4, host 16 CPU / 29 GiB RAM, KVM OK, ports,
profiles, plugin API verified. **No changes were made during discovery.**

## Gate 1 — Code generated, nothing installed (THIS gate)

Verify:

```sh
cd /home/james/agent-sandbox-integration
git status                        # only repo-local changes
cd broker && bun test             # unit tests: must pass without msb/nono/opencode
bun build src/main.ts --outdir /tmp/build-check   # compiles
```

Checklist:

- [x] No files created outside this repository
- [x] No sudo/install/service/systemd/config changes performed
- [x] No credentials or tokens anywhere in the repo
- [ x] `bun test` passes (87 unit tests at Gate 1)
- [x] nono profile validates: `nono profile validate nono/profile/opencode-secure.json`
- [x] nono dry-run shows the intended capability table:
      `nono run --dry-run --profile nono/profile/opencode-secure.json -- true`
- [x] Review `docs/threat-model.md` residual risks
- [x] Approve → proceed to Gate 2

## Gate 2 — nono profile generated and validated

```sh
mkdir -p ~/.local/share/opencode-sandbox-control
scripts/install-user-files            # dry-run first; then review diffs
nono profile validate ~/.config/nono/profiles/opencode-secure.json
nono profile show opencode-secure
nono profile diff opencode-secure <everyday-profile>
nono run --dry-run --profile opencode-secure -- true
```

Checklist (user):

- [ ] Resolved capability table matches intent: control dir RW, project roots
      RO, provider domains + localhost proxy ports only
- [ ] Finalize placeholder grants (project roots, reference roots, domains)
- [ ] Approve and install (`install-user-files --apply`)

## Gate 3 — Microsandbox manually verified

**Status: PASSED (user-certified 2026-08-16)** — `scripts/gate3-msb-verify`
16/16 on both host environments. Findings resolved in `ef208e2`, `b837aa5`,
`9518d5b`, `b643dc1` (see findings below).

Drafted 2026-08-15 against msb v0.6.9 (verified via `msb create --tree` and
live Gate 3 runs). Values mirror the broker policy (`broker/src/config.ts`:
image `debian`, 2 vCPU / 2 GiB, deny-by-default network). Run via
`scripts/gate3-msb-verify` for PASS/FAIL output.

### Gate 3 findings resolved (2026-08-15)

1. **F1 /dev/kvm passthrough (S11):** msb exposes the HOST `/dev/kvm`
   (major:minor 10,232) into the guest, mode 600 root:root; `--rm /dev/kvm`
   does NOT remove it. Guest root can open it (nested KVM). **Mitigation:**
   the broker runs every worker command as `-u nobody` (non-root) — verified
   the guest node denies non-root opens. `broker/src/config.ts`
   `resource.workerUser`.
2. **F2 conf schemas (step 7 proof point):** the broker's generated confs were
   invalid for msb 0.6.9. Corrected shapes now locked by unit tests:
   - `runtime.conf`: `{"security":"restricted","workdir":"/work"}`
     (`capabilities` is not a field)
   - `net.conf`: `{"policy":"none"}` (enum `none|public|open`; `mode` is not
     a field)
   - `resource.conf`: `{"cpus":2,"memory":"2048M"}` (`cpus` plural;
     memory is a SIZE STRING)
   - `fs.conf`: `{}` (only `mounts|patch_files|patches`; no `workdir`)
   - `secret.conf`: `{}` (unwrapped — no `secrets` wrapper)
   - plus argv `--mkdir /work` (workdir must exist in the guest)
3. **F3 copy symlink policy:** `msb copy` refuses symlinks escaping the
   destination (`os-release -> ../usr/lib/os-release`) — security-positive;
   probes must copy regular files.
4. **Probe corrections:** debian image ships its own empty `/home` (probe
   `/home/james`); exec needs explicit `-w` (create-time `-w` is
   interactive-only); guest has own subnet routes by design (functional
   network check = reachability, e.g. `getent`).

```sh
# 0) Preconditions
msb doctor                          # all ✓; KVM read/write for user — UNCHANGED
msb image list                      # debian present (47 MiB)

# 1) Throwaway sandbox — CLI-flags form (proves msb itself + broker policy values)
mkdir -p /tmp/gate3
msb create -n gate3-smoke debian \
  -c 2 --max-cpus 2 -m 2G --max-memory 2G \
  --no-net -w /work --mkdir /work -H gate3-smoke

# 2) It is running
msb list | grep gate3-smoke
msb status gate3-smoke

# 3) Exec works; workdir is /work
msb exec gate3-smoke -- pwd                  # expect /work
msb exec gate3-smoke -- cat /etc/os-release

# 4) Isolation: the host is NOT mounted (S11)
msb exec gate3-smoke -- ls /home             # expect: no such dir
msb exec gate3-smoke -- test -e /dev/kvm && echo KVM-EXPOSED || echo KVM-NOT-EXPOSED
msb exec gate3-smoke -- test -S /var/run/docker.sock && echo DOCKER-EXPOSED || echo DOCKER-NOT-EXPOSED

# 5) Network deny-by-default (S12): guest routes are its own subnet; the
#    functional check is reachability
msb exec gate3-smoke -- sh -c 'wc -l < /proc/net/route'   # informational
msb exec gate3-smoke -- getent hosts 100.90.20.31        # expect failure/timeout

# 6) Copy round-trip (regular file — msb refuses symlink escapes)
msb exec -w /work gate3-smoke -- sh -c 'echo gate3 > /work/copy-probe.txt'
msb copy gate3-smoke:/work/copy-probe.txt /tmp/gate3/copy-probe.txt && cat /tmp/gate3/copy-probe.txt
msb copy /etc/hostname gate3-smoke:/tmp/hostname

# 7) Broker-shaped conf files — corrected schemas (see findings above)
printf '{"security":"restricted","workdir":"/work"}' > /tmp/gate3/runtime.conf
printf '{"policy":"none"}' > /tmp/gate3/net.conf
printf '{"cpus":2,"memory":"2048M"}' > /tmp/gate3/resource.conf
printf '{}' > /tmp/gate3/fs.conf
printf '{}' > /tmp/gate3/secret.conf
msb create -n gate3-conf-test debian \
  --conf /tmp/gate3/runtime.conf \
  --net-conf /tmp/gate3/net.conf \
  --resource-conf /tmp/gate3/resource.conf \
  --fs-conf /tmp/gate3/fs.conf \
  --secret-conf /tmp/gate3/secret.conf \
  -c 2 --max-cpus 2 --mkdir /work
msb status gate3-conf-test
msb exec -w /work gate3-conf-test -- pwd               # expect /work
# KVM mitigation: non-root guest user cannot open /dev/kvm
msb exec -u nobody gate3-conf-test -- sh -c 'exec 3<>/dev/kvm 2>/dev/null && echo KVM-OPENABLE || echo KVM-NOT-OPENABLE'

# 8) Cleanup
msb stop gate3-smoke gate3-conf-test
msb remove gate3-smoke gate3-conf-test
msb list                                      # empty
```

Checklist (user):

- [x] Worker image pinned in broker config; LLM cannot choose (S11) —
      `broker/src/config.ts` `workerImage`; `msb.ts` never accepts a caller image
- [x] Network deny-by-default confirmed (no LAN/metadata/socket) — steps 1/5/7
- [x] `/dev/kvm` access unchanged (already user-accessible per discovery) — step 0
- [x] Step 7 conf-file create succeeds (broker schema proof point)

## Gate 4 — Broker unit/security tests

```sh
cd broker && bun test
SANDBOX_GATED_TESTS=security bun test tests/security/   # broker live
```

Checklist:

- [x] All unit tests pass
- [x] Security suite passes (secret protection, OAuth absence, host escape,
      LAN isolation, fail closed, divergence, argument attacks)
- [x] Plugins loaded in opencode: verify `tool` hook + `ctx.ask()` signature
      against installed 1.18.18 (plugins/README.md)
- [ ] systemd unit reviewed and enabled (user action):
      `systemctl --user enable --now sandbox-broker`

## Gate 5 — Throwaway-project lazy sandbox test

**Status: prepared 2026-08-16** — implementation in `21ff185`; integration
suite 7/7 (my run). User-certify by running:

```sh
# 0) build the prepared worker disk (debian + git), if not already present
scripts/build-worker-image

# 1) the Gate 5 suite (spawns its own test broker + throwaway project)
SANDBOX_GATED_TESTS=integration bun test tests/integration/
```

Checklist (user):

- [ ] Read-only investigation created **zero** workers
- [ ] First write/bash created **exactly one** worker; reuse; session
      separation; read switch; external read works; external write fails
- [ ] Host project untouched after sandboxed writes

Findings resolved during preparation: prepared-worker-disk lifecycle
(template cloned per worker; msb writes the root-disk file; never fsck the
copied upper.ext4 — host e2fsck corrupts it), guest-fs boot/read races
(waitReady + bounded prep retry; fetch without `-q`), non-root file modes
(host-tmp 0644), snapshot must be awaited before createWorker.

## Gate 6 — Git result round-trip

```sh
SANDBOX_GATED_TESTS=integration bun test tests/integration/   # + git round-trip cases
```

Checklist:

- [ ] Baseline B under `refs/opencode-sandbox/baseline/<id>`; user branch and
      index untouched
- [ ] Result bundle imports under `refs/opencode-sandbox/result/<id>`
- [ ] `git apply --check` + apply of B→C delta; host tree correct
- [ ] Divergence refusal works (S16)

## Gate 7 — OAuth/subagent isolation

Checklist:

- [ ] Worker contains no `auth.json` and no provider env (S8/S9)
- [ ] Subagent sessions map to their own workers; no cross-session access
- [ ] auth.json not readable through model-facing read tools (S7)

## Gate 8 — Parallel worker isolation

Checklist:

- [ ] Two concurrent sessions → two workers, no interference (§28)
- [ ] Pool budget respected; exhaustion rejects cleanly (§22)

## Gate 9 — OpenChamber integration

```sh
scripts/start-openchamber
```

Checklist:

- [ ] Exactly one intended server on 127.0.0.1:4096 (spec §23)
- [ ] OpenChamber attaches to it; no second server spawned
- [ ] `OPENCODE_PID` attach mechanism re-verified against OpenChamber 1.18.4

## Gate 10 — Adversarial security acceptance

- [ ] §29 adversarial review performed by a separate reviewer agent/model
- [ ] All high/critical findings resolved
- [ ] `SANDBOX_GATED_TESTS=all bun test tests/` green
- [ ] Success condition from §33 demonstrated end-to-end with a human
