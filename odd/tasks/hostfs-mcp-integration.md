# ODD Tasks — hostfs-mcp-integration

- **Feature:** `hostfs-mcp-integration`
- **Project:** `sandbox-integration` (`/home/james/agent-sandbox-integration`)
- **Status:** planned — tracker only; no implementation started
- **Created:** 2026-09-19
- **Delivery strategy:** `ask-on-risk`
- **Chain strategy:** `stacked-to-main` (the user's standing choice)

## Objective

Implement a narrowly scoped, read-only local MCP service named `hostfs` so
approved agents can understand selected host directory structure and locate
exact configuration files outside the active project, while strictly respecting
the existing write-authority boundaries. The service exposes exactly five
read-only operations (`hostfs_roots`, `hostfs_list`, `hostfs_find_name`,
`hostfs_stat`, `hostfs_read`) over a fixed server-side logical-root allowlist,
with sensitive-path denies that override all allows and hard depth/count/size
limits. It complements rather than replaces `aft_outline`/`aft_zoom`,
`codegraph_codegraph_explore`, `ast_grep_search`, and the project/sandbox
filesystem tools; it is never used for normal in-repository code exploration.

Delivery is sandbox-built and staged only. The canonical workflow repository is
updated by the user through a hash-guarded handoff bundle, the runtime is
installed by a user-run script, and active OpenCode configuration is updated by
the user-run verifier recovery. A generated patch or installer is not evidence
that deployment occurred.

## Problem / context

Agents have no read-only way to inspect host configuration outside the active
project, so host-layout questions are answered by guesswork or by asking the
user to paste paths. `hostfs` closes that gap with the smallest possible
surface: five bounded metadata/read tools over a server-defined logical-root
allowlist, enforced inside the service rather than by MCP Roots. All write,
execution, lifecycle and arbitrary content-search surfaces stay absent, so the
tool cannot become a general host filesystem escape. The brief is the
authoritative specification; this tracker derives reviewable change units from
its deliverables and requirements.

## Source brief (authoritative)

- **Brief file:** `docs/hostfs.md`
- **SHA-256:** `a6fbd06a7c53e87fbff4dcb57acad50b02b46517548b04e7ca2c8ad88bf7e70d`
- **Line count:** 446
- `docs/hostfs.md` is the acceptance authority for this feature. It is not
  duplicated here; read it verbatim. If this tracker and the brief ever
  disagree, the brief wins.

## Scope

### In scope

- MCP server source for exactly the five operations above, with a stable local
  entrypoint (no `npx -y`, no floating package version, no network install at
  OpenCode startup).
- Root/policy configuration schema and sensitive-path policy, enforced
  server-side; deterministic ordering; hard depth, item-count, file-size and
  response-size limits.
- Logical roots (allowlist): `opencode-config` →
  `/home/james/.config/opencode`; `cortexkit-config` →
  `/home/james/.config/cortexkit`; `systemd-user` →
  `/home/james/.config/systemd/user`; `workflow-optimisation` →
  `/home/james/ai-workspace/workflow_optimisation`; `sandbox-integration` →
  `/home/james/agent-sandbox-integration`; `local-opencode-autoupdater` →
  `/home/james/.local/share/opencode-plugin-auto-update-local`.
- Unit tests and MCP protocol integration tests in temporary fixture roots.
- Build configuration and a local package/build manifest.
- Operator documentation.
- A manifest describing the required workflow integration (permission model and
  staged behaviour), without applying it.
- Handling of a workflow source that is readable: capture commit, dirty-state
  summary and per-file SHA-256; stage only the necessary files beneath the
  sandbox repository; patch the staging copy only.
- A self-contained handoff bundle with patch, preimage/result checksum
  manifests, Fish-compatible apply/rollback/install scripts, README, runtime
  manifest or reproducible build instructions, and a complete test report.
- Staged verifier logic and staged recovery tests against a temporary fake
  OpenCode configuration.

### Out of scope

- Installing the general filesystem MCP unchanged or any broader tool surface.
- Any write, edit, create, move, copy, delete, chmod, shell, execution,
  lifecycle or arbitrary content-search operation.
- Exposing `/`, `/home/james`, arbitrary caller-supplied roots, or the whole
  OpenCode cache through general traversal. Cache diagnostics, if ever needed,
  are a separate fixed inventory operation returning only package, version,
  path, size and active-reference metadata.
- Applying the permission model directly; deployment or installation; mirroring
  to `~/.config`; restarting services.
- Executing any handoff, installation or rollback script from an agent session.
- Changing the listed existing policies, or adding a cache-prune systemd
  pre-hook.
- Staging or changing unrelated files, or fabricating a patch against unseen
  files.
- Changing model assignments or fallback allocation.

## Constraints

- **Authority boundary.** Only `/home/james/agent-sandbox-integration` is
  writable. Not authorized for modification:
  `/home/james/ai-workspace/workflow_optimisation`,
  `/home/james/.config/opencode`, `/home/james/.config/systemd/user`, any
  active OpenCode plugin directory, or any other host configuration path.
  Read-only inspection of the workflow repository is permitted where tools
  allow. No workarounds through Bash, MCP, symlinks, alternate paths,
  subprocesses or temporary mounts. No direct install, deploy or modification
  of active OpenCode configuration.
- **Orchestrator stays read-only.** All permitted source edits, builds and
  tests are delegated to authorized sandbox workers.
- **Server-side security.** MCP Roots is not an access-control boundary; all
  access is enforced in the service and the underlying process sandbox. Per
  operation: accept only a server-defined logical root; accept only relative
  paths; reject absolute paths, null bytes, encoded traversal and `..`;
  canonicalize and confirm containment; use `lstat` or equivalent checks;
  reject symlink escape and unsafe symlink chains; reject devices, sockets,
  FIFOs and other special files; impose depth, item-count, file-size and
  response-size limits; produce deterministic output; perform no shell
  execution; require no network; run without elevated privileges.
- **Sensitive-path denies override all allows.** Deny at least: `.env` and
  `.env.*` (except separately reviewed examples if justified); SSH and GPG
  material; private keys and private certificates; password, token, secret and
  credential files; OpenCode authentication and MCP OAuth stores; keyrings and
  password stores; browser profiles; unrelated personal files. Focused tests
  must prove these protections.
- **Read semantics.** `hostfs_read` reads one explicitly selected regular text
  file, rejects binary and special files, imposes a conservative byte limit,
  reports truncation explicitly, and never silently follows a symlink outside
  policy. `hostfs_find_name` searches filenames/path components only, never
  contents.
- **Permission model (staged, not applied).** Global default denies
  `hostfs_*`. `gentle-orchestrator` allows `hostfs_roots`, `hostfs_list`,
  `hostfs_find_name`, `hostfs_stat`, with `hostfs_read` set to `ask`, retaining
  all existing read-only restrictions. A new read-only `host-config-researcher`
  subagent uses the five tools but cannot edit, execute, delegate or write
  memory. `hostfs_read` may be allowed for that specialist only if server-side
  restrictions are comprehensively tested; otherwise it stays `ask`. All other
  agents (`general`, implementation agents, SDD apply agents, frontend
  implementation agents, ordinary repository researchers, Systematic
  reviewers, isolated RDD/4R reviewers, `sdd-research`, vision agents) get no
  `hostfs_*` access.
- **Existing policies that must not change.** `grep: ask`; Nono security
  boundaries; peak policy; model assignments or fallback ordering; Astra
  selection policy; Magic Context behaviour; Gentle AI/Systematic routing
  except for the narrow hostfs addition; TUI plugin-discovery requirements; the
  local auto-update plugin URI (`file:///home/james/.local/share/opencode-plugin-auto-update-local/dist/index.js`);
  cache-pruning service behaviour. Do not add a cache-prune systemd pre-hook.
- **Repository discipline.** Use existing repository conventions. Tests run in
  temporary fixture roots, never against real secret-bearing directories.
  Commit only sandbox-repository changes, Conventional Commits, no push. Do not
  commit or claim to commit workflow-repository changes. Do not run recovery
  against the live config.
- **Agent sessions never execute** the handoff, installation or rollback
  scripts, and never apply the staged permission model.

## Tasks

Stable IDs; each task is a reviewable change unit.

### T1 — MCP server core and the five read-only tools

Implement the `hostfs` MCP server with exactly `hostfs_roots`, `hostfs_list`,
`hostfs_find_name`, `hostfs_stat`, `hostfs_read`, a stable local entrypoint,
and tool schemas that expose no additional surface.

- Done when: the server initializes; `tools/list` reports exactly the five
  approved tools (subject to verified OpenCode name-prefix behaviour); no
  write/edit/create/move/copy/delete/chmod/shell/execution/lifecycle/arbitrary
  content-search tool exists.

### T2 — Root/policy configuration schema and logical-root allowlist

Define the schema and the six intended logical roots, and restrict callers to
server-defined logical roots only.

- Done when: only allowlisted roots resolve; absolute paths, null bytes,
  encoded traversal and `..` are rejected; `/`, `/home/james`, arbitrary
  caller-supplied roots and the whole OpenCode cache are not reachable.

### T3 — Sensitive-path deny policy and path-safety enforcement

Implement the deny list (override-all-allows) and the path-safety pipeline:
canonicalization, containment confirmation, `lstat`, symlink escape and chain
refusal, special-file refusal.

- Done when: every listed deny class is refused, and symlink escape, unsafe
  chains, devices, sockets and FIFOs are refused.

### T4 — Bounds, limits and deterministic read semantics

Implement depth, item-count, file-size and response-size limits; deterministic
ordering; binary/special-file rejection in reads; conservative byte limit with
explicit truncation reporting.

- Done when: limits are enforced on every operation and ordering is stable
  across runs.

### T5 — Unit tests

Tests for policy, containment, denies, symlink handling, special files, bounds,
truncation and binary rejection, in temporary fixture roots.

- Done when: the full coverage list below is exercised and the repository test
  suite stays green.

### T6 — MCP protocol integration tests

Exercise MCP initialization, `tools/list`, and each operation against temporary
roots; assert the absence of mutation tools.

- Done when: protocol-level tests prove the five-tool surface and per-op
  limits.

### T7 — Build configuration and local package/build manifest

Add build configuration and the local package/build manifest that pins the
stable local entrypoint.

- Done when: the server builds locally with no `npx -y`, no floating version
  and no network installation at OpenCode startup.

### T8 — Operator documentation

Document the five tools, roots, deny rules, limits, and safe usage.

- Done when: an operator can run and reason about the server from the docs
  alone.

### T9 — Workflow integration manifest (permission model and behaviour)

Produce the manifest describing the required workflow integration: global deny,
orchestrator four-allow-plus-one-ask, `host-config-researcher` surface, the
eight staged workflow behaviours, and the route contract. Do not apply it.

- Staged behaviours: (1) use AFT/CodeGraph/AST inside repositories; (2) use
  hostfs metadata tools only for approved host paths outside the project;
  (3) use orchestrator `hostfs_read` only for a necessary, exact file and with
  approval; (4) delegate multi-directory or content-bearing host investigation
  to `host-config-researcher`; (5) include logical roots, objective, expected
  evidence and scope limits in the Task brief; (6) treat missing or denied
  access as a limitation, not authority to use Bash or broader traversal;
  (7) never give hostfs access to isolated reviewers or implementation workers;
  (8) after compaction, retain relevant paths and findings rather than
  directory dumps. Keep global `AGENTS.md` lightweight; put detailed procedure
  in the appropriate scoped workflow skill.
- Done when: the manifest fully expresses the model without mutating any
  external configuration.

### T10 — Read-only workflow source capture and staging copy

If the workflow repository is readable: record its Git commit, dirty-state
summary and SHA-256 of every input file used; copy only necessary files into a
staging directory beneath the sandbox repository, preserving paths and
permissions; generate a minimal patch and a per-file manifest (original SHA-256,
resulting SHA-256, intended mode, reason). If it is not readable, produce an
integration manifest, proposed snippets/templates, and the exact files and
hashes still required — and do not fabricate a patch.

- Expected inputs may include `WORKFLOW.md`, `verify-workflow.sh`,
  `global-config/AGENTS.md`, `global-config/opencode.json`,
  `global-config/tui.json`,
  `global-config/plugins/workflow-health-check.ts`, relevant
  `global-config/skills/**` files, `config-manifest-host-tools.md`, and other
  files proven necessary.
- Done when: preimage hashes are recorded, staging contains only necessary
  files, and no unrelated file is staged or changed.

### T11 — Handoff bundle generator and checksum manifests

Generate `integration-output/hostfs-workflow-integration/` containing
`workflow-integration.patch`, `preimage-sha256.txt`, `result-sha256.txt`,
`apply-hostfs-integration.fish`, `rollback-hostfs-integration.fish`,
`install-hostfs-runtime.fish`, `README.md`, a built-runtime manifest or
reproducible build instructions, and a complete test report.

- Done when: the bundle is self-contained and hash-guarded.

### T12 — Fish apply/rollback/install scripts

Apply script: target exactly
`/home/james/ai-workspace/workflow_optimisation`; refuse any other target unless
explicitly supplied and validated; verify every preimage hash before any
change; fail without mutation on mismatch; require a clean or explicitly
acknowledged worktree; create a timestamped backup outside the files being
changed; run `git apply --check` or equivalent before applying; apply only the
reviewed patch; verify every resulting hash; print the backup location and next
commands; never touch active `~/.config/opencode`.

Rollback script: validate installed files against expected post-apply hashes;
refuse ambiguous rollback; restore from the specific timestamped backup;
preserve subsequent unrelated changes; report what was restored.

Runtime install script (user-run only): build from the reviewed
sandbox-repository commit or install a hash-verified artifact; install to a
dedicated local location, not the plugin cache; avoid modifying active OpenCode
config directly; verify the installed runtime digest; instruct the user to run
workflow recovery afterward.

- Done when: scripts implement these behaviours and are never executed by an
  agent session.

### T13 — Staged verifier logic

Prepare, in the staging copy only, verifier checks: runtime exists and matches
the reviewed digest/version; OpenCode points to the pinned local entrypoint;
exactly five approved MCP tools exist with no write or arbitrary-content-search
tool; roots match the allowlist and `/` and broad `/home/james` roots are
absent; sensitive-path policy and limits match reviewed values; `hostfs_*` is
globally denied; orchestrator is four allow plus one ask;
`host-config-researcher` has the exact reviewed surface; other agents do not
inherit hostfs tools; workflow router and skills contain the route contract;
the local auto-update URI remains exactly
`file:///home/james/.local/share/opencode-plugin-auto-update-local/dist/index.js`;
active secure OpenCode has loaded current files after restart.

- Done when: recovery logic backs up files and fails closed on symlinks,
  malformed destinations or ambiguous state, preserving unrelated
  configuration; update staged `VERIFY_SCRIPT_SHA256` only after the staged
  verifier is final.

### T14 — Staged recovery tests

Test against a temporary fake OpenCode configuration: clean recovery;
idempotent second run; deliberate drift restoration; symlink refusal;
preimage-hash mismatch refusal; preservation of the local auto-update URI.

- Done when: all cases pass and recovery is never run against the live config.

### T15 — Evidence, readback and state reporting

Verify the implemented surface against the staging manifest and the brief;
record the test commands and observed results; report architecture and security
decisions, sandbox files changed, MCP tools and limits, logical roots and deny
rules, the sandbox commit hash, the workflow source commit/hash used, every
staged workflow file, the handoff bundle path and checksum, the exact Fish
commands the user must run, the expected verifier output, checks pending until
user deployment, and the rollback command.

- Done when: the report clearly distinguishes built-and-tested-in-sandbox and
  staged-for-workflow-integration from applied, installed, recovered and
  loaded states, and claims only the first two.

## Acceptance criteria

1. The server exposes exactly the five approved read-only tools; no write,
   execution, lifecycle or arbitrary content-search tool exists.
2. Every operation accepts only a server-defined logical root and a relative
   path; absolute paths, null bytes, encoded traversal and `..` are refused.
3. Canonicalization and containment checks, `lstat`, symlink-escape/chain
   refusal, and special-file refusal hold on every operation.
4. Sensitive-path denies override all allows and cover every listed deny class.
5. Depth, item-count, file-size and response-size limits are enforced with
   deterministic ordering; `hostfs_read` rejects binary/special files, applies
   a conservative byte limit and reports truncation explicitly.
6. Neither `/`, `/home/james`, arbitrary caller-supplied roots, nor the whole
   OpenCode cache is reachable; the package cache is not exposed through
   general traversal.
7. Tests cover the full brief coverage list and run only in temporary fixture
   roots; MCP initialization, `tools/list` and each operation are exercised.
8. The staged permission model matches the brief exactly (global deny;
   orchestrator four allow plus one ask; `host-config-researcher` surface;
   no inheritance by other agents) and is prepared but not applied.
9. The handoff bundle is self-contained and hash-guarded; apply/rollback/install
   scripts implement every stated requirement and are never executed by an
   agent session.
10. Existing policies listed above are unchanged, and only sandbox-repository
    changes are committed (Conventional Commits, no push).

## Checks

- Repository test suite green, with RED→GREEN captured for new assertions
  (per existing repository conventions; exact commands recorded in T7 and T15).
- Local build succeeds with the pinned local entrypoint; no `npx -y`, no
  floating version, no startup network install.
- Argv/path inspection: fixed logical roots; containment enforced; no shell
  execution and no network.
- `tools/list` readback: exactly five tools; mutation/arbitrary-search tools
  absent.
- Deny-rule readback: every sensitive-path class refused; deny overrides allow.
- Limits readback: depth, item, size and response bounds; deterministic order.
- Staged manifest readback: permission model and route contract match the
  brief.
- Staged verifier checks listed in T13 pass against a temporary fake OpenCode
  configuration; `VERIFY_SCRIPT_SHA256` updated only after the verifier is
  final.
- Any S17 path touched (e.g. `opencode/config-fragments/**`) is reviewed and
  installed by the user, never auto-applied.

## Authorized scope

Authorized: implement T1–T15 as reviewable change units under the ODD work-unit
rule, with sandbox-only mutation, after a separate apply phase is explicitly
launched.

Not authorized by this tracker: deployment, installation, mirroring to
`~/.config`, service restart, or commit/push/PR/merge/release in the workflow
repository; executing any handoff/installation/rollback script from an agent
session; applying the staged permission model directly; any change that weakens
a permission; and any change to the existing policies that must not change.

This tracker's creation is the only authorized output of the creating session;
no feature code, deploy, mirror, restart, or commit was performed.

## Delivery strategy

- Delivery strategy: `ask-on-risk`. Forecast at tracker creation: the change
  spans an MCP server, schema/policy modules, unit and protocol tests, build
  config, docs, a workflow-integration manifest, a staging copy plus verifier,
  a handoff generator, three Fish scripts and checksum manifests — well past
  400 authored lines. Recompute from work-unit commits; when the running total
  crosses ~400 authored lines, apply the chosen strategy before the next
  commit.
- Chain strategy: `stacked-to-main` (the user's standing choice). Each unit
  lands on the default branch in order as its own reviewable slice.
- Likely slices (confirm at implementation time): Slice 1 = T1–T4 (server,
  schema, policy, limits); Slice 2 = T5–T8 (tests, build, docs); Slice 3 =
  T9–T14 (workflow manifest, staging, bundle, scripts, verifier); Slice 4 = T15
  (evidence and readback).

## Progress

| Task | Status  | Notes |
|------|---------|-------|
| T1   | pending | Not started. MCP server core and the five read-only tools. |
| T2   | pending | Not started. Root/policy schema and logical-root allowlist. |
| T3   | pending | Not started. Sensitive-path denies and path safety. |
| T4   | pending | Not started. Bounds, limits and deterministic read semantics. |
| T5   | pending | Not started. Unit tests. |
| T6   | pending | Not started. MCP protocol integration tests. |
| T7   | pending | Not started. Build configuration and local build manifest. |
| T8   | pending | Not started. Operator documentation. |
| T9   | pending | Not started. Workflow integration manifest and staged behaviour. |
| T10  | pending | Not started. Workflow source capture and staging copy. |
| T11  | pending | Not started. Handoff bundle generator and checksum manifests. |
| T12  | pending | Not started. Fish apply/rollback/install scripts. |
| T13  | pending | Not started. Staged verifier logic. |
| T14  | pending | Not started. Staged recovery tests. |
| T15  | pending | Not started. Evidence, readback and state reporting. |

## Evidence

- Tracker created: `odd/tasks/hostfs-mcp-integration.md` (this file).
- Authoritative brief restored at `docs/hostfs.md` from the brief's four parts
  (parts 1–4), written verbatim with nothing added or removed:
  - SHA-256: `a6fbd06a7c53e87fbff4dcb57acad50b02b46517548b04e7ca2c8ad88bf7e70d`
  - Line count: 446
  - Observed prior state in the working tree (2026-09-19): `docs/hostfs.md`
    was corrupted — the first line began `ld the restricted…` (truncated
    `Build`), list items were collapsed into single lines, and a stray `G`
    trailed the file. The restored file replaces that state.
- Read-only observations used while preparing this tracker (2026-09-19):
  - `broker/src/config.ts:320` — `maxApplyDiffLines: 200` (default).
  - `broker/src/service.ts:1153` — `APPLY_PREVIEW_MAX_LINES = 400`.
  - `broker/src/copy-review.ts:56-65` — `assertCopyOutReviewLimit`; only
    source-code extensions are line-bounded, documents are not.
  - `broker/src/service.ts` `runPrepare` stages with
    `:(exclude).broker-tmp` and `:(exclude)*.bundle`, so the broker's
    `ses_*.bundle` artifact is excluded from a result.
- No feature code, deploy, mirror, restart, or commit was performed in this
  session.

## Next step

T1 — implement the `hostfs` MCP server core and the five read-only tools,
after a separate apply phase is explicitly launched. Confirm the S17 review
path before touching any `opencode/config-fragments/**` or other protected
file.
