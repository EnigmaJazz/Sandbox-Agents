# Review-run store — root choice, confinement probe and refusal knobs

Status: slices U1b-1 and U1b-2 of the `review-run-foundation` ODD task (2026-10-16).
This document records **why** the review-run store root is where it is, and the
**observed probe** that establishes the confined OpenCode process cannot write
it. The code lives in `broker/src/review-run.ts`; the config knobs in
`broker/src/config.ts`.

## Default root and why

| Knob | Default |
|---|---|
| `reviewRunRoot` | `<stateDir>/review-runs` — with the default `stateDir` this is `$HOME/.local/state/opencode-sandbox/review-runs` (override: `BROKER_REVIEW_RUN_ROOT`) |
| `reviewRunDeniedPrefixes` | `[]` (operator-settable; see below) |
| `reviewRunMaxBytes` | 8 MiB — whole run (`BROKER_REVIEW_RUN_MAX_BYTES`) |
| `reviewRunMaxFileBytes` | 4 MiB — one artifact (`BROKER_REVIEW_RUN_MAX_FILE_BYTES`) |
| `reviewRunMaxPerSession` | 8 runs (`BROKER_REVIEW_RUN_MAX_PER_SESSION`) |
| `reviewRunMaxRuns` | 64 runs, global across sessions (`BROKER_REVIEW_RUN_MAX_RUNS`) |
| `reviewRunTtlMs` | 7 days — retention TTL (`BROKER_REVIEW_RUN_TTL_MS`) |
| `reviewHelperPath` | `null` — unpinned (`BROKER_REVIEW_HELPER_PATH`) |
| `reviewHelperSha256` | `null` — unpinned, or 64 lowercase hex (`BROKER_REVIEW_HELPER_SHA256`) |

Why `<stateDir>/review-runs`:

- It is **outside the project tree**, so a materialized review writes nothing
  into the repository and needs no apply approval.
- It is **outside every path the profile visibly grants** the confined agent:
  the profile allows `$HOME/.local/state/opencode` (a *different* directory —
  `opencode-sandbox` is not `opencode` and is not granted) and `$TMPDIR`.
- The profile `extends: "default"`, whose filesystem rules are **not visible**
  from `nono/profile/opencode-secure.json`. The privacy of this root is
  therefore **not settleable by reading config**; it is established by the
  probe below and re-checked whenever the profile changes.

## The operator probe (confinement is proven, not assumed)

Run on the host as the owning user, with the store root already created by the
broker (a `touch` into a missing directory would fail with ENOENT, which is not
evidence of denial). Fish-compatible:

```sh
mkdir -p "$HOME/.local/state/opencode-sandbox/review-runs"

# Probe A — the store root must be DENIED.
nono run --profile nono/profile/opencode-secure.json -- sh -c 'touch "$HOME/.local/state/opencode-sandbox/review-runs/.probe"'
# Expected: non-zero exit, "Permission denied" (or "Read-only file system"), no output file.

# Probe B — positive control: a path the profile DOES grant must be WRITABLE,
# proving the probe actually ran under the profile and the difference is the
# path grant, not a broken command.
nono run --profile nono/profile/opencode-secure.json -- sh -c 'touch "$HOME/.local/state/opencode/.probe-allowed"'

test -e "$HOME/.local/state/opencode-sandbox/review-runs/.probe"; and echo LEAK; or echo CONFINED
rm -f "$HOME/.local/state/opencode/.probe-allowed"
```

`CONFINED` with Probe B succeeding is the evidence. On any profile edit that
touches filesystem grants, re-run both probes.

**This is the profile's property, verified by that probe — NOT a guarantee the
broker asserts.** The broker cannot prove the confined agent's confinement from
inside its own process, and `broker/src/review-run.ts` makes no such claim. It
does not embed a mirror of the profile: a hardcoded copy would drift silently.
What the broker *does* enforce is deterministic and testable (below).

## What the broker refuses deterministically

`ReviewRunStore` canonically resolves the configured root and refuses, before
writing anything, when the root is inside:

| Refusal | Error class | Error code |
|---|---|---|
| the registered project root | `ReviewRunStoreInProjectError` | `review_run_store_in_project` |
| the effective `$TMPDIR` (`os.tmpdir()`), unconditionally | `ReviewRunStoreInTmpError` | `review_run_store_in_tmp` |
| any `reviewRunDeniedPrefixes` entry | `ReviewRunStoreDeniedPrefixError` | `review_run_store_denied_prefix` |

Containment is canonical (`realpath` of the nearest existing ancestor, then
boundary-aware comparison), so `…/proj-backup` is not treated as inside
`…/proj`, and a symlinked ancestor cannot smuggle the root inside the project.

### `reviewRunDeniedPrefixes` mirror (operator-set)

Mirror the profile's agent-writable entries for this host, so a future
misconfiguration fails closed even before the probe is re-run:

```ts
reviewRunDeniedPrefixes: [
  "/home/james/.cache/opencode",
  "/home/james/.local/state/opencode",
  "/home/james/agent-sandbox-integration/.git",
  "/home/james/agent-sandbox-integration/.atl",
  "/tmp" as the effective $TMPDIR (also refused unconditionally),
],
```

The `.git` and `.atl` entries are project-local and per-project; list one entry
per registered project. This list is a **mirror of the profile at a point in
time** and must be reviewed whenever the profile's `filesystem.allow` changes —
the unconditional `$TMPDIR` refusal is the one entry that never depends on the
mirror staying current.

## Other guarantees this slice records

- Directories (store root, per-session, per-run) are mode `0700`; artifacts and
  `metadata.json` are `0600`, forced with `chmod`/`fchmod` so the ambient umask
  cannot weaken them.
- Every artifact (including `metadata.json`) is published by writing a sibling
  temp file with `O_EXCL`, `fsync`, `rename`, then fsyncing the directory. A
  failure between temp-write and rename leaves no artifact and no temp file; a
  published artifact is byte-identical to its input.
- Byte caps are measured with `Buffer.byteLength` (never `String.length`) and
  enforced before publication: an over-cap artifact is a named refusal that
  names the cap and the observed size — never a truncated file.
- `metadata.json` is reserved for the run record (`REVIEW_RUN_METADATA_NAME`).
  The artifact-name validator refuses it and every case variant of it
  (`review_run_artifact_name_reserved`), so an artifact can never overwrite the
  run record; only the record itself publishes that name.

## Added by slice U1b-2

### Pinned helper identity (property 1)

`assertPinnedReviewHelper(cfg)` reads ONLY the configured `reviewHelperPath`.
It `lstat`s the path (not `stat`, so a symlink is refused rather than followed),
requires a regular file, reads its bytes once, and requires the sha256 to equal
`reviewHelperSha256` exactly. It never searches and never falls back to any
package-cache location; a digest-correct helper sitting inside the agent-writable
`$HOME/.cache/opencode` tree is simply never consulted. Named refusals:

| Failure | Error class | Error code |
|---|---|---|
| path or digest null | `ReviewHelperUnconfiguredError` | `review_helper_unconfigured` |
| file absent | `ReviewHelperMissingError` | `review_helper_missing` |
| not a regular file (incl. symlink) | `ReviewHelperNotRegularError` | `review_helper_not_regular` |
| digest mismatch (names expected + observed) | `ReviewHelperDigestMismatchError` | `review_helper_digest_mismatch` |

The digest grammar (`^[0-9a-f]{64}$`) is validated at config parse; a malformed
value is refused with `ConfigError`. The actual pinning (copying the bytes into
a broker-private directory and writing the config) is slice U1b-3.

### Owner-session access (property 3)

`assertRunOwnership(record, sessionID)` refuses a request whose session id is
not the run record's `sessionID` (`ReviewRunOwnershipError`,
`review_run_ownership`). The refusal names the run id but never the requesting
session id, so a probing session cannot learn another session's identifier.

### Retention, expiry and recovery (property 8)

`pruneReviewRuns({root, ttlMs, maxRuns, now?})` removes a run whose directory
mtime is older than the TTL, then, when the global `maxRuns` bound is exceeded,
the oldest runs first. A run whose record reads `publishing` is "open" and is
**never** removed by either pass; it is reported in `keptOpen`. Returned summary:
`{ pruned: [{sessionID, runId, reason: "expired"|"over-bound", state}], keptOpen, totalBefore }`.

`recoverInterruptedRuns({root, ttlMs, now?})` handles a run interrupted
mid-write: a record still reading `publishing` older than the TTL is marked
`failed` through the existing `ReviewRunWriter.fail()` path with
`failureReason: "interrupted"` recorded in the record, and reported — never
deleted. The per-session quota from U1b-1 is a separate bound and is unchanged.

### Race-resistant read helper (property 4)

`readRunArtifact({runDir, name, maxFileBytes, allowRecord?})` reads one artifact
from a specific run directory with: the same name grammar + reserved-name
validation as `addArtifact`; canonical containment against that run directory
(reusing the module's boundary-aware `contains`/`canonicalForContainment`); a
single `openSync` with `O_NOFOLLOW` followed by `fstatSync` on the SAME fd (never
`stat`-then-`open`); a regular-file requirement from that fstat; and a byte cap
enforced by the fstat size and the returned length. `metadata.json` is refused
unless the caller passes `allowRecord: true`. Named refusals:
`review_run_artifact_escape`, `review_run_artifact_symlink`,
`review_run_artifact_not_regular`, `review_run_artifact_not_found`,
`review_run_artifact_cap`, and the existing `review_run_artifact_name_reserved`.

## U1b-3 — installed review-helper pin

The installer pins exactly `validate-review.mjs` from the highest installed
numeric `major.minor.patch` version under `$HOME/.cache/opencode/packages/`,
comparing components numerically. Unversioned `systematic/` and `latest/` entries
are ignored and can never override a concrete version. It does
not pin `ensure-ignore.mjs`: the broker performs the ignore check itself.
The destination is `$BROKER_STATE_DIR/review-helper/validate-review.mjs`,
defaulting to `$HOME/.local/state/opencode-sandbox/review-helper/`; the
containing directory is forced to mode `0700` and the file to `0600`. The
installer records the source version and path in `pin.json` and writes
`BROKER_REVIEW_HELPER_PATH` plus `BROKER_REVIEW_HELPER_SHA256` into
`$HOME/.config/opencode-sandbox/broker.env`. `systemd-user/sandbox-broker.service`
loads that file using `EnvironmentFile`, and `broker/src/config.ts` reads those
environment keys into `reviewHelperPath` and `reviewHelperSha256`.

This state path is deliberately outside the confined agent's writable set:
the profile grants `$HOME/.local/state/opencode`, not the distinct
`$HOME/.local/state/opencode-sandbox`. The same confinement probe above remains
the evidence requirement; the installer enforces private owner-only modes but
does not itself prove Nono confinement.

`--verify` checks the pin's regular-file type, 0600 file mode and 0700 parent
directory, compares the pinned file's SHA-256 with the value in the live broker
environment file, compares it again with the current highest-version cache
source, and checks the recorded version in `pin.json`. It reports each mismatch
as `DRIFT` and exits non-zero. Bare invocation only reports the selected source
version/path and computed digest; `--apply` performs the copy and journals it.
When the highest available cache version differs from `pin.json`, verification
reports the version change and requires a deliberate `--apply`; it never
repins automatically. The installer pins only the validator because
`assertPinnedReviewHelper` (U1b-2) verifies the configured path and digest for
each execution, while the broker owns the ignore check. No model-facing host
tool routes to this store yet.

The installer rejects a statically symlinked destination directory, including a
dangling link, and checks its path ancestors before creating the pin. This closes
the static symlink case only: a check-then-`mkdir -p`/`chmod`/`cp` sequence is
NOT race-free against a writable ancestor. The confinement property in design
gate #2, verified by the operator probe above, is what closes that boundary —
not another bash check.

