# Delta for Reviewer Relay Transport

## ADDED Requirements

### Requirement: Session-repository root resolution

The relay MUST resolve cwd from the Task session's repository, never from the OpenCode server or plugin-instance project, and MUST accept only the exact allowlisted canonical root.

#### Scenario: Session repository selected

- GIVEN a reviewer Task belongs to an allowlisted repository session
- WHEN the relay resolves cwd
- THEN it MUST use that session repository's canonical root

#### Scenario: Untrusted root rejected

- GIVEN resolution yields the server project, a non-canonical path, or a root outside the allowlist
- WHEN relay startup is requested
- THEN it MUST fail before spawning a child

### Requirement: Disjoint reviewer hook scope

Hooks MUST match only names in the integration's dedicated reviewer allowlist. That allowlist MUST be disjoint from installed `REVIEW_AGENTS`: `review-risk`, `review-resilience`, `review-readability`, `review-reliability`, `review-refuter`, and `review-validator`.

#### Scenario: Installed reviewer name bypasses relay

- GIVEN a Task targets any installed `REVIEW_AGENTS` name
- WHEN hooks evaluate the Task
- THEN this relay MUST NOT intercept or alter it

#### Scenario: Integration reviewer name is handled

- GIVEN a Task targets an allowlisted integration reviewer name
- WHEN hooks evaluate the Task
- THEN exactly this relay MAY handle it

### Requirement: Binding-only Task boundary

The Task launch prompt MUST carry only the small provider-issued binding prompt. The relay MUST materialize the full reviewer context itself within the resolved session repository.

#### Scenario: Context is materialized by relay

- GIVEN a valid provider binding and an allowlisted session root
- WHEN the reviewer Task starts
- THEN the Task-boundary prompt MUST exclude the materialized context block
- AND the reviewer MUST receive the relay-materialized complete block

### Requirement: Verbatim and complete provider framing

The relay MUST forward provider-issued frames verbatim and MUST NOT synthesize tokens, lineage, subject identity, or authority. It MUST fail closed on any malformed or partial frame, including a context block missing `GENTLE_AI_REVIEW_CONTEXT_END`.

#### Scenario: Valid frame preserved

- GIVEN a complete provider-issued frame
- WHEN the relay forwards it
- THEN every frame byte and provider token MUST remain unchanged

#### Scenario: Partial frame refused

- GIVEN a malformed frame or context without `GENTLE_AI_REVIEW_CONTEXT_END`
- WHEN the relay validates the frame
- THEN it MUST stop without launching or admitting reviewer output
- AND it MUST NOT derive replacement authority data

### Requirement: Bounded host process

The relay MUST spawn only `gentle-ai review opencode-transport` through a fixed argv vector, without a shell or caller-controlled environment injection. Output MUST be bounded, and the child MUST have a configured timeout that supports multi-minute reviewer calls while remaining finite.

#### Scenario: Disciplined spawn

- GIVEN valid binding and canonical-root inputs
- WHEN the relay starts the transport
- THEN binary, argv, cwd, environment policy, and output bounds MUST match the fixed contract

#### Scenario: Relay deadline expires

- GIVEN the child remains active beyond its configured multi-minute timeout
- WHEN the deadline expires
- THEN the relay MUST terminate it and fail closed

### Requirement: Manual security-boundary delivery

Changes under `opencode/plugins/**` and `opencode/config-fragments/**` MUST NOT be agent-applied. Delivery MUST require explicit manual review and user-controlled installation without modifying installed host configuration automatically.

#### Scenario: Protected artifact is ready

- GIVEN relay plugin or reviewer-fragment changes are produced
- WHEN delivery is requested
- THEN automation MUST stop for manual review and user installation
