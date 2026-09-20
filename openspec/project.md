# Project Context

- **Project:** `agent-sandbox-integration`
- **Stack:** Bun + TypeScript; the broker is dependency-free and uses `bun:test` plus Node built-ins.
- **Architecture:** Security infrastructure centered on a trusted sandbox broker with explicit allowlists, canonical-path checks, argv-vector process spawning, atomic state writes, no `eval`, and no implicit fallback.
- **Persistence:** Hybrid Magic Context and OpenSpec.
- **Strict TDD:** Disabled (`strict_tdd: false`); no explicit workspace-wide test command covers every in-scope project.
- **Verification:** `cd broker && bun test`; run `bun build src/main.ts` for compilation before commit. Do not run gated suites unless the environment supports them.
- **Constraints:** English artifacts; modify only this repository; do not touch live configuration, install packages, use sudo, or expose credentials. S17 protected security components require manual review and are outside this initialization change.

## Testing Capability Summary

| Relative path | Stack | Test command | Framework |
| --- | --- | --- | --- |
| `broker` | Bun + TypeScript | `cd broker && bun test` | `bun:test` |

Unit and integration tests are available through `bun:test`; E2E tests, coverage, linting, and formatting commands were not detected. Type/build verification is `bun build src/main.ts`.
