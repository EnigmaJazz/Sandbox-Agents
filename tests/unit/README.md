# tests/unit/

Unit tests live in **`broker/tests/`** (they import broker sources directly).

Run them with:

```sh
cd broker && bun test
```

Requirements: nothing but `bun` (bun:test + node builtins). No msb, nono or
opencode processes are involved; the msb adapter is exercised through a fake
spawn, and gitops tests cover only the pure parts (ref naming, diff
classification, protected paths, divergence comparison) without touching any
real repository's git state.

Optional stricter check (not required for `bun test`): `tsc --noEmit -p
broker/tsconfig.json` needs a local `typescript` + `bun-types` — not
bundled by design, to keep the repo dependency-free.
