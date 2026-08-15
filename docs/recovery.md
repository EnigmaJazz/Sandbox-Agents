# Recovery — divergence, FAILED_CLOSED, corrupted state, rollback

Status: **Gate 1**. Procedures below are the operational answers to
SYSTEM_PROMPT.md §20 (KEEP/REJECT), S16 (divergence), and the §27 gate
discipline.

## 1. Host divergence (S16)

Symptom: `sandboxctl apply` → `host project diverged from baseline (S16)`.
The result was **retained** — nothing was applied, the host tree is
unchanged, and the session is back in RESULT_READY.

Recovery options:

1. **Reconcile manually, then apply**: fix the host tree (or accept the
   divergence as intentional), run `sandboxctl diff <session>` to review,
   then `sandboxctl apply <session>` again (broker re-checks divergence).
2. **Keep for inspection**: `sandboxctl keep <session>` — worker destroyed,
   `refs/opencode-sandbox/result/<sessionID>` retained:
   `git show refs/opencode-sandbox/result/<sessionID> --stat`
3. **Discard**: `sandboxctl discard <session>` — worker + result ref removed,
   state REJECTED.

Rule: never force an apply around the divergence check — that is the S16
boundary working as designed.

## 2. FAILED_CLOSED sessions (S14)

A session in FAILED_CLOSED is terminal. The session record carries the
`error` field with the root cause (creation failure, snapshot failure,
validation failure, inconsistency). There is deliberately **no API to revive
it** (no implicit fallback, §30).

Recovery: read the error (`sandboxctl status <session>`), fix the underlying
cause, and start a NEW session for that project. Optionally remove the stale
record:

```sh
# manual, user-approved cleanup of a single failed session record:
rm -f ~/.local/state/opencode-sandbox/sessions/<sessionID>.json
```

## 3. Corrupted state files

If a `sessions/*.json` is corrupt, the broker throws
`StateCorruptionError` for that session and **fails closed** (S14) — it never
guesses state (§10). All other sessions continue to work.

Recovery:
1. Move the corrupt file aside (do not delete before inspection):
   `mv ~/.local/state/opencode-sandbox/sessions/<id>.json{,.corrupt-$(date +%s)}`
2. `sandboxctl list`/`status` again; the session is gone from the store.
3. If a worker still exists for it, remove it manually:
   `msb remove oc-sandbox-<sessionID>` (user action).

## 4. RETAINED results (KEEP, §20)

`refs/opencode-sandbox/result/<sessionID>` is the only retained artifact.
Review it, then either re-integrate into a fresh session or delete the ref:

```sh
git update-ref -d refs/opencode-sandbox/result/<sessionID>
```

## 5. Rollback of installed files

`scripts/rollback` reverses `scripts/install-user-files` exactly: restores
`.bak` files, disables/removes the systemd unit (only if it matches the repo
copy), removes the nono profile and plugins it installed, and logs every
action to `~/.local/state/opencode-sandbox/install-journal.tsv`.

```sh
scripts/rollback            # dry-run: list actions
scripts/rollback --apply    # execute
```

Never hand-edit `~/.config/opencode/opencode.json` without a `.bak`; the
fragment merge is manual by design (install-user-files produces the diff
first).

## 6. Broker data hygiene

- Bundles/patches under `~/.local/state/opencode-sandbox/` accumulate per
  session; remove with the session (discard/REJECTED) or manually.
- The broker never writes credentials anywhere (§26); no secrets to purge,
  and the state dir is 0700.

## 7. Gate rollback (Gate 1 discipline)

Nothing is installed at Gate 1 — rolling back Gate 1 is `git clean` of this
repository only. Later gates each have their own rollback path (manual
checklists in manual-verification.md) plus the scripts above.
