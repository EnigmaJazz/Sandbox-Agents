# OpenCode V2 install checklist (owner steps, S17)

Everything below is YOURS to do: the V2 files are S17 paths, so you read the exact bytes and install them. Nothing here has been
installed. Target version **2.2.2** (decided 2026-10-29). V1 (port 4096, `~/.opencode`, `~/.config/opencode`) is never touched by any step.
Branch: `refactor/p0-shared-tool-table`. Review base: `2d6e222` (the commit before the V2 work). Facts and evidence:
`docs/opencode-v2-discovery.md`; per-workstream notes: `docs/upgrades/opencode-v2.md`.

## 0. Before anything
- [x] V1 is healthy: `bash ~/ai-workspace/workflow_optimisation/verify-workflow.sh < /dev/null` passes.
- [x] Back up V1 data (the V1 data stays untouched, but a V2 first start may read it): `cp -a ~/.local/share/opencode ~/.local/share/opencode.bak-$(date +%Y%m%d)`.
- [x] Back up the OpenChamber settings: `cp -a ~/.config/openchamber ~/.config/openchamber.bak-$(date +%Y%m%d)`.
- [x] OpenChamber 1.24.2 is installed globally with Bun (`~/.bun/bin/openchamber` links into `~/.bun/install/global/node_modules/@openchamber/web`). The exact-version reinstall for rollback is `bun add -g @openchamber/web@1.24.2` (the global `package.json` has `^1.24.2`, which would allow a later 1.x). Do NOT accept OpenChamber's one-click "update to OpenCode 2".

## 1. Read the diff (14 files, about 1,440 lines)
```bash
cd ~/agent-sandbox-integration
git diff --stat 2d6e222..HEAD -- nono opencode/plugins-v2 scripts
git diff 2d6e222..HEAD -- nono opencode/plugins-v2 scripts      # the exact bytes you are installing
```
Read in this order, and stop at anything you do not understand:
1. `nono/profile/opencode-v2-secure.json`: the confinement. Check: port 4097; `$HOME/.claude` and `$HOME/.agents` denied; no V1 root granted; no `.git` write grant; the V2 `config` root is `read` only (so the agent cannot rewrite its own guard).
2. `scripts/secure-launcher-v2.conf` and `scripts/start-secure-opencode-v2`: the password comes from a 0600 file into the environment only; refusal rules; V1 binary refused.
3. `opencode/plugins-v2/00-routing-guard.ts` and `lib/guard-core.ts`: what is allowed or denied on every tool call.
4. `opencode/plugins-v2/sandbox-tools.ts` and `lib/v2-adapter.ts`: the sandbox tools and the approval mapping (`ctx.permission.assert`).
5. `opencode/plugins-v2/reviewer-relay-transport.ts` and `lib/relay-v2.ts`: the reviewer relay (shares the V1 `reviewer-relay-core.ts`, untouched).
6. `opencode/plugins-v2/config-fragments/*.jsonc`: permission rules (every tool has an explicit rule; three that V1 left to a default are now `ask`), role agents, relay agents.
7. `scripts/install-user-files-v2` and `scripts/rollback-v2`: what step 4 will write.

## 2. Check the tests still pass (no install needed)
```bash
cd ~/agent-sandbox-integration/broker && bun test                                       # whole suite
OPENCODE_V2_HOST_TEST=1 OPENCODE_V2_BIN=$HOME/opencode-v2-probe/prefix-2.2.2/node_modules/.bin/opencode2 bun test tests/v2-host.test.ts   # real V2, fake broker
```

## 3. Install the V2 CLI into its own prefix
```bash
mkdir -p ~/.local/share/opencode-v2/prefix
npm install --prefix ~/.local/share/opencode-v2/prefix --no-audit --no-fund @opencode/cli@2.2.2
~/.local/share/opencode-v2/prefix/node_modules/.bin/opencode2 --version      # expect "opencode v2.2.2"
ls -l ~/.local/share/opencode-v2/prefix/node_modules/@opencode/cli-linux-x64/bin/opencode   # expect about 248 MB (248486064 bytes)
```
**Let the install finish (about 2 minutes) and do not interrupt it.** The platform binaries are about 250 MB each; an interrupted extraction leaves truncated files that crash with `Bus error`, and re-running `npm install` over them fails in the vendor postinstall ("Failed to install OpenCode") because it verifies the binary with `--version`. This happened once on 2026-10-29. If it does: `rm -r ~/.local/share/opencode-v2/prefix` and install again from scratch. If a future npm blocks the postinstall, `npm install-scripts approve @opencode/cli` is the documented fix.
Never run `opencode upgrade --major` or the curl installer: both replace V1.
- [ ] Create the server password (0600, never printed): `umask 077; head -c 24 /dev/urandom | base64 > ~/.local/share/opencode-v2/server-password`
- [ ] Make `zod` resolvable from the V2 config root: `mkdir -p ~/.local/share/opencode-v2/config/opencode && npm install --prefix ~/.local/share/opencode-v2/config/opencode zod`

## 4. Install the files (dry-run first)
```bash
cd ~/agent-sandbox-integration
bash scripts/install-user-files-v2              # dry-run: lists every file it would write
bash scripts/install-user-files-v2 --apply      # writes the 19 plugin files, the nono profile, and STAGES the fragments
```
It writes only under `~/.local/share/opencode-v2/` and `~/.config/nono/profiles/opencode-v2-secure.json`, backs up any differing file, and journals to `~/.local/state/opencode-sandbox/install-journal-v2.tsv`.
Undo: `bash scripts/rollback-v2 --apply` (removes only files still identical to the repo copy).

## 5. Build the V2 config root (derived from `global-config/`)
```bash
cd ~/ai-workspace/workflow_optimisation
python3 scripts/derive-v2-config.py --source global-config --sandbox-repo ~/agent-sandbox-integration \
  --target ~/.local/share/opencode-v2/config/opencode            # dry-run: lists what it would write, notes and warnings
python3 scripts/derive-v2-config.py --source global-config --sandbox-repo ~/agent-sandbox-integration \
  --target ~/.local/share/opencode-v2/config/opencode --apply    # writes; backs up differing files; never deletes
```
It writes `opencode.json` (plugin list as V2 `plugins` with `~x.y.z` ranges; the auto-update fork and `opencode-usage-total` dropped), `cli.json`, `AGENTS.md`, `systematic.jsonc`, `rate-limit-fallback.json`, `prompts/`, `skills/`, the repo's dual-mode `plugins/`, and a copy of the rate-limit fork under `vendor/`. Permissions are carried over from V1 unchanged.
- [ ] Read the `note:` and `WARNING:` lines it prints. Decided: `opencode-usage-total` is retired on V2; the three live-only prompts are now in `global-config/prompts/`; the vision bridge is in `global-config/mcp/vision-bridge/` and runs from the V2 root with V2-owned auth and log paths. One warning remains: `gentle-orchestrator` has `host_review_start: allow` (V2 will not prompt for it).
- [ ] The vision bridge reads its OpenAI token from the V2 data root (`~/.local/share/opencode-v2/data/opencode/auth.json`), not from V1's `auth.json` (the V2 profile does not grant the V1 data directory, deliberately). Log V2 into OpenAI once after the first start, or the bridge has no OpenAI leg.
- [ ] The three sandbox fragments staged in step 4 are NOT merged by this script. The V1 policy already denies the sandbox and host tools globally and grants them per agent, which is stricter than the fragments; the fragments are the fallback reference. Do not merge them on top without comparing.
- [ ] Check the running server (after step 7's start): one command, read-only, prints PASS or FAIL per check and never prints the password:
```bash
cd ~/agent-sandbox-integration && bun scripts/check-v2-stack.ts
```
  It reads `~/.local/share/opencode-v2/server-password`, asks the server at `http://127.0.0.1:4097` for its agents (`debug agents`) and plugins (`plugin list`), and checks: the orchestrator cannot use host `shell` or `edit`; secret reads are denied; the six `asi-review-*` relay agents exist as hidden subagents; all ten plugins are loaded (aft-opencode, astra-sol-upgrade, opencode-magic-context, rate-limit-fallback-mapped, systematic, systematic-routing-guard, workflow-health-check, sandbox-tools, routing-guard, reviewer-relay-transport) and none failed. Exit code 0 only if everything passes. The first run after a start waits up to two minutes while the packages install; options: `--wait SECONDS`, `--server URL`. A fresh install resolves each `~` range to the newest patch, so versions can be ahead of the reviewed pins (magic-context came up as 0.49.30); that is expected.

## 6. Install the unit (S17: `systemd-user/` is a protected path)
```bash
cp ~/agent-sandbox-integration/docs/secure-opencode-v2.service.template ~/.config/systemd/user/secure-opencode-v2.service
systemctl --user daemon-reload          # do NOT enable yet; it Conflicts= with secure-opencode.service (V1)
```
The guarded update job templates are `~/ai-workspace/workflow_optimisation/docs/systemd/v2-plugin-autoupdate.{service,timer}.template`: install them only after step 7 works.

## 7. First V2 start (this is the cutover rehearsal; V1 must be stopped, they conflict)
```bash
systemctl --user stop secure-opencode.service        # V1 off (rollback: start it again)
systemctl --user start secure-opencode-v2.service
journalctl --user -u secure-opencode-v2.service -n 50
```
Then run the manual gates on V2 (the list in `docs/upgrades/opencode-v2.md`, "Cutover" step 2): host read routing and mutation blocking, lazy worker activation, `sandbox_edit`, `sandbox_apply` approval with the full preview, a `host_git_commit` approval, native review end to end (needs the broker and `gentle-ai` v4), Code Mode cannot bypass approval, no `~/.claude` content visible.
After the first TUI start: confirm `cli.json` has no V1-only plugins, run `herdr integration status`.

## Rollback at any point
`systemctl --user stop secure-opencode-v2.service && systemctl --user start secure-opencode.service`, then `bash scripts/rollback-v2 --apply` if you want the files removed. V1 data is untouched; restore `~/.local/share/opencode.bak-*` only if V2 changed it.
