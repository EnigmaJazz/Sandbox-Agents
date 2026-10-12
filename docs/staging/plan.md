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

### Review bursts in OpenCode, with a review agent (decided 2026-10-12)

The user reviews inside OpenCode, in conversation with a dedicated **stage-review agent**.

What the agent does:

- Lists the waiting stages per project with size, checker verdict, S17 flag, age and stale
  markers (the burst digest).
- Walks one stage at a time: explains the diff, relays the checker's findings, answers
  questions, and reads surrounding code on request.
- Turns the discussion into a **revision note** when the user wants changes, and records it on
  the stage with the rejection. The working agents pick that note up; the review agent does not
  write code.

What the agent cannot do:

- It is read-only on the host and has no worker. It cannot edit a stage or a verdict.
- It cannot approve, reject or apply by itself. Those are separate tools
  (`host_stage_approve`, `host_stage_reject`, `host_stage_apply`) whose OpenCode permission is
  `ask`, so each call stops at a prompt the user answers, showing the stage identity and the
  apply preview. This is the same human gate `sandbox_apply` uses today.

Broker-side enforcement, because a permission prompt alone is a plugin-side control:

- The three decision operations are accepted only from a session bound to the stage-review
  role (`bindSessionAgent`, `role-policy.ts`), and never from a session that owns a worker in
  that chain. An agent cannot decide on its own stage.
- Every decision names the stage's result commit. The broker refuses if it no longer matches,
  so a decision cannot land on content the user did not see.
- Each decision is logged with the session, role, stage and commit.

Honest limit: the main socket trusts the session identity a plugin supplies, so this gate is as
strong as today's apply gate and no stronger. A compromised plugin process could claim the
review role. Two things keep the consequence bounded: S17 stages are never applied through this
path (below), and the existing divergence and protected-path checks still run on every apply.

**S17 stages keep today's rule:** they can sit in a chain and be discussed with the review
agent, but the broker refuses to apply them from any agent session. The user applies those by
hand, as now.

A terminal view (`sandboxctl stages`, read-only) is kept as a fallback for seeing the queue
when OpenCode is not running.

## Threat model changes (P0, `docs/threat-model.md`, S17, user reviews)

New or extended items to write before any code:

- **Stage-baseline forgery:** a worker supplies a false parent. Mitigated: the broker derives it.
- **Verdict forgery:** a worker or plugin writes a passing verdict. Mitigated: verdicts come only
  from advisor records the broker published itself.
- **Approval forgery:** an agent approves its own stage. Mitigated: decisions only from the
  stage-review role, never from a session with a worker in the chain, behind an `ask` prompt,
  bound to the result commit. Residual risk stated above; S17 stages excluded.
- **Persuasion by the review agent:** it summarises the work the user is approving, so a wrong
  or manipulated summary could mislead. Mitigated: the approval prompt shows the real diff from
  the broker, not the agent's summary, and the checker verdict comes from broker records.
  Stage content is untrusted input to the review agent (prompt injection): it has no write or
  decision capability to be steered into using.
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
| P2 | Stage-review role and its broker policy; `host_stage_list/show/approve/reject/apply` tools with `ask` on the three decisions; the stage-review agent definition and prompt; in-order apply reusing the existing apply path; read-only `sandboxctl stages` | First point where the user can work in bursts. Touches `opencode/plugins/**`, `opencode/config-fragments/**` and both installer parity lists. |
| P3 | Continuous external check per stage, verdict records, pause on CRITICAL | Uses `docs/advisor/`; finishes plan items A2 and A5-A9 as needed. |
| P4 | Reject, `STALE`, replay with `merge-tree`, conflict hand-back | Highest risk of subtle bugs; needs adversarial tests. |
| P5 | Working-agent side: the orchestrator keeps working on the tip, respects the limits, picks up revision notes, never holds the review role | Touches `opencode/plugins/**`. |
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

1. Limits: are 5 stages and 800 lines the right defaults?
2. Whether one chain per project is enough, or several lanes per project are needed.
3. Which model runs the stage-review agent. It should differ from the model that wrote the
   stage, so the conversation is not the author explaining its own work.

Decided: review bursts happen in OpenCode with a stage-review agent (2026-10-12), not in a
terminal tool.

## Verification of the plan itself

Each phase ends with `cd broker && bun test` green, `bun build src/main.ts --target=bun`
succeeding, new tests failing first, and the user reviewing the diff before installing. The
final acceptance is a user-run gate in P6.
