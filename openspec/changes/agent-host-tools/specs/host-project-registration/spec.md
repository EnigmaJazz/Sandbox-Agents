# Delta for Host Project Registration

## ADDED Requirements

### Requirement: Wired path-banned registration

`registerProject` dispatch MUST invoke the existing operation using only `bun scripts/register-project.ts [--dry-run] [--create-remote] [--public] <path>`. Path MUST be an existing absolute directory, not `/`, `$HOME`, or beneath `$HOME/.ssh|.config|.local|.cache|.gnupg|.aws|.kube`, `/etc`, `/usr`, `/var`, or `/tmp`. `--public` MUST require `--create-remote`.

#### Scenario: Eligible project
- GIVEN an eligible directory
- WHEN registration is dispatched
- THEN the fixed argv MUST execute

#### Scenario: Banned registration
- GIVEN a banned path or invalid flag combination
- WHEN registration is requested
- THEN no process MUST spawn
