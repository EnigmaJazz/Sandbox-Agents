# ODD Tasks — host-journal-tool

- **Feature:** `host-journal-tool`
- **Project:** `sandbox-integration` (`/home/james/agent-sandbox-integration`)
- **Status:** planned — tracker only; no implementation started
- **Created:** 2026-09-19
- **Delivery strategy:** `ask-on-risk`
- **Chain strategy:** `stacked-to-main` (the user's standing choice)

## Objective

Add a read-only host journal tool, `host_journal`, so an agent can read a bounded
slice of a user journal directly instead of asking the user to paste
`journalctl` output by hand. The tool runs a fixed argv vector
(`journalctl --user --unit <unit> --since <window> --lines <n> --no-pager`),
restricted to a deliberately small unit allowlist and a bounded window/line
count, applies an optional case-sensitive literal substring filter broker-side,
and returns output that is redacted first and then capped at the same 512 KiB
limit the host git reads use. It is classified `read`, so it is open to every
agent and never prompts.

## Problem

During the reviewer-relay debugging session the orchestrator repeatedly asked the
user for `journalctl` output — roughly a dozen manual round-trips — because the
relay's own diagnostics (materialized-prompt length/blockFound,
`messages.transform` / `system.transform` binding lines, child exit reasons)
exist only in the journal. The recurring targets were `secure-opencode.service`
and `sandbox-broker.service`. (Reported by the user; not reproduced here.) An
agent cannot read those journals today through the host tool surface.

## Verified current surface (file:line)

Read-only observations from this session (2026-09-19); the manifest's cited line
numbers are stale relative to the current files. The observed values are below.

### Read classification and authorization — `broker/src/validation.ts`

- `:783-791` — `HOST_READ_OPERATIONS` has exactly **7** entries (`sddStatus`,
  `sddContinue`, `sddTaskResult`, `reviewAssess`, `reviewModeStatus`,
  `reviewStatus`, `reviewLensContext`). **No journal operation.**
- `:794-811` — `HOST_MUTATION_OPERATIONS` has **16** entries (includes
  `gitCommit` `:796`, `gitPush` `:797`). No journal operation.
- `:813-819` — `hostToolAccess`: a `read`/`mutation` classification; any operation
  in neither list throws `unknown host tool operation`.
- `:832-860` — `HostToolPolicy`; `decide` returns
  `{ allowed: true, access: "read", reasonCode: "HOST_READ_OPEN" }` for read ops
  at `:848-850`, so reads are open to every agent and never reach the
  orchestrator-allowlist branch (`:851-858`).
- `:866-985` — `ALLOWED_PAYLOAD_KEYS` (exact-key allowlist per operation). Host
  read-tier examples: `reviewStatus` `:895-904`, `reviewLensContext` `:905-912`.
  The parallel `hostread` keys are `:969-978` (incl. `hostServiceLogs`
  `:977 = ["service","lines","since"]`). `hostJournal` does not exist.
- `:987-1006` — `assertPayloadKeys`: rejects any undeclared key; a broker-policy
  `FORBIDDEN_WORKER_FIELDS` key gets a distinct message.

### Operation union and dispatch

- `broker/src/types.ts:35-99` — the `Operation` union. Host read ops are `:82-91`
  (`hostSystemSummary` … `hostDockerLogs`); the sdd/review read tier is `:54-61`.
  `:102-155` — `OPERATIONS` array (unknown ops fail closed).
- `broker/src/server.ts:342-438` — `dispatch` switch; `reviewStatus` at
  `:391-392`; the default case at `:436` routes anything else to `buildHostOp`.
- `broker/src/service.ts:147-163` — `authorizeHostDispatch`: builds
  `HostToolPolicy` from `config.readOnlyAgents`, takes the broker-derived
  `trustedAgent` from the session record (`:154-155`), and throws `PolicyError`
  when denied.
- `broker/src/service.ts:2145-2157` — `buildHostOp` (the parallel `hostread`
  path): checks `ctx.hostRead.has(op)` and executes; it does **not** call
  `authorizeHostDispatch`.
- `broker/src/sdd-service.ts:122-138` — `buildReviewStatusOp`, the read-handler
  shape to mirror: `payloadOf(req)` (which runs `assertPayloadKeys`) at `:124`,
  `authorizeHostDispatch(ctx, "reviewStatus", …)` at `:125`.

### Parallel structured host-read tier — `broker/src/hostread.ts`

This is a **second** host-read mechanism that already reads the journal; it is
recorded because it overlaps the requested tool.

- `:29-37` — `HostReadOp` (`operation`, `binary`, `baseArgv`, `payloadKeys`,
  `outputCapBytes`, `readOnly: true`).
- `:48-75` — `buildHostReadOps`; `:70` registers `hostServiceLogs` with
  `baseArgv ["-u"]`, keys `["service","lines","since"]`, cap `512 * 1024`.
- `:102-122` — `execute`: spawns the fixed argv with `maxOutputBytes` = op cap;
  `:113-120` filters `hostProcessList` output in-process by a literal
  `includes(needle)` — the precedent for a literal (non-regex) filter.
- `:128-171` — `buildArgv`: fixed binary + base argv; `lines` → `-n N`
  (`:144-147`), `since` → `--since S` (`:149-154`).
- `:174-177` — `truncate` (the hostread cap; note it does **not** redact).
- `broker/src/config.ts:63-75` — `HostReadConfig`; `:247-259` —
  `DEFAULT_HOST_READ_CONFIG`, with `serviceLogs` = `/usr/bin/journalctl` at
  `:254`; `resource.logLinesMax = 500` at `:331`.

**Observed contrast:** `hostServiceLogs` reads the **system** journal for an
arbitrary validated service name (`assertServiceOrContainerName`), has no
`--user`, no `--no-pager`, no unit allowlist, no substring filter, and does not
redact before capping. `host_journal` is narrower: user journal, two-unit
allowlist, window allowlist, literal filter, redact-then-cap. The two tools must
not be conflated.

### Validators — `broker/src/validation.ts`

- `:183-188` — `assertSince`: charset/length guard
  (`^[0-9A-Za-z :.+-]{1,64}$`), **not** a window bound.
- `:190-200` — `assertPositiveInt(value, max, what)`.
- `:202-210` — `assertServiceOrContainerName`: rejects `-`-leading values and
  shell metacharacters.

### Plugin declarations — `opencode/plugins/sandbox-tools.ts`

- `:61` — `READ_ONLY_AGENTS = ["gentle-orchestrator"]`; `:63-67` —
  `assertNotOrchestrator`, used **only** by `sandbox_*` tools, never by host
  tools.
- `:604-637` — `host_review_status`, the read-only declaration to mirror: a
  `tool({...})` with zod args, no `assertNotOrchestrator`, **no `ctx.ask`**, and a
  broker request `c.request("reviewStatus", …)` at `:619`.
- Other read declarations: `host_sdd_status` `:503-522`, `host_review_assess`
  `:555-588`, `host_review_mode_status` `:590-602`,
  `host_review_lens_context` `:639-669`.
- No `host_journal` tool exists. A repo-wide search also finds **no plugin
  declaration** for the fragment's ten `host_*` read names (`host_system`,
  `host_service_status`, `host_service_logs`, …), consistent with manifest §5
  Discrepancy 2 and §8 item 4.

### Permission fragment — `opencode/config-fragments/sandbox-permissions.jsonc`

- `:64-73` — host read-only system tools `allow`, including `host_service_logs`
  at `:66`.
- `:74-81` — host read-only SDD/review tools `allow` (e.g. `host_review_status`
  `:80`).
- `:88-104` — the mutation `ask` block (e.g. `host_git_commit` `:90`).
- No `host_journal` entry.

### Manifest — `docs/config-manifest-host-tools.md`

- `:240-244` — inventory claim: "44 tools: 13 `sandbox_*` and 31 host tools …
  9 read operations (`validation.ts:750-760`) and 22 mutation operations
  (`validation.ts:763-786`)". Observed current code is **7 read + 16 mutation =
  23**; the counts and cited line ranges are stale.
- `:191-206` — §4 ALLOW list (host read tools).
- `:207-221` — §4 ASK list (host mutations).
- `:269-275` — §5a host git inventory; `:346-371` — Discrepancies.
- `:450-477` — fragment merge state (not merged).
- `:716-864` — Appendix A.2 `permission` object.

### Output cap and redaction — `broker/src/gitops.ts`

- `:333` — `GIT_OUTPUT_MAX_BYTES = 512 * 1024`.
- `:335-340` — `capAndRedact`: calls `redact(text)` **first**, then truncates to
  the byte cap. `redact` is imported from `broker/src/logging.ts:31`
  (`gitops.ts:34`).

## Scope

### Reads only

- Fixed argv: `journalctl --user --unit <unit> --since <window> --lines <n>
  --no-pager` — built as an argv array, never a shell string. (`--lines` value is
  a separate argv item; `--no-pager` prevents a pager.)
- Unit allowlist, deliberately small: `secure-opencode.service`,
  `sandbox-broker.service`. Adding a unit is a deliberate code change, never
  caller-supplied; the payload carries a unit, but only a value on this
  allowlist is accepted.
- Bounded `--since` **window** and bounded line count, both validated
  broker-side. `window` is an allowlisted token (proposed:
  `15m` | `1h` | `6h` | `24h`) mapped broker-side to `--since -<token>`; it is
  never a free-form timestamp. `lines` is validated by `assertPositiveInt` with
  the configured `logLinesMax` ceiling (500).
- Optional case-sensitive **literal substring** filter, applied broker-side after
  reading (`line.includes(needle)`), never a caller-supplied regex or shell
  pattern.
- Output: redact first, then cap at the same 512 KiB byte limit the git reads
  use (`GIT_OUTPUT_MAX_BYTES` / `capAndRedact`, `gitops.ts:333-340`).
- Classified `read` in `HOST_READ_OPERATIONS`, so it is open to every agent and
  never calls `ctx.ask`.

### Out of scope

System journal (`--system`), arbitrary unit names, follow mode
(`-f`/`--follow`), vacuum/rotate, export, remote journals, and any write. A
caller cannot reach them: the argv is fixed and the only caller-supplied values
are a unit on the allowlist, an allowlisted window token, a bounded integer, and
a bounded literal filter.

## Constraints

- **Fixed argv vectors only**; no shell string anywhere. The builder is a pure
  helper (mirroring `gitops.ts:347-405`).
- **Read-tier classification**: `hostJournal` is added to
  `HOST_READ_OPERATIONS` (`validation.ts:783-791`) and **never** to
  `HOST_MUTATION_OPERATIONS`; it reaches `HOST_READ_OPEN` in
  `HostToolPolicy.decide` (`:848-850`) and never calls `ctx.ask`.
- **Exact-payload-key allowlist** per operation: add
  `hostJournal: ["unit","window","lines","filter"]` to `ALLOWED_PAYLOAD_KEYS`
  (`validation.ts:866-985`), or the operation is rejected by `assertPayloadKeys`
  (`:987-1006`). No undeclared key is accepted.
- **Unit allowlist is code-owned**, not payload-owned. The handler rejects any
  unit not on the constant list before building argv;
  `assertServiceOrContainerName` (`:202-210`) additionally rejects `-`-leading
  values, so a unit can never inject a flag such as `--system` or `-f`.
- **Bounded output**: reuse `GIT_OUTPUT_MAX_BYTES` (512 KiB, `gitops.ts:333`) and
  `capAndRedact` (`:335-340`) — redact first, then cap. Do not duplicate the
  redaction logic.
- **No new credentials and no network.** The tool only spawns the fixed local
  `journalctl` binary.
- **Broker stays dependency-free** (`bun:test` + node builtins only).
- **Every new operation appears in both the fragment and the manifest in the same
  change unit** — never one without the other.
- **S17.** `broker/src/**`, `opencode/plugins/**`,
  `opencode/config-fragments/**`, and `docs/threat-model.md` are S17: agent
  changes are reviewed and installed by the user, never auto-applied.
- **No deploy, mirror to `~/.config`, service restart, or commit by the agent.**
- **Design note (overlap):** the parallel `hostread` tier already exposes
  `hostServiceLogs` (system journal, arbitrary unit). `host_journal` is a
  separate, narrower read-tier tool. Consolidation (extending `hostServiceLogs`)
  is a possible alternative but changes that tool's semantics and is out of scope
  here; confirm before T1 if the user prefers consolidation.

## Tasks

Stable IDs; each task is a reviewable change unit.

### T1 — Tool + broker operation + fixed argv builder

Add the plugin `host_journal` declaration, the `hostJournal` `Operation` union
entry and `OPERATIONS` member, the `server.ts` dispatch case, the read handler,
and the pure fixed-argv builder.

- Files: `opencode/plugins/sandbox-tools.ts`, `broker/src/types.ts`,
  `broker/src/server.ts`, `broker/src/service.ts`, new `broker/src/journal.ts`
  (argv builder; may import `capAndRedact`).
- Done when: `hostJournal` produces exactly
  `[binary, "--user", "--unit", unit, "--since", "-<window>", "--lines", n,
  "--no-pager"]` for allowlisted inputs, with no `--system`, no `-f`, and no
  shell string.

### T2 — Validation and authorization

Payload allowlist, read classification, and the unit/window/lines bounds.

- Files: `broker/src/validation.ts`, `broker/src/service.ts`,
  `broker/src/journal.ts`.
- Done when: `hostJournal` is in `HOST_READ_OPERATIONS` and absent from
  `HOST_MUTATION_OPERATIONS`; its payload keys are exactly declared; unlisted
  units, non-allowlisted windows, out-of-range line counts, and undeclared keys
  are all refused.

### T3 — Tests

Fixed argv; refusals (system journal, unlisted unit, follow mode, mutation
attempts); window and line bounds; redaction then cap; read-tier no-prompt
behaviour. Capture RED→GREEN.

- Files: `broker/tests/journal.test.ts` (new, argv/refusals/bounds), plus
  additions to `broker/tests/validation.test.ts` and
  `broker/tests/service-host-tools.test.ts`.
- Done when: RED→GREEN is captured for the new assertions and the existing suite
  stays green.

### T4 — Docs and configuration

Fragment read entry, manifest inventory and counts, threat model if the boundary
warrants it.

- `opencode/config-fragments/sandbox-permissions.jsonc`: add
  `host_journal: "allow"` in the read tier (`:64-81`).
- `docs/config-manifest-host-tools.md`: add the tool to §4 ALLOW (`:191-206`),
  add an inventory entry, and correct the stale counts at `:240-244`.
- `docs/threat-model.md`: update the host-read boundary only if warranted (S17).
- Done when all three documents match the implemented surface.

### T5 — Evidence and readback

Verify the implemented surface against the fragment and the manifest; record the
journal round-trips this replaces.

- Done when: the fragment entry, manifest entry, and the shipped code
  (`HOST_READ_OPERATIONS`, `ALLOWED_PAYLOAD_KEYS`, dispatch, builder) agree, and
  the evidence records the manual `journalctl` round-trips this tool removes.

## Acceptance criteria

1. An agent reads a bounded journal slice for an allowlisted unit with no prompt.
2. `--system`, unlisted units, follow mode, and every mutation are refused.
3. Output is redacted first, then capped at 512 KiB.
4. No undeclared payload key is accepted.
5. Every new operation appears in both the fragment and the manifest in the same
   change unit.
6. Tests cover argv, refusals, bounds, and the read-tier no-prompt behaviour; the
   existing suite stays green.
7. No read tool calls `ctx.ask`; no read operation is added to
   `HOST_MUTATION_OPERATIONS`.

## Checks

- `bun --cwd broker test` (all suites green; RED→GREEN captured for new
  assertions). Note: `sandbox_bash`'s `cwd` is broken, so always use the `--cwd`
  form.
- `bun build broker/src/main.ts --outfile <tmp path>` (always pass `--outfile`;
  compiles; dependency-free constraint holds).
- Argv inspection for `hostJournal`: exact fixed vector; no `--system`, no
  `-f`/`--follow`, no shell string.
- Fragment/manifest readback against the implemented operation set.
- A read-tier no-prompt check: `host_journal` runs without `ctx.ask`.
- S17 files are reviewed and installed by the user; the agent does not apply
  them.

## Authorized scope

Authorized: implement T1–T5 as reviewable change units under the ODD work-unit
rule, with sandbox-only mutation, after a separate apply phase is explicitly
launched.

Not authorized by this tracker: deployment, mirroring to `~/.config`, service
restart, or commit/push/PR/merge/release; and any change that weakens a
permission. S17 files (`broker/src/**`, `opencode/plugins/**`,
`opencode/config-fragments/**`, `docs/threat-model.md`) are reviewed and
installed by the user, never auto-applied.

This tracker's creation is the only authorized output of the creating session;
no feature code, deploy, mirror, restart, or commit was performed.

## Delivery strategy

- Delivery strategy: `ask-on-risk`. Forecast at tracker creation: the change
  spans one plugin tool, one operation, a handler, a pure argv builder, a
  validator set, a test file, and three documents — plausibly 250–450 authored
  lines across units. Recompute from work-unit commits; when the running total
  crosses ~400 authored lines, apply the chosen strategy before the next commit.
- Chain strategy: `stacked-to-main` (the user's standing choice). Each unit lands
  on the default branch in order as its own reviewable slice.
- Likely slices (confirm at implementation time): Slice 1 = T1 + T2 + their
  T3/T4/T5 parts. This is a single narrow read tool, so a single slice is likely
  sufficient.

## Progress

| Task | Status  | Notes |
|------|---------|-------|
| T1   | pending | Not started. Tool + operation + handler + argv builder. |
| T2   | pending | Not started. Validation and authorization. |
| T3   | pending | Not started. Tests. |
| T4   | pending | Not started. Fragment, manifest, threat model. |
| T5   | pending | Not started. Evidence and readback. |

## Evidence

- Tracker created: `odd/tasks/host-journal-tool.md` (this file).
- Verified read-only in this session (2026-09-19):
  - `broker/src/validation.ts:783-791` — `HOST_READ_OPERATIONS` (7, no journal).
  - `broker/src/validation.ts:794-811` — `HOST_MUTATION_OPERATIONS` (16).
  - `broker/src/validation.ts:813-819` — `hostToolAccess`.
  - `broker/src/validation.ts:832-860` — `HostToolPolicy.decide`; read open at
    `:848-850`.
  - `broker/src/validation.ts:866-985` — `ALLOWED_PAYLOAD_KEYS`;
    `:987-1006` — `assertPayloadKeys`.
  - `broker/src/validation.ts:183-210` — `assertSince`, `assertPositiveInt`,
    `assertServiceOrContainerName`.
  - `broker/src/types.ts:35-99` — `Operation`; `:102-155` — `OPERATIONS`.
  - `broker/src/server.ts:342-438` — dispatch; `:391-392` reviewStatus; `:436`
    default `buildHostOp`.
  - `broker/src/service.ts:147-163` — `authorizeHostDispatch`;
    `:2145-2157` — `buildHostOp`.
  - `broker/src/sdd-service.ts:122-138` — `buildReviewStatusOp` (mirror).
  - `broker/src/hostread.ts:29-75`, `:102-177` — parallel host-read tier;
    `hostServiceLogs` at `:70`.
  - `broker/src/config.ts:63-75`, `:247-259` (`serviceLogs` `/usr/bin/journalctl`
    `:254`), `:331` (`logLinesMax` 500).
  - `opencode/plugins/sandbox-tools.ts:61-67` — `READ_ONLY_AGENTS` /
    `assertNotOrchestrator`; `:604-637` — `host_review_status`; `:503-669` —
    other read declarations. No `host_journal`.
  - `opencode/config-fragments/sandbox-permissions.jsonc:64-81` — host read
    allow tier; `:88-104` — mutation ask block.
  - `docs/config-manifest-host-tools.md:240-244` — stale counts; `:191-206` —
    ALLOW list; `:207-221` — ASK list; `:269-275` — §5a; `:346-371` —
    Discrepancies; `:450-477` — merge state.
  - `broker/src/gitops.ts:333` — `GIT_OUTPUT_MAX_BYTES`; `:335-340` —
    `capAndRedact`; `broker/src/logging.ts:31` — `redact`.
- Reported by the user (not reproduced here): during the reviewer-relay debugging
  session the orchestrator made roughly a dozen manual `journalctl` round-trips
  against `secure-opencode.service` and `sandbox-broker.service`.
- Observed delivery constraint: `sandbox_bash`'s `cwd` is broken (use `--cwd`);
  `bun build` needs `--outfile`.

## Next step

T1 — add the `host_journal` tool, the `hostJournal` operation, the read handler,
and the pure fixed-argv builder, mirroring the `reviewStatus` read tier. Confirm
the S17 review path, and confirm the user's preference on the `hostServiceLogs`
overlap, before any apply.
