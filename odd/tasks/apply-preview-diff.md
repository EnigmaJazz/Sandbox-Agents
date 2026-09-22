# ODD Tasks — apply-preview-diff

- **Feature:** `apply-preview-diff`
- **Project:** `sandbox-integration` (`/home/james/agent-sandbox-integration`)
- **Status:** T1–T3 installed (broker-owned plain and ANSI artifacts + the fail-closed approval guard); T4 (docs) and T5 (post-install readback) pending.
- **Created:** 2026-09-19
- **Delivery strategy:** `ask-on-risk`
- **Chain strategy:** `stacked-to-main` (the user's standing choice)

## Objective

Make the B→C apply preview reviewable outside the terminal. Emit the
**complete** worker baseline-to-result (B→C) diff as a **plain,
editor-friendly file** — no escape sequences — at a stable, non-tracked path,
and surface that path in the `sandbox_apply` approval metadata so a reviewer can
open it in an editor. Provide a separate, explicit **ANSI-coloured rendering
option** for terminal use. Keep the bounded in-prompt preview exactly as it is
today.

## Problem / context

The `sandbox_apply` approval prompt shows a **bounded** preview of the worker's
B→C diff, with an explicit truncation marker. The user reviews approval prompts
by reading the actual diff content, not line-count statistics; a truncated
prompt preview means the full delta can only be inspected in a terminal.

Two consumers need two different renderings of the same diff:

- an **editor** renders a plain unified diff with syntax highlighting — ANSI
  escape sequences inside the file break that rendering; and
- a **terminal** pager consumes ANSI colour.

A file artifact and a colour option are therefore two different consumers, not
one. The current implementation partially exists but conflates them (see
`Verified current surface`): it already writes the full diff to a file, but that
file lives in the OS temp dir and is colourised with ANSI escapes, so it is
neither stable nor editor-friendly.

### Relationship to the open finding `R4-apply-preview-bypass`

The user cites the open finding **`R4-apply-preview-bypass`** (BLOCKER,
resilience lens) with the text:

> "Large apply results are now executed despite the human preview being
> truncated, so approval cannot inspect the complete B→C delta"
> (`broker/src/service.ts:1559-1563`).

Observed (this session): the cited range `broker/src/service.ts:1559-1563` is
the `releaseWorker` comment plus the start of the `APPLIED` return object — it
does **not** contain the finding text verbatim, so the finding's line reference
is stale relative to the current file. The finding's **substance** is nonetheless
consistent with the code: the apply path (`buildApplyResultOp`) has **no**
`maxApplyDiffLines` gate. A repo search finds `maxApplyDiffLines` only in
`broker/src/copy-review.ts:59-63` (whole-file `copy_out` review limit) and
`broker/src/main.ts:133-137` (config wiring); it is absent from the apply path.

This tracker is about **how the delta is presented for review** — it does not
change what is applied. It is adjacent to, but not a fix for, that finding: this
tracker makes the *complete* delta inspectable in a file, while the finding is
that execution is not gated on the preview being complete. The two must be
reconciled when the finding is fixed, and neither substitutes for the other.

The standing boundary still applies: **`sandbox_apply` must not proceed when the
complete B→C preview cannot be shown.** This tracker improves presentation; it
does not relax that boundary.

## Verified current surface (file:line)

Read-only observations from this session (2026-09-20) against the current files.

### Apply-preview construction and truncation — `broker/src/service.ts`

- `:1152-1153` — `/** Bounded line cap for the apply-approval preview text. */`
  and `export const APPLY_PREVIEW_MAX_LINES = 400;`.
- `:1155-1162` — `ApplyPreview` interface: `files`, `addedLines`, `removedLines`,
  `totalLines`, `preview`, `previewTruncated`.
- `:1164-1187` — `buildApplyPreview(diff)`. Counts `diff --git` / `+` / `-`
  lines (`:1175-1179`); `previewTruncated = totalLines > APPLY_PREVIEW_MAX_LINES`
  (`:1181`); `shown = lines.slice(0, APPLY_PREVIEW_MAX_LINES)` (`:1182`); the
  truncation marker at `:1184` is
  `(... preview truncated: showing 400 of <N> lines; see previewFile for the full diff)`.
  Note the marker text names `previewFile`; the broker object returned here does
  **not** itself carry that field — the plugin supplies it (below).
- `:1265-1274` — active `buildDiffOp` return; `applyPreview: buildApplyPreview(
  compare.trim().length > 0 ? compare : diff.stdout)` at `:1269`. This is the
  preview the `sandbox_apply` tool consumes.
- `:1659-1667` — `buildRetainedDiff` return; **no `applyPreview` field** (the
  retained diff surface is unbounded and un-summarised).
- `:1510-1529` — apply path: builds `patchFile = patchPathFor(stateDir,
  req.sessionID)` (`:1511`), runs `git diff <baseline> <result> -- .` (`:1512-1518`),
  `mkdirSync(.../patches, 0o700)` (`:1525-1528`), writes the **complete plain**
  `patch.stdout` to `patchFile` with mode `0o600` (`:1529`). So a complete,
  plain B→C diff already exists broker-side — but only **at apply time**, after
  the approval prompt has already been answered.
- `:1562-1567` — `buildApplyResultOp` success return:
  `applyPreview: buildApplyPreview(patch.stdout)`.
- `:1433-1533` — `buildApplyResultOp` gate order: `confirm: "APPLY"` (`:1436`),
  state must be `RESULT_READY` (`:1440`), S16 host-divergence refusal
  (`:1458-1468`), changed-path/protected-path rejection (`:1470-1488`), unsafe
  symlink/submodule rejection (`:1496-1508`), then diff + `git apply --check` +
  `git apply` (`:1510-1553`). **No line-count gate on apply** (see finding note).

### Configured preview/apply line limit — `broker/src/config.ts`

- `:39-40` — `/** Max B->C patch lines an apply may carry (approval preview
  limit). */ maxApplyDiffLines: number;`.
- `:320` — default `maxApplyDiffLines: 200`.
- `:285-288` — `stateDir = resolve(process.env.BROKER_STATE_DIR ??
  join(homedir(), ".local", "state", "opencode-sandbox"))` — the broker's
  state area lives **outside** the worktree.

### `sandbox_apply` tool and its `ctx.ask` metadata — `opencode/plugins/sandbox-tools.ts`

- `:369-431` — `sandbox_apply` declaration (`args: {}`). Its `execute`:
  - `assertNotOrchestrator(ctx.agent, "sandbox_apply")` (`:378`);
  - if worker state is not `RESULT_READY`, calls `prepareResult` (`:380-383`);
  - requests the broker `diff` op with `{ mode: "active" }` (`:384`);
  - `rawPreview = ((diffRes.compare ?? "").trim() ? diffRes.compare : diffRes.diff) ?? ""`
    (`:399`);
  - `previewFile = join(tmpdir(), \`sandbox-apply-${ctx.sessionID}.diff\`)`
    (`:400`);
  - `writeFileSync(previewFile, coloriseDiff(rawPreview), { mode: 0o600 })`
    (`:401`) — i.e. the file is written **with ANSI colour**;
  - builds `metadata` from `diffRes.applyPreview`, adding `previewFile` as a
    field (`:405-422`); the fallback shape (older broker) also carries
    `previewFile` and `previewTruncated: true` (`:417-422`);
  - `await ctx.ask({ permission: "sandbox_apply", patterns: ["*"], always: [],
    metadata })` (`:423-428`).
- `:344-354` — `sandbox_diff` tool: read surface, `assertNotOrchestrator`,
  no `ctx.ask`; requests broker op `diff` with `{}` (`:352`), formatted by
  `formatResult("diff", …)`. The broker operation behind it is `buildDiffOp`
  (`broker/src/service.ts:1189`); with the default `mode: "active"` it runs
  `git diff <baselineRef> HEAD` **inside the worker** (`:1198-1210`), and
  retained mode delegates to `buildRetainedDiff` (`:1196`).
- `:69-84` — **existing ANSI emitter**: `coloriseDiff(diff)`. `reset = "\x1b[0m"`;
  `diff --git` / `---` / `+++` → bold `\x1b[1m`; `@@` → cyan `\x1b[36m`;
  `+` → green `\x1b[32m`; `-` → red `\x1b[31m`. This is the only ANSI-diff
  renderer and it is currently applied unconditionally to `previewFile`.
- `:27-30` — imports `writeFileSync` (`node:fs`, `:28`), `tmpdir`
  (`node:os`, `:29`), `join` (`node:path`, `:30`).
- `:175-199` — `formatResult`; `case "diff"` returns the raw `diff` string if
  non-empty, else `stat`, else the JSON payload (`:193-199`).

### Existing complete-diff storage and non-tracked state

- `broker/src/gitops.ts:324-326` — `patchPathFor(stateDir, sessionID) =
  join(stateDir, "patches", \`${sessionID}.patch\`)`. Deterministic per session,
  plain, `0600`, but written only at apply time.
- `broker/src/gitops.ts:35-46` — `BASELINE_REF_PREFIX =
  "refs/opencode-sandbox/baseline"`, `RESULT_REF_PREFIX =
  "refs/opencode-sandbox/result"`, `baselineRef(sessionID)`, `resultRef(sessionID)`.
  Result/baseline refs are stored as git refs (non-tracked; never on a branch).
- `.git/gentle-ai/` — **exists** and is the established per-project non-tracked
  state area. Observed children: `rate-limit-fallback.log`,
  `review-transactions/` (contains `v2/`), `rejected-results/` (contains
  `review-16583a1b7bc565ef/`, `review-6b89495c07831ddb/`), `sdd-runtime/`,
  `REVIEW-MAINTENANCE.lock`. Nothing under `.git/` can be tracked by git, so
  this is a safe artifact location.
- `.gitignore:8-14` — ignores `*.log`, `*.jsonl`, `.sandbox-state/`,
  `broker/.sandbox-state/`; it does **not** list `.git/gentle-ai/**` because
  `.git/**` is never tracked regardless.

### Colour / redaction helpers

- `broker/src/gitops.ts:332-340` — `GIT_OUTPUT_MAX_BYTES = 512 * 1024` (`:333`)
  and `capAndRedact(text, maxBytes)` (`:336-340`): calls `redact(text)` **first**
  (`:337`), then truncates to the byte cap. `redact` is imported from
  `broker/src/logging.ts:31` (`gitops.ts:34`).
- `broker/src/logging.ts:27-37` — `SECRET_VALUE_RE`
  (`token|secret|password|credential|api[_-]?key|authorization` assignments) and
  `redact(text)` replacing the value with `REDACTED`. No ANSI handling.
- **Existing ANSI:** only `coloriseDiff` (`opencode/plugins/sandbox-tools.ts:69-84`).
  No broker-side module emits ANSI, and `redact`/`capAndRedact` do not strip it.

### S17 / apply-boundary checks (unchanged by this tracker)

- `broker/src/service.ts:1470-1488` — protected-security-path rejection (S17:
  `broker/src/**`, nono/systemd, `opencode/plugins/**`,
  `opencode/config-fragments/**`, `scripts/**`, `tests/security/**`,
  `tests/acceptance/**`, `docs/threat-model.md`).
- `broker/src/service.ts:1496-1508` — symlink/submodule rejection.
- `broker/src/service.ts:1510-1541` — `git apply --check` then `git apply`,
  fixed argv vectors via `buildCheckArgv` (`broker/src/gitops.ts:317-322`).

## Scope

### In scope

- Write the **complete** B→C diff to a stable, **non-tracked** path — a
  `.git/gentle-ai/**` location (proposed) or the broker's state area — never a
  tracked project path. Atomic write; deterministic name per applied result.
- Surface that path in the `sandbox_apply` approval metadata so the reviewer can
  open it in an editor.
- An explicit **colour option** producing ANSI-coloured output for terminal
  rendering, opt-in and never the default for the file.
- Keep the in-prompt preview bounded **exactly** as it is today
  (`APPLY_PREVIEW_MAX_LINES = 400`, truncation marker unchanged).

### Out of scope

- Changing what is applied, the S17 checks, the changed-path derivation, or the
  diff content.
- Colour codes inside the plain file artifact.
- Any new credential exposure in the diff or its path.
- Fixing `R4-apply-preview-bypass` (the apply-size/preview-completeness gate);
  this tracker only changes presentation. The two are reconciled separately.

## Constraints

- **Fixed argv vectors only**, never a shell string (diff/ref commands as argv
  arrays, mirroring the existing `ctx.git.spawn([...])` calls).
- **Deterministic, atomic writes**: write to a temp file in the same directory
  then `rename` into place; `0600`; name derived from the session/result ref.
- **Non-tracked artifact**: the path must be under `.git/**` or the broker
  state dir; it must never be staged or committed. Prefer `.git/gentle-ai/`,
  which is already the per-project state area.
- **No secrets in the artifact**: reuse `capAndRedact`/`redact`
  (`broker/src/gitops.ts:336-340`, `broker/src/logging.ts:31`); do not duplicate
  the redaction logic. **Superseded (2026-09-20) — see the deviation note in
  `Implementation result` below: the artifact is written raw.**
- **The plain artifact must contain no escape sequences** (`\x1b[...`).
- **The coloured rendering must be opt-in** and never the default for the file.
- **S17**: `broker/src/**`, `opencode/plugins/**`,
  `opencode/config-fragments/**`, and `docs/threat-model.md` are reviewed and
  installed by the user, never auto-applied.
- **No deploy, mirror to `~/.config`, service restart, or commit by an agent.**
- **Broker stays dependency-free** (`bun:test` + node builtins only).

## Tasks

Stable IDs; each task is a reviewable change unit.

### T1 — Plain full-diff artifact

Write the complete B→C diff to the non-tracked path, atomically, and surface the
path in the `sandbox_apply` approval metadata.

- Decisions: location `.git/gentle-ai/apply-preview/<sessionID>.diff`
  (proposed) with the broker state dir as the alternative; whether the broker or
  the plugin owns the write. The broker already produces the complete plain diff
  (`service.ts:1512-1529`); if the broker writes it at apply time, the plugin
  must be able to surface the path in the **pre-apply** `ctx.ask` metadata, so a
  broker-side preview-write hook or a plugin-side write from the `diff` op
  response is required.
- Done when: after prepare/finish, the complete plain B→C diff exists at the
  stable non-tracked path and the approval metadata carries that path.

### T2 — Colour option

Opt-in ANSI rendering for terminal display, leaving the file artifact plain.

- Files: `opencode/plugins/sandbox-tools.ts` (reuse `coloriseDiff`, `:69-84`;
  add an explicit option rather than applying it unconditionally at `:401`).
- Done when: colour is emitted only when requested and is never written to the
  file artifact; the default file is plain.

### T3 — Tests

- The artifact contains the complete diff with **no** escape sequences.
- The colour option emits ANSI and only when requested.
- The truncation marker and the bounded prompt preview are unchanged
  (`buildApplyPreview`, `APPLY_PREVIEW_MAX_LINES = 400`).
- The artifact path never appears as a tracked change.
- Files: additions to `broker/tests/` (a preview/artifact suite) and any plugin
  test surface. Done when RED→GREEN is captured and the existing suite stays
  green.

### T4 — Docs and configuration

Fragment/manifest and operator documentation for the new artifact and option.

- Done when the fragment/manifest and operator docs describe the artifact path
  and the colour option, and match the implemented surface.

### T5 — Evidence and readback

Confirm the surface matches the documentation, and record how the artifact
behaves for a truncated preview.

- Done when: the implemented path, the metadata field, and the docs agree, and
  the evidence records the artifact for a diff larger than
  `APPLY_PREVIEW_MAX_LINES`.

## Acceptance criteria

1. After a prepare/finish, the complete B→C diff exists as a plain file at a
   non-tracked path, and the approval surfaces that path.
2. Opening the file in an editor shows a clean unified diff with no escape
   sequences.
3. A colour option renders ANSI for the terminal; it is never applied to the
   file artifact.
4. The in-prompt preview stays bounded and keeps its truncation marker.
5. Nothing about the applied result, the S17 checks, or the changed-path
   derivation changes.
6. The artifact never appears as a tracked or staged change.
7. Tests cover the above; the existing suite stays green.

## Checks

- `bun --cwd broker test` (all suites green; RED→GREEN captured for new
  assertions). Note: `sandbox_bash`'s `cwd` is broken, so always use the
  `--cwd` form.
- `bun build broker/src/main.ts --outfile <tmp path>` (always pass `--outfile`;
  compiles; dependency-free constraint holds).
- Artifact content check: the complete diff is present and contains no
  `\x1b` escape sequences.
- Colour option check: ANSI is emitted only when requested; the default file
  has none.
- Bounded-preview check: `APPLY_PREVIEW_MAX_LINES = 400` and the truncation
  marker are unchanged; `buildApplyPreview` output is byte-identical for a
  fixed diff.
- Readback that the artifact is **untracked**: `git status --porcelain` shows
  no entry for the artifact path, and `git ls-files <artifact path>` is empty.
- S17 files are reviewed and installed by the user; the agent does not apply
  them.

## Authorized scope

Authorized: implement T1–T5 as reviewable change units under the ODD work-unit
rule, with sandbox-only mutation, after a separate apply phase is explicitly
launched.

Not authorized by this tracker: deployment, mirroring to `~/.config`, service
restart, or commit/push/PR/merge/release; and any change that weakens a
permission or an S17 check. S17 files (`broker/src/**`,
`opencode/plugins/**`, `opencode/config-fragments/**`, `docs/threat-model.md`)
are reviewed and installed by the user, never auto-applied.

This tracker's creation is the only authorized output of the creating session;
no feature code, deploy, mirror, restart, or commit was performed.

## Delivery strategy

- Delivery strategy: `ask-on-risk`. Forecast at tracker creation: the change
  spans the plugin preview path (`opencode/plugins/sandbox-tools.ts`), possibly
  a broker write hook (`broker/src/service.ts` / `broker/src/gitops.ts`), a test
  suite, and fragment/manifest plus operator docs — plausibly 200–400 authored
  lines across units. Recompute from work-unit commits; when the running total
  crosses ~400 authored lines, apply the chosen strategy before the next commit.
- Chain strategy: `stacked-to-main` (the user's standing choice). Each unit
  lands on the default branch in order as its own reviewable slice.
- Likely slices (confirm at implementation time): Slice 1 = T1 + T2 + their
  T3/T4/T5 parts, since the plain artifact and the colour option are the two
  halves of one presentation change. Confirm the artifact-location decision
  (`.git/gentle-ai/**` vs broker state dir) before T1.

## Implementation result (2026-09-20) — installed (2026-09-22)

T1, T2 and T3 are DONE (implemented and verified in the sandbox). T4 (docs) and
T5 (post-install readback) remain pending.

- **Result (installed 2026-09-22):** `refs/opencode-sandbox/result/ses_f4184a893ffe1h0mHlXInJJ6q6`.
  S17 refused apply with `result touches protected paths (S7/S17):
  broker/src/gitops.ts, broker/src/service.ts, opencode/plugins/sandbox-tools.ts`.
- **Files:**
  - `broker/src/gitops.ts` — new `applyPreviewPathFor` and
    `applyPreviewAnsiPathFor`, plus the single `coloriseDiff` renderer.
  - `broker/src/service.ts` — new `ApplyPreviewFiles`, `writeFileAtomic`, and
    `writeApplyPreviewFiles`; `buildDiffOp` now returns `applyPreviewFiles`.
  - `opencode/plugins/sandbox-tools.ts` — the tmpdir write and the duplicate
    `coloriseDiff` are removed; metadata now carries `previewFile` and
    `previewAnsiFile`.
  - new `broker/tests/apply-preview.test.ts` (239 lines); modified
    `broker/tests/service-diff.test.ts`.
- **Decision made:** the broker owns the write. Location is
  `<stateDir>/apply-preview/<sessionID>.diff` (plain) and
  `<sessionID>.ansi.diff` (ANSI); directory `0700`, files `0600`, atomic
  temp-then-rename, outside the worktree. The project-local `.git/gentle-ai/**`
  option remains open.

### Deliberate deviation — the artifact is written raw

The constraint "no secrets in the artifact: reuse `capAndRedact`/`redact`" is
**superseded** for this artifact: the plain B→C diff is written **raw**, because
redacting the human's own diff under review would corrupt it — redaction mutates
the exact bytes the reviewer must approve. The precedent is the existing
`patches/<sessionID>.patch`, which is likewise written raw. This is a deliberate,
recorded deviation from the tracker constraint, not an oversight.

### Remaining and risks

- T4 docs — note that no tool or parameter surface changed, so the permission
  fragment is likely unchanged.
- T5 readback after install; until then the surface is unverified against a
  running broker.
- The plugin now yields `previewFile: undefined` if an older broker omits
  `applyPreviewFiles` (the bounded preview is still present).
- Retained-mode diffs do not emit artifacts.

## Progress

| Task | Status  | Notes |
|------|---------|-------|
| T1   | installed | Plain full-diff artifact + metadata path. Broker owns the write at `<stateDir>/apply-preview/<sessionID>.diff`; `applyPreviewFiles` in the diff op; `previewFile` in the approval metadata. |
| T2   | installed | Opt-in ANSI colour. `<sessionID>.ansi.diff`; single `coloriseDiff` in the writer; the plugin temp write is gone. |
| T3   | installed | Tests. RED 8 fail / 8 → GREEN 8 / 0; new `broker/tests/apply-preview.test.ts`; `broker/tests/service-diff.test.ts` updated. |
| T4   | pending | Docs. No tool or parameter surface changed, so the permission fragment is likely unchanged. |
| T5   | pending | Post-install readback. The surface is unverified against a running broker until install. |

## Evidence

- Tracker created: `odd/tasks/apply-preview-diff.md` (this file).
- Verified read-only in this session (2026-09-20):
  - `broker/src/service.ts:1152-1162` — `APPLY_PREVIEW_MAX_LINES = 400`,
    `ApplyPreview` shape.
  - `broker/src/service.ts:1164-1187` — `buildApplyPreview`; truncation at
    `:1181-1184`; marker names `previewFile`.
  - `broker/src/service.ts:1189-1276` — `buildDiffOp`; active return with
    `applyPreview` at `:1269`.
  - `broker/src/service.ts:1433-1568` — `buildApplyResultOp`; diff write at
    `:1512-1529`; success return at `:1562-1567`; **no apply-size gate**.
  - `broker/src/service.ts:1637-1668` — `buildRetainedDiff`; no `applyPreview`.
  - `broker/src/config.ts:39-40`, `:320` — `maxApplyDiffLines` (default 200);
    `:285-288` — `stateDir` outside the worktree.
  - `opencode/plugins/sandbox-tools.ts:369-431` — `sandbox_apply`; `diff` request
    `:384`; `previewFile` in `tmpdir()` `:400`; colourised write `:401`;
    metadata `:406-422`; `ctx.ask` `:423-428`.
  - `opencode/plugins/sandbox-tools.ts:344-354` — `sandbox_diff`; broker op
    `diff` `:352`.
  - `opencode/plugins/sandbox-tools.ts:69-84` — `coloriseDiff` (existing ANSI).
  - `opencode/plugins/sandbox-tools.ts:27-30` — `writeFileSync`, `tmpdir`,
    `join` imports; `:175-199` — `formatResult` `diff` case.
  - `broker/src/gitops.ts:35-46` — baseline/result refs; `:317-326` —
    `buildCheckArgv`, `patchPathFor`; `:332-340` — `GIT_OUTPUT_MAX_BYTES`,
    `capAndRedact`.
  - `broker/src/logging.ts:27-37` — `SECRET_VALUE_RE`, `redact`.
  - `.git/gentle-ai/` — observed non-tracked state area: `rate-limit-fallback.log`,
    `review-transactions/v2/`, `rejected-results/review-*/`, `sdd-runtime/`,
    `REVIEW-MAINTENANCE.lock`.
  - `broker/src/copy-review.ts:59-63` and `broker/src/main.ts:133-137` — the
    only `maxApplyDiffLines` consumers (copy_out review limit; config wiring);
    absent from the apply path.
- Finding reference (provided by the user, not located as a persisted artifact
  in this repo): `R4-apply-preview-bypass` (BLOCKER, resilience lens). The
  cited range `broker/src/service.ts:1559-1563` was observed to be the
  `releaseWorker` comment plus the start of the `APPLIED` return object, so the
  finding's line reference is stale; its substance (no apply-size gate) holds.
- Observed delivery constraint: `sandbox_bash`'s `cwd` is broken (use `--cwd`);
  `bun build` needs `--outfile`.
- Implementation evidence (2026-09-20, sandbox):
  - RED capture: 8 fail / 8 — missing `applyPreviewFiles`, undefined
    `coloriseDiff`, plugin metadata unwired.
  - GREEN: 8 pass / 0 fail for the new suite; full suite **442 pass / 0 fail**
    against a **434** baseline.
  - `bun build` succeeds for both the broker bundle and the plugin bundle.
  - Files: `broker/src/gitops.ts` (`applyPreviewPathFor`,
    `applyPreviewAnsiPathFor`, single `coloriseDiff`); `broker/src/service.ts`
    (`ApplyPreviewFiles`, `writeFileAtomic`, `writeApplyPreviewFiles`,
    `buildDiffOp` returning `applyPreviewFiles`); `opencode/plugins/
    sandbox-tools.ts` (tmpdir write and duplicate `coloriseDiff` removed;
    metadata carries `previewFile` + `previewAnsiFile`); new
    `broker/tests/apply-preview.test.ts` (239 lines); modified
    `broker/tests/service-diff.test.ts`.
  - Result retained, not installed:
    `refs/opencode-sandbox/result/ses_f4184a893ffe1h0mHlXInJJ6q6`. S17 refused
    apply with `result touches protected paths (S7/S17): broker/src/gitops.ts,
    broker/src/service.ts, opencode/plugins/sandbox-tools.ts`.

## Next step

Installed (2026-09-22): the broker-owned plain/ANSI artifacts and the fail-closed
approval guard are committed and installed. T5 — the post-install readback of the
implemented path, the metadata field,
and the docs.
