# Review-run store — root choice, confinement probe and refusal knobs

Status: slice U1b-1 of the `review-run-foundation` ODD task (2026-10-16).
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

## Not in this slice

Owner-session access control (T8), retention/expiry (T9), the race-resistant
read helper (T10) and the pinned helper identity (T7/T12) are later slices.
No model-facing host tool routes to this store yet.
