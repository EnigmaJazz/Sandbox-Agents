# ODD Tasks — host-sandbox-result-tool

- **Feature:** `host-sandbox-result-tool`
- **Project:** `sandbox-integration` (`/home/james/agent-sandbox-integration`)
- **Status:** implementation in working tree — T1/T2 implemented and installed, T3/T4/T5 done; record T1/T2 commit identities once supplied
- **Created:** 2026-09-23
- **Delivery strategy:** `ask-on-risk`
- **Chain strategy:** `stacked-to-main` (the user's standing choice)

## Objective

Add a broker-side host tool surface that lets the orchestrator read and install a
sandbox result ref without host shell. A read operation returns the result ref's
commit identity and a bounded diff; an approval-gated install operation resolves
the ref, derives its paths broker-side, presents the exact diff for approval, and
writes only those paths into the working tree. The tool removes the user's manual
pasting; the human keeps the accept/reject decision.

## Problem

The orchestrator has no host shell, so it cannot inspect or install a sandbox
result ref (`refs/opencode-sandbox/result/<sessionID>`) by itself. Installing a
reviewed result meant the user pasting this command repeatedly:

```
git checkout refs/opencode-sandbox/result/<sessionID> -- <paths>
```

Three costs were observed on 2026-09-21 (reported by the user; not reproduced in
this session):

1. `git checkout <ref> -- <paths>` **stages the index as a side effect.** That
   forced a `git reset --mixed` and a re-commit of six work units.
2. Installing from a **stale checkout silently downgraded the live plugin set** —
   the pasted paths resolved older bytes than the intended result.
3. Confirming whether a **blocking ref held the intended work** required the user
   to run `git show` / `git diff` by hand and read the output back.

The tool removes the pasting. It does not remove the human's decision.

## Scope

### T1 — read

A broker operation that, for a session id, returns:

- the result ref's commit identity and timestamp;
- the changed-path list with per-file added/removed counts;
- the patch, or a bounded excerpt of it; and
- a comparison mode between two refs (or a baseline and a result).

Properties: fixed argv, no worker activation, bounded output, read-only, no
approval (classified with the existing read tier).

### T2 — install (approval-gated)

Resolve a result ref, derive its paths broker-side, present the exact diff for
approval, and write only those paths into the working tree.

Constraints:

- never `git add -A`;
- never stage the index;
- refuse unknown sessions and any path outside the result's own diff;
- S17 paths require that approval — the approval **is** the manual review, not a
  bypass of it.

### T3 — exposure

Plugin tool definition, config fragment, `docs/config-manifest-host-tools.md`,
and the threat-model note.

### T4 — tests

Fixed argv; unknown session refused; a path outside the result's diff refused;
the index left unstaged after an install; bounded output; S17 path handling.

### T5 — docs.

### Out of scope

Deleting or rewriting result refs, pushing, arbitrary/unresolved refs, caller-
supplied path lists, and any ref outside
`refs/opencode-sandbox/result/<sessionID>`.

## Related current surface (verified read-only this session, file:line)

- `broker/src/gitops.ts:35-46` — `BASELINE_REF_PREFIX`,
  `RESULT_REF_PREFIX = "refs/opencode-sandbox/result"`, `baselineRef`,
  `resultRef`; `assertRefComponent` guards the session id.
- `broker/src/gitops.ts:104-114` — `buildDiffArgv` / `buildChangedPathsArgv`
  (`git diff --name-only --no-renames -z <baseline> <result> -- .`), the existing
  baseline↔result diff internals T1 should reuse rather than reinvent.
- `broker/src/gitops.ts:242-256` — `checkProtectedPaths` (S7/S17 glob match).
- `broker/src/gitops.ts:394-402` — `buildGitCommitArgv` stages then commits
  (`git add -- <paths>` + `git commit -m … -- <paths>`). T2 must NOT follow this
  shape: it writes the working tree only and leaves the index untouched.
- `broker/src/service.ts:2139-2186` — `resolveCommitResult`: already resolves a
  result ref, verifies the ref is inside `RESULT_REF_PREFIX`, and binds the
  session to the project. T1/T2 should reuse this resolution and its fail-closed
  errors (unknown session, no applied result, wrong project, outside namespace).
- `broker/src/service.ts:2196` — `buildGitCommitOp`; `:158` —
  `authorizeHostDispatch` (trusted session-record agent, never the envelope
  claim).
- `broker/src/validation.ts:783-791` — `HOST_READ_OPERATIONS` (observed: 7, no
  sandbox-result op). `:793+` — `HOST_MUTATION_OPERATIONS`.
- `opencode/plugins/lib/host-tool-approval.ts:20-36` — `HostMutationOperation`
  union (observed: 16) and `buildHostToolAsk` (`always: []`, never
  auto-approved).
- Existing tests: `broker/tests/service-git-commit-session.test.ts` (cross-
  session applied result, namespace/project refusal),
  `broker/tests/service-diff.test.ts` (diff metadata for the approval decision),
  `broker/tests/gitops.test.ts` (`checkProtectedPaths`, ref naming).

Note: `host_git_commit` today **rejects** S17 paths outright via
`checkProtectedPaths`. T2 instead surfaces S17 paths through the single approval
so the approval is the manual review. Implementers must reconcile this
deliberately (and document it in T5) rather than by omission.

## Constraints

- **Fixed argv vectors only, never a shell string.** Every operation builds an
  argv array in the `gitops.ts` style; no raw ref, no caller path list, no shell.
- **No worker activation.** T1 and T2 run broker-side against the host repo, like
  the other `host_*` operations.
- **Bounded output with an explicit cap** — reuse the existing 512-KiB cap +
  redaction path (`gitops.ts:333-340`, `GIT_OUTPUT_MAX_BYTES`).
- **T1 is read-only and never prompts** — it must classify as `read`
  (`HOST_READ_OPEN`) and must not be added to `HOST_MUTATION_OPERATIONS`.
- **T2 is approval-gated**: fragment `ask` plus an in-tool metadata `ctx.ask`
  (`buildHostToolAsk`), orchestrator-only broker-side.
- **Index is never staged.** T2 writes only the result's own diff paths into the
  working tree; `git status` must show the index untouched afterwards.
- **Fail closed** on an unknown session or an out-of-diff path, naming the reason.
- **Preserve exact-payload-key validation** (`assertPayloadKeys`) with a precise
  allowlist per new operation. No `sandboxSessionID`-plus-arbitrary-ref form.
- **Preserve S17 handling as specified above** and document it; `broker/src/**`,
  `opencode/plugins/**`, `opencode/config-fragments/**`, and
  `docs/threat-model.md` are installed by the user, never auto-applied.
- **Every new operation appears in the fragment and the manifest in the same
  change unit.** No deploy, mirror to `~/.config`, service restart, or commit by
  the agent. Broker code stays dependency-free (`bun:test` + node builtins only).

## Tasks

Stable IDs; each task is a reviewable change unit.

- **T1 — read.** Broker operation + plugin read tool for result-ref identity,
  changed paths with per-file counts, bounded patch/excerpt, and a
  two-ref/baseline-vs-result comparison mode. Fixed argv, bounded output,
  read-only, no approval. Done when the orchestrator can answer "does this
  blocking ref match intent?" and diff two refs with no host shell.
- **T2 — install (approval-gated).** Broker mutation + plugin tool: resolve the
  result ref (reuse `resolveCommitResult` semantics), derive paths broker-side,
  present the exact diff for approval, then write only those paths into the
  working tree. Done when an S17 install completes from one approval and
  `git status` shows the index untouched.
- **T3 — exposure.** Plugin tool definition, config fragment, manifest, and
  threat-model note. Done when all four match the implemented surface.
- **T4 — tests.** Fixed argv; unknown session refused; out-of-diff path refused;
  index unstaged after install; bounded output; S17 path handling. Done when
  RED→GREEN evidence is captured and the existing suite stays green.
- **T5 — docs.** Manifest §inventory and line refs, fragment permission lists,
  and the threat-model boundary. Done when the documents match the code.

## Acceptance criteria

1. The orchestrator can determine whether a blocking result ref matches intent
   with no host shell, and can diff two refs itself.
2. An S17 install happens from one approval-gated operation, and `git status`
   shows the index untouched afterwards.
3. No operation accepts a raw ref, an arbitrary path list, or shell.
4. An unknown session or an out-of-diff path fails closed with a named reason.

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

## Checks

- `bun --cwd broker test` — at tracker creation: **489 pass, 0 fail, 2187
  expect() calls, 489 tests across 30 files.** A docs-only change must not alter
  any count; this confirms no test impact, it does not validate the tracker's
  content.
- Argv-vector inspection for both operations (no shell string, no raw ref, no
  caller path list, no `git add -A`).
- Index-untouched check: after a T2 install, `git status` shows the same staged
  set as before (expected: none).
- Bounded-output check on T1 (cap + redaction).
- An unknown-session and out-of-diff-path refusal check, each with a named
  reason.
- Readback of the fragment and manifest entries against the implemented tool set.
- S17 files are reviewed and installed by the user; the agent does not apply them.

## Delivery strategy

- Delivery strategy: `ask-on-risk` (the default). Forecast at tracker creation:
  roughly **400–650 authored lines added and 40–80 deleted** across units,
  excluding generated files. Recompute from work-unit commits; apply the chosen
  strategy before the next commit once the running total crosses ~400 authored
  lines.
- Chain strategy: `stacked-to-main` (the user's standing choice). Each unit lands
  on the default branch in order as its own reviewable slice.
- Likely slices (confirm at implementation time): Slice 1 = T1 read + its
  T3/T4/T5 parts; Slice 2 = T2 install + its T3/T4/T5 parts.

## Progress

| Task | Status  | Notes |
|------|---------|-------|
| T1   | done    | Implemented, installed, and verified in the working tree with the suite green; record commit identity once supplied. |
| T2   | done    | Implemented, installed, and verified in the working tree with the suite green; record commit identity once supplied. |
| T3   | done    | Exposure completed. |
| T4   | done    | Tests pass: twelve tests for the read operation, install suite, and live-git verification that install writes the working tree without staging the index. |
| T5   | done    | Docs completed. |

## Evidence

- Tracker created: `odd/tasks/host-sandbox-result-tool.md` (this file).
- Observed read-only this session via CodeGraph (current on-disk source):
  `broker/src/gitops.ts:35-46`, `:104-114`, `:242-256`, `:394-402`;
  `broker/src/service.ts:158`, `:2139-2186`, `:2196`;
  `broker/src/validation.ts:783-791` (7 read ops, no sandbox-result op);
  `opencode/plugins/lib/host-tool-approval.ts:20-36` (16 mutations).
- `bun --cwd broker test` at tracker creation: 489 pass, 0 fail, 2187 expect()
  calls, 489 tests across 30 files, 0 failures.
- Re-read current implementation sources: `opencode/plugins/sandbox-tools.ts:559-581`
  (`host_sandbox_result`), `:583-622` (`host_sandbox_result_install`);
  `broker/src/validation.ts:799-808` (8 read operations), `:811-829`
  (17 mutations), `:987-988` (payload allowlists);
  `opencode/config-fragments/sandbox-permissions.jsonc:82-83`.
- `bun --cwd broker test` run for this update succeeded; complete aggregate totals
  were unavailable in the returned output.
- T4 evidence: twelve tests pass across the read operation and install suite.
  The live-git test `sandboxResultInstall — live git: worktree written, index
  untouched` verified that installation writes the working tree without staging
  the index. Its RED run, after reverting to the `git checkout <ref> -- <paths>`
  shape, produced staged `mod.ts` and `new.ts` entries that should not exist.
- Reported by the user (2026-09-21; not reproduced here): the index-staging side
  effect and forced `git reset --mixed` + six-unit re-commit; the stale-checkout
  plugin downgrade; and the manual `git show`/`git diff` readback before
  accepting a blocking ref.

## Next step

1. Install the retained threat-model result
   `refs/opencode-sandbox/result/ses_f2a680fbcffe4ofdUaecsnUiV2`; it touches S17
   (`docs/threat-model.md`) and is user-installed.
2. Record the T1/T2 commit identities once supplied; do not infer or invent them.
3. Then review.
