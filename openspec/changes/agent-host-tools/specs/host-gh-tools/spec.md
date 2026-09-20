# Delta for Host GitHub Tools

## ADDED Requirements

### Requirement: Fixed issue creation

`ghIssueCreate` MUST use only `gh issue create --repo <repo> --title <title> --body <body>`. Values and output MUST be capped, and stdout/stderr MUST pass through `redact()`.

#### Scenario: Valid issue
- GIVEN valid repository, title, and body
- WHEN `ghIssueCreate` runs
- THEN exact argv MUST execute in the canonical root

#### Scenario: Invalid issue
- GIVEN an unknown, unsafe, or over-cap value
- WHEN validation runs
- THEN execution MUST be rejected
