# Upgrade plan — OpenCode V2 migration (required by OpenChamber ≥ 2.0); side-by-side, non-destructive

Moved from `docs/TODO.md` on 2026-10-02; the TODO keeps a short entry pointing here.

Reviewed 2026-10-01 against these sources:
- the `@opencode/plugin@2.0.4` and `@opencode/schema@2.0.4` type declarations;
- OpenCode source at commit `466b3e59` (the commit gentle-ai pins);
- gentle-ai v4's V2 plugin assets and `docs/opencode-compatibility.md`;
- the OpenChamber v2.0.0 release notes.

**Status 2026-11-01: the cutover is complete (owner-attested, before 2026-11-01).** The working build is OpenCode V2 **2.2.2**, installed under `~/.local/share/opencode-v2/prefix` and served on port 4097 by `secure-opencode-v2.service` under the `opencode-v2-secure` nono profile (owner-attested). The repository contains the corresponding V2 sources: `opencode/plugins-v2/`, `nono/profile/opencode-v2-secure.json`, `scripts/*-v2*`, `docs/secure-opencode-v2.service.template` and `scripts/check-v2-stack.ts` (repository-verified). V1 1.18.33 (`~/.opencode/bin/opencode`, port 4096) and OpenChamber 1.24.2 are retained for rollback and are not the working build. At review time the plan's upstream reference was 2.0.21; the owner pinned 2.2.2 (`docs/opencode-v2-discovery.md:9`).

**Historical pre-cutover hold (superseded 2026-11-01)**

- **Keep OpenChamber at 1.24.2.** OpenChamber 2.x requires OpenCode ≥ 2.0.15. Its startup screen offers a one-click "update to OpenCode 2" when it finds 1.x; **decline it**, because it would bypass this plan and the nono confinement.
- **Back up OpenCode's data directory first.** Its "sessions from 1.x carry over" may migrate session data in place, so before any V2 run, copy `~/.local/share/opencode` aside.

Both instructions applied before the cutover; the OpenChamber one is superseded — whether OpenChamber 2 is now attached is an open item, listed under **Post-cutover status** below.

**What V2 changes (verified from the declarations and source)**

1. **The plugin API is rewritten.** `Plugin.define({ id, setup(ctx) })` returns a cleanup function, and the package becomes `@opencode/plugin` (V1 was `@opencode-ai/plugin`). Tools are added with `ctx.tool.transform(editor => editor.add({ name, input, description, execute, options }))`, and `execute` returns `{ content, output, metadata }`. Hooks are `await ctx.tool.hook("execute.before" | "execute.after", …)`, `ctx.shell.hook("create.before")`, `ctx.permission.hook("evaluate")` and `ctx.session.hook("model.request")` (mutable `system[]`, replacing V1's `experimental.chat.system.transform`). Events come from `ctx.event.subscribe`, and the location from `ctx.location.directory`.
2. **The tool context has no `ask` and no `directory`.** `Tool.Context` holds only `sessionID`, `agent`, `messageID`, `id` and `progress`. Every approval prompt in `sandbox-tools.ts` (the about 20 `ctx.ask(build*Ask(...))` calls, including the `sandbox_apply` diff preview, `host_git_commit` and `host_git_push`) has to move to declarative `options.permission` keys plus config rules, with `permission.hook("evaluate")` (which carries `metadata` and `message`) for context. **Open question:** whether OpenChamber or the TUI show `message`/metadata in the approval prompt. If not, the preview-file rule in `apply-preview-guard.ts` must carry the approval.
3. **Better agent identity.** The host supplies `agent` on every tool call and every execute hook. That can replace the V1 `chat.params` binding (`bindSessionAgent`) with something stronger.
4. **The Task tool is now `subagent`** (`input.agent`, `input.prompt`, `input.background`, `input.sessionID`). OpenCode 2.0.19 adds the line "You are a subagent spawned by another session." to subagent prompts. When one plugin's execute hook throws, later plugins' hooks are skipped for that call.
5. **Plugin discovery loads `.ts`/`.js` files *and subdirectories*** from `plugin/` and `plugins/` under each config root. The installed V1 `~/.config/opencode/plugins/` (with `lib/`) would be loaded by V2, so V1 and V2 **must not share a config root**.
6. **V2 also reads `~/.claude` and `~/.agents`** as config sources, globally and per project. That's a confinement risk for the secure stack: Claude Code agents, skills and hooks could leak in. It must be disabled or confined. V2 reads `AGENTS.md` and not `CLAUDE.md`.
7. **Code Mode** (OpenChamber 2.0) lets the agent call plugin tools from a script. `Tool.Options.codemode` exists, so set `codemode: false` on every `host_*` and approval-gated `sandbox_*` tool, and prove per-call permission still applies.
8. **OpenChamber 2 attaches to OpenCode 2.** Server authentication changes (V2 `serve` uses a password; OpenChamber needs a UI password for tunnels), and settings apply live without a restart.
9. **Review depends on gentle-ai 4.** V2 native review is admitted only with gentle-ai v4's managed V2 relay declaration (`gentle-ai.opencode-relay/v2-staged`); gentle-ai 3.7 has no V2 transport. **Do the gentle-ai 4 upgrade first.**

**Strategy: a parallel V2 stack; cutover and rollback are launcher switches**

- **Separate everything V1 uses:** the V2 binary (npm `@opencode/cli`, pinned version), `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_STATE_HOME` roots for V2, port (e.g. 4097), nono profile, launcher (`scripts/start-secure-opencode-v2`), systemd template and plugin sources (`opencode/plugins-v2/**`, new and S17).
- **The V1 tree stays untouched:** the binary, `~/.config/opencode`, `~/.local/share/opencode`, `opencode/plugins/**` and port 4096.
- **The broker is shared**; its protocol is host-agnostic.
- **The V2 data root starts as a copy** of the V1 data, so any carry-over migration happens on the copy.
- **Rollback (retained):** stop the V2 launcher, start V1, and reinstall OpenChamber 1.24.2. The exact reinstall command is recorded in `docs/upgrades/opencode-v2-install-checklist.md`.

**Avoiding duplicate work: one implementation, thin adapters, adapter written late**

- **Only the OpenCode plugin entry layer differs between V1 and V2.** The broker, `lib/` modules and the gentle-ai 4 dormancy switch are shared, and changes to them are made once.
- **Keep all tool logic in one host-neutral table** (step P0). Each OpenCode version then needs only a thin adapter that translates that table into its plugin API.
- **Write the V2 adapter late: just before cutover, never in advance.** Do it only when the cutover date is set, gentle-ai 4 is installed and verified, and V0 has been refreshed against the target V2 release. A V2 adapter written early would have to be kept in step with every later V1 change, which is exactly the duplication this plan avoids.
- **Until then, all new tools and features land in the shared table and run through the V1 adapter.** That includes plan A's advisor tools.
- **Reconcile first.** Before starting, reconcile this plan with workflow_optimisation's parallel V2 queue (Q40–Q47 and `~/ai-workspace/OPENCODE-V2-PLUGIN-TASKS.md`) so only one plan drives the plugin work.

**Workstreams**

Timing:
- **Now, on V1:** P0, V0 and V1. These are useful even if V2 never happens.
- **Late, just before cutover:** V2–V7, in order, as one bounded run of ODD tasks (each under the 400-line cap).

- **P0 — Shared tool table and thin V1 adapter (now; a no-behaviour-change refactor of the V1 plugin).**
  - Move every tool's definition into one host-neutral table in `opencode/plugins/lib/` (for example `tool-specs.ts`), with:
    - name, description and argument schema;
    - a handler that takes `(args, { sessionID, agent, directory })` and returns the result string;
    - an approval spec stated independently of the host. For example: "ask, with this metadata builder and this preview guard", or "none".
    - It reuses `broker-client`, `sandbox-edit-core`, `host-tool-approval` and `apply-preview-guard` unchanged.
  - Reduce `opencode/plugins/sandbox-tools.ts` to a thin V1 adapter. It maps the table to `tool({...})`, maps approval specs to `ctx.ask`, and takes `sessionID`, `agent` and `directory` from the V1 context. The legacy SDD tools stay dormant, following the gentle-ai 4 plan.
  - Tests:
    - the adapter registers exactly the table's tool names;
    - every gated tool's approval spec is preserved, and asks before acting;
    - `bun test` stays green with unchanged behaviour.
  - The same idea for config: keep permission and agent entries in one source, or add a parity test, so V5 can generate the V2 format rather than copying it by hand.
- **V0 status 2026-10-29:** done for 2.2.0 in `docs/opencode-v2-discovery.md` (refresh against the cutover release). **V1 status:** a no-op; V2 session ids pass the broker allowlist, pinned by `broker/tests/v2-session-ids.test.ts`.
- **V0 — Discovery (read-only, scratch fixtures; no installation).** Do it now, then refresh it against the exact target release just before cutover.
  - Pin the target version (≥ 2.0.15; gentle-ai proved 2.0.19 with SDK 2.0.4; re-check 2.0.21's declarations for drift).
  - Record V2's built-in tool IDs and input shapes (the equivalents of read/grep/glob/list/bash/edit/write/apply_patch, plus `subagent`).
  - Record the V2 permission config format (native ordered rules), agent config, `serve` flags and authentication, the env vars for config and data roots, how to turn off the `~/.claude`/`~/.agents` sources, the session-ID format against the broker's `SESSION_ID_RE`, Code Mode semantics, and whether permission prompts show `message`/metadata.
  - Output: `docs/opencode-v2-discovery.md`, with sources.
- **V1 — Broker.** Expected to be a no-op. Confirm V2 session IDs pass validation and add a regression test.
- **V2 — Thin V2 adapter, `opencode/plugins-v2/sandbox-tools.ts` (late: written just before cutover, not in advance).**
  - **Status 2026-10-29 (written early at the owner's request, under a session-scoped S17 waiver for `opencode/plugins-v2/`; installed before 2026-11-01, owner-attested):** entry `opencode/plugins-v2/sandbox-tools.ts` + pure mapping `opencode/plugins-v2/lib/v2-adapter.ts`, tests `broker/tests/v2-adapter.test.ts`. Verified on isolated V2 2.2.0: it loads and offers exactly the 42 tool names of the V1 table. Not verified live: the approval round trip (`ctx.permission.assert`) and broker calls (needs a broker). Agent binding is made from the tool context on each call (replaces the V1 `chat.params` hook). Still open: V3 guard and system rule, V4 relay, V5 config (permission rules for each gated tool name must exist, or `assert` has nothing to ask about), V6 launch, V7 host fixture.
  - Map P0's shared tool table to `ctx.tool.transform`. No tool logic is written here. The directory comes from `ctx.location.directory` at setup, the agent from `Tool.Context.agent`.
  - Map approval specs to V2 permissions, per V0's findings (replacing `ctx.ask`).
  - Parity test: the V2 adapter registers exactly the same tool names, and preserves every approval spec, as the V1 adapter.
  - Keep the legacy SDD tools dormant, following the gentle-ai 4 plan.
- **V3 status 2026-10-29 (written early under the same session-scoped waiver; installed before 2026-11-01, owner-attested):** `opencode/plugins-v2/00-routing-guard.ts` + pure core `opencode/plugins-v2/lib/guard-core.ts`, tests `broker/tests/v2-routing-guard.test.ts` (24). The rule goes in through the session `context` hook (verified shape), not `model.request`. Translates `shell`/`subagent` to the inventory's `bash`/`task`; Code Mode's `execute` is unclassified and so denied. V2 input keys: read `path`, grep `pattern`+`path`, glob `pattern`. Two V1 defects fixed in the port (V1 left untouched, S17 owner decision): `<approved root>/../project` passed the external-root check, and the denial-reason regex `/[\\r\\n]+/` matched a backslash and the letters r and n instead of line breaks. Verified on isolated V2 2.2.0: with the broker unreachable both `shell` and `read` are refused (fail closed) and the rule is in the prompt. Not verified live: a reachable broker (admission, worker states) and hook order against other plugins. Open: the broker inventory has no V2-only tool names beyond `shell`/`subagent` (for example `todowrite` may differ) so unknown ones are denied until classified (broker/src is S17).
- **V3 — `routing-guard` and the system rule.** Port the guard to `ctx.tool.hook("execute.before")` (throw to refuse) using V2 tool IDs, and the rule text to `ctx.session.hook("model.request")`. Name the file so it sorts first: hook order follows sorted discovery, and a throwing hook skips later plugins' hooks.
- **V4 status 2026-10-29 (owner decision: the relay stays, because sandboxed agents have no shell by design; written early under the same session-scoped waiver; installed before 2026-11-01, owner-attested):** `opencode/plugins-v2/reviewer-relay-transport.ts`, mapping `opencode/plugins-v2/lib/relay-v2.ts`, agent fragment `opencode/plugins-v2/config-fragments/reviewer-relay-agents.jsonc`, tests `broker/tests/v2-reviewer-relay.test.ts` (19, real relay core with a scripted transport child). The V1 core `plugins/lib/reviewer-relay-core.ts` is shared and untouched. V2 facts used (probe-relay fixture): the Task tool is `subagent` {agent, description, prompt}; a before-hook can rewrite `input.prompt` but V2 prepends "You are a subagent spawned by another session.", so the child's `context` hook rewrites system and the last user message in place (replaces V1's two transform hooks); the after-hook writes `result.content`; `session.created` carries {sessionID, parentID, agent}; a thrown before-hook error reaches the model intact (V1 had to return refusals). Verified on isolated V2 2.2.0: the six `asi-review-*` agents resolve as hidden subagents, and with no broker the model receives `reviewer_relay_policy_refused: Failed to connect` (fail closed, typed text intact). **Not verified live:** the success path (needs the broker and a real `gentle-ai review opencode-transport` with a review context), concurrency across four lenses, and after-hook refusals (they replace `result.content`; an after-hook cannot turn a completed Task into an error). Open: the orchestrator's permission to dispatch `asi-review-*` (the `subagent` rule) is not in these fragments.
- **V4 — Reviewer relay.** Port it to `subagent` and the V2 hook shapes, or retire it in favour of gentle-ai v4's managed V2 transport (which already binds `review-*` agents and refuses mismatches). The `asi-review-*` scheme existed only because the V1 transport owned the `review-*` names. Decide in V0. Either way, never synthesise provider values (AGENTS.md).
- **V5 — Config fragments (V2 format).**
  - **Status 2026-10-29 (written early under the same session-scoped waiver; installed before 2026-11-01, owner-attested):** `opencode/plugins-v2/config-fragments/{sandbox-permissions,role-agents}.jsonc`, tests `broker/tests/v2-config-fragments.test.ts`. Findings: on V2 a tool with no rule is silently allowed, so every tool has an explicit rule (three V1 left to its default now say `ask`); the V1 `read` {allow, deny} object is invalid config on both V1 and V2 and is a pattern map here; V2 converts agent `tools` maps and `task` denies into rules. Verified on isolated V2 2.2.0: researcher is offered only its 4 read tools, worker only the sandbox set, host shell/edit denied, 12 secret-read denies, 20 `ask` rules. Open: the `~/.claude`/`~/.agents` sources have no config knob (V6 nono profile); the reviewer-relay agents belong to V4. The V1 fragment's `read` block still needs its own fix (S17 path, owner decision).
  - Permissions: the V2 equivalents of bash/edit/write deny, `host_*`/`sandbox_*` rules and the credential read denies.
  - Agents and roles; review agents.
  - Disable the `~/.claude`/`~/.agents` sources.
  - `codemode: false` on the gated tools.
- **V6 status 2026-10-29 (written early under a session-scoped S17 waiver for `opencode/plugins-v2/`, `nono/` and `scripts/`; installed before 2026-11-01, owner-attested):** `nono/profile/opencode-v2-secure.json`, `scripts/secure-launcher-v2.conf`, `scripts/start-secure-opencode-v2`, `scripts/install-user-files-v2`, `scripts/rollback-v2`, `docs/secure-opencode-v2.service.template`, tests `broker/tests/v2-launch.test.ts` (21). V1 files are untouched: a separate installer and rollback keep the V1 installer's tests and journal as they are. Facts (opencode-v2-probe): `serve` has no password flag, the password is the `OPENCODE_SERVER_PASSWORD` environment variable; `OPENCODE_DISABLE_CLAUDE_CODE=1` hides `~/.claude` skills but nothing in config or the environment hides `~/.agents` skills, so the nono deny on both directories is the real control. Verified under a real `nono run` with the V2 profile: the password reaches the child's environment, and `~/.claude`, `~/.agents`, `~/.ssh`, `~/.local/share/opencode` and `~/.config/opencode` are all unreadable. The profile drops the `opencode_linux` group (it grants the V1 binary directory) and V1's `~/.agents/skills` read. The installer stages the fragments in `~/.local/share/opencode-v2/fragments/` and never edits a V2 `opencode.json`. Security follow-ups from the native review of `34b69fe`: the V2 config root (where the installer puts the guard, the sandbox tools and the relay) is granted read-only, because Landlock cannot make a subdirectory read-only inside a writable grant and V2 runs fine with a read-only config root; verified under a real `nono run` (config not writable, data writable). The server password is already removed by V2 from its shell tool and MCP children (probe), so no launcher change was needed, but in-process plugins can read it. The remaining review items were then fixed too: no project `.git` directory is writable in the V2 profile (V2 never writes there, probe: no new entries, and it runs with `.git` read-only; verified under `nono run`: not writable, readable), the launcher refuses a control directory that is inside a project root or a git checkout (so `--control-dir` cannot skip the refusals), the two machine-dependent tests are hermetic (the nono validate test skips visibly without nono), and the installer plans and validates every destination before writing anything, with collision-proof backup names. Not done: OpenChamber 2 attach (its V2 contract is unobserved, so `scripts/start-openchamber` is unchanged), the real `systemd-user/` unit (S17, not waived; the template is in docs/), and a real V2 `serve` start under nono. `zod` must be resolvable from the V2 config root (the installer warns).
- **V6 — Confinement and launch.**
  - The `nono/profile/opencode-v2-secure.json` profile (V2 binary path, V2 XDG roots, deny `~/.claude`/`~/.agents` unless V0 shows they can be turned off in config).
  - `scripts/start-secure-opencode-v2`, using the same control-directory refusal rules; `scripts/start-openchamber` taking a target port/version.
  - Server password handling without logging it (§26).
  - The `systemd-user` V2 template; `scripts/install-user-files` and `scripts/rollback` entries for the V2 paths.
- **V7 status 2026-10-29 (written early under the same session-scoped waiver; installed before 2026-11-01, owner-attested):** the gated host fixture is `broker/tests/v2-host.test.ts` (7 tests). It runs a REAL OpenCode V2 in an isolated HOME and XDG roots against the plugins as installed by `scripts/install-user-files-v2 --apply`, the V2 permission and role fragments, a scripted OpenAI-compatible provider and a fake broker on a Unix socket (loopback only, no model, no worker). Off by default; enable with `OPENCODE_V2_HOST_TEST=1 OPENCODE_V2_BIN=<V2 cli> bun test tests/v2-host.test.ts` (the binary must not be under `~/.opencode`; `zod` from `ZOD_DIR` or `~/.config/opencode/node_modules/zod`). Verified on V2 2.2.0: a sandbox tool reaches the broker after the session is bound to the host-supplied agent; the guard asks the broker to admit non-sandbox tools and refuses Code Mode's `execute`; host reads run before activation and are redirected once a worker is active; an unreachable broker refuses a host read; `sandbox_apply` without approval is rejected and the broker never receives `applyResult`, with approval it does (positive control); the researcher role is offered only read tools. Not covered: the reviewer relay (needs a real `gentle-ai` transport), a real broker and worker, the interactive approval prompt, and `serve`/OpenChamber.
- **V7 — Tests.**
  - Pure-logic tests for the new adapters (hook payload mapping, tool registration list, the permission mapping) in `broker/tests/`. The broker stays dependency-free, so no V2 SDK import in tests.
  - A gated V2 host fixture modelled on gentle-ai's `scripts/test-opencode-v2-host.py`: isolated XDG roots, loopback-only network, a scripted provider.

**Post-cutover status (2026-11-01).** Repository-verified: the V2 plugin, profile, launcher, installer, rollback, service template and health-check sources exist at the paths above; the V2 profile serves port 4097 (`nono/profile/opencode-v2-secure.json:144`); `scripts/check-v2-stack.ts` exists and checks tool IDs, agent names and plugin names. Owner-attested: the cutover, the running 2.2.2 build, the installed systemd unit and the installed profile. Correction to the V6 note above: the profile now **does** grant project `.git` write, as a documented trade-off (`nono/profile/opencode-v2-secure.json:5`; the same premise is stated at `broker/src/gitguard.ts:4`), so the earlier "no project `.git` directory is writable" statement is superseded.

- Open — **OpenChamber 2 attach.** The repository has the launcher and unit template (`scripts/start-openchamber-v2`, commit `0a884d1`); whether OpenChamber 2 is installed and attached to port 4097 is a live state and is owner-to-confirm.
- Open — **real systemd unit.** The template `docs/secure-opencode-v2.service.template` is repository-verified; installation at `~/.config/systemd/user/secure-opencode-v2.service` is owner-attested.
- Partial — **V0 refresh against the cutover release.** Re-verified on 2.2.2 for the listed facts; not re-run for the nono profile checks, the verifier's section 9 against a full config, or anything needing a TTY (`docs/opencode-v2-discovery.md:10-11`).
- Unknown — byte-level verification of the installed V2 files, the resolved plugin patch versions, and an end-to-end `asi-review-*` relay run on the live V2 broker. Each is recorded as an owner-to-confirm question, not as a defect.

**Cutover — completed (owner-attested, before 2026-11-01); the steps below are the record and the rollback reference**

1. Back up `~/.local/share/opencode`, record the OpenChamber 1.24.2 reinstall command, and install the pinned V2 CLI to its own path.
2. Copy the V1 data into the V2 data root, start `start-secure-opencode-v2`, then run the manual gates on V2:
   - host read routing and mutation blocking;
   - lazy worker activation;
   - `sandbox_edit` (mode preserved);
   - `sandbox_apply` approval with the full preview;
   - a `host_git_commit` approval;
   - native review end to end;
   - Code Mode cannot bypass approval;
   - no `~/.claude` content visible.
3. Upgrade OpenChamber and point it at the V2 port. Only then retire the V1 launcher. Keep the V1 tree for rollback.
