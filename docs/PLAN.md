## Brief — host review pipeline tools for the secure OpenCode orchestrator

Source: brief from a secure-opencode session whose repo of record was
`/home/james/ai-workspace/tasker/tesla`. Captured in substance; the tool names below are
proposals, not existing operations.

### Observed failure (one real run)

`ce:review` over `593ffd9..7564788` (3,112 changed lines, 26 files) degraded on four axes:

| Gap | Evidence |
|---|---|
| Diff obtained only by brute force | 4 worker delegations; 2 of 3 diff returns truncated in transit (~16 KB / ~26 KB), spilled to a host path no other session could read |
| Reviewers had no diff | 7 of 7 reviewers returned DIFF_UNAVAILABLE — they reviewed current file contents only, so `pre_existing` attribution was unverified |
| Packaged pipeline never ran | `ensure-ignore.mjs` and `validate-review.mjs` (screen/prepare/merge/finalize/artifact) are node scripts outside the sandbox allowlist |
| Run artifact never written | `.context/systematic/ce-review/<runId>/review-summary.json` — the orchestrator has no write surface |

Adjacent: `git rev-parse` was unavailable, so branch/ref facts came from hand-reading
`.git/HEAD`, `.git/refs/**`, `.git/packed-refs`.

### Root causes

- **RC1** — no non-mutating way to obtain a git range as data.
- **RC2** — no shared scratch surface: a file written by one worker session is invisible to the
  next, so a diff fetched once cannot be reused by N reviewers.
- **RC3** — no execution surface for the bundled helpers (structural admission and
  deterministic merge must not be done by hand).
- **RC4** — no artifact write surface.

### Proposed fixed host tools

1. `host_git_range_materialize` — read-only wrt project state; writes only into the ignored run
   dir. Params: `baseRef` (required), `headRef=HEAD`, `mode: committed|workspace`,
   `contextLines=3`, `paths[]`, `runId`. Fixed `git -C <canonical-root>` argv; refuses
   unresolvable refs rather than falling back. Writes `scope.diff`, `scope.index.json`
   (base/head shas, commits, changed paths, per-file added/deleted, untracked) and optional
   `slices/<n>.diff`. Returns only the bounded index, never the diff inline.
2. `host_review_pipeline_run` — approval-gated. Params: `phase:
   ensure-ignore|screen|prepare|merge|finalize|artifact`, `reviewer?`, `harness?`,
   `inputPath`, `runId`. Resolves the installed helper by path, fixed argv, stdin from a
   project-relative path, stdout captured under the run dir and returned as a bounded summary.
3. `host_review_artifact_write` — approval-gated. Params: `runId`, `contentPath|content`,
   `filename: "review-summary.json"`. Atomic temp-file + rename, owner-only perms, refuses any
   path outside `.context/systematic/ce-review/<runId>/`.
4. `host_git_read` — read-only, optional. Allowlisted `rev-parse|merge-base|status|log|
   ls-files|for-each-ref`, bounded output.

### Boundaries (non-negotiable)

Typed params only, fixed argv, canonical project root only — no arbitrary shell, and no
push/commit/checkout/fetch/`--ext-diff`/external diff drivers. Writable roots are exactly two,
both verified gitignored and never assumed: the `ce:review` run dir and `.atl/review/**`.
Tool 1 is read-only wrt refs so it needs no approval; tools 2–3 are ask-gated to
`gentle-orchestrator` only. Reviewers must not be given bash — they gain read access to the
materialized diff and nothing else. Cap materialised bytes (e.g. 8 MiB) and fail closed with a
named error rather than truncating.

### Acceptance criteria

1. A 3,000-line range materialises in ≤1 tool call and **0 reviewers** report DIFF_UNAVAILABLE.
2. `screen→prepare→merge→finalize` each run in ≤1 tool call; the written `review-summary.json`
   passes the artifact self-validation.
3. No inline tool result exceeds ~8 KB; no worker activation is needed for pure scope/diff work.
4. An unresolvable `baseRef` fails closed with a named reason.

### Regression risks to hold

New write roots are new privacy surface — keep them to the two ignore-verified directories and
never inside tracked source. Silent truncation is worse than failure: cap and fail closed.
