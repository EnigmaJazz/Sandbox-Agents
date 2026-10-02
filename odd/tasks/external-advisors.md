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
- [ ] **A3 — Advisory records.** Split into:
  - [x] **A3a — Store, lifecycle and pre-code advice.**
  - [ ] **A3b — Review-lens requests.** The broker reads `target`, `order`, both subject hashes and the `lens-context` text from gentle-ai for an external-lens lineage, and validates responses against the cached reviewer schema, including the `subject_hash` match and the `inspection.paths` coverage.
- [ ] **A4 — Stored-response relay into `reviewCaptureResult`.** Design and failing tests are
  written once A3's store exists.
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

## Next step

Next: A3b (review-lens records), then A4 (stored-response relay). Both are Claude-owned. A2 and A5 can be handed off from test-first specs. Slices A2, A3 and A5 can be handed off from test-first specs; A4 stays with Claude.
