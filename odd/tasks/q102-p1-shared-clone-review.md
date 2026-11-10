# ODD Tasks — q102-p1-shared-clone-review

- **Feature:** `q102-p1-shared-clone-review`
- **Project:** `sandbox-integration`
- **Status:** **PROPOSAL — planning only.** OPEN-1 is decided (review before apply, on a host-side
  shared clone). The profile read grant is not installed yet and the D37 trial run has not been
  started. No P1 code exists.
- **Created:** 2026-11-10
- **Parent:** `odd/tasks/staging-chains.md` (Q102; T1 P0 spike), `docs/staging/plan.md`
- **Source:** owner decision relayed in the 2026-11-10 Orca dispatch (OPEN-1); spike evidence in
  `workflow_optimisation` `odd/advice/b0-native-review-on-staged-refs.md`

## Decision recorded (OPEN-1)

Native review runs **before** apply. The candidate is a **host-side** `git clone --shared` of the
project with the stage commit checked out detached; `--base-ref` is the stage's baseline commit and
`--committed-only` is set. The after-apply fallback in `docs/staging/plan.md` is **not** selected.

`review assess` and `review status` are base-to-HEAD only, so the stage commit must be HEAD of the
repository the command runs in. A clone keeps review authority in its own git common directory, so
nothing is written into the host repository; a linked worktree would share the host's `.git`. The
clone is disposable and holds no worktree inside the project.

## State directory

**Chosen path:** `/home/james/.local/state/opencode-sandbox/review-clones`

- It is the broker's own state root (`BROKER_STATE_DIR`, default in `broker/src/config.ts:455-458`;
  `systemd-user/broker.env` sets no override).
- Outside every project and outside every current sandbox grant. The staging design already treats
  the state directory as trusted (P2b advisory, `odd/tasks/staging-chains.md`).
- Per review: `<stateDir>/review-clones/<projectID>/<chainID>/stage-<n>.<attempt>`. A `projectID` may
  be a virtual `<rootID>~<project>~<name>`, so `~` is a legal path segment.
- Create-only, mode 0700, verified with `realpathSync`, and never inside a project.

## Profile grant (owner installs)

`nono/profile/opencode-v2-secure.json`, version 0.1.2 -> 0.1.3, one read entry. Read-only first:
`assess`, `status` and `start` run broker-side on the host (`broker/src/sdd-runtime.ts:312,368`), so
the sandbox needs to read the clone, not write it. If the D37 trial shows the in-process transport
must write authority, or its frozen-git temp dir, inside the clone's git directory, widening to
read+write needs a new owner decision carrying that evidence.

```diff
--- a/nono/profile/opencode-v2-secure.json
+++ b/nono/profile/opencode-v2-secure.json
@@ meta
-    "version": "0.1.2",
-    "description": "... NOT INSTALLED - delivery is manual (S17).",
+    "version": "0.1.3",
+    "description": "... A read grant for the broker's shared review clones lets a staged candidate
+      be read without granting the sandbox write access there (Q102 OPEN-1; review authority stays
+      in the clone's own git directory). NOT INSTALLED - delivery is manual (S17).",
@@ filesystem.read
       "$HOME/.nanobot/workspace",
+      "$HOME/.local/state/opencode-sandbox/review-clones",
       "$HOME/.local/share/opencode-v2/prefix",
```

`broker/tests/v2-launch.test.ts` carries the matching V2-only divergence: the path joins the
`v2Only` allowlist and a positive assertion pins the read entry, so the grant cannot be silently
reverted.

**Install (owner, Fish):**

```fish
./scripts/install-user-files-v2 --dry-run
./scripts/install-user-files-v2 --apply
```

The installer copies `nono/profile/opencode-v2-secure.json` to
`~/.config/nono/profiles/opencode-v2-secure.json` and journals it; the running V2 process picks the
profile up at its next launch. Agents never run it.

Alternates: `git clone --shared` writes `objects/info/alternates` pointing at the source repository's
object directory, so the sandbox also needs the read access it already has on every registered
project's `.git` (`nono/profile/opencode-v2-secure.json:71-83`).

## P1 plan — the shared-clone review path

### R1 — clone materialisation (broker core, S17)

- New `broker/src/review-clone.ts`: `reviewCloneRoot(stateDir)`,
  `reviewClonePathFor(stateDir, projectID, chainID, stage, attempt)`, `buildSharedCloneArgv({source,
  target})` = `["git","clone","--shared","--no-checkout","--",source,target]`, and
  `buildDetachCheckoutArgv(sha)` = `["git","checkout","--detach",sha]`.
- Path hygiene: 0700 root, allowlisted components, `..` refused, create-only, no symlinked ancestor.
- `checkout` is already execution-bearing (`broker/src/gitguard.ts:117-131`); `clone` is not in that
  set. Settle it in this unit with a test: either add `clone`, or restrict it to `--shared` local
  sources, so `upload-pack` against a source config is never unguarded.
- Post-conditions: HEAD equals the stage commit; the baseline commit is resolvable in the clone.
- Tests: pure argv tests, plus a real-git test that clones a fixture, detaches at a commit reachable
  from no branch, and asserts the source gained no branch and no worktree; a control without the
  checkout must fail.

### R2 — running the review at the clone

- The stage review resolves `projectRoot = clonePath`, `baseRef = stage.baseline`,
  `committedOnly = true` and reuses `buildReviewAssessArgv` / `buildReviewStatusArgv`
  (`broker/src/sdd-runtime.ts:312,368`). The clone path is broker-derived and never caller-supplied;
  `host_review_*` must not accept a caller `projectDir` on this path.
- Tests: routing test asserting the spawned argv's `--cwd` is under `<stateDir>/review-clones`, and a
  refusal when a caller names one.

### R3 — binding and lifecycle

- `stageApprove` records the reviewed candidate identity (the review target and subject hashes) and
  refuses when the clone's HEAD no longer equals the stage commit, so an approval can never land on
  content that was not reviewed.
- Cleanup after acknowledge, apply or reject; retention of the newest N in the reaper; never remove a
  clone while a review is in flight.
- Threat-model update: authority in the clone's own common dir, no host-repo writes, the alternates
  read path, and the disposable name.

### R4 — the D37 trial run (owner-consented, once, owner-executed)

Precondition: the profile grant is installed and the V2 process relaunched. Steps on the host
(Fish):

```fish
set CLONE /home/james/.local/state/opencode-sandbox/review-clones/sandbox-integration/trial/stage-1.0
git clone --shared --no-checkout /home/james/agent-sandbox-integration $CLONE
git -C $CLONE checkout --detach <stage-sha>
gentle-ai review assess --cwd $CLONE --agent opencode --base-ref <baseline-sha> --committed-only --json
gentle-ai review status --cwd $CLONE --contract gentle-ai.review-integration/v2 --agent opencode --base-ref <baseline-sha> --committed-only --next-transition
```

Then follow the returned `review.start` command verbatim with the owner's consent, capture the lenses
through the installed relay, acknowledge, and delete the clone.

Record: `risk`, `review_due` and `review_due_reason` on a real-sized stage; where authority was
written (`<clone>/.git/...`); whether the sandbox can read the clone (one `nono why --profile
opencode-v2-secure` probe plus one sandbox read); whether the host repository's lineage listing is
unaffected; and whether acknowledgement burns cleanly.

Stop conditions: any write into the host repository, authority left behind after acknowledgement, or
a lens unable to obtain its context. On any of them record the evidence, do not retry, and return the
decision to the owner.

### R5 — unblock S79

With R1-R4 in place the stage-review burst can review before apply, the after-apply fallback is not
used, and `docs/staging/plan.md` receives a short OPEN-1 update in the same unit.

## Acceptance criteria

- a READY stage is reviewed end to end before apply, on a clone under the state directory, with no
  branch and no worktree added to the host repository and no authority written outside the clone;
- the reviewed candidate is bound to the approved commit;
- a clone is never created inside a project, is create-only and 0700, and is removed after the
  decision;
- `cd broker && bun test` is green apart from the known profile-drift failures and
  `bun build --target=bun src/main.ts` succeeds.

## Risks and open questions the trial settles

1. Read versus write for the in-process transport: the grant proposed here is read-only.
2. A shared clone reads through alternates; if the project repository is repacked mid-review, the
   clone must be re-created rather than repaired.
3. A linked-worktree project clones from the worktree path; its alternates target is the common
   object directory, already granted.
4. `review_due` on a real stage size is still unobserved (the spike saw a one-line stage only).
5. V1 parity: this grant is V2-only. If V1 sessions must read clones too, the same one-line grant in
   `opencode-secure.json` is a separate owner decision.
6. `git clone` is not execution-bearing in the guard today; R1 settles it with a test.

## Non-goals

No change to chain or stage records beyond the review binding; no auto-approval; no unattended
native review (consent stays per candidate); no change to the after-apply commit path; no V1 profile
change; no agent-side install.


## Revisions
- r1 2026-11-10T17:11:57Z gentle-orchestrator: Q102 OPEN-1: record the decided review-before-apply design, the approved state directory and profile grant, and the P1 shared-clone review plan
