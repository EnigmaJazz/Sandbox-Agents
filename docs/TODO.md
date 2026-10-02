# TODO — agent-sandbox-integration

Last reconciled: 2026-10-01. This file is the ordered project to-do list. Status claims are repository evidence only; live user configuration is not inspected here. Owners: **A** = agent, **U** = user, **X** = external project/person.

## Tier 1 — silent work destruction / unrecoverable loss (0 open items)

All Tier 1 items are implemented and committed.

1. **Trace-file inventory/consent defect** — **COMPLETE**; owner **A**. The fix is committed as `f048a67` on `feat/review-and-state-hardening`. The scoped assessment against base `1407a78` returned `review_due: false`, reason `under_budget`; no review was due or run, so this change is not individually reviewed and joins the pending accumulated slice. Source: `odd/tasks/review-trace-write-guard.md`.

2. **`readFile` silent truncation** — **COMPLETE**; see Completed.

3. **`writeFile` mode and ownership reset** — **COMPLETE**; see Completed.


## Tier 2 — blocks other work (12 items)

1. **Host review pipeline tools P-1–P-4** (`host_git_range_materialize`, `host_review_pipeline_run`, `host_review_artifact_write`, optional `host_git_read`) — **OPEN / proposed**; owner **A**. Build the fixed-argv, bounded, shared-materialization/execution/artifact surface. Tier 2 because reviewers currently lack the diff and packaged pipeline cannot run. Source: `docs/PLAN.md:21–56,58–64`.
2. **Project `.git` read-write + `.codegraph` create/grant coverage** — **OPEN**; owner **A**. Add the registration/profile create-and-grant path, including linked worktree `.git` metadata. Tier 2 because projects/worktrees cannot be safely registered with the required index and git access. Source: `odd/tasks/register-project-profile-grants.md:87–111,193–201`; `docs/TODO.md` (prior item 27, line 71, consolidated here).
3. **Deployment-verification gap** — **OPEN**; owner **U** for installed-byte verification, **A** for a repo-side verifier proposal. Add a reliable post-install comparison so stale plugin/profile mirrors cannot appear current. Tier 2 because unverified installed bytes can invalidate subsequent checks. Source: `docs/TODO.md` (prior follow-up at line 238, consolidated here).
4. **Host git read tools** (`status|diff|log|show|branch`) — **OPEN**; owner **A**. Implement the read-only broker/plugin operations. Tier 2 because review and branch facts otherwise require user-pasted host commands. Source: `odd/tasks/host-git-tools.md:179–190,290–298`.
5. **`host_journal`** — **OPEN**; owner **A**. Add bounded user-journal reads for allowlisted units after deciding the overlap with `hostServiceLogs`. Tier 2 because operational evidence is otherwise unavailable to the orchestrator. Source: `odd/tasks/host-journal-tool.md:219–280,336–344`.
6. **Python worker verification** — **OPEN / design unresolved**; owner **A**. Decide dependency/interpreter provisioning or explicitly define host-side verification, including Python 3.14 compatibility. Tier 2 because one reported project could not run its tests in the worker. Source: `docs/TODO.md` (consolidated from the prior worker-verification item 7 at lines 204–217 before this rewrite).
7. **Router-ledger append operation** — **PLANNED; external design dependency**; owner **A** for implementation, **X** for the design in the workflow-optimisation repository. Extend `host_plan_append` for the `router-log` document using the broker-owned destination enum and the bounded, validated, atomic, orchestrator-only, approval-gated, S17-aware behavior specified in `docs/PLAN.md:1–17`; do not duplicate that design here. Dependency: complete the external workflow-optimisation design before implementation. Tier 2 because the global ledger is required for every routed unit, while missing append capability forces manual row handoff and reconstruction. Source: `docs/PLAN.md:1–17`.
8. **Claim-retractions ledger append operation** — **PLANNED**; owner **A**. Extend the shared `host_plan_append` operation with the broker-resolved `claim-retractions` document value; implement the bounded, row-schema-validated, atomic, orchestrator-only, approval-gated, S17-aware behavior specified in `docs/PLAN.md` rather than duplicating its design here. Dependency: the shared append operation and its broker-owned document enum. Tier 2, matching the router-ledger item, because the next session needs evidence-backed corrections and reconstructing them from memory repeats the failure this ledger is meant to prevent. Source: `docs/PLAN.md` (claim-retractions ledger section).
9. **Socket-drain completion** — **OPEN (slices 3–4 only)**; owner **A**. The live re-probe passed on 2026-10-01: `sandbox_read` returns small files whole, and a ~4,800-line file completes without a broker timeout (any shortening is the harness's own per-response limit). workflow_optimisation's "`sandbox_read` broken at any size" conclusion is superseded. Remaining: update `odd/tasks/socket-write-drain.md` (it still says "T1–T6 not started"), then slices 3–4 (T4 review fixes, T5/T6 checks). Slice 2 (T3) was delivered as `374e347`. Source: `odd/tasks/socket-write-drain.md`; workflow_optimisation probe reports 2026-10-01.
10. **External advisor system (plan A)** — **PLANNED**; owner **A**, **U** (S17 review and installation). Read-only Claude Code/Antigravity advisors, opened and prompted by the user, investigating in pinned throwaway workers. Their bound, immutable evidence feeds the existing gentle-ai adjudication and progression (agentless external-lens lineages, verified 2026-10-01). Includes the selection mechanism (`rotate`, independent groups, recorded overrides) behind workflow_optimisation's policy table. Tier 2 because workflow_optimisation's mandatory external advice lane (their B3–B5) is blocked on it. Its prerequisites (Tier 1 items 2–3, the drain fix and the live re-probe) are done. Source: `docs/advisor/plan-sandbox-integration.md`, `docs/advisor/interface-contract.md`.
11. **Install-vs-commit gap** — **OPEN**; owner **A**. After a result is installed with `host_sandbox_result_install`, `host_git_commit` refuses with `no applied B->C result`, so installed work can't be committed through the host tools and commits are handed over manually. Tier 2 because every installed result in workflow_optimisation hits it. Source: workflow_optimisation `docs/TODO.md` (2026-09-30 "item 1 fixed and verified; commit needs the host"); their item 8.
12. **Project-scoped signal for the routing guard** — **PLANNED; external design dependency**; owner **A** for the host-side operation, **X** for the design. The routing guard is project-blind: its markers can't satisfy a stage artifact for another project because no trustworthy session-to-project source exists. The guard's tracker plans a durable project-scoped signal, with the host-side operation built here. Tier 2 because stage gating, including any future advice stage, stays project-blind without it. Source: workflow_optimisation `odd/tasks/routing-guard-keys.md` (implementation order item 5; Debt).


## Planned — gentle-ai 4.0 upgrade (SDD retirement); implement when ready to upgrade

Reviewed 2026-10-01 against the v4.0.0 release notes and the tagged source (`ff77164`), compared with v3.7.0 (`6dee8f8`). Upgrade blocker today: Homebrew still offers 3.7.0, which is how this machine installed it.

**What v4 changes for this repository**

- **SDD is gone.** `sdd-status`, `sdd-continue`, `sdd-attempt`, `sdd-archive-compose`, `sdd-task-result` and `sdd-preflight-hook` are removed, as is the OpenSpec workflow. In v4 the only `sdd-*` strings left are in the legacy-asset cleanup list. Our broker operations `sddStatus`, `sddContinue`, `sddTaskResult`, `sddAttemptGrant` and `sddArchiveCompose`, and the plugin tools `host_sdd_status`, `host_sdd_continue`, `host_sdd_task_result`, `host_sdd_attempt_grant` and `host_sdd_archive_compose`, would all fail at runtime.
- **Review is compatible.** All 58 flags our broker forwards were checked against the v4 source. The only five missing (`--change`, `--change-instance`, `--request-id`, `--canonical`, `--delta`) belong to the retired SDD commands; every review flag still exists. The provider contract stays at `1.2.0`.
- **The relay transport is compatible.** `review opencode-transport` adds an optional `agent` field to the start frame and keeps the V1 wire shape without it. Our relay sends no `agent`, and OpenCode here is 1.18.33 (V1). If an `agent` is ever sent, it must be the provider lens name (`review-risk`), never our `asi-review-*` name. Some binding refusals are now reported as `…stale_authority` instead of `…binding_invalid`; we only mention the latter in a comment (`reviewer-relay-core.ts:10`).
- **Recovery comes from STATUS.** STATUS now returns a runnable `review recover` command. `host_review_recover` still accepts every flag it uses, so callers should forward the returned command exactly.
- **`review assess` grades added lines only**, so risk tiers may change. No code change is needed.

**Principle: SDD becomes dormant, never deleted.** All SDD code, argv builders, approval builders and tests stay so that a rollback to 3.x needs only configuration. Unlike the v6 §28 retirement (`broker/tests/retired-v2-registration.test.ts`), which deleted operations, nothing is removed here.

**Before the upgrade (safe on 3.7.0, no behaviour change until switched)**

1. **Broker dormancy switch.** Add `sddRuntime.legacySddEnabled`, defaulting to `true` while 3.x is installed, with an env override in `systemd-user/broker.env`. When it's off, dispatching the five `sdd*` operations is refused with a typed `PolicyError` ("SDD retired in gentle-ai 4; dormant — enable legacySddEnabled only after rolling back to 3.x"). Operations, payload allowlists, classification and argv builders stay registered. Review operations, which share `sdd-runtime.ts`/`sdd-service.ts`, are never gated. At startup, log the detected `gentle-ai --version` and warn when the switch and the major version disagree. Tests: refused when off and allowed when on, for each of the five operations; review operations unaffected in both states; argv builders unchanged.
2. **Plugin dormancy.** Move the five `host_sdd_*` tool definitions out of the default tool map into `opencode/plugins/lib/legacy-sdd-tools.ts`. Keep `lib/` so the OpenCode loader never auto-loads it. Register those tools only when `OPENCODE_SANDBOX_LEGACY_SDD=1`. `buildSddAttemptGrantAsk` and `buildSddArchiveComposeAsk` stay. Tests: the default tool set has no `host_sdd_*`; the env flag restores exactly the five, with unchanged argument schemas.
3. **Permission fragment.** In `opencode/config-fragments/sandbox-permissions.jsonc`, change the five live `host_sdd_*` entries to `deny`, keeping the entries and adding a comment on how to restore them for rollback. The eight already-retired entries stay `deny`.
4. **Prompt and docs.**
   - `opencode/prompts/sandbox-rules.md` "Host-side SDD runtime" still advertises `host_sdd_attempt_acquire`, which v6 §28 already retired. Mark the section dormant.
   - `docs/config-manifest-host-tools.md`: move the 13 `host_sdd_*` rows to a "dormant (gentle-ai 4)" table and update the tool totals.
   - `opencode/config-fragments/role-agents.jsonc` header: note that the gating SDD change is historical.
5. **OpenSpec archive.** Keep `openspec/` as read-only history, with a README line saying it was retired with gentle-ai 4. `openspec/changes/agent-host-tools` tasks 5.1–5.6 can no longer be continued through SDD. Close them as superseded, or move any still-wanted work into an ODD tracker, and update the Tier 4 "Agent-host-tools slices 2–3" and "SDD runtime host binary" entries to match.
6. **Rollback kit (user).** Before upgrading, copy the 3.7.0 binary to a stable path outside Homebrew's Cellar, e.g. `~/.local/share/opencode-sandbox/gentle-ai-3.7.0`, because `brew upgrade` cleanup removes the old keg. Rollback is then:
   1. set `BROKER_GENTLE_AI_BINARY` to that binary;
   2. set the dormancy switch and `OPENCODE_SANDBOX_LEGACY_SDD=1`;
   3. restore the `host_sdd_*` permissions;
   4. run that binary's `gentle-ai sync` to restore its managed assets.

   Unverified risk: whether v3.7.0 can read review stores written by v4. Check with `review status` in a scratch repository before relying on rollback.

**Upgrade day (user, in order).** Do this before the OpenCode V2 migration below. V2 native review needs gentle-ai 4's V2 relay, and this upgrade is tested on the current V1 stack.

1. Rollback kit in place; the broker and plugin from steps 1–5 are installed and verified on 3.7.0 with the switch still on.
2. `brew upgrade gentle-ai` (or `go install github.com/gentleman-programming/gentle-ai/v4/cmd/gentle-ai@v4.0.0`; v3's self-update cannot cross to v4). Then `gentle-ai sync`. Sync exits non-zero if it can't detect OpenCode's version; treat that as a failure.
3. Turn off `legacySddEnabled` and restart the broker. Reinstall the plugin without `OPENCODE_SANDBOX_LEGACY_SDD` and restart OpenCode.
4. Verify:
   - `gentle-ai review capabilities` reports contract `1.2.0`;
   - every `host_sdd_*` call is refused with the dormancy message;
   - a scratch-repository native review runs end to end through the relay (start → lens → capture → acknowledge → `assess` `already_reviewed`);
   - `host_review_recover` executes a STATUS-returned recovery command;
   - the two external-advisor experiments from 2026-10-01 (agentless collect, `lens-context`, parallel lenses, stale refusal, approval → acknowledgement → `assess`) still hold. Plan A's interface contract §4 was verified on 3.7.0 only.
5. Record the result here, and tell workflow_optimisation (below).

**workflow_optimisation impact (their repository; carry over by hand)**

- WORKFLOW.md SDD lanes, the `workflow-sdd-secure` route and its stage table, SDD-phase rules, `sdd-attempt grant` guidance, and the "post-sdd-phase → judgment-day" trigger all go dormant.
- Their `opencode.json` `host_sdd_*` grants become `deny`.
- Verifier checks that expect `host_sdd_*` grants must change.
- `strict_tdd` and `--sdd-mode` settings no longer exist.
- ODD is unchanged and becomes the only route.


## Planned — OpenCode V2 migration (required by OpenChamber ≥ 2.0); side-by-side, non-destructive

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

## Tier 3 — blocks users now (6 items)

1. **Commit and issue text newline rejection** — **OPEN**; owner **A**. Permit newline/tab in argv-contained commit messages and issue bodies while retaining NUL/control, size, and single-line title validation. Tier 3 because ordinary multi-line commit/issue content is rejected. Source: `docs/TODO.md` (consolidated from prior item 6 at lines 190–203 before this rewrite).
2. **Remaining manual verification gates** — **OPEN; user-owned**; owner **U**. Complete the user-certified installation and acceptance checklists; agents must not self-certify. Tier 3 because these gates block live acceptance and use. Source: `docs/manual-verification.md:1–5,36–52,230–275`; `openspec/changes/agent-host-tools/tasks.md:69–78`.
3. **`sandbox_diff` reports zero** — **OPEN**; owner **A**. Correct active/retained comparison behavior. Tier 3 because users cannot see the worker delta through the read surface. Source: `docs/TODO.md` (consolidated from prior item 24 at lines 80–82 before this rewrite).
4. **Wrong `sandbox_apply` S17 failure message** — **OPEN**; owner **A**. Return the accurate protected-path refusal message. Tier 3 because users receive misleading failure feedback. Source: `docs/TODO.md` (consolidated from prior item 25 at lines 80–82 before this rewrite).
5. **`sandbox_apply_patch` rejects valid EOF hunks** — **OPEN**; owner **A**. Accept append-only hunks ending in additions, or name the constraint clearly. Tier 3 because users must contort otherwise valid patches. Source: `docs/TODO.md` (consolidated from prior item 8 at lines 219–221 before this rewrite).
6. **No way to abandon an active sandbox session** — **OPEN / design**; owner **A**. `sandbox_discard` accepts only `RESULT_READY`/`RETAINED` (`buildDiscardResultOp`), so an agent that damages its worker (for example the mode change in Tier 1 item 3) must `sandbox_finish` an unwanted result before it can discard it, or wait for the idle reaper. Decide whether discard should also release an active worker, or whether a separate abandon operation is needed. Until then, `sandbox_finish` followed by `sandbox_discard` is the safe path. Tier 3 because users get a confusing refusal at the moment they're trying to back out safely. Source: workflow_optimisation probe report 2026-10-01.

## Tier 4 — advisory and tail (11 primary entries; 20 tail entries)

1. **`R3-cache-hit-wrap`** — **OPEN / advisory finding from closed review; provider-designated later work**; owner **A**. Add `refusalOr(cause, rootRefused)` around the cache-hit call to `selectCanonicalSessionRoot` so an unexpected low-level failure cannot surface untyped. The provider marked this non-blocking and separate from corrections (WARNING, disposition *introduced*). Source: `odd/tasks/reviewer-relay-root-guard.md` (closed lineage `review-8b3f47c19de20a55`), `opencode/plugins/lib/reviewer-relay-core.ts:294`.
2. **`R2-001`** — **OPEN / advisory finding from closed review; provider-designated later work**; owner **A**. Improve or remove the guard-site comment that repeats the header rationale without adding a distinct invariant. The provider marked this non-blocking and separate from corrections (SUGGESTION). Source: `odd/tasks/reviewer-relay-root-guard.md` (closed lineage `review-8b3f47c19de20a55`), `opencode/plugins/lib/reviewer-relay-core.ts:256`.
3. **`R3-test-vacuous-assertion`** — **OPEN / advisory finding from approved artifacts-durability review; provider-designated later work**; owner **A**. Repair the test so it demonstrates sweep behavior: `broker/tests/state-artifacts.test.ts:619` deletes the bundle with `rmSync` before the sweep runs, making its final absence assertion unable to demonstrate the sweep. Provider classification: SUGGESTION. Source: `odd/tasks/artifacts-durability-gate.md` (lineage `review-9070428dfe159687`).
4. **`R3-svc-gc-uncovered`** — **OPEN / advisory finding from approved artifacts-durability review; provider-designated later work**; owner **A**. Add coverage for the service integration where `gcSessionArtifacts` passes `bundleExists`; no test currently exercises it. Location: `broker/src/service.ts:777-779`. Provider classification: WARNING. Source: `odd/tasks/artifacts-durability-gate.md` (lineage `review-9070428dfe159687`).
5. **`R3-bundle-toctou`** — **OPEN / advisory finding from approved artifacts-durability review; provider-designated later work**; owner **A**. Assess the time-of-check/time-of-use window: `bundleExists` is sampled before asynchronous durable-ref resolution and removal. Location: `broker/src/reaper.ts:123`. Provider classification: SUGGESTION. Source: `odd/tasks/artifacts-durability-gate.md` (lineage `review-9070428dfe159687`).
6. **Advisory lens findings** (`R2-001`, `R2-002`, `R3-001`, `R3-002`; separately `R3-003`) — **OPEN / advisory**; owner **A**. Track containment-helper readability, misleading diff-catch advice, lost original cause, symlink-deletion test, and profile `~` validity. Tier 4 because the recorded review classified these as non-blocking. Source: `odd/tasks/host-sandbox-result-tool.md:300–313`; `docs/TODO.md` (prior lines 239–241).
7. **Apply-preview docs and installed readback** — **OPEN**; owner **U** for installed-stack readback, **A** for documentation. Finish T4/T5 and reconcile the earlier body with the installed guard evidence. Tier 4 because code is recorded as installed but docs/readback remain pending. Source: `odd/tasks/apply-preview-diff.md:347–350,390–398,459–464`.
8. **Host-tool flag-parity sweep** — **OPEN**; owner **A**. Complete T2–T5 sweep and readback; T1 alone is done. Tier 4 because the direct missing-flag defect is fixed and only the residual audit remains. Source: `odd/tasks/review-host-tool-flag-parity.md:154–162,183–185`.
9. **Host-read operation for two verification gaps** — **UNRESOLVED / design external to this repository**; owner **X** for the design evidence, then **A** for implementation if authorized. Identify the two actual gaps from the external design before proposing an operation; do not guess their semantics. Tier 4 because this is an unscoped discovery/design dependency, not a verified implementation defect. Source: `docs/TODO.md` (this recorded request); the authoritative design and gap definitions are external and are not in this repository.
10. **Cross-project change-request feature and corrections** — **OPEN / requirements unresolved**; owner **A**. Define target/requester identity, evidence transfer, approval at request time, and S17 interaction before implementation. Tier 4 because this is a proposed workflow rather than a current data-loss blocker. Source: `docs/TODO.md` (consolidated from prior item 3 at lines 127–136 before this rewrite).
11. **Remaining tail — retain as separate tracked work**:
   - **Push to `origin` status** — **UNVERIFIED**; owner **U**. Tier 4 because sandbox refs did not expose the host remote state and this is a user-side delivery check. Source: `docs/TODO.md` (prior Delivered note, lines 13–15).
   - **GGA review-hook / `host_git_commit` conflict** — **OPEN; reproduce first, mechanism unverified**; owner **A**. Tier 4 because the cause must be established before this can be scoped. Source: `docs/TODO.md` (prior item 4, lines 138–145, consolidated here).
   - **Worktree review/commit lifecycle and project selector** — **PROPOSED / not started**; owner **A**. Add allowlisted project selection and safe worktree lifecycle once linked `.git` grants are solved. Tier 4 because it depends on the Tier 2 grant work. Source: `docs/TODO.md` (prior plan, lines 157–189); `odd/tasks/register-project-profile-grants.md:102–111`.
   - **Nono 0.74 loopback regression report** — **DRAFTED / external follow-through pending**; owner **X**. Tier 4 because the remaining action is external reporting. Source: `docs/TODO.md` (prior item 3, line 60).
   - **Auto-update EACCES verification** — **UNRESOLVED**; owner **U**. Tier 4 because it is an unverified operational follow-up rather than a demonstrated current blocker. Source: `docs/TODO.md` (consolidated from prior item 5 at line 61 before this rewrite).
   - **`sandbox_copy_out` diff-style review parity** — **OPEN**; owner **A**. Tier 4 because it improves review parity but is not a current apply failure. Source: `docs/TODO.md` (prior item 10, line 62).
   - **Live human-oversight issue-creation check** — **UNVERIFIED live**; owner **U**. The `host_gh_issue_create` implementation is recorded as wired; only its live exercise remains. Tier 4 because implementation is recorded complete and only live evidence is pending. Source: `docs/TODO.md` (prior item 12, line 63, consolidated here).
   - **Sandbox tool-definition audit** — **OPEN**; owner **A**. Tier 4 because it is a broad quality audit rather than a known outage. Source: `docs/TODO.md` (prior item 13, line 64).
   - **Agent web/network access** — **OPEN**; owner **A**. Tier 4 because it is an optional capability expansion under deny-by-default networking. Source: `docs/TODO.md` (consolidated from prior item 14 at line 65 before this rewrite).
   - **AFT sandbox-state gating** — **OPEN**; owner **A**. Tier 4 because it is a bounded hardening task below the user-facing defects. Source: `docs/TODO.md` (prior item 19, line 67).
   - **OpenChamber E2E on nono 0.73** — **OPEN / user verification**; owner **U**. Tier 4 because this is an acceptance check rather than a code defect. Source: `docs/TODO.md` (prior item 22, line 69); `docs/manual-verification.md:230–240`.
   - **SDD runtime host binary and test verification** — **OPEN / host verification**; owner **U**. Tier 4 because only host-side verification remains. Source: `docs/TODO.md` (prior item 23, line 70).
   - **Role-based subagents Phase B** — **PARKED**; owner **A**; nine tasks remain. Tier 4 because the multi-phase feature is explicitly parked. Source: `docs/TODO.md` (consolidated from prior item 15 at line 75 before this rewrite).
   - **Agent-host-tools slices 2–3, verification and archive** — **OPEN; must be dispatched in a new session**; owner **A**. The session latch arose in the prior malformed task-result session; later work does not change the requirement for the still-unchecked follow-on phases. Tier 4 because this is unfinished planned continuation rather than a failure in the completed slice. Source: `openspec/changes/agent-host-tools/tasks.md:69–78`.
   - **Read-only orchestrator S17 review** — **CODE DELIVERED; USER REVIEW OPEN**; owner **U**. Tier 4 because this is a user-controlled protected-path gate rather than agent implementation. Source: `docs/TODO.md` (consolidated from prior item 18 at line 76 before this rewrite); `docs/manual-verification.md:249–275`.
   - **Router-log work-unit handoff gap** — **OPEN workflow gap**; owner **A**. `ROUTER-LOG.md` lives in the workflow-optimisation repository, not this repository, so routed work-unit rows depend on manual handoff. The seven rows for tonight's units are supplied separately. Source: workflow routing handoff; no repository-local `ROUTER-LOG.md`.
   - **OpenChamber metadata Details suppressant-key note** — **OPEN / upstream report**; owner **X**. Tier 4 because the remaining action is an upstream advisory. Source: `docs/TODO.md` (prior follow-up, line 239).
   - **Nono profile `~` entry (`R3-003`)** — **UNVERIFIED**; owner **U**. Tier 4 because the review marked it advisory and it requires user-side `nono why` verification. Source: `odd/tasks/host-sandbox-result-tool.md:304–313`.
   - **Untracked target-path divergence during result install** — **OPEN / follow-up unit**; owner **A**. Extend the baseline-divergence protection to cover an untracked file at a result target path; `git diff --quiet` does not report untracked files. Source: `odd/tasks/result-install-divergence.md`.
   - **HostFS MCP integration proposal** — **PARKED / not started**; owner **A**. Tier 4 because the full proposal remains unstarted. Source: `odd/tasks/hostfs-mcp-integration.md:421–440,463–468`.
   - **Gentle AI 3.1.0 descriptive-doc alignment** — **OPEN; T5 only**; owner **A**. Tier 4 because implementation and tests are complete; only descriptive docs remain. Source: `odd/tasks/gentle-ai-3.1.0-integration-alignment.md:186–195,375–378`.

## Completed

- **`readFile` returns exact bytes or refuses (Tier 1 item 2):** committed as `374e347`. The target must be a regular file within `contentMaxBytes` (the write limit). It's read as base64, refused when the decoded length differs from the size on disk, and refused when it isn't valid UTF-8; CRLF and a BOM survive. Checks: `bun --cwd broker test` passed (575 at that commit), and the build succeeded. Live: broker restarted 2026-10-01 22:29:45, and the workflow_optimisation probe read files correctly afterwards.
- **`writeFile` keeps the target's mode (Tier 1 item 3):** committed as `74f280a`. It reads the existing mode first (refusing non-regular targets, failing closed when an existing target can't be inspected), stages a worker-owned copy beside the target, sets the saved mode (644 for new files), and renames it over the target atomically, cleaning up temps on success and failure. Checks: `bun --cwd broker test` passed with 584, 0 fail; the build succeeded. Against the previous code, 16 of the 17 new tests fail. **Live-verified 2026-10-01:** `sandbox_edit` on `verify-workflow.sh` kept `-rwxr-xr-x`; the diff held exactly the one-character hunk with no mode lines; nothing was finished or applied.
- **Socket write drain, slice 1 (T1+T2):** committed as `81c78cc` on `feat/review-and-state-hardening`. Responses and requests are queued per connection, resumed on `drain`, FIFO, so frames can't interleave. A failed write closes the socket, and a request's timeout starts only after its frame is fully sent. Bun's `socket.write` on a Unix socket accepts only ~219 KB (`net.core.wmem_default`) and drops the rest. The remaining slices are Tier 1 item 2 and Tier 2 item 9. Source: `odd/tasks/socket-write-drain.md`.
- **Result-install revert hazard:** complete in commit `1407a78` on `feat/review-and-state-hardening`. The fail-closed baseline-divergence check covers restore and delete targets before either mutation. Checks: `bun --cwd broker test` — 553 pass, 0 fail across 35 files; build green with output outside the repository. Reviewability receipt: 87 authored lines (86 additions + 1 deletion), no generated paths; `authored_patch_bytes` could not be measured because the sandbox rejected the byte-counting invocation, so no estimate is recorded. Native review approved with zero findings from all four lenses; lineage `review-5de9d2f7cbc97ce3`, consumed revision `sha256:4c9bcf29d632538f43d6d5c66f58a7bdd187015be0f5038260ec02aa9cbf777e`, acknowledgement `authority: burned`. The no-divergence case passed before the fix and is not claimed as RED. The untracked-target limitation is tracked separately in Tier 4. Source: `odd/tasks/result-install-divergence.md`.
- **Scoped native RDD review boundary advanced:** the scoped `--base-ref` assessment and acknowledged review cover `ee831ace..HEAD`; future assessments cover only new commits after that boundary. The pre-existing range `2d92f331..ee831ace` remains unreviewed and is **accepted-by-deferral** by explicit user decision, not pending and deliberately not to be re-reviewed. Source: closed scoped review recorded in `odd/tasks/reviewer-relay-root-guard.md`.
- **S17 protected-list repository template:** repository `systemd-user/broker.env` contains the full protected list, matching `DEFAULT_PROTECTED_SECURITY_FILES`; live installed `~/.config/opencode-sandbox/broker.env` is user-owned and was not read here. The old claim that the repository copy is `[]` is corrected below. Source: `systemd-user/broker.env:25–28`; `broker/src/config.ts:213–229`.
- **SDD session latch:** the triggering latch is session-specific, not a repository-wide lock; the repository records that the unfinished slices, verification and archive must run in a NEW session. Later commits show work occurred in subsequent sessions, but do not complete the unchecked acceptance tasks. The TODO's former “resolved in practice” wording was too broad and is corrected below. Source: `openspec/changes/agent-host-tools/tasks.md:69–78`.
- **Sandbox result-ref inspector/install:** implemented and registered; no longer a proposal. Source: `opencode/plugins/sandbox-tools.ts:591–635`; `odd/tasks/host-sandbox-result-tool.md:220–249`.
- **A-R4 approval bypass:** plugin refuses approval when the preview is truncated and no complete plain artifact exists; see contradiction resolution 4 for the exact guard and regression evidence. This does not assert a broker-side size gate. Source: `opencode/plugins/lib/apply-preview-guard.ts:43–57`; `opencode/plugins/sandbox-tools.ts:428–465`; `odd/tasks/apply-preview-diff.md` (correction below).
- **Acknowledge-approved lineage bug:** implemented and recorded live verified. Source: `docs/TODO.md` (prior lines 103–117); `odd/tasks/review-host-tool-flag-parity.md:154–160`.
- **Readable apply preview / metadata rendering:** installed and post-install behavior recorded as confirmed. Source: `odd/tasks/host-sandbox-result-tool.md:278–287,318–323`; `odd/tasks/apply-preview-diff.md:347–368`.
- **Result-bundle durability after import failure:** completed in commit `682065e` on `feat/review-and-state-hardening`. Callers supply bundle presence (shape 2; no state marker); a `FAILED_CLOSED` record requires a durable ref when `resultRef != null || bundleExists` and is removable only when `(resultRef == null && !bundleExists) || durable`. The three documented removal cases remain the only ones; `durableHostRefResolves` and release-only idle behavior are unchanged. The no-bundle case passed before the fix and is not claimed as RED; the bundle-present case failed before the fix (expected 0 removals, received 2). Direct terminal cleanup's grace period was deliberately not extended (judgement call). Checks: `bun --cwd broker test` — 550 pass, 0 fail, 2,738 assertions / 35 files; build green with output outside the repository. Reviewability receipt: 75 authored lines (59 additions + 16 deletions), 7,871 bytes, no generated paths. Native review approved on the first pass and acknowledged with authority burned (lineage `review-9070428dfe159687`; consumed revision `sha256:eae2b607e6174f93ee1b66b13193ae2721e26b8d243526424f26838f60e8860a`; candidate 5 files / 80 lines). The reviewed range included `nono/profile/opencode-secure.json`, adding `huggingface.co`; the risk lens inspected it and found no reachable exposure, with no authorship judgment. Three provider-designated non-blocking advisories are separately queued in Tier 4. Source: `odd/tasks/artifacts-durability-gate.md`.
- **Idle-reaper active-session release behavior:** `sweepIdle`, `sweepUnfinished` (including its clean-worker branch), and `reapOnDisconnect` now release `SANDBOX_ACTIVE` workers only: release the worker, clear `workerName`, set `workerState: "DESTROYED"`, and keep the session resumable. `FAILED_CLOSED` is reserved for genuine failures. GC prunes only terminal records, so failed-import bundles are retained while the session remains resumable. Added three release-only reaper tests, a re-ensure test, and a bundle-retention test. The remaining terminal-session durability gap was closed by commit `682065e` and is recorded in Completed below. Source: current reaper implementation and tests; prior `docs/TODO.md` Completed list.
- **`runPrepare` import refspec, temp-directory and bundle-status checks:** `service.ts` creates and checks `.broker-tmp`, checks worker `update-ref` and `bundle create` statuses, and forces `+<ref>:<ref>` when fetching; `broker/src/gitops.ts`'s `buildResultImportPlan` is forced to match. The former single misleading error is replaced by `result bundle staging directory failed`, `result ref staging failed`, and `result bundle creation failed`. Full suite: 542 pass / 0 fail. Source: current `service.ts` and `broker/src/gitops.ts` implementation and tests.
- **Copy-tool hardening; global AGENTS.md host-side SDD guidance; worker runners; broker commits/build; repository env template sync; apply-review file flow; host commit/push authorization; idle-reaper/pool-queue implementation.** These prior completed entries are retained as completed implementation records; open recovery risks are tracked in Tier 1. Source: prior `docs/TODO.md` Completed list; `openspec/changes/agent-host-tools/tasks.md:69–78`.
- **Project registration `.codegraph` item 27:** not complete; superseded by the still-pending registration/profile-grants tracker and therefore moved to Tier 2, not marked done. Source: `odd/tasks/register-project-profile-grants.md:193–201`.

## Contradiction resolutions and record corrections

1. **Protected-list state.** The contradiction was between the TODO saying the full list was already present, and manifest/OpenSpec text saying `[]`. Repository evidence: `systemd-user/broker.env:25–28` has a populated `BROKER_PROTECTED_SECURITY_FILES` JSON array; `broker/src/config.ts:217–229` has the same full default list. Resolution: the repository copy is full, not `[]`. The live installed env is user-owned and was not read; its state cannot be inferred. Correct the manifest and OpenSpec wording to distinguish repository template from documented live configuration; do not claim a live observation. Source: `docs/config-manifest-host-tools.md:427–441`; `openspec/changes/agent-host-tools/tasks.md:71`.
2. **SDD session latch.** TODO said resolved because later commits landed; OpenSpec says phases still pending and must run in a NEW session. Resolution: the session-scoped latch is not cleared by work completed in later sessions; the open follow-on work must use a new session. Correct the TODO to remove “resolved in practice” and keep the OpenSpec note. Evidence: `openspec/changes/agent-host-tools/tasks.md:69–78`, including unchecked 5.1–5.6 and the explicit latch at line 78.
3. **Result-ref inspector.** TODO presents it as proposed; tracker records T1–T5 done and the current plugin has registered `host_sandbox_result` and `host_sandbox_result_install`. Resolution: implemented, installed, and verified per tracker; move the proposal to Completed and remove the obsolete proposal block. Evidence: `opencode/plugins/sandbox-tools.ts:591–635`; `odd/tasks/host-sandbox-result-tool.md:220–249`.
4. **A-R4 apply-preview.** Tracker body says apply has no gate; closing note says fail-closed guard installed. Resolution: the broker does not implement a preview-line-size gate, but the plugin `sandbox_apply` path cannot request approval for a truncated preview when `applyPreviewFiles.plain` is absent; it throws before `ctx.ask` and before `applyResult`. So approval cannot proceed in that condition through this plugin path. Correct the stale body to make this distinction and cite the guard; preserve any separate broker-bypass finding only if evidence identifies a path that bypasses the plugin. Evidence: `opencode/plugins/lib/apply-preview-guard.ts:43–57,65–74`; `opencode/plugins/sandbox-tools.ts:428–465`; `odd/tasks/apply-preview-diff.md:39–65,459–464`.
