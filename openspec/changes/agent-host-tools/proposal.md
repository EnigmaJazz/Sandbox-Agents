# Proposal: Agent Host Tools

## Intent

Agents inside the secured runtime cannot manage git/gh or drive the SDD/RDD lifecycle: host bash is denied, only two SDD host ops exist (`sdd-status`, `sdd-attempt acquire`), and `host_register_project` is inert — its plugin tool exists but `server.ts` lacks a `registerProject` dispatch case, so it throws `StateError`. This blocks the P0 SDD/RDD workflow (TODO #11/#12).

## Scope

### In Scope
- Fix `registerProject` dispatch.
- P0 SDD/RDD host ops: `sdd-status [change]` + `--contract`, `sdd-continue`, `sdd-attempt settle`, `sdd-archive-compose`, `sdd-verify-validate`, `sdd-task-result`; read-only `review assess`, `review mode status`.
- `gitCommit` (ref-scoped), `gitPush` (guarded), `ghIssueCreate` (fixed argv).
- Authorization: orchestrator-only mutations + human approval; read-only tools open to all agents.

### Out of Scope
- Token-bound review mutations (`start|capture-result|acknowledge-approved|capture-unachievable|recover`).
- P1 ops (`sdd-attempt status|begin|finish|reset`, `review status`, `review schema`, `sync`, `skill-registry refresh`).
- Any generic/arbitrary shell or dispatcher (T2 rejected).

## Capabilities

### New Capabilities
- `host-sdd-runtime-tools`: fixed-argv host execution for the P0 SDD/RDD command set.
- `host-git-tools`: approval-gated ref-scoped commit and guarded push.
- `host-gh-tools`: approval-gated fixed-argv `gh issue create`.
- `host-project-registration`: wired, path-banned `registerProject` host op.
- `host-tool-authorization`: per-tool permission/approval and agent authorization.

### Modified Capabilities
None.

## Approach

Each op wires six points: `types.ts` `Operation`+`OPERATIONS`; `validation.ts` `ALLOWED_PAYLOAD_KEYS`; typed argv builder in `service.ts`/`sdd-service.ts`; `server.ts:dispatch` case; a `tool()` in `opencode/plugins/sandbox-tools.ts`; a `sandbox-permissions.jsonc` entry; plus `broker-client.ts` `OPERATION_TIMEOUT_MS` when >30s.

- **Approval**: fragment `ask` + metadata-rich in-tool `ctx.ask` (`sandbox_apply` precedent).
- **Git**: broker-side branch resolution in the canonical root; never `--force`/`--force-with-lease`/`--delete`/`+refspec`; refuse detached-HEAD push; refuse no-upstream push unless `setUpstream`; default-refuse direct `main`/`master` push unless explicit `allowProtectedBranch`; single `-m`, control-char/byte-capped, no leading `-`; `checkProtectedPaths` before commit (S7/S17); reuse `resolveProjectRoot`; redact stdout/stderr via `logging.ts`.
- **gh**: fixed argv; repo/title/body caps; approval-gated.
- **SDD**: extend `SddRuntimeExecutor` with fixed argv builders; never accept free-form argv; `review assess`/`review mode status` stay read-only with exact argv.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `broker/src/{types,validation,service,sdd-service,server,sdd-runtime,logging,hostread}.ts` | Modified | Ops, argv builders, dispatch |
| `opencode/plugins/sandbox-tools.ts`, `opencode/plugins/lib/broker-client.ts` | Modified | Host tools, timeouts |
| `opencode/config-fragments/sandbox-permissions.jsonc` | Modified | `ask`/`allow` entries |
| `broker/tests/*.test.ts` | Modified | Argv and guard tests |
| `scripts/**`, `docs/threat-model.md` | Modified | Registration prior art; S17 note |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| S17 protected paths touched | High | Explicit manual review precedes merge |
| `registerProject` breadth (profile/launcher writes) | Med | `ask` + absolute-path bans |
| `ctx.ask` not exercisable by broker tests | Med | Pure ask-metadata helper + manual gate |
| Double approval prompt (fragment + in-tool) | Low | Accept; mirrors `sandbox_apply` |

## Rollback Plan

Revert the change commit: prior `broker/src`, plugins, and fragments return, and host tools fall back to the two existing SDD ops. No persisted schema change, so reverting removes the new ops cleanly. S17 manual review precedes merge.

## Dependencies

- Broker stays dependency-free (`bun:test` + Node built-ins).
- Host `git`/`gh` credentials remain broker-spawn-env only (workers hold none).

## Success Criteria

- [ ] `registerProject` dispatch works; plugin tool functional.
- [ ] P0 SDD/RDD ops reachable via host tools with exact argv; `sdd-status [change]`/`--contract` supported.
- [ ] `gitCommit` commits only the applied B→C set; `gitPush` refuses force/detached/protected-branch cases.
- [ ] Mutations are `ask`-gated and orchestrator-only; read-only ops open to all agents.
- [ ] `cd broker && bun test` and `bun build src/main.ts` pass.
