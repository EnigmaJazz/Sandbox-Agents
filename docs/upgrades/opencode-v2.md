# Upgrade plan — OpenCode V2 migration (required by OpenChamber ≥ 2.0); side-by-side, non-destructive

Moved from `docs/TODO.md` on 2026-10-02; the TODO keeps a short entry pointing here.

Reviewed 2026-10-01 against these sources:
- the `@opencode/plugin@2.0.4` and `@opencode/schema@2.0.4` type declarations;
- OpenCode source at commit `466b3e59` (the commit gentle-ai pins);
- gentle-ai v4's V2 plugin assets and `docs/opencode-compatibility.md`;
- the OpenChamber v2.0.0 release notes.

Installed today: OpenCode 1.18.33 (V1, `~/.opencode/bin/opencode`), OpenChamber 1.24.2. Latest: OpenCode 2.0.21 (`npm @opencode/cli`), OpenChamber 2.1.0.

**Hold until this plan is ready**

- **Keep OpenChamber at 1.24.2.** OpenChamber 2.x requires OpenCode ≥ 2.0.15. Its startup screen offers a one-click "update to OpenCode 2" when it finds 1.x; **decline it**, because it would bypass this plan and the nono confinement.
- **Back up OpenCode's data directory first.** Its "sessions from 1.x carry over" may migrate session data in place, so before any V2 run, copy `~/.local/share/opencode` aside.

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
- **Rollback** is to stop the V2 launcher, start V1, and reinstall OpenChamber 1.24.2. Note its exact install command before upgrading it.

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
- **V0 — Discovery (read-only, scratch fixtures; no installation).** Do it now, then refresh it against the exact target release just before cutover.
  - Pin the target version (≥ 2.0.15; gentle-ai proved 2.0.19 with SDK 2.0.4; re-check 2.0.21's declarations for drift).
  - Record V2's built-in tool IDs and input shapes (the equivalents of read/grep/glob/list/bash/edit/write/apply_patch, plus `subagent`).
  - Record the V2 permission config format (native ordered rules), agent config, `serve` flags and authentication, the env vars for config and data roots, how to turn off the `~/.claude`/`~/.agents` sources, the session-ID format against the broker's `SESSION_ID_RE`, Code Mode semantics, and whether permission prompts show `message`/metadata.
  - Output: `docs/opencode-v2-discovery.md`, with sources.
- **V1 — Broker.** Expected to be a no-op. Confirm V2 session IDs pass validation and add a regression test.
- **V2 — Thin V2 adapter, `opencode/plugins-v2/sandbox-tools.ts` (late: written just before cutover, not in advance).**
  - Map P0's shared tool table to `ctx.tool.transform`. No tool logic is written here. The directory comes from `ctx.location.directory` at setup, the agent from `Tool.Context.agent`.
  - Map approval specs to V2 permissions, per V0's findings (replacing `ctx.ask`).
  - Parity test: the V2 adapter registers exactly the same tool names, and preserves every approval spec, as the V1 adapter.
  - Keep the legacy SDD tools dormant, following the gentle-ai 4 plan.
- **V3 — `routing-guard` and the system rule.** Port the guard to `ctx.tool.hook("execute.before")` (throw to refuse) using V2 tool IDs, and the rule text to `ctx.session.hook("model.request")`. Name the file so it sorts first: hook order follows sorted discovery, and a throwing hook skips later plugins' hooks.
- **V4 — Reviewer relay.** Port it to `subagent` and the V2 hook shapes, or retire it in favour of gentle-ai v4's managed V2 transport (which already binds `review-*` agents and refuses mismatches). The `asi-review-*` scheme existed only because the V1 transport owned the `review-*` names. Decide in V0. Either way, never synthesise provider values (AGENTS.md).
- **V5 — Config fragments (V2 format).**
  - Permissions: the V2 equivalents of bash/edit/write deny, `host_*`/`sandbox_*` rules and the credential read denies.
  - Agents and roles; review agents.
  - Disable the `~/.claude`/`~/.agents` sources.
  - `codemode: false` on the gated tools.
- **V6 — Confinement and launch.**
  - The `nono/profile/opencode-v2-secure.json` profile (V2 binary path, V2 XDG roots, deny `~/.claude`/`~/.agents` unless V0 shows they can be turned off in config).
  - `scripts/start-secure-opencode-v2`, using the same control-directory refusal rules; `scripts/start-openchamber` taking a target port/version.
  - Server password handling without logging it (§26).
  - The `systemd-user` V2 template; `scripts/install-user-files` and `scripts/rollback` entries for the V2 paths.
- **V7 — Tests.**
  - Pure-logic tests for the new adapters (hook payload mapping, tool registration list, the permission mapping) in `broker/tests/`. The broker stays dependency-free, so no V2 SDK import in tests.
  - A gated V2 host fixture modelled on gentle-ai's `scripts/test-opencode-v2-host.py`: isolated XDG roots, loopback-only network, a scripted provider.

**Cutover (user, after gentle-ai 4 is upgraded, and after P0, the refreshed V0, and the late V2–V7 are installed and verified)**

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
