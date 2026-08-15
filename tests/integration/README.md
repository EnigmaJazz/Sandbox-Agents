# tests/integration/

Gated integration suite (Gate 5): requires a real Microsandbox (`msb`)
installation, a configured project allowlist, and a live broker.

```sh
SANDBOX_GATED_TESTS=integration bun test tests/integration/
```

Tests exercise the REAL broker service + REAL msb adapter:
lazy creation, worker reuse, session separation, read switch, external
read/write, host escape. They are **skipped by default**; Gate 5 in
`docs/manual-verification.md` remains a manual gate until the environment is
ready. Set `SANDBOX_GATED_TESTS=all` to include security + acceptance suites.
