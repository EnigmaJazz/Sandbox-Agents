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

```sh
msb doctor
msb image list                      # debian image present (47 MiB)
# broker net.conf: confirm deny-by-default; add project-required allowlist (S12)
```

Checklist:

- [ ] Worker image pinned in broker config; LLM cannot choose (S11)
- [ ] Network deny-by-default confirmed (no LAN/metadata/socket)
- [ ] `/dev/kvm` access unchanged (already user-accessible per discovery)

## Gate 4 — Broker unit/security tests

```sh
cd broker && bun test
SANDBOX_GATED_TESTS=security bun test tests/security/   # broker live
```

Checklist:

- [ ] All unit tests pass
- [ ] Security suite passes (secret protection, OAuth absence, host escape,
      LAN isolation, fail closed, divergence, argument attacks)
- [ ] Plugins loaded in opencode: verify `tool` hook + `ctx.ask()` signature
      against installed 1.18.18 (plugins/README.md)
- [ ] systemd unit reviewed and enabled (user action):
      `systemctl --user enable --now sandbox-broker`

## Gate 5 — Throwaway-project lazy sandbox test

```sh
SANDBOX_GATED_TESTS=integration bun test tests/integration/
```

Checklist:

- [ ] Read-only investigation created **zero** workers
- [ ] First write/bash created **exactly one** worker; reuse; session
      separation; read switch; external read works; external write fails

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
