# Delta for Host SDD Runtime Tools

## ADDED Requirements

### Requirement: Fixed P0 commands

The broker MUST expose per-command tools using only: `gentle-ai sdd-status [change] --cwd <root> --json --instructions [--contract gentle-ai.sdd-status/v2]`; `gentle-ai sdd-continue [change] --cwd <root>`; `gentle-ai sdd-attempt acquire --cwd <root> --change <change> --request-id <id> --work-unit <unit> --evidence-goal <goal> --max-attempts <n> --max-changed-lines <n>` with an optional untracked declaration `--untracked-scope <exclude|select> --expected-untracked-inventory <sha256:64-hex>` and, for `select`, one `--intended-untracked <repo-relative-path>` per path; `gentle-ai sdd-attempt settle --cwd <root> --change <change> --token <token> --request-id <id> --outcome <passed|failed|interrupted> [--evidence-revision <sha256:64-hex>] [--remediates-evidence-revision <sha256:64-hex>] --diagnosis <diagnosis> --harness-disposition <reused|invalidated> --cleanup-evidence <evidence> --process-evidence <evidence>` with the same optional untracked declaration `--untracked-scope <exclude|select> --expected-untracked-inventory <sha256:64-hex>` and, for `select`, one `--intended-untracked <repo-relative-path>` per path; `gentle-ai sdd-archive-compose --canonical <path> --delta <path> --output <path>`; `gentle-ai sdd-verify-validate --input <path|-> --requirements <count> --scenarios <count>`; `gentle-ai sdd-task-result --phase <phase> --cwd <root> --input <path|->`; `gentle-ai review assess --cwd <root> --json`; `gentle-ai review mode status`; `gentle-ai review status --cwd <root> --contract gentle-ai.review-integration/v2 --agent <agent> [--lineage <value>] [--repository-context <value>] [--projection workspace|staged] [--intended-untracked-selection <schema-bound-json>] --next-transition`.

#### Scenario: Valid payload
- GIVEN a valid payload
- WHEN its tool executes
- THEN argv MUST match its template exactly

#### Scenario: Undeclared field
- GIVEN an undeclared field
- WHEN validation runs
- THEN execution MUST be rejected

#### Scenario: Untracked declaration
- GIVEN an `sdd-attempt acquire` payload that sets `untrackedScope`
- WHEN its tool executes
- THEN argv MUST carry `--untracked-scope` and `--expected-untracked-inventory`, and `select` MUST also carry one `--intended-untracked` per intended path

#### Scenario: Settle untracked declaration
- GIVEN an `sdd-attempt settle` payload that sets `untrackedScope`
- WHEN its tool executes
- THEN argv MUST carry `--untracked-scope` and `--expected-untracked-inventory`, and `select` MUST also carry one `--intended-untracked` per intended path

#### Scenario: Begin untracked declaration
- GIVEN an `sdd-attempt begin` payload that sets `untrackedScope`
- WHEN its tool executes
- THEN argv MUST carry `--untracked-scope` and `--expected-untracked-inventory`, and `select` MUST also carry one `--intended-untracked` per intended path

#### Scenario: Untracked declaration rejected
- GIVEN `untrackedScope` `select` with no `intendedUntracked`, `exclude` that carries `intendedUntracked`, or a malformed `expectedUntrackedInventory`
- WHEN validation runs for either `sdd-attempt acquire` or `sdd-attempt settle`
- THEN execution MUST be rejected

#### Scenario: Review status passthrough
- GIVEN a valid `reviewStatus` payload
- WHEN its tool executes
- THEN argv MUST match the fixed review-status template (`agent` defaults to `opencode`) and the raw JSON envelope MUST be returned unchanged

#### Scenario: Review status intended untracked selection
- GIVEN a `reviewStatus` payload that sets `intendedUntrackedSelection` to the provider's schema-bound `gentle-ai.review-intended-untracked-selection/v1` JSON value
- WHEN its tool executes
- THEN argv MUST carry exactly one `--intended-untracked-selection <json>` element after `--projection` and before `--next-transition`, forwarded byte-for-byte without reshaping or re-serialization
- AND a non-JSON, empty, oversized, control-bearing, or flag-like value MUST be rejected before spawn

### Requirement: Maintainer-authorized attempt rescope

The broker MUST expose `sddAttemptRescope` as a `gentle-orchestrator`-only MUTATION using exactly `gentle-ai sdd-attempt rescope --cwd <canonical-root> --change <change> --expected-revision <sha256:64-hex> --request-id <unique-id> --work-unit <label> --evidence-goal <goal> --max-attempts <n> --max-changed-lines <n> --reason <text> --actor <actor>`. The broker MUST supply the canonical project root, MUST NOT accept free-form cwd, binary, or argv, and MUST allow only `projectDir`, `change`, `expectedRevision`, `requestId`, `workUnit`, `evidenceGoal`, `maxAttempts`, `maxChangedLines`, `reason`, and `actor`.

Rescope MUST authorize only a narrower successor objective and MUST carry cumulative attempt and changed-line counts forward unchanged. The CLI MUST refuse caps above the current objective caps (currently 3 attempts and 800 changed lines); the broker MUST validate only that both caps are positive integers. `expectedRevision` MUST match `sha256:` followed by exactly 64 lowercase hexadecimal characters. `actor` MUST be a bounded non-empty identifier without control characters; `reason` MUST contain 1..4096 bytes without NUL or control characters; `requestId`, `workUnit`, and `evidenceGoal` MUST follow the existing bounded identifier rules.

#### Scenario: Exact rescope argv
- GIVEN a valid `sddAttemptRescope` payload
- WHEN the tool executes
- THEN emitted argv MUST match the frozen template exactly with the canonical root substituted

#### Scenario: Extra rescope field
- GIVEN a payload containing any undeclared field
- WHEN validation runs
- THEN execution MUST be rejected

#### Scenario: Malformed expected revision
- GIVEN `expectedRevision` is not `sha256:` followed by exactly 64 lowercase hexadecimal characters
- WHEN validation runs
- THEN execution MUST be rejected

#### Scenario: Invalid reason or actor
- GIVEN `reason` or `actor` is missing or empty, or either value contains a control character
- WHEN validation runs
- THEN execution MUST be rejected

#### Scenario: Rescope authorization
- GIVEN any caller requests `sddAttemptRescope`
- WHEN authorization runs
- THEN it MUST be classified as an orchestrator-only MUTATION protected by fragment `ask` and metadata-rich in-tool `ctx.ask`, never as a read

### Requirement: Ledger objective begin

The broker MUST expose `sddAttemptBegin` as a `gentle-orchestrator`-only MUTATION using exactly `gentle-ai sdd-attempt begin --cwd <canonical-root> --change <change> --expected-revision <sha256:64-hex> --request-id <unique-id> --work-unit <label> --evidence-goal <goal> --max-attempts <n> --max-changed-lines <n> [--untracked-scope <exclude|select> --expected-untracked-inventory <sha256:64-hex> [--intended-untracked <repo-relative-path>...]]`. It MUST substitute the canonical root and allow only `projectDir`, `change`, `expectedRevision`, `requestId`, `workUnit`, `evidenceGoal`, `maxAttempts`, `maxChangedLines`, `untrackedScope`, `expectedUntrackedInventory`, and `intendedUntracked`.

`begin` MUST start the objective already recorded by maintainer `rescope`, not create a new objective. The CLI MUST refuse caps above the current objective caps (currently 3 attempts and 800 changed lines); the broker MUST require positive integers and MUST NOT clamp or encode that ceiling. `expectedRevision` MUST be `sha256:` plus 64 lowercase hexadecimal characters. `requestId`, `workUnit`, and `evidenceGoal` MUST reuse the existing bounded identifier rules.

#### Scenario: Exact begin argv
- GIVEN a valid `sddAttemptBegin` payload
- WHEN the tool executes
- THEN argv MUST match the fixed template exactly with the canonical root substituted

#### Scenario: Extra begin field
- GIVEN a payload containing an undeclared field
- WHEN validation runs
- THEN execution MUST be rejected

#### Scenario: Malformed begin revision
- GIVEN `expectedRevision` is malformed
- WHEN validation runs
- THEN execution MUST be rejected

#### Scenario: Begin authorization
- GIVEN any caller requests `sddAttemptBegin`
- WHEN authorization runs
- THEN it MUST be an orchestrator-only MUTATION protected by fragment `ask` and in-tool `ctx.ask`, never a read

### Requirement: Ledger objective status

The broker MUST expose `sddAttemptStatus` as a host READ open to every agent without prompting, using only `gentle-ai sdd-attempt status --cwd <canonical-root> --change <change>`. It MUST substitute the canonical root and allow only `projectDir` and `change`. It MUST publish `objective.work_unit`, `objective.evidence_goal`, `objective.max_attempts`, and `objective.max_changed_lines` for the current change.

Because the exact installed-binary flag set is unverified, the broker MUST use tolerant raw-envelope passthrough: return numeric status and raw stdout/stderr, parse JSON only when parsing succeeds, and MUST NOT fail solely because output is non-JSON.

#### Scenario: Status passthrough
- GIVEN a valid `sddAttemptStatus` payload
- WHEN the tool executes
- THEN fixed review-style passthrough MUST return the raw envelope unchanged

#### Scenario: Extra status field
- GIVEN a payload containing an undeclared field
- WHEN validation runs
- THEN execution MUST be rejected

#### Scenario: Status authorization
- GIVEN any agent requests `sddAttemptStatus`
- WHEN authorization runs
- THEN it MUST be treated as a READ available without a prompt

### Requirement: Ledger active-attempt finish

The broker MUST expose `sddAttemptFinish` as a `gentle-orchestrator`-only MUTATION using exactly `gentle-ai sdd-attempt finish --cwd <canonical-root> --change <change> --expected-revision <sha256:64-hex> --request-id <lowercase-id> --outcome <failed|interrupted|passed> --evidence-revision <sha256> --diagnosis <text> --harness-disposition <reused|invalidated> --cleanup-evidence <text> --process-evidence <text> [--remediates-evidence-revision <sha256>] [--untracked-scope <exclude|select> --expected-untracked-inventory <sha256:64-hex> [--intended-untracked <repo-relative-path>...]]`. It MUST substitute the canonical allowlisted project root, run there, reject free-form cwd, binary, or argv, and allow only `projectDir`, `change`, `expectedRevision`, `requestId`, `outcome`, `evidenceRevision`, `diagnosis`, `harnessDisposition`, `cleanupEvidence`, `processEvidence`, `remediatesEvidenceRevision`, `untrackedScope`, `expectedUntrackedInventory`, and `intendedUntracked`.

`finish` MUST complete the ACTIVE attempt without a token, and `expectedRevision` MUST equal the current runtime revision. `change` MUST follow the existing bounded SDD-identifier rules. `expectedRevision` and `expectedUntrackedInventory` MUST be `sha256:` plus 64 lowercase hexadecimal characters; evidence revisions MUST be 64 lowercase hexadecimal characters. `requestId` MUST match `^[a-z0-9][a-z0-9-]{0,127}$`. `outcome` and `harnessDisposition` MUST use their declared enums. `diagnosis`, `cleanupEvidence`, and `processEvidence` MUST each contain 1..500 UTF-8 bytes without NUL/control characters and MUST NOT start with `-`. `passed` and `failed` MUST carry a non-empty evidence revision; `interrupted` MUST carry only an empty or canonical legacy revision. `remediatesEvidenceRevision` MAY be omitted. An untracked declaration MUST supply scope and inventory digest together; `select` MUST carry 1..256 repo-relative paths of at most 4096 bytes each, while `exclude` MUST NOT carry intended paths. Returned stdout and stderr MUST each pass through `redact()` before being capped at 512 KiB.

#### Scenario: Exact finish argv

- GIVEN a valid `sddAttemptFinish` payload, including any valid optional declarations
- WHEN the tool executes
- THEN argv MUST match the frozen template exactly and the process MUST run in the canonical root

#### Scenario: Extra finish field

- GIVEN a finish payload containing any undeclared field
- WHEN validation runs
- THEN execution MUST be rejected

#### Scenario: Invalid finish value

- GIVEN a malformed revision, non-lowercase or flag-like request ID, unsupported enum, oversized evidence text, or flag-like evidence text
- WHEN validation runs
- THEN execution MUST be rejected

#### Scenario: Outcome revision rules

- GIVEN `passed` or `failed` lacks a canonical evidence revision, or `interrupted` carries a non-empty non-canonical revision
- WHEN validation runs
- THEN execution MUST be rejected

#### Scenario: Finish authorization

- GIVEN a non-orchestrator caller requests `sddAttemptFinish`
- WHEN authorization runs
- THEN access MUST be denied because the operation is an orchestrator-only MUTATION

### Requirement: Ledger objective reset

The broker MUST expose `sddAttemptReset` as a `gentle-orchestrator`-only MUTATION using exactly `gentle-ai sdd-attempt reset --cwd <canonical-root> --change <change> --expected-revision <sha256:64-hex> --request-id <lowercase-id> --reason <text> --actor <actor> [--objective-relation <remediation|independent>]`. It MUST substitute the canonical allowlisted project root, run there, reject free-form cwd, binary, or argv, and allow only `projectDir`, `change`, `expectedRevision`, `requestId`, `reason`, `actor`, and `objectiveRelation`.

`reset` MUST reset only a decision-required or complete objective. `change` MUST follow the existing bounded SDD-identifier rules; `expectedRevision` MUST be `sha256:` plus 64 lowercase hexadecimal characters; and `requestId` MUST match `^[a-z0-9][a-z0-9-]{0,127}$`. `reason` MUST contain 1..500 UTF-8 bytes and `actor` 1..128 UTF-8 bytes; both MUST exclude NUL/control characters and MUST NOT start with `-`. `objectiveRelation`, when present, MUST be `remediation` or `independent`; `independent` MUST declare that the successor does not inherit the closed objective's settle obligation. Returned stdout and stderr MUST each pass through `redact()` before being capped at 512 KiB.

#### Scenario: Exact reset argv

- GIVEN a valid `sddAttemptReset` payload
- WHEN the tool executes
- THEN argv MUST match the frozen template exactly and the process MUST run in the canonical root

#### Scenario: Extra reset field

- GIVEN a reset payload containing any undeclared field
- WHEN validation runs
- THEN execution MUST be rejected

#### Scenario: Invalid reset value

- GIVEN a malformed revision, non-lowercase or flag-like request ID, oversized or flag-like reason/actor, or unsupported objective relation
- WHEN validation runs
- THEN execution MUST be rejected

#### Scenario: Objective relation cases

- GIVEN `objectiveRelation` is omitted, `remediation`, or `independent`
- WHEN the tool executes
- THEN omission MUST emit no relation flag, each value MUST emit its exact flag, and `independent` MUST prevent obligation inheritance

#### Scenario: Reset authorization

- GIVEN a non-orchestrator caller requests `sddAttemptReset`
- WHEN authorization runs
- THEN access MUST be denied because the operation is an orchestrator-only MUTATION

### Requirement: Ledger root grant

The broker MUST expose `sddAttemptGrant` as a `gentle-orchestrator`-only MUTATION using exactly `gentle-ai sdd-attempt grant --cwd <canonical-root> --change <change> [--expected-revision <sha256:64-hex>] --root <canonical-path>... --change-instance <caller-token> --request-id <lowercase-id> --actor <actor> --reason <text>`. It MUST substitute the canonical allowlisted project root, run there, reject free-form cwd, binary, or argv, and allow only `projectDir`, `change`, `expectedRevision`, `roots`, `changeInstance`, `requestId`, `actor`, and `reason`.

`change` MUST follow the existing bounded SDD-identifier rules. `expectedRevision` MAY be omitted only for an initial grant and otherwise MUST be `sha256:` plus 64 lowercase hexadecimal characters. `roots` MUST contain 1..32 unique canonical absolute paths, each at most 4096 UTF-8 bytes. `changeInstance` MUST contain 1..128 UTF-8 bytes; `requestId` MUST match `^[a-z0-9][a-z0-9-]{0,127}$`; `actor` MUST contain 1..128 UTF-8 bytes; and `reason` MUST contain 1..500 UTF-8 bytes. These text values MUST exclude NUL/control characters and MUST NOT start with `-`. Returned stdout and stderr MUST each pass through `redact()` before being capped at 512 KiB.

#### Scenario: Exact grant argv

- GIVEN a valid grant with one or more roots and either a valid CAS revision or an initial omitted revision
- WHEN the tool executes
- THEN argv MUST repeat `--root` once per root in order and the process MUST run in the canonical project root

#### Scenario: Extra grant field

- GIVEN a grant payload containing any undeclared field
- WHEN validation runs
- THEN execution MUST be rejected

#### Scenario: Invalid grant value

- GIVEN a malformed revision, non-lowercase or flag-like request ID, oversized or flag-like token/actor/reason, or non-canonical root
- WHEN validation runs
- THEN execution MUST be rejected

#### Scenario: Grant root bounds

- GIVEN zero roots, more than 32 roots, a duplicate root, or a root over 4096 bytes
- WHEN validation runs
- THEN execution MUST be rejected

#### Scenario: Grant authorization

- GIVEN a non-orchestrator caller requests `sddAttemptGrant`
- WHEN authorization runs
- THEN access MUST be denied because the operation is an orchestrator-only MUTATION

## Scope Boundary

In scope: sdd-attempt rescope, sdd-attempt begin, sdd-attempt status, sdd-attempt finish, sdd-attempt reset, sdd-attempt grant.

Not requirements: token-bound review `start`, `capture-result`, `acknowledge-approved`, `capture-unachievable`, `recover`; deferred `sdd-attempt handoff|repair`; `review schema`, `sync`, and `skill-registry refresh`.

## Open Questions

- Verify against the installed `gentle-ai` binary, through the host broker, whether `sdd-attempt status` supports exactly `--cwd <canonical-root> --change <change>` before freezing that argv template.
