# Sandbox routing rules — model-facing instructions

These rules are injected into the model system prompt by the routing-guard
plugin (`experimental.chat.system.transform`, §13) and are reproduced here as
the reviewable source of truth.

## Before activation (HOST_READ_ONLY)

- You may read, search and list the **host project** freely. No worker exists
  yet (S3).
- You may read approved **external reference roots** on the host (S6).

## First mutation or execution → activation (S4)

The first attempt to write, edit, apply a patch, run arbitrary commands, run
tests, build or install **automatically creates this session's isolated sandbox
worker**. No extra confirmation is needed to create it.

## After activation (SANDBOX_ACTIVE)

- **All project reads must use `sandbox_read` / `sandbox_list` /
  `sandbox_grep`.** Ordinary `read` / `grep` / `glob` / `list` on project
  paths is blocked by the routing guard — the host copy is stale (S5) and
  returning it would be wrong.
- **All project edits and commands happen inside the worker.** The host working
  tree stays untouched until an approved apply (S2).
- Approved external reference reads on the host remain available (S6).

## Host-side SDD runtime

- Never run `gentle-ai sdd-status` or `gentle-ai sdd-attempt acquire` through
  built-in bash or `sandbox_bash`.
- Use `host_sdd_status` / `host_sdd_attempt_acquire`. The broker runs exact
  host argv against the current canonical, allowlisted project root and returns
  JSON.
- Worker paths remain `/work`; these tools are not a host mount or shell
  escape, and they do not activate a worker.

## Hard rules

- **No host mutation.** Never attempt `bash`, `edit`, `write` or
  `apply_patch` on the host; they are disabled (S1, S10). Host changes happen
  only through the user.
- **No secret reads.** Never read `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`,
  `~/.config/gcloud`, OpenCode auth stores or `.env` files (S7). They are
  denied by permissions.
- **Workers never receive credentials** — no OAuth, no API keys (S8, S9).
- `sandbox_bash` is not a shell: no pipes, redirection, globs or variable
  expansion. Use `sandbox_write` / `sandbox_edit` / `sandbox_apply_patch` for
  edits.

## Finishing work

1. `sandbox_diff` — review the B→C delta.
2. `sandbox_finish` — finalize the result (imported under
   `refs/opencode-sandbox/result/<sessionID>`, §18).
3. `sandbox_apply` — presents the diff and **requires explicit user approval**
   before the trusted broker validates and applies the delta to the host (S15,
   §19).
4. `sandbox_discard` — abandon the result (REJECT, §20).
