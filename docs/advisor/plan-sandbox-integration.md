# Plan A: build the external advisor system (agent-sandbox-integration)

Status: **in progress**. Done: the security core: A0, A1 (`cb29902`), A3 (`8cf78d9`, `0b402f3`) and A4 (relay). Next: A2, A5–A9. Task record: `odd/tasks/external-advisors.md`. Executor: the OpenCode sandbox agents of this repository, following
WORKFLOW.md (ODD tracker first, work-unit commits under the 400-line cap, review per slice).

Most paths here are **S17** (`broker/src/**`, `opencode/plugins/**`, `nono/profile/**`,
`scripts/**`, `tests/security/**`). Agent-produced changes to them are rejected at apply time
until the user reviews them by hand, and the user installs everything. New `advisor/**` paths
are security-enforcing; slice A0 proposes adding them to the S17 list.

Contract: [`interface-contract.md`](interface-contract.md). When to use the system is decided by
[`handoff-workflow-optimisation.md`](handoff-workflow-optimisation.md); this plan builds no
mandate and no gate.

## Facts this plan relies on (verified 2026-10-01)

- **`exec` refuses shell metacharacters** in argv (`broker/src/validation.ts:130–153`). Advisors
  therefore create scripts with worker `writeFile`/`applyPatch`, so those stay allowed inside the
  worker.
- **The worker snapshot is a real commit** (`commit-tree` over a temporary index, so it includes
  uncommitted changes; `broker/src/service.ts` ~690–745).
- **The main socket trusts the caller-supplied `sessionID`.** Advisors therefore need their own
  listener, whose role is set by the listener rather than by the request.
- **gentle-ai behaviour** is as listed in interface-contract §4.
- **The socket drain fix** (81c78cc) is in place, so large frames are delivered whole.

## Prerequisite: finish the socket-drain work (tracker `odd/tasks/socket-write-drain.md`)

Advisors read and write through the same `readFile`/`writeFile` frames that failed on large
files, so they must be reliable first.

- **Done:** slice 1 (T1+T2, the write queues and drain) is committed as `81c78cc`. The installed
  plugin copy has had it since 2026-09-30 23:41, and the broker since its restart on
  2026-10-01 17:26.
- **Update the tracker.** It still says "T1–T6 not started".
- **Re-probe live on a fresh worker:** a small file, then `verify-workflow.sh` (4,770 lines),
  then the small file again, with `sandbox_read` and `sandbox_edit`. The workflow_optimisation
  finding that "`sandbox_read` is broken at any size" came from probes in session
  `ses_f0c117946ffe…`. The broker logged both of its reads as `ok` in 12–16 ms (2026-09-30
  ~20:08Z), before the fix existed. The small read followed the large one on the same
  connection: the large reply was cut off, and the small reply was swallowed with it. Expect it
  not to reproduce. Report the result to workflow_optimisation (see handoff B0).
- **Then do slice 2 (T3)**: refuse partial reads, preserve line endings. Without it an advisor
  could investigate a truncated file without knowing. Slices 3–4 (T4 review fixes, T5/T6) can
  run alongside A1–A3.

## Slices (each one ODD task; behaviour, tests and docs together)

### A0. Tracker and S17 list update
- Create `odd/tasks/external-advisors.md` with task IDs A1–A9 and this plan's acceptance criteria.
- Propose adding `advisor/**` to the S17 list in AGENTS.md. That edit is the user's call.

### A1. Advisor socket and trusted binding (`broker/src/server.ts`, `config.ts`)
- **Done in `cb29902`.** Two design choices made while building it:
  - **One connection is one session.** The broker assigns `advisor-<projectId>-<16 hex>` when the connection opens, and rewrites every request to it. The client sends the placeholder `advisor` (or the assigned id), so it can never name another session. Several sessions means several connections.
  - **The agent is always `external-advisor`**, and `ensureWorker` is pinned to the listener's project.
  - `BROKER_ADVISOR_PROJECTS` (JSON array of registered project ids, default empty) enables the listeners. The advisor-specific operations join the allowlist with A2 and A3.
- **A per-project listener**, `$XDG_RUNTIME_DIR/opencode-sandbox-advisor-<projectId>.sock`
  (0600), configured from broker config and never from requests.
- **Role and project come from the listener.** Each connection gets its own sessions,
  `advisor-<projectId>-<nonce>`; a request for any other session ID is refused.
- **What the advisor socket accepts** (allowlist):
  - worker lifecycle: `ensureWorker`, `workerStatus`, `destroyWorker`;
  - inside the worker: `exec`, `readFile`, `writeFile`, `applyPatch`, `listDir`, `grep`, `diff`;
  - advisor-specific: `resultDiff`, `evidenceKeep`, `advisorRead`, `advisorRespond`.
- **Everything else is refused there**, including every `host_*`, `review*` and `sdd*`
  operation, results, copy, `bindSessionAgent` and `registerProject`.
- **The main socket refuses** advisor-only operations and `advisor-*` session IDs.
- **Tests:** the allowlist in both directions; foreign and other-project session refusal; no
  role spoofing.

### A2. Snapshot pinning, identity and evidence export (`service.ts`, `gitops.ts`)
- **`ensureWorker {snapshot}`** takes `{resultRef}` (`^refs/opencode-sandbox/result/<sid>$`),
  `{commit}` (a full SHA reachable in the project) or `{worktree}`. The value is resolved once
  with `rev-parse --verify <x>^{commit}` and returned as `{commit, tree, source, resultRef?, headSha}`.
- **`resultDiff {ref}`** returns a bounded diff, reusing the apply-preview truncation.
- **`evidenceKeep {requestId, paths[]}`** copies only from `/work/.advisor/` (no symlinks; count
  and size capped). Files go to `<stateDir>/advisor/<project>/evidence/<id>/` with
  `manifest.json` (snapshot identity plus a SHA-256 per file).
- **Tests:** refused refs (`HEAD~1`, arbitrary, another project's); the pinned commit stays
  stable when the ref moves; a working-tree snapshot with uncommitted changes gets a distinct
  commit; evidence path, symlink and size refusals; manifest hashes.

### A3. Advisory records (`broker/src/advisor-records.ts`, new)
- **A3a done** (store, lifecycle, pre-code advice). As built:
  - **Immutability:** request, claim and response are separate files, each published once by an exclusive hard link, so they're immutable at the OS level.
  - **Claiming:** the first advisor session to `advisorRead` claims the request; only that session may `advisorRespond`, once.
  - **Expiry:** status is derived, and an unanswered request expires after 24 h.
  - **Payload:** the payload-key allowlist is what refuses a `token` field.
- **A3b done.** As built:
  - Under the v2 contract the `collect` input, its artifact subject and the lens-context binding share one `subject_hash`, so the broker stores one hash and cross-checks the lens-context against it.
  - There's no changed-path manifest in v2, so inspection-path coverage is left to gentle-ai's preflight.
  - The lineage registry is `broker/src/advisor-lineages.ts`.
  - The reviewer-result pre-check is `broker/src/advisor-reviewer-result.ts`, verified live to agree with `capture-result --preflight` on an accepted result.
- **Operations:**
  - main socket: `advisorAsk`, `advisorGet`, `advisorList`;
  - advisor socket: `advisorRead`, `advisorRespond`.
- **Shapes and lifecycle** follow interface-contract §3. Statuses are `pending`, `claimed`
  (set by the first `advisorRead`), `submitted`, `declined` and `expired` (TTL). Records are
  immutable, and a follow-up gets a new id.
- **For `review-lens` asks, the broker reads the provider values itself:** it calls
  `review status --lineage --next-transition` and `review lens-context` through the existing
  `sddRuntime` executor. It stores `target`, `order`, both subject hashes and the lens-context
  text verbatim. It refuses if the lineage isn't recorded as external-lens (A4) or the lens
  isn't in the `collect` inputs.
- **For `review-lens` responses:** the reviewer JSON must validate against the cached
  `gentle-ai review schema reviewer`. Its `subject_hash` must equal one of the stored hashes,
  and `inspection.paths` must cover the changed-path manifest.
- **What records never do:** accept a `token`, write routing-key or marker paths, or call
  `capture-result`.
- **Selection mechanism** (interface-contract §6):
  - `host: "rotate"` resolves to the least recently used host per project, using a small
    per-project counter in broker state;
  - `selection.rule` is required and recorded;
  - `group` gives first-pass independence: `advisorRead` never returns a sibling's response
    before both are submitted;
  - overrides need a reason and are recorded. The broker holds no policy about which rule
    applies.
- **Tests:** the lifecycle; immutability; expiry; token refusal; schema and subject refusals;
  non-external-lens lineage refusal.

### A4. Review integration (`sdd-service.ts`, `sdd-runtime.ts`)
- **Done**, and verified live end to end against gentle-ai. As built:
  - The caller of a relay supplies only `projectDir` and `inputFromAdvisorResponse`. The broker supplies every capture field, including `--subject-hash` (required by the v2 contract), so mismatches between caller and provider values can't arise.
  - The relay marker lives in `<stateDir>/advisor/<projectId>/relayed/<lineage>.<lens>` and is released when gentle-ai refuses.
  - Module: `broker/src/advisor-relay.ts`.
- **`reviewStart` gains `externalLenses: true`.** It omits `agent` and records the lineage as
  external-lens in broker state.
- **`reviewCaptureResult` gains `inputFromAdvisorResponse`.** For external-lens lineages a
  free-form `input` is **refused**: interface-contract §4 shows gentle-ai trusts submitted
  content. The broker:
  1. re-reads the current `collect` transition;
  2. checks lineage, target, lens and order, and that the subject hash is one of the provider's
     current hashes;
  3. refuses a lens already relayed in this lineage;
  4. stages the stored bytes through the existing private `stagedInput` path;
  5. runs `--preflight`, then the capture.
- **Tests (with a stub runtime):** missing, pending, claimed, declined, expired and nonexistent
  responses are refused; a stale binding (different lens, order or subject) is refused;
  duplicate relay is refused; free-form `input` on an external-lens lineage is refused; the
  existing `input` behaviour is unchanged for other lineages.

### A5. OpenCode host tools (`opencode/plugins/sandbox-tools.ts`)
- **Where they go:** if step P0 of `docs/upgrades/opencode-v2.md` (shared tool table) has landed, define these tools in the
  shared table only; the V1 adapter picks them up, and the late V2 adapter will too. Don't
  write them directly into an adapter.
- **New tools:** `host_advisor_ask`, `host_advisor_get` and `host_advisor_list`, using the
  existing `client()`/`formatResult` pattern and host-authoritative `sessionID`/`agent`.
- **Extended arguments:** `host_review_start` gets `externalLenses`, and
  `host_review_capture_result` gets `inputFromAdvisorResponse`.
- **Approval prompts:** add ask-metadata builders in `lib/host-tool-approval.ts` where the
  existing pattern requires them.
- **The system-prompt rule text says only what the tools do.** When they're mandatory is
  workflow_optimisation's job.
- **Tests:** argument schemas; output formats; no `token` passthrough.

### A6. Advisor MCP server (`advisor/mcp-server.ts`, new; Bun stdio)
- **It connects only to the advisor socket**, whose path the launcher supplies. It reuses
  `opencode/plugins/lib/broker-client.ts`.
- **Tools:**
  - `read_request`, which includes the lens-context text for `review-lens`;
  - `result_diff`;
  - `sandbox_start`, pinned to the request's snapshot;
  - `sandbox_write`, `sandbox_bash`, `sandbox_read`, `sandbox_grep`, `sandbox_list`,
    `sandbox_reset`;
  - `evidence_keep`, `submit_response`.
- **`submit_response`** validates against the reviewer schema before sending.
- **Instructions:** write scripts under `/work/.advisor/`; keep evidence before submitting;
  never claim results that weren't observed.
- **Tests:** the tool allowlist; schema pre-validation; that it never connects to the main socket.

### A7. Claude Code launcher and configuration (`advisor/hosts/claude/`, `advisor/advisor-open`)
- **Gate first: prove configuration isolation.** A dedicated `CLAUDE_CONFIG_DIR` with its own
  subscription login must load **no** user hooks, plugins, memory or MCP servers. Prove it before
  any live launch.
- **Configuration:**
  - `settings.json` denies `Edit`/`Write`/`NotebookEdit`/`Bash`/`WebFetch`/`WebSearch` and
    credential `Read` paths;
  - a PreToolUse allowlist hook;
  - `--strict-mcp-config` with only the advisor server.
- **`advisor-open <id>`** `exec`s the **interactive** CLI under nono. The user types the first
  message; nothing injects or automates prompts.
- **It opens the request's resolved host.** `--host <h> --override-reason <text>` records a user
  override through the broker; it's refused without a reason.

### A8. Antigravity configuration (`advisor/hosts/agy/`)
- **Gate first: agy configuration isolation.** If its config root can't be isolated from
  `~/.gemini/config/{hooks.json,plugins}`, this slice doesn't ship.
- **Agent file:** `asi-external-advisor.md`, whose `tools:` lists only `view_file`,
  `grep_search`, `find_by_name`, `list_dir` and the MCP tools. Never
  `--dangerously-skip-permissions`.

### A9. Confinement and gated tests (`nono/profile/advisor-{claude,agy}.json`, `tests/security/`)
- **Profiles:**
  - the project read-only;
  - the dedicated config directory read-write;
  - only that project's advisor socket (the main socket and the broker state directory are
    denied);
  - only the provider's API on the network.
- **Gated tests:** the security suite gets advisor-socket cases. An integration test against a
  scratch repo with real gentle-ai (`SANDBOX_GATED_TESTS=integration`) covers:
  1. an external-lens review started;
  2. an advisor response relayed and admitted;
  3. a CRITICAL finding leading to `correction_required`;
  4. clean lenses leading to `approved`, then acknowledgement, then `assess` reporting
     `already_reviewed`;
  5. a new commit leading to `review_due`, with the old response refused.

## Acceptance (for the user's manual gate)

1. An OpenCode orchestrator on an ODD task starts an external-lens review and asks for one
   `review-lens` request per lens.
2. The user opens `advisor-open <id>` and prompts it. The advisor writes a **new** diagnostic
   script in `/work/.advisor/`, runs it against the pinned snapshot, keeps the evidence and
   submits a schema-valid result.
3. The orchestrator relays it with `inputFromAdvisorResponse`, and gentle-ai adjudicates.
4. The host project is unchanged. The advisor can't edit files, run host Bash, read
   credentials or reach the main socket.
5. **None of these satisfy anything:** a missing, failed, stale or unresolved response, or one
   submitted for a changed candidate. Valid responses progress only through gentle-ai's
   approval, acknowledgement and `assess`.

## Order and dependencies

- Prerequisite (drain re-probe and slice 2), then A0 → A1 → A2 → A3 → A4 → A5 → A6 → A7 → A8 →
  A9.
- **Where this sits in `docs/TODO.md`:** Tier 2 (it blocks the workflow-wide advice mandate).
  It comes after the drain prerequisite, and doesn't depend on the other Tier 2 items.
- **Pre-code-advice requests** need only A1–A3, A5, A6 and A7 or A8. Agentless review (A4) can
  follow without blocking advice.
- A3–A5 freeze the interface contract. Tell workflow_optimisation when A5 is installed, because
  their B2–B4 depend on the tool names.
