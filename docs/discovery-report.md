# Discovery Report — Agentic Sandbox Integration

Date: 2026-08-15 · Host: `james-ubuntu` · Phase: Mandatory discovery (SYSTEM_PROMPT.md §4)

> This report contains NO credentials, tokens, or secret contents. Credential stores were
> confirmed present without being displayed.

## 1. System

| Item | Value |
|---|---|
| `uname -a` | `Linux james-ubuntu 7.0.0-29-generic #29-Ubuntu SMP PREEMPT_DYNAMIC x86_64 GNU/Linux` |
| Kernel | `7.0.0-29-generic` |
| `nproc` | 16 |
| `free -h` | 29 GiB total · 6.1 GiB used · 2.6 GiB free · 21 GiB buff/cache · 23 GiB available · 16 GiB swap |
| `df -h /` | 92 G · 59 G used (68%) · 29 G avail · `/dev/nvme0n1p6` |
| `df -h /home` | 203 G · 73 G used (38%) · 121 G avail · `/dev/nvme0n1p7` |
| `XDG_RUNTIME_DIR` | `/run/user/1000` |
| systemd user session | `systemctl --user is-system-running` → `running` |

## 2. Tool versions and locations

| Tool | Version | Path |
|---|---|---|
| opencode | 1.18.18 | `/home/james/.opencode/bin/opencode` |
| openchamber | 1.18.4 | `/home/james/.bun/bin/openchamber` |
| nono | 0.73.0 | `/home/linuxbrew/.linuxbrew/bin/nono` |
| msb (Microsandbox) | 0.6.9 | `/home/james/.local/bin/msb` |
| gentle-ai | 2.4.0-rc.8 | `/home/linuxbrew/.linuxbrew/bin/gentle-ai` |
| git | 2.55.0 | `/home/linuxbrew/.linuxbrew/bin/git` |
| bun | 1.3.14 | `/home/linuxbrew/.linuxbrew/bin/bun` |
| node | v26.7.0 | `/home/linuxbrew/.linuxbrew/bin/node` |

`opencode auth list` (spec-sanctioned; store NOT displayed): credential store at
`~/.local/share/opencode/auth.json` exists and contains 5 credentials: **OpenCode Go api**,
**OpenRouter api**, **local api**, **OpenAI oauth**, **DeepSeek api**. → S8/S9 relevant: OpenAI
OAuth lives in the persistent host OpenCode process.

## 3. OpenCode configuration

- Global config: `~/.config/opencode/opencode.json` (JSON, `$schema: https://opencode.ai/config.json`)
- Secondary files: `opencode.jsonc` (plus several `.bak-*` files), `AGENTS.md`, `package.json`,
  `plugins/`, `skills/`, `prompts/`, `profiles/`, `commands/`, `mcp/`
- Data dir: `~/.local/share/opencode/` → `auth.json`, `log`, `logs`, `repos`, `storage`,
  `opencode.db` (+ WAL), `tool-output`, `snapshot`
- Install: `~/.opencode/` (bin + node_modules with `@opencode-ai/plugin` and `@opencode-ai/sdk`)

### Config structure (keys only)

- `default_agent: gentle-orchestrator`
- `agent`: frontend-apply, frontend-apply-local, frontend-dev, gentle-orchestrator, jd-fix-agent,
  jd-judge-a, jd-judge-b, review-readability, review-refuter, review-reliability,
  review-resilience, review-risk, sdd-apply, sdd-apply-local, sdd-archive, sdd-design,
  sdd-explore, sdd-init, sdd-onboard, sdd-propose, sdd-spec, sdd-tasks, sdd-verify, vision
- `provider`: `kinver` → `http://127.0.0.1:13000/v1`; `opencode-go`,
  `opencode-go-pool`, `opencode-go-pool-anthropic` → `http://127.0.0.1:8788/v1`
  (OpenCode Go proxy endpoint; currently listening on 127.0.0.1:8788)
- `mcp`: context7, engram
- `permission`: `bash` `*: allow` (git commit/push/force-push/rebase/reset-hard → ask),
  `edit: ask`, `write: ask`, `read` `*: allow` with deny list (`**/.env*`, `**/.ssh/**`,
  `**/.aws/credentials`, `**/*.key`, `**/*.pem`, `**/credentials.json`, `**/secrets/**`,
  `**/.credentials/**`, `**/.config/gh/hosts.yml`, `**/Library/Keychains/**`),
  `external_directory: allow`
- `share: disabled`
- `plugin`: `opencode-usage-total`, `@cortexkit/opencode-magic-context@0.36.1`
- Installed plugin files under `~/.config/opencode/plugins/` include: `use-grep-tool.ts`,
  `nono-sandbox.ts`, `model-variants.ts`, `opencode-rate-limit-fallback-mapped/`,
  `review-result-artifacts.ts`, `skill-registry.ts`, `workflow-health-check.ts`, `codecast-stable.js`

### Installed plugin API (v1.18.18 — verified from `@opencode-ai/plugin` typings)

- Hooks object returned by a plugin factory. Relevant hooks for this project:
  - `tool` → `{ [name]: tool({ description, args(zod), execute(args, ctx) }) }` — **custom tools**,
    with `ToolContext = { sessionID, messageID, agent, directory, worktree, abort, metadata(), ask() }`
  - `tool.execute.before(input: { tool, sessionID, callID }, output: { args })` — throw to block
    a tool call (used by read-routing guard)
  - `tool.execute.after(input: { tool, sessionID, callID, args }, output: { title, output, metadata })`
  - `permission.ask(input: Permission, output: { status: "ask"|"deny"|"allow" })`
  - `experimental.chat.system.transform(input: { sessionID?, model }, output: { system })`
  - `config(input: Config)`, `event`, `chat.message`, `chat.params`, `shell.env`
- Config `permission` schema: `read`, `edit`, `glob`, `grep`, `list`, `bash`, `task`,
  `external_directory`, ... each `ask | allow | deny` or rule map.
- `tools` config key is only a boolean enable/disable map. `AgentConfig.tools` is deprecated
  ("Use 'permission' field instead").
- `opencode serve` exists: `--port`, `--hostname` (default 127.0.0.1), `--pure`, `--print-logs`.

## 4. nono

- Binary: `/home/linuxbrew/.linuxbrew/bin/nono` v0.73.0
- Profile dir: `~/.config/nono/profiles/` — existing: `Orchestrator.json`, `opencode-sandbox.json`
- Built-in profile `nolabs-ai/opencode` (registry-managed, extends `default`) grants **RW to the
  current working directory** (`Workdir access: ReadWrite`) plus RW to `~/.opencode`,
  `~/.config/opencode`, `~/.cache/opencode`, `~/.local/share/opencode`,
  `~/.local/share/opentui`, `~/.local/state/opencode`, `$NONO_CONFIG/profile-drafts`, `$TMPDIR`;
  read: `$NONO_PACKAGES`, `$NONO_CONFIG/profiles`, `~/.agents`.
  → Confirms SYSTEM_PROMPT.md §15 warning: **secure OpenCode must NOT be started from a real
  project directory**; use a dedicated control dir.
- Existing `opencode-sandbox.json` extends `nolabs-ai/opencode` with Gentle-AI/AFT/Magic-Context
  paths — it is the current everyday profile, NOT the new security profile.
- Profile authoring guide (v0.73.0) verified: `meta`, `extends` (chain ≤ 10, array-append merge,
  no way to remove inherited filesystem paths), `groups.include/exclude`, `filesystem`
  (allow/read/write/allow_file/read_file/write_file/deny/bypass_protection/ignore, `$HOME`,
  `$WORKDIR`, `$TMPDIR`, `$NONO_CONFIG`, `$NONO_PACKAGES` expansion, `*`/`**` globs),
  `workdir.access` (none/read/write/readwrite), `network` (`block`, `allow_domain`, `deny_domain`,
  `open_port`, `listen_port`, `no_proxy`, `upstream_proxy`, `credentials`), `security`
  (signal_mode, process_info_mode, capability_elevation), `credential_capture`, `command_policies`.
- **Linux gotcha**: `filesystem.deny` overlapping a broader allow is a hard start error (Landlock
  is allow-list only) → write narrow grants, never broad allow + deny carve-outs.
- CLI available for Gate 2: `nono profile validate`, `nono profile show`, `nono profile diff`,
  `nono run --profile ... --dry-run -- ...`.

## 5. Microsandbox (msb) — Gate 3 candidate

- `msb doctor`: OK. Platform Linux x86_64; `MSB_HOME=/home/james/.microsandbox`;
  libkrunfw present; CPU virt `svm`; `/dev/kvm` **read/write accessible to the user** (no
  permission change needed); x2AVIC enabled; reflink unavailable → copy fallback for clones.
- `msb image list`: one image cached — `debian` (47 MiB).
- `msb list`: no sandboxes currently.
- CLI shape (argv-based, no shell interpolation):
  - `msb create [IMAGE] --conf <PATH> --net-conf <PATH> --resource-conf <PATH> --fs-conf <PATH>
    --runtime-conf <PATH> --secret-conf <PATH> --script-conf <PATH> -n <NAME> -c <CPUS>
    --max-cpus <N> ...` (sparse unwrapped config files)
  - `msb exec <NAME> [-- <COMMAND>...]` with `-w/--workdir`, `--timeout`, `-u/--user`,
    `--stream`, `--rlimit`, `-e KEY=value`
  - `msb copy <SOURCE> <DEST>` with `SANDBOX:/abs/path` syntax
  - also: `run`, `modify`, `start`, `stop`, `restart`, `ping`, `touch`, `list`, `status`,
    `metrics`, `remove`, `logs`, `ssh`, `inspect`, `image`, `volume`, `snapshot`, `doctor`
- Note: no SDK package detected on this host yet; broker may shell out to `msb` with strict
  argv vectors (spec §6 prefers SDK if available — re-check at Gate 3).

## 6. OpenChamber

- Binary: `/home/james/.bun/bin/openchamber` v1.18.4
- Config: `~/.config/openchamber/` → `settings.json`, `startup.env`, `install-id-web`,
  `push-subscriptions.json`, `ui-passkeys.json`, `jwt-secret` (secret — not displayed)
- `startup.env` currently contains `OPENCODE_PID=37288` and an OpenChamber UI password
  (secret — not reproduced here) → OpenChamber currently launches/manages its own OpenCode
  server. Spec §23: secured server must be `nono → opencode serve --port 4096`, and OpenChamber
  must connect to it, not launch a second server.
- Port 4096 currently free. `ss` shows an already-running `opencode` process (pid 198386) with
  multiple loopback listeners.

## 7. Network / services observed (listening)

- 100.90.20.31:443 (Tailscale), 127.0.0.1:8125, 0.0.0.0:8080/8081, 0.0.0.0:22, 0.0.0.0:19999,
  127.0.0.1:631 (cups), 0.0.0.0:3000, 0.0.0.0:18790 (nanobot), 100.90.20.31:8444-8446,
  127.0.0.53:53, several opencode loopback sockets (pid 198386)
- opencode-go proxy: `127.0.0.1:8788` **listening**; kinver proxy `127.0.0.1:13000` not
  currently listening.

## 8. Gentle-AI

- Binary: linuxbrew `gentle-ai` 2.4.0-rc.8; state: `~/.gentle-ai/` → `state.json`, `cache/`,
  `backups/`, `review-contexts/`. Orchestrator model assignments live in the global
  `opencode.json` `agent.*.model` keys (not altered by this project).

## 9. Implications for the implementation (recorded, not applied)

1. The secured OpenCode must run under a NEW nono child profile: control dir RW
   (`~/.local/share/opencode-sandbox-control/`), project roots **read-only**, credential stores
   only what OpenCode itself needs, everything else denied. Profile generated in-repo
   (`nono/profile/`), validated at Gate 2, installed only after review.
2. Stage A explicit `sandbox_*` tools: implement via a plugin `tool` hook (zod args,
   `ToolContext.sessionID/directory/worktree`, `ctx.ask()` for apply), with a routing guard on
   `tool.execute.before` that fails closed after activation (S5, §13).
3. The broker: Bun TypeScript service on a Unix socket
   `$XDG_RUNTIME_DIR/opencode-sandbox-broker.sock` (0700, user-only), spawning `msb` with argv
   vectors; state persisted in `~/.local/state/opencode-sandbox/`; systemd `--user` unit in
   repo, not installed (Gate 1).
4. Snapshot: temporary Git index + synthetic baseline commit under
   `refs/opencode-sandbox/baseline/<sessionID>`, transferred via bundle; results return via
   `refs/opencode-sandbox/result/<sessionID>`; apply only B→C delta after divergence check (S15,
   S16, §17–19).
5. Worker image: single trusted image (current candidate: `debian`), LLM cannot choose it;
   resource budget per §22 (reserve ≥25% CPU/RAM, never last 4 GiB); deny-by-default network in
   final config (S12).
6. Permissions fragment: additive `permission` fragment denying ordinary bash/edit/write and
   secret reads for protected agents; `sandbox_apply` → ask; never weakens existing rules (§14).
7. Existing OpenChamber launches its own OpenCode server today; launcher must point it at the
   secured `opencode serve` on 127.0.0.1:4096 and verify only one server is active (§23).
8. No live configuration was modified during discovery. Nothing is installed. KVM permissions
   unchanged. No credentials copied or displayed.

## 10. Manual gates status

- Gate 0 (Discovery complete): **ready for user review** (this report).
- Gates 1–10: pending; each requires explicit user action/approval per SYSTEM_PROMPT.md §27.
