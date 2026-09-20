# Exploration: agent-host-tools

Exploration only; no product/scope decisions are made here. The orchestrator
confirms scope after this artifact.

Goal: approval-gated, fixed-argv **host** tools for (A) git/gh (`git commit`,
`git push`, `gh issue create`) plus fixing the unwired `host_register_project`;
(B) Gentle-AI SDD runtime completion — every SDD CLI op an agent needs;
(C) possibly read-only `review` ops. Recon was pre-supplied and re-verified
against the code during this phase.

## Current State

**Wiring pattern for a new operation** (each command touches ~6 points):
`types.ts` `Operation` union (`:35-74`) + `OPERATIONS` (`:77-112`);
`validation.ts` `ALLOWED_PAYLOAD_KEYS` (`:246-288`); a typed argv builder in
`service.ts` or `sdd-service.ts`; a `case` in `server.ts:dispatch`
(`:316-368`); a `tool()` in `opencode/plugins/sandbox-tools.ts`; a permission
entry in `opencode/config-fragments/sandbox-permissions.jsonc`; and
`broker-client.ts` `OPERATION_TIMEOUT_MS` (`:64-67`) when >30 s.

**Host SDD runtime**: `broker/src/sdd-runtime.ts` has exactly two commands.
`buildSddStatusArgv` (`:118-124`) hardcodes `--cwd <root> --json --instructions`
— no `[change]`, no `--contract`. `buildSddAttemptAcquireArgv` (`:126-168`) is
the only mutation. Both use `resolveProjectRoot` (`:182-198`): trusted
`BROKER_PROJECTS` allowlist + `realpathSync` both sides + exact equality; spawn
via `spawnArgv` (120 s, 512 KiB cap, strict JSON parse). `sdd-service.ts`
exposes only `buildSddStatusOp` / `buildSddAttemptAcquireOp`; both have
dispatch cases (`server.ts:351-354`).

**Plugin host tools**: `host_sdd_status` (`sandbox-tools.ts:426-439`),
`host_sdd_attempt_acquire` (`:441-462`), `host_register_project` (`:464-472`).
None call `ctx.ask`; the fragment has no entry for any of the three. `ctx.ask`
exists only for `sandbox_apply` (`:346`), `sandbox_copy_out` (`:374`),
`sandbox_copy_in` (`:404`), and `sandbox_apply` is *also* `"ask"` in the
fragment (`:62`): the established pattern is fragment-gate **plus**
metadata-rich in-tool `ctx.ask`.

**Host spawn env**: `spawnArgv` merges `process.env` (`msb.ts:65`), so host
git/gh inherit host credentials — broker side only; workers cannot
(`assertWorkerEnv` rejects credential-shaped keys, `msb.ts:129-154`).
`routing-guard.ts` intercepts only `read/grep/glob/list` and
`bash/edit/write/apply_patch/patch` (`:43-50`); custom `host_*` tools pass.

**Apply flow**: `service.ts:1312-1406` computes the B→C `changed` set, runs
`checkProtectedPaths`, rejects symlink/submodule, then `git apply`
**working-tree only**. `changed` is not persisted, but `baselineRef`/`resultRef`
are stored on the record (`:1290-1291`), so the applied path set is recoverable
as `git diff --name-only <baselineRef> <resultRef>`. Prior art for fixed-argv
git/gh: `scripts/register-project.ts` (`git init/remote/config`,
`gh repo view/create`, push) via `execFileSync` (`:383-572`), path bans at
`validateProject` (`:104-133`).

**Bug**: `buildRegisterProjectOp` (`service.ts:1789-1850`) and
`registerProjectOperationMap` (`:1851-1853`) are never imported by `server.ts`;
there is no `case "registerProject"`, so dispatch falls to `buildHostOp`
(`:1723-1735`) and throws `StateError: host read 'registerProject' is not
enabled`. The plugin tool is inert.

**CLI inventory**: RO — `sdd-status [change]`, `sdd-status --contract`,
`sdd-continue`, `sdd-verify-validate`, `sdd-task-result`, `review assess`,
`review mode status`, `review status`, `review schema reviewer`. MUT reachable —
`sdd-attempt acquire`. MUT unreachable — `sdd-attempt settle` (the pair to
acquire is **missing**), `sdd-attempt status|begin|finish|reset`,
`sdd-archive-compose`, `review mode enable|disable`, `sync`,
`skill-registry refresh`, and token-bound `review
start|capture-result|acknowledge-approved|capture-unachievable|recover`.

**Constraints** (`SYSTEM_PROMPT.md`): §9 (`:548-572`) — no generic host
mutation in v1; any narrow tool MUST be `permission: ask` and a **fixed action,
not arbitrary shell**; §14 (`:727-737`) repeats "host mutation absent or ask".
§31 (`:1325-1344`) — never autonomously force-push or modify production
branches remotely. §18 (`:897-899`) — the worker must not push and should not
hold GitHub creds, so host-side push is the only sanctioned path. `AGENTS.md
S17` protects `broker/src/**`, `opencode/plugins/**`,
`opencode/config-fragments/**`, `scripts/**`, `tests/security/**`,
`docs/threat-model.md`: changes touching them need explicit manual review.
Broker stays dependency-free.
## Design Questions and Options

### Q1. Tool topology

- **T1 — one broker op + one host tool per command.** Granular per-tool
  `ask`/`allow` exactly as §9/§14 require; per-op fail-closed; matches house
  style; token-bound ops individually withholdable. Cost: ~11–13 commands × ~6
  touch points (~70–80 edits). Effort: Medium.
- **T2 — one guarded generic `host_gentle_ai` dispatcher** (command enum +
  fixed per-sub-op templates). Least code; one extension point. But one
  permission can't tier `sdd-status` (read) against `review
  acknowledge-approved` (authority); wider blast radius; dynamic argv harder to
  prove. Effort: Medium–High.

### Q2. git/gh approval model

Prompt options: fragment `ask` only; in-tool `ctx.ask` with metadata only; or
both (the `sandbox_apply` precedent — strongest, possibly double-prompts).
Metadata: commit → branch, subject, path count/preview, protected-path result;
push → remote, branch, commits ahead, upstream, main/master warning; issue →
repo, title, body preview. Branch guards: resolve branch broker-side
(`git rev-parse --abbrev-ref HEAD` in the canonical root), never from the
plugin; refuse detached-HEAD push; refuse no-upstream push unless `setUpstream`;
**never** `--force`/`--force-with-lease`/`--delete`/`+refspec`; default-refuse
direct `main`/`master` push unless an explicit `allowProtectedBranch` flag
(itself `ask`), per §31. Message: single `-m`, no control chars, byte-capped,
must not start with `-`. Protected-path check before commit via
`checkProtectedPaths` (S7/S17).

### Q3. Commit scoping / where git runs

Git runs on the **host broker** in the canonical repo (workers must not push;
§18). Scoping: **S1** scope to the applied B→C set
(`git diff --name-only <baselineRef> <resultRef>` → `git add`/`git commit --
<paths>`): never sweeps user work, exact file list, trivial protected check;
needs record/refs retained. **S2** `git add -A` — sweeps unrelated changes;
reject. **S3** require a clean tree — safe but hostile in active development.
**S4** fold commit into `applyResult` — race-free and atomic, but couples
concerns and makes commit mandatory. Apply already refuses host divergence
(`service.ts:1300-1310`); the per-session lock (`server.ts:370-376`) bounds the
remaining window.

### Q4. Scope / phasing

- **P0** (unblocks SDD/RDD and TODO #11/#12): fix `registerProject` dispatch;
  `host_sdd_status` +`[change]` +`--contract`; `sdd-continue`;
  `sdd-attempt settle`; `sdd-archive-compose`; `sdd-verify-validate` /
  `sdd-task-result`; `git commit`/`push`; `gh issue create`; `review assess` +
  `review mode status`.
- **P1**: `review status` (RO, token passthrough); `sdd-attempt
  status|begin|finish|reset`; `review schema reviewer`; `sync`;
  `skill-registry refresh`.
- **Deferred / decision-required**: token-bound `review
  start|capture-result|acknowledge-approved|capture-unachievable|recover` —
  exposing them risks a model driving its own approval loop. Either keep them
  out of model tools (orchestrator fixed integration) or expose only to the
  orchestrator with exact argv + approval + opaque-token validation.

### Q5. Security

Reuse `resolveProjectRoot` for every host op (broker-derived canonical root,
never free-form plugin input). Typed builders with `assertExactKeys`; allowlist
regexes; `--` before pathspecs/positionals; reject leading `-`, `:(…)` magic,
`..`. Redact git/gh stdout/stderr with `logging.ts redact()`; cap output; never
return env or `gh` auth. Byte caps + bounded enums. `ctx.ask` + fragment `ask`
for every mutation; `allow` only for RO. Decide per-tool agent authorization
(the orchestrator is read-only in authority but is the designated
`host_register_project` caller); `assertNotOrchestrator` is sandbox-only, so
host tools need an explicit policy. S17: this change touches protected paths by
design → explicit manual review is mandatory.

### Q6. Testing (no new deps)

Extend the `sdd-runtime.test.ts` fake-spawn pattern for exact argv vectors and
`resolveProjectRoot` rejections. New git-ops builder tests via injected
`SpawnFn` (branch resolution, `--` separators, refused `--force`,
protected-path refusal, commit scoping). A service test for the fixed
`registerProject` case (argv + non-zero → `MsbError`). `validation.test.ts` per
new key set. `ctx.ask` gating is plugin-level and unreachable by broker
`bun:test` (`@opencode-ai/plugin`/`zod` are not broker deps): extract
ask-metadata into a pure helper, otherwise approval is only manually verified.
Live git/gh tests stay behind `SANDBOX_GATED_TESTS`; `bun build src/main.ts` is
the type gate.

## Recommendation (provisional; orchestrator decides)

- **T1** topology (shared typed-builder helper): only per-op tools satisfy
  §9/§14 "fixed action" and give a per-tool authority gradient.
- **S1** commit scoping with broker-side branch resolution and §31 guards.
- **Approval**: fragment `ask` + metadata-rich `ctx.ask`, mirroring
  `sandbox_apply`.
- **Phasing**: P0 first; P1 introspection; **defer** token-bound review
  mutations pending an explicit security decision.

Main tradeoff: **T1 auditability/authority gradient vs T2 code volume.** For a
security component I lean T1; T2 is acceptable only if the token-bound review
mutations are excluded.

## Risks

- **S17 (highest)**: the work modifies `broker/src/**` and
  `opencode/plugins/**`; automatic apply rejects it, so delivery needs explicit
  manual review and a deliberate S17 decision.
- **`registerProject` breadth**: writes the nono profile, broker.env and
  launcher; its plugin schema accepts any absolute path — gate `ask` + ban paths.
- **Testability gap**: `ctx.ask` gating not exercisable by broker tests.
- **RDD `review assess`**: read-only, but token passthrough rules must be
  honored exactly; guessing argv/contracts is forbidden.

## Ready for Proposal

Yes — decisions required: (1) T1 vs T2/T3; (2) whether to expose token-bound
review mutations at all; (3) P0/P1/deferred cutoff; (4) S1 vs S4 commit
scoping; (5) who may call which host tool. No product decisions were made here.
