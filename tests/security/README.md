# tests/security/

Gated security suite (Gates 7 + 10): secret protection, OAuth absence, host
escape, LAN isolation, fail closed, host divergence, broker argument attacks,
and S17 self-modification rejection.

```sh
SANDBOX_GATED_TESTS=security bun test tests/security/
```

Requires the same environment as tests/integration plus a host with real
credential stores to probe. The §28 argument-attack table is ALSO covered by
pure unit tests in `broker/tests/validation.test.ts` (runs with `bun test` at
Gate 1); this suite re-runs the attacks against the live socket.

**Adversarial review (spec §29)** is a separate, manual step with a dedicated
reviewer agent — see `docs/threat-model.md`.
