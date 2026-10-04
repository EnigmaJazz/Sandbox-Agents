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
  - **Advisor dispatch (pre-code):** `advisor-security`, model `opencode-go/deepseek-v4.1-flash`.
    Question: “What is wrong or missing in this approach, what should change before implementation,
    and what evidence supports that?” Frozen evidence: `docs/advisor/plan-sandbox-integration.md`
    (### A2 item 3), `docs/advisor/interface-contract.md` §3, `broker/src/advisor-records.ts`,
    `broker/src/advisor-socket.ts`, and `broker/src/validation.ts`.
  - **Answer summary:**
    1. Three wiring points were missing: `Operation` union and `OPERATIONS` array
       (`types.ts:34-110`, `:113-174`; rejected at `validation.ts:1177-1179`), an
       `ALLOWED_PAYLOAD_KEYS.evidenceKeep` entry (`validation.ts:1039-1042`), and a `server.ts:558`
       dispatch case. Without them validation rejects every call before a handler runs.
    2. The named validators cannot enforce worker containment or symlink rules:
       `assertSandboxPath` is lexical, host-blind, and rejects absolute paths (`validation.ts:159-180`);
       `resolveProjectRelativePath` performs host realpath (`:471-516`). No existing operation lstat-
       checks worker paths; `readFile` uses `stat -L` and `copyOut` uses `cat`, both following links
       (`service.ts:974`, `:996`, `:1189-1192`).
    3. The broker must hash exact received bytes in a single unsymlinked read and never trust a
       worker-supplied size or hash; `service.ts:1008-1012` shows the existing check-then-read gap.
    4. Claim authorization must mirror existing checks (`advisor-records.ts:52`, `:256-260`, `:494`,
       `:500`, `:556-560`). Refuse `evidenceKeep` after a response exists, or the response-time
       manifest hash can diverge from what `advisorGet` later surfaces.
    5. Publish the file set as one unit: `publishExclusive` is per-file (`advisor-records.ts:198-212`),
       so partial failure leaves a partial directory. Stage, write manifest last, publish atomically,
       and refuse a second `evidenceKeep`.
    6. Enforce path count up front and size while copying. `readFile` refuses non-UTF-8
       (`service.ts:1015-1019`), rejecting legitimate binary evidence.
    7. The snapshot-identity claim is unsupported: evidence follows the snapshot and nothing compares
       `request.snapshot` with the worker's pinned snapshot (`service.ts:686-700`, `:745-776`;
       `advisor-socket.ts:85-92`).
    8. The read surface is unwired: `view()` has no evidence field (`advisor-records.ts:383-424`),
       `StoredResponse` has none (`:103-111`), and `advisorRespond` must read the stored digest, not
       accept one in its payload (`validation.ts:1031`).
    9. Apply permissions with explicit `chmodSync`; umask masks create modes
       (`advisor-records.ts:186-196`; precedent `service.ts:1049-1060`, `:1206-1208`).
  - **Could not verify:** `msb copy` symlink semantics, whether `outputMaxBytes` bounds `copyOut`,
    actual `contentMaxBytes`/`pathMaxBytes` defaults, and A6 (the advisor MCP server and its
    `evidence_keep` tool), which does not exist yet.
  - **Effect:** consequential findings resolved before coding; the A2 plan was revised first. This is
    advisory evidence only, not an approval.
  - **Post-code dispatch #1** — step `post-code`; advisor `advisor-security`; model
    `opencode-go/deepseek-v4.1-flash`; frozen evidence `04322bd`. Found D1–D5: manifest identity
    was worker-controlled HEAD; the size cap had no overflow signal; an evidence/response race;
    non-exclusive publication; and intermediate symlinks were accepted. All were resolved before
    the native review. Advisory evidence, not an approval.
  - **Post-code dispatch #2 (verification)** — step `post-code`; advisor `advisor-security`; model
    `opencode-go/deepseek-v4.1-flash`; frozen evidence `4b51e2e`. Verified D1, D2, D3 and D5
    implemented and effective; D2 additionally confirmed `msb.ts:70-73` accumulates whole chunks,
    so capped reads cannot be mistaken for a short prefix. D4's premise did not hold: `withSessionLock`
    and the same-session claim rule serialize the operation, so the loser refuses at the earlier
    guard and reservation is redundant defence-in-depth, not a live-defect fix. Also noted three
    minor defects and two indistinct tests. Advisory evidence, not an approval.
  - **Correction dispatch** — step `post-code`; advisor `advisor-security`; model
    `opencode-go/deepseek-v4.1-flash`; frozen evidence: correction working tree after `4b51e2e`
    verification (not yet committed). This correction resolves the three minors, the two test-honesty
    points, and adds `baselineRef` coverage. Advisory evidence, not an approval.
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

### A2c review and bounded correction

- **Four-lens review:** APPROVED with authority burned; lineage `review-7c30251f6a95caef`; target `sha256:09f1d05d…`. The approval is consumed; advisory evidence is not approval authority for this correction.
- **Advisories** (each id is scoped by the review lineage above because ids collide across reviews):
  - `R2-001` — fixed: exactly 1 MiB is accepted.
  - `R3-SIZE-OFFBYONE` — fixed: encoded cap has the one-byte overflow signal.
  - `R4-encoded-cap-boundary` — fixed: exact 1 MiB is accepted; the retained decoded-byte guard refuses larger files, including 1 MiB + 1 whose base64 length is unchanged.
  - `R3-RESPOND-MANIFEST-PARSE` — fixed: malformed stored manifests become `PolicyError`.
  - `R2-002` — fixed: grouped regular-file predicate preserves behavior and clarifies precedence.
  - `R3-BOUNDARY-COVERAGE` — fixed: duplicate normalized paths and directories are tested as refusals.
  - `R4-evidencekeep-no-aggregate-deadline` — fixed: one 120-second operation deadline retains per-call timeouts and cleans staging/reservation on failure.
  - `R4-evidence-stranded-state` — remains open and out of scope; crash recovery/sweeping needs a separate recovery design.
- **Correction dispatch** — step `post-code`; this bounded correction implements the seven items above and updates A2 item 3's exact-size contract. Advisory evidence, not approval.
- **TDD evidence:** RED observed `712 pass`, `3 fail`, `Ran 715 tests across 49 files`; failures exposed the exact-size boundary, aggregate deadline, and malformed-manifest parse. GREEN observed `715 pass`, `0 fail`, `3254 expect() calls`, `Ran 715 tests across 49 files. [3.09s]`.
- **Build:** `bun build broker/src/main.ts --target=bun --outfile /tmp/a2c-adv.js` bundled 25 modules; output `a2c-adv.js 0.29 MB (entry point)`.
