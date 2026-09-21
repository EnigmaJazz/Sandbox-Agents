# Delta for Host Git Tools

## ADDED Requirements

### Requirement: Ref-scoped commit

`gitCommit` MUST derive paths from persisted `baselineRef`/`resultRef`, run `checkProtectedPaths`, and commit exactly those paths with fixed stage/commit argv and `-- <paths>`. It MUST use a bounded `-m` message and MUST NOT sweep unrelated work.

#### Scenario: Commit result
- GIVEN an applied B→C result
- WHEN `gitCommit` runs
- THEN only its checked paths MUST be committed

### Requirement: Guarded push and output

`gitPush` MUST broker-resolve the branch and use only `git push [--set-upstream] <remote> <branch>`. It MUST refuse force, force-with-lease, delete, `+refspec`, detached HEAD, missing upstream without `setUpstream`, and direct `main`/`master` without `allowProtectedBranch`. Git stdout/stderr MUST be capped and passed through `redact()`.

#### Scenario: Unsafe push
- GIVEN any refused condition
- WHEN `gitPush` is requested
- THEN no push MUST execute

#### Scenario: Secret output
- GIVEN git output contains secret-shaped data
- WHEN returned or logged
- THEN it MUST be redacted within the cap
