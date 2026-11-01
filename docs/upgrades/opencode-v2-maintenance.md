# OpenCode V2 stack maintenance

This guide covers updates to the installed OpenCode V2 plugins, configuration fragments, nono
profile, service unit, and runtime. The cutover and current runtime state (V2 2.2.2 at
`~/.local/share/opencode-v2/prefix`, port 4097, `secure-opencode-v2.service`, profile
`opencode-v2-secure`) are owner-attested; the repository contains the update sources and controls
cited below (`docs/upgrades/opencode-v2.md:11`, `docs/upgrades/opencode-v2.md:100`).

Related records: [completed cutover checklist](opencode-v2-install-checklist.md) and [V2 upgrade plan](opencode-v2.md).

## Authority and scope

The V2 plugin sources are `opencode/plugins-v2/` plus shared logic in `opencode/plugins/lib/`;
fragments are in `opencode/plugins-v2/config-fragments/`. The V2 profile, installer/rollback,
launcher configuration, and unit template are `nono/profile/opencode-v2-secure.json`,
`scripts/install-user-files-v2`, `scripts/rollback-v2`, `scripts/secure-launcher-v2.conf`, and
`docs/secure-opencode-v2.service.template` (`scripts/secure-launcher-v2.conf:42-75`,
`docs/secure-opencode-v2.service.template:1-6`).

**S17 boundary:** agents may propose changes to repository source, but only the owner reviews and
installs S17 bytes. The V2 profile, plugin/config sources, installer/rollback, and service template
have manual owner delivery; the installer itself warns not to run without explicit approval
(`scripts/install-user-files-v2:3-10`; `scripts/secure-launcher-v2.conf:7`;
`docs/secure-opencode-v2.service.template:1-6`). A committed change is not live: the installer
does not restart a service and explicitly leaves fragments for manual merge
(`scripts/install-user-files-v2:8-10,85-86`).

## Standard update loop

Run these commands from the repository root in the owner's interactive Fish terminal. The
installer accepts `--dry-run` and `--apply`; dry-run is also its default
(`scripts/install-user-files-v2:19-24`; `docs/upgrades/opencode-v2-install-checklist.md:49-56`).
The review command follows the repository's existing V2 review procedure
(`docs/upgrades/opencode-v2-install-checklist.md:16-20`).

1. Edit the appropriate repository source described below.
2. Review the proposed source changes:

   ```fish
   git diff -- opencode/plugins-v2 opencode/plugins/lib nono/profile/opencode-v2-secure.json docs/secure-opencode-v2.service.template scripts/secure-launcher-v2.conf
   ```

3. Preview installer-managed changes, then install only after owner review:

   ```fish
   bash scripts/install-user-files-v2 --dry-run
   bash scripts/install-user-files-v2 --apply
   ```

   The script validates its complete source/destination plan before writing. Existing differing destinations are backed up, and applied files are journalled (`scripts/install-user-files-v2:41-62,64-80`).

4. If a fragment changed, compare and merge the staged copy into the V2 `opencode.json` by hand. The installer stages fragments; it never edits `opencode.json` or performs the merge (`scripts/install-user-files-v2:8-10,67-73,82-86`).
5. Restart V2 and verify the running service:

   ```fish
   systemctl --user restart secure-opencode-v2.service
   bun scripts/check-v2-stack.ts
   ```

   The unit template names `secure-opencode-v2.service` and starts
   `scripts/start-secure-opencode-v2`; the completed install checklist uses the same unit name
   for stop/start and documents the health-check command
   (`docs/secure-opencode-v2.service.template:1-20`;
   `docs/upgrades/opencode-v2-install-checklist.md:70-87`). The health-check options are
   `--server URL`, `--opencode PATH`, `--password-file FILE`, and `--wait SECONDS`
   (`scripts/check-v2-stack.ts:3-11,62-74`).

6. Record the runtime and resolved package versions in the table below. V2's config uses `~x.y.z` package ranges, so a fresh resolution may be newer than the reviewed patch pin (`docs/upgrades/opencode-v2-install-checklist.md:66,74`).

Do not use V1's `scripts/install-user-files`, `scripts/rollback`, `secure-opencode.service`, or port 4096 for V2 maintenance; V1 is retained only for rollback (`docs/upgrades/opencode-v2.md:11,34-38`).

## Per-artifact procedure

| Artifact | Edit in the repository | Installer behavior | Verification |
|---|---|---|---|
| Plugin entry or shared library | Edit `opencode/plugins-v2/` or the V2-used shared modules under `opencode/plugins/lib/`. The allowlist in `V2_PLUGIN_FILES` is the definitive set copied by the installer (`scripts/secure-launcher-v2.conf:42-66`). Add a new file to that list when it must be installed. | Copies only listed sources to `~/.local/share/opencode-v2/config/opencode/plugins/`; it does not discover arbitrary new files (`scripts/secure-launcher-v2.conf:45-66`; `scripts/install-user-files-v2:67-80`). | Dry-run should list the intended destination; after install and restart, the health check verifies expected plugin names are loaded, not the installed bytes (`scripts/install-user-files-v2:46-52`; `scripts/check-v2-stack.ts:24-27,56-59`).
| Config fragment | Edit one of `sandbox-permissions.jsonc`, `role-agents.jsonc`, or `reviewer-relay-agents.jsonc` under `opencode/plugins-v2/config-fragments/`; the list is in the V2 config (`scripts/secure-launcher-v2.conf:67-73`). | Stages listed fragments under `~/.local/share/opencode-v2/fragments/`. It does not merge them into V2 `opencode.json`; merge by hand after comparing with the current config (`scripts/install-user-files-v2:8-10,67-73,85`). | Review the staged fragment against the V2 config, restart, then run the health check for expected agents/plugin names. This is not a full permission-parity check (`scripts/check-v2-stack.ts:39-59`).
| Nono profile | Edit `nono/profile/opencode-v2-secure.json`. | Installs it to `~/.config/nono/profiles/opencode-v2-secure.json` (`scripts/secure-launcher-v2.conf:74-75`; `scripts/install-user-files-v2:67-80`). | Owner validates the profile before relying on it. The current source has invalid JSON: a comma is missing between `"api.anthropic.com"` and `"platform.claude.com"` at lines 140-141. Fix this before profile validation (`nono/profile/opencode-v2-secure.json:140-141`). The health check does not parse or validate the profile.
| Service unit | Edit `docs/secure-opencode-v2.service.template`; it is manually installed, not part of the V2 file installer (`docs/secure-opencode-v2.service.template:1-6`; `scripts/secure-launcher-v2.conf:42-75`). | No automated install, reload, or restart. Owner reviews/copies the template to `~/.config/systemd/user/secure-opencode-v2.service` and reloads systemd; these are the documented cutover steps (`docs/upgrades/opencode-v2-install-checklist.md:76-80`). | Owner inspects the installed unit and service status/logs; then restart and run the health check (`docs/upgrades/opencode-v2-install-checklist.md:76-87`; `docs/operations.md:16-24`).
| OpenCode runtime | Update the pinned `@opencode/cli` version using the separate V2 prefix, not the V1 install. The checklist documents the install form and version probe (`docs/upgrades/opencode-v2-install-checklist.md:37-44`). | `install-user-files-v2` does not install or upgrade the runtime; its plan contains only plugin files, the profile, and fragments (`scripts/install-user-files-v2:64-80`; `scripts/secure-launcher-v2.conf:42-75`). | Use the version probe after installation, restart the V2 unit, and run the health check (`docs/upgrades/opencode-v2-install-checklist.md:39-42,70-74`). Re-check compatibility against the exact target runtime before owner installation.

The documented runtime installation command is `npm install --prefix ~/.local/share/opencode-v2/prefix --no-audit --no-fund @opencode/cli@2.2.2`; for an update, replace the pin with the reviewed target version. The corresponding probe is `~/.local/share/opencode-v2/prefix/node_modules/.bin/opencode2 --version` (`docs/upgrades/opencode-v2-install-checklist.md:37-42`).

## Health-check coverage and limits

`scripts/check-v2-stack.ts` reads the password from the configured 0600 file, queries
`debug agents` and `plugin list`, retries agent queries until `--wait` expires, and prints
PASS/FAIL checks (`scripts/check-v2-stack.ts:62-94`). It checks that `gentle-orchestrator` is
present, its effective `shell` and `edit` permissions deny host use, secret-read denies include
`**/.ssh/**` and `**/*.pem`, all six `asi-review-*` agents exist as hidden subagents, all ten
expected plugin IDs are listed, and no plugin has the failed-load ID `-`
(`scripts/check-v2-stack.ts:23-27,39-59`).

It does **not** enumerate or validate the complete live tool-ID set; the `shell`/`edit` checks
inspect permission rules. It does not compare installed file hashes, inspect the V2 config or
nono profile, validate every permission/agent setting, or prove a tool's end-to-end behavior
(`scripts/check-v2-stack.ts:39-59,88-95`). Treat PASS as these specific runtime checks only.

## Rollback

Preview and then remove only unchanged installer-managed files:

```fish
bash scripts/rollback-v2 --dry-run
bash scripts/rollback-v2 --apply
```

`rollback-v2` removes a destination only when it is a regular non-symlink file identical to its current repository source; edited, missing, or non-matching files are skipped. It leaves backups in place and does not remove V2 data, config, or the password file (`scripts/rollback-v2:3-5,21-37`). It does not revert a manually merged V2 `opencode.json`, a manually installed service unit, or a runtime upgrade; handle those separately. For service fallback, stop `secure-opencode-v2.service` and start the retained `secure-opencode.service` (`docs/upgrades/opencode-v2-install-checklist.md:94-95`). V1 is separate and the V2 installer/rollback never touches its tree (`scripts/install-user-files-v2:8-10`; `scripts/rollback-v2:3-5`).

## Resolved-version record

The configured `~x.y.z` ranges allow fresh installs to resolve newer patch versions than the reviewed pins; the checklist records this behavior and a previously observed `opencode-magic-context` resolution of `0.49.30` (`docs/upgrades/opencode-v2-install-checklist.md:66,74`). Record the actual resolved set after each runtime/config installation in this table, in this document. Do not substitute configured ranges for resolved versions.

| Installed on | OpenCode CLI (`opencode2 --version`) | Package/plugin name | Configured range | Resolved version | Reviewed source revision / notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

## Known gaps

- Installed plugin/config/profile bytes are not hash-verified by the health check; byte-level deployment verification remains open (`scripts/check-v2-stack.ts:39-59`; `docs/upgrades/opencode-v2-install-checklist.md:74`).
- The repository profile is currently invalid JSON because the comma is missing at lines 140-141. The owner must fix it before profile validation (`nono/profile/opencode-v2-secure.json:140-141`).
- `~x.y.z` ranges can drift to newer patches on fresh resolution; record the resolved set after every install (`docs/upgrades/opencode-v2-install-checklist.md:66,74`).

## Quick checklist

- [ ] Edit the V2 repository source and review the exact diff; keep within S17 owner-install boundaries.
- [ ] For a new plugin file, add its source/destination mapping to `V2_PLUGIN_FILES`; for a fragment, plan a manual merge.
- [ ] Fix and validate the V2 nono profile before relying on it.
- [ ] Run installer dry-run, review its plan, then have the owner apply the reviewed files.
- [ ] Manually merge reviewed config fragments; manually install unit-template changes and reload systemd when applicable.
- [ ] Upgrade the V2 runtime separately when needed; do not touch V1.
- [ ] Restart `secure-opencode-v2.service`, run `bun scripts/check-v2-stack.ts`, and investigate each failure.
- [ ] Record the exact runtime and resolved plugin versions in the table above.
