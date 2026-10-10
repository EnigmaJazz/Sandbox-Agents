# Upgrade plan — gentle-ai 4.0 (SDD retirement); implement when ready to upgrade

Moved from `docs/TODO.md` on 2026-10-02; the TODO keeps a short entry pointing here.

Reviewed 2026-10-01 against the v4.0.0 release notes and the tagged source (`ff77164`), compared with v3.7.0 (`6dee8f8`). Homebrew has offered 4.0.0 since 2026-10-02 (it originally offered only 3.7.0); the user preserved the 3.7.0 binary for rollback at `~/.local/share/opencode-sandbox/gentle-ai-3.7.0`.

**What v4 changes for this repository**

- **SDD is gone.** `sdd-status`, `sdd-continue`, `sdd-attempt`, `sdd-archive-compose`, `sdd-task-result` and `sdd-preflight-hook` are removed, as is the OpenSpec workflow. In v4 the only `sdd-*` strings left are in the legacy-asset cleanup list. Our broker operations `sddStatus`, `sddContinue`, `sddTaskResult`, `sddAttemptGrant` and `sddArchiveCompose`, and the plugin tools `host_sdd_status`, `host_sdd_continue`, `host_sdd_task_result`, `host_sdd_attempt_grant` and `host_sdd_archive_compose`, would all fail at runtime.
- **Review is compatible.** All 58 flags our broker forwards were checked against the v4 source. The only five missing (`--change`, `--change-instance`, `--request-id`, `--canonical`, `--delta`) belong to the retired SDD commands; every review flag still exists. The provider contract stays at `1.2.0`.
- **The relay transport is compatible.** `review opencode-transport` adds an optional `agent` field to the start frame and keeps the V1 wire shape without it. Our relay sends no `agent`, and OpenCode here is 1.18.33 (V1). If an `agent` is ever sent, it must be the provider lens name (`review-risk`), never our `asi-review-*` name. Some binding refusals are now reported as `…stale_authority` instead of `…binding_invalid`; we only mention the latter in a comment (`reviewer-relay-core.ts:10`).
- **Recovery comes from STATUS.** STATUS now returns a runnable `review recover` command. `host_review_recover` still accepts every flag it uses, so callers should forward the returned command exactly.
- **`review assess` grades added lines only**, so risk tiers may change. No code change is needed.

**Principle: SDD becomes dormant, never deleted.** All SDD code, argv builders, approval builders and tests stay so that a rollback to 3.x needs only configuration. Unlike the v6 §28 retirement (`broker/tests/retired-v2-registration.test.ts`), which deleted operations, nothing is removed here.

**Before the upgrade (safe on 3.7.0, no behaviour change until switched)**

1. **Broker dormancy switch.** **Done in T1 of `odd/tasks/gentle-ai-4-sdd-dormancy.md`.** `BROKER_LEGACY_SDD=auto|on|off` (default `auto`): `auto` enables the five `sdd*` operations only when `gentle-ai --version` reports a major below 4, and an unreadable version keeps them dormant. It's resolved once at broker start and logged, with a warning when `on`/`off` disagrees with the detected version. A dormant operation refuses with a typed `PolicyError` ("SDD retired in gentle-ai 4; this operation is dormant…") before any gentle-ai call. Review operations are never gated. `defaultConfig` defaults to dormant, so any non-`main.ts` construction fails closed. Because of `auto`, upgrade day needs no broker setting change, only a restart.
2. **Plugin dormancy.** **Done in T2 of `odd/tasks/gentle-ai-4-sdd-dormancy.md`.** The five `host_sdd_*` tool definitions moved unchanged to `opencode/plugins/lib/legacy-sdd-tools.ts` (`lib/`, so the OpenCode loader never treats it as a plugin). They're registered only when `OPENCODE_SANDBOX_LEGACY_SDD=1` (exactly `1`). The approval builders are unchanged, and the installer and rollback scripts list the new file. **Install timing:** the plugin builds its tool list at load time and can't detect the gentle-ai version, so its default is dormant even on 3.7.0. Install this plugin change on upgrade day (step 3 below), not before. Until then the installed plugin keeps the SDD tools. To use the new plugin on 3.x, set `OPENCODE_SANDBOX_LEGACY_SDD=1` in the secure launcher's environment.
3. **Permission fragment.** **Done in T3 of `odd/tasks/gentle-ai-4-sdd-dormancy.md` (commit `5e65f46`).** In `opencode/config-fragments/sandbox-permissions.jsonc`, change the five live `host_sdd_*` entries to `deny`, keeping the entries and adding a comment on how to restore them for rollback. The eight already-retired entries stay `deny`.
4. **Prompt and docs.** **Done in T4 of `odd/tasks/gentle-ai-4-sdd-dormancy.md` (commit `83f448c`).**
   - `opencode/prompts/sandbox-rules.md` "Host-side SDD runtime" still advertises `host_sdd_attempt_acquire`, which v6 §28 already retired. Mark the section dormant.
   - `docs/config-manifest-host-tools.md`: move the 13 `host_sdd_*` rows to a "dormant (gentle-ai 4)" table and update the tool totals.
   - `opencode/config-fragments/role-agents.jsonc` header: note that the gating SDD change is historical.
5. **OpenSpec archive.** **Done in T5 of `odd/tasks/gentle-ai-4-sdd-dormancy.md` (commit `8152748`).** Keep `openspec/` as read-only history, with a README line saying it was retired with gentle-ai 4. `openspec/changes/agent-host-tools` tasks 5.1–5.6 can no longer be continued through SDD. Close them as superseded, or move any still-wanted work into an ODD tracker, and update the `docs/TODO.md` Tier 4 "Agent-host-tools slices 2–3" and "SDD runtime host binary" entries to match.
6. **Rollback kit (user).** Before upgrading, copy the 3.7.0 binary to a stable path outside Homebrew's Cellar, e.g. `~/.local/share/opencode-sandbox/gentle-ai-3.7.0`, because `brew upgrade` cleanup removes the old keg. Rollback is then:
   1. set `BROKER_GENTLE_AI_BINARY` to that binary;
   2. keep `BROKER_LEGACY_SDD=auto` (or set `on`) and set `OPENCODE_SANDBOX_LEGACY_SDD=1`;
   3. restore the `host_sdd_*` permissions;
   4. run that binary's `gentle-ai sync` to restore its managed assets.

   Store compatibility was verified on 2026-10-09 in both directions (see "Pre-upgrade verification" below): 3.7.0 reads an acknowledged and an in-progress (`correction_required`) store written by 4.0.0, and 4.0.0 reads an in-progress store written by 3.7.0.

**Pre-upgrade verification against the real 4.0.0 binary (2026-10-09)**

The release binary was downloaded to a scratch directory, checked against the release `checksums.txt`, and run only with an isolated `HOME` in throwaway repositories. Nothing was installed and the real `~/.gentle-ai/state.json` was not modified. Review calls went through the real broker code (`SddRuntimeExecutor`, the `sdd-service.ts` review handlers, the advisor records and relay) at `bf3c792`, with the binary set to 4.0.0.

| Check | Result |
|---|---|
| Version detection | **Pass.** `detectGentleAiMajor` returns 4 and `auto` resolves to dormant; it returns 3 and enabled for 3.7.0. `gentle-ai sdd-status` is an unknown command on 4.0.0. |
| Capabilities | **Pass, with a correction to this document.** `review capabilities` reports schema `gentle-ai.review-integration.capabilities/v1.5`, contract `gentle-ai.review-integration/v1`, identical on 3.7.0 and 4.0.0. The "1.2.0" quoted earlier is the name of the release's provider-contract archive, not a value this command prints, so it is not something to check on upgrade day. |
| Flag parity | **Pass.** For all 12 review subcommands the broker builds argv for, every forwarded flag exists in 4.0.0, and the 4.0.0 flag set of each subcommand is identical to 3.7.0's. (`acknowledge-approved --help` prints no flag list on either version; its four flags were exercised live instead.) |
| Native lifecycle, external-lens path | **Pass.** Preflight STATUS → `reviewStart` with `externalLenses` and `consent: granted` → bound STATUS offers four agentless lens slots → free-form `inputJson` refused by the broker → four stored advisor responses relayed (preflight then capture each) → `approved` → `reviewAcknowledgeApproved` prints `gentle-ai.review-acknowledged/v1` → `reviewAssess` reports `review_due: false`, `already_reviewed`. |
| Severe finding | **Pass.** A relayed CRITICAL finding closes the review as `correction_required`; lineage-bound STATUS then asks for the correction plan. |
| Relay at most once | **Pass.** A second relay for a lens already captured is refused. |
| Oversized candidate | **Pass.** A 12,000-line candidate is refused at START with `lens_context_budget_exceeded`, `mutation_outcome: not_started`, and no `.git/gentle-ai` store is created. |
| `assess` tier | **Same on both.** The scratch candidate (an auth check plus a shell hook, 18 lines) is `high` / `high_risk` on 3.7.0 and 4.0.0. |
| Store compatibility | **Pass, both directions.** See the rollback note above. |
| `--target-evidence` | **Not required.** STATUS offers it on both versions and START succeeds without it on both. It only makes a stale refusal name its cause, so it stays in the flag-parity sweep (`docs/TODO.md`) and is not an upgrade blocker. |
| Recovery command | **Not verified live.** The `review recover` flag set is identical to 3.7.0's and fully covered by `REVIEW_COMMANDS.reviewRecover` (18 of 18), but no recoverable store was constructed, so a STATUS-returned recovery command was not executed. |
| Relay transport (`review opencode-transport`) | **Not verified here.** It needs the installed OpenCode stack; it is the first check on upgrade day. |

Two behaviours observed on both versions, recorded so they are not mistaken for regressions on upgrade day:

- A `--base-ref --committed-only` review is bound to the trees frozen at START. A later commit does not make a pending lens slot stale; the relay is still admitted for the frozen candidate, and the new commit shows up as a new range in `assess`.
- After `correction_required` on a committed-only review, STATUS with only `--lineage` answers `empty_candidate_base_ref_required`. Re-enter with the capture's `status_continuation` (which carries the base ref), not a reconstructed command.

**What `gentle-ai sync` writes for OpenCode on 4.0.0** (run in the isolated home only):

- Agents: `gentle-orchestrator`, `gentle-ai-explore`, `gentle-ai-verify`, `gentle-ai-worker`, the three `jd-*` agents and the six `review-*` agents. No `sdd-*` agent remains. The three `gentle-ai-*` agents are new.
- No name collides with our `asi-review-*` agents, and the provider's `review-*` names are unchanged.
- It writes `gentle-orchestrator`'s `permission.task` allowlist. That list does not contain `asi-review-*` or any agent defined outside gentle-ai, so check it after sync on the real configuration (step 3 below).
- The new agents are not in the broker's `readOnlyAgents`, so the broker treats them as ordinary sandbox workers. `gentle-ai-worker` is defined with only `task: deny`; whether it can edit on the host depends on the global permission map in the live `opencode.json`, which this repository does not own.

**State on 2026-10-10, before the upgrade**

- The broker runs from this checkout and was restarted on 2026-10-10 at 13:02:47. The operator observed its journal startup line: `legacy SDD enabled (BROKER_LEGACY_SDD=auto, gentle-ai major 3)`.
- HEAD is `7aec9e6`, reported in sync with `origin/feat/review-and-state-hardening`; the `git log --oneline -12` check showed `7aec9e6` immediately below the sandbox's generated baseline commit. The remote-ref sync could not be independently verified in the sandbox: `origin/feat/review-and-state-hardening` is not present there.
- The current last-reviewed boundary is `5d24a64`, from approved and acknowledged review lineage `review-0789e564b02b5363`; `odd/tasks/broker-socket-lifecycle.md` records approval at the corrected candidate identity and the correction commit.
- The rollback binary check passed: `~/.local/share/opencode-sandbox/gentle-ai-3.7.0` exists and is executable (operator-reported).
- The tracked working tree is clean. The operator's known untracked non-project paths are `.codegraph/`, `.windsurf/`, `CLAUDE.md`, `docs/handovers/`, `package-lock.json`, and `package.json`. The sandbox `git status --short` did not reproduce this host inventory; it showed only its generated session bundle.
- Refreshed deferred advisories: `R4-001` and `R4-002` were resolved by the response-finalization work (`odd/tasks/response-safety-followups.md`; commit `086d576`); `R4-003` was resolved by logger-resilience work (same tracker; commit `cf78617` and follow-up hardening); `R4-004` and the `SocketWriteQueue` state after enqueue failure were resolved by queue-drain/teardown work (same tracker; commits `789602a` and `528fa89`). Still open are the install-refusal message (Tier 3 item 9), `R4-2` on `installedCommit` divergence (`docs/TODO.md`, Tier 4 item 30), and the pre-existing unrecoverable socket-path restart loop (`docs/TODO.md`, Tier 4 item 54; `odd/tasks/broker-socket-lifecycle.md`).
- Broker startup behavior changed on 2026-10-10 with the socket-lifecycle work: it recovers a stale socket, refuses a live one by exiting 0, unlinks sockets it owns on shutdown, and bounds the liveness probe to 2,000 ms. The tracker and commits `365b4a1` and `5d24a64` document these changes. On upgrade day, a failed start therefore has distinct, diagnosable outcomes rather than one undifferentiated socket-bind failure.

**Upgrade day (user, in order).** Do this before the OpenCode V2 migration (`docs/upgrades/opencode-v2.md`). V2 native review needs gentle-ai 4's V2 relay, and this upgrade is tested on the current V1 stack. Commands are for fish.

0. **Baseline on 3.7.0.** Confirm nothing drifted since the state above, so a failure after the upgrade can be attributed to it.

   ```fish
   cd ~/agent-sandbox-integration; and git status --short; and git log --oneline -1
   scripts/install-user-files --verify                      # expect: verification passed
   test -x ~/.local/share/opencode-sandbox/gentle-ai-3.7.0; and echo "rollback binary present"
   ```

   If the broker source moved past the commit it was started on, restart it and run one native review on 3.7.0 first.

1. **Upgrade and sync.**

   ```fish
   brew upgrade gentle-ai; and gentle-ai --version          # expect: gentle-ai 4.0.0
   gentle-ai sync; and echo "sync ok"                       # a non-zero exit is a failure; stop here
   ```

   `brew upgrade` removes the 3.7.0 keg; the copy in `~/.local/share/opencode-sandbox/` is the rollback binary. v3's self-update cannot cross to v4.

2. **Restart the broker and OpenCode.**

   ```fish
   systemctl --user restart sandbox-broker
   journalctl --user -u sandbox-broker -n 20 --no-pager | rg "legacy SDD"
   # expect: legacy SDD dormant (BROKER_LEGACY_SDD=auto, gentle-ai major 4)
   ```

   Then restart the secure OpenCode server the usual way. Leave `OPENCODE_SANDBOX_LEGACY_SDD` unset.

3. **Check what sync changed.** In the live `opencode.json`, confirm `gentle-orchestrator`'s `permission.task` still allows the `asi-review-*` agents and the workflow_optimisation agents, and that the global `edit`/`write`/`bash` denies still apply to the new `gentle-ai-worker`. Run workflow_optimisation's verifier; expect it to complain about `host_sdd_*` grants until that repository is updated.

4. **Verify in OpenCode** (each is a pass/fail):
   - `host_sdd_status` is not offered as a tool; a direct broker `sddStatus` call is refused with "SDD retired in gentle-ai 4; this operation is dormant…".
   - A native review of a small scratch commit runs end to end through the `asi-review-*` relay: start → four lenses → capture → acknowledge → `host_review_assess` reports `already_reviewed`. This is the one path the pre-upgrade checks could not cover.
   - If a recoverable state ever appears, `host_review_recover` executes the STATUS-returned command unchanged.

5. Record the result here and in `docs/TODO.md`, and tell workflow_optimisation.

**Rollback (user).** No repository change is needed.

```fish
# 1. point the broker at the preserved binary: in ~/.config/opencode-sandbox/broker.env change the
#    existing line to
#    BROKER_GENTLE_AI_BINARY=/home/james/.local/share/opencode-sandbox/gentle-ai-3.7.0
#    (scripts/install-user-files --verify will report broker.env as different while this is in place)
systemctl --user restart sandbox-broker
journalctl --user -u sandbox-broker -n 20 --no-pager | rg "legacy SDD"   # expect: enabled … major 3
# 2. restore that version's managed assets
~/.local/share/opencode-sandbox/gentle-ai-3.7.0 sync
```

Then, only if the SDD tools are wanted again: set `OPENCODE_SANDBOX_LEGACY_SDD=1` in the secure launcher's environment, restore the five `host_sdd_*` permission entries, and restart OpenCode. Review stores written by 4.0.0 stay readable (verified above). Note that anything on `PATH` calling plain `gentle-ai` (hooks, the Claude Code stop hook) still gets 4.0.0 until Homebrew is rolled back too.

**workflow_optimisation impact (their repository; carry over by hand)**

- WORKFLOW.md SDD lanes, the `workflow-sdd-secure` route and its stage table, SDD-phase rules, `sdd-attempt grant` guidance, and the "post-sdd-phase → judgment-day" trigger all go dormant.
- Their `opencode.json` `host_sdd_*` grants become `deny`.
- Verifier checks that expect `host_sdd_*` grants must change.
- `strict_tdd` and `--sdd-mode` settings no longer exist.
- ODD is unchanged and becomes the only route.
