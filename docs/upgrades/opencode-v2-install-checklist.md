# OpenCode V2 install checklist (owner steps, S17)

Everything below is YOURS to do: the V2 files are S17 paths, so you read the exact bytes and install them. Nothing here has been
installed. Target version **2.2.2** (decided 2026-10-29). V1 (port 4096, `~/.opencode`, `~/.config/opencode`) is never touched by any step.
Branch: `refactor/p0-shared-tool-table`. Review base: `2d6e222` (the commit before the V2 work). Facts and evidence:
`docs/opencode-v2-discovery.md`; per-workstream notes: `docs/upgrades/opencode-v2.md`.

## 0. Before anything
- [ ] V1 is healthy: `bash ~/ai-workspace/workflow_optimisation/verify-workflow.sh < /dev/null` passes.
- [ ] Back up V1 data (the V1 data stays untouched, but a V2 first start may read it): `cp -a ~/.local/share/opencode ~/.local/share/opencode.bak-$(date +%Y%m%d)`.
- [ ] Write down the OpenChamber 1.24.2 reinstall command (you will need it for rollback). Do NOT accept OpenChamber's one-click "update to OpenCode 2".

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
~/.local/share/opencode-v2/prefix/node_modules/.bin/opencode2 --version      # expect 2.2.2
```
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

## 5. Build the V2 `opencode.json` (NOT YET DEFINED, decide first)
`~/.local/share/opencode-v2/config/opencode/opencode.json` does not exist, and nothing generates it. It needs: your providers and models, the agents, and the three staged fragments merged by hand from `~/.local/share/opencode-v2/fragments/`. It must NOT contain the auto-update fork reference. Plugin package entries use `~x.y.z` ranges (guarded auto-update). This is the Q46 change set: until it is written, either build the file by hand from `global-config/opencode.json` minus V1-only entries, or ask for the change set to be written first.
- [ ] Check the result: `OPENCODE_CONFIG_DIR` unset, run `opencode2 debug agents` with `XDG_CONFIG_HOME=~/.local/share/opencode-v2/config` and confirm: host `shell` and `edit` denied, 12 read denies, every `sandbox_*` and `host_*` tool has a rule.

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
