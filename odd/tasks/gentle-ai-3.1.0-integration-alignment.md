# ODD Tasks — gentle-ai-3.1.0-integration-alignment

- **Feature:** `gentle-ai-3.1.0-integration-alignment`
- **Project:** `sandbox-integration` (`/home/james/agent-sandbox-integration`)
- **Status:** T1–T4 committed and installed; T5 recorded and pending
- **Created:** 2026-09-17
- **Delivery strategy:** `ask-on-risk` (default). Rough forecast ≈600 authored changed lines
  (additions + deletions, excluding generated files), so the slice decision will be made when the
  running total crosses ~400. T3 is deletion-heavy; T1 is trivial. The running total crossed ~400
  during T3 (T3 alone: 281 insertions / 3485 deletions), so the stacked-to-main vs
  feature-branch-chain choice is due before the work-unit commits.
- **Chain strategy:** `stacked-to-main` — **decided** (see "Delivery decision" below). Each unit
  lands on the default branch in order as its own reviewable slice. Delivery strategy remains
  `ask-on-risk`.

## Objective

Bring the host sandbox integration into full compliance with the Gentle AI 3.1.0 v6 deployment
notes (`/home/james/ai-workspace/workflow_optimisation/host-sandbox-integration-v6.md`).

## Problem

An audit against the Gentle AI 3.1.0 clone (`.sandbox-state/gentle-ai-3.1.0/`) and the v6 notes
found exactly two unmet requirements plus one sanctioned cleanup.

1. **v6 §24 — installer/rollback gap.** `scripts/install-user-files` (step 4) and
   `scripts/rollback` (§1) list only `sandbox-tools.ts`, `routing-guard.ts`, and
   `lib/broker-client.ts`. Neither lists `opencode/plugins/reviewer-relay-transport.ts` or
   `opencode/plugins/lib/host-tool-approval.ts`. The hosted verifier reports
   `HOST_TOOL_INSTALL_ROLLBACK_GAP` on both scripts and it is the verifier's only failure.
2. **v6 §32 — scoped native assessment is not preserved.** `host_review_assess` declares
   `args: {}` and sends only `projectDir` (`opencode/plugins/sandbox-tools.ts:549-560`; broker
   allowlist `reviewAssess: ["projectDir"]`, `broker/src/validation.ts:890`), so it emits
   `gentle-ai review assess --cwd <root> --json`. `host_review_status` accepts only `agent`,
   `lineage`, `repositoryContext`, `projection`, `intendedUntrackedSelection`
   (`sandbox-tools.ts:576-603`; broker allowlist `reviewStatus`, `validation.ts:892`), so it emits
   `gentle-ai review status --cwd --contract --agent … --next-transition` with no `--base-ref` or
   `--committed-only`. `host_review_start`, `host_review_validate`, and `host_review_recover`
   already carry `baseRef`/`committedOnly` end to end, so the argv-builder/validator pattern
   exists to extend. Until the scoped route is proven, substantial ODD native review must be
   reported **blocked** rather than run unscoped.
3. **v6 §28 — dead retired v2 registrations.** The eight retired v2 operations
   (`host_sdd_attempt_acquire/begin/rescope/finish/reset/settle/status`,
   `host_sdd_verify_validate`) remain registered in the plugin
   (`opencode/plugins/sandbox-tools.ts:512,637-880`), the broker operation union and read/mutation
   lists (`broker/src/types.ts:56-70,126-140`), payload allowlists
   (`broker/src/validation.ts:753-775`), server dispatch (`broker/src/server.ts:388-410`),
   handlers (`broker/src/sdd-service.ts:89-351`), argv builders (`broker/src/sdd-runtime.ts`),
   the permission fragment (`opencode/config-fragments/sandbox-permissions.jsonc:76-89`), and
   tests. They are correctly denied in the live config; v6 explicitly permits removing the dead
   registrations as a separate reviewed update.

## Why

The integration is otherwise compliant, but the installer gap is the verifier's single failing
check and blocks a clean startup sequence. The scoped-assessment gap forces the orchestrator to
report substantial ODD native review as blocked, preventing the RDD work-unit boundary from being
exercised. Removing the dead v2 registrations shrinks the permission/attack surface without
changing live behaviour, because those operations are already denied and their replacement route
is the read-only `host_sdd_status` / `host_sdd_continue` pair.

## Scope

Only this repository. Files expected to change:

- `scripts/install-user-files`
- `scripts/rollback`
- `opencode/plugins/sandbox-tools.ts`
- `opencode/plugins/lib/host-tool-approval.ts`
- `opencode/config-fragments/sandbox-permissions.jsonc`
- `broker/src/*.ts`
- `broker/tests/**`

These are **S17 protected paths**: agent-authored changes must be applied by the user, never
mirrored or deployed by an agent to `~/.config`.

## Constraints

- Do not deploy, mirror to `~/.config`, restart any service, or modify the Gentle AI clones, the
  live host configuration, or running services.
- Preserve the three existing installer/rollback entries and the `lib/` subpath.
- Do not change the broker trusted-agent allowlist (`["gentle-orchestrator"]`).
- Do not weaken any permission. Keep `host_sdd_attempt_grant` registered and working.
- Keep behaviour and tests in the same change units.
- Broker code stays dependency-free (`bun:test` + node builtins only), so `bun test` runs offline.

## Tasks

Stable IDs; each task is a reviewable change unit.

### T1 — Installer + rollback parity (v6 §24)

Add `opencode/plugins/reviewer-relay-transport.ts` and
`opencode/plugins/lib/host-tool-approval.ts` to `scripts/install-user-files` and
`scripts/rollback`, preserving the `lib/` subpath and keeping the existing three entries.

- Files: `scripts/install-user-files`, `scripts/rollback`.
- Done when: both scripts iterate the same five files; rollback's `cmp -s` guard still applies
  per file.

### T2 — Scoped review route (v6 §32)

Add `--base-ref` and `--committed-only` support to `host_review_assess` and `host_review_status`
end to end: plugin tool schemas (`sandbox-tools.ts`), broker payload allowlists
(`validation.ts`), and argv builders (`sdd-runtime.ts`). Keep the existing unscoped behaviour
valid when the flags are omitted.

- Files: `opencode/plugins/sandbox-tools.ts`,
  `opencode/plugins/lib/host-tool-approval.ts` (if ask metadata is needed),
  `broker/src/{types,validation,sdd-runtime,sdd-service}.ts`, `broker/tests/**`.
- Done when: an exact scoped argv is provable with a focused broker test, and omitting both flags
  yields the current argv byte-for-byte.

### T3 — Remove the eight dead retired v2 registrations (v6 §28)

Remove `host_sdd_attempt_acquire/begin/rescope/finish/reset/settle/status` and
`host_sdd_verify_validate` across plugin tools, broker read/mutation lists, payload allowlists,
protocol enum, server dispatch, handlers, argv builders, the permission fragment, and tests.
Keep `host_sdd_attempt_grant`.

- Files: `opencode/plugins/sandbox-tools.ts`,
  `opencode/plugins/lib/host-tool-approval.ts`,
  `opencode/config-fragments/sandbox-permissions.jsonc`, `broker/src/*.ts`, `broker/tests/**`.
- Done when: no retired v2 registration remains except the grant, and `host_sdd_attempt_grant`
  still routes and requires approval.

### T4 — Final full-suite evidence + record correction

Capture the closing evidence for the v6 change set and correct two inaccurate tracker claims. No
new test was added: T1–T3 each shipped their focused test in their own change unit and no genuine
coverage gap was found — adding tests only to inflate the count is out of scope.

- Files: `odd/tasks/gentle-ai-3.1.0-integration-alignment.md` (evidence + corrections only).
- Done when: the full broker suite, the broker build, and the plugin transpile are recorded with
  exact counts and observed exit status; the T3 RED claim and the T3 apply blocker are corrected;
  T5 is recorded for the leftover stale references.

### T5 — Update descriptive surfaces that still document the eight removed operations

Recorded by T4; not actioned in T4's change unit. These descriptive surfaces still name the eight
retired v2 operations that T3 removed:

- `opencode/prompts/sandbox-rules.md:31-33` — names `gentle-ai sdd-attempt acquire` and
  `host_sdd_attempt_acquire`. **Not S17.**
- `SYSTEM_PROMPT.md:292-294`, `:653`, and `:659-661` — the same two names. **Not S17.**
- `docs/config-manifest-host-tools.md` — section 4's allow/ask inventory, section 5's
  "31 host tools / 9 read / 22 mutation" counts, the section 5c tool tables, and the Appendix A.2
  permission block still describe all eight. **Not S17.**
- Historical OpenSpec change records also name them
  (`openspec/changes/agent-host-tools/{design,proposal,exploration,tasks,apply-progress}.md` and
  `openspec/changes/agent-host-tools/specs/host-sdd-runtime-tools/spec.md`). **Not S17**, but these
  are point-in-time records of the change that introduced the operations; annotate or leave as
  history rather than rewrite — decide during T5.

Explicitly out of T5: `opencode/config-fragments/sandbox-permissions.jsonc:76-89` keeps the eight
as deliberate `"deny"` entries (T3's chosen outcome; that path **is** S17), and
`broker/tests/retired-v2-registration.test.ts` names them deliberately as its assertion fixture.

## Acceptance criteria

1. All five plugin files are covered by both `scripts/install-user-files` and
   `scripts/rollback`.
2. The scoped flags (`--base-ref`, `--committed-only`) are provable end to end for
   `host_review_assess` and `host_review_status`; omitting them preserves current behaviour.
3. No retired v2 registration remains except `host_sdd_attempt_grant`.
4. `cd broker && bun test` is green and `bun build src/main.ts` compiles.
5. The hosted verifier no longer reports `HOST_TOOL_INSTALL_ROLLBACK_GAP` once the user applies
   the changes.

## Authorized scope

Authorized: create this tracker, then implement T1–T4 in this repository as reviewable change
units under the ODD work-unit commit rule, with sandbox-only mutation.

Not authorized by this tracker: push, PR creation, merge, release, deployment to `~/.config`,
service restart, edits to the Gentle AI clones or live host config, and changing the
trusted-agent allowlist or any permission strength.

## Checks

- `bun --cwd broker test`
- `bun build --target=bun --outfile=/tmp/main.js broker/src/main.ts`
- `bun build --target=bun --outfile=/tmp/plugin.js --external=@opencode-ai/plugin --external=zod opencode/plugins/sandbox-tools.ts`
- Record RED → GREEN evidence for any new test (T4 added none; T3's RED is inferred — see below).

## Progress

| Task | Status  | Notes |
|------|---------|-------|
| T1   | complete | Installer + rollback both cover the five plugin files; `broker/tests/installer-parity.test.ts` added (RED→GREEN). |
| T2   | complete | Scoped `--base-ref`/`--committed-only` wired end to end for `host_review_assess`/`host_review_status`; `broker/tests/review-scoped-flags.test.ts` added (RED→GREEN). |
| T3   | complete | Eight retired v2 registrations removed end to end (plugin, broker union/lists/payloads/dispatch/handlers/argv); `host_sdd_attempt_grant` kept and tested; fragment eight `deny` + grant `ask`; `broker/tests/retired-v2-registration.test.ts` added; full suite 371 pass / 0 fail. |
| T4   | complete | Closing evidence captured (suite 371 pass / 0 fail; build and plugin transpile exit 0); T3 RED claim corrected to inferred; T3 apply blocker corrected to applied; no new tests added (no genuine gap found). |
| T5   | pending | Recorded only: update descriptive surfaces that still document the eight removed operations (`opencode/prompts/sandbox-rules.md`, `SYSTEM_PROMPT.md`, `docs/config-manifest-host-tools.md`, plus historical OpenSpec change records). None are S17; the fragment `deny` entries and the retirement test are intentionally excluded. |

## Evidence

- Tracker created: `odd/tasks/gentle-ai-3.1.0-integration-alignment.md`.
- Audit verification (this delegation, read-only):
  - `scripts/install-user-files:110` and `scripts/rollback:37` both list only
    `sandbox-tools.ts routing-guard.ts lib/broker-client.ts`.
  - `sandbox-tools.ts:549-560` (`host_review_assess`, `args: {}`) and `:576-603`
    (`host_review_status`, no `baseRef`/`committedOnly`).
  - `validation.ts:890` (`reviewAssess: ["projectDir"]`) and `:892` (`reviewStatus` without
    `baseRef`/`committedOnly`).
  - `types.ts:56-70,126-140` and `sdd-service.ts:89-351` still register the eight retired v2
    operations; `sandbox-permissions.jsonc:76-89` still lists them.
- T1 evidence (sandbox worker, 2026-09-17):
  - Files changed: `scripts/install-user-files`, `scripts/rollback`, `broker/tests/installer-parity.test.ts` (new).
  - Target state: both scripts iterate the same five plugin files —
    `sandbox-tools.ts routing-guard.ts lib/broker-client.ts reviewer-relay-transport.ts lib/host-tool-approval.ts` —
    with the `lib/` subpath preserved and the existing three entries kept.
  - `scripts/rollback` keeps its per-file `cmp -s` guard unchanged.
  - New test parses each script's `for f in ...; do` loop and asserts both cover exactly the five
    plugin files (fails if any entry is missing from either script).
  - RED (before fix): full suite `bun test` — 402 pass, 5 fail (407 tests, 18 files); all five
    failures were the new installer-parity tests.
  - GREEN (focused): `bun test tests/installer-parity.test.ts` — 5 pass, 0 fail, 9 expect() calls, 1 file.
  - GREEN (full suite): `bun test` — 407 pass, 0 fail, 1827 expect() calls, 18 files.
  - Build: `bun build --target=bun --outfile=/tmp/main.js broker/src/main.ts` — Bundled 17 modules in 6ms,
    `main.js 212.17 KB`, exit 0. The default target with `--outfile` also bundled 24 modules (1.15 MB).
    The literal `bun build src/main.ts` (no outfile) streams the ~1.15 MB bundle to stdout and stalls
    on the broker output cap — a sandbox transport limitation, not a compile error.
  - Environment note: `sandbox_bash`'s relative `cwd` option fails in this worker (ENOENT), so the
    suite ran as `bun --cwd broker test`.
  - Result ref: refs/opencode-sandbox/result/ses_f4efbf4a7ffeGiX7BtZEzL7bLe
  - Blocker: none.
- T2 evidence (sandbox worker, 2026-09-17):
  - Upstream flags confirmed against `.sandbox-state/gentle-ai-3.1.0` (not guessed):
    - `internal/cli/review_assess.go:112` — `baseRef := flags.String("base-ref", ...)`; `:113` — `committedOnly := flags.Bool("committed-only", ...)`. Argument shape: `--base-ref <ref>` (value), `--committed-only` (bare boolean).
    - `internal/cli/review_facade.go:784` — `baseRef := flags.String("base-ref", ...)`; `:786` — `committedOnly := flags.Bool("committed-only", ...)`.
    - `internal/cli/review_operation_contract.go:112` — STATUS publishes `base-ref` in ValueFlags and `committed-only` in BoolFlags.
    - Both commands accept both flags. The upstream command owns the committed-range pairing/acknowledgement rule; the broker forwards each supplied flag verbatim and adds no cross-flag policy.
  - Files changed (S17): `opencode/plugins/sandbox-tools.ts`, `broker/src/validation.ts`, `broker/src/types.ts`, `broker/src/sdd-runtime.ts`, `broker/src/sdd-service.ts`; new test `broker/tests/review-scoped-flags.test.ts`. `host-tool-approval.ts` needed no change (both operations are read-only with no ask metadata).
  - Wiring points: plugin schemas `sandbox-tools.ts:549-566` (assess) and `:576-611` (status); payload allowlists `validation.ts:890` and `:892-900`; argv builders `sdd-runtime.ts:157-176`, `:614-641` (assess), `:650-709` (status); runtime methods `sdd-runtime.ts:1248-1262` (assess) and `:1283-1318` (status); handlers `sdd-service.ts:112-121` and `:138-155`.
  - Behaviour: flags are optional; omitting both keeps the unscoped argv byte-for-byte (`review assess --cwd <root> --json`; `review status --cwd --contract gentle-ai.review-integration/v2 --agent opencode --next-transition`). Values are validated by the existing `assertReviewBaseRef`/`assertOptionalBoolean` and forwarded exactly. Status emits the scoped pair after `--projection` and before `--intended-untracked-selection`, keeping `--next-transition` last. Explicit `committedOnly: false` emits nothing (matches the table-driven review-field behaviour).
  - Redaction rules, trusted-agent allowlist, and permission strength: unchanged.
  - RED (before fix): `bun --cwd broker test tests/review-scoped-flags.test.ts` — 6 pass, 8 fail, 26 expect() calls, 14 tests, 1 file, exit 1.
  - GREEN (focused): `bun --cwd broker test tests/review-scoped-flags.test.ts` — 14 pass, 0 fail, 35 expect() calls, 1 file, exit 0.
  - GREEN (full suite): `bun --cwd broker test` — 421 pass, 0 fail, 1862 expect() calls, 19 files, exit 0.
  - Build: `bun build --target=bun --outfile=/tmp/main.js broker/src/main.ts` — Bundled 17 modules in 8ms, `main.js 213.43 KB`, exit 0.
  - Plugin syntax: `bun build --target=bun --outfile=/tmp/plugin.js --external=@opencode-ai/plugin --external=zod opencode/plugins/sandbox-tools.ts` — Bundled 3 modules, `plugin.js 80.31 KB`, exit 0 (no `node_modules` in the worker, so imports were marked external; this is a syntax/bundle check only).
  - Residual: the scoped route is now provable end to end in the broker, but a live scoped run against the host review store remains the user's runtime probe — these tests do not execute `gentle-ai review assess/status --base-ref … --committed-only`.
  - Result ref: refs/opencode-sandbox/result/ses_f4ec71bfaffeEv262rG3QOahKz
  - Blocker: S17 apply refusal (`broker/src/**` and `opencode/plugins/**` are protected paths); the change unit is retained for manual user application.

- T3 evidence (sandbox worker, 2026-09-17):
  - Removed the eight retired v2 registrations: `host_sdd_verify_validate` and
    `host_sdd_attempt_acquire/status/begin/rescope/finish/reset/settle` (broker operations
    `sddVerifyValidate`, `sddAttemptAcquire/Settle/Begin/Rescope/Finish/Reset/Status`).
  - Surfaces removed end to end: plugin tools (`opencode/plugins/sandbox-tools.ts`), ask
    metadata + `HostMutationOperation` (`opencode/plugins/lib/host-tool-approval.ts`), client
    timeouts (`opencode/plugins/lib/broker-client.ts`), `Operation`/`OPERATIONS`/payload
    interfaces (`broker/src/types.ts`), read+mutation lists and `ALLOWED_PAYLOAD_KEYS`
    (`broker/src/validation.ts`), dispatch (`broker/src/server.ts`), handlers
    (`broker/src/sdd-service.ts`), argv builders + executor methods (`broker/src/sdd-runtime.ts`).
  - `host_sdd_attempt_grant` stays registered, orchestrator-only, approval-gated, and covered
    end to end (operation, exact argv, ask metadata).
  - Permission fragment: the eight entries are now `"deny"` and were NOT deleted;
    `host_sdd_attempt_grant` remains `"ask"` (`opencode/config-fragments/sandbox-permissions.jsonc:76-89`).
  - Tests: deleted `broker/tests/sdd-settle-untracked.test.ts`; pruned retired-op tests from
    `service-host-tools.test.ts`, `sdd-runtime.test.ts`, `validation.test.ts`,
    `host-tool-approval.test.ts`; added `broker/tests/retired-v2-registration.test.ts`
    (6 tests: op-union absence, classification absence, payload-allowlist absence, grant
    registration/argv/ask, and the fragment's eight `deny` + grant `ask`).
  - RED: **inferred, not captured.** The retirement test was authored in the same change unit as
    the removals and was only ever observed GREEN; it never ran against the pre-change broker. No
    pre-change state remained reachable once the eight registrations were removed in the same
    unit, and the worker was terminal after apply, so a pre-change rerun was impossible. The
    earlier wording that this RED "fails against the pre-change broker" was an inference, not
    observed evidence.
  - GREEN (full suite): `bun --cwd broker test` — 371 pass, 0 fail, 1708 expect() calls, 19 files, exit 0.
  - Build: `bun build --target=bun --outfile=/tmp/main.js broker/src/main.ts` — Bundled 17 modules in 8ms,
    `main.js 187.27 KB`, exit 0. Plugin syntax: `bun build --target=bun --outfile=/tmp/plugin.js
    --external=@opencode-ai/plugin --external=zod opencode/plugins/sandbox-tools.ts` — Bundled 3 modules,
    `plugin.js 60.17 KB`, exit 0.
  - Diff (result commit): 16 files changed, 281 insertions / 3485 deletions (includes this tracker and
    the new `broker/tests/retired-v2-registration.test.ts`; counts the deleted
    `broker/tests/sdd-settle-untracked.test.ts`).
  - Result ref: refs/opencode-sandbox/result/ses_f4ebab0d3ffeRh11KUSfP6bWYM
  - Residual: `opencode/prompts/sandbox-rules.md:31-33`, `SYSTEM_PROMPT.md:292,659`, and
    `docs/config-manifest-host-tools.md` still name retired tools; they are descriptive surfaces
    outside T3's authorized file list and are recorded rather than edited. T5 now tracks them
    (extended list in the T5 section).
  - Blocker: none — **corrected by T4.** The earlier prediction that the S17 guard would force
    manual re-application did not hold: the T3 change unit applied successfully and, together with
    T1 and T2, is present in the host working tree (committed and installed). This supersedes the earlier
    "pending sandbox_apply / retained for manual application" notes on the T2 and T3 units.

- T4 evidence (sandbox worker, 2026-09-17):
  - Scope: closing evidence capture and record correction only; T1–T3 were not re-done and no
    source file changed in this unit — the only delta is this tracker.
  - Baseline: the worker snapshot contains the T1–T3 host working-tree changes (worker baseline
    commit `3911549`, parent `ff9149c`); `git status --porcelain` in the worker was clean apart
    from the session bundle, so the suite ran against the T1–T3 code.
  - Full suite: `bun --cwd broker test` — 371 pass, 0 fail, 1708 expect() calls, 19 files;
    exit status 0 (observed by spawning the exact argv and printing its exit code).
  - Build: `bun build --target=bun --outfile=/tmp/main.js broker/src/main.ts` — Bundled 17 modules
    in 6ms, `main.js 187.27 KB`; exit status 0 (observed).
  - Plugin transpile: `bun build --target=bun --outfile=/tmp/plugin.js
    --external=@opencode-ai/plugin --external=zod opencode/plugins/sandbox-tools.ts` — Bundled 3
    modules in 2ms, `plugin.js 60.17 KB`; exit status 0 (observed).
  - New tests: none added — no genuine coverage gap found; T1–T3 already shipped their focused
    tests in their own units.
  - Corrected claim 1: the T3 retirement-test RED is **inferred, not captured** (see the corrected
    T3 RED line above).
  - Corrected claim 2: the T3 apply-blocker prediction was wrong — the apply succeeded and T1–T3
    are in the host working tree (committed and installed).
  - Environment note: `sandbox_bash` does not surface process exit codes and its relative `cwd`
    option fails (ENOENT); the suite ran as `bun --cwd broker test`, and exit codes were observed
    by spawning the exact argv from `bun -e` and printing the child's `.exitCode`.
  - Blocker: none.

## Delivery decision — chain strategy, slice boundaries, commits

Recorded 2026-09-17. The delivery decision for this change set has been taken.

- **Chain strategy:** `stacked-to-main`. Each unit lands on the default branch in order, as its own
  reviewable slice. **Delivery strategy remains `ask-on-risk`.**
- **Why the choice was due:** the authored running total crossed the ~400-line advisory (T3 alone:
  281 insertions / 3485 deletions), which is the `ask-on-risk` trigger. This is planning guidance
  only — it never justified shrinking the changes; the code was sized by the v6 requirements, not
  by the line budget.

### Slice boundaries and commit membership

One commit per slice; a slice's diff is computed against the previous slice.

- **Slice 1 (T1)** — `scripts/install-user-files`, `scripts/rollback`,
  `broker/tests/installer-parity.test.ts`.
- **Slice 2 (T2)** — `opencode/plugins/sandbox-tools.ts`, `broker/src/validation.ts`,
  `broker/src/types.ts`, `broker/src/sdd-runtime.ts`, `broker/src/sdd-service.ts`,
  `broker/tests/review-scoped-flags.test.ts`.
- **Slice 3 (T3)** — `opencode/plugins/sandbox-tools.ts`,
  `opencode/plugins/lib/host-tool-approval.ts`, `opencode/plugins/lib/broker-client.ts`,
  `opencode/config-fragments/sandbox-permissions.jsonc`, `broker/src/sdd-runtime.ts`,
  `broker/src/sdd-service.ts`, `broker/src/server.ts`, `broker/src/types.ts`,
  `broker/src/validation.ts`, `broker/tests/retired-v2-registration.test.ts`, plus the
  deleted/edited retired-op tests (`broker/tests/sdd-settle-untracked.test.ts` deleted;
  `service-host-tools.test.ts`, `sdd-runtime.test.ts`, `validation.test.ts`,
  `host-tool-approval.test.ts` pruned).
- **Metadata slice (T4/T5)** — `odd/tasks/gentle-ai-3.1.0-integration-alignment.md` only.

Slices 2 and 3 both touch `opencode/plugins/sandbox-tools.ts`, `broker/src/sdd-runtime.ts`,
`broker/src/sdd-service.ts`, `broker/src/types.ts`, and `broker/src/validation.ts`. They must
therefore be committed in order, and the later slice's diff is computed against the earlier slice —
not against the default branch.

### Commit convention for these slices

- Conventional Commit messages (for example `fix(installer): …`, `feat(review): …`,
  `chore(broker): …`).
- Include the routed-task trailer
  `ROUTED: global-tooling@human-review (router log row <date>)`, where `<date>` is the actual
  router-log row date filled in at commit time.
- No AI attribution and no `Co-Authored-By` trailer.

### Outstanding before delivery

1. S17 human review of all three slices.
2. Hosted verifier run with `WORKFLOW_VERIFY_SANDBOX_REPO` set, confirming
   `HOST_TOOL_INSTALL_ROLLBACK_GAP` is gone.
3. Refresh the installed plugin files.
4. The single secure-OpenCode restart, after all plugin checks pass.
5. The post-restart verifier run.
6. The two live probes: a scoped `review assess --base-ref … --committed-only` run against the host
   review store, and the Gate 11 relay probe.

### Known limitation

The `ROUTER-LOG.md` row this work owes lives in
`/home/james/ai-workspace/workflow_optimisation/`, outside this repository, so no sandbox worker can
write it. The user must add it (or an authorized host-side path must).

## Next step

T5 — update the descriptive surfaces that still document the eight removed operations. Recorded,
not yet actioned; none of its targets are S17.

## Closing note — user actions for the v6 change set

T1–T4 are complete, committed and installed. Remaining user-owned steps:

1. Review the S17 diff (`broker/src/**`, `opencode/plugins/**`, `scripts/**`,
   `opencode/config-fragments/**`).
2. Create the work-unit commits under the ODD work-unit rule.
3. Run the hosted verifier with `WORKFLOW_VERIFY_SANDBOX_REPO` set and confirm
   `HOST_TOOL_INSTALL_ROLLBACK_GAP` is gone.
4. Install/refresh the plugin files, then the single restart and the post-restart verifier run.
5. Run the live runtime probes: a scoped `review assess --base-ref … --committed-only` run and the
   Gate 11 relay probe.

## Deferred / out of scope (record, do not action)

- C3 verifier wording checks — they pass; editing `verify-workflow.sh` would force the
  health-plugin digest re-pin.
- C10 the inert ten `host_system`/service/process/network/Docker `allow` entries in the
  permission fragment.
- The `global-config` / deployed `AGENTS.md` divergence.
- The RDD kill-switch command naming and the one-line feature-document message in `WORKFLOW.md`.
