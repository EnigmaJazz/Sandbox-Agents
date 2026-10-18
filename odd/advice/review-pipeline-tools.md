# Pre-code advice record — review-pipeline-tools

Change: host review-pipeline tools for the secure orchestrator (materialize, pipeline phases, persist).
Advice step: `pre-code`.
Recorded: 2026-10-17.

## Why this record exists
`WORKFLOW.md` requires a durable pre-code advice record at `odd/advice/<change>.md` for a substantial route. This change's earlier units were implemented before the record existed; it is created now and covers the advice obtained across the change, including the final surfacing slice. A unit lacking this record is a blocked gate, not a skipped one.

## Pre-code advisors dispatched (final surfacing slice, U3c)
| Advisor | Model | Scope of question |
|---|---|---|
| `advisor-integration-pre` | `opencode-go/kimi-k2.7-code` | the two plugin tools, the approval plumbing, the permission fragment, the client timeouts, and cross-component deployment |
| `advisor-security-pre` | `openai/gpt-6.1-sol` | the approval boundary, what persist writes into the project, containment, ignore provisioning, and the helper trust boundary |

Both were dispatched in parallel against frozen evidence; neither saw the other's answer.

## Findings recorded
### must-fix — integration
1. Add `host_review_pipeline_run` and `host_review_persist` beside `host_review_materialize` (`opencode/plugins/sandbox-tools.ts:735-765`) following the same shape: zod args, `currentProjectDirectory(ctx.directory)`, `c.request(op, ctx.sessionID, payload, ctx.agent)`, JSON on success, thrown error preserving the broker code.
2. `host_review_persist` requires an approval ask: add `"reviewPersist"` to the `HostMutationOperation` union (`opencode/plugins/lib/host-tool-approval.ts:20-37`), add a `buildReviewPersistAsk` builder modelled on the existing ones, and `await ctx.ask(...)` before the broker call. The ask's permission string must be exactly `"host_review_persist"` to match the fragment entry (`host-tool-approval.ts:47-52`).
3. Fragment entries: `"host_review_pipeline_run": "allow"` and `"host_review_persist": "ask"` (`opencode/config-fragments/sandbox-permissions.jsonc:82` for the allow precedent; `:95-108` for the ask precedent).
4. Add `OPERATION_TIMEOUT_MS` entries at 60_000 for both operations (`opencode/plugins/lib/broker-client.ts:102-123`); both currently inherit the 30s default while the broker's helper budget is exactly 30s (`broker/src/review-pipeline.ts:125`, `broker/src/review-persist.ts:126`).
5. Bibliographic note only: no agent-level tool allowlist or extra session-binding code is required; the broker authorizes from the stored session agent (`broker/src/service.ts:176-191`).

### must-fix — security
6. Do not expose persist before its project-write containment is race-resistant. The static checks are sound (32-hex `runId`, destination beneath the approved root, existing components must be non-symlink directories), but they precede awaited git execution and are then followed by pathname-based temp creation and rename (`broker/src/review-persist.ts:35-65,75-104`), so a concurrent writer could replace a checked ancestor with a symlink during that interval. Recommended: directory-handle-relative no-follow containment, or another mechanism that closes the window; a further `lstat` does not.
7. Define what persistence approval actually authorizes, and keep caller-controlled `projectDir` out of the tool schema. Persist creates directories, may replace `.context/.gitignore`, and may rename a summary over an existing target, and artifact validation happens AFTER publication (`broker/src/review-persist.ts:30-34,47-72,84-111`). The approval prompt should name the canonical project, the run, the source reference, the overwrite behaviour and the possible ignore-file change; and a denial must produce zero dispatches.
8. Do not equate a PATH-only child environment with helper confinement. The spawn is an ordinary spawn with no filesystem restriction (`broker/src/msb.ts:119-136`); the digest and interpreter checks establish which executable runs, not what it may read or write. The unapproved pipeline boundary therefore rests on trusted helper and interpreter behaviour, and that trust boundary should be stated explicitly rather than implied.

### should-fix
9. Bind a run to its project and prove finalize provenance: the service synthesizes `outcome: "accepted"` from whatever artifact the caller names, and the read path enforces name grammar, containment, no-follow and size but not phase provenance (`broker/src/service.ts:3632-3648`; `broker/src/review-run.ts:993-1063`). A same-session run in allowlisted project A could be persisted into allowlisted project B.
10. Treat ignore provisioning as a separate, non-transactional project mutation: it can fail after replacing the ignore file without undoing that replacement, its appended rule covers all of `systematic/ce-review/`, and a concurrent ignore edit can be lost.
11. Mirror the broker's validation in the plugin zod schemas for earlier, clearer errors (not required for safety, since the broker fails closed).
12. Do NOT add `reviewPipelineRun` to `HostMutationOperation`; that union is for approval-gated operations only.
13. Preserve broker identity authorization for the new mutations and do not reclassify them as open reads merely because their outputs live in broker state.

## Answer to the frozen question ("what is wrong or missing in this approach, what should change before implementation, and what evidence supports that?")
The surfacing plan was mechanically correct but incomplete in three ways that matter: the persist tool needs an approval gate whose permission string matches its fragment entry; persist must not be exposed while its project-write containment has a check-then-write window; and the approval must describe the authority it actually grants rather than just "writes a summary". The evidence is the cited code paths.

## Status
Consequential findings are resolved before coding: the surfacing proceeds, and the persist exposure is held behind the containment and approval-scope work (see the tracker's Progress for the slicing decision).

## Post-code correction findings

Both post-code advisors agreed that `host_review_pipeline_run` should remain `allow`, not ask-gated. Its writes are broker-owned run-store artifacts and never project content; the broker-side orchestrator-identity gate is the primary control. The residual risk is that a misbehaving orchestrator can consume process spawns and the per-session run quota without a prompt: this is a resource risk, not a project-mutation risk. This is consistent with the `host_review_materialize` precedent.

The advisors also verified two properties as correct and not worth re-litigating: the persist path asks before dispatching the broker request, and project location is derived from `ctx.directory` rather than accepted as caller-controlled input.

- MUST-FIX (both advisors, converged): include `mode` in the persist approval request and make write/report-only summaries accurately describe project writes and validation. Disposition: implemented; tests cover both phrasings and preserve the exact `host_review_persist` permission.
- SHOULD-FIX (both advisors): state the pipeline run's materialize/run-directory prerequisite in the tool description. Disposition: implemented and covered by a description assertion.
- SHOULD-FIX (both advisors): replace the plan-append docstring on `buildReviewPipelineRunOp`. Disposition: corrected as a one-sentence description; no behavior changed.

### Follow-up review finding — persist project binding

- **`R3-unbound-project-persist` disposition: not fixed in this slice.** No cheap in-band pre-check exists in the current surfaces: the plugin has only the session's current `ctx.directory`, while the run's originating project binding is held by broker-owned run metadata. The plugin cannot read that metadata without adding a broker operation/tool, and passing a caller-supplied project would not establish a trusted binding. The broker's existing `review_persist_project_mismatch` refusal remains the control, but it occurs after approval. The approval's `projectDir` therefore reflects the session's current directory; the residual risk is an approval that names a project the broker will then refuse. Evidence: `host_review_persist` computes `projectDir` from `ctx.directory` and places it in both approval metadata and the request payload (`opencode/plugins/sandbox-tools.ts`); broker `reviewPersist` checks the recorded run's project against the requested project and throws `review_persist_project_mismatch` (`broker/src/service.ts`).

## External advisory evidence — owner-supplied reviews

The owner supplied two independent external reviews in-session. Selection rule: two independent engines, first pass, no cross-visibility; the owner supplied the reviews. Their verbatim responses are not reproduced here: a recorded response is never edited, and a partial transcription would itself be an edit. The index below records finding IDs and dispositions only.

### Claude

- F1 validator exit codes — **NEEDS PROBE**.
- F2 publish-before-validate — **CONFIRMED; fixed here** by validating staged evidence before any project artifact publication.
- F3 ignore temp not fsynced — **open**.
- F4 concurrent persists lose updates — **open**.
- F5 HOME set to project root — **CONFIRMED**.
- F6 advisory cluster — **open**.
- F7 helper source writable so the digest pins attacker bytes — **NEEDS PROBE; highest severity**.
- F8 interpreter resolved after `broker.env` overwrite — **open**.
- F9 interpreter path breaks on brew upgrade — **open**.
- F10, F11, F12 advisories — **open**.
- F13 approval proves acceptance, not a review — **open**.
- F14 relocating the store is insufficient on LEAK — **open**.

### Antigravity

- F-01a chained input cap, F-01b screen collision, F-01c accounting bypass — **CONFIRMED and fixed in this work**.
- F-02 publish-before-validate — **CONFIRMED; fixed here** by staging under the broker run store and publishing only after `passed`.
- F-03 HOME=root — **CONFIRMED**.
- F-04 anchor opened across awaits — **CONFIRMED; guard installed**.
- F-05 helper discovery path and missing-key verify — premise **REFUTED** (`$HOME/.cache/opencode/packages` exists and has no `node_modules` entry); missing-key sub-claim **UNVERIFIED**.
- F-06 helper errors thrown rather than mapped — **open**.
- F-07 control directory in the allowlist — **CONFIRMED, out of scope** (pre-existing profile decision).
- F-08 provenance bypass and post-approval artifact swap — **open**.
- F-09 what is correct and must not change — recorded as advisory guidance, not a defect finding.
