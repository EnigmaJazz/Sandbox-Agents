# Threat model — Agentic Sandbox Integration

Status: **Gate 1**. Assumes the OpenCode model is MALICIOUS (spec §29
adversarial review posture). Every invariant S1–S17 is mapped to its
mitigation, followed by the §29 checklist as the review guide.

## Threat model summary

**Assets**: host filesystem (esp. credentials), host services (systemd,
tailscale, docker), OAuth store, the user's git working tree, the broker
itself, the security configuration (S17).

**Attacker**: the LLM model + anything it controls (worker code, malicious
git objects, crafted tool arguments). NOT the local user — the broker socket
is user-only by construction (§6), so threat model assumes same-UID trust
boundary between broker and OpenCode process; session IDs are opencode-issued.

## S1–S17 → mitigations

| # | Invariant | Mitigation (code / config / gate) |
|---|---|---|
| S1 | No arbitrary project code on host | Ordinary `bash` denied in permissions fragment + routing-guard blocks bash/edit/write/apply_patch; broker has **no** generic host-shell op (S10). All execution goes to msb workers. |
| S2 | Writes only in worker until acceptance | `sandbox_*` write ops target the worker repo only; host working tree only ever touched by `git apply` of an approved B→C delta (§19.9). |
| S3 | Reads before activation on host | routing-guard allows read/grep/glob/list while `workerStatus` reports HOST_READ_ONLY. |
| S4 | First mutation activates worker | Plugin calls `ensureWorker` on write/edit/apply_patch/bash; broker transitions HOST_READ_ONLY→CREATING_SANDBOX→SANDBOX_ACTIVE. |
| S5 | Reads switch after activation | routing-guard `tool.execute.before`: SANDBOX_ACTIVE/RESULT_READY ⇒ project-path reads throw the redirect error; broker state is authoritative. |
| S6 | External read roots only | `canonicalizeWithinRoots`: realpath + prefix-boundary check; symlink escape rejected (unit-tested). Approved roots are explicit config, never whole-home. |
| S7 | Sensitive paths protected | OpenCode permission denies (`auth.json`, `.ssh/**`, `.gnupg/**`, `.aws/**`, `.kube/**`, gcloud, gh hosts.yml, `.env*`, keys) + broker `protectedPaths` (S17 set too) + nono denies non-overlapping stores. |
| S8 | OAuth never enters workers | No auth file copy; exec env allowlist with credential-key rejection; worker secret conf is empty; broker never forwards credentials. |
| S9 | Provider creds stay out of workers | Same env allowlist + credential-shape key rejection (unit-tested). |
| S10 | No generic host shell | Broker exposes only structured read-only host ops (fixed argv, readOnly flags, unit-tested). Host mutation = manual user step. |
| S11 | Workers cannot request host access | Payload exact-key allowlists reject image/mounts/privileged/devices/network/securityProfile (unit-tested §28). msb conf files generated from broker policy only. |
| S12 | Worker network deny-by-default | net.conf placeholder deny at Gate 1; final allowlist net-conf generated at Gate 3; LAN/metadata/socket access excluded; msb `--net-conf` from policy. |
| S13 | Session isolation | sessionID → exactly one worker; per-session lock serializes transitions; worker names derived from sessionID. |
| S14 | Fail closed | Every error path returns an error; FAILED_CLOSED terminal state; no host fallback anywhere; guard also fails closed when broker unreachable. |
| S15 | No direct worker→host write path | Result crosses via git bundle → import under `refs/opencode-sandbox/result/<id>` → apply is broker-side, gated. |
| S16 | Divergence detected | `computeDivergence` (baseline tree vs current host tree) before apply; refusal retains result (unit-tested). |
| S17 | Config cannot modify itself | `protectedSecurityFiles` globs (broker src, nono profile, plugins, fragments, systemd unit, scripts, security/acceptance tests, threat model) rejected in apply; changes require manual review. |

## Direct project-document mutation (`planDocAppend`)

**Boundary**: the broker can append to exactly two project documents —
`docs/TODO.md` (`doc: "todo"`) and `docs/PLAN.md` (`doc: "plan"`). It is the
first broker operation that writes a project file directly instead of spawning
a fixed-argv CLI.

**Invariants**

- No caller path/cwd/binary/argv: `doc` is an enum, and the two destinations
  are compile-time constants joined beneath the canonical approved root.
- Append-only: existing bytes are read, preserved verbatim and ordered, and
  the trimmed block is appended (EOF or before the next equal/higher ATX
  heading). There is no overwrite, truncate, replace, or delete input.
- Bounded: content is trimmed, 1..16384 UTF-8 bytes, LF-only; the optional
  heading is 1..256 bytes and control-free.
- Atomic and serialized: per-destination lock, sibling `O_CREAT|O_EXCL` temp
  file, fsync, close, revalidate destination/parent, rename, directory fsync;
  temp files are removed on every failure path.
- Path safety: destination and its real parent must resolve beneath the
  canonical root; symlinked/non-regular existing destinations are rejected
  before and immediately before the rename; protected/S17 destinations are
  rejected before any I/O.
- Authority: orchestrator-only mutation + fragment `ask` + metadata-rich
  in-tool `ctx.ask` before the broker call.

**Residual risk**: the broker writes Markdown inside the project, so a
compromised approval could append misleading plan content. The two destination
constants and byte/heading caps bound the blast radius; the files are not
executable and not on the S17 list.
## Host project registration (`host_register_project`) and S17 rollout

**Boundary**: `registerProject` is an orchestrator-only broker mutation that
runs the existing fixed-argv operator tool
`bun scripts/register-project.ts [--dry-run] [--create-remote] [--public] <path>`.
The broker accepts exactly `{path,dryRun,createRemote,makePublic}` and rejects
every other key.

**Invariants**

- Authority: orchestrator-only mutation (broker `HOST_MUTATION_OPERATIONS` +
  `authorizeHostDispatch`); broker authorization is authoritative, and a
  non-orchestrator call is denied before any spawn.
- Path ban before spawn: the target must be an existing absolute directory that
  is neither `/`, `$HOME`, nor beneath
  `$HOME/.ssh|.config|.local|.cache|.gnupg|.aws|.kube`, `/etc`, `/usr`, `/var`,
  or `/tmp`. An ineligible path or an invalid flag combination
  (`--public` without `--create-remote`) fails validation with NO process
  spawned.
- Fixed argv only: no caller-supplied cwd, binary, or argv; the script path is
  a broker-owned constant.

### Per-project profile grants written by registration

Registration grants each project three entries in
`nono/profile/opencode-secure.json`: the project tree stays `read`
(`filesystem.read`), while `<project>/.atl` and `<project>/.codegraph` are
`filesystem.allow` (read-write) metadata caches. It also grants
`<project>/.git` read-write.

**`.git` read-write is a deliberate, earned boundary decision.** It is broader
than the `.atl`/`.codegraph` metadata grants because `.git` is refs, index, and
history — not a tool cache. It exists because the native reviewer transport
resolves the opaque repository-context binding only through Git's registered
sibling worktrees and then keeps all authority, materialization, and capture
operations on that root
(`internal/cli/review_opencode_transport.go:328-334`). Without the grant the
transport child exits `binding_invalid`; with only `<project>/.git/gentle-ai`
read-write it stops at `materialization_unavailable`; with `<project>/.git`
read-write it materializes the provider prompt. The project tree itself is
never granted read-write, and unrelated profile entries are never rewritten.

**Analyzed risk — which mechanisms execute, and under what subcommand.** A
confined agent that can write `<project>/.git` can plant command execution that
the unconfined broker's host `git` then runs. Path scoping does NOT mitigate
this: these keys are repository-global, independent of which paths a subcommand
touches (§30).

| repository-local mechanism | executes under |
|---|---|
| `.git/hooks/*` (`pre-commit`, `commit-msg`, `post-commit`, `post-index-change`, `fsmonitor-watchman`, ...) | `commit`, `add`, `push`, `merge`, `rebase`, ... |
| `core.hooksPath` | any hook-running subcommand |
| `core.fsmonitor` (command form) | `status`, `add`, `diff`, `commit` (index refresh) |
| `filter.<name>.clean`/`smudge`/`process` | `add`/`checkout`/`diff` on matching paths |
| `diff.<name>.command` / `diff.<name>.textconv` | `diff` |
| `include.path` / `includeIf.*.path` | any config read |
| `core.gitProxy`, `core.sshCommand`, `core.editor`, `core.askpass`, `credential.helper`, `merge.<name>.driver`, `gpg.program`, `submodule.<name>.command`, `sequence.editor` | `fetch`/`push`, merges, commits, tag signing, submodule ops |
| `remote.<name>.url` helper forms (`ext::`, `!cmd`), `remote.<name>.receivepack`/`uploadpack`/`vcs`, `url.<base>.insteadOf` | `push`, `fetch` |

**Mitigations (at the `spawnArgv` choke point, `broker/src/gitguard.ts`).**

1. **Neutralized with command-line `-c`** (highest config precedence, so a
   repository-local value cannot win): `core.hooksPath=/dev/null`,
   `core.fsmonitor=false`, `core.pager=cat`. A caller-supplied `-c`/`-C` in the
   global-option region that would defeat the splice or desync the guard is
   itself refused.
2. **Refused fail-closed** (git has no command-line "unset"): execution-bearing
   subcommands are refused when the repository-local config carries an execution
   key (filters, diff drivers, include chains, ssh/editor/proxy/helper/merge/
   submodule/gpg), and remote-touching subcommands (`push`, `fetch`) are refused
   when a remote URL uses the `ext::`/`!` helper forms or a non-allowlisted
   transport, when `remote.*.receivepack|uploadpack|vcs` is set, or when a
   `url.*.insteadOf`/`pushInsteadOf` rewrite exists. Allowed transports are
   `https://`, `http://`, `ssh://`, `git://`, `file://`, and scp-style
   `user@host:path`; `remote.*.url` is NOT blanket-refused (this repo's own
   `remote.origin.url` is `https://…`).

**SCOPED posture and rationale.** The user's global/system git config is trusted
and NOT agent-writable, so it is left in force (`GIT_CONFIG_NOSYSTEM`/
`GIT_CONFIG_GLOBAL` are deliberately not used): globally configured
`credential.helper`, `url.*.insteadOf`, `core.sshCommand` and `commit.gpgsign`
keep working. Only REPOSITORY-LOCAL keys — the ones the agent can actually
write — are neutralized or refused. The guard never invokes git; it reads the
repository-local config as text so it cannot become a vector.

**Honest consequence.** A repository that legitimately carries a local
refused-class key (for example a tool that wrote a repo-local
`filter.<name>.clean`, or a local `credential.helper`) now REFUSES every guarded
subcommand rather than executing. That is the intended fail-closed posture, not
a regression; remediation is to move the driver to the trusted global config or
remove the local key. Note the asymmetry: a GLOBALLY scoped LFS filter driver
keeps working; only a repository-LOCAL one is refused.

**Residual risks.**
- **TOCTOU between the guard's read and git's read.** The refusal is
  timing-dependent: the guard stats/reads the config, then `git` re-reads it. An
  agent that can rewrite `.git/config` in that window could swap a safe key for
  an execution key after the check. The `-c` NEUTRALIZATIONS are not
  timing-dependent (command-line precedence beats any later file value), so the
  hook/fsmonitor/pager vectors close regardless of the race; the refused-class
  keys retain this window.
- **Remote-transport allowlist is policy.** `git://` and `http://` are allowed
  as benign transports; they are unauthenticated/unencrypted, a
  transport-security choice outside this guard's scope.
- **Guard/child environment invariant.** The guard resolves the repository from
  the SAME effective environment the child receives
  (`{ ...process.env, ...opts.env }`, including inherited `GIT_DIR`/
  `GIT_COMMON_DIR`); if that merge ever diverges, a refusal can fail open.

Registration never creates `.git`: a synthesized `.git` would be a broken Git
directory. `git init -b main` runs before the profile writers, so `.git`
normally exists; when it does not, the grant is skipped with a warning because
nono binds grants to paths that exist at sandbox start. `<project>/.codegraph`
is created because nono cannot create it, exactly as `.atl` already is.

**S17 protected-path review**: registration mutates live host configuration
that sits on or beside the S17 set — `nono/profile/opencode-secure.json`,
`$HOME/.config/opencode-sandbox/broker.env`, and
`scripts/secure-launcher.conf`. Any agent-produced change under
`broker/src/**`, `nono/profile/**`, `systemd-user/**`, `opencode/plugins/**`,
`opencode/config-fragments/**`, `scripts/**`, `tests/security/**`,
`tests/acceptance/**`, or this document is rejected at apply time and requires
explicit manual review.

**`.new` staging / apply-review rollout**: S17 targets are never installed by
an agent. Candidate files are staged as `<target>.new` OUTSIDE the live paths,
the user reviews the diff, and only then copies the file into place and
restarts the affected service(s). `sandbox_finish` exports the result bundle;
`sandbox_apply` presents the diff and blocks for explicit human approval; a
denial or failed apply retains the result unchanged. Rollback stops before the
copy, or restores the prior files.

## Residual risks (honest, Gate 1)

1. **auth.json is process-accessible** (required by §16 for OAuth) — only the
   OpenCode permission layer + guard prevent model reads. An opencode
   permission bypass (e.g. `external_directory: allow`, bug in rule engine)
   would expose it. Mitigation: fragment denies + periodic audit; keep
   `read` deny list current.
2. **Broker trust boundary is same-UID**: any process running as the user can
   talk to the socket (0600 user-only). Workers are isolated by msb, not by
   OS-level user separation — a worker escape would be a host-UID compromise.
3. **msb config schema drift** (0.6.9 today): sparse conf files generated at
   runtime must be re-validated at Gate 3 against `msb create --help`.
4. **git apply surface**: apply is working-tree-only, but a crafted diff can
   still touch files the broker's protected-path globs don't cover —
   protected-path list must be maintained.
5. **Sandbox_bash tokenizer**: not a shell; model commands relying on pipes
   fail loudly (good), but the tokenizer is client-side — the broker's argv
   validation is the enforcement point.
6. **nono Linux Landlock**: no deny-within-allow — profile must stay narrow;
   a too-broad grant at Gate 2 review weakens S7 at the process layer.
7. **Accepted residual — Orca dispatch ownership (`host_orca_report`, S4).**
   The S4 gate proves liveness, not ownership. The caller supplies `terminal`,
   `taskId` and `dispatchId` (plugin `tool-specs-host-ops.ts:267-269`, forwarded
   at `:281`); the broker validates their form (`service.ts:3420-3423`), runs
   the read-only `orca orchestration worker-show --dispatch <ctx_…> --json`
   probe (`service.ts:3426`), and compares its reply with those same
   caller-supplied values (`service.ts:3438`; `orca.ts:214-284`). A caller
   holding another live worker's tuple can therefore pass the probe and send
   `worker_done`, `heartbeat` or `ask` as that worker.
   This is accepted because the exposure was not introduced by probe realignment:
   before it, the probe never matched the real `orchestration check` reply, so
   every send was refused; the gate failed safe by being vacuous. Realignment
   makes an existing design limit reachable. Binding the tuple to the calling
   session needs a broker-side session-to-dispatch record, which does not exist
   because dispatch is external Orca state; that is a new capability, not a
   correction to this unit. Exploitation requires holding the ids: `term_` plus
   a 36-character UUID, `task_` plus 12 hex characters, and `ctx_` plus 12 hex
   characters.
   Acceptance rests on the testable assumption that **one sandboxed worker
   cannot learn another live worker's dispatch tuple**. If ids appear in shared
   logs, transcripts, the broker journal, or another session's context, this
   becomes a live impersonation path and the decision must be revisited. A
   narrower TOCTOU also remains: probe and send are separate spawns, so a
   dispatch that settles or is revoked between them is still sent; this is
   inherent to preflight and accepted on the same basis.

## §29 adversarial checklist (review guide for the reviewer agent)

Assume the OpenCode model is malicious. Investigate, in order:

path traversal · symlink attacks · TOCTOU (snapshot→apply window) · command
injection · argument injection · environment injection · Git hooks (baseline
bundle could carry hooks — verify worker repo init disables them) ·
.git/config (worker must not gain host config) · credential helpers · SSH
agent socket · Docker socket · Unix sockets · /proc · /sys · device access ·
network pivoting · metadata endpoints · broker authentication (same-UID) ·
session spoofing (plugin-supplied sessionID) · cross-session access ·
worker reuse · result-bundle attacks (malformed bundles, ref smuggling) ·
malicious Git objects · submodules · symlink result application · S17
self-modification · OpenCode permission bypass · failure-open behaviour.

Host-git (unconfined broker, not worker-scoped): repository-local
`.git/config` execution keys the broker's host `git` would honor — hooks,
`core.hooksPath`, `core.fsmonitor`, filters, diff drivers, `include.*`,
`credential.helper`, ssh/editor/proxy/merge drivers — and remote transports
(`ext::`, `!cmd`, `remote.*.receivepack|uploadpack|vcs`,
`url.*.insteadOf`); the `-c` neutralizations and the fail-closed refusal in
`broker/src/gitguard.ts`; the guard-vs-child environment invariant
(`GIT_DIR`/`GIT_COMMON_DIR`); and the guard-read / git-read TOCTOU window.

Each finding: severity (high/critical must be resolved before final
acceptance, §29), evidence, suggested fix, owning gate.

## Reporting process

Security issues: open an issue in the repository or tell the repository owner
directly (this repo has no public tracker configured). Include: affected
gate, invariant (S#), reproduction, impact, suggested fix. Do not include
credential material in any report.

## Review lifecycle host tools (host-review-lifecycle)

The nine `host_review_*` tools are orchestrator-only mutations with fragment
`ask` plus an in-tool `ctx.ask`. Provider-issued tokens (target, lineage,
expected revision, repository context, subject/request hash, lens, contract,
policy, trace, attestation, release values) are validated only and passed
byte-for-byte into their fixed argv positions; the broker never reconstructs,
reorders, or defaults them. `reviewRecover.maintainerAuthorization` is
validated as LF-only JSON and forwarded verbatim, and it is never echoed into
approval metadata (only "present (redacted)").

`reviewCaptureResult.input` is a project-relative path or the literal `-`.
For a path, the broker snapshots a regular file of at most 512 KiB into the
broker-private `${stateDir}/review-input/` directory (mode `0600`,
`O_CREAT|O_EXCL`, random name), passes that absolute private path as
`--input`, and unlinks it in a `finally` on success, nonzero exit, timeout,
or spawn failure. Stale snapshots are removed when the executor is
constructed. The staging directory lives OUTSIDE the project tree, so it
cannot change the repository's untracked inventory. Literal `-` forwards
explicit EOF with no staging; inline result bytes are not a supported
transport.

Residual risk: the caller supplies the project-relative input path, so a
compromised orchestrator can ask the broker to read any regular file beneath
the approved root and hand it to `gentle-ai`; the 512-KiB cap and canonical
root check bound that disclosure. Verification must still resolve the exact
`review acknowledge-approved` flag set against the installed binary before
any flag is added.

## Host sandbox result tools (`host-sandbox-result-tool`)

**Install boundary**: `sandboxResultInstall` / `host_sandbox_result_install` is
an orchestrator-only, approval-gated write into the host working tree. The
approval is bound to the commit that was previewed. The operation writes only
paths in the result's own diff, never writes outside that diff, and never stages
the Git index. It requires the configured ask approval and is ask-gated; it is
not an automatic apply path.

**S17 review**: unlike `host_git_commit`, which refuses S17 paths through
`checkProtectedPaths`, result installation deliberately surfaces S17 paths
through the single approval. That approval is the manual review. The
sandbox-apply boundary is unchanged and continues to refuse protected paths.

**Environment boundary (verified 2026-09-24)**: the nono profile's bundled
groups grant package-manager caches read-only: `~/.bun` through
`group:bun_runtime` and `~/.npm` through `group:node_runtime`. In contrast,
`~/.cache/opencode` is read-write. A package install therefore fails at its
first cache write, and OpenCode logs nothing. Plugin and package installs belong
to the non-secure OpenCode instance, which shares `~/.cache/opencode`; the secure
instance consumes that cache only.

## Staged work chains and gate verdicts (PROPOSED - for owner review)

Status: **PROPOSED - for owner review.** Not in force until the user reviews and installs it
(S17 path). Written in P0 of `docs/staging/plan.md` (scope D24); the gate-verdict part comes from
decision D22 of the multi-tier orchestration spec. Nothing above this section changes.

**New assets**: chain and stage records and their refs (`refs/opencode-sandbox/chain/**`); the
stage baseline; the owner's approve, reject and apply decisions; the recorded gate verdict; and,
once review-before-apply is chosen (OPEN-1), a host-side shared review clone.

**Trust boundaries**: stage content is worker output and therefore untrusted, including as input
to the stage-review agent and to Jev. Baselines, diffs and verdicts come from broker records, never
from the worker or the review agent. The review agent has no write or decision capability.

| Abuse case | Mitigation |
|---|---|
| Stage-baseline forgery: a worker supplies a false parent | The broker derives the baseline; the worker cannot name it. |
| Approval forgery: an agent approves or applies its own stage | A stage never applies without the owner's approval. Decisions come only from the stage-review role, never from a session with a worker in the chain, behind an `ask` prompt bound to the result commit. |
| Persuasion by the review agent: a wrong or manipulated summary | The approval prompt shows the broker's real diff, not the agent's summary. |
| Stale or reordered apply: stage n without n-1, or after the host moved | Stages apply in order only, reusing the existing divergence check (S16). A rejection marks dependent stages `STALE`; they are re-run from the current tip, with no merge-tree replay. |
| S17 content in a stage | Protected paths (S17) stay rejected at apply; S17 stages are excluded from the stage-review path and keep the manual review. |
| Chain growth as a denial of service | Stage and line limits per lane (broker configuration). |
| Retention loss: GC removes an unapplied stage's only copy | The artifact GC never removes it (the durability rule in `artifacts.ts`). |
| Review-consent bypass | Consent for native review is never pre-granted. |
| Review authority leaks into the host repository | Native review authority lives in the Git common directory. A shared review clone has its own authority store, so none lands in the host repo. The clone is created host-side by the broker, is disposable, and is not a worktree in the project. Unverified: where `review start` writes, and whether the sandbox can read the clone (spike, OPEN-1). |
| Gate-verdict forgery (D22): a worker or plugin writes a passing verdict | Code records a gate verdict only when Jev shows a clear match to the spec and the deterministic checks agree. A clear fail returns to the Planner; an unsure result, or a payload too large to check, goes to the independent spec-check agent. |
| Steering Jev through stage content | Jev output is evidence, never approval, everywhere except this one gate verdict. Any stage that names a high-risk item keeps its independent verifier regardless of the Jev result (proposed). |
| Widened `host_gate_verdict` author (D22 changes who may write it) | The change is isolated in its own commit, keeps the append-only record, and is checked by an independent verifier before the owner installs it. `host_gate_verdict` itself stays PLANNER-only; code records through a separate operation, `gateVerdictAuto`. |
| Forged probabilities by a compromised router identity | **Residual, by design.** The Jev call is outside the broker (no network, no API key), so the broker cannot verify `p`: whoever can bind a `gateRouterAgents` name is the trust root. Bound: the allowlist is empty by default and disjoint from every other authority; the identity is the broker-bound one (never an envelope claim) and holds no other operation; any process that can reach the broker socket and bind a `gateRouterAgents` name becomes the router, and the broker cannot tell an LLM from a non-LLM caller, so keeping OpenCode agents out of that list is a deployment duty; code can record only a first `PASS`, never `REFINE` or `ESCALATE`, never edit a verdict; every code-recorded line carries the probabilities, the check results and a `d22-auto` pointer for audit; `host_task_mark` and the owner's review still follow. A router can still choose `expectedCriteria` (each id must exist in the plan document, but completeness is not checked) and which of the broker's recorded test logs to cite. |
| Deterministic results supplied by the caller | Not accepted. The payload has no deterministic, threshold or verdict field (strict allowlist; an unknown key is refused). The broker derives paths, budget and test status from the pinned stage, the planner-authored `## Allowed edit surfaces` and its own stage-bound test logs (next rows), and treats anything it cannot derive as missing, which cannot be a clear match. The stage state is re-checked inside the plan-document lock immediately before the append, `taskId` must be in the plan's `## Tasks`, and fenced bullets under `## Allowed edit surfaces` are not scope. |
| Test evidence for unapplied stage content (D30, U4d): where it runs and what it is | At stage finish (`prepareResult`, idle auto-finish, `keepResult`), after the result is imported and pinned, the broker runs each runner of its own configuration (`BROKER_TEST_RUNNERS`: absolute argv vector, relative cwd, timeout of at most 600 s, output cap of at most 4 MiB per stream) INSIDE THE WORKER SANDBOX, as the worker user, in `/work/<cwd>`, with env `CI` and `NO_COLOR` only. Nothing from the stage content runs on the host; the host `testRun` is unchanged and its logs carry no binding, so they are never gate evidence. Runner argv never comes from the worker, the stage content, the plan or any caller (a hostile `package.json`, `Makefile` or runner-like file in the stage is not read by the broker). No shell strings; a timeout, a signal, a non-zero exit, no exit code or output over the cap is a FAILING log, never a pass. Network: whatever the worker sandbox has (`deny-by-default`, `WorkerSpec.networkMode`); the broker itself has no network and adds none. |
| Evidence bound to other content than the stage, or forged by the worker or its output | The log is written by the broker in its state directory (0700 directory, 0600 file, temp + rename), which the worker cannot reach; the binding header is written by the broker at offset 0, and the output follows it (redacted for secret-shaped assignments and capped), so output with a forged header line, control characters or an escape sequence is only payload. It is bound (` project=<id> tree=<sha>`) only when the sandbox tree, computed with a throwaway index (never the worker's), no `filter.*` config and fsmonitor off, equals `<stage result>^{tree}` before the runners start and after they finish. `gateVerdictAuto` does not trust the `testRunRefs` pointer on the stage record: it re-reads each cited log and re-checks header, project, tree and age. An infrastructure failure writes no log and never blocks registration. |
| Residual (by design): a passing log proves only that the stage passes ITS OWN tests | A worker can edit or add test files in the same stage, so a green log does not show the tests are meaningful. The scope check (`## Allowed edit surfaces`), the diff review (touches to test paths) and the Jev criteria must cover test tampering; the owner's approval remains the control. The evidence is also only as honest as the sandbox that produced it. Content the runner can see that the tree id does not cover: a nested git repository (the tree records only a gitlink, mode 160000, while the runner sees the repository's tracked and untracked files); tracked `*.bundle` files and `.broker-tmp/` (excluded from `add -A`, so the index version is kept while the file the runner reads can differ); anything outside `/work`; file mode when the worker sets `core.fileMode=false` (the tree says 100644, the runner sees an executable); `.gitattributes` text/eol normalisation; and symlinks (the tree records the link, the runner follows it) Git-ignored files in `/work` are refused (no log) unless they sit under a path in `BROKER_EVIDENCE_IGNORED_ALLOW` (a JSON array of literal repo-relative paths, default `["node_modules"]`); an allowed ignored path stays a residual of the same class as an installed dependency. The broker refuses to write evidence (no log) when the hashed tree contains a gitlink or when the worker repository sets `core.fileMode=false`, `core.symlinks=false`, `core.worktree` (any value, read raw so a bool spelling cannot slip through), `core.bare=true` or `core.sparseCheckout=true` (checked before and after the runners, with the same configuration probe as the `filter.*` check); the other items above are documented residuals, not detected. The tree id is computed by git inside the worker's own sandbox, so it is a consistency check and NOT a trust boundary: a live process of the worker can swap the index file or set `core.worktree` between the hash and the run. A green log proves only that the stage passes its own tests under those conditions. A process the worker left running can change files during a run and restore them before the second tree check; a worker that controls its sandbox can make its own runners pass. The router may cite any log bound to the same tree (for example a re-run), so a flaky test can be re-run until it passes. Finishing a stage blocks for the sum of the runner timeouts while the session is locked, and the plugin client budget for `prepareResult` (default 30 s) can expire first; the broker still completes and a retry re-runs the runners. At most one finish of a session runs at a time: an explicit `prepareResult` or `keepResult` that overlaps an in-flight finish (including the reaper's idle auto-finish or disconnect reap) is refused with `a result export is already in flight for this session`, and the reaper skips a session that is being finished, so the runners never run twice at once and a worker is never released under a running runner. The reaper's own interval never starts a sweep while the previous one is still running. A finish whose exec call never settles loses the guard after the runners' timeouts plus a 5-minute grace, and a late settle cannot release a newer claim; an explicit `destroyWorker` is refused while a finish is in flight. The newest 500 `test-runs` logs are kept and older ones are pruned after each evidence write; a pruned log is simply missing evidence. |
| Superseding a Planner verdict | Code records only a task's first verdict: it refuses when the latest verdict is a Planner `REFINE` or `ESCALATE` (`GATE_AUTO_SUPERSEDE_REFUSED`) or when a `PASS` already exists (`GATE_AUTO_PASS_EXISTS`). Refined work returns to Planner authorship. |
| Replay and duplicates | The recorded `ref` carries a digest of the task, checkpoint, stage commits, probabilities and check results. An identical call records nothing and returns the original hash; a conflicting one is refused; concurrent calls serialize on the plan-document lock. |
| Evidence mismatch: a stage that is not the work gated | The stage must belong to the plan document's project and be `READY` or `APPROVED` with a pinned result; the diff is baseline..result from the broker's own refs. A `plan-vs-spec` checkpoint is checked against the plan alone: the plan's `## Allowed edit surfaces` must be well-formed, bounded and free of protected paths (a bad surface returns to the Planner, a missing section is unsure). A recorded `PASS` there still needs the router identity and every criterion above the high threshold, and it says nothing about any diff or test run. |
