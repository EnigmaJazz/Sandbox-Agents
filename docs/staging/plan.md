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

### Lanes (decided 2026-10-12)

A project has at most **two active chains**:

- **Feature lane:** one chain per ODD feature (`odd/tasks/<feature>.md`). Each work-unit commit
  is a stage; the chain closes when the feature is fully applied or abandoned. Limits (5 stages
  and 800 changed lines, adjustable) are a per-feature budget.
- **Fix lane:** one chain for separate bug fixes, kept short (default 2 stages).

Why two and not one: stages apply in order, so in a single chain an urgent fix would wait
behind every unapproved feature stage.

Both lanes start from the same host state, so applying one makes the other stale. Rules:

- The fix lane applies first; the feature chain is then replayed onto the new host state with
  the same `merge-tree` replay used for rejections (no extra mechanism).
- When a fix stage lands, the broker compares its paths with the feature chain's and warns
  immediately if they overlap, not at apply time.
- No third parallel chain. Each extra chain multiplies replays.

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

Two tiers (decided 2026-10-12). An earlier draft used external advisors for the continuous
per-stage check. That was wrong: external advisor sessions must be opened and prompted by the
user (subscription terms of service), so they cannot run unattended.

- **Per stage, unattended: internal OpenCode advisors.** Before a stage starts, an internal
  advisor (`advisor-security` and the lane in TODO Tier 2 item 13) advises on the approach;
  after it reaches `READY`, an internal advisor reviews the stage's own diff. The advisor runs
  on a different model from the one that wrote the stage wherever the configured providers
  allow. Its verdict is submitted through a broker operation that only the advisor role may
  call, and is stored on the stage; the writing session cannot write or alter it.
- **Per feature and per bug-fix plan, in the user's burst: external advisors.** Before an ODD
  feature starts (on its plan) and after its last stage (on the whole feature), and on the plan
  for a bug fix. The user opens and prompts these sessions, as `docs/advisor/` requires, so
  they happen when the user is present and never block agents between bursts.
- A missing pre-stage or post-stage advisor record blocks that stage from being offered for
  approval. It is not enough for the agent to say advice was taken.
- **Formal native review (gentle-ai RAR):** needs per-candidate human consent for medium and
  high risk changes, so it **cannot run unattended**. It runs in the user's burst, against the
  slice the user is about to approve. We do not fake or pre-grant consent.
- **Review slices follow stages.** The native review candidate is a work-unit commit or a PR
  slice, so a stage is normally one candidate. Low-risk stages (`passive`, or under budget) may
  be grouped and reviewed together; `review assess` on the stage decides, as it does today.
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

### The user's burst, end to end

The workflow is a series of stage reviews, most with a native review alongside. For each stage,
in order:

1. The review agent presents the stage: diff, size, S17 flag, the continuous checker's verdict.
2. The agent runs `review assess` on the stage and says whether a native review is due.
3. If due, the consent prompt appears and you grant or decline it. The four lenses run in the
   background while you talk through the diff with the agent; findings are relayed when they
   land.
4. You approve (then apply), or reject with a revision note.
5. On reject, later stages go stale and the replay starts while you move to the next project.

Time is spent waiting for the lenses, so a burst should overlap them: start the consent for
the next stage's review while the current one is still running, across projects too.

Open spike (P0): the native review needs a checked-out candidate and an acknowledgement that
burns it. The design for running it against an unapplied stage commit is not settled; the
shared-clone approach in P0 decides it. If native review cannot run on a stage before it is
applied, the fallback is to review the applied commit on the feature branch, which shifts the
review after apply and weakens the guarantee. That fallback needs your explicit decision.

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

Isolation of the agent and its tools (decided 2026-10-12). Three layers, each using a pattern
this repository already has:

1. **No other agent can reach it.** It is a `mode: "primary"` agent the user selects, not a
   subagent, so it is not a Task target. Every other agent's `permission.task` already denies
   by default (`role-agents.jsonc`: `"task": { "*": "deny" }`) or uses an explicit allowlist
   (the orchestrator); the stage-review agent is in none of them.
2. **No other agent has its tools.** `host_stage_*` are denied in the global permission
   fragment and enabled only inside the stage-review agent's own block, whose `tools` map
   starts from `"*": false`. The three decision tools are `ask` there.
3. **The broker refuses everyone else.** A new `stageReviewAgents` allowlist in the broker
   configuration, enforced like `readOnlyAgents` in `HostToolPolicy`: stage operations from any
   other agent name are refused, and the stage-review agent is refused every worker operation.
   The agent name comes from OpenCode's tool context (`ctx.agent`), not from the model.

Explicit denial, not reliance on defaults (decided 2026-10-12): every other agent gets an
explicit `"<stage-review agent>": "deny"` entry in its `permission.task`, including the
orchestrator, whose allowlist `gentle-ai sync` rewrites. This repository ships the reviewed
fragment; the **workflow_optimisation** project, which already owns the live configuration
overrides, applies it after each sync, and its verifier asserts three things: the deny entry is
present for every agent, it takes effect over any broader rule in the same map, and
`host_stage_*` is enabled for the stage-review agent only. That needs a handover to that
project in P2; nothing is edited there from here.

The per-agent override of a global deny is already in use and working (checked 2026-10-12):
the live `opencode.json` denies `sandbox_bash`, `sandbox_edit`, `sandbox_apply` and others
globally and grants them per agent as `allow` or `ask` (for example `general` and
`frontend-apply`), and the broker journal shows those agents' operations succeeding. The
`host_stage_*` tools use the same arrangement, so no new OpenCode behaviour is assumed.

Further broker-side enforcement, because a permission prompt alone is a plugin-side control:

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

## Where this falls in the wider queue (decided 2026-10-12)

1. Review and restart for the worker-leak fixes (`4fbc94c`, `d65518b`), on gentle-ai 3.7.0.
2. gentle-ai 4 upgrade day. The current first priority.
3. Staging P0: threat model and the native-review spike (run on gentle-ai 4).
4. Prerequisites:
   - **Workflow enforcement (workflow_optimisation), compulsory.** Agents left to run several
     stages must not skip checks or drift. Staging must not start unattended multi-stage work
     until that enforcement is live. Host-side parts built here: the project-scoped signal for
     the routing guard (TODO Tier 2 item 12) and the ledger append operations (items 7 and 8).
   - The internal advisory lane running on every unit (Tier 2 item 13).
   - Host review pipeline tools (Tier 2 item 1), likely needed by the native-review spike.
   - Review queueing at the reviewer cap (Tier 3 item 8).
   - Apply-path recovery gaps (Tier 4 items 27 and 30).
5. Staging P1-P2: the first usable version, on OpenCode V1.
6. Staging P3-P6.
7. OpenCode V2 migration. Not urgent: it exists to let OpenChamber update, and V1 is stable.
   The staging tools are ported with the rest of the plugin surface then.

The broker enforces what it can itself and does not rely on prompts: a stage is not offered
for approval without its advisor records, limits stop new stages, and a CRITICAL verdict pauses
the chain. Workflow enforcement covers what the broker cannot see (which checks an agent ran
inside a stage).

## Phases

All code is under S17 paths: test-first in `broker/tests/`, one work-unit commit each (about
400 changed lines per task is a planning heuristic), reviewed and installed by the user.

| Phase | Deliverable | Notes |
|---|---|---|
| P0 | This plan accepted; threat-model update; `odd/tasks/staging-chains.md` | Docs only. Spike: can native review run on a stage commit (needs a checked-out candidate; try a shared clone in the state directory, never a worktree in the project). Result decides the burst-time review design. |
| P1 | Chain and stage records, refs, `chainCreate` / `chainStatus`, worker starts from the tip via the existing `snapshot.resultRef`, stage registered on finish | Broker derives baselines. No apply change yet. |
| P2 | Stage-review role, the `stageReviewAgents` allowlist and its broker policy; global deny of `host_stage_*`; `host_stage_list/show/approve/reject/apply` tools with `ask` on the three decisions; the stage-review agent definition and prompt; in-order apply reusing the existing apply path; read-only `sandboxctl stages` | First point where the user can work in bursts. Touches `opencode/plugins/**`, `opencode/config-fragments/**` and both installer parity lists. Includes the handover to workflow_optimisation for the task-deny override and its verifier checks. |
| P3 | Internal advisor pre and post each stage, broker-recorded verdicts, pause on CRITICAL; external advisor hooks at feature start, feature end and bug-fix planning | Internal lane is TODO Tier 2 item 13. External advisors (`docs/advisor/`, A2 and A5-A9) are needed only for the burst-time hooks, so they do not block P1-P2. |
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

## Decisions

Decided 2026-10-12:

- Review bursts happen in OpenCode with a stage-review agent, not in a terminal tool.
- At most two chains per project: one per ODD feature, plus a short fix lane (rules above).
- Review-agent model: the same tier as the orchestrator, from a different vendor than the model
  that wrote the stage. A weak or local model is not acceptable, because a confident wrong
  explanation of a diff is the one failure nothing else catches. It does not need to be the
  strongest, since the checker and native review find the defects. For S17 stages use the
  strongest available model.

- Limits start at 5 stages and 800 changed lines for the feature lane and 2 stages for the fix
  lane. They are configuration, not constants: broker defaults with a per-project override in
  the project registration, changeable without a code change, and shown in the burst digest so
  a limit that is stopping work is visible.
- Native-review fallback accepted: if the P0 spike shows native review cannot run on an
  unapplied stage, it runs after apply. The order is then: the user approves the stage on the
  diff and the continuous checker's verdict, the stage is applied to the working tree, native
  review runs on it, and only then is it committed. A blocking finding is corrected as a new
  stage, or the applied stage is reverted before commit. Nothing is committed or pushed
  unreviewed; what is lost is that host files change before the formal review. The spike still
  runs first, because review-before-apply is the stronger design.

No decisions are open. P0 can start on the user's go-ahead.

## Verification of the plan itself

Each phase ends with `cd broker && bun test` green, `bun build src/main.ts --target=bun`
succeeding, new tests failing first, and the user reviewing the diff before installing. The
final acceptance is a user-run gate in P6.
