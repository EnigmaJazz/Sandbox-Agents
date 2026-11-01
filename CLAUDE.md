# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

AGENTS.md above is binding: repository-only writes, no installs or `sudo`, the S17 protected paths
(the user reviews and installs those bytes), and no self-certified gates. The notes below add what
AGENTS.md and the README don't say.

## Commands

All tests run from `broker/` with Bun (>= 1.3). The broker has no dependencies, so this works offline.

```sh
cd broker && bun test                                  # full offline suite
cd broker && bun test tests/advisor-relay.test.ts      # one file
cd broker && bun test tests/policy.test.ts -t "name"   # one test by name pattern
cd broker && bun build src/main.ts --target=bun --outfile <path outside the repo>   # compile check
```

- Both the full suite and the build must pass before any commit. There is no linter or formatter step.
- `tests/integration`, `tests/security` and `tests/acceptance` are gated suites that skip unless
  `SANDBOX_GATED_TESTS=integration|security|acceptance|all` is set. They need real `msb`, `nono` and
  `gentle-ai`; don't run them unless the environment supports them.
- Plugin code (`opencode/plugins/**`) is tested from `broker/tests/` too, because that is the only
  test root. Those tests mock `@opencode-ai/plugin` and `zod` (pattern:
  `broker/tests/legacy-sdd-tools.test.ts`); the plugins are not part of the broker `tsconfig.json`.

## Architecture

Core policy: host reads are allowed inside approved roots, project writes and code execution happen
in a transient Microsandbox worker, and host mutation needs explicit human approval.
`docs/architecture.md` has the component diagram and state machine; `docs/threat-model.md` has S1–S17.

**Broker (`broker/src/`)** is the trusted side. Requests arrive as NDJSON on a user-only Unix socket
and pass through these layers in order:

1. `server.ts` frames lines (`RequestLineFramer`, `SocketWriteQueue`) and dispatches by operation name.
2. `validation.ts` holds the per-operation payload-key allowlists (`ALLOWED_PAYLOAD_KEYS`) and the
   project allowlist. A new operation or payload field must be added here or it is refused.
3. `policy.ts` and `role-policy.ts` decide what an agent role may call.
4. `service.ts` implements worker and result operations (`build*Op` functions); `sdd-service.ts`
   wraps the `gentle-ai` CLI through `sdd-runtime.ts`, whose command tables define which flags each
   host tool can forward.
5. `msb.ts` (worker adapter) and `gitops.ts` spawn processes with argv vectors only.

Session state is one atomic JSON file per session (`state.ts`), never inferred from a worker name.
The only worker-to-host write channel is the git boundary: a synthetic baseline commit under
`refs/opencode-sandbox/baseline/<sessionID>`, a result under `.../result/<sessionID>`, then a
divergence check, protected-path check and `git apply` on approval.

**External advisors (`broker/src/advisor-*.ts`)** use a second, per-project socket. Each connection
is bound to a broker-assigned session and a narrow operation allowlist (`advisor-socket.ts`).
Requests, claims and responses are write-once files published by exclusive hard link
(`advisor-records.ts`). A review started with `externalLenses` accepts reviewer results only by
relaying a stored advisor response (`advisor-relay.ts`), never free-form input. Plan and contract:
`docs/advisor/`.

**OpenCode plugins (`opencode/plugins/`)**: `sandbox-tools.ts` registers the `sandbox_*` and `host_*`
tools and talks to the broker through `lib/broker-client.ts` (also used by `cli/sandboxctl`);
`routing-guard.ts` fails closed after a session activates; `reviewer-relay-transport.ts` carries
native review lenses. The repository copy is the source; the user installs it with
`scripts/install-user-files`, so a committed plugin change is not live until then, and a broker
change is not live until the user restarts the broker.

## Things that bite

- Every plugin file must be listed in both `scripts/install-user-files` and `scripts/rollback`;
  `installer-parity.test.ts` fails otherwise.
- `sandbox-edit-tool-activation.test.ts` module-mocks `lib/broker-client.ts`, and Bun module mocks
  leak across test files. A test that needs the real client imports it with a query suffix (see
  `broker-client-receive.test.ts`) or uses a raw socket; don't add another mock of that module.
- The legacy SDD operations and tools are dormant, not deleted (`legacy-sdd.ts`,
  `lib/legacy-sdd-tools.ts`, enabled by `BROKER_LEGACY_SDD` and `OPENCODE_SANDBOX_LEGACY_SDD=1`).
  Keep them that way so a rollback stays possible.
- `sandbox_bash` is not a shell: it tokenizes on whitespace and quotes, and the broker re-validates
  every token. No pipes, redirection, globs or expansion.

## Where work is tracked

- `docs/TODO.md` is the ordered to-do list, by tier. Keep it current when work lands.
- `odd/tasks/<feature>.md` is the durable record per feature: tasks, evidence, commit hashes.
- `docs/upgrades/` holds the queued, non-destructive upgrade paths (gentle-ai 4, OpenCode V2).
- `SYSTEM_PROMPT.md` is the specification; `§n` references in code and docs point into it.
