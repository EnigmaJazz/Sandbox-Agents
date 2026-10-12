# Plan: staged work chains (queue changes now, review them in bursts later)

Status: **proposed, design only. No code until the user approves this plan and the
threat-model update in P0.** Task record to create when P0 starts: `odd/tasks/staging-chains.md`.

## Goal

Agents keep working on a project without waiting for the user. Each finished piece of work is
saved as a **stage** in a protected chain. The user returns on their own schedule, reviews the
stages one at a time in order, and approves or rejects each. **Nothing reaches the live host
files until the user approves that stage.** An independent model checks each stage as it lands.
If an early stage is rejected, later stages are replayed onto the corrected work instead of
being thrown away where possible.

## Why the user is the bottleneck today

A worker snapshots the host worktree when it starts. Task 2 cannot see task 1's changes until
task 1 is applied, and apply needs a live human answer. With several projects running, each one
blocks on the same person.

## What already exists (verified in the code, 2026-10-12)

- `ensureWorker` accepts `snapshot: { worktree } | { resultRef } | { commit }`
  (`snapshotFromPayload`, `broker/src/service.ts` ~696). A worker can already start from a
  previous result ref. **Nothing orders, tracks or applies such results as a chain.**
- Results are bundles imported under `refs/opencode-sandbox/result/<sessionID>`; the baseline is
  a synthetic commit under `refs/opencode-sandbox/baseline/<sessionID>` (`gitops.ts`). Neither
  moves the user's branch or index.
- Apply is gated: `APPLY_PENDING` -> `APPLIED`, with the S16 divergence check, the protected-path
  check (S17) and `git apply` (`service.ts` ~1850-1975). It compares the host tree to the
  session's own baseline.
- The external advisor system (`docs/advisor/`) already gives a second model a bounded,
  broker-mediated channel to read a worker's work and write a response that the broker stores.
- `gitCommit` can commit an installed result under a human-authorised orchestrator.

Correction to what I said earlier in this conversation: the broker already has the primitive for
starting a worker from an unapplied result. The missing parts are the chain itself (ordering,
identity, state), in-order apply, the review queue, rework handling, and a human-only approval
channel.

## Design

### Concepts

- **Chain**: one per project and lane. Holds `base` (the host snapshot when the chain started,
  B0), an ordered list of stages, and limits.
- **Stage n**: `baseline` (= stage n-1's result commit, or B0 for the first), `result` commit,
  changed paths, whether it touches S17 paths, and a review verdict. Stored as refs in the host
  repository: `refs/opencode-sandbox/chain/<chainID>/base` and `.../stage/<n>`. No working tree
  or branch is touched.
- **The broker, not the worker, supplies each stage's baseline.** It resolves the parent stage's
  commit itself, so a worker cannot claim an arbitrary baseline (extends S15/S16).

### Stage states

`BUILDING` (worker active) -> `READY` (result imported) -> `CHECKING` -> `CHECKED(pass | findings)`
-> `APPROVED` -> `APPLIED`, or `REJECTED`, or `STALE` (an earlier stage was rejected or changed).

Only a human-only operation moves a stage to `APPROVED`, `APPLIED` or `REJECTED`.

### Apply rules

- Stages apply strictly in order. Stage n applies only when stage n-1 is `APPLIED`.
- Apply reuses today's path: the divergence check compares the host to the stage's baseline,
  which equals the host after the previous stage applied, so a clean in-order apply passes
  naturally. Any host edit made meanwhile shows as divergence and blocks that stage, as today.
- "Approve through stage k" is a convenience: it applies stages in order and stops at the first
  failure. It still shows each stage's diff and verdict before the confirmation.
- S17 paths are allowed into a chain but are flagged on the stage and need an explicit,
  separate confirmation per stage. They are never batch-approved.

### Independent checking

- **v1 (continuous):** when a stage reaches `READY`, the broker offers it to an external advisor
  (a model from a different vendor, `docs/advisor/`) with the stage's own diff. The verdict is
  recorded by the broker from the advisor record; a worker cannot write or alter it.
- **Formal native review (gentle-ai RAR):** needs per-candidate human consent for medium and
  high risk changes, so it **cannot run unattended**. It runs in the user's burst, against the
  slice the user is about to approve. We do not fake or pre-grant consent.
- A stage with a CRITICAL finding pauses the chain (no new stage starts) until the user looks.

### Rework after a rejection

1. Reject stage k with a note. Stages after k become `STALE`.
2. The agent corrects stage k as a new version.
3. The broker replays each stale stage onto the new tip using `git merge-tree --write-tree`
   (object database only, no checkout, no working tree).
4. A clean replay becomes a new stage and is re-checked (its content changed). A conflict is
   handed back to an agent with the stale diff and the rejection note as context.

So the cost of an early mistake is bounded by how many later stages conflict with the fix, not
by the chain length. It is not zero.

### Bounding the blast radius

Per-chain limits, set by the user: maximum unapproved stages (default 5) and maximum changed
lines across them (default 800). At the limit the agents stop starting new stages for that
chain and work on other projects. This is the safety valve for "a lot of work would need
repeating".

### Human-only approval channel (the hard part)

Today the human gate is OpenCode's permission prompt: the plugin asks, the user answers in the
TUI, the plugin calls the broker. The main socket trusts the caller-supplied `sessionID`, so any
plugin call could claim approval. A queue the user answers later cannot rely on that.

Proposal: a third listener, the **operator socket** (mode 0600, separate path, never passed to
any plugin tool or agent), accepting only `chainList`, `stageShow`, `stageApprove`,
`stageReject`, `stageApply`. Driven by a terminal tool, `sandboxctl stages ...`, which the user
runs. Same pattern as the advisor listener, where the role is set by the listener and not by the
request. The agents' tools cannot reach it because the path is never in their configuration and
their shell is the sandbox, not the host.

### Burst digest

`sandboxctl stages` prints, per project: stages waiting, each stage's size, checker verdict,
S17 flag, age, and stale markers. This replaces answering agents one by one.

## Threat model changes (P0, `docs/threat-model.md`, S17, user reviews)

New or extended items to write before any code:

- **Stage-baseline forgery:** a worker supplies a false parent. Mitigated: the broker derives it.
- **Verdict forgery:** a worker or plugin writes a passing verdict. Mitigated: verdicts come only
  from advisor records the broker published itself.
- **Approval forgery:** an agent approves its own stage. Mitigated: operator socket only.
- **Stale or reordered apply:** applying stage n without n-1, or after the host moved.
  Mitigated: in-order rule plus the existing divergence check.
- **Chain growth as a denial of service:** mitigated by the stage and line limits.
- **Review-consent bypass:** mitigated by never pre-granting consent.
- **Retention:** unapproved stages hold refs and bundles. Extend the artifact GC so it never
  removes an unapplied stage's only copy (the durability rule in `artifacts.ts`).

## Phases

All code is under S17 paths: test-first in `broker/tests/`, one work-unit commit each (about
400 changed lines per task is a planning heuristic), reviewed and installed by the user.

| Phase | Deliverable | Notes |
|---|---|---|
| P0 | This plan accepted; threat-model update; `odd/tasks/staging-chains.md` | Docs only. Spike: can native review run on a stage commit (needs a checked-out candidate; try a shared clone in the state directory, never a worktree in the project). Result decides the burst-time review design. |
| P1 | Chain and stage records, refs, `chainCreate` / `chainStatus`, worker starts from the tip via the existing `snapshot.resultRef`, stage registered on finish | Broker derives baselines. No apply change yet. |
| P2 | Operator socket, `sandboxctl stages list/show/approve/reject/apply`, in-order apply reusing the existing apply path | First point where the user can work in bursts. |
| P3 | Continuous external check per stage, verdict records, pause on CRITICAL | Uses `docs/advisor/`; finishes plan items A2 and A5-A9 as needed. |
| P4 | Reject, `STALE`, replay with `merge-tree`, conflict hand-back | Highest risk of subtle bugs; needs adversarial tests. |
| P5 | Plugin tools and agent prompt: orchestrator keeps working on the tip, respects the limits, never approves; burst digest | Touches `opencode/plugins/**` and `scripts/install-user-files` (both parity lists). |
| P6 | Gated acceptance tests in `tests/acceptance/`; a manual gate for the user to run and sign off | Agents do not self-certify. |

P1-P2 deliver most of the value (agents stop waiting, the user approves in bursts). P3 and P4
add the checking and the rework behaviour.

## Out of scope

- Pushing, installs, broker restarts and anything outside the project repository stay live-human
  actions.
- Running staged code against the live system. A stage is only exercised inside the sandbox.
- Auto-merging an agent's own approval, now or later.
- Multi-user chains.

## Open decisions

1. Where the user does the burst: the terminal tool above (recommended, since it also gives a
   safe human-only channel), or inside OpenCode.
2. Limits: are 5 stages and 800 lines the right defaults?
3. Whether one chain per project is enough, or several lanes per project are needed.

## Verification of the plan itself

Each phase ends with `cd broker && bun test` green, `bun build src/main.ts --target=bun`
succeeding, new tests failing first, and the user reviewing the diff before installing. The
final acceptance is a user-run gate in P6.
