# Delta for Host Plan Document

## ADDED Requirements

### Requirement: Allowlisted append-only plan document

The broker MUST expose `planDocAppend` as a `gentle-orchestrator`-only
MUTATION with payload keys exactly `{projectDir, doc, content, heading?}`. It
MUST map `doc` by enum only: `todo` to `docs/TODO.md` and `plan` to
`docs/PLAN.md`. It MUST reject every other value, including absolute paths,
traversal, and other repository paths; it MUST accept no free-form path, cwd,
binary, or argv. When `heading` is present it MUST name one exact existing ATX
heading and MUST insert the block before the next heading of equal or higher
level; a missing or ambiguous heading MUST fail without mutation.

`content` MUST be one non-empty UTF-8 block after trimming leading and trailing whitespace, MUST be at most 16 KiB after trimming, and MUST contain no control character other than LF newline. The operation MUST preserve all existing document content, append only the trimmed block, and create the mapped document when absent; it MUST never overwrite or truncate existing content. The resulting document MUST be written atomically.

The broker MUST resolve and enforce the canonical allowlisted project root, MUST keep the mapped destination beneath that root, and MUST reject an S17 protected destination or canonical-path mismatch. The operation MUST require fragment `ask` and a metadata-rich in-tool approval prompt before mutation.

#### Scenario: Exact document mapping

- GIVEN `doc` is `todo` or `plan`
- WHEN destination validation runs
- THEN it MUST resolve exactly to `docs/TODO.md` or `docs/PLAN.md`, respectively

#### Scenario: Append preserves content

- GIVEN the mapped document contains existing bytes
- WHEN approved content is appended
- THEN the existing bytes MUST remain unchanged and the trimmed block MUST be added atomically

#### Scenario: Unknown document

- GIVEN `doc` is not `todo` or `plan`
- WHEN validation runs
- THEN execution MUST be rejected

#### Scenario: Traversal or absolute document

- GIVEN `doc` contains traversal, an absolute path, or another repository path
- WHEN validation runs
- THEN execution MUST be rejected as an unknown enum value

#### Scenario: Oversized content

- GIVEN trimmed `content` exceeds 16 KiB
- WHEN validation runs
- THEN execution MUST be rejected

#### Scenario: Control-character content

- GIVEN `content` contains a control character other than LF newline
- WHEN validation runs
- THEN execution MUST be rejected

#### Scenario: Protected destination

- GIVEN canonical resolution or mapping drift would target an S17 protected path
- WHEN destination checks run
- THEN execution MUST be rejected before mutation

#### Scenario: Non-orchestrator caller

- GIVEN a non-orchestrator requests `planDocAppend`
- WHEN authorization runs
- THEN access MUST be denied

#### Scenario: Approval required

- GIVEN the orchestrator requests `planDocAppend`
- WHEN approval has not been granted
- THEN no file MUST be created or changed
