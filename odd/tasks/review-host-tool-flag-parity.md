# ODD Tasks — review-host-tool-flag-parity

- **Feature:** `review-host-tool-flag-parity`
- **Project:** `sandbox-integration` (`/home/james/agent-sandbox-integration`)
- **Status:** planned — tracker only; no implementation started
- **Created:** 2026-09-19
- **Delivery strategy:** `ask-on-risk`
- **Chain strategy:** `stacked-to-main` (the user's standing choice)

## Objective

Make the broker's fixed argv for every host review-lifecycle tool match the flags the installed gentle-ai 3.4 CLI requires, so a host review tool is refused only for genuine provider/binding reasons and never because the broker omitted a required flag. The confirmed instance is `host_review_acknowledge_approved`: today it builds a flag-less argv, and the 3.4 CLI refuses it unless `--lineage`, `--target`, `--expected-revision`, and `--token` are present. The fix accepts those four provider-issued values from the caller and forwards them byte-for-byte; no token is invented or derived broker-side.

## Problem

The broker's `reviewAcknowledgeApproved` operation is flag-less in this repository, while the installed 3.4 CLI requires four provider-issued flags. The observed refusal is exactly:

```
Error: review acknowledge-approved requires --lineage, --target, --expected-revision, and --token
```

That message is emitted at `internal/cli/review_last_event_closure.go:76-77` (`RunReviewAcknowledgeApproved`, `:60-86`) when any of the four is empty. The four values are provider-issued: `reviewApprovedAcknowledgementTransition` builds the exact continuation with `cwd`, `lineage`, `target`, `expected-revision`, and `token` at `review_last_event_closure.go:33-43` (the token comes from the committed `ApprovedCompactAcknowledgement`).

Why this went unnoticed: a prior 3.3→3.4 audit's verb list omitted `acknowledge-approved`, so that verb was never included in the flag-parity comparison. The 3.4 operation registry compounds this — its `acknowledge-approved` row declares no flag metadata at all (`review_operation_contract.go:100` has only `Command`/`Operation`/`Label`, no `ValueFlags`/`BoolFlags`), so a registry-metadata-driven sweep has nothing to compare and silently skips the row. (The omission is reported context; the earlier audit artifact itself is not present in this repository.)

## Verified current surface (file:line)

Part B sweep performed read-only in this session (2026-09-19) against the installed 3.4 tree at `.sandbox-state/gentle-ai-3.4.0`. "Broker argv" is the fixed vector the broker assembles; "3.4 CLI requires" is the flag set the Run function refuses without.

| Tool | Broker argv (source) | 3.4 CLI requires (source) | Status |
|------|----------------------|---------------------------|--------|
| `host_review_acknowledge_approved` | `[binary, "review", "acknowledge-approved"]` — `sdd-runtime.ts:1010-1015` (spec `fields: []`, `needsRoot:false`), executor `sdd-runtime.ts:819-826`, plugin `sandbox-tools.ts:932-945` (`args: {}`) | `--lineage --target --expected-revision --token` (all four; `--cwd` defaults to `"."`) — `review_last_event_closure.go:62-66`, refusal `:76-78` | **drifted** — all four flags missing |
| `host_review_assess` | `[binary, "review", "assess", "--cwd", root, (--base-ref), (--committed-only), (--untracked-scope=…), (--expected-untracked-inventory=…), (--intended-untracked)…, "--json"]` — `sdd-runtime.ts:308-346` | no required flags; all optional (`cwd` default `"."`) — `review_assess.go:207-260` | matches |
| `host_review_capture_correction_plan` | `[binary, "review", "capture-correction-plan", "--cwd", root, …]` — spec `sdd-runtime.ts:1016-1028`, builder `:1287-1289`, executor `:834-836` | `--lineage --target --expected-revision --request-hash` + positive `--correction-lines` — `review_correction_plan_capture.go:28-46` | matches (broker can emit all) |
| `host_review_capture_refuter` | `[binary, "review", "capture-refuter", "--cwd", root, …]` — spec `sdd-runtime.ts:1029-1042`, builder `:1290-1292`, executor `:837-839` | `--lineage --target --expected-revision --agent` + one of `--materialize`/`--execute`/`--input` — `review_provider_role_capture.go:62-104` | matches (required set present; `--input` not exposed — see note) |
| `host_review_capture_result` | `[binary, "review", "capture-result", "--cwd", root, …]` — spec `sdd-runtime.ts:977-994`, executor `:779-817` (stages `--input`) | exact repository context, `--lineage --target --lens --order` + either `--input` or `--agent` (or `--preflight`) — `review_artifact.go:143-190`, refusal `:178` | matches |
| `host_review_capture_unachievable` | `[binary, "review", "capture-unachievable", "--cwd", root, …]` — spec `sdd-runtime.ts:995-1009`, builder `:1281-1283`, executor `:831-833` | `--lineage --target --expected-revision --request-hash`; `--reason` unless `--withdraw` — `review_capture_unachievable.go:60-84` | matches |
| `host_review_capture_validation` | `[binary, "review", "capture-validation", "--cwd", root, …]` — spec `sdd-runtime.ts:1043-1057`, builder `:1293-1295`, executor `:840-842` | `--lineage --target --expected-revision --agent` + `--request-hash` + one of `--materialize`/`--execute`/`--input` — `review_provider_role_capture.go:62-104` | matches (required set present; `--input` not exposed — see note) |
| `host_review_lens_context` | `[binary, "review", "lens-context", "--cwd", root, "--repository-context", …, "--lineage", …, "--target", …, "--expected-revision", …, "--lens", …]` — `sdd-runtime.ts:431-466` | `--repository-context --lineage --target --expected-revision --lens` — `review_lens_context.go:204-222` | matches |
| `host_review_mode_status` | `[binary, "review", "mode", "status"]` — `sdd-runtime.ts:349-354` | no required flags (`--cwd` default `"."`) — `review_mode.go:46-92` | matches |
| `host_review_recover` | `[binary, "review", "recover", "--cwd", root, …]` — spec `sdd-runtime.ts:1076-1098`, builder `:1299-1301`, executor `:846-848` | `--predecessor-lineage --expected-predecessor-revision --successor-lineage --disposition`; `--reason` + `--actor` when `--maintainer-authorization` is supplied — `review_facade.go:1556-1600` | matches |
| `host_review_start` | `[binary, "review", "start", "--cwd", root, …]` — spec `sdd-runtime.ts:955-976`, builder `:1275-1277`, executor `:828-830` | negotiated route requires exactly one `--agent` and `--target`; `--base-ref` pairing rules — `review_facade.go:1990-2050` | matches (all fields present) |
| `host_review_status` | `[binary, "review", "status", "--cwd", root, "--contract", "gentle-ai.review-integration/v2", "--agent", …, "--next-transition"]` — `sdd-runtime.ts:364-421` | no unconditional required flags (`cwd`/`projection` defaults) — `review_facade.go:774-812` | matches |
| `host_review_validate` | `[binary, "review", "validate", "--cwd", root, …]` — spec `sdd-runtime.ts:1058-1075`, builder `:1296-1298`, executor `:843-845` | `--gate` required (allowlisted enum) — `review_facade.go:2581-2608` | matches |

Notes (not required-flag drift, recorded for completeness):

- `host_review_assess` does not forward the CLI's optional `--agent`; the broker builder has no `agent` field (`sdd-runtime.ts:308-346`). Optional only; assess remains runnable without it.
- `capture-refuter` and `capture-validation` do not expose the CLI's optional `--input` submission form; the broker exposes `--materialize`/`--execute` (`sdd-runtime.ts:1029-1057`). The CLI's required-flag rule is satisfied by those two, so this is a capability gap, not a required-flag drift. Confirm at T2 whether the host-relay result path needs `--input`.
- `acknowledge-approved` also has an implicit `--cwd`: the CLI default is `"."` and the broker spawns with `cwd: projectRoot` (`sdd-runtime.ts:856-866`), so the effective repository is correct; only the four token flags are missing.

Broker-side chain for the confirmed drift:

- Plugin declaration: `opencode/plugins/sandbox-tools.ts:932-945` (`args: {}`, description literally says "The candidate argv is flag-less").
- Approval metadata: `opencode/plugins/lib/host-tool-approval.ts:463-473` (`ReviewAcknowledgeApprovedAskArgs {}`, empty `details`).
- Operation classification and payload allowlist: `broker/src/validation.ts:805` (mutation) and `:942` (`reviewAcknowledgeApproved: ["projectDir"]`).
- Payload type: `broker/src/types.ts:311-313` (`ReviewAcknowledgeApprovedPayload { projectDir: string }`).
- Dispatch and handler: `broker/src/server.ts:413-414` → `broker/src/sdd-service.ts:285-292` → `broker/src/sdd-runtime.ts:819-826`.
- Fixed-argv spec: `broker/src/sdd-runtime.ts:1010-1015`.

## Scope

### In scope

- Accept the four provider-issued values (`lineage`, `target`, `expectedRevision`, `token`) for `reviewAcknowledgeApproved` and forward them, in the exact flag order the CLI documents, as separate argv items.
- Re-check every other host review-lifecycle tool against the 3.4 required-flag set (the sweep above) and fix any additional drift it surfaces (T2).
- Tests for argv shape, refusal cases, and provider-token forwarding (T3).
- Fragment/manifest updates if the tool surface changes (T4), and evidence readback (T5).

### Out of scope

- Changing review semantics, adding non-provider flags, or inventing/deriving any token.
- The optional-flag capability gaps (`assess --agent`, refuter/validation `--input`) unless T2 confirms they are required for the host-relay path.
- Any change to the installed 3.4 tree, `~/.config`, systemd, or the relay.

## Constraints

- Fixed argv vectors only; never a shell string. Values are pushed as separate argv items.
- Provider-issued values (`--lineage`, `--target`, `--expected-revision`, `--token`, and any other provider token) are forwarded byte-for-byte and never invented, re-encoded, or defaulted.
- Orchestrator-only mutation where the tool is a mutation: `reviewAcknowledgeApproved` stays in `HOST_MUTATION_OPERATIONS` (`validation.ts:805`) and keeps its `ctx.ask` gate.
- Exact-payload-key allowlists preserved: `reviewAcknowledgeApproved` in `ALLOWED_PAYLOAD_KEYS` (`validation.ts:942`) must list exactly the forwarded keys; no undeclared key is accepted (`assertPayloadKeys`, `:987-1006`).
- S17: `broker/src/**`, `opencode/plugins/**`, `opencode/config-fragments/**`, and `docs/threat-model.md` are reviewed and installed by the user, never auto-applied.
- No deploy, mirror to `~/.config`, service restart, or commit by an agent.

## Tasks

Stable IDs; each task is a reviewable change unit.

### T1 — acknowledge-approved: accept and forward the four provider-issued values

Add `lineage`, `target`, `expectedRevision`, `token` to the payload type, the exact-key allowlist, the plugin tool args + approval metadata, the dispatcher forwarding, and the argv spec so the built vector is `[binary, "review", "acknowledge-approved", "--lineage", <l>, "--target", <t>, "--expected-revision", <r>, "--token", <tok>]`.

- Files: `broker/src/types.ts`, `broker/src/validation.ts`, `broker/src/sdd-service.ts`, `broker/src/sdd-runtime.ts`, `opencode/plugins/sandbox-tools.ts`, `opencode/plugins/lib/host-tool-approval.ts`.
- Done when: the four values are forwarded byte-for-byte; a missing value refuses broker-side before spawn; no token is derived broker-side.

### T2 — fix any other drifted tool found by the sweep

The sweep above found no other required-flag drift. Re-run the comparison at implementation time; if any tool has drifted, fix it in the same pattern as T1. Confirm the two capability-gap notes (`assess --agent`, refuter/validation `--input`) are genuinely optional.

- Done when: a recorded re-sweep against the installed tree shows exactly one drifted tool (acknowledge-approved) or all drift is fixed.

### T3 — tests

Argv shape for `acknowledge-approved`; refusal cases (missing lineage/target/expected-revision/token); provider-token byte-for-byte forwarding. Capture RED→GREEN.

- Files: `broker/tests/sdd-runtime.test.ts`, `broker/tests/service-host-tools.test.ts`, `broker/tests/host-tool-approval.test.ts`, `broker/tests/validation.test.ts`.
- Done when: RED→GREEN is captured and the existing suite stays green.

### T4 — fragment/manifest updates if the tool surface changes

If the payload keys or tool metadata change in a way the fragment or manifest records, update them in the same change unit.

- Files: `opencode/config-fragments/sandbox-permissions.jsonc`, `docs/config-manifest-host-tools.md`, `docs/threat-model.md` (S17, only if the boundary warrants it).
- Done when: the recorded surface matches the implemented one.

### T5 — evidence and readback

Verify the implemented argv against the 3.4 CLI requirement; confirm the exact-refusal reproduction no longer occurs.

- Done when: the argv builder, the payload allowlist, the plugin args, and the 3.4 `RunReviewAcknowledgeApproved` requirement (`review_last_event_closure.go:76-78`) agree.

## Acceptance criteria

1. `host_review_acknowledge_approved` emits `--lineage`, `--target`, `--expected-revision`, and `--token` as separate argv items when supplied.
2. The four values are forwarded byte-for-byte; none is invented, defaulted, or re-encoded.
3. A missing required value is refused broker-side before any spawn.
4. `reviewAcknowledgeApproved` stays an orchestrator-only mutation with its `ctx.ask` gate.
5. The exact-key allowlist lists exactly the forwarded keys; no undeclared key is accepted.
6. Tests cover argv shape, the refusal cases, and provider-token forwarding; the existing suite stays green.
7. Every other host review-lifecycle tool matches the 3.4 required-flag set, or its drift is fixed.

## Checks

- `bun --cwd broker test` (all suites green; RED→GREEN captured for new assertions). Note: `sandbox_bash`'s `cwd` is broken, so always use the `--cwd` form.
- `bun build broker/src/main.ts --outfile <tmp path>` (always pass `--outfile`; compiles; dependency-free constraint holds).
- Argv inspection for `reviewAcknowledgeApproved`: exact fixed vector; four token flags forwarded verbatim; no shell string.
- Payload-key readback: `ALLOWED_PAYLOAD_KEYS.reviewAcknowledgeApproved` equals the forwarded key set.
- S17 files are reviewed and installed by the user; the agent does not apply them.

## Authorized scope

Authorized: implement T1–T5 as reviewable change units under the ODD work-unit rule, with sandbox-only mutation, after a separate apply phase is explicitly launched.

Not authorized by this tracker: deployment, mirroring to `~/.config`, service restart, or commit/push/PR/merge/release; and any change that weakens a permission. S17 files (`broker/src/**`, `opencode/plugins/**`, `opencode/config-fragments/**`, `docs/threat-model.md`) are reviewed and installed by the user, never auto-applied.

This tracker's creation is the only authorized output of the creating session; no feature code, deploy, mirror, restart, or commit was performed.

## Delivery strategy

- Delivery strategy: `ask-on-risk`. Forecast at tracker creation: the change spans one payload type, one allowlist, one dispatcher forward, one argv spec, one plugin tool, one approval-metadata helper, and tests — plausibly 60–150 authored lines. Recompute from work-unit commits; when the running total crosses ~400 authored lines, apply the chosen strategy before the next commit.
- Chain strategy: `stacked-to-main` (the user's standing choice). Each unit lands on the default branch in order as its own reviewable slice.
- Likely slices (confirm at implementation time): Slice 1 = T1 + T3 + T5 (the fix, its tests, and readback). T2/T4 are conditional and may collapse into Slice 1 if no other drift surfaces.

## Progress

| Task | Status  | Notes |
|------|---------|-------|
| T1   | pending | Not started. Accept + forward the four provider-issued values. |
| T2   | pending | Not started. Re-sweep for other drift; none found on 2026-09-19. |
| T3   | pending | Not started. Tests: argv shape, refusals, token forwarding. |
| T4   | pending | Not started. Fragment/manifest only if the surface changes. |
| T5   | pending | Not started. Evidence and readback. |

## Evidence

- Tracker created: `odd/tasks/review-host-tool-flag-parity.md` (this file).
- Verified read-only in this session (2026-09-19):
  - `broker/src/sdd-runtime.ts:1010-1015` — `reviewAcknowledgeApproved` spec (`command ["review","acknowledge-approved"]`, `needsRoot:false`, `fields:[]`).
  - `broker/src/sdd-runtime.ts:819-826` — `reviewAcknowledgeApproved` executor (`buildReviewAcknowledgeApprovedArgv({ binary })`).
  - `broker/src/sdd-runtime.ts:1284-1286` — `buildReviewAcknowledgeApprovedArgv`.
  - `broker/src/sdd-runtime.ts:954-1099` — `REVIEW_COMMANDS` registry; `:1229-1267` — `buildReviewArgv`; `:856-866` — spawn with `cwd: projectRoot`.
  - `broker/src/sdd-service.ts:285-292` — `buildReviewAcknowledgeApprovedOp` (forwards only `projectDir`).
  - `broker/src/server.ts:413-414` — dispatch case.
  - `broker/src/validation.ts:805` — mutation classification; `:942` — payload allowlist `["projectDir"]`; `:987-1006` — `assertPayloadKeys`.
  - `broker/src/types.ts:311-313` — `ReviewAcknowledgeApprovedPayload`.
  - `opencode/plugins/sandbox-tools.ts:932-945` — plugin declaration (`args: {}`).
  - `opencode/plugins/lib/host-tool-approval.ts:463-473` — `buildReviewAcknowledgeApprovedAsk` (empty details).
  - `.sandbox-state/gentle-ai-3.4.0/internal/cli/review_last_event_closure.go:60-86` — `RunReviewAcknowledgeApproved`; flags `:62-66`; refusal `:76-78`; provider continuation `:33-43`.
  - `.sandbox-state/gentle-ai-3.4.0/internal/cli/review_operation_contract.go:100` — `acknowledge-approved` registry row with no flag metadata; `:95-99` — capture rows with flag metadata; `:111-113` — start/status/validate rows.
  - 3.4 CLI required-flag evidence for the rest of the sweep: `review_assess.go:207-260`; `review_artifact.go:143-190`; `review_capture_unachievable.go:60-84`; `review_correction_plan_capture.go:28-46`; `review_provider_role_capture.go:62-104`; `review_lens_context.go:204-222`; `review_mode.go:46-92`; `review_facade.go:774-812`, `:1556-1600`, `:1990-2050`, `:2581-2608`.
- Reported context (not reproduced here): a prior 3.3→3.4 audit's verb list omitted `acknowledge-approved`, which is why the missing flags went unnoticed; the earlier audit artifact is not present in this repository.

## Next step

T1 — accept `lineage`, `target`, `expectedRevision`, and `token` for `reviewAcknowledgeApproved` and forward them as the four provider-issued argv flags, mirroring the provider continuation in `review_last_event_closure.go:33-43`. Confirm the S17 review path before any apply.
