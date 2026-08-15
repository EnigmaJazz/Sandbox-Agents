# nono — secured OpenCode profile (defence in depth, spec §15)

`nono/profile/opencode-secure.json` constrains the host OpenCode process.
**Nothing here is installed at Gate 1.**

## Why a dedicated profile

The official `nolabs-ai/opencode` profile grants **ReadWrite to the current
working directory** plus RW to `~/.opencode`, `~/.config/opencode`,
`~/.cache/opencode`, `~/.local/share/opencode`, and more (discovery §4).
Per spec §15 we therefore:

1. **Never start secure OpenCode from a real project directory** — a dedicated
   control directory (`~/.local/share/opencode-sandbox-control`) is used
   (`scripts/start-secure-opencode` enforces this).
2. **Extend `default`, not `nolabs-ai/opencode`** — inheriting the opencode
   profile would carry grants that cannot be removed safely (nono array-append
   merge; no mechanism to remove inherited filesystem paths). Building from
   `default` + the explicit OpenCode state paths gives narrow, reviewable
   grants. See `nono/profile/README.md` for the exact extends decision.

## What the profile grants (review carefully at Gate 2)

| Area | Policy |
|---|---|
| Workdir | `none` — no automatic CWD sharing |
| Control dir | RW (`~/.local/share/opencode-sandbox-control`) |
| OpenCode state | RW `~/.local/share/opencode`, `~/.local/state/opencode`, `~/.cache/opencode`, `~/.config/opencode` (required by the process itself, incl. OAuth storage §16) |
| Project roots | RO (placeholder list — finalize at Gate 2) |
| Everything else | denied (no deny-within-allow carve-outs — Landlock hard error, discovery §4) |
| Network | Proxy allowlist: OpenAI/OpenRouter/DeepSeek domains + localhost ports 13000/8788, listen 4096 (placeholder — finalize at Gate 2) |
| Security | signal/process-info isolated, no capability elevation |

## The auth.json tension (S7 vs §16)

`auth.json` sits inside an RW-granted OpenCode state dir because the process
must access it for OAuth. It CANNOT be denied at the filesystem layer without
a Landlock hard error. Protection is therefore enforced at the **OpenCode
permission layer** (deny list in `opencode/config-fragments/`) and by the
routing guard — the model's `read` tool can never display it.

## Gate 2 checklist

Run (all read-only except where noted — the USER performs installs):

```sh
nono profile validate nono/profile/opencode-secure.json
nono profile show opencode-secure            # after install, or use the file path
nono profile diff <existing> opencode-secure # compare with the everyday profile
nono run --dry-run --profile nono/profile/opencode-secure.json -- true
mkdir -p ~/.local/share/opencode-sandbox-control   # needed before launch (grants expand at start)
scripts/start-secure-opencode
```

Then the human reviews the resolved capability table before `--apply`.

## Linux note (Landlock)

`filesystem.deny` overlapping a broader allow is a **hard start error** on
Linux. The profile therefore uses narrow grants, never broad-allow + carve-out
(discovery §4). Adding new `allow`/`read` entries at Gate 2 must respect this.
