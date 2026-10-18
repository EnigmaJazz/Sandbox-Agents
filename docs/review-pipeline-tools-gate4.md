# Review pipeline tools — Gate 4 installation and probes

This document covers activation of `host_review_materialize` and `host_review_diff_read`. It does not certify Gate 4; the operator probes below remain unverified by this unit.

## Install and activate, in order

1. Run `scripts/install-user-files --apply` to install the reviewed plugin files.
2. The permission fragment is NOT merged automatically. **MERGE IS MANUAL**: add `"host_review_materialize": "allow"` and `"host_review_diff_read": "allow"` by hand to the installed `opencode.json` permission map. Do not replace the installed configuration with the fragment.
3. `scripts/install-user-files --verify` covers the plugin files but deliberately excludes `opencode/config-fragments/sandbox-permissions.jsonc`; verification does not establish that the permission entry was merged.
4. Restart the broker because its binary changed, then restart secure OpenCode so it loads the plugin tool definition and permission change.

## Gate 4 operator probes

Both probes are operator-run and unverified by this unit:

- Confirm both manually merged permission entries gate their plugin tools. The permission fragment itself notes that plugin-tool permission matching is unverified and must be checked at Gate 4.
- Inspect the INSTALLED PM and orchestrator agent definitions and confirm they do not contain explicit `tools:` allowlists that also need these tools. If they do, update those allowlists through the approved manual installation process.
- Call `host_review_materialize` and then `host_review_diff_read` with the real returned `runId`; confirm a text diff returns `text`, `bytes`, and `sha256` with no `data`, while a binary diff returns `data`, `binary: true`, `bytes`, and `sha256` with no `text`. Inline only `text`; never forward the raw `data` array into a prompt.

`host_review_materialize` returns a bounded index. `host_review_diff_read` returns one bounded whole diff or named slice.

The live broker `readOnlyAgents` list currently comes from `DEFAULT_READ_ONLY_AGENTS` in the installed broker binary. `broker/src/main.ts` passes only its parsed CLI/environment overrides to `defaultConfig`; `parseBrokerEnv()` has no `readOnlyAgents` environment setting. Embedded callers can override the list through `defaultConfig({ readOnlyAgents })`, but the broker's normal launcher does not. Restarting the broker activates the changed defaults; there is no separate installed config list to merge.
