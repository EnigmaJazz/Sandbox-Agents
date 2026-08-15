# nono/profile — the opencode-secure child profile

**NOT INSTALLED at Gate 1.** `opencode-secure.json` is a *child profile* per
spec §15, generated against the current nono 0.73.0 schema (verified with
`nono profile guide`, discovery §4). It validated with
`nono profile validate` and `nono run --dry-run` at Gate 1; the resolved
capability table must still be reviewed by a human at Gate 2.

## extends decision

`"extends": "default"` — **not** `nolabs-ai/opencode`:

- Inheriting the official opencode profile would bring over-broad grants
  (RW workdir/CWD, `~/.opencode`, `~/.config/opencode`, `~/.cache/opencode`,
  `~/.local/share/opencode`, `~/.local/share/opentui`, `~/.local/state/opencode`).
- nono's merge appends arrays and has **no mechanism to remove inherited
  filesystem paths** (discovery §4), so over-broad base grants cannot be
  tightened.
- `default` is the conservative base (deny_credentials, deny_shell_history,
  system_read_linux_core, dangerous_commands groups, …). The required
  OpenCode state paths are added explicitly as the only RW grants.
- Per spec §15: *"If inheriting nolabs-ai/opencode causes over-broad
  permissions that cannot be removed safely, construct a profile from default
  and add only the required OpenCode state paths."*

## Required OpenCode state paths (RW)

- `~/.local/share/opencode` — data dir: `auth.json` (OAuth, §16),
  `opencode.db`, logs, storage
- `~/.local/state/opencode`, `~/.cache/opencode` — runtime state/cache
- `~/.config/opencode` — config, plugins, skills (the process manages these)
- `~/.local/share/opencode-sandbox-control` — dedicated control dir (writable;
  never a real project)
- `$TMPDIR` — opencode temp usage

## Grants to finalize at Gate 2 (placeholders now)

- `filesystem.read` — real project roots + approved external reference roots
  (S6). Never whole-home.
- `network.allow_domain` — final provider list (OpenAI OAuth + API,
  OpenRouter, DeepSeek, local proxies 127.0.0.1:13000/8788 via `open_port`).
- `network.listen_port` — 4096 (the secured `opencode serve` port, §23).
