# Upgrade plan — gentle-ai 4.0 (SDD retirement); implement when ready to upgrade

Moved from `docs/TODO.md` on 2026-10-02; the TODO keeps a short entry pointing here.

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
5. **OpenSpec archive.** Keep `openspec/` as read-only history, with a README line saying it was retired with gentle-ai 4. `openspec/changes/agent-host-tools` tasks 5.1–5.6 can no longer be continued through SDD. Close them as superseded, or move any still-wanted work into an ODD tracker, and update the `docs/TODO.md` Tier 4 "Agent-host-tools slices 2–3" and "SDD runtime host binary" entries to match.
6. **Rollback kit (user).** Before upgrading, copy the 3.7.0 binary to a stable path outside Homebrew's Cellar, e.g. `~/.local/share/opencode-sandbox/gentle-ai-3.7.0`, because `brew upgrade` cleanup removes the old keg. Rollback is then:
   1. set `BROKER_GENTLE_AI_BINARY` to that binary;
   2. set the dormancy switch and `OPENCODE_SANDBOX_LEGACY_SDD=1`;
   3. restore the `host_sdd_*` permissions;
   4. run that binary's `gentle-ai sync` to restore its managed assets.

   Unverified risk: whether v3.7.0 can read review stores written by v4. Check with `review status` in a scratch repository before relying on rollback.

**Upgrade day (user, in order).** Do this before the OpenCode V2 migration (`docs/upgrades/opencode-v2.md`). V2 native review needs gentle-ai 4's V2 relay, and this upgrade is tested on the current V1 stack.

1. Rollback kit in place; the broker and plugin from steps 1–5 are installed and verified on 3.7.0 with the switch still on.
2. `brew upgrade gentle-ai` (or `go install github.com/gentleman-programming/gentle-ai/v4/cmd/gentle-ai@v4.0.0`; v3's self-update cannot cross to v4). Then `gentle-ai sync`. Sync exits non-zero if it can't detect OpenCode's version; treat that as a failure.
3. Turn off `legacySddEnabled` and restart the broker. Reinstall the plugin without `OPENCODE_SANDBOX_LEGACY_SDD` and restart OpenCode.
4. Verify:
   - `gentle-ai review capabilities` reports contract `1.2.0`;
   - every `host_sdd_*` call is refused with the dormancy message;
   - a scratch-repository native review runs end to end through the relay (start → lens → capture → acknowledge → `assess` `already_reviewed`);
   - `host_review_recover` executes a STATUS-returned recovery command;
   - the two external-advisor experiments from 2026-10-01 (agentless collect, `lens-context`, parallel lenses, stale refusal, approval → acknowledgement → `assess`) still hold. Plan A's interface contract §4 was verified on 3.7.0 only.
5. Record the result in this document and in `docs/TODO.md`, and tell workflow_optimisation (see the impact list below).

**workflow_optimisation impact (their repository; carry over by hand)**

- WORKFLOW.md SDD lanes, the `workflow-sdd-secure` route and its stage table, SDD-phase rules, `sdd-attempt grant` guidance, and the "post-sdd-phase → judgment-day" trigger all go dormant.
- Their `opencode.json` `host_sdd_*` grants become `deny`.
- Verifier checks that expect `host_sdd_*` grants must change.
- `strict_tdd` and `--sdd-mode` settings no longer exist.
- ODD is unchanged and becomes the only route.
