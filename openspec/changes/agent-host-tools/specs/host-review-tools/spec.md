# Delta for Host Review Tools

## ADDED Requirements

### Requirement: Fixed review lifecycle operations

The broker MUST expose the following nine `gentle-orchestrator`-only MUTATIONS plus one READ (`reviewLensContext`). Each payload MUST allow exactly the listed keys, and argv MUST use the displayed order with absent optional values omitted and list flags repeated in payload order.

- `reviewStart {projectDir,agent?,contract?,target?,projection?,focus?,untrackedScope?,expectedUntrackedInventory?,intendedUntracked?,baseRef?,committedOnly?,workspaceOverlay?,lineage?,consent?,locale?,policy?,trace?}` MUST emit `gentle-ai review start --cwd <root> [--agent <value>] [--contract <value>] [--target <value>] [--projection workspace|staged] [--focus risk|resilience|readability|reliability] [--untracked-scope exclude|select] [--expected-untracked-inventory <digest>] [--intended-untracked <path>]... [--base-ref <value>] [--committed-only] [--workspace-overlay] [--lineage <value>] [--consent relay|granted|declined] [--locale en|es] [--policy <value>] [--trace <value>]`.
- `reviewCaptureResult {projectDir,agent?,input?,inputJson?,lens?,order?,target?,lineage?,expectedRevision?,repositoryContext?,subjectHash?,materialize?,preflight?}` MUST emit `gentle-ai review capture-result --cwd <root> [--agent <value>] [--input <file|->] [--lens <value>] [--order <n>] [--target <value>] [--lineage <value>] [--expected-revision <value>] [--repository-context <value>] [--subject-hash <value>] [--materialize] [--preflight]`.
- `reviewCaptureUnachievable {projectDir,target?,lineage?,expectedRevision?,repositoryContext?,requestHash?,reason?,detail?,withdraw?}` MUST emit `gentle-ai review capture-unachievable --cwd <root> [--target <value>] [--lineage <value>] [--expected-revision <value>] [--repository-context <value>] [--request-hash <value>] [--reason <value>] [--detail <value>] [--withdraw]`.
- `reviewAcknowledgeApproved {projectDir}` MUST emit exactly `gentle-ai review acknowledge-approved`; no flag is currently specified.
- `reviewCaptureCorrectionPlan {projectDir,target?,lineage?,expectedRevision?,repositoryContext?,requestHash?,correctionLines?}` MUST emit `gentle-ai review capture-correction-plan --cwd <root> [--target <value>] [--lineage <value>] [--expected-revision <value>] [--repository-context <value>] [--request-hash <value>] [--correction-lines <positive-int>]`.
- `reviewCaptureRefuter {projectDir,agent?,target?,lineage?,expectedRevision?,repositoryContext?,materialize?,execute?}` MUST emit `gentle-ai review capture-refuter --cwd <root> [--agent <value>] [--target <value>] [--lineage <value>] [--expected-revision <value>] [--repository-context <value>] [--materialize] [--execute]`.
- `reviewCaptureValidation {projectDir,agent?,target?,lineage?,expectedRevision?,repositoryContext?,requestHash?,materialize?,execute?}` MUST emit `gentle-ai review capture-validation --cwd <root> [--agent <value>] [--target <value>] [--lineage <value>] [--expected-revision <value>] [--repository-context <value>] [--request-hash <value>] [--materialize] [--execute]`.
- `reviewValidate {projectDir,contract?,gate?,baseRef?,lineage?,policy?,prePrCiAttestation?,releaseConfiguration?,releaseEvidenceFreshness?,releaseGenerated?,releaseProvenance?,releasePublicationBoundary?}` MUST emit `gentle-ai review validate --cwd <root> [--contract <value>] [--gate post-apply|pre-commit|pre-push|pre-pr|release] [--base-ref <value>] [--lineage <value>] [--policy <value>] [--pre-pr-ci-attestation <value>] [--release-configuration <value>] [--release-evidence-freshness <value>] [--release-generated <value>] [--release-provenance <value>] [--release-publication-boundary <value>]`.
- `reviewRecover {projectDir,actor?,disposition?,expectedPredecessorRevision?,predecessorLineage?,successorLineage?,reason?,maintainerAuthorization?,baseRef?,committedOnly?,workspaceOverlay?,releaseScope?,projection?,untrackedScope?,expectedUntrackedInventory?,intendedUntracked?,focus?,policy?}` MUST emit `gentle-ai review recover --cwd <root> [--actor <value>] [--disposition scope_changed|invalidated|escalated] [--expected-predecessor-revision <value>] [--predecessor-lineage <value>] [--successor-lineage <value>] [--reason <value>] [--maintainer-authorization <LF-only JSON>] [--base-ref <value>] [--committed-only] [--workspace-overlay] [--release-scope] [--projection workspace|staged] [--untracked-scope exclude|select] [--expected-untracked-inventory <digest>] [--intended-untracked <path>]... [--focus <value>] [--policy <value>]`.
- `reviewLensContext {projectDir,repositoryContext,lineage,target,expectedRevision,lens}` is a host READ open to every agent with no approval prompt. It MUST emit `gentle-ai review lens-context --cwd <root> --repository-context <h> --lineage <l> --target <t> --expected-revision <r> --lens <review-risk|review-resilience|review-readability|review-reliability>` and return the raw multi-line reviewer block (binding line plus the `GENTLE_AI_REVIEW_CONTEXT` ... `END` delimiters) as plain text through the tolerant raw path; it MUST NOT be parsed as JSON.

### Requirement: Token and process boundary

For every operation, the broker MUST resolve the allowlisted canonical project root, substitute it only where `<root>` appears, execute in that root, and reject caller-supplied cwd, binary, argv, unknown keys, root mismatch, or S17 path access. `reviewAcknowledgeApproved` MUST execute in the canonical root even though its candidate argv has no `--cwd` flag.

Provider-issued `target`, lineage fields, `repositoryContext`, `lens`, `contract`, `policy`, `trace`, attestation, and release values MUST be 1..4096 UTF-8 bytes, contain no NUL/control characters, and not start with `-`. `agent` MUST match `^[a-z0-9_-]{1,64}$`; `actor` MUST be 1..128 safe UTF-8 bytes; `focus` for `reviewRecover` MUST be a 1..128-byte opaque token. `expectedRevision`, `expectedPredecessorRevision`, `subjectHash`, `requestHash`, and `expectedUntrackedInventory` MUST match `sha256:[0-9a-f]{64}`. `order` MUST be an integer from 0 through 32; `correctionLines` MUST be a positive 32-bit integer. `baseRef` MUST be 1..1024 safe bytes and reject leading `-`, controls, `..`, and revision magic.

Enums MUST use only their displayed domains. Flag fields MUST be strict booleans and emit their flag only when true. `reason` MUST be 1..4096 UTF-8 bytes and `detail` 1..16384 bytes, without NUL/control characters or a leading `-`. `input` MUST be `-` or a project-relative path of at most 4096 bytes that canonicalizes beneath the root. `inputJson` MUST be a non-empty JSON string of at most 512 KiB with no NUL byte, and MUST be mutually exclusive with `input` (both absent is allowed; both present MUST be rejected); when present, the broker MUST stage its exact bytes into the private review-input snapshot and pass that path as `--input`. `maintainerAuthorization` MUST be valid JSON of 1..65536 UTF-8 bytes with LF-only line endings and no NUL or CR, and MUST be forwarded byte-for-byte. An untracked declaration MUST provide `untrackedScope` and `expectedUntrackedInventory` together; `select` MUST include 1..256 unique project-relative `intendedUntracked` paths of at most 4096 bytes, while `exclude` MUST include none.

Every accepted provider token MUST be passed to its matching argv position verbatim: the broker MUST NOT normalize, reconstruct, guess, derive, reorder, or default it from prose or prior state. Returned stderr MUST pass through `redact()` before being capped at 512 KiB. Returned protocol stdout MUST be preserved verbatim — its provider-issued tokens are forwarded into subsequent review operations and MUST NOT be normalized, reconstructed, or rewritten by redaction — bounded by the executor's spawn output cap. Every operation MUST require fragment `ask` plus a metadata-rich in-tool approval prompt before spawn.

#### Scenario: Exact argv for every operation

- GIVEN any one of the nine operations with a valid payload
- WHEN it executes
- THEN argv MUST match that operation's frozen template and optional-flag order exactly

#### Scenario: Unknown payload key for every operation

- GIVEN any one of the nine payloads contains an undeclared key
- WHEN validation runs
- THEN execution MUST be rejected before spawn

#### Scenario: Invalid value for every operation

- GIVEN any declared value violates its enum, shape, size, coupling, boolean, JSON, or path rule
- WHEN validation runs
- THEN execution MUST be rejected before spawn

#### Scenario: Verbatim token passthrough for every token-bearing operation

- GIVEN a valid provider-issued token with significant case or punctuation
- WHEN its operation emits argv
- THEN the exact payload bytes MUST occupy the matching argv element without reconstruction or defaulting

#### Scenario: Non-orchestrator denied for every operation

- GIVEN a non-orchestrator requests any review lifecycle operation
- WHEN authorization runs
- THEN access MUST be denied

#### Scenario: Approval prompt for every operation

- GIVEN the orchestrator requests any review lifecycle operation
- WHEN fragment or in-tool approval is absent or denied
- THEN the process MUST NOT spawn

## Open Questions

- `review capture-result --help` permits `--input <file|->`, but it does not define how a result file or stdin is staged for this broker boundary. The adapter now accepts an optional inline `inputJson` body (staged into the same broker-private snapshot and passed as `--input`) alongside the project-relative `input` path; confirm the installed binary treats the staged path as an ordinary file and never re-interprets it as stdin.
- `review acknowledge-approved --help` returned no flags on 2026-09-12. Verify the installed binary's exact flag/token contract before adding any payload key or argv flag; the current candidate remains flag-less.
- `review recover --focus <value>` does not publish an enum. Until verified, it remains a bounded opaque provider token and MUST NOT be narrowed to the four `review start` focus values.
