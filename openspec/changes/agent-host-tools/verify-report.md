```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:16cd05ea9835822018b7154a4e946dc4a2968e9baae41785050875cf0023d174
verdict: pass
blockers: 0
critical_findings: 0
requirements: 16/16
scenarios: 61/61
test_command: env -C broker bun test
test_exit_code: 0
test_output_hash: sha256:0599f525493cf0f5b4ac2375782e975dd1b97a9593cfa8e6e3328f95c98076cf
build_command: env -C broker bun build --target=bun --outfile=/tmp/broker-main.js src/main.ts
build_exit_code: 0
build_output_hash: sha256:0cea45a47f77dc334bb1f78743bb8d8c5cc72048d3b0472400afbb7df49ce77e
```

## Verification Report

### Change and Scope

- Change: `agent-host-tools`
- Persistence mode: `hybrid` (OpenSpec plus Magic Context)
- Verification mode: standard (`strict_tdd: false`)
- Evidence revision: `sha256:16cd05ea9835822018b7154a4e946dc4a2968e9baae41785050875cf0023d174`
- Scope re-verified: Correction D1, Correction C6, corrections C1-C5, remediation G1-G4, and the complete proposal/spec/design/task implementation surface.
- Tasks 5.1-5.6 are under `## Phase 5: Acceptance & Carry-forward (operator-owned)`. They remain untouched, are outside verification scope, and are not verification blockers. Native status therefore mechanically reports 64/70 checked tasks, while all implementation and verification tasks in scope are complete.
- Worker-side `gentle-ai` / `sdd-verify-validate` was intentionally not invoked. Host validation is orchestrator-owned after persistence and its worker absence is not a blocker.

### Completeness

| Dimension | Result | Evidence |
|---|---|---|
| Proposal | PASS | `proposal.md` was read. |
| Specifications | PASS | All seven delta specs were read and their headings recounted: 16 requirements and 61 scenarios. |
| Design | PASS WITH DOCUMENTED DEVIATIONS | `design.md` and the accepted placement/output deviations recorded in `apply-progress.md` were read. Correction D1 is documented at `design.md:239-243`. |
| Tasks | PASS | All implementation and verification tasks are checked. The six unchecked Phase 5 items are explicitly operator-owned delivery steps outside this verification scope. |
| Runtime evidence | PASS | The broker tests, broker build, and plugin build were executed in this sandbox worker and all exited 0. |
| Coverage | NOT CONFIGURED | No coverage command or threshold is declared by the project. |

### Heading Recount

| Specification | Requirements | Scenarios |
|---|---:|---:|
| `host-sdd-runtime-tools` | 7 | 35 |
| `host-plan-doc` | 1 | 9 |
| `host-review-tools` | 2 | 6 |
| `host-tool-authorization` | 2 | 4 |
| `host-git-tools` | 2 | 3 |
| `host-project-registration` | 1 | 2 |
| `host-gh-tools` | 1 | 2 |
| **Total** | **16** | **61** |

No `### Requirement` or `#### Scenario` heading was added, removed, or renamed by Correction D1.

### Command Evidence

Hashes are SHA-256 over the captured stdout bytes followed by the captured stderr bytes for a fresh execution of the displayed argv.

| Command | Exit | Exact evidence |
|---|---:|---|
| `env -C broker bun test` | 0 | **349 pass / 0 fail**, 1537 `expect()` calls, 15 files. Captured output digest: `sha256:0599f525493cf0f5b4ac2375782e975dd1b97a9593cfa8e6e3328f95c98076cf`. |
| `env -C broker bun build --target=bun --outfile=/tmp/broker-main.js src/main.ts` | 0 | Bundled **17 modules**; `broker-main.js` 212.0 KB. Captured output digest: `sha256:0cea45a47f77dc334bb1f78743bb8d8c5cc72048d3b0472400afbb7df49ce77e`. |
| `bun build --external @opencode-ai/plugin --external zod --outfile=/tmp/plugin-check.js opencode/plugins/sandbox-tools.ts` | 0 | Bundled **10 modules**; `plugin-check.js` 1.0 MB. Captured output digest: `sha256:78b4f0e463e57356682446143a0964ba0e6a4ad38cc1889d2da6da7a68f42c23`. |
| Live `SANDBOX_GATED_TESTS` suites | not run | Gates 0-10 remain operator-owned and were not self-certified. |

### Correction D1 Re-verification

#### `reviewLensContext` fixed read transport

| Check | Source/spec evidence | Passing runtime evidence | Result |
|---|---|---|---|
| Operation and payload registration | `broker/src/types.ts:64,134,358-363,515-523` registers `reviewLensContext`, the four-value `ReviewLens`, and the exact payload. `broker/src/validation.ts:750-760,900-907` classifies it in `HOST_READ_OPERATIONS` and allowlists its exact keys. | `broker/tests/validation.test.ts:950+` verifies read classification, exact keys, and the four-value lens domain. | PASS |
| Exact fixed argv | `broker/src/sdd-runtime.ts:694-729` validates `repositoryContext`, `lineage`, and `target` with `assertReviewToken`, `expectedRevision` with the SHA-256 validator, and `lens` with `assertReviewLens`, then emits exactly `gentle-ai review lens-context --cwd <root> --repository-context <h> --lineage <l> --target <t> --expected-revision <r> --lens <lens>`. | Passing tests at `broker/tests/sdd-runtime.test.ts:1672-1710`: exact argv with verbatim tokens and rejection of bad lens/revision/flag-like tokens/extra keys. | PASS |
| Raw plain-text execution | `broker/src/sdd-runtime.ts:1272-1298` resolves the canonical project root and executes through `runRaw`; the multi-line `GENTLE_AI_REVIEW_CONTEXT ... END` block is not JSON-parsed. | `broker/tests/sdd-runtime.test.ts:1712+` passes: `review lens-context executor returns the plain-text block without JSON parsing`. | PASS |
| Service and dispatch | `broker/src/sdd-service.ts:156-168` authorizes and forwards all six bound fields; `broker/src/server.ts:416+` dispatches the operation. | `broker/tests/service-host-tools.test.ts:799-833` proves the read is open to a non-orchestrator, forwards all fields, and rejects undeclared/missing fields. | PASS |
| Plugin read surface | `opencode/plugins/sandbox-tools.ts:605+` exposes `host_review_lens_context`; `opencode/config-fragments/sandbox-permissions.jsonc:81` marks it `allow`. It has no mutation approval builder or `ctx.ask`. | The full tests `reads are open to every agent` and `every read operation runs for a non-orchestrator agent` pass. | PASS |
| Client timeout | `opencode/plugins/lib/broker-client.ts:64-87` assigns `reviewLensContext: 130_000`. | `broker/tests/host-tool-approval.test.ts:509-511` verifies 130 seconds and greater than the 30-second read default. | PASS |

#### Inline `reviewCaptureResult.inputJson`

| Check | Source/spec evidence | Passing runtime evidence | Result |
|---|---|---|---|
| Type and exact-key allowlist | `broker/src/types.ts:385-399` adds `inputJson?: string`; `broker/src/validation.ts:977-978` adds it to the exact `reviewCaptureResult` allowlist; `broker/src/sdd-service.ts:419-445` forwards it. | Service test `review capture-result forwards the inline inputJson body` passes. | PASS |
| Validation and mutual exclusion | `broker/src/validation.ts:1410-1428` requires a non-empty, valid JSON string, bounded by `REVIEW_INPUT_MAX_BYTES`, NUL-free, while permitting LF. `broker/src/sdd-runtime.ts:1506-1523` rejects simultaneous `input` and `inputJson` and validates/stages the inline body. | `broker/tests/sdd-runtime.test.ts:1775+` rejects both-present, empty, non-JSON, NUL-bearing, and oversized bodies before spawn; `broker/tests/validation.test.ts:950+` passes the focused validator cases. | PASS |
| Private exact-byte staging | `broker/src/sdd-runtime.ts:1982-1985,2026-2054` sets the 512 KiB cap, encodes the exact UTF-8 body, creates `${stateDir}/review-input/` mode `0700`, opens a random snapshot with `O_CREAT|O_EXCL|O_WRONLY` mode `0600`, writes and fsyncs it. | `broker/tests/sdd-runtime.test.ts:1744+` passes: exact private bytes are observed, LF is preserved, mode is `0600`, and the snapshot is deleted after execution. | PASS |
| Cleanup on every terminal path | `broker/src/sdd-runtime.ts:1524-1543` wraps execution in `try/finally` and best-effort unlinks every staged non-stdin snapshot. | The inline staging/cleanup test passes; the pre-existing staged-input timeout/spawn/cleanup tests also pass. | PASS |
| Approval metadata does not expose body | `opencode/plugins/sandbox-tools.ts:1068-1091,1335-1344` derives only UTF-8 byte count and a short SHA-256 digest; `opencode/plugins/lib/host-tool-approval.ts:696-733` includes only `inputJsonBytes` and `inputJsonDigest` in metadata. | `broker/tests/host-tool-approval.test.ts:493-502` passes: `review capture-result ask surfaces inline byte count and digest only`. | PASS |

#### D1 specification alignment

- `specs/host-review-tools/spec.md:7-18,24-28` now defines nine orchestrator-only review mutations plus the prompt-free `reviewLensContext` read, its exact fixed argv/raw-text behavior, the four-value lens enum, and the inline `inputJson` validation/staging contract.
- `specs/host-tool-authorization/spec.md:16` now enumerates **nine reads**: `sddStatus`, `sddContinue`, `sddVerifyValidate`, `sddTaskResult`, `reviewAssess`, `reviewModeStatus`, `reviewStatus`, `reviewLensContext`, and `sddAttemptStatus`.
- `design.md:239-243`, `tasks.md:155-160`, and `apply-progress.md:650-677` describe the same D1 transport, staging, timeout, permissions, and count-neutral spec updates.

### Earlier Correction Re-verification: G1-G4

| Gap | Spec and implementation evidence | Runtime evidence | Result |
|---|---|---|---|
| G1 - begin untracked declaration | `sddAttemptBegin` types/allowlists include `untrackedScope`, `expectedUntrackedInventory`, and `intendedUntracked`; the fixed builder uses the shared untracked declaration append; service, executor, plugin, and ask metadata preserve it. | Passing exact-argv, coupling rejection, service forwarding, and approval-metadata tests. | PASS |
| G2 - settle remediation revision | `sddAttemptSettle` includes `remediatesEvidenceRevision`; the fixed builder validates and emits `--remediates-evidence-revision` before any untracked declaration; every layer forwards it. | Passing exact-argv, omission, malformed-revision, executor/service forwarding, and approval tests. | PASS |
| G3 - review-status passthrough | `reviewStatus` includes `lineage`, `repositoryContext`, and `projection`; the builder emits them after `--agent` and before `--next-transition`; the read remains prompt-free. | Passing exact-order, unchanged-envelope, service-forwarding, and allowlist tests. | PASS |
| G4 - capture-result order 0..32 | Broker validation, runtime argv, plugin schema, and approval metadata accept integer 0 through 32 and reject values outside the range. | Passing lifecycle argv, validator, and ask-metadata tests include order zero. | PASS |

### Earlier Correction Re-verification: C1-C5

| Task | Spec and implementation evidence | Runtime evidence | Result |
|---|---|---|---|
| C1 - RED-first coverage | Runtime, validation, and service tests cover exact argv position, verbatim bytes, allowlisting, and fail-closed rejection for `intendedUntrackedSelection`. | All focused tests pass in the 349-test suite. | PASS |
| C2 - payload and validation | `ReviewStatusPayload` and the exact-key allowlist include `intendedUntrackedSelection`; validation requires non-empty JSON, at most 65536 bytes, control-free, and not flag-like. | Empty, non-JSON, oversized, control-bearing, and flag-like cases reject. | PASS |
| C3 - fixed argv transport | Exactly one `--intended-untracked-selection <json>` pair is emitted after `--projection` and before `--next-transition`, without re-serialization. | Passing argv test preserves unusual JSON spacing byte-for-byte. | PASS |
| C4 - plugin pass-through | `host_review_status` exposes and forwards the optional string unchanged while remaining a prompt-free read. | Service forwarding and authorization matrix tests pass. | PASS |
| C5 - artifact alignment | Spec, scenario, design, tasks, and apply progress describe one consistent transport. | Recount remains 16 requirements / 61 scenarios. | PASS |

### Earlier Correction C6 Re-verification

| Change | Source/spec evidence | Passing runtime evidence | Result |
|---|---|---|---|
| Canonical registration validation and banned-root defense | `broker/src/validation.ts:596-642` validates lexical and canonical absolute paths, resolves with `realpathSync`, repeats root/`$HOME`/banned-root checks, requires a directory, and returns the canonical path. | Validation tests prove an eligible canonical directory is returned and symlink aliases to `$HOME/.ssh` and `/etc` reject. | PASS |
| Shell-active-byte rejection | `broker/src/validation.ts:578,624-631` rejects `$`, backtick, backslash, double quote, and `!` before a path can reach sourced launcher configuration. | Tests reject directories containing each shell-active byte. | PASS |
| Canonical path forwarded | `broker/src/service.ts` consumes the validator's returned canonical path and appends only that value to the fixed registration argv. | Exact fixed-argv service and canonical-return tests pass. | PASS |
| Protocol stdout preserved | `broker/src/sdd-runtime.ts` preserves protocol stdout under the spawn cap and applies `capAndRedact` only to stderr/diagnostics for token-bearing lifecycle calls. | Finish and review tests preserve secret-shaped provider tokens byte-for-byte in stdout. | PASS |
| Stderr redacted and capped | Review stderr passes through redaction before the 512 KiB cap. | Focused tests prove both redaction and the exact cap. | PASS |
| Amended review output contract | `specs/host-review-tools/spec.md:28` requires verbatim protocol stdout and redacted/capped stderr. | The same passing lifecycle output tests directly cover the amended requirement. | PASS |

### Authorization and Approval Audit

| Operation set | Broker authorization | Fragment permission | In-tool behavior | Result |
|---|---|---|---|---|
| Core mutations `registerProject`, `sddAttemptAcquire`, `sddAttemptSettle`, `sddArchiveCompose`, `gitCommit`, `gitPush`, `ghIssueCreate`, `planDocAppend` | Orchestrator-only. | Matching `host_*` entries are `ask`. | Matching plugin paths await metadata-rich `ctx.ask`. | PASS |
| Nine review mutations | Orchestrator-only. | All nine entries are `ask`. | All nine await matching approval builders with `always: []`. | PASS |
| Additional ledger mutations `sddAttemptBegin`, `sddAttemptRescope`, `sddAttemptFinish`, `sddAttemptReset`, `sddAttemptGrant` | Orchestrator-only. | All five entries are `ask`. | All five await matching approval builders. | PASS |
| Nine reads `sddStatus`, `sddContinue`, `sddVerifyValidate`, `sddTaskResult`, `reviewAssess`, `reviewModeStatus`, `reviewStatus`, `reviewLensContext`, `sddAttemptStatus` | Open to every agent through `HOST_READ_OPERATIONS`. | Every matching key is `allow`. | Their plugin paths do not call `ctx.ask`. | PASS |

The runtime tests `every mutation is refused for a non-orchestrator agent` and `every read operation runs for a non-orchestrator agent` passed. Broker session identity remains authoritative over an envelope agent claim.

### Behavioral Compliance Matrix

#### `host-gh-tools` - 1 requirement, 2 scenarios

| Scenario | Status | Passing evidence |
|---|---|---|
| Valid issue | PASS | Exact `gh issue create --repo --title --body` argv and canonical-root service spawn tests. |
| Invalid issue | PASS | Malformed/oversized value and undeclared-key rejection before spawn. |

#### `host-git-tools` - 2 requirements, 3 scenarios

| Scenario | Status | Passing evidence |
|---|---|---|
| Commit result | PASS | Explicit B-to-C path stage/commit tests; empty/protected/unsafe paths reject. |
| Unsafe push | PASS | Detached, missing-upstream, protected-branch, force/delete/lease/refspec cases reject before push. |
| Secret output | PASS | Redaction-before-512-KiB-cap test. |

#### `host-plan-doc` - 1 requirement, 9 scenarios

| Scenario | Status | Passing evidence |
|---|---|---|
| Exact document mapping | PASS | Enum maps only `todo` and `plan`. |
| Append preserves content | PASS | Existing bytes, atomic append, heading insertion, concurrency, and cleanup tests. |
| Unknown document | PASS | Unknown enum rejects without write. |
| Traversal or absolute document | PASS | Path-shaped enum values reject without write. |
| Oversized content | PASS | Trimmed 16-KiB bound test. |
| Control-character content | PASS | LF-only content validation test. |
| Protected destination | PASS | Protected target rejects before write. |
| Non-orchestrator caller | PASS | Mutation-denial matrix and plan-specific authorization test. |
| Approval required | PASS | Fragment `ask`, awaited document-specific ask, and no-auto-approval metadata test. |

#### `host-project-registration` - 1 requirement, 2 scenarios

| Scenario | Status | Passing evidence |
|---|---|---|
| Eligible project | PASS | Canonical target validation/return plus exact fixed registration argv test. |
| Banned registration | PASS | Lexical/canonical banned-root checks, symlink-to-banned rejection, shell-active-byte rejection, invalid flag coupling, undeclared keys, and non-orchestrator calls reject without spawn. |

#### `host-review-tools` - 2 requirements, 6 scenarios

| Scenario | Status | Passing evidence |
|---|---|---|
| Exact argv for every operation | PASS | Exact vectors for all nine review mutations; order `0..32`; D1 exact fixed `reviewLensContext` read vector and raw text execution also pass. |
| Unknown payload key for every operation | PASS | Exact-key allowlists and service rejection tests, including lens-context and inline capture. |
| Invalid value for every operation | PASS | Enum, token, ref, order, hash, JSON, boolean, coupling, and path tests; D1 rejects invalid lens/revision/tokens and invalid inline JSON. |
| Verbatim token passthrough for every token-bearing operation | PASS | Provider bytes and positions remain unchanged; protocol stdout tokens survive byte-for-byte; lens-context uses the raw path. |
| Non-orchestrator denied for every operation | PASS | Full review-mutation denial matrix passes; the separate D1 read is correctly open to every agent. |
| Approval prompt for every operation | PASS | Nine mutation fragment `ask` entries and awaited metadata builders pass; D1 read is intentionally `allow`/no-prompt. Inline metadata contains only count and digest. |

#### `host-sdd-runtime-tools` - 7 requirements, 35 scenarios

| Requirement / scenario group | Status | Passing evidence |
|---|---|---|
| Fixed P0 commands (8 scenarios) | PASS | Exact status/continue/acquire/settle/archive/verify/task-result/assess/mode-status/review-status vectors; acquire/settle/begin declarations; review-status passthrough and intended-untracked-selection transport. |
| Rescope (5 scenarios) | PASS | Exact objective argv, unchanged positive caps, exact-key/revision/text rejection, and mutation approval. |
| Begin (4 scenarios) | PASS | Exact argv, optional untracked tail, exact-key/revision rejection, and mutation approval. |
| Status (3 scenarios) | PASS | Exact read argv, tolerant raw output, exact-key rejection, and prompt-free access. |
| Finish (5 scenarios) | PASS | Exact optional order, outcome/evidence coupling, text validation, token-free active finish, and mutation approval. |
| Reset (5 scenarios) | PASS | Exact argv/relation forwarding, value rejection, relation cases, and mutation approval. |
| Grant (5 scenarios) | PASS | Repeated-root order, optional initial revision, root bounds, value rejection, and mutation approval. |

#### `host-tool-authorization` - 2 requirements, 4 scenarios

| Scenario | Status | Passing evidence |
|---|---|---|
| Untrusted input | PASS | Canonical roots, exact keys, registration canonicalization, and unsafe argument/path/hash/enum rejection before spawn. |
| Mutation | PASS | Full mutation list is orchestrator-only, fragment-`ask`, and protected by awaited metadata-rich `ctx.ask`. |
| Plan document approval | PASS | Document-specific metadata and no-auto-approval behavior. |
| Other caller | PASS | Full matrix passes with **nine** reads open/prompt-free and every mutation denied to non-orchestrators. |

### Correctness and Design Coherence

| Check | Result | Evidence |
|---|---|---|
| Fixed argv and no shell dispatch | PASS | Exact argv builders and direct vector spawning across SDD, review, D1 lens context, git, GitHub, and registration. |
| Canonical root and declared-key boundary | PASS | Root equality, registration canonicalization, repeated banned-root checks, shell-active-byte rejection, and exact payload-key tests. |
| Authorization split | PASS | Mutations remain orchestrator-only; the complete nine-read set is open and prompt-free. |
| Approval split | PASS | Mutation fragment entries remain `ask`; matching plugin paths await metadata-rich approval. D1's read correctly has neither. |
| D1 spec/code alignment | PASS | Fixed lens argv, raw-text path, exact validators, read classification, plugin permission, 130-second timeout, inline staging/cleanup, and metadata privacy all agree with amended specs. |
| G1-G4 alignment | PASS | Specs, runtime builders, types, allowlists, forwarding, and tests agree. |
| C1-C5 alignment | PASS | Schema-bound review-status selection is validated, forwarded exactly once without re-serialization, exposed as a read, and covered at runtime. |
| C6 registration hardening | PASS | Canonical forwarding, repeated banned-root checks, directory validation, and shell-active-byte rejection pass focused tests. |
| C6 protocol output handling | PASS | Spec, executor, and tests agree on verbatim protocol stdout plus redacted/capped stderr. |
| Rollback and manual gates | PASS | No live configuration was changed; Gates 0-10 and S17 manual review remain operator-owned. |
| Plan-document helper placement | ACCEPTED DEVIATION | Implemented in `broker/src/service.ts`, documented in `apply-progress.md`, behavior passes. |
| Review runtime placement | ACCEPTED DEVIATION | Implemented table-first in `broker/src/sdd-runtime.ts`, documented in `apply-progress.md`, behavior passes. |

### Issues

#### CRITICAL

None.

#### WARNING

1. Live gated git/GitHub and installed-binary lifecycle probes were not run because their host prerequisites and Gates 0-10 are operator-owned.
2. CLI-owned state semantics and carried-forward binary-contract open questions remain outside broker-unit verification; fixed argv, validation, authorization, approval, staging, and passthrough behavior are covered.
3. S17 implementation paths still require explicit maintainer manual review before acceptance. This verification changed only `verify-report.md`.
4. Native status includes six unchecked Phase 5 operator/delivery tasks; the phase-specific scope explicitly excludes them from verification completion.

#### SUGGESTION

1. Reconcile stale design/task wording that names separate `plan-doc.ts` and `review-runtime.ts` files when artifact-only cleanup is authorized; `apply-progress.md` already records the accepted implementation locations.

### Final Verdict

**PASS WITH WARNINGS** - all 349 tests pass, the broker build bundles 17 modules, the plugin build bundles 10 modules, all 16 requirements and 61 scenarios have passing runtime/source evidence, Correction D1 is coherent across source/tests/specs, and C6, C1-C5, and G1-G4 remain satisfied. Tasks 5.1-5.6 and manual Gates 0-10/S17 remain untouched and operator-owned.
