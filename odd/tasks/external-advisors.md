# External advisors (plan A)

## Objective

Read-only Claude Code / Antigravity advisors, opened and prompted by the user, that investigate
in pinned throwaway workers. Their bound, immutable evidence feeds the existing gentle-ai
adjudication; they never get authority to issue keys. Plan:
`docs/advisor/plan-sandbox-integration.md`. Contract: `docs/advisor/interface-contract.md`.

## Constraints

- `broker/src/**`, `opencode/plugins/**`, `nono/profile/**`, `scripts/**` are S17. The user
  reviews and installs.
- No advisor-reachable operation may export, apply, install, commit, or call gentle-ai.
- Dependency-free broker; argv only; fail closed.

## Tasks

- [x] **A0 — This task record.** The proposal to add `advisor/**` to the S17 list in AGENTS.md
  is the user's decision and is still open.
- [x] **A1 — Advisor socket and trusted binding.**
  - `BROKER_ADVISOR_PROJECTS` (a JSON array of registered project ids) opens one 0600 listener
    per project: `opencode-sandbox-advisor-<projectId>.sock`, next to the main socket.
  - Each advisor connection is bound at open to one broker-assigned session,
    `advisor-<projectId>-<random>`. Every request on it is rewritten to that session, with agent
    `external-advisor`. `ensureWorker`'s `projectDir` is pinned to the listener's project.
  - Operation allowlist: `ensureWorker`, `workerStatus`, `destroyWorker`, `exec`, `readFile`,
    `writeFile`, `applyPatch`, `listDir`, `grep`, `diff`. Everything else is refused.
  - The main socket refuses any `advisor-*` session id.
  - Disconnect reaps the advisor session through the existing disconnect clean-up.
- [ ] **A2 — Snapshot pinning, identity, evidence export.** See the plan.
- [x] **A3 — Advisory records.** Split into:
  - [x] **A3a — Store, lifecycle and pre-code advice.**
  - [x] **A3b — Review-lens requests.** The broker reads `target`, `order`, both subject hashes and the `lens-context` text from gentle-ai for an external-lens lineage, and validates responses against the cached reviewer schema, including the `subject_hash` match and the `inspection.paths` coverage.
- [x] **A4 — External-lens start and stored-response relay into `reviewCaptureResult`.**
- [ ] **A5–A9.** See the plan.

## Acceptance (A1)

- An advisor connection can't name, read or operate any session but its own.
- It can't run any operation outside the allowlist.
- It can't change its project.
- The main socket can't operate an advisor session.
- Two advisor connections get distinct sessions.
- The socket file is mode 0600.

## Checks

- `cd broker && bun test`
- `cd broker && bun build src/main.ts --target=bun --outfile <scratch path outside the repo>`

## Route and delivery

- Route: direct inline (Claude Code orchestrator). One work-unit commit per slice on
  `feat/review-and-state-hardening`; no push.

## Progress

Started 2026-10-02 with A1.

- **A1 done.**
  - New `broker/src/advisor-socket.ts`: the allowlist, socket naming, session assignment, `bindAdvisorRequest` and `refuseAdvisorSessionOnMain`.
  - `server.ts` starts one 0600 listener per `config.advisorProjects` entry, refusing an unregistered project at start, and binds each connection at open. It applies the binding (advisor) or the refusal (main) right after parsing, and stops the advisor listeners on shutdown. The existing disconnect clean-up reaps the advisor session.
  - `config.ts` adds `advisorProjects` (default `[]`, so no listener). `main.ts` parses `BROKER_ADVISOR_PROJECTS`, and `systemd-user/broker.env` documents it, left unset.
  - Tests: 12 new in `broker/tests/advisor-socket.test.ts` (unit, plus an end-to-end run against a real broker serving a real advisor socket). They failed before implementation (module missing), then passed. The end-to-end run shows distinct assigned sessions per connection, refusal of `prepareResult`, of a foreign session and of another project, the main socket refusing an advisor session, and mode 0600.
  - Checks: `bun test` passed 630, 0 fail; `bun build src/main.ts` succeeded.
  - Not yet: `resultDiff`, `evidenceKeep`, `advisorRead` and `advisorRespond` don't exist. A2 and A3 add them to the allowlist.

- **A3a done.**
  - New `broker/src/advisor-records.ts`. `advisorAsk` (orchestrator-only host mutation), `advisorGet` and `advisorList` (host reads) are on the main socket; `advisorRead` and `advisorRespond` are advisor-socket only.
  - **Storage:** records live under `<stateDir>/advisor/<projectId>/requests/` (directories 0700, files 0600). The request, its claim and its response are each published once by an exclusive hard link, so immutability holds at the OS level, races included.
  - **Status** is derived from which files exist and the clock (pending, claimed, submitted, declined, or expired after a 24 h TTL).
  - **Selection:** `rotate` resolves to the least recently used host per project and is persisted; `selection.rule` is required; `group` is recorded.
  - **Advisor view:** an advisor sees only its own request (no response field, no other records). Its project comes from its broker-assigned session id.
  - **Refusals:** a token is refused by the payload-key allowlist, and `review-lens` is refused until A3b.
  - **Wiring:** `types.ts`, `validation.ts` (payload keys; read/mutation classes), `server.ts` dispatch, and `advisor-socket.ts` (allowlist; the main socket refuses the advisor-only operations).
  - Tests: 16 new in `broker/tests/advisor-records.test.ts` (they failed before implementation, module missing), plus an end-to-end socket test in `advisor-socket.test.ts`: the orchestrator asks on the main socket, the advisor claims and answers on its socket, a second answer is refused, the main socket can't read as an advisor, and the orchestrator reads the answer.
  - Checks: `bun test` passed 647, 0 fail; `bun build src/main.ts` succeeded.
  - Not yet: user overrides (`advisor-open --override-reason`, A7) and evidence references (A2).

- **Review correction (`R3-rotate-race`).** Native review lineage `review-96365efe7a5eaa5e` (run from another chat) raised a CRITICAL reliability finding: a race in the `rotation.json` read-modify-write.
  - **Verification:** it doesn't reproduce. `rotateHost`, and everything in `advisorAsk` before it, is synchronous on a single-threaded runtime in a single broker process, and 10 concurrent asks alternate hosts strictly.
  - **Correction:** make the invariant explicit and tested rather than add an unneeded lock. There's a documented invariant on `rotateHost` and a concurrency regression test.
  - **Mutation check:** splitting the read and write with an `await` makes the test fail (mutation reverted).
  - Checks: `bun test` passed 648, 0 fail.

- **A3b done.**
  - New `broker/src/advisor-lineages.ts`: the external-lens lineage registry, written by A4's `reviewStart`.
  - New `broker/src/advisor-reviewer-result.ts`: a structural pre-check mirroring the gentle-ai reviewer schema; gentle-ai's preflight at relay time stays authoritative.
  - `advisor-records.ts`: a `review-lens` ask requires a registered lineage. The broker then reads the lens's `collect` input (`review status --contract v2 --next-transition --lineage`, through the existing runtime wrapper) and its `review lens-context`. It cross-checks the lens-context binding's `subject_hash` against the provider's, and stores lineage, lens, target, order, subject hash and the reviewer task. The caller supplies only lineage and lens.
  - The advisor's view includes the reviewer task. A submitted lens response needs a `reviewerResult` that passes the pre-check, and is stored exactly as submitted; a declined one needs a reason.
  - **Verified 2026-10-02:** an agentless lineage returns the same `collect` input with or without `--agent opencode` under v2. v2 passes `subject-hash` as an explicit capture argument and has no changed-path manifest, so path coverage is left to gentle-ai's preflight.
  - Tests: 13 new in `broker/tests/advisor-review-lens.test.ts` (they failed before implementation, modules missing). The obsolete A3a "refused until A3b" test was replaced by the registered-lineage rule.
  - **Live check against real gentle-ai** (throwaway agentless lineage `review-d6d1312c5655c0de`): the ask read a 10,352-byte reviewer task. A result that passed the broker pre-check also passed `gentle-ai review capture-result --preflight` (`validation: accepted`).
  - Checks: `bun test` passed 660, 0 fail; `bun build src/main.ts` succeeded.

- **A4 done.**
  - New `broker/src/advisor-relay.ts`.
  - `reviewStart` takes `externalLenses: true`: no runtime agent (refused if one is given), and the returned `lineage_id` is registered.
  - `reviewCaptureResult` takes `inputFromAdvisorResponse`, which excludes every other capture field: the broker builds the capture itself.
    - **Relayable responses:** only a submitted review-lens response.
    - **Freshness:** a fresh `collect` input must match its target, order and subject hash, otherwise it's refused as stale. The current revision and repository context come from that fresh input.
    - **Order:** `--preflight` runs first, then the real capture, with the stored result staged through the existing private `inputJson` path.
    - **At most once per (lineage, lens):** an exclusive marker under `<stateDir>/advisor/<projectId>/relayed/` is released when gentle-ai refuses, so a corrected retry is possible.
  - **Self-approval hole closed:** on an external-lens lineage, free-form `input`/`inputJson` and any `agent` are refused.
  - Tests: 11 in `broker/tests/advisor-relay.test.ts`. Eight failed before implementation; the other three passed already, covering existing behaviour or refused by the payload allowlist.
  - **Live end-to-end against real gentle-ai** (throwaway repo, broker handlers with the real runtime): an `externalLenses` start (`state: reviewing`); a free-form `inputJson` refused; an advisor asked, claimed and answered with a CRITICAL finding; the relay admitted by gentle-ai, which adjudicated `correction_required`; a second relay refused.
  - Observed: `reviewStart` doesn't forward `--target-evidence` from the STATUS-returned start command, and gentle-ai accepted the start without it. That was pre-existing and is noted for the flag-parity sweep.
  - Checks: `bun test` passed 671, 0 fail; `bun build src/main.ts` succeeded.

## Next step

The security core (A1, A3, A4) is complete. Remaining: A2 (snapshot pinning and evidence export), A5 (OpenCode host tools), A6 (advisor MCP server), A7/A8 (launchers, behind their config-isolation gates), A9 (confinement). These can be handed off from test-first specs; the user installs. A2 and A5 can be handed off from test-first specs. Slices A2, A3 and A5 can be handed off from test-first specs; A4 stays with Claude.

## A2a review and follow-up

- **Review:** approved; authority burned. Lineage `review-7dc1caa8ea859908`; target `sha256:ac279408…`; consumed revision `sha256:d2f95f0d…`; commit `1b3d246`.
- **Last reviewed boundary:** commit `1b3d246`. The boundary **advanced to `3253224`** by a `passive` assessment (3 paths / 29 lines, reason `non_executable_only`). The next review must pass `3253224` as `base-ref`, never the previous commit. A previous-commit base makes every window a single work unit, always `under_budget`, so the checkpoint would silently never fire.
- **Later advisory work (non-blocking):**
  - `R3-ensureWorker-snapshot-return-inconsistent` (reliability, WARNING, `broker/src/service.ts:505`) — `ensureWorker` returns a `snapshot` identity on a new worker but omits it on reuse.
  - `R4-001` (resilience, WARNING, `broker/src/service.ts:324`) — a repeat call omitting `snapshot` defaults to worktree, so a session pinned to a commit/resultRef is refused rather than reused.
- **Sandbox invocation constraint:** run from the project root with `bun --cwd broker test`; never change cwd. At the root, `bun --version` reports 1.3.14; `bun test` and `printenv` from `broker/` return ENOENT. Root-causing the cwd behaviour is planned as a separate unit.
