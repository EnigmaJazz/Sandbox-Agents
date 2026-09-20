# Delta for Host Tool Authorization

## ADDED Requirements

### Requirement: Canonical input boundary

Every host tool MUST use `resolveProjectRoot`'s `BROKER_PROJECTS` allowlist plus `realpathSync` equality; plugins MUST NOT supply free-form roots. Tools MUST accept only declared fields and fixed argv. Dynamic values MUST reject leading `-`, control characters, shell metacharacters, `..`, and `:(...)` magic.

#### Scenario: Untrusted input
- GIVEN a root mismatch or unsafe argument
- WHEN a host tool is requested
- THEN execution MUST be rejected before spawn

### Requirement: Authorization and approval

Mutations (`registerProject`, `sddAttemptAcquire`, `sddAttemptSettle`, `sddArchiveCompose`, `gitCommit`, `gitPush`, `ghIssueCreate`, `planDocAppend`, `reviewStart`, `reviewCaptureResult`, `reviewCaptureUnachievable`, `reviewAcknowledgeApproved`, `reviewCaptureCorrectionPlan`, `reviewCaptureRefuter`, `reviewCaptureValidation`, `reviewValidate`, `reviewRecover`) MUST be orchestrator-only, fragment-`ask`, and protected by metadata-rich in-tool `ctx.ask`. `planDocAppend` additionally MUST present an approval prompt before creating or appending its allowlisted document. Read-only P0 tools (`sddStatus`, `sddContinue`, `sddVerifyValidate`, `sddTaskResult`, `reviewAssess`, `reviewModeStatus`, `reviewStatus`, `reviewLensContext`, `sddAttemptStatus`) MUST be available to all agents and MUST NOT prompt.

#### Scenario: Mutation
- GIVEN the orchestrator requests a mutation
- WHEN both approvals are granted
- THEN it MAY execute

#### Scenario: Plan document approval
- GIVEN the orchestrator requests `planDocAppend`
- WHEN its document-specific approval prompt is not granted
- THEN no plan document MUST be created or changed

#### Scenario: Other caller
- GIVEN a non-orchestrator mutation or read-only request
- WHEN authorization runs
- THEN the mutation MUST be denied and read-only request MUST proceed without prompting
