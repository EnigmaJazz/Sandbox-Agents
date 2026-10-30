# OpenCode V2 discovery (workstream V0 of docs/upgrades/opencode-v2.md)

Observed on OpenCode **V2 2.2.0** (npm `@opencode/cli`, binary `opencode2`), 2026-10-29, in isolated HOME and XDG roots with a scripted
provider on loopback. Nothing here touched the V1 install, config, data or port 4096. Refresh it against the exact release chosen
for cutover. Source evidence: `~/opencode-v2-probe/` (`FINDINGS.md`, `FINDINGS-2.md`, `FINDINGS-3.md`, the fixtures and the
`run_probe*.py` scripts) and the host fixture `broker/tests/v2-host.test.ts`. [V] observed, [I] inferred, [U] unknown.

## Target version
- **Owner decision 2026-10-29: pin 2.2.2** (npm `latest` that day). Installed in isolation at `~/opencode-v2-probe/prefix-2.2.2` (the 2.2.0 prefix is kept). gentle-ai's review proof was on 2.0.19; OpenChamber needs at least 2.0.15.
- [V] Re-verified on 2.2.2: the host fixture (`broker/tests/v2-host.test.ts`, 7 of 7); the `retry` hook with `switchModel`; the `subagent` before/after hooks and the child `context` rewrite; the password scrub (a control variable inherited, the password variables not); a tool with no rule runs silently while an `ask` rule rejects non-interactively; the `debug agents` shape (`id, name, mode, hidden, permissions[{action,resource,effect}]`). No difference from 2.2.0 was found.
- [U] Not re-run on 2.2.2: the nono profile checks (they do not depend on the V2 binary), the verifier's section 9 against a full config, and anything that needs a TTY. All facts below were first observed on 2.2.0.

## Built-in tool ids and input shapes
| Tool | V2 id | Input |
|---|---|---|
| shell | `shell` (V1 `bash`) | `{command, workdir?, timeout?}` |
| read | `read` | `{path}` (V1 `filePath`) |
| grep | `grep` | `{pattern, path?}` |
| glob | `glob` | `{pattern}` |
| edit, write, patch | `edit` | one id (permission action `edit`) |
| subagent | `subagent` (V1 `task`) | `{agent, description, prompt, background?, sessionID?}` |
| Code Mode | `execute` | `{code}`; built-ins are `codemode:false`, plugin tools default to callable from it |
| others | `webfetch`, `websearch`, `question`, `skill` | |
There is no `list` tool. A tool id missing from the broker's `TOOL_CLASSIFICATION_INVENTORY` is unclassified and denied.

## Permissions and agents
- [V] A V1 `permission` map is accepted and normalised: `bash` becomes `shell`; `write`, `apply_patch` become `edit`; `task` becomes `subagent`.
  `debug agents` shows rules as `{action, resource, effect}`; the base rule is `* * allow`, later rules win.
- [V] **A tool with no rule is allowed silently.** V1 asked by default. Every gated tool needs an explicit `ask` or `deny`.
- [V] `read` takes a pattern map (`{"**/.ssh/**": "deny"}`). The `{allow: [], deny: [...]}` object form is invalid config on V1 and V2.
- [V] Agent `tools` maps become rules (`"*": false` becomes `* * deny`, each `true` an allow). A config `deny` removes the tool from the model's list.
- [V] `ctx.permission.assert({action, resources, metadata, sessionID, agent?})` works inside a plugin tool: a rule `ask` plus `--auto` continues, without it the call is `permission.rejected`; a hook deny throws.
  The permission hook never fires for plugin tools; `ctx.tool.hook("execute.before")` is their only gate.

## Plugin API facts the adapters use
- [V] Only a plain-object default export `{id, setup}` loads (a dual `{id, setup, server}` works; `setup` runs once per directory). Config entries must be directories.
- [V] `ctx.tool.transform(editor => editor.add({name, description, input, execute, options}))`; `input` accepts zod (standard schema) or JSON Schema; `execute` returns `{content}`. Tool context: `sessionID, agent, messageID, id, progress`; no `directory`: use `(await ctx.session.get({sessionID})).location.directory`.
- [V] `execute.before` may mutate `input`; throwing refuses the call and the message reaches the model. `execute.after` may rewrite `result.content`.
- [V] `ctx.session.hook("context")` event has `{sessionID, agent, system, messages, model, options, tools}`; system entries are `{type:"text", text}`, messages `{role, content:[{type:"text", text}]}`, both editable in place.
- [V] `ctx.session.hook("retry")` and `switchModel` (see `FINDINGS-3.md`). `session.created` event data: `{sessionID, parentID, agent, title}`; `session.deleted`: `{sessionID}`.
- [V] Plugin discovery loads `.ts`/`.js` files in `<config root>/plugins/`; `plugins/lib/` is not loaded as a plugin. Hooks run in sorted file order; hence `00-routing-guard.ts`.

## Server, auth and roots
- [V] `opencode serve` flags: `--hostname --port --cors --service --stdio`. No password flag: the password is the environment variable `OPENCODE_SERVER_PASSWORD` (`OPENCODE_PASSWORD` also exists). V2 removes both from the environment of its shell tool and of MCP servers it starts; other variables are inherited. In-process plugins can read it.
- [V] `opencode run` without `--standalone` joins a shared background service on fixed port 49374; always pass `--standalone` for probes and close stdin.
- [V] Roots follow XDG: `XDG_CONFIG_HOME/opencode`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`; `OPENCODE_CONFIG_DIR` is listed as a config source but plugins in it did not load. V2 runs with a read-only config root.
- [V] V2 searches every ancestor directory of the project for config, `.opencode`, `.claude` and `.agents`: anything in the home directory leaks into V2 (a stray `~/opencode.jsonc` installed an unpinned plugin during probing).
- [V] V2 does not write into a project's `.git`.

## `~/.claude` and `~/.agents`
- [V] `~/.claude/skills` and `~/.agents/skills` are read as skill sources. `OPENCODE_DISABLE_CLAUDE_CODE=1` (or `..._SKILLS=1`) hides the `~/.claude` skills; **nothing hides `~/.agents`**. Not read: `CLAUDE.md` files, `~/.agents/AGENTS.md`; `~/.claude/agents` markdown agents were not picked up.
- [V] Under nono (Landlock) a deny on both directories works: `~/.claude`, `~/.agents` are unreadable to the process (profile `nono/profile/opencode-v2-secure.json`). Landlock cannot make a subdirectory read-only inside a writable grant and refuses a deny overlap. nono also keeps its own state under `$XDG_STATE_HOME/nono` and refuses to start if the profile grants a directory above it ("overlaps protected nono state root"), so the V2 XDG variables must reach only the server inside the sandbox (`nono run -- env XDG_...=... opencode2 serve`), never nono itself (found on the first real start, 2026-10-30).

## Sessions and the broker
- [V] V2 session ids are `ses_` plus 26 alphanumerics (30 characters), for example `ses_e7685f69affe4QgQ1ES5hVBiGl`. They pass the broker's `SESSION_ID_RE` (`/^[A-Za-z0-9_-]{1,64}$/`); regression test `broker/tests/v2-session-ids.test.ts`. Workstream V1 (broker) is therefore a no-op.
- [V] The broker is host-agnostic: the fake-broker host fixture drives real V2 through the NDJSON protocol unchanged.

## Still unknown
- Interactive approval prompts and the TUI (`tui.json` to `cli.json` migration needs a TTY; `tui.jsonc` is never migrated).
- OpenChamber 2 attach and its server authentication; `serve` under nono with a real broker and worker.
- What `plugin update` writes on success; behaviour of a session after it is moved; whether a later 2.2.x changes any of the above.
